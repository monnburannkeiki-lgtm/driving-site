// 動画アップロードの「枠」の発行と、処理状況の確認だけを担当します。
// 動画本体はブラウザからGoogleへ直接送られるため、Vercelの4.5MB制限には当たりません。
// APIキー（GEMINI_API_KEY）はこのサーバー側だけで使います。
const BASE = "https://generativelanguage.googleapis.com";
const MAX_SIZE = 100 * 1024 * 1024; // 100MBまで

module.exports = async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "サーバーに GEMINI_API_KEY が設定されていません。" });

  try {
    const action = req.query.action;

    // 1) アップロード枠（Resumable Upload のセッションURL）を発行
    if (req.method === "POST" && action === "start") {
      const { name, size, mime } = req.body || {};
      if (typeof mime !== "string" || !mime.startsWith("video/")) return res.status(400).json({ error: "動画ファイルを選んでください。" });
      if (!(size > 0) || size > MAX_SIZE) return res.status(400).json({ error: "動画は100MB以下にしてください。" });

      const r = await fetch(BASE + "/upload/v1beta/files", {
        method: "POST",
        headers: {
          "x-goog-api-key": key,
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(size),
          "X-Goog-Upload-Header-Content-Type": mime,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ file: { display_name: String(name || "video").slice(0, 80) } })
      });
      if (!r.ok) return res.status(502).json({ error: "アップロードを開始できませんでした（" + r.status + "）" });

      const u = new URL(r.headers.get("x-goog-upload-url"));
      u.searchParams.delete("key"); // キーはヘッダーで渡しているためURLには入らないが、念のため取り除く
      return res.status(200).json({ uploadUrl: u.toString() });
    }

    // 2) 動画の処理状況の確認
    if (req.method === "GET" && action === "status") {
      const name = String(req.query.name || "");
      if (!/^files\/[a-z0-9-]{1,60}$/.test(name)) return res.status(400).json({ error: "ファイル名が正しくありません。" });
      const r = await fetch(BASE + "/v1beta/" + name, { headers: { "x-goog-api-key": key } });
      if (!r.ok) return res.status(502).json({ error: "処理状況を確認できませんでした（" + r.status + "）" });
      return res.status(200).json(await r.json());
    }

    return res.status(400).json({ error: "不正なリクエストです。" });
  } catch (e) {
    return res.status(500).json({ error: "サーバーでエラーが発生しました。" });
  }
};
