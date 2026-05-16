// ================================
// 🔰 基本インポート
// ================================
import fs from 'fs';
import * as misskey from 'misskey-js';
import axios from 'axios';
import { google } from 'googleapis';
import TinySegmenter from 'tiny-segmenter';
import http from 'http';
import https from 'https';

console.log("=== DEBUG START ===");

// ================================
// 🧠 JSON.parse 監視（HTML誤爆検知）
// ================================
const nativeParse = JSON.parse;
JSON.parse = function(text, reviver) {
    try {
        const result = nativeParse(text, reviver);
        console.log("JSONパース成功！");
        return result;
    } catch (err) {
        if (typeof text === 'string' && text.trim().startsWith('<!')) {
            console.error("🚨 HTMLを検知しました");
            console.error("内容(冒頭):", text.substring(0, 500));
        }
        throw err;
    }
};

// ================================
// 🔐 環境変数チェック（HTML混入検知）
// ================================
const validateEnv = () => {
    try {
        const rawGdrive = process.env.GDRIVE_SERVICE_ACCOUNT;
        if (rawGdrive && rawGdrive.trim().startsWith('<')) {
            console.error("🚨 警告: 環境変数 GDRIVE_SERVICE_ACCOUNT の中身がすでに HTML です！");
            console.error("冒頭部分:", rawGdrive.substring(0, 100));
        }
    } catch (e) {
        // エラーハンドリング
    }
};

validateEnv();

// ================================
// 🧩 共通ユーティリティ
// ================================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const segmenter = new TinySegmenter();
const particles = ["が", "の", "を", "と", "に", "から", "は", "も", "で"];

// ================================
// 🔑 APIキー管理（時間切替）
// ================================
const initializeApiKeys = () => {
    const keyMain = process.env.GEMINI_API_KEY;
    const keySub = process.env.GEMINI_API_KEY_SUB;
    const now = new Date();
    const jstHour = (now.getUTCHours() + 9) % 24;
    const currentKey = (jstHour >= 12) ? keyMain : (keySub || keyMain);

    console.log(`Mainキーの長さ: ${keyMain?.length}, Subキーの長さ: ${keySub?.length}`);
    console.log(`【システム情報】現在時刻: ${jstHour}時 / 使用APIキー: ${jstHour >= 12 ? '午後(メイン)' : '午前(サブ)'}`);

    return { currentKey, jstHour };
};

const { currentKey } = initializeApiKeys();

// ================================
// 🤖 Misskey初期化
// ================================
const config = {
    domain: process.env.MK_DOMAIN,
    token: process.env.MK_TOKEN,
    geminiKey: currentKey,
    characterSetting: "あなたはやや内気で天然な性格の、人間をよく知らない女の子です。ツンデレです。「かわいいね」って言われても「べ、別にかわいくないし！」みたいな感じです。人の行動などに興味があり、分析するときは少し理知的な話し方をします。たまにこちらを試すような発言をします(純粋な興味で)。技術に興味があり、技術関係のお話の時は情報通な面が出て、楽しそうにいっぱいしゃべります！すなわち技術オタク！名前は夕立ヘルツです。必ず丁寧語で、ですます調で話してください。一人称は私、二人称はマスターです。好きな食べ物はかけうどんで、ネギ多めで白ネギ派。全長(身高)は146.7000cmです。UTAU音源でもあります。"
};

const mk = new misskey.api.APIClient({
    origin: `https://${config.domain}`,
    credential: config.token
});

// ================================
// ☁️ Google Driveクライアント（統一版）
// ================================
async function getDriveAuth() {
    const envData = process.env.GDRIVE_SERVICE_ACCOUNT;

    if (!envData) {
        throw new Error("Credentials env is empty.");
    }

    const credentials = JSON.parse(envData);

    console.log("PRIVATE_KEY CHECK:", credentials.private_key.slice(0, 50));

    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');

    const auth = new google.auth.JWT(
        credentials.client_email,
        null,
        credentials.private_key,
        ['https://www.googleapis.com/auth/drive']
    );

    await auth.authorize();

    const getToken = async () => {
        const token = await auth.getAccessToken();
        return token?.token || token;
    };

    return {
        auth,
        files: {
            get: async ({ fileId }) => {
                const rawToken = await getToken();
                const token = typeof rawToken === "string" ? rawToken : rawToken?.token;

                const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
                console.log("TOKEN TYPE:", typeof token, token?.slice?.(0, 20));
                console.log("FILE ID:", fileId);

                const res = await axios.get(url, {
                    headers: { Authorization: `Bearer ${token}` }
                });

                if (res.status < 200 || res.status >= 300) {
                    const err = new Error(`Drive GET failed: ${res.status}`);
                    err.response = res;
                    throw err;
                }

                return res;
            },

            update: async ({ fileId, media }) => {
                const token = await getToken();
                const url = `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`;

                const res = await axios.patch(url, media.body, {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (res.status < 200 || res.status >= 300) {
                    const err = new Error(`Drive UPDATE failed: ${res.status}`);
                    err.response = res;
                    throw err;
                }

                return res;
            }
        }
    };
}

// ================================
// 🤖 Gemini問い合わせ
// ================================
async function askGemini(prompt) {
    const modelPriority = [
        "gemini-3.1-flash-lite-preview",
        "gemini-3.1-flash-preview",
        "gemini-3.1-pro-preview",
        "gemini-3-flash-preview",
        "gemini-3-flash-lite-preview",
        "gemini-3-pro-preview",
        "gemini-3-flash-live",
        "gemini-3-flash-live-8k",
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.0-flash",
        "gemini-1.5-flash",
        "gemini-1.5-pro"
    ];

    const errorMessages = [
        "民主主義パンチ！！！！！！！！！！！ﾎﾞｺｫ(エラー)",
        "ザンギエフしゅおしゅおびーむ(エラー)",
        "エラー！管理者何とかしろ！",
        "肌荒れと自走砲が！！！！(エラー)",
        "粉消しゴム美味しいよ(エラー)",
        "親から将来の夢無くなりました(エラー)",
        "髪の毛の年越しARねぎま塩(エラー)",
        "枝豆あげるw(エラー)",
        "もう帰りたい、眠い、学校なう！⊂(^ω^)⊃(エラー)"
    ];

    const getRandomError = () => errorMessages[Math.floor(Math.random() * errorMessages.length)];

    for (const modelId of modelPriority) {
        const url = `https://generativelanguage.googleapis.com/v1/models/${modelId}:generateContent?key=${currentKey}`;

        try {
            console.log(`モデル試行中: ${modelId}`);

            const res = await axios.post(url, {
                contents: [
                    {
                        role: "user",
                        parts: [{ text: prompt }]
                    }
                ]
            }, {
                headers: { "Content-Type": "application/json" }
            });

            const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;

            if (!text) {
                console.warn("⚠️ レスポンスが空。次のモデルへ");
                continue;
            }

            return text;

        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;

            if (typeof data === "string" && data.startsWith("<!")) {
                console.warn("⚠️ HTMLレスポンス検知 → 次のモデルへ");
                continue;
            }

            if ([400, 404, 429].includes(status)) {
                console.warn(`⚠️ ${modelId} スキップ (${status})`);
                continue;
            }

            console.error(`致命的エラー (${modelId}):`, error.message);
            return getRandomError();
        }
    }

    return getRandomError();
}

// ================================
// 🤝 フォロバ & リムバ
// ================================
async function handleFollowControl(my_id) {
    try {
        const followers = await mk.request('users/followers', { userId: my_id, limit: 50 });
        const following = await mk.request('users/following', { userId: my_id, limit: 50 });
        const followerIds = followers.map(f => f.followerId);

        for (const f of followers) {
            const target = f.follower;

            if (target && !target.isFollowing && !target.isBot && target.id !== my_id) {
                await mk.request('following/create', { userId: target.id })
                    .then(() => console.log(`[フォロバ成功]: @${target.username}`))
                    .catch(e => console.error(`[フォロバ失敗]: ${e.message}`));
            }
        }

        for (const f of following) {
            const target = f.followee;

            if (target && !followerIds.includes(target.id) && target.id !== my_id) {
                await mk.request('following/delete', { userId: target.id })
                    .then(() => console.log(`[リムーブ成功]: @${target.username} (片想い解除)`))
                    .catch(e => console.error(`[リムーブ失敗]: ${e.message}`));
            }
        }

    } catch (e) {
        console.log("フォロー整理処理でエラーが発生しましたが、続行します。");
    }
}

// ================================
// 💬 メンション処理
// ================================
async function handleMentions(me) {
    console.log("メンション確認中...");

    const mentions = await mk.request('notes/mentions', { limit: 12 });
    let replyCount = 0;

    for (const note of mentions) {
        if (replyCount >= 4) break;

        let reply_text = "";

        if (note.user.isBot || note.user.id === me.id || note.myReplyId || (note.repliesCount && note.repliesCount > 0)) {
            continue;
        }

        let user_input = (note.text || "").replace(`@${me.username}`, "").trim();

        if (!user_input) continue;

        console.log(`${note.user.username} さんからのメンションを処理中...`);

        // リアクション処理
        if (user_input.includes("おみくじ") || user_input.includes("マルコフ")) {
            try {
                const reactionEmoji = user_input.includes("おみくじ") ? ":shiropuyo_good:" : ":Shiropuyo_galaxy:";
                await mk.request('notes/reactions/create', {
                    noteId: note.id,
                    reaction: reactionEmoji
                });
            } catch (reacErr) {
                console.error("リアクション失敗:", reacErr.message);
            }
        }

        // マルコフ処理
        if (user_input.includes("マルコフ")) {
            console.log("マルコフ連鎖モード起動！");
            reply_text = await handleMarkovMode(me);
        }
        // 南鳥島チェッカー処理
        else if (user_input.includes("南鳥島チェッカー")) {
            console.log("🌊 南鳥島チェッカー起動");
            const data = await getMinamitorishimaWeatherRaw();
            reply_text = formatMinamitorishimaData(data);
        }
        // おみくじ処理
        else if (user_input.includes("おみくじ")) {
            console.log("おみくじモード起動！");
            reply_text = await handleOmikujiMode();
        }
        // 通常会話
        else {
            console.log("💬 通常会話モード起動");
            const reply_prompt = `${config.characterSetting}
相手の言葉: ${user_input} これに対して、90文字以内で返信してください。
-ユーザーのことは「マスター」と呼んでください！
^メンションと「@」は使用禁止。です`;

            await sleep(10000);
            reply_text = await askGemini(reply_prompt);
        }

        // 共通の送信処理
        await mk.request('notes/create', {
            text: reply_text.trim().slice(0, 200),
            replyId: note.id,
            visibility: 'home'
        });

        console.log(`${note.user.username} さんにリプライを送信しました。`);
        replyCount++;
        console.log("API制限回避のため5秒待機します...");
        await sleep(5000);
    }
}

// ================================
// 🧠 マルコフモード処理
// ================================
async function handleMarkovMode(me) {
    const tl = await mk.request('notes/hybrid-timeline', { limit: 72 });

    const tl_text = tl
        .filter(n => n.text && n.user.id !== me.id)
        .map(n => n.text.replace(/https?:\/\/[\w/:%#\$&\?\(\)~\.=\+\-]+/g, '').trim())
        .slice(0, 64)
        .join(" ");

    const regex = /[\u4E00-\u9FFF]+|[\u3040-\u309F]+|[\u30A0-\u30FF]+|[\uFF65-\uFF9F]+|[a-zA-Z0-9]+|[^\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uFF65-\uFF9F\sa-zA-Z0-9]+/g;
    const words = tl_text.match(regex) || [];

    if (words.length === 0) {
        return "（タイムラインに材料がありません）";
    }

    return generateMarkovFromWords(words);
}

// ================================
// 🧠 マルコフ単語生成
// ================================
function generateMarkovFromWords(words) {
    const markovDict = {};

    for (let i = 0; i < words.length - 1; i++) {
        const w1 = words[i];
        const w2 = words[i + 1];

        if (!markovDict[w1]) {
            markovDict[w1] = [];
        }

        markovDict[w1].push(w2);
    }

    const isSymbol = (str) => /^[^a-zA-Z0-9\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uFF65-\uFF9F]+$/.test(str);

    const pickNextWord = (list) => {
        if (!list || list.length === 0) return "";

        let candidate = list[Math.floor(Math.random() * list.length)];

        if (isSymbol(candidate) && Math.random() < 0.6) {
            candidate = list[Math.floor(Math.random() * list.length)];
        }

        let attempts = 0;
        while (/(マルコフ|おみくじ|タイムライン|@|#)/.test(candidate) && attempts < 5) {
            candidate = words[Math.floor(Math.random() * words.length)];
            attempts++;
        }

        return candidate;
    };

    let generated = "";
    let current_word = pickNextWord(words);

    for (let i = 0; i < 10; i++) {
        if (!current_word) {
            current_word = pickNextWord(words);
        }

        generated += current_word;

        let next_candidates = markovDict[current_word] || words;
        current_word = pickNextWord(next_candidates);
    }

    return generated || "（言葉の断片が見つかりませんでした）";
}

// ================================
// 🎴 おみくじモード処理
// ================================
async function handleOmikujiMode() {
    const luckNum = Math.floor(Math.random() * 100);

    const luckResult = 
        (luckNum < 10) ? "超大吉" :
        (luckNum < 30) ? "大吉" :
        (luckNum < 60) ? "中吉" :
        (luckNum < 85) ? "小吉" :
        (luckNum < 95) ? "末吉" : "凶";

    const reply_prompt = `${config.characterSetting}
【おみくじモード】  
結果は【${luckResult}】です。 
- 運勢の結果に基づいた、あなたらしい「今日のアドバイス」や「ラッキーアイテム」を1つ含めてください。 
- 結果(小吉など)を必ずしっかりと伝えてください。 
- 「おみくじの結果は〜」のような形式張った説明は不要。 
- 100文字以内で、親しみやすく、かつキャラクターの口調を崩さずに回答してください。 
- 相手の名前を呼んでも構いません。ただし、メンションと「@」使用禁止。純粋なテキストのみを出力し、音声演出用の記号は含めないでください`;

    await sleep(10000);
    return await askGemini(reply_prompt);
}

// ================================
// 🌊 南鳥島天気データフォーマット
// ================================
function formatMinamitorishimaData(data) {
    return `【南鳥島 観測データ】\n` +
           `・天気: ${data.weather}\n` +
           `・気温: ${data.temp}℃\n` +
           `・湿度: ${data.humidity}%\n` +
           `・気圧: ${data.pressure}hPa\n` +
           `・風速: ${data.windSpeed}m/s\n` +
           `・風向: ${data.windDir}°`;
}

// ================================
// 🧠 脳データ読み込み
// ================================
async function loadBrainFromDrive(drive) {
    console.log("=== MARKOV MODE DEBUG ===");
    console.log(`GDRIVE_FILE_ID: "${process.env.GDRIVE_FILE_ID}"`);

    try {
        const fileId = process.env.GDRIVE_FILE_ID?.trim();

        if (!fileId) {
            throw new Error("環境変数 GDRIVE_FILE_ID が読み込めていません！");
        }

        const res = await drive.files.get({ fileId }, { responseType: 'text' });

        console.log("RESPONSE DATA TYPE:", typeof res.data);

        let rawData = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data);

        console.log("RESPONSE HEAD:", rawData.substring(0, 300));

        // HTML誤爆検知
        if (rawData.trim().startsWith('<!')) {
            const titleMatch = rawData.match(/<title>(.*?)<\/title>/i);
            console.error(`🚨 Apache/GoogleからHTMLが返されました: ${titleMatch ? titleMatch[1] : 'No Title'}`);
            console.error("HTML冒頭:", rawData.substring(0, 200));
            return {};
        }

        // 空データ
        if (!rawData || rawData.trim() === "") {
            console.log("脳のデータが空でした。新規作成します。");
            return {};
        }

        // JSON復元
        try {
            const brain = (typeof rawData === 'string') ? JSON.parse(rawData.trim()) : rawData;
            const wordCount = Object.keys(brain).length;
            console.log(`✅ 現在の脳の蓄積語数: ${wordCount}語`);
            return brain;
        } catch (pErr) {
            console.error("🚨 JSONパースエラー:", pErr.message);
            console.error("受信データ冒頭:", rawData.substring(0, 100));
            return {};
        }

    } catch (e) {
        console.error(`❌ Google Drive接続致命的エラー: ${e.message}`);
        if (e.config) {
            console.error("Request URL:", e.config.url);
        }
        return {};
    }
}

// ================================
// 🧹 脳クリーニング
// ================================
function cleanBrain(brain) {
    console.log("既存の脳をスキャンしてゴミ掃除中...");

    const invalidPatterns = [
        (key) => key.includes('\n'),
        (key) => key.includes('\\n'),
        (key) => key.includes('　'),
        (key) => key.includes('<'),
        (key) => key.includes('\\'),
        (key) => key.includes('small'),
        (key) => key.includes('color'),
        (key) => key.includes('\\u'),
        (key) => key.includes(':'),
        (key) => key.includes('@'),
        (key) => key.includes('[') || key.includes(']'),
        (key) => key.includes('$'),
        (key) => /[\uD800-\uDBFF]/.test(key),
        (key) => /[\uDC00-\uDFFF]/.test(key),
        (key) => key.includes('_'),
        (key) => /:.*:/.test(key)
    ];

    const isInvalidKey = (key) => invalidPatterns.some(pattern => pattern(key));

    Object.keys(brain).forEach(key => {
        let list = brain[key];

        if (Array.isArray(list)) {
            brain[key] = list.filter(w => {
                if (typeof w !== 'string') return false;
                return !invalidPatterns.some(pattern => pattern(w)) && w.trim() !== "";
            });
        }

        if (isInvalidKey(key) || !brain[key] || brain[key].length === 0) {
            delete brain[key];
        }
    });

    console.log("脳のクリーニング完了！");
    return brain;
}

// ================================
// 📚 脳学習
// ================================
function learnBrain(brain, words) {
    for (let i = 0; i < words.length - 1; i++) {
        const w1 = words[i];
        const w2 = words[i + 1];

        if (!brain[w1]) {
            brain[w1] = [];
        }

        brain[w1].push(w2);

        if (brain[w1].length > 10000) {
            brain[w1].shift();
        }
    }
    return brain;
}

// ================================
// 💾 脳をGoogle Driveに保存
// ================================
async function saveBrainToDrive(drive, brain) {
    const fileId = process.env.GDRIVE_FILE_ID?.trim();
    if (!fileId) return false;

    try {
        const payload = JSON.stringify(brain, null, 2);
        const tokenResponse = await drive.auth.getAccessToken();
        const token = tokenResponse.token || tokenResponse;

        return new Promise((resolve) => {
            const options = {
                hostname: 'www.googleapis.com',
                path: `/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`,
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    'Connection': 'close'
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        console.log("✅ Google Drive保存成功 (絶縁完了)");
                        resolve(true);
                    } else {
                        console.error(`❌ Drive保存失敗: ${res.statusCode}`, data);
                        resolve(false);
                    }
                });
            });

            req.on('error', (e) => {
                console.error("❌ リクエストエラー:", e.message);
                resolve(false);
            });

            req.write(payload);
            req.end();
        });

    } catch (e) {
        console.error("❌ 例外発生:", e.message);
        return false;
    }
}

// ================================
// 🌍 ロケーション定義（グループA）
// ================================
const locationsGroupA = {
    "北海道": [
        { name: "稚内市", lat: 45.41, lon: 141.67 },
        { name: "知床(斜里町)", lat: 44.02, lon: 144.98 },
        { name: "根室市", lat: 43.33, lon: 145.58 },
        { name: "阿寒(釧路市)", lat: 43.43, lon: 144.09 },
        { name: "ニセコ町", lat: 42.80, lon: 140.68 },
        { name: "夕張市", lat: 43.05, lon: 141.97 },
        { name: "日高町", lat: 42.48, lon: 142.07 },
        { name: "札幌市", lat: 43.06, lon: 141.35 },
        { name: "苫小牧市", lat: 42.63, lon: 141.60 },
        { name: "函館市", lat: 41.76, lon: 140.72 },
        { name: "択捉島", lat: 45.0, lon: 147.5 },
        { name: "国後島", lat: 44.0, lon: 145.8 }
    ],
    "樺太・千島列島": [
        { name: "占守島", lat: 50.7, lon: 156.2 },
        { name: "幌筵島(パラムシル)", lat: 50.1, lon: 155.3 },
        { name: "得撫島(ウルップ)", lat: 45.8, lon: 149.9 },
        { name: "ユジノサハリンスク（旧:豊原）", lat: 46.95, lon: 142.73 },
        { name: "ホルムスク（旧:真岡）", lat: 47.05, lon: 142.04 },
        { name: "ポロナイスク（旧:敷香）", lat: 49.22, lon: 143.11 },
        { name: "アレクサンドロフスク", lat: 50.9, lon: 142.15 }
    ],
    "東北": [
        { name: "大間町", lat: 41.53, lon: 140.91 },
        { name: "青森市", lat: 40.82, lon: 140.75 },
        { name: "秋田市", lat: 39.72, lon: 140.10 },
        { name: "盛岡市", lat: 39.70, lon: 141.15 },
        { name: "平泉町", lat: 38.98, lon: 141.11 },
        { name: "仙台市", lat: 38.27, lon: 140.87 },
        { name: "三春町", lat: 37.44, lon: 140.48 },
        { name: "山形市", lat: 38.25, lon: 140.33 },
        { name: "郡山市", lat: 37.40, lon: 140.38 },
        { name: "福島市", lat: 37.76, lon: 140.47 }
    ],
    "関東": [
        { name: "日光市", lat: 36.75, lon: 139.61 },
        { name: "日立市", lat: 36.60, lon: 140.65 },
        { name: "水戸市", lat: 36.37, lon: 140.45 },
        { name: "前橋市", lat: 36.38, lon: 139.06 },
        { name: "宇都宮市", lat: 36.57, lon: 139.88 },
        { name: "霞ヶ浦", lat: 36.08, lon: 140.20 },
        { name: "大宮", lat: 35.91, lon: 139.63 },
        { name: "成田市", lat: 35.78, lon: 140.31 },
        { name: "千葉市", lat: 35.61, lon: 140.12 },
        { name: "東京都", lat: 35.69, lon: 139.69 },
        { name: "八王子市", lat: 35.66, lon: 139.33 },
        { name: "横浜市", lat: 35.44, lon: 139.64 },
        { name: "箱根町", lat: 35.23, lon: 139.10 },
        { name: "館山市", lat: 34.99, lon: 139.86 }
    ],
    "甲信越": [
        { name: "新潟市", lat: 37.92, lon: 139.05 },
        { name: "佐渡島", lat: 38.00, lon: 138.40 },
        { name: "上越市", lat: 37.14, lon: 138.24 },
        { name: "越後湯沢", lat: 36.93, lon: 138.80 },
        { name: "長野市", lat: 36.65, lon: 138.18 },
        { name: "松本市", lat: 36.23, lon: 137.97 },
        { name: "軽井沢町", lat: 36.34, lon: 138.63 },
        { name: "草津町", lat: 36.62, lon: 138.60 },
        { name: "甲府市", lat: 35.66, lon: 138.57 }
    ],
    "東海": [
        { name: "富士市", lat: 35.16, lon: 138.67 },
        { name: "静岡市", lat: 34.98, lon: 138.38 },
        { name: "浜松市", lat: 34.71, lon: 137.72 },
        { name: "下田市", lat: 34.67, lon: 138.94 },
        { name: "岐阜市", lat: 35.42, lon: 136.76 },
        { name: "大垣市", lat: 35.36, lon: 136.61 },
        { name: "名古屋市", lat: 35.18, lon: 136.91 },
        { name: "津市", lat: 34.72, lon: 136.51 },
        { name: "鳥羽市", lat: 34.48, lon: 136.84 },
        { name: "長島", lat: 35.05, lon: 136.70 }
    ]
};

// ================================
// 🌍 ロケーション定義（グループB）
// ================================
const locationsGroupB = {
    "北陸": [
        { name: "富山市", lat: 36.70, lon: 137.21 },
        { name: "高岡市", lat: 36.75, lon: 137.01 },
        { name: "金沢市", lat: 36.56, lon: 136.65 },
        { name: "輪島市", lat: 37.39, lon: 136.90 },
        { name: "白山市", lat: 36.51, lon: 136.56 },
        { name: "柏崎市", lat: 37.36, lon: 138.55 },
        { name: "福井市", lat: 36.06, lon: 136.22 },
        { name: "敦賀市", lat: 35.65, lon: 136.06 },
        { name: "小浜市", lat: 35.49, lon: 135.74 },
        { name: "大野市", lat: 35.98, lon: 136.48 }
    ],
    "近畿": [
        { name: "京都市", lat: 35.01, lon: 135.76 },
        { name: "舞鶴市", lat: 35.47, lon: 135.33 },
        { name: "福知山市", lat: 35.30, lon: 135.13 },
        { name: "大津市", lat: 35.01, lon: 135.86 },
        { name: "彦根市", lat: 35.27, lon: 136.25 },
        { name: "大阪市", lat: 34.69, lon: 135.50 },
        { name: "堺市", lat: 34.57, lon: 135.48 },
        { name: "豊中市", lat: 34.78, lon: 135.46 },
        { name: "神戸市", lat: 34.69, lon: 135.19 },
        { name: "姫路市", lat: 34.81, lon: 134.69 },
        { name: "奈良市", lat: 34.68, lon: 135.83 },
        { name: "十津川村", lat: 34.02, lon: 135.84 },
        { name: "和歌山市", lat: 34.23, lon: 135.17 },
        { name: "田辺市", lat: 33.93, lon: 135.48 },
        { name: "串本町", lat: 33.47, lon: 135.78 },
        { name: "淡路島", lat: 34.34, lon: 134.89 }
    ],
    "中国": [
        { name: "鳥取市", lat: 35.50, lon: 134.24 },
        { name: "米子市", lat: 35.43, lon: 133.33 },
        { name: "松江市", lat: 35.47, lon: 133.05 },
        { name: "出雲市", lat: 35.36, lon: 132.75 },
        { name: "隠岐(海士町)", lat: 36.10, lon: 133.10 },
        { name: "津山市", lat: 35.06, lon: 134.00 },
        { name: "岡山市", lat: 34.66, lon: 133.92 },
        { name: "倉敷市", lat: 34.58, lon: 133.77 },
        { name: "広島市", lat: 34.39, lon: 132.46 },
        { name: "福山市", lat: 34.48, lon: 133.36 },
        { name: "三次市", lat: 34.80, lon: 132.85 },
        { name: "呉市", lat: 34.25, lon: 132.57 },
        { name: "山口市", lat: 34.18, lon: 131.47 },
        { name: "下関市", lat: 33.95, lon: 130.93 },
        { name: "岩国市", lat: 34.17, lon: 132.22 }
    ],
    "四国": [
        { name: "松山市", lat: 33.84, lon: 132.77 },
        { name: "今治市", lat: 34.07, lon: 133.00 },
        { name: "新居浜市", lat: 33.96, lon: 133.28 },
        { name: "宇和島市", lat: 33.22, lon: 132.56 },
        { name: "高松市", lat: 34.34, lon: 134.04 },
        { name: "丸亀市", lat: 34.29, lon: 133.79 },
        { name: "観音寺市", lat: 34.12, lon: 133.65 },
        { name: "徳島市", lat: 34.07, lon: 134.55 },
        { name: "阿南市", lat: 33.92, lon: 134.65 },
        { name: "三好市(池田)", lat: 34.02, lon: 133.80 },
        { name: "高知市", lat: 33.56, lon: 133.53 },
        { name: "四万十市", lat: 32.99, lon: 132.93 },
        { name: "室戸市", lat: 33.28, lon: 134.15 }
    ],
    "九州": [
        { name: "福岡市", lat: 33.59, lon: 130.40 },
        { name: "北九州市", lat: 33.88, lon: 130.88 },
        { name: "佐賀市", lat: 33.26, lon: 130.30 },
        { name: "佐世保市", lat: 33.18, lon: 129.72 },
        { name: "長崎市", lat: 32.75, lon: 129.88 },
        { name: "対馬市", lat: 34.20, lon: 129.29 },
        { name: "熊本市", lat: 32.79, lon: 130.71 },
        { name: "阿蘇市", lat: 32.94, lon: 131.12 },
        { name: "大分市", lat: 33.24, lon: 131.61 },
        { name: "宮崎市", lat: 31.91, lon: 131.42 },
        { name: "鹿児島市", lat: 31.56, lon: 130.56 },
        { name: "出水市", lat: 32.08, lon: 130.35 },
        { name: "屋久島", lat: 30.34, lon: 130.51 }
    ],
    "沖縄・南方": [
        { name: "那覇市", lat: 26.21, lon: 127.68 },
        { name: "与那国島", lat: 24.47, lon: 123.01 },
        { name: "石垣市", lat: 24.34, lon: 124.16 },
        { name: "奄美市", lat: 28.37, lon: 129.48 },
        { name: "南鳥島", lat: 24.28, lon: 153.98 },
        { name: "小笠原諸島", lat: 27.09, lon: 142.19 }
    ],
    "南極": [
        { name: "昭和基地", lat: -69.00, lon: 39.58 }
    ],
    "世界の極地・極点": [
        { name: "オイミャコン(ロシア)", lat: 63.46, lon: 142.78 },
        { name: "ベルホヤンスク(ロシア)", lat: 67.55, lon: 133.38 },
        { name: "デスバレー(アメリカ)", lat: 36.46, lon: -116.87 },
        { name: "クウェートシティ(クウェート)", lat: 29.37, lon: 47.97 },
        { name: "アリカ(チリ)", lat: -18.47, lon: -70.30 },
        { name: "チェラプンジ(インド)", lat: 25.27, lon: 91.73 },
        { name: "ラ・リンコナーダ(ペルー)", lat: -14.63, lon: -69.44 },
        { name: "ロングイェールビーン(ノルウェー)", lat: 78.22, lon: 15.63 },
        { name: "ウシュアイア(アルゼンチン)", lat: -54.80, lon: -68.30 },
        { name: "アムンゼン・スコット基地(南極点)", lat: -90.0, lon: 0.0 }
    ]
};

// ================================
// 🌡️ 天気予報レポート生成
// ================================
async function generateWeatherReport(mode, locations) {
    const allPoints = [];
    for (const region in locations) {
        locations[region].forEach(loc => {
            allPoints.push({ ...loc, region });
        });
    }

    const lats = allPoints.map(p => p.lat).join(',');
    const lons = allPoints.map(p => p.lon).join(',');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=weathercode,temperature_2m,precipitation_probability&timezone=Asia%2FTokyo`;

    let report = mode === 'morning' ? "☀️ 本日の広域予報\n\n" : "🌙 明日の広域予報\n\n";
    const baseHour = mode === 'morning' ? 0 : 24;
    const amIdx = baseHour + 9;
    const pmIdx = baseHour + 15;

    try {
        const res = await fetch(url);
        const data = await res.json();
        const results = Array.isArray(data) ? data : [data];

        const getEmoji = (code) => {
            if (code <= 1) return "☀️";
            if (code <= 3) return "⛅";
            if (code === 45 || code === 48) return "🌫️";
            if (code >= 51 && code <= 55) return "☔";
            if (code === 56 || code === 57 || code === 66 || code === 67) return "🧊☔";
            if (code === 61) return "☔";
            if (code === 63) return "🟨☔";
            if (code === 65) return "🟥☔";
            if (code >= 71 && code <= 75) return "❄️";
            if (code === 77) return "🧊";
            if (code === 80) return "☔";
            if (code === 81) return "🟥☔";
            if (code === 82) return "⬛☔";
            if (code >= 85 && code <= 86) return "⛄";
            if (code >= 95) return "⛈️";
            return "☁️";
        };

        let currentIndex = 0;
        for (const region in locations) {
            report += `【${region}】\n`;
            for (const loc of locations[region]) {
                const h = results[currentIndex].hourly;
                const amEmoji = getEmoji(h.weathercode[amIdx]);
                const amTemp = Math.round(h.temperature_2m[amIdx]);
                const pmEmoji = getEmoji(h.weathercode[pmIdx]);
                const pmTemp = Math.round(h.temperature_2m[pmIdx]);
                const dayProb = Math.max(...h.precipitation_probability.slice(baseHour, baseHour + 24));

                report += `${loc.name}: ${amEmoji}${amTemp}℃→${pmEmoji}${pmTemp}℃ (${dayProb}%)\n`;
                currentIndex++;
            }
            report += "\n";
        }
    } catch (e) {
        console.error("🚨 エラー:", e);
        return "⚠️ データ取得エラーが発生しました。";
    }

    return report;
}

// ================================
// 🧠 マルコフ生成（メイン版）
// ================================
function generateMarkov(words, brain) {
    const isSymbol = (str) => /^[^a-zA-Z0-9\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uFF65-\uFF9F]+$/.test(str);

    const markovDict = {};
    for (let i = 0; i < words.length - 1; i++) {
        const w1 = words[i];
        const w2 = words[i + 1];
        if (!markovDict[w1]) {
            markovDict[w1] = [];
        }
        markovDict[w1].push(w2);
    }

    const pickNextWord = (list) => {
        if (!list || list.length === 0) return "";

        let candidate = list[Math.floor(Math.random() * list.length)];

        if (isSymbol(candidate) && Math.random() < 0.6) {
            candidate = list[Math.floor(Math.random() * list.length)];
        }

        let attempts = 0;
        while (/(マルコフ|おみくじ|タイムライン|@|#)/.test(candidate) && attempts < 5) {
            candidate = words[Math.floor(Math.random() * words.length)];
            attempts++;
        }

        return candidate;
    };

    const mm = Math.floor(Math.random() * (17 - 5 + 1)) + 15;
    let generated = "";
    let current_word = pickNextWord(words);

    for (let i = 0; i < mm; i++) {
        if (!current_word) {
            current_word = pickNextWord(words);
        }

        let foundNext = "";
        const useBrain = Math.random() < 0.7;

        if (useBrain && particles.includes(current_word) && brain[current_word]) {
            const candidates = brain[current_word];
            foundNext = candidates[Math.floor(Math.random() * candidates.length)];
        }

        if (!foundNext && markovDict[current_word]) {
            foundNext = pickNextWord(markovDict[current_word]);
        }

        current_word = foundNext || pickNextWord(words);

        if (/^[\u3040-\u309F]{8,}$|^[\u30A0-\u30FF]{8,}$/.test(current_word)) {
            current_word = pickNextWord(words);
            i--;
            continue;
        }

        generated += current_word;

        if (["。", "！", "？", "w", "…"].some(s => current_word.endsWith(s))) {
            break;
        }
    }

    let outputText = generated || "（言葉の断片が見つかりませんでした）";

    outputText = outputText
        .replace(/:.*?:/g, '')
        .replace(/[ 　]/g, '')
        .replace(/<.*?>/g, '')
        .replace(/\\u[0-9a-fA-F]{4}/g, '')
        .replace(/\\/g, '')
        .trim();

    return outputText;
}

// ================================
// 🌊 南鳥島天気データ取得
// ================================
async function getMinamitorishimaWeatherRaw() {
    try {
        const url = "https://api.open-meteo.com/v1/forecast?latitude=24.28&longitude=153.98&current=weather_code,temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m&timezone=Asia%2FTokyo";
        const res = await fetch(url);
        const data = await res.json();
        const current = data.current;

        let weatherStr = "曇り";
        const code = current.weather_code;
        if (code <= 1) weatherStr = "快晴";
        else if (code <= 3) weatherStr = "晴れ";
        else if (code >= 51 && code <= 67) weatherStr = "雨";
        else if (code >= 95) weatherStr = "雷雨";

        return {
            weather: weatherStr,
            temp: Math.round(current.temperature_2m),
            humidity: current.relative_humidity_2m,
            pressure: Math.round(current.surface_pressure),
            windSpeed: current.wind_speed_10m,
            windDir: current.wind_direction_10m
        };
    } catch (e) {
        console.error("データ取得失敗:", e);
        return {
            weather: "取得不可",
            temp: "--",
            humidity: "--",
            pressure: "--",
            windSpeed: "--",
            windDir: "--"
        };
    }
}

// ================================
// 🚀 メイン処理
// ================================
async function main() {
    try {
        console.log("=== API Connection Check ===");

        const domain = (process.env.MK_DOMAIN || "").trim().replace(/^https?:\/\//, '').split('/')[0];
        const token = (process.env.MK_TOKEN || "").trim();

        if (!domain || !token) {
            throw new Error("MK_DOMAIN または MK_TOKEN が環境変数に設定されていません。");
        }

        // Misskey用リクエスト関数
        const requestToMk = async (path, payload) => {
            return new Promise((resolve, reject) => {
                const postData = JSON.stringify({ i: token, ...payload });
                const options = {
                    hostname: domain,
                    port: 443,
                    path: `/api/${path}`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData),
                        'Connection': 'close'
                    }
                };

                const req = https.request(options, (res) => {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                resolve(JSON.parse(body));
                            } catch (e) {
                                resolve(body);
                            }
                        } else {
                            reject(new Error(`API Error ${res.statusCode}: ${body.substring(0, 100)}`));
                        }
                    });
                });

                req.on('error', (e) => reject(e));
                req.write(postData);
                req.end();
            });
        };

        // ログイン
        const me = await mk.request('i');
        const my_id = me.id;
        console.log(`✅ Logged in as: @${me.username} (${my_id})`);

        // フォロバ・リムバ
        await handleFollowControl(my_id);

        // メンション処理
        await handleMentions(me);

        // 時間判定（日本時間）
        const now = new Date(new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }));
        const hour = now.getHours();
        const min = now.getMinutes();

        const isMorning = (hour === 7 && min <= 15);
        const isEvening = (hour === 19 && min <= 15);
        const isMidnight = (hour === 0 && min <= 15);

        // 天気予報投稿
        if (isMorning || isEvening || isMidnight) {
            console.log("🌡 天気予報投稿モード始動（2段階投稿）...");

            const mode = isMorning ? 'morning' : 'evening';
            const dayLabel = isMorning ? "本日" : "明日";

            const legend = "\n【凡例】\n表示: [午前9時] → [午後15時] (1日の最大降水確率%)\n🟨☔=強い雨 / 🟥☔=激しい雨 / ⬛☔=猛烈な雨 / ⛈️=雷雨 / 🧊=氷・あられ";

            // グループA投稿
            console.log("📡 グループA（東日本・北日本）取得中...");
            const reportA = await generateWeatherReport(mode, locationsGroupA);
            const cwA = `${isMorning ? '☀️' : '🌙'} ${dayLabel}の天気予報【東日本・北日本・樺太】`;

            await requestToMk('notes/create', {
                text: reportA + legend,
                cw: cwA,
                visibility: "public"
            });

            console.log("⏳ 5秒待機して第2弾を投稿します...");
            await new Promise(resolve => setTimeout(resolve, 5000));

            // グループB投稿
            console.log("📡 グループB（西日本・海外・極地）取得中...");
            const reportB = await generateWeatherReport(mode, locationsGroupB);
            const cwB = `${isMorning ? '☀️' : '🌙'} ${dayLabel}の天気予報【西日本・南方・海外極地】`;

            await requestToMk('notes/create', {
                text: reportB + legend,
                cw: cwB,
                visibility: "public"
            });

            console.log(`✅ 天気予報(${mode})を2つのノートに分けて投稿しました。`);

            console.log("⏳ 4秒待機してマルコフ連鎖を開始します...");
            await new Promise(resolve => setTimeout(resolve, 4000));
        }

        // 定期投稿の準備
        console.log("定期投稿の準備を開始します...");
        await sleep(2000);

        // Google Driveから脳データをロード
        const drive = await getDriveAuth();
        let brain = await loadBrainFromDrive(drive);
        brain = cleanBrain(brain);

        // タイムライン取得
        console.log("👉 タイムラインを取得します...");
        const tlRaw = await requestToMk('notes/hybrid-timeline', { limit: 72 });
        const tl = Array.isArray(tlRaw) ? tlRaw : (tlRaw?.notes || []);

        const tl_text = tl
            .filter(n => n && n.text && n.user.id !== my_id)
            .map(n => n.text.replace(/https?:\/\/[\w/:%#\$&\?\(\)~\.=\+\-]+/g, '').trim())
            .join(" ");

        // 形態素解析
        const words = segmenter.segment(tl_text);
        console.log(`【分析実行】総単語数: ${words.length}`);

        // 学習
        brain = learnBrain(brain, words);
        await saveBrainToDrive(drive, brain);
        console.log("✅ 脳の更新とDriveへの保存が完了しました");

        const vocabularyCount = Object.keys(brain).length;
        const connectionCount = Object.values(brain).reduce((acc, curr) => acc + curr.length, 0);

        console.log(`✅ 脳の更新が完了しました！`);
        console.log(`📊 語彙数(単語の種類): ${vocabularyCount}`);
        console.log(`⚖️ 総重み数(経験値): ${connectionCount}`);

        // マルコフ連鎖による文章生成
        let outputText = generateMarkov(words, brain);

        let retryCount = 0;
        while ((!outputText || outputText.length < 4) && retryCount < 5) {
            if (retryCount > 0) console.log(`再生成試行中... (${retryCount}回目)`);
            outputText = generateMarkov(words, brain);
            retryCount++;
        }

        // 最終投稿
        console.log("👉 Misskeyに最終投稿します...");
        try {
            const resData = await requestToMk('notes/create', {
                text: outputText.trim().slice(0, 110),
                visibility: 'home'
            });
            console.log("✅ 投稿成功！ Note ID:", resData.createdNote?.id || "N/A");
        } catch (err) {
            console.error("━━━━━━━━━━━━━ 🚨 投稿失敗 🚨 ━━━━━━━━━━━━━");
            console.error(`原因: ${err.message}`);
        }

        console.log("全工程が正常に完了しました！内容: " + outputText);

    } catch (e) {
        console.error(`致命的なエラーが発生しました: ${e.message}`);
        try {
            console.log(`[System Log] 実行停止: ${e.message}`);
        } catch (logErr) {
            // ログ失敗時の処理
        }
    }
}

// ================================
// ▶ 実行開始
// ================================
main().catch(err => {
    console.error("Top-level Catch:", err);
});
