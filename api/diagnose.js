// 診断の実行。APIキー（GEMINI_API_KEY）とプロンプトはサーバー側だけにあります。
const BASE = "https://generativelanguage.googleapis.com";
const MODEL = "gemini-3.8-flash";

function buildPrompt(memo) {
  return [
    "あなたはプロの教習指導員です。添付された運転動画を見て、「視線の配り方」「車間距離」「ハンドル操作」「速度調整」の4つの観点について、良かった点と改善点を日本語で具体的に出力してください。",
    "出力は次の形式にしてください。観点ごとに見出し（## を付ける）を作り、その下に「良かった点」と「改善点」を箇条書きで書きます。",
    "## 視線の配り方",
    "## 車間距離",
    "## ハンドル操作",
    "## 速度調整",
    "各項目は、動画の中の具体的な場面（わかる場合は時間も添える）を挙げ、どう直せばよいかを一言で書いてください。",
    "動画から判断できない観点は推測せず「動画からは判断できません」と書いてください。交通ルール違反や危険な場面があれば、最初に伝えてください。",
    memo ? "利用者からの補足：" + memo : ""
  ].filter(Boolean).join("\n");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POSTで呼び出してください。" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "サーバーに GEMINI_API_KEY が設定されていません。" });

  const { fileUri, mime, memo } = req.body || {};
  if (typeof fileUri !== "string" || !fileUri.startsWith(BASE + "/v1beta/files/")) {
    return res.status(400).json({ error: "動画の情報が正しくありません。" });
  }
  if (typeof mime !== "string" || !mime.startsWith("video/")) {
    return res.status(400).json({ error: "動画の形式が正しくありません。" });
  }

  try {
    const r = await fetch(BASE + "/v1beta/models/" + MODEL + ":generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { file_data: { mime_type: mime, file_uri: fileUri } },
            { text: buildPrompt(typeof memo === "string" ? memo.slice(0, 300) : "") }
          ]
        }],
        // 無料プランの関数は最長60秒のため、思考を軽め（low）にして時間内に返します
        generationConfig: { thinkingConfig: { thinkingLevel: "low" } }
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: "診断に失敗しました（" + r.status + "）：" + (data.error?.message || "") });

    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    if (!text) {
      return res.status(502).json({ error: data.promptFeedback?.blockReason ? "内容の安全性判定により結果が返されませんでした。" : "AIから結果が返ってきませんでした。" });
    }
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: "サーバーでエラーが発生しました。" });
  }
};
