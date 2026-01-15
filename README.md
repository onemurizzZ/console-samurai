# Console Samurai

Console Samurai は、ランタイムの console 出力やエラーを VS Code に集約し、
エディタ内のインライン表示やログビューアで確認できる拡張機能です。
WebSocket ブリッジを使って、ブラウザ/Node のログを VS Code に送信します。

## 特長

- console.log / info / warn / error / debug / trace の表示
- console.time / timeLog / timeEnd の計測ログ
- ブラウザのネットワークログ (fetch / XMLHttpRequest)
- エディタ内のインライン表示 (ホバーで詳細)
- ログビューア (検索・レベルフィルタ・展開表示)
- Node / ブラウザ両方のランタイムに対応

## クイックスタート

1) VS Code で拡張を実行 (F5) するか、パッケージをインストールします。
2) ステータスバーに `Console Samurai: host:port` が表示されればサーバ稼働中です。
3) アプリ側にクライアントを追加します。

### ブラウザで使う

```html
<script src="/path/to/console-samurai-client.js"></script>
<script>
  // 必要なら設定を上書き
  window.__CONSOLE_SAMURAI__ = { host: '127.0.0.1', port: 4973 };
</script>
```

### Node で使う

```bash
node -r /path/to/console-samurai-node.js your-app.js
```

### Node 自動アタッチ (おすすめ)

VS Code の統合ターミナルで `node ./index.js` や `npm run dev` などを実行するだけで
Console Samurai が自動的に有効になるようにできます。

設定: `console-samurai.node.autoAttach` (既定: true)

注意: 環境変数を使うため **新しく開いたターミナル** から有効になります。
既存のターミナルは閉じて開き直してください。

## 設定

VS Code の設定から `console-samurai.*` を調整できます。

主な項目:
- `console-samurai.autoStart` : サーバの自動起動
- `console-samurai.host` / `console-samurai.port` : WebSocket の待受
- `console-samurai.maxLogEntries` : 保存するログ件数
- `console-samurai.inline.*` : インライン表示のON/OFFや表示文字数
- `console-samurai.output.enabledLevels` : 表示するログレベル
- `console-samurai.network.enabled` : ネットワークログのON/OFF
- `console-samurai.captureErrors` : ランタイムエラーの捕捉
- `console-samurai.node.autoAttach` : Node の自動アタッチ
- `console-samurai.pathMappings` : URL→ローカルパスの対応付け
- `console-samurai.logCaptureOptions` : シリアライズの上限
