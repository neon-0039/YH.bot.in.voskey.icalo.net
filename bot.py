import os
import sys
import json
import time
import random
import re
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Any, Optional
import hashlib

import requests
import asyncio
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from fugashi import Tagger

print("=== DEBUG START ===")

# ================================
# 🧠 JSON.loads 監視（HTML誤爆検知）
# ================================
original_loads = json.loads

def patched_loads(s, *args, **kwargs):
    try:
        result = original_loads(s, *args, **kwargs)
        print("JSONパース成功！")
        return result
    except json.JSONDecodeError as err:
        if isinstance(s, str) and s.strip().startswith('<!'):
            print("🚨 HTMLを検知しました")
            print("内容(冒頭):", s[:500])
        raise err

json.loads = patched_loads

# ================================
# 🔐 環境変数チェック（HTML混入検知）
# ================================
def validate_env():
    try:
        raw_gdrive = os.environ.get('GDRIVE_SERVICE_ACCOUNT')
        if raw_gdrive and raw_gdrive.strip().startswith('<'):
            print("🚨 警告: 環境変数 GDRIVE_SERVICE_ACCOUNT の中身がすでに HTML です！")
            print("冒頭部分:", raw_gdrive[:100])
    except Exception as e:
        pass

validate_env()

# ================================
# 🧩 共通ユーティリティ
# ================================
def sleep(ms):
    """ミリ秒単位でスリープ"""
    time.sleep(ms / 1000.0)

particles = ["が", "の", "を", "と", "に", "から", "は", "も", "で"]

# ================================
# 🔑 APIキー管理（時間切替）
# ================================
def initialize_api_keys():
    key_main = os.environ.get('GEMINI_API_KEY')
    key_sub = os.environ.get('GEMINI_API_KEY_SUB')
    
    now = datetime.now(timezone.utc)
    jst_hour = (now.hour + 9) % 24
    current_key = key_main if (jst_hour >= 12) else (key_sub or key_main)
    
    print(f"Mainキーの長さ: {len(key_main) if key_main else 0}, Subキーの長さ: {len(key_sub) if key_sub else 0}")
    print(f"【システム情報】現在時刻: {jst_hour}時 / 使用APIキー: {'午後(メイン)' if jst_hour >= 12 else '午前(サブ)'}")
    
    return {"currentKey": current_key, "jstHour": jst_hour}

api_config = initialize_api_keys()
current_key = api_config["currentKey"]

# ================================
# 🤖 Misskey初期化
# ================================
config = {
    "domain": os.environ.get('MK_DOMAIN'),
    "token": os.environ.get('MK_TOKEN'),
    "geminiKey": current_key,
    "characterSetting": "あなたはやや内気で天然な性格の、人間をよく知らない女の子です。ツンデレです。「かわいいね」って言われても「べ、別に…」と照れてしまいます。口調は、やや年上のお姉さんのような、親しみやすく親密な感じが特徴です。マスターのことは大切にしていますが、表面上はそれをあまり見せません。"
}

# ================================
# 🔧 Fugashiを使った形態素解析
# ================================
_tagger = None

def get_tagger():
    """Taggerインスタンスをシングルトンで取得"""
    global _tagger
    if _tagger is None:
        _tagger = Tagger()
    return _tagger

def tokenize_with_fugashi(text):
    """Fugashiを使用して日本語のテキストを形態素解析"""
    try:
        tagger = get_tagger()
        words = []
        
        for word in tagger(text):
            surface = word.surface
            if surface.strip():
                words.append(surface)
        
        return words
    except Exception as e:
        print(f"形態素解析エラー: {str(e)}")
        # フォールバック：単純な分割
        return simple_tokenize(text)

def simple_tokenize(text):
    """フォールバック用の単純な分割"""
    regex = r'[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]+|[\uFF65-\uFF9F]+|[a-zA-Z0-9]+|[、！？…]'
    words = re.findall(regex, text)
    return words

# ================================
# 📚 テキスト前処理（URLと:word:を除去）
# ================================
def preprocess_text(text):
    """
    URLと:word:形式を先に除去してから形態素解析する
    """
    # 1. URLを除去
    text = re.sub(r'https?://[\w/:%#\$&\?\(\)~\.=\+\-]+', '', text)
    
    # 2. :word: 形式（カスタム絵文字など）を除去
    text = re.sub(r':[a-zA-Z0-9_]+:', '', text)
    
    # 3. HTMLタグを除去
    text = re.sub(r'<[^>]*>', '', text)
    
    # 4. 余分な空白を整理
    text = re.sub(r'\s+', ' ', text).strip()
    
    return text

# ================================
# ☁️ Google Driveクライアント（統一版）
# ================================
async def get_drive_auth():
    env_data = os.environ.get('GDRIVE_SERVICE_ACCOUNT')
    
    if not env_data:
        raise Exception("Credentials env is empty.")
    
    credentials_dict = json.loads(env_data)
    
    print("PRIVATE_KEY CHECK:", credentials_dict.get('private_key', '')[:50])
    
    credentials_dict['private_key'] = credentials_dict['private_key'].replace('\\n', '\n')
    
    credentials = Credentials.from_service_account_info(
        credentials_dict,
        scopes=['https://www.googleapis.com/auth/drive']
    )
    
    drive_service = build('drive', 'v3', credentials=credentials)
    
    async def get_file(file_id):
        """Google Driveからファイルを取得"""
        try:
            print(f"FILE ID: {file_id}")
            request = drive_service.files().get_media(fileId=file_id)
            response = request.execute()
            return response
        except HttpError as error:
            print(f"Drive GET failed: {error}")
            raise error
    
    async def update_file(file_id, media_body):
        """Google Driveのファイルを更新"""
        try:
            from googleapiclient.http import MediaIoBaseUpload
            request = drive_service.files().update(
                fileId=file_id,
                media_body=media_body
            )
            response = request.execute()
            return response
        except HttpError as error:
            print(f"Drive UPDATE failed: {error}")
            raise error
    
    return {
        "auth": credentials,
        "files": {
            "get": get_file,
            "update": update_file
        }
    }

# ================================
# 🤖 Gemini問い合わせ
# ================================
async def ask_gemini(prompt):
    model_priority = [
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
    ]
    
    error_messages = [
        "民主主義パンチ！！！！！！！！！！！ﾎﾞｺｫ(エラー)",
        "ザンギエフしゅおしゅおびーむ(エラー)",
        "エラー！管理者何とかしろ！",
        "肌荒れと自走砲が！！！！(エラー)",
        "粉消しゴム美味しいよ(エラー)",
        "親から将来の夢無くなりました(エラー)",
        "髪の毛の年越しARねぎま塩(エラー)",
        "枝豆あげるw(エラー)",
        "もう帰りたい、眠い、学校なう！⊂(^ω^)⊃(エラー)"
    ]
    
    def get_random_error():
        return random.choice(error_messages)
    
    for model_id in model_priority:
        url = f"https://generativelanguage.googleapis.com/v1/models/{model_id}:generateContent?key={current_key}"
        
        try:
            print(f"モデル試行中: {model_id}")
            
            response = requests.post(
                url,
                json={
                    "contents": [
                        {
                            "role": "user",
                            "parts": [{"text": prompt}]
                        }
                    ]
                },
                headers={"Content-Type": "application/json"}
            )
            
            if response.status_code != 200:
                status = response.status_code
                data = response.text
                
                if data.startswith("<!"):
                    print(f"⚠️ HTMLレスポンス検知 → 次のモデルへ")
                    continue
                
                if status in [400, 404, 429]:
                    print(f"⚠️ {model_id} スキップ ({status})")
                    continue
                
                print(f"致命的エラー ({model_id}): {response.reason}")
                return get_random_error()
            
            data = response.json()
            text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text")
            
            if not text:
                print("⚠️ レスポンスが空。次のモデルへ")
                continue
            
            return text
        
        except Exception as error:
            print(f"エラー ({model_id}): {str(error)}")
            return get_random_error()
    
    return get_random_error()

# ================================
# 🤝 フォロバ & リムバ
# ================================
async def handle_follow_control(mk_client, my_id):
    try:
        followers = await mk_client.request('users/followers', {'userId': my_id, 'limit': 50})
        following = await mk_client.request('users/following', {'userId': my_id, 'limit': 50})
        follower_ids = [f['followerId'] for f in followers]
        
        for f in followers:
            target = f.get('follower')
            
            if target and not target.get('isFollowing') and not target.get('isBot') and target.get('id') != my_id:
                try:
                    await mk_client.request('following/create', {'userId': target.get('id')})
                    print(f"[フォロバ成功]: @{target.get('username')}")
                except Exception as e:
                    print(f"[フォロバ失敗]: {str(e)}")
        
        for f in following:
            target = f.get('followee')
            
            if target and target.get('id') not in follower_ids and target.get('id') != my_id:
                try:
                    await mk_client.request('following/delete', {'userId': target.get('id')})
                    print(f"[リムーブ成功]: @{target.get('username')} (片想い解除)")
                except Exception as e:
                    print(f"[リムーブ失敗]: {str(e)}")
    
    except Exception as e:
        print("フォロー整理処理でエラーが発生しましたが、続行します。")

# ================================
# 💬 メンション処理
# ================================
async def handle_mentions(mk_client, me):
    print("メンション確認中...")
    
    mentions = await mk_client.request('notes/mentions', {'limit': 12})
    reply_count = 0
    
    for note in mentions:
        if reply_count >= 4:
            break
        
        reply_text = ""
        
        if note.get('user', {}).get('isBot') or note.get('user', {}).get('id') == me.get('id') or note.get('myReplyId') or (note.get('repliesCount') and note.get('repliesCount') > 0):
            continue
        
        user_input = (note.get('text') or "").replace(f"@{me.get('username')}", "").strip()
        
        if not user_input:
            continue
        
        print(f"{note.get('user', {}).get('username')} さんからのメンションを処理中...")
        
        # リアクション処理
        if "おみくじ" in user_input or "マルコフ" in user_input:
            try:
                reaction_emoji = ":shiropuyo_good:" if "おみくじ" in user_input else ":Shiropuyo_galaxy:"
                await mk_client.request('notes/reactions/create', {
                    'noteId': note.get('id'),
                    'reaction': reaction_emoji
                })
            except Exception as reac_err:
                print(f"リアクション失敗: {str(reac_err)}")
        
        # マルコフ処理
        if "マルコフ" in user_input:
            print("マルコフ連鎖モード起動！")
            reply_text = await handle_markov_mode(mk_client, me)
        # 南鳥島チェッカー処理
        elif "南鳥島チェッカー" in user_input:
            print("🌊 南鳥島チェッカー起動")
            data = await get_minamitorishima_weather_raw()
            reply_text = format_minamitorishima_data(data)
        # おみくじ処理
        elif "おみくじ" in user_input:
            print("おみくじモード起動！")
            reply_text = await handle_omikuji_mode()
        # 通常会話
        else:
            print("💬 通常会話モード起動")
            reply_prompt = f"""{config['characterSetting']}
相手の言葉: {user_input} これに対して、90文字以内で返信してください。
-ユーザーのことは「マスター」と呼んでください！
^メンションと「@」は使用禁止。です"""
            
            await asyncio.sleep(10)
            reply_text = await ask_gemini(reply_prompt)
        
        # 共通の送信処理
        await mk_client.request('notes/create', {
            'text': reply_text.strip()[:200],
            'replyId': note.get('id'),
            'visibility': 'home'
        })
        
        print(f"{note.get('user', {}).get('username')} さんにリプライを送信しました。")
        reply_count += 1
        print("API制限回避のため5秒待機します...")
        await asyncio.sleep(5)

# ================================
# 🧠 マルコフモード処理（簡易版）
# ================================
async def handle_markov_mode(mk_client, me):
    tl = await mk_client.request('notes/timeline', {'limit': 72})
    
    tl_text = ""
    for n in tl:
        if n.get('text') and n.get('user', {}).get('id') != me.get('id') and 'http' not in n.get('text', ''):
            cleaned = re.sub(r'https?://[\w/:%#\$&\?\(\)~\.=\+\-]+', '', n.get('text', '')).strip()
            tl_text += cleaned + " "
    
    # 形態素解析
    words = tokenize_with_fugashi(tl_text)
    
    if not words:
        return "（タイムラインに材料がありません）"
    
    return generate_simple_markov(words)

# ================================
# 🧠 シンプルマルコフ生成（脳を使わない）
# ================================
def generate_simple_markov(words):
    if not words:
        return "（材料がありません）"
    
    def is_symbol(s):
        return not re.search(r'[a-zA-Z0-9\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uFF65-\uFF9F]', s)
    
    # 不要な要素をフィルタ
    cleaned_words = [w for w in words if w.strip() and not is_symbol(w)]
    
    if not cleaned_words:
        return "（材料がありません）"
    
    generated = ""
    length = random.randint(6, 10)
    
    for i in range(length):
        random_idx = random.randint(0, len(cleaned_words) - 1)
        generated += cleaned_words[random_idx]
        
        # 句点で終わったら中断
        if any(cleaned_words[random_idx].endswith(s) for s in ["。", "！", "？"]):
            break
    
    return generated or "（言葉が見つかりません）"

# ================================
# 🎴 おみくじモード処理
# ================================
async def handle_omikuji_mode():
    luck_num = random.randint(0, 99)
    
    if luck_num < 10:
        luck_result = "超大吉"
    elif luck_num < 30:
        luck_result = "大吉"
    elif luck_num < 60:
        luck_result = "中吉"
    elif luck_num < 85:
        luck_result = "小吉"
    elif luck_num < 95:
        luck_result = "末吉"
    else:
        luck_result = "凶"
    
    reply_prompt = f"""{config['characterSetting']}
【おみくじモード】  
結果は【{luck_result}】です。 
- 運勢の結果に基づいた、あなたらしい「今日のアドバイス」や「ラッキーアイテム」を1つ含めてください。 
- 結果(小吉など)を必ずしっかりと伝えてください。 
- 「おみくじの結果は〜」のような形式張った説明は不要。 
- 100文字以内で、親しみやすく、かつキャラクターの口調を崩さずに回答してください。 
- 相手の名前を呼んでも構いません。ただし、メンションと「@」使用禁止。純粋なテキストのみを出力し、音声演出用の記号は含めないでください"""
    
    await asyncio.sleep(10)
    return await ask_gemini(reply_prompt)

# ================================
# 🌊 南鳥島天気データフォーマット
# ================================
def format_minamitorishima_data(data):
    return (f"【南鳥島 観測データ】\n"
            f"・天気: {data.get('weather')}\n"
            f"・気温: {data.get('temp')}℃\n"
            f"・湿度: {data.get('humidity')}%\n"
            f"・気圧: {data.get('pressure')}hPa\n"
            f"・風速: {data.get('windSpeed')}m/s\n"
            f"・風向: {data.get('windDir')}°")

# ================================
# 🧠 脳データ読み込み
# ================================
async def load_brain_from_drive(drive):
    print("=== MARKOV MODE DEBUG ===")
    file_id = os.environ.get('GDRIVE_FILE_ID', '').strip() if os.environ.get('GDRIVE_FILE_ID') else None
    print(f'GDRIVE_FILE_ID: "{file_id}"')
    
    try:
        if not file_id:
            raise Exception("環境変数 GDRIVE_FILE_ID が読み込めていません！")
        
        raw_data = await drive['files']['get'](file_id)
        
        print(f"RESPONSE DATA TYPE: {type(raw_data)}")
        
        if isinstance(raw_data, dict):
            raw_data = json.dumps(raw_data)
        else:
            raw_data = str(raw_data)
        
        print(f"RESPONSE HEAD: {raw_data[:300]}")
        
        # HTML誤爆検知
        if raw_data.strip().startswith('<!'):
            title_match = re.search(r'<title>(.*?)</title>', raw_data, re.IGNORECASE)
            title = title_match.group(1) if title_match else 'No Title'
            print(f"🚨 Apache/GoogleからHTMLが返されました: {title}")
            print(f"HTML冒頭: {raw_data[:200]}")
            return {}
        
        # 空データ
        if not raw_data or raw_data.strip() == "":
            print("脳のデータが空でした。新規作成します。")
            return {}
        
        # JSON復元
        try:
            brain = json.loads(raw_data.strip()) if isinstance(raw_data, str) else raw_data
            word_count = len(brain)
            print(f"✅ 現在の脳の蓄積語数: {word_count}語")
            return brain
        except json.JSONDecodeError as p_err:
            print(f"🚨 JSONパースエラー: {str(p_err)}")
            print(f"受信データ冒頭: {raw_data[:100]}")
            return {}
    
    except Exception as e:
        print(f"❌ Google Drive接続致命的エラー: {str(e)}")
        return {}

# ================================
# 📚 脳学習（改良版）
# ================================
def learn_brain(brain, words):
    for i in range(len(words) - 1):
        w1 = words[i]
        w2 = words[i + 1]
        
        if w1 not in brain:
            brain[w1] = []
        
        brain[w1].append(w2)
        
        if len(brain[w1]) > 10000:
            brain[w1].pop(0)
    
    return brain

# ================================
# 💾 脳をGoogle Driveに保存
# ================================
async def save_brain_to_drive(drive, brain):
    file_id = os.environ.get('GDRIVE_FILE_ID', '').strip() if os.environ.get('GDRIVE_FILE_ID') else None
    if not file_id:
        return False
    
    try:
        payload = json.dumps(brain, ensure_ascii=False, indent=2)
        
        # Google Drive APIを使用してファイルを更新
        from io import BytesIO
        from googleapiclient.http import MediaIoBaseUpload
        
        media = MediaIoBaseUpload(BytesIO(payload.encode('utf-8')), mimetype='application/json')
        await drive['files']['update'](file_id, media)
        
        print("✅ Google Drive保存成功 (絶縁完了)")
        return True
    
    except Exception as e:
        print(f"❌ 例外発生: {str(e)}")
        return False

# ================================
# 🌍 ロケーション定義（グループA）
# ================================
locations_group_a = {
    "北海道": [
        {"name": "稚内市", "lat": 45.41, "lon": 141.67},
        {"name": "知床(斜里町)", "lat": 44.02, "lon": 144.98},
        {"name": "根室市", "lat": 43.33, "lon": 145.58},
        {"name": "阿寒(釧路市)", "lat": 43.43, "lon": 144.09},
        {"name": "ニセコ町", "lat": 42.80, "lon": 140.68},
        {"name": "夕張市", "lat": 43.05, "lon": 141.97},
        {"name": "日高町", "lat": 42.48, "lon": 142.07},
        {"name": "札幌市", "lat": 43.06, "lon": 141.35},
        {"name": "苫小牧市", "lat": 42.63, "lon": 141.60},
        {"name": "函館市", "lat": 41.76, "lon": 140.72},
        {"name": "択捉島", "lat": 45.0, "lon": 147.5},
        {"name": "国後島", "lat": 44.0, "lon": 145.8}
    ],
    "樺太・千島列島": [
        {"name": "占守島", "lat": 50.7, "lon": 156.2},
        {"name": "幌筵島(パラムシル)", "lat": 50.1, "lon": 155.3},
        {"name": "得撫島(ウルップ)", "lat": 45.8, "lon": 149.9},
        {"name": "ユジノサハリンスク（旧:豊原）", "lat": 46.95, "lon": 142.73},
        {"name": "ホルムスク（旧:真岡）", "lat": 47.05, "lon": 142.04},
        {"name": "ポロナイスク（旧:敷香）", "lat": 49.22, "lon": 143.11},
        {"name": "アレクサンドロフスク", "lat": 50.9, "lon": 142.15}
    ],
    "東北": [
        {"name": "大間町", "lat": 41.53, "lon": 140.91},
        {"name": "青森市", "lat": 40.82, "lon": 140.75},
        {"name": "秋田市", "lat": 39.72, "lon": 140.10},
        {"name": "盛岡市", "lat": 39.70, "lon": 141.15},
        {"name": "平泉町", "lat": 38.98, "lon": 141.11},
        {"name": "仙台市", "lat": 38.27, "lon": 140.87},
        {"name": "三春町", "lat": 37.44, "lon": 140.48},
        {"name": "山形市", "lat": 38.25, "lon": 140.33},
        {"name": "郡山市", "lat": 37.40, "lon": 140.38},
        {"name": "福島市", "lat": 37.76, "lon": 140.47}
    ],
    "関東": [
        {"name": "日光市", "lat": 36.75, "lon": 139.61},
        {"name": "日立市", "lat": 36.60, "lon": 140.65},
        {"name": "水戸市", "lat": 36.37, "lon": 140.45},
        {"name": "前橋市", "lat": 36.38, "lon": 139.06},
        {"name": "宇都宮市", "lat": 36.57, "lon": 139.88},
        {"name": "霞ヶ浦", "lat": 36.08, "lon": 140.20},
        {"name": "大宮", "lat": 35.91, "lon": 139.63},
        {"name": "成田市", "lat": 35.78, "lon": 140.31},
        {"name": "千葉市", "lat": 35.61, "lon": 140.12},
        {"name": "東京都(新宿区)", "lat": 35.69, "lon": 139.69},
        {"name": "八王子市", "lat": 35.66, "lon": 139.33},
        {"name": "横浜市", "lat": 35.44, "lon": 139.64},
        {"name": "箱根町", "lat": 35.23, "lon": 139.10},
        {"name": "館山市", "lat": 34.99, "lon": 139.86}
    ],
    "甲信越": [
        {"name": "新潟市", "lat": 37.92, "lon": 139.05},
        {"name": "佐渡島", "lat": 38.00, "lon": 138.40},
        {"name": "上越市", "lat": 37.14, "lon": 138.24},
        {"name": "越後湯沢", "lat": 36.93, "lon": 138.80},
        {"name": "長野市", "lat": 36.65, "lon": 138.18},
        {"name": "松本市", "lat": 36.23, "lon": 137.97},
        {"name": "軽井沢町", "lat": 36.34, "lon": 138.63},
        {"name": "草津町", "lat": 36.62, "lon": 138.60},
        {"name": "甲府市", "lat": 35.66, "lon": 138.57}
    ],
    "東海": [
        {"name": "富士市", "lat": 35.16, "lon": 138.67},
        {"name": "静岡市", "lat": 34.98, "lon": 138.38},
        {"name": "浜松市", "lat": 34.71, "lon": 137.72},
        {"name": "下田市", "lat": 34.67, "lon": 138.94},
        {"name": "岐阜市", "lat": 35.42, "lon": 136.76},
        {"name": "大垣市", "lat": 35.36, "lon": 136.61},
        {"name": "名古屋市", "lat": 35.18, "lon": 136.91},
        {"name": "津市", "lat": 34.72, "lon": 136.51},
        {"name": "鳥羽市", "lat": 34.48, "lon": 136.84},
        {"name": "長島", "lat": 35.05, "lon": 136.70}
    ]
}

# ================================
# 🌍 ロケーション定義（グループB）
# ================================
locations_group_b = {
    "北陸": [
        {"name": "富山市", "lat": 36.70, "lon": 137.21},
        {"name": "高岡市", "lat": 36.75, "lon": 137.01},
        {"name": "金沢市", "lat": 36.56, "lon": 136.65},
        {"name": "輪島市", "lat": 37.39, "lon": 136.90},
        {"name": "白山市", "lat": 36.51, "lon": 136.56},
        {"name": "柏崎市", "lat": 37.36, "lon": 138.55},
        {"name": "福井市", "lat": 36.06, "lon": 136.22},
        {"name": "敦賀市", "lat": 35.65, "lon": 136.06},
        {"name": "小浜市", "lat": 35.49, "lon": 135.74},
        {"name": "大野市", "lat": 35.98, "lon": 136.48}
    ],
    "近畿": [
        {"name": "京都市", "lat": 35.01, "lon": 135.76},
        {"name": "舞鶴市", "lat": 35.47, "lon": 135.33},
        {"name": "福知山市", "lat": 35.30, "lon": 135.13},
        {"name": "大津市", "lat": 35.01, "lon": 135.86},
        {"name": "彦根市", "lat": 35.27, "lon": 136.25},
        {"name": "大阪市", "lat": 34.69, "lon": 135.50},
        {"name": "堺市", "lat": 34.57, "lon": 135.48},
        {"name": "豊中市", "lat": 34.78, "lon": 135.46},
        {"name": "神戸市", "lat": 34.69, "lon": 135.19},
        {"name": "姫路市", "lat": 34.81, "lon": 134.69},
        {"name": "奈良市", "lat": 34.68, "lon": 135.83},
        {"name": "十津川村", "lat": 34.02, "lon": 135.84},
        {"name": "和歌山市", "lat": 34.23, "lon": 135.17},
        {"name": "田辺市", "lat": 33.93, "lon": 135.48},
        {"name": "串本町", "lat": 33.47, "lon": 135.78},
        {"name": "淡路島", "lat": 34.34, "lon": 134.89}
    ],
    "中国": [
        {"name": "鳥取市", "lat": 35.50, "lon": 134.24},
        {"name": "米子市", "lat": 35.43, "lon": 133.33},
        {"name": "松江市", "lat": 35.47, "lon": 133.05},
        {"name": "出雲市", "lat": 35.36, "lon": 132.75},
        {"name": "隠岐(海士町)", "lat": 36.10, "lon": 133.10},
        {"name": "津山市", "lat": 35.06, "lon": 134.00},
        {"name": "岡山市", "lat": 34.66, "lon": 133.92},
        {"name": "倉敷市", "lat": 34.58, "lon": 133.77},
        {"name": "広島市", "lat": 34.39, "lon": 132.46},
        {"name": "福山市", "lat": 34.48, "lon": 133.36},
        {"name": "三次市", "lat": 34.80, "lon": 132.85},
        {"name": "呉市", "lat": 34.25, "lon": 132.57},
        {"name": "山口市", "lat": 34.18, "lon": 131.47},
        {"name": "下関市", "lat": 33.95, "lon": 130.93},
        {"name": "岩国市", "lat": 34.17, "lon": 132.22}
    ],
    "四国": [
        {"name": "松山市", "lat": 33.84, "lon": 132.77},
        {"name": "今治市", "lat": 34.07, "lon": 133.00},
        {"name": "新居浜市", "lat": 33.96, "lon": 133.28},
        {"name": "宇和島市", "lat": 33.22, "lon": 132.56},
        {"name": "高松市", "lat": 34.34, "lon": 134.04},
        {"name": "丸亀市", "lat": 34.29, "lon": 133.79},
        {"name": "観音寺市", "lat": 34.12, "lon": 133.65},
        {"name": "徳島市", "lat": 34.07, "lon": 134.55},
        {"name": "阿南市", "lat": 33.92, "lon": 134.65},
        {"name": "三好市(池田)", "lat": 34.02, "lon": 133.80},
        {"name": "高知市", "lat": 33.56, "lon": 133.53},
        {"name": "四万十市", "lat": 32.99, "lon": 132.93},
        {"name": "室戸市", "lat": 33.28, "lon": 134.15}
    ],
    "九州": [
        {"name": "福岡市", "lat": 33.59, "lon": 130.40},
        {"name": "北九州市", "lat": 33.88, "lon": 130.88},
        {"name": "佐賀市", "lat": 33.26, "lon": 130.30},
        {"name": "佐世保市", "lat": 33.18, "lon": 129.72},
        {"name": "長崎市", "lat": 32.75, "lon": 129.88},
        {"name": "対馬市", "lat": 34.20, "lon": 129.29},
        {"name": "熊本市", "lat": 32.79, "lon": 130.71},
        {"name": "阿蘇市", "lat": 32.94, "lon": 131.12},
        {"name": "大分市", "lat": 33.24, "lon": 131.61},
        {"name": "宮崎市", "lat": 31.91, "lon": 131.42},
        {"name": "鹿児島市", "lat": 31.56, "lon": 130.56},
        {"name": "出水市", "lat": 32.08, "lon": 130.35},
        {"name": "屋久島", "lat": 30.34, "lon": 130.51}
    ],
    "沖縄・南方": [
        {"name": "那覇市", "lat": 26.21, "lon": 127.68},
        {"name": "与那国島", "lat": 24.47, "lon": 123.01},
        {"name": "石垣市", "lat": 24.34, "lon": 124.16},
        {"name": "奄美市", "lat": 28.37, "lon": 129.48},
        {"name": "南鳥島", "lat": 24.28, "lon": 153.98},
        {"name": "小笠原諸島", "lat": 27.09, "lon": 142.19}
    ],
    "南極": [
        {"name": "昭和基地", "lat": -69.00, "lon": 39.58}
    ],
    "世界の極地・極点": [
        {"name": "オイミャコン(ロシア)", "lat": 63.46, "lon": 142.78},
        {"name": "ベルホヤンスク(ロシア)", "lat": 67.55, "lon": 133.38},
        {"name": "デスバレー(アメリカ)", "lat": 36.46, "lon": -116.87},
        {"name": "クウェートシティ(クウェート)", "lat": 29.37, "lon": 47.97},
        {"name": "アリカ(チリ)", "lat": -18.47, "lon": -70.30},
        {"name": "チェラプンジ(インド)", "lat": 25.27, "lon": 91.73},
        {"name": "ラ・リンコナーダ(ペルー)", "lat": -14.63, "lon": -69.44},
        {"name": "ロングイェールビーン(ノルウェー)", "lat": 78.22, "lon": 15.63},
        {"name": "ウシュアイア(アルゼンチン)", "lat": -54.80, "lon": -68.30},
        {"name": "アムンゼン・スコット基地(南極点)", "lat": -90.0, "lon": 0.0}
    ]
}

# ================================
# 🌡️ 天気予報レポート生成
# ================================
async def generate_weather_report(mode, locations):
    all_points = []
    for region in locations:
        for loc in locations[region]:
            all_points.append({**loc, "region": region})
    
    lats = ",".join([str(p["lat"]) for p in all_points])
    lons = ",".join([str(p["lon"]) for p in all_points])
    url = f"https://api.open-meteo.com/v1/forecast?latitude={lats}&longitude={lons}&hourly=weathercode,temperature_2m,precipitation_probability&timezone=Asia%2FTokyo"
    
    report = "☀️ 本日の広域予報\n\n" if mode == 'morning' else "🌙 明日の広域予報\n\n"
    base_hour = 0 if mode == 'morning' else 24
    am_idx = base_hour + 9
    pm_idx = base_hour + 15
    
    try:
        response = requests.get(url)
        data = response.json()
        results = data if isinstance(data, list) else [data]
        
        def get_emoji(code):
            if code <= 1:
                return "☀️"
            elif code <= 3:
                return "⛅"
            elif code == 45 or code == 48:
                return "🌫️"
            elif 51 <= code <= 55:
                return "☔"
            elif code in [56, 57, 66, 67]:
                return "🧊☔"
            elif code == 61:
                return "☔"
            elif code == 63:
                return "🟨☔"
            elif code == 65:
                return "🟥☔"
            elif 71 <= code <= 75:
                return "❄️"
            elif code == 77:
                return "🧊"
            elif code == 80:
                return "☔"
            elif code == 81:
                return "🟥☔"
            elif code == 82:
                return "⬛☔"
            elif 85 <= code <= 86:
                return "⛄"
            elif code >= 95:
                return "⛈️"
            else:
                return "☁️"
        
        current_index = 0
        for region in locations:
            report += f"【{region}】\n"
            for loc in locations[region]:
                h = results[current_index]["hourly"]
                am_emoji = get_emoji(h["weathercode"][am_idx])
                am_temp = round(h["temperature_2m"][am_idx])
                pm_emoji = get_emoji(h["weathercode"][pm_idx])
                pm_temp = round(h["temperature_2m"][pm_idx])
                day_prob = max(h["precipitation_probability"][base_hour:base_hour + 24])
                
                report += f"{loc['name']}: {am_emoji}{am_temp}℃→{pm_emoji}{pm_temp}℃ ({day_prob}%)\n"
                current_index += 1
            report += "\n"
    
    except Exception as e:
        print(f"🚨 エラー: {str(e)}")
        return "⚠️ データ取得エラーが発生しました。"
    
    return report

# ================================
# 🧹 脳クリーニング
# ================================
def clean_brain(brain):
    print("🧹 脳のクリーニング中...")
    
    keys_to_delete = []
    
    for key in brain:
        is_invalid_key = (
            '\n' in key or
            '\\n' in key or
            '　' in key or
            '<' in key or
            '\\' in key or
            'small' in key or
            'color' in key or
            '\\u' in key or
            '@' in key or
            '[' in key or
            ']' in key or
            '$' in key or
            '>' in key or
            'Shi' in key or
            '/' in key or
            '​' in key or
            'center' in key or
            '(+' in key or
            '(-' in key or
            bool(re.search(r'[\uD800-\uDBFF]', key)) or
            bool(re.search(r'[\uDC00-\uDFFF]', key)) or
            bool(re.search(r'\?{3,}', key)) or
            bool(re.match(r'^:[a-zA-Z0-9_]+:$', key)) or
            bool(re.search(r':[a-zA-Z0-9_]+:', key)) or
            bool(re.search(r'[^\u0000-\u0039\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uFF65-\uFF9F\s、。！？w…ー・]', key)) or
            '_' in key or
            bool(re.match(r'^[:＿]+$', key)) or
            bool(re.search(r'emoji|code|image|html', key, re.IGNORECASE))
        )
        
        word_list = brain[key]
        
        if isinstance(word_list, list):
            brain[key] = [
                w for w in word_list if isinstance(w, str) and
                '\n' not in w and
                '\\n' not in w and
                '　' not in w and
                '@' not in w and
                '<' not in w and
                '\\' not in w and
                'small' not in w and
                'color' not in w and
                '\\u' not in w and
                '[' not in w and
                ']' not in w and
                '$' not in w and
                '>' not in w and
                'Shi' not in w and
                '/' not in w and
                '​' not in w and
                'center' not in w and
                '(+' not in w and
                '(-' not in w and
                not bool(re.match(r'^:[a-zA-Z0-9_]+:$', w)) and
                not bool(re.search(r':[a-zA-Z0-9_]+:', w)) and
                not bool(re.search(r'\?{3,}', w)) and
                not bool(re.search(r'[^\u0000-\u0039\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uFF65-\uFF9F\s、。！？w…ー・]', w)) and
                not bool(re.search(r'[\uD800-\uDBFF]', w)) and
                not bool(re.search(r'[\uDC00-\uDFFF]', w)) and
                w.strip() != ""
            ]
        
        if is_invalid_key or not brain[key] or len(brain[key]) == 0:
            keys_to_delete.append(key)
    
    for key in keys_to_delete:
        del brain[key]
    
    print("✅ 脳のクリーニング完了！")
    return brain

# ================================
# 🧠 マルコフ生成（メイン版：脳を使う）
# ================================
def generate_markov(words, brain):
    if not words:
        return "（材料がありません）"
    
    def is_symbol(s):
        return not re.search(r'[a-zA-Z0-9\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uFF65-\uFF9F]', s)
    
    markov_dict = {}
    for i in range(len(words) - 1):
        w1 = words[i]
        w2 = words[i + 1]
        if w1 not in markov_dict:
            markov_dict[w1] = []
        markov_dict[w1].append(w2)
    
    def pick_next_word(word_list):
        if not word_list:
            return ""
        
        candidate = random.choice(word_list)
        
        if is_symbol(candidate) and random.random() < 0.6:
            candidate = random.choice(word_list)
        
        attempts = 0
        while re.search(r'マルコフ|おみくじ|タイムライン|@|#|死', candidate) and attempts < 5:
            candidate = random.choice(words)
            attempts += 1
        
        return candidate
    
    # 目標文字数をランダムに決定（20~40文字）
    target_length = random.randint(20, 40)
    
    generated = ""
    current_word = pick_next_word(words)
    
    # 目標文字数に達するまでループ
    while len(generated) < target_length:
        if not current_word:
            current_word = pick_next_word(words)
        
        found_next = ""
        use_brain = random.random() < 0.7
        
        if use_brain and current_word in particles and current_word in brain:
            candidates = brain[current_word]
            found_next = random.choice(candidates)
        
        if not found_next and current_word in markov_dict:
            found_next = pick_next_word(markov_dict[current_word])
        
        current_word = found_next or pick_next_word(words)
        
        # 長い連続ひらがな・カタカナをスキップ
        if re.match(r'^[\u3040-\u309F]{8,}$|^[\u30A0-\u30FF]{8,}$', current_word):
            current_word = pick_next_word(words)
            continue
        
        generated += current_word
        
        # 終端文字で自然に終了
        if any(current_word.endswith(s) for s in ["。", "！", "？", "w", "…"]):
            break
    
    output_text = generated or "（言葉の断片が見つかりませんでした）"
    
    # テキスト後処理
    output_text = re.sub(r':[^:]*:', '', output_text)
    output_text = output_text.replace(' ', '').replace('　', '')
    output_text = re.sub(r'<[^>]*>', '', output_text)
    output_text = re.sub(r'\\u[0-9a-fA-F]{4}', '', output_text)
    output_text = output_text.replace('\\', '').strip()
    
    return output_text

# ================================
# 🌊 南鳥島天気データ取得
# ================================
async def get_minamitorishima_weather_raw():
    try:
        url = "https://api.open-meteo.com/v1/forecast?latitude=24.28&longitude=153.98&current=weather_code,temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m"
        response = requests.get(url)
        data = response.json()
        current = data.get("current", {})
        
        weather_str = "曇り"
        code = current.get("weather_code")
        if code <= 1:
            weather_str = "快晴"
        elif code <= 3:
            weather_str = "晴れ"
        elif 51 <= code <= 67:
            weather_str = "雨"
        elif code >= 95:
            weather_str = "雷雨"
        
        return {
            "weather": weather_str,
            "temp": round(current.get("temperature_2m", 0)),
            "humidity": current.get("relative_humidity_2m"),
            "pressure": round(current.get("surface_pressure", 0)),
            "windSpeed": current.get("wind_speed_10m"),
            "windDir": current.get("wind_direction_10m")
        }
    except Exception as e:
        print(f"データ取得失敗: {str(e)}")
        return {
            "weather": "取得不可",
            "temp": "--",
            "humidity": "--",
            "pressure": "--",
            "windSpeed": "--",
            "windDir": "--"
        }

# ================================
# 🚀 メイン処理
# ================================
async def main():
    try:
        print("=== API Connection Check ===")
        
        domain = (os.environ.get('MK_DOMAIN') or "").strip().replace("https://", "").replace("http://", "").split("/")[0]
        token = (os.environ.get('MK_TOKEN') or "").strip()
        
        if not domain or not token:
            raise Exception("MK_DOMAIN または MK_TOKEN が環境変数に設定されていません。")
        
        # Misskey用クライアント
        class MisKeyClient:
            def __init__(self, domain, token):
                self.domain = domain
                self.token = token
            
            async def request(self, path, payload=None):
                """Misskeyへのリクエスト"""
                if payload is None:
                    payload = {}
                
                post_data = json.dumps({"i": self.token, **payload})
                
                try:
                    response = requests.post(
                        f"https://{self.domain}/api/{path}",
                        data=post_data,
                        headers={"Content-Type": "application/json"}
                    )
                    
                    if response.status_code >= 200 and response.status_code < 300:
                        try:
                            return response.json()
                        except:
                            return response.text
                    else:
                        raise Exception(f"API Error {response.status_code}: {response.text[:100]}")
                
                except Exception as e:
                    raise e
        
        mk = MisKeyClient(domain, token)
        
        # ログイン
        me = await mk.request('i')
        my_id = me.get('id')
        print(f"✅ Logged in as: @{me.get('username')} ({my_id})")
        
        # フォロバ・リムバ
        await handle_follow_control(mk, my_id)
        
        # メンション処理
        await handle_mentions(mk, me)
        
        # 時間判定（日本時間）
        jst_now = datetime.now(timezone.utc) + timedelta(hours=9)
        hour = jst_now.hour
        minute = jst_now.minute
        
        is_morning = (hour == 7 and minute <= 15)
        is_evening = (hour == 19 and minute <= 15)
        is_midnight = (hour == 0 and minute <= 15)
        
        # 天気予報投稿
        if is_morning or is_evening or is_midnight:
            print("🌡 天気予報投稿モード始動（2段階投稿）...")
            
            mode = 'morning' if is_morning else 'evening'
            day_label = "本日" if is_morning else "明日"
            
            legend = "\n【凡例】\n表示: [午前9時] → [午後15時] (1日の最大降水確率%)\n🟨☔=強い雨 / 🟥☔=激しい雨 / ⬛☔=猛烈な雨 / ⛈️=雷雨 / ❄️=雪 / ⛄=み種"
            
            # グループA投稿
            print("📡 グループA（東日本・北日本）取得中...")
            report_a = await generate_weather_report(mode, locations_group_a)
            cw_a = f"{'☀️' if is_morning else '🌙'} {day_label}の天気予報【東日本・北日本・樺太】"
            
            await mk.request('notes/create', {
                'text': report_a + legend,
                'cw': cw_a,
                'visibility': 'public'
            })
            
            print("⏳ 5秒待機して第2弾を投稿します...")
            await asyncio.sleep(5)
            
            # グループB投稿
            print("📡 グループB（西日本・海外・極地）取得中...")
            report_b = await generate_weather_report(mode, locations_group_b)
            cw_b = f"{'☀️' if is_morning else '🌙'} {day_label}の天気予報【西日本・南方・海外極地】"
            
            await mk.request('notes/create', {
                'text': report_b + legend,
                'cw': cw_b,
                'visibility': 'public'
            })
            
            print(f"✅ 天気予報({mode})を2つのノートに分けて投稿しました。")
            
            print("⏳ 4秒待機してマルコフ連鎖を開始します...")
            await asyncio.sleep(4)
        
        # 定期投稿の準備
        print("定期投稿の準備を開始します...")
        await asyncio.sleep(2)
        
        # Google Driveから脳データをロード
        drive = await get_drive_auth()
        brain = await load_brain_from_drive(drive)
        brain = clean_brain(brain)
        
        # タイムライン取得
        print("👉 タイムラインを取得します...")
        tl_raw = await mk.request('notes/timeline', {'limit': 100})
        tl = tl_raw if isinstance(tl_raw, list) else (tl_raw.get('notes') or [])
        
        all_texts = []
        
        # 形態素解析前の前処理
        for n in tl:
            # 自分の投稿、ボット、URL含む投稿をスキップ
            if (not n.get('text') or 
                n.get('user', {}).get('id') == my_id or 
                n.get('user', {}).get('isBot')):
                continue
            
            # 前処理：URL と :word: を除去
            cleaned_text = preprocess_text(n.get('text', ''))
            
            if cleaned_text.strip():
                all_texts.append(cleaned_text)
        
        print(f"【収集完了】有効なテキスト: {len(all_texts)}件")
        
        # 形態素解析して単語分割
        all_words = []
        for text in all_texts:
            try:
                # Fugashiで形態素解析
                words = tokenize_with_fugashi(text)
                all_words.extend(words)
            except Exception as e:
                print(f"⚠️ 形態素解析エラー: {str(e)}")
                continue
        
        print(f"【分析実行】総単語数: {len(all_words)}")
        
        # 学習
        if all_words:
            brain = learn_brain(brain, all_words)
            brain = clean_brain(brain)
            await save_brain_to_drive(drive, brain)
            
            vocabulary_count = len(brain)
            connection_count = sum(len(v) for v in brain.values())
            
            print(f"✅ 脳の更新が完了しました！")
            print(f"📊 語彙数(単語の種類): {vocabulary_count}")
            print(f"⚖️ 総重み数(経験値): {connection_count}")
        
        # マルコフ連鎖による文章生成
        output_text = generate_markov(all_words, brain)
        
        retry_count = 0
        while (not output_text or len(output_text) < 4) and retry_count < 5:
            if retry_count > 0:
                print(f"再生成試行中... ({retry_count}回目)")
            output_text = generate_markov(all_words, brain)
            retry_count += 1
        
        # 最終投稿
        print("👉 Misskeyに最終投稿します...")
        try:
            res_data = await mk.request('notes/create', {
                'text': output_text.strip()[:110],
                'visibility': 'home'
            })
            note_id = res_data.get('createdNote', {}).get('id') if isinstance(res_data, dict) else "N/A"
            print(f"✅ 投稿成功！ Note ID: {note_id}")
        except Exception as err:
            print("━━━━━━━━━━━━━ 🚨 投稿失敗 🚨 ━━━━━━━━━━━━━")
            print(f"原因: {str(err)}")
        
        print("全工程が正常に完了しました！内容: " + output_text)
    
    except Exception as e:
        print(f"致命的なエラーが発生しました: {str(e)}")
        try:
            print(f"[System Log] 実行停止: {str(e)}")
        except:
            pass

# ================================
# ▶ 実行開始
# ================================
if __name__ == "__main__":
    asyncio.run(main())
