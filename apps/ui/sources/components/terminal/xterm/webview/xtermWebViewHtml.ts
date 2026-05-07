import { XTERM_WEBVIEW_BUNDLE_JS, XTERM_WEBVIEW_CSS } from './xtermWebViewAssets.generated';

export type XtermWebViewTheme = Readonly<{
    backgroundColor: string;
    textColor: string;
    cursorColor: string;
    selectionBackgroundColor: string;
    isDark: boolean;
}>;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

export function buildXtermWebViewHtml(params: Readonly<{
    theme: XtermWebViewTheme;
    fontSizePx: number;
    lineHeightPx: number;
    maxChunkBytes: number;
    allowCdnFallback: boolean;
}>): string {
    const maxChunkBytes = clampNumber(params.maxChunkBytes, 64_000, 8_000, 256_000);
    const fontSizePx = clampNumber(params.fontSizePx, 13, 8, 40);
    const lineHeightPx = clampNumber(params.lineHeightPx, Math.round(fontSizePx * 1.35), 10, 80);
    const lineHeight = clampNumber(lineHeightPx / Math.max(1, fontSizePx), 1.35, 1, 2.5);

    const themeJson = JSON.stringify(params.theme);

    const embeddedBundle = typeof XTERM_WEBVIEW_BUNDLE_JS === 'string' ? XTERM_WEBVIEW_BUNDLE_JS.trim() : '';
    const embeddedCss = typeof XTERM_WEBVIEW_CSS === 'string' ? XTERM_WEBVIEW_CSS.trim() : '';
    const hasEmbeddedBundle = embeddedBundle.length > 0;

    // NOTE: Dev-only best-effort CDN fallback for when the embedded bundle isn't available.
    // This keeps the terminal usable in environments where postinstall generation is skipped.
    const cdnModuleImports =
        hasEmbeddedBundle || !params.allowCdnFallback
            ? ''
            : `[
                import('https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm'),
                import('https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/+esm'),
                import('https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/+esm'),
              ]`;

    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
    <style>
      html, body {
        margin: 0;
        height: 100%;
        background: ${params.theme.backgroundColor};
      }
      #root {
        height: 100%;
        width: 100%;
        overflow: hidden;
      }
      ${embeddedCss}
    </style>
  </head>
  <body>
    <div id="root"></div>
    ${hasEmbeddedBundle ? `<script>${embeddedBundle}</script>` : ''}
    <script type="module">
      const MAX_CHUNK_BYTES = ${maxChunkBytes};
      const DEFAULT_CONFIG = {
        theme: ${themeJson},
        fontSizePx: ${Math.round(fontSizePx)},
        lineHeight: ${lineHeight},
      };
      const INITIAL_READY_FIT_DELAY_MS = 20;
      const READY_FIT_RETRY_INTERVAL_MS = 50;
      const READY_FIT_RETRY_LIMIT = 30;

      function postRaw(value) {
        try {
          window.ReactNativeWebView.postMessage(value);
        } catch (e) {
          // Ignore.
        }
      }

      function bytesToBase64(bytes) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
      }

      function base64ToBytes(value) {
        const binary = atob(value);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          out[i] = binary.charCodeAt(i) & 0xff;
        }
        return out;
      }

      function encodeUtf8Base64(text) {
        const bytes = new TextEncoder().encode(text);
        return bytesToBase64(bytes);
      }

      function decodeUtf8Base64(base64) {
        const bytes = base64ToBytes(base64);
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      }

      function chunkString(value, maxLen) {
        const out = [];
        for (let i = 0; i < value.length; i += maxLen) {
          out.push(value.slice(i, i + maxLen));
        }
        return out;
      }

      function sendEnvelope(envelope) {
        const json = JSON.stringify(envelope);
        const base64 = encodeUtf8Base64(json);

        if (base64.length <= MAX_CHUNK_BYTES) {
          postRaw(JSON.stringify(envelope));
          return;
        }

        const parts = chunkString(base64, MAX_CHUNK_BYTES);
        const messageId = Math.random().toString(36).slice(2);
        for (let i = 0; i < parts.length; i++) {
          postRaw(JSON.stringify({
            v: 1,
            type: 'chunk',
            payload: {
              messageId,
              index: i,
              total: parts.length,
              data: parts[i]
            }
          }));
        }
      }

      function isBenignDisposedXtermRenderError(value) {
        const message = String(value && value.message ? value.message : value || '');
        const stack = String(value && value.stack ? value.stack : '');
        return message.includes("Cannot read properties of undefined (reading 'dimensions')")
          && (stack.includes('RenderService') || stack.includes('Viewport') || stack.includes('xterm'));
      }

      window.addEventListener('error', (event) => {
        if (isBenignDisposedXtermRenderError(event.error || event.message)) {
          event.preventDefault();
        }
      });

      window.addEventListener('unhandledrejection', (event) => {
        if (isBenignDisposedXtermRenderError(event.reason)) {
          event.preventDefault();
        }
      });

      const pendingByMessageId = new Map();

      function tryFinalizePending(messageId, pending) {
        if (pending.received !== pending.total) return null;
        pendingByMessageId.delete(messageId);
        const merged = pending.parts.join('');
        try {
          const json = decodeUtf8Base64(merged);
          return JSON.parse(json);
        } catch (e) {
          return null;
        }
      }

      function decodeIncomingMessage(raw) {
        let data;
        try {
          data = JSON.parse(raw);
        } catch (e) {
          return null;
        }
        if (!data || typeof data !== 'object') return null;
        if (data.v !== 1) return null;

        if (data.type !== 'chunk') return data;

        const payload = data.payload || {};
        const messageId = payload.messageId;
        const index = payload.index;
        const total = payload.total;
        const part = payload.data;
        if (typeof messageId !== 'string' || !messageId) return null;
        if (typeof index !== 'number' || typeof total !== 'number') return null;
        if (typeof part !== 'string') return null;
        if (index < 0 || total <= 0 || index >= total) return null;

        let pending = pendingByMessageId.get(messageId);
        if (!pending) {
          pending = { total, parts: Array.from({ length: total }, () => ''), received: 0 };
          pendingByMessageId.set(messageId, pending);
        }
        if (pending.total !== total) {
          pendingByMessageId.delete(messageId);
          return null;
        }
        if (pending.parts[index] === '') {
          pending.parts[index] = part;
          pending.received += 1;
        }
        return tryFinalizePending(messageId, pending);
      }

      function resolveXtermExports() {
        const embedded = globalThis.HAPPIER_XTERM_WEBVIEW;
        if (embedded && embedded.Terminal && embedded.FitAddon) {
          return embedded;
        }
        return null;
      }

      async function loadXtermExports() {
        let mod = resolveXtermExports();
        if (mod) return mod;

        const cdnImports = ${cdnModuleImports || 'null'};
        if (cdnImports) {
          const [xterm, fit, links] = await Promise.all(cdnImports);
          globalThis.HAPPIER_XTERM_WEBVIEW = {
            Terminal: xterm.Terminal,
            FitAddon: fit.FitAddon,
            WebLinksAddon: links.WebLinksAddon,
          };
        }

        mod = resolveXtermExports();
        return mod;
      }

      let term = null;
      let fitAddon = null;
      let didSendReady = false;
      let lastCols = 0;
      let lastRows = 0;
      let pendingWrite = '';
      let isWriting = false;
      let readyFitAttemptCount = 0;

      function scheduleWriteFlush() {
        if (!term) return;
        if (!pendingWrite) return;
        if (isWriting) return;

        const chunk = pendingWrite;
        pendingWrite = '';
        isWriting = true;
        term.write(chunk, () => {
          isWriting = false;
          if (pendingWrite) {
            if (typeof requestAnimationFrame === 'function') {
              requestAnimationFrame(() => scheduleWriteFlush());
            } else {
              setTimeout(() => scheduleWriteFlush(), 0);
            }
          }
        });
      }

      function enqueueWrite(data) {
        if (!data || !term) return;
        pendingWrite += data;
        scheduleWriteFlush();
      }

      function applyTheme(theme) {
        if (!term || !theme) return;
        try {
          term.options.theme = {
            background: theme.backgroundColor,
            foreground: theme.textColor,
            cursor: theme.cursorColor,
            selectionBackground: theme.selectionBackgroundColor,
          };
        } catch (e) {
          // ignore
        }
      }

      function applyFont(fontSizePx, lineHeight) {
        if (!term) return;
        try {
          term.options.fontSize = Math.max(8, Math.round(fontSizePx));
          term.options.lineHeight = Math.max(1, Math.min(2.5, Number(lineHeight) || 1.35));
        } catch (e) {
          // ignore
        }
      }

      function reportSize(kind) {
        if (!term) return false;
        const cols = term.cols || 0;
        const rows = term.rows || 0;
        if (cols <= 0 || rows <= 0) return false;

        if (cols !== lastCols || rows !== lastRows) {
          lastCols = cols;
          lastRows = rows;
          sendEnvelope({ v: 1, type: kind === 'ready' ? 'ready' : 'resize', payload: { cols, rows } });
        } else if (kind === 'ready' && !didSendReady) {
          sendEnvelope({ v: 1, type: 'ready', payload: { cols, rows } });
        }

        if (kind === 'ready') {
          didSendReady = true;
        }
        return true;
      }

      function fitAndReport(kind) {
        if (!fitAddon || !term) return false;
        const root = document.getElementById('root');
        if (!root) return false;
        const rect = root.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 24) return false;
        try {
          fitAddon.fit();
          return reportSize(kind);
        } catch (e) {
          return false;
        }
      }

      function scheduleReadyFitAttempt(delayMs) {
        setTimeout(() => {
          readyFitAttemptCount += 1;
          fitAndReport('ready');
          try { term && term.focus(); } catch {}
          scheduleWriteFlush();
          if (!didSendReady && readyFitAttemptCount < READY_FIT_RETRY_LIMIT) {
            scheduleReadyFitAttempt(READY_FIT_RETRY_INTERVAL_MS);
          }
        }, delayMs);
      }

      function clearTerminal() {
        if (!term) return;
        pendingWrite = '';
        isWriting = false;
        try {
          term.clear();
          term.write('\\x1b[2J\\x1b[H');
        } catch (e) {
          // ignore
        }
      }

      function onHostMessage(message) {
        if (!message || typeof message !== 'object') return;
        if (message.v !== 1) return;
        const payload = message.payload || {};

        if (message.type === 'write') {
          if (typeof payload.data === 'string') enqueueWrite(payload.data);
          return;
        }
        if (message.type === 'clear') {
          clearTerminal();
          return;
        }
        if (message.type === 'focus') {
          try { term && term.focus(); } catch {}
          return;
        }
        if (message.type === 'setTheme') {
          applyTheme(payload);
          return;
        }
        if (message.type === 'setFontSize') {
          if (typeof payload.fontSizePx === 'number') {
            applyFont(payload.fontSizePx, payload.lineHeight);
            fitAndReport('resize');
          }
          return;
        }
      }

      async function boot() {
        const root = document.getElementById('root');
        if (!root) throw new Error('missing root element');

        const mod = await loadXtermExports();
        if (!mod || !mod.Terminal || !mod.FitAddon) {
          sendEnvelope({ v: 1, type: 'bootError', payload: { code: 'terminal_renderer_unavailable' } });
          return;
        }

        term = new mod.Terminal({
          cursorBlink: true,
          fontFamily: 'Menlo, ui-monospace, SFMono-Regular, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace',
          fontSize: DEFAULT_CONFIG.fontSizePx,
          lineHeight: DEFAULT_CONFIG.lineHeight,
          scrollback: 5000,
          screenReaderMode: false,
          theme: {
            background: DEFAULT_CONFIG.theme.backgroundColor,
            foreground: DEFAULT_CONFIG.theme.textColor,
            cursor: DEFAULT_CONFIG.theme.cursorColor,
            selectionBackground: DEFAULT_CONFIG.theme.selectionBackgroundColor,
          },
        });

        fitAddon = new mod.FitAddon();
        term.loadAddon(fitAddon);
        try {
          if (mod.WebLinksAddon) {
            term.loadAddon(new mod.WebLinksAddon());
          }
        } catch {}

        term.open(root);
        term.onData((data) => {
          if (typeof data === 'string' && data) {
            sendEnvelope({ v: 1, type: 'input', payload: { data } });
          }
        });

        scheduleReadyFitAttempt(INITIAL_READY_FIT_DELAY_MS);

        const resizeObserver = typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(() => fitAndReport(didSendReady ? 'resize' : 'ready'))
          : null;
        if (resizeObserver) resizeObserver.observe(root);

        const onResize = () => fitAndReport(didSendReady ? 'resize' : 'ready');
        window.addEventListener('resize', onResize);
        if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
          window.visualViewport.addEventListener('resize', onResize);
        }

        window.addEventListener('message', (event) => {
          const decoded = decodeIncomingMessage(event.data);
          if (!decoded) return;
          onHostMessage(decoded);
        });

        // React Native WebView sends messages via document.
        document.addEventListener('message', (event) => {
          const decoded = decodeIncomingMessage(event.data);
          if (!decoded) return;
          onHostMessage(decoded);
        });
      }

      boot().catch((err) => {
        sendEnvelope({ v: 1, type: 'bootError', payload: { code: 'terminal_boot_failed', message: String(err && err.message ? err.message : err) } });
      });
    </script>
  </body>
</html>`;
}
