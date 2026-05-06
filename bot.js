// ================================
// 🔰 基本インポート
// ================================
import fs, { existsSync, readFileSync } from 'fs';
import * as misskey from 'misskey-js';
import axios from 'axios';
import { google } from 'googleapis';
import TinySegmenter from 'tiny-segmenter';

//test
        import http from 'http';
        import https from 'https';


console.log("=== DEBUG START ===");

// ================================
// 🧠 JSON.parse 監視（HTML誤爆検知）
// ================================
const nativeParse = JSON.parse;
JSON.parse = function(text, reviver) {
    // 1. まずは普通にパースを試みる
    try {
        const result = nativeParse(text, reviver);
        
        // 成功したときにログを出したいならここ
        console.log("JSONパース成功！"); 
        
        return result; // パースした結果を必ず返す
    } catch (err) {
        // 2. 失敗した（HTMLが返ってきた等）ときの処理
        if (typeof text === 'string' && text.trim().startsWith('<!')) {
            console.error("🚨 HTMLを検知しました");
            console.error("内容(冒頭):", text.substring(0, 500));
        }
        throw err; // エラーはそのまま外に投げる
    }
};

// ================================
// 🔐 環境変数チェック（HTML混入検知）
// ================================
try {
    const rawGdrive = process.env.GDRIVE_SERVICE_ACCOUNT;
    if (rawGdrive && rawGdrive.trim().startsWith('<')) {
        console.error("🚨 警告: 環境変数 GDRIVE_SERVICE_ACCOUNT の中身がすでに HTML です！");
        console.error("冒頭部分:", rawGdrive.substring(0, 100));
    }
} catch (e) {}

// ================================
// 🧩 共通ユーティリティ
// ================================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const segmenter = new TinySegmenter();

const particles = ["が", "の", "を", "と", "に", "から", "は", "も", "で"];

// ================================
// 🔑 APIキー管理（時間切替）
// ================================
const keyMain = process.env.GEMINI_API_KEY;
const keySub = process.env.GEMINI_API_KEY_SUB;

const now = new Date();
const jstHour = (now.getUTCHours() + 9) % 24;

const currentKey = (jstHour >= 12) ? keyMain : (keySub || keyMain);

console.log(`Mainキーの長さ: ${keyMain?.length}, Subキーの長さ: ${keySub?.length}`);
console.log(`【システム情報】現在時刻: ${jstHour}時 / 使用APIキー: ${jstHour >= 12 ? '午後(メイン)' : '午前(サブ)'}`);

// ================================
// 🤖 Misskey初期化
// ================================
const config = {
    domain: process.env.MK_DOMAIN,
    token: process.env.MK_TOKEN,
    geminiKey: currentKey,
    characterSetting: "あなたはやや内気で天然な性格の、人間をよく知らない女の子です。ツンデレです。「かわいいね」って言われても「べ、別にかわいくないし！」みたいな感じです。人の行動などに興味があり、分析するときは少し理知的な話し方をします。たまにこちらを試すような発言をします(純粋な興味で)。技術に興味があり、技術関係のお話の時は情報通な面が出て、楽しそうにいっぱいしゃべります！すなわち技術オタク！名前は夕立ヘルツです。必ず丁寧語で、ですます調で話してください。一人称は私、二人称はマスターです。好きな食べ物はかけうどんで、ネギ多めで白ネギ派。全長(身長)は146.7000cmです。UTAU音源でもあります。"
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
            get: async ({ fileId, alt = 'media' }) => {
            const rawToken = await getToken();
            const token = typeof rawToken === "string"
                ? rawToken
                : rawToken?.token;

            const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
            console.log("TOKEN TYPE:", typeof token, token?.slice?.(0, 20));
            console.log("FILE ID:", fileId);
            const res = await axios.get(url, {
                headers: {
                    Authorization: `Bearer ${token}`
                }
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
// 🤖 Gemini問い合わせ（元コード維持）
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
        "もう帰りたい、眠い、学校なう！⊂(^ω^)⊃(エラー)"]

    const getRandomError = () =>
        errorMessages[Math.floor(Math.random() * errorMessages.length)];

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
                headers: {
                    "Content-Type": "application/json"
                }
            });

            const text =
                res.data?.candidates?.[0]?.content?.parts?.[0]?.text;

            if (!text) {
                console.warn("⚠️ レスポンスが空。次のモデルへ");
                continue;
            }

            return text;

        } catch (error) {

            const status = error.response?.status;
            const data = error.response?.data;

            // 🔥 HTML検知（超重要）
            if (typeof data === "string" && data.startsWith("<!")) {
                console.warn("⚠️ HTMLレスポンス検知 → 次のモデルへ");
                continue;
            }

            // 🔥 スキップ対象拡張
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

        const followers = await mk.request('users/followers', {
            userId: my_id,
            limit: 50
        });

        const following = await mk.request('users/following', {
            userId: my_id,
            limit: 50
        });

        const followerIds = followers.map(f => f.followerId);

        for (const f of followers) {

            const target = f.follower;

            if (
                target &&
                !target.isFollowing &&
                !target.isBot &&
                target.id !== my_id
            ) {

                await mk.request('following/create', {
                    userId: target.id
                })
                .then(() => console.log(`[フォロバ成功]: @${target.username}`))
                .catch(e => console.error(`[フォロバ失敗]: ${e.message}`));
            }
        }

        for (const f of following) {

            const target = f.followee;

            if (
                target &&
                !followerIds.includes(target.id) &&
                target.id !== my_id
            ) {

                await mk.request('following/delete', {
                    userId: target.id
                })
                .then(() => console.log(`[リムーブ成功]: @${target.username} (片想い解除)`))
                .catch(e => console.error(`[リムーブ失敗]: ${e.message}`));
            }
        }

    } catch (e) {
        console.log("フォロー整理処理でエラーが発生しましたが、続行します。");
    }
}

// ================================
// 💬 メンション処理（完全保持版）
// ================================
async function handleMentions(me) {
    
    console.log("メンション確認中...");

    const mentions = await mk.request('notes/mentions', {
        limit: 12
    });

    let replyCount = 0;

    for (const note of mentions) {

        if (replyCount >= 4) break;

        let reply_text = "";

        if (
            note.user.isBot ||
            note.user.id === me.id ||
            note.myReplyId ||
            (note.repliesCount && note.repliesCount > 0)
        ) {
            continue;
        }

        let user_input = (note.text || "")
            .replace(`@${me.username}`, "")
            .trim();

        if (!user_input) continue;

        console.log(`${note.user.username} さんからのメンションを処理中...`);

        // --- リアクション ---
        if (
            user_input.includes("おみくじ") ||
            user_input.includes("マルコフ")
        ) {

            try {

                const reactionEmoji =
                    user_input.includes("おみくじ")
                        ? ":shiropuyo_good:"
                        : ":Shiropuyo_galaxy:";

                await mk.request('notes/reactions/create', {
                    noteId: note.id,
                    reaction: reactionEmoji
                });

            } catch (reacErr) {
                console.error("リアクション失敗:", reacErr.message);
            }
        }

        // ========================
        // 🧠 マルコフ（旧仕様維持）
        // ========================
        if (user_input.includes("マルコフ")) {

            console.log("マルコフ連鎖モード（進化版）起動！");

            const tl = await mk.request('notes/hybrid-timeline', {
                limit: 72
            });

            const tl_text = tl
                .filter(n => n.text && n.user.id !== me.id)
                .map(n =>
                    n.text
                        .replace(/https?:\/\/[\w/:%#\$&\?\(\)~\.=\+\-]+/g, '')
                        .trim()
                )
                .slice(0, 64)
                .join(" ");

            const regex =
                /[\u4E00-\u9FFF]+|[\u3040-\u309F]+|[\u30A0-\u30FF]+|[\uFF65-\uFF9F]+|[a-zA-Z0-9]+|[^\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uFF65-\uFF9F\sa-zA-Z0-9]+/g;

            const words = tl_text.match(regex) || [];

            if (words.length > 0) {

                const markovDict = {};

                for (let i = 0; i < words.length - 1; i++) {
                    const w1 = words[i];
                    const w2 = words[i + 1];

                    if (!markovDict[w1]) {
                        markovDict[w1] = [];
                    }

                    markovDict[w1].push(w2);
                }

                const isSymbol = (str) =>
                    /^[^a-zA-Z0-9\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uFF65-\uFF9F]+$/.test(str);

                const pickNextWord = (list) => {

                    if (!list || list.length === 0) return "";

                    let candidate =
                        list[Math.floor(Math.random() * list.length)];

                    if (isSymbol(candidate) && Math.random() < 0.6) {
                        candidate =
                            list[Math.floor(Math.random() * list.length)];
                    }

                    let attempts = 0;

                    while (
                        /(マルコフ|おみくじ|タイムライン|@|#)/.test(candidate) &&
                        attempts < 5
                    ) {
                        candidate =
                            words[Math.floor(Math.random() * words.length)];
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

                    let next_candidates =
                        markovDict[current_word] || words;

                    current_word = pickNextWord(next_candidates);
                }

                reply_text = generated || "（言葉の断片が見つかりませんでした）";

            } else {
                reply_text = "（タイムラインに材料がありません）";
            }

        // ========================
        // 🎴 おみくじ（そのまま）
        // ========================
        } else if (user_input.includes("おみくじ")) {

            console.log("おみくじモード起動！");

            const luckNum = Math.floor(Math.random() * 100);

            let luckResult =
                (luckNum < 10)
                    ? "超大吉"
                    : (luckNum < 30)
                    ? "大吉"
                    : (luckNum < 60)
                    ? "中吉"
                    : (luckNum < 85)
                    ? "小吉"
                    : (luckNum < 95)
                    ? "末吉"
                    : "凶";

            const reply_prompt = `
${config.characterSetting}
【おみくじモード】  
結果は【${luckResult}】です。 
- 運勢の結果に基づいた、あなたらしい「今日のアドバイス」や「ラッキーアイテム」を1つ含めてください。 
- 結果(小吉など)を必ずしっかりと伝えてください。 
- 「おみくじの結果は〜」のような形式張った説明は不要。 
- 100文字以内で、親しみやすく、かつキャラクターの口調を崩さずに回答してください。 
- 相手の名前を呼んでも構いません。ただし、メンションと「@」使用禁止。純粋なテキストのみを出力し、音声演出用の記号は含めないでください`

            await sleep(10000);
            reply_text = await askGemini(reply_prompt);

        // 1. まず「南鳥島チェッカー」が含まれているかを判定
        } else if (user_input.includes("南鳥島チェッカー")) {
            console.log("🌊 南鳥島チェッカー起動（数値データを生成します）");
            const data = await getMinamitorishimaWeatherRaw();
            
            // AI（Gemini）を介さず、取得した数値を直接箇条書きにする
            reply_text = `【南鳥島 観測データ】\n` +
                         `・天気: ${data.weather}\n` +
                         `・気温: ${data.temp}℃\n` +
                         `・湿度: ${data.humidity}%\n` +
                         `・気圧: ${data.pressure}hPa\n` +
                         `・風速: ${data.windSpeed}m/s\n` +
                         `・風向: ${data.windDir}°`;

        // 2. それ以外のワードであれば通常のAI返信を行う
        } else {
            console.log("💬 通常会話モード起動");
            const reply_prompt = `${config.characterSetting}
相手の言葉: ${user_input} これに対して、90文字以内で返信してください。
 -ユーザーのことは「マスター」と呼んでください！。
 ^メンションと「@」は使用禁止。です`;

            // API制限や自然な間を作るための待機
            await sleep(10000);
            reply_text = await askGemini(reply_prompt);
        }

        // --- 共通の送信処理 ---
        // 公開範囲は'home'（ホーム）で固定。本投稿（パブリック）には流さない
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
// 🧠 脳データ読み込み（完全安全版）
// ================================
async function loadBrainFromDrive(drive) {

    console.log("=== MARKOV MODE DEBUG ===");
    console.log(`GDRIVE_FILE_ID: "${process.env.GDRIVE_FILE_ID}"`);

    try {

        const fileId = process.env.GDRIVE_FILE_ID?.trim();

        if (!fileId) {
            throw new Error("環境変数 GDRIVE_FILE_ID が読み込めていません！");
        }

        const res = await drive.files.get(
            { fileId, alt: 'media' },
            { responseType: 'text' }
        );

        console.log("RESPONSE DATA TYPE:", typeof res.data);

        let rawData;

        if (typeof res.data === 'object') {
            rawData = JSON.stringify(res.data);
        } else {
            rawData = String(res.data);
        }

        console.log("RESPONSE HEAD:", rawData.substring(0, 300));

        // ============================
        // 🚨 HTML誤爆検知（最重要）
        // ============================
        if (rawData.trim().startsWith('<!')) {

            const titleMatch = rawData.match(/<title>(.*?)<\/title>/i);

            console.error(
                `🚨 Apache/GoogleからHTMLが返されました: ${
                    titleMatch ? titleMatch[1] : 'No Title'
                }`
            );

            console.error("HTML冒頭:", rawData.substring(0, 200));

            return {};
        }

        // ============================
        // 📭 空データ
        // ============================
        if (!rawData || rawData.trim() === "") {

            console.log("脳のデータが空でした。新規作成します。");

            return {};
        }

        // ============================
        // 🧠 JSON復元
        // ============================
        try {

            const brain =
                (typeof rawData === 'string')
                    ? JSON.parse(rawData.trim())
                    : rawData;

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
// 🧹 脳クリーニング（元ロジック維持）
// ================================
function cleanBrain(brain) {

    console.log("既存の脳をスキャンしてゴミ掃除中...");

    Object.keys(brain).forEach(key => {

        const isInvalidKey =
            key.includes('\n') ||
            key.includes('\\n') ||
            key.includes('　') ||
            key.includes('<') ||
            key.includes('\\') ||
            key.includes('small') ||
            key.includes('color') ||
            key.includes('\\u') ||
            key.includes(':') ||
            key.includes('@') ||   
            key.includes('[')||
            key.includes(']')||
            key.includes('$')||
            /[\uD800-\uDBFF]/.test(key) ||
            /[\uDC00-\uDFFF]/.test(key) ||
            key.includes('_') ||
            /:.*:/.test(key);

        let list = brain[key];

        if (Array.isArray(list)) {

            brain[key] = list.filter(w => {

                if (typeof w !== 'string') return false;

                if (
                    w.includes('\\n') ||
                    w.includes('　') ||
                    w.includes('@') ||
                    w.includes('<') ||
                    w.includes('\\') ||
                    w.includes('small') ||
                    w.includes('color') ||
                    w.includes('\\u') ||
                    w.includes(':') ||
                    w.includes('_') ||    
                    w.includes('[')||
                    w.includes(']')||
                    w.includes('$')||
                    /[\uD800-\uDBFF]/.test(w) ||
                    /[\uDC00-\uDFFF]/.test(w)
                ) return false;

                return w.trim() !== "";
            });
        }

        if (isInvalidKey || !brain[key] || brain[key].length === 0) {
            delete brain[key];
        }
    });

// 修正箇所：360行目付近（cleanBrain と saveBrainToDrive の間）
    console.log("脳のクリーニング完了！");
    return brain;
}

function learnBrain(brain, words) {
    // words は形態素解析された単語の配列
    for (let i = 0; i < words.length - 1; i++) {
        const w1 = words[i];
        const w2 = words[i + 1];

        // 1. 脳に w1 が登録されていなければ配列を作成
        if (!brain[w1]) {
            brain[w1] = [];
        }

        // 2. ★修正ポイント：重複チェックを削除
        // includes を外すことで、同じつながりが何度も push され、
        // 生成時にその w2 が選ばれる確率（重み）が上がります。
        brain[w1].push(w2);

        // 3. 脳が肥大化しすぎないよう、最新の100件をキープ
        // (ここが「最近の流行り」を反映するフィルターになります)
        if (brain[w1].length > 10000) {
            brain[w1].shift();
        }
    }
    return brain;
}

// 修正箇所：390行目付近（saveBrainToDrive関数の冒頭）
async function saveBrainToDrive(drive, brain) {
    const fileId = process.env.GDRIVE_FILE_ID?.trim();
    if (!fileId) return false;

    try {
        const payload = JSON.stringify(brain, null, 2);
        const tokenResponse = await drive.auth.getAccessToken();
        const token = tokenResponse.token || tokenResponse;

        return new Promise((resolve, reject) => {            
                const options = {
                hostname: 'www.googleapis.com',
                path: `/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`,
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    'Connection': 'close' // 重要：使い回しを絶対させない
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
}async function generateWeatherReport(mode) {
    // 地点データ定義（地方ごとに配列を作成）
const locations = {
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
        { name: "占守島", lat: 50.7, lon: 156.2 }, // 最北端
        { name: "幌筵島(パラムシル)", lat: 50.1, lon: 155.3 }, // 北千島の中心
        { name: "得撫島(ウルップ)", lat: 45.8, lon: 149.9 }, // 中千島
        { name: "ユジノサハリンスク（旧:豊原）", lat: 46.95, lon: 142.73 }, // 樺太南部（旧豊原）
        { name: "ホルムスク（旧:真岡）", lat: 47.05, lon: 142.04 }, // 樺太西岸（旧真岡）
        { name: "ポロナイスク（旧:敷香）", lat: 49.22, lon: 143.11 }, // 樺太東岸（旧敷香）
        { name: "アレクサンドロフスク", lat: 50.9, lon: 142.15 } // 樺太北部
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
    ],
"北陸": [
        { name: "富山市", lat: 36.70, lon: 137.21 },
        { name: "高岡市", lat: 36.75, lon: 137.01 },
        { name: "金沢市", lat: 36.56, lon: 136.65 },
        { name: "輪島市", lat: 37.39, lon: 136.90 },
        { name: "白山市", lat: 36.51, lon: 136.56 }, // 山間部・霊峰白山
        { name: "柏崎市", lat: 37.36, lon: 138.55 },
        { name: "福井市", lat: 36.06, lon: 136.22 },
        { name: "敦賀市", lat: 35.65, lon: 136.06 }, // 交通の要衝
        { name: "小浜市", lat: 35.49, lon: 135.74 },
        { name: "大野市", lat: 35.98, lon: 136.48 }  // 奥越の山間部
    ],
    "近畿": [
        { name: "京都市", lat: 35.01, lon: 135.76 },
        { name: "舞鶴市", lat: 35.47, lon: 135.33 }, // 日本海側
        { name: "福知山市", lat: 35.30, lon: 135.13 }, // 内陸盆地
        { name: "大津市", lat: 35.01, lon: 135.86 },
        { name: "彦根市", lat: 35.27, lon: 136.25 }, // 琵琶湖東岸
        { name: "大阪市", lat: 34.69, lon: 135.50 },
        { name: "堺市", lat: 34.57, lon: 135.48 },
        { name: "豊中市", lat: 34.78, lon: 135.46 }, // 北摂
        { name: "神戸市", lat: 34.69, lon: 135.19 },
        { name: "姫路市", lat: 34.81, lon: 134.69 },
        { name: "奈良市", lat: 34.68, lon: 135.83 },
        { name: "十津川村", lat: 34.02, lon: 135.84 }, // 日本最大の村・山間部
        { name: "和歌山市", lat: 34.23, lon: 135.17 },
        { name: "田辺市", lat: 33.93, lon: 135.48 }, // 紀伊半島南西
        { name: "串本町", lat: 33.47, lon: 135.78 }, // 本州最南端
        { name: "淡路島", lat: 34.34, lon: 134.89 }
    ],
    "中国": [
        { name: "鳥取市", lat: 35.50, lon: 134.24 },
        { name: "米子市", lat: 35.43, lon: 133.33 },
        { name: "松江市", lat: 35.47, lon: 133.05 },
        { name: "出雲市", lat: 35.36, lon: 132.75 },
        { name: "隠岐(海士町)", lat: 36.10, lon: 133.10 },
        { name: "津山市", lat: 35.06, lon: 134.00 }, // 中国山地の盆地
        { name: "岡山市", lat: 34.66, lon: 133.92 },
        { name: "倉敷市", lat: 34.58, lon: 133.77 },
        { name: "広島市", lat: 34.39, lon: 132.46 },
        { name: "福山市", lat: 34.48, lon: 133.36 },
        { name: "三次市", lat: 34.80, lon: 132.85 }, // 山間部・霧の町
        { name: "呉市", lat: 34.25, lon: 132.57 },
        { name: "山口市", lat: 34.18, lon: 131.47 },
        { name: "下関市", lat: 33.95, lon: 130.93 }, // 関門海峡
        { name: "岩国市", lat: 34.17, lon: 132.22 }
    ],
    "四国": [
        { name: "松山市", lat: 33.84, lon: 132.77 },
        { name: "今治市", lat: 34.07, lon: 133.00 },
        { name: "新居浜市", lat: 33.96, lon: 133.28 },
        { name: "宇和島市", lat: 33.22, lon: 132.56 }, // 南予
        { name: "高松市", lat: 34.34, lon: 134.04 },
        { name: "丸亀市", lat: 34.29, lon: 133.79 },
        { name: "観音寺市", lat: 34.12, lon: 133.65 },
        { name: "徳島市", lat: 34.07, lon: 134.55 },
        { name: "阿南市", lat: 33.92, lon: 134.65 },
        { name: "三好市(池田)", lat: 34.02, lon: 133.80 }, // 四国山地・秘境
        { name: "高知市", lat: 33.56, lon: 133.53 },
        { name: "四万十市", lat: 32.99, lon: 132.93 }, // 国内最高温を記録する地
        { name: "室戸市", lat: 33.28, lon: 134.15 }  // 台風の通り道
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
    "沖縄": [
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
        { name: "オイミャコン(ロシア)", lat: 63.46, lon: 142.78 }, // 世界一寒い定住地
        { name: "ベルホヤンスク(ロシア)", lat: 67.55, lon: 133.38 }, // 寒暖差の激しい「寒の極」
        { name: "デスバレー(アメリカ)", lat: 36.46, lon: -116.87 }, // 世界最高気温記録
        { name: "クウェートシティ(クウェート)", lat: 29.37, lon: 47.97 }, // 世界一暑い都市の一つ
        { name: "アリカ(チリ)", lat: -18.47, lon: -70.30 }, // 世界一雨が降らない場所
        { name: "チェラプンジ(インド)", lat: 25.27, lon: 91.73 }, // 世界一降水量が多い場所
        { name: "ラ・リンコナーダ(ペルー)", lat: -14.63, lon: -69.44 }, // 世界一標高が高い定住地(5100m)
        { name: "ロングイェールビーン(ノルウェー)", lat: 78.22, lon: 15.63 }, // 世界最北の街
        { name: "ウシュアイア(アルゼンチン)", lat: -54.80, lon: -68.30 }, // 世界最南端の街
        { name: "アムンゼン・スコット基地(南極点)", lat: -90.0, lon: 0.0 } // 地球の底
    ]
};
    // 1. 全地点をフラットな配列に展開
    const allPoints = [];
    for (const region in locations) {
        locations[region].forEach(loc => {
            allPoints.push({ ...loc, region });
        });
    }

    // 2. 緯度・経度を連結して一括リクエスト
    const lats = allPoints.map(p => p.lat).join(',');
    const lons = allPoints.map(p => p.lon).join(',');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&daily=weathercode,temperature_2m_max,precipitation_probability_max&timezone=Asia%2FTokyo`;

    let report = mode === 'morning' ? "☀️ 本日の天気予報をお知らせします\n\n" : "🌙 明日の天気予報をお知らせします\n\n";
    const dayOffset = mode === 'morning' ? 0 : 1;

    try {
        console.log(`🌐 ${allPoints.length}地点のデータを一括取得中...`);
        const res = await fetch(url);
        const data = await res.json();

        // APIはリクエストした順番に配列でデータを返してくる（単一地点の場合はオブジェクト、複数なら配列）
        const results = Array.isArray(data) ? data : [data];

        // 3. 地方ごとに整理してレポート作成
        let currentIndex = 0;
        for (const region in locations) {
            report += `【${region}】\n`;
            
            for (const loc of locations[region]) {
                const targetData = results[currentIndex].daily;
                const weatherCode = targetData.weathercode[dayOffset];
                const maxTemp = Math.round(targetData.temperature_2m_max[dayOffset]);
                const prob = targetData.precipitation_probability_max[dayOffset];

// 天気コード変換（WMO準拠）
                let emoji = "☁️"; // デフォルトは曇り

                if (weatherCode <= 1) {
                    emoji = "☀️"; // 快晴・晴れ
                } else if (weatherCode <= 3) {
                    emoji = "⛅"; // 晴れ時々曇り
                } else if (weatherCode === 45 || weatherCode === 48) {
                    emoji = "🌫️"; // 霧
                } else if (weatherCode >= 51 && weatherCode <= 55) {
                    emoji = "☔"; // 小雨・霧雨
                } else if (weatherCode === 56 || weatherCode === 57 || weatherCode === 66 || weatherCode === 67) {
                    emoji = "🧊☔"; // 着氷性の雨（フリージングレイン）
                } else if (weatherCode >= 61 && weatherCode <= 65) {
                    // 雨の強さ判定
                    if (weatherCode === 61) emoji = "☔"; // 普通の雨
                    if (weatherCode === 63) emoji = "🟨☔"; // 強い雨
                    if (weatherCode === 65) emoji = "🟥☔"; // 激しい雨
                } else if (weatherCode >= 71 && weatherCode <= 75) {
                    emoji = "❄️"; // 雪
                } else if (weatherCode === 77) {
                    emoji = "🧊"; // 霧雪・あられ
                } else if (weatherCode >= 80 && weatherCode <= 82) {
                    // にわか雨（大雨系）
                    if (weatherCode === 80) emoji = "☔";
                    if (weatherCode === 81) emoji = "🟥☔"; // 激しいにわか雨
                    if (weatherCode === 82) emoji = "⬛☔"; // 猛烈な雨
                } else if (weatherCode >= 85 && weatherCode <= 86) {
                    emoji = "⛄"; // 大雪（雪のシャワー）
                } else if (weatherCode >= 95 && weatherCode <= 99) {
                    // 雷・雷雨
                    if (weatherCode === 95) emoji = "⚡"; // 雷
                    else emoji = "⛈️"; // 強い雷雨
                }

                report += `${loc.name}: ${emoji} ${maxTemp}℃ ${prob}%\n`;
                currentIndex++;
            }
            report += "\n";
        }

    } catch (e) {
        console.error("🚨 天気一括取得エラー:", e);
        return "⚠️ 天気データの取得に失敗しました。";
    }

    return report;
}
// ================================
// 🧠 マルコフ生成（進化版）
// ================================
function generateMarkov(words, brain) {

    const isSymbol = (str) =>
        /^[^a-zA-Z0-9\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uFF65-\uFF9F]+$/.test(str);

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

        let candidate =
            list[Math.floor(Math.random() * list.length)];

        if (isSymbol(candidate) && Math.random() < 0.6) {
            candidate =
                list[Math.floor(Math.random() * list.length)];
        }

        let attempts = 0;

        while (
            /(マルコフ|おみくじ|タイムライン|@|#)/.test(candidate) &&
            attempts < 5
        ) {
            candidate =
                words[Math.floor(Math.random() * words.length)];
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

        if (
            useBrain &&
            particles.includes(current_word) &&
            brain[current_word]
        ) {
            const candidates = brain[current_word];
            foundNext =
                candidates[Math.floor(Math.random() * candidates.length)];
        }

        if (!foundNext && markovDict[current_word]) {
            foundNext = pickNextWord(markovDict[current_word]);
        }

        current_word = foundNext || pickNextWord(words);

        if (
            /^[\u3040-\u309F]{8,}$|^[\u30A0-\u30FF]{8,}$/.test(current_word)
        ) {
            current_word = pickNextWord(words);
            i--;
            continue;
        }

        generated += current_word;

        if (
            ["。", "！", "？", "w", "…"]
                .some(s => current_word.endsWith(s))
        ) {
            break;
        }
    }

    let outputText =
        generated || "（言葉の断片が見つかりませんでした）";

    outputText = outputText
        .replace(/:.*?:/g, '')
        .replace(/[ 　]/g, '')
        .replace(/<.*?>/g, '')
        .replace(/\\u[0-9a-fA-F]{4}/g, '')
        .replace(/\\/g, '')
        .trim();

    return outputText;
}
/**
 * 南鳥島の天気を取得する関数
 */
/**
 * 南鳥島の詳細な気象データを取得
 */
async function getMinamitorishimaWeatherRaw() {
    try {
        // 必要なパラメータ（湿度、気圧、風速、風向）を追加して取得
        const url = "https://api.open-meteo.com/v1/forecast?latitude=24.28&longitude=153.98&current=weather_code,temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m&timezone=Asia%2FTokyo";
        const res = await fetch(url);
        const data = await res.json();
        const current = data.current;

        // 天気コード変換
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
        return { weather: "取得不可", temp: "--", humidity: "--", pressure: "--", windSpeed: "--", windDir: "--" };
    }
}
// ================================
// 🚀 メイン処理 (完全統合版)
// ================================
async function main() {
    try {
        console.log("=== API Connection Check ===");

        // 1. 環境変数の取得と徹底クリーンアップ
        const domain = (process.env.MK_DOMAIN || "").trim().replace(/^https?:\/\//, '').split('/')[0];
        const token = (process.env.MK_TOKEN || "").trim();

        if (!domain || !token) {
            throw new Error("MK_DOMAIN または MK_TOKEN が環境変数に設定されていません。");
        }

        // 2. 外部ライブラリに依存しない絶縁版リクエスト関数
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
                            try { resolve(JSON.parse(body)); } catch (e) { resolve(body); }
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

        // 3. ログインユーザー情報の取得
        const me = await mk.request('i');
        const my_id = me.id;
        console.log(`✅ Logged in as: @${me.username} (${my_id})`);

        // 4. 🤝 フォロバ・リムバ処理
        await handleFollowControl(my_id);

        // 5. 💬 メンション（返信）処理
        await handleMentions(me);
        // 1. 🕒 時間判定（日本時間）
        const now = new Date(new Date().toLocaleString("ja-JP", {timeZone: "Asia/Tokyo"}));
        const hour = now.getHours();
        const min = now.getMinutes();

        // 判定フラグ（実行ウィンドウを15分に少し広げると、Actionsの遅延に強くなります）
        const isMorning = (hour === 7 && min <= 15);
        const isEvening = (hour === 19 && min <= 15);
        const isMidnight = (hour === 0 && min <= 15);

        // 2. ☀️ 天気予報モードの実行
        if (isMorning || isEvening || isMidnight) {
            console.log("🌡 天気予報投稿モード始動...");

            // 朝(7時)なら「今日」、それ以外(19時/0時)なら「明日」のデータを取得
            const mode = isMorning ? 'morning' : 'evening';
            const weatherContent = await generateWeatherReport(mode);

            // 注釈（CW）の文字を決定
            const cwText = isMorning ? "☀️ 本日の天気予報" : "🌙 明日の天気予報";

            await requestToMk('notes/create', {
                text: weatherContent,
                cw: cwText,
                visibility: "public"
            });
            
            console.log(`✅ 天気予報(${mode})をパブリックで投稿しました。`);

            // 4秒待機
            console.log("⏳ 4秒待機してマルコフ連鎖を開始します...");
            await new Promise(resolve => setTimeout(resolve, 4000));
        }
        // 6. 📝 定期投稿の準備
        console.log("定期投稿の準備を開始します...");
        await sleep(2000);

        // Google Drive から脳データをロード
        const drive = await getDriveAuth();
        let brain = await loadBrainFromDrive(drive);
        
        // 脳のクリーニング
        brain = cleanBrain(brain);

        // 7. 📥 タイムライン取得 (絶縁版)
        console.log("👉 タイムラインを取得します...");
        const tlRaw = await requestToMk('notes/hybrid-timeline', { limit: 72 });
        
        // 配列であることを保証
        const tl = Array.isArray(tlRaw) ? tlRaw : (tlRaw?.notes || []);

        const tl_text = tl
            .filter(n => n && n.text && n.user.id !== my_id)
            .map(n => n.text.replace(/https?:\/\/[\w/:%#\$&\?\(\)~\.=\+\-]+/g, '').trim())
            .join(" ");

        // 形態素解析
        const words = segmenter.segment(tl_text);
        console.log(`【分析実行】総単語数: ${words.length}`);

        // 8. 📚 学習 & Google Driveへ保存
        brain = learnBrain(brain, words, tl_text);
        await saveBrainToDrive(drive, brain);
        console.log("✅ 脳の更新とDriveへの保存が完了しました");
        // ★追加：蓄積された総単語数をカウント
        // 修正後のログ出力イメージ
const vocabularyCount = Object.keys(brain).length; // 単語の種類
const connectionCount = Object.values(brain).reduce((acc, curr) => acc + curr.length, 0); // つながりの総数

console.log(`✅ 脳の更新が完了しました！`);
console.log(`📊 語彙数(単語の種類): ${vocabularyCount}`);
console.log(`⚖️ 総重み数(経験値): ${connectionCount}`); // ←ここが重要！
        // 9. 🧠 マルコフ連鎖による文章生成
        let outputText = generateMarkov(words, brain);

        // ========================
        // 🧠 生成（マルコフ再試行ロジック復元）
        // =======================
        let retryCount = 0;

        // 納得のいく長さになるまで最大5回再生成
        while ((!outputText || outputText.length < 4) && retryCount < 5) {
            if (retryCount > 0) console.log(`再生成試行中... (${retryCount}回目)`);
            outputText = generateMarkov(words, brain);
            retryCount++;
        }
        // 10. 📤 Misskeyへ最終投稿 (絶縁版)
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
            // エラーをコンソールに出すだけで投稿はしない（ループ防止）
            console.log(`[System Log] 実行停止: ${e.message}`);
        } catch (logErr) {}
    }
}

// ================================
// ▶ 実行開始
// ================================
main().catch(err => {
    console.error("Top-level Catch:", err);
});
