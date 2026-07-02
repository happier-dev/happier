/**
 * Builds the HTML document for the native TipTap WebView surface.
 *
 * Mirrors `code/editor/bridge/codemirrorWebViewHtml.ts` but with two hard
 * differences:
 *  - D9: there is NO CDN fallback. The bundle is inlined; if it is missing/empty
 *    the boot script emits an `error` envelope so the native surface fails closed
 *    to raw mode. (A markdown file editor writing to disk must be deterministic +
 *    offline.)
 *  - D4: the runtime uses headless `@tiptap/core` (the inlined bundle assigns
 *    `globalThis.HAPPIER_TIPTAP_WEBVIEW`), NO React.
 *
 * The inline `<script type="module">` owns only the chunked postMessage transport
 * + the `ready` handshake (the same wire format as `chunkedBridge.ts`, R4); it
 * delegates editor/command/selection logic to the bundle runtime.
 */

import { buildMarkdownProseCss } from '../markdownEditorProseStyle';
import { TIPTAP_WEBVIEW_BUNDLE_JS, TIPTAP_WEBVIEW_CSS } from './tiptapWebViewBundle.generated';

/**
 * System font stacks the WebView can resolve without the bundled app fonts
 * (Inter / IBM Plex Mono are not loaded inside the WebView document). These are
 * the ONLY literal font values in this module — colors still come from the
 * active theme (see `buildMarkdownProseCss` call below).
 */
const SYSTEM_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const SYSTEM_MONO = 'Menlo, ui-monospace, SFMono-Regular, Monaco, Consolas, monospace';

export type TiptapWebViewTheme = Readonly<{
    isDark: boolean;
    backgroundColor: string;
    textColor: string;
    secondaryTextColor: string;
    dividerColor: string;
    selectionBackgroundColor: string;
    selectionAccentColor: string;
    linkColor: string;
    codeBackgroundColor: string;
}>;

export function buildTiptapWebViewHtml(params: Readonly<{
    theme: TiptapWebViewTheme;
    readOnly: boolean;
    changeDebounceMs: number;
    maxChunkBytes: number;
    uiFontScale?: number;
    osFontScale?: number;
}>): string {
    const themeJson = JSON.stringify(params.theme);
    const readOnly = params.readOnly ? 'true' : 'false';
    const changeDebounceMs = Math.max(0, Math.floor(params.changeDebounceMs));
    const maxChunkBytes = Math.max(8_000, Math.floor(params.maxChunkBytes));

    // The WebView can't stack OS Dynamic Type the way the native `Text` primitive
    // does, so fold the in-app scale and the OS scale into a single prose scale
    // (this mirrors what the previous `resolveCodeEditorFontMetrics` call did with
    // uiFontScale * osFontScale). The base prose font is then `16 * proseScale`,
    // matching MarkdownView's `buildEnrichedMarkdownStyle`.
    const uiFontScale =
        typeof params.uiFontScale === 'number' && Number.isFinite(params.uiFontScale) ? params.uiFontScale : 1;
    const osFontScale =
        typeof params.osFontScale === 'number' && Number.isFinite(params.osFontScale) ? params.osFontScale : 1;
    const proseScale = uiFontScale * osFontScale;

    // Mirrors MarkdownView's spec via the shared builder. Fonts are the system
    // stacks above (the WebView can't load Inter); colors come from the active
    // native theme. The native theme exposes a single code background, so it is
    // used for BOTH inline code and code blocks.
    const proseCss = buildMarkdownProseCss('.ProseMirror', {
        fonts: { body: SYSTEM_SANS, heading: SYSTEM_SANS, mono: SYSTEM_MONO },
        colors: {
            text: params.theme.textColor,
            secondaryText: params.theme.secondaryTextColor,
            link: params.theme.linkColor,
            inlineCodeBackground: params.theme.codeBackgroundColor,
            codeBlockBackground: params.theme.codeBackgroundColor,
            divider: params.theme.dividerColor,
        },
        uiFontScale: proseScale,
    });

    const embeddedBundle = typeof TIPTAP_WEBVIEW_BUNDLE_JS === 'string' ? TIPTAP_WEBVIEW_BUNDLE_JS.trim() : '';
    const hasEmbeddedBundle = embeddedBundle.length > 0;
    const proseMirrorCss = typeof TIPTAP_WEBVIEW_CSS === 'string' ? TIPTAP_WEBVIEW_CSS : '';

    // NOTE: NO CDN fallback (D9). If the embedded bundle is empty we emit an
    // `error` envelope on boot so the native surface falls back to raw mode.
    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
    <style>
      ${proseMirrorCss}
      :root {
        --happier-tiptap-selection-background-color: ${params.theme.selectionBackgroundColor};
        --happier-tiptap-selection-accent-color: ${params.theme.selectionAccentColor};
        --happier-tiptap-gap-cursor-color: ${params.theme.textColor};
      }
      html, body {
        margin: 0;
        height: 100%;
        background: ${params.theme.backgroundColor};
        color: ${params.theme.textColor};
        -webkit-text-size-adjust: 100%;
      }
      #root {
        height: 100%;
        overflow: auto;
        -webkit-overflow-scrolling: touch;
      }
      /*
       * LAYOUT + native-only chrome only. Typography (font family/size/
       * line-height/color, headings, code, blockquote, hr, tasklist) is emitted
       * by the shared prose builder below so it matches MarkdownView exactly.
       */
      .ProseMirror {
        min-height: 100%;
        padding: 12px 14px;
        box-sizing: border-box;
        caret-color: ${params.theme.textColor};
      }
      /* Shared prose typography (mirrors MarkdownView via buildMarkdownProseCss). */
      ${proseCss}
      .ProseMirror ::selection { background: var(--happier-tiptap-selection-background-color); }
    </style>
  </head>
  <body>
    <div id="root"></div>
    ${hasEmbeddedBundle ? `<script>${embeddedBundle}</script>` : ''}
    <script type="module">
      const MAX_CHUNK_BYTES = ${maxChunkBytes};
      const CHANGE_DEBOUNCE_MS = ${changeDebounceMs};
      const READ_ONLY = ${readOnly};
      const THEME = ${themeJson};
      const HAS_BUNDLE = ${hasEmbeddedBundle ? 'true' : 'false'};

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
        return bytesToBase64(new TextEncoder().encode(text));
      }

      function decodeUtf8Base64(base64) {
        return new TextDecoder('utf-8', { fatal: false }).decode(base64ToBytes(base64));
      }

      function chunkString(value, maxLen) {
        const out = [];
        for (let i = 0; i < value.length; i += maxLen) {
          out.push(value.slice(i, i + maxLen));
        }
        return out;
      }

      // R4: this inline chunk encode/decode runtime DUPLICATES the wire format of
      // chunkedBridge.ts (the host side). The two MUST stay byte-compatible:
      // the WebViewBridgeEnvelopeV1 shape, v:1, the chunk envelope carrying
      // messageId/index/total/data, base64 UTF-8 chunking, and the MAX_CHUNK_BYTES
      // threshold. If you change the format here, change chunkedBridge.ts (and the
      // native surface decoder) too. NOTE: no backticks/dollar-braces in this
      // comment — it lives inside the HTML template literal.

      function sendEnvelope(envelope) {
        const json = JSON.stringify(envelope);
        const base64 = encodeUtf8Base64(json);
        if (base64.length <= MAX_CHUNK_BYTES) {
          postRaw(json);
          return;
        }
        const parts = chunkString(base64, MAX_CHUNK_BYTES);
        const messageId = Math.random().toString(36).slice(2);
        for (let i = 0; i < parts.length; i++) {
          postRaw(JSON.stringify({
            v: 1,
            type: 'chunk',
            payload: { messageId, index: i, total: parts.length, data: parts[i] }
          }));
        }
      }

      const pendingByMessageId = new Map();

      function tryFinalizePending(messageId, pending) {
        if (pending.received !== pending.total) return null;
        pendingByMessageId.delete(messageId);
        try {
          return JSON.parse(decodeUtf8Base64(pending.parts.join('')));
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
        if (!data || typeof data !== 'object' || data.v !== 1) return null;
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

      function boot() {
        // D9: fail closed when the bundle is missing/empty (no CDN fallback).
        const api = HAS_BUNDLE ? globalThis.HAPPIER_TIPTAP_WEBVIEW : null;
        if (!api || typeof api.createRuntime !== 'function') {
          throw new Error('TipTap bundle missing');
        }

        const root = document.getElementById('root');
        const runtime = api.createRuntime({
          root,
          postEnvelope: sendEnvelope,
          config: { changeDebounceMs: CHANGE_DEBOUNCE_MS, readOnly: READ_ONLY },
        });

        function onMessage(event) {
          const raw = event && event.data ? String(event.data) : '';
          const decoded = decodeIncomingMessage(raw);
          if (decoded) {
            runtime.onEnvelope(decoded);
          }
        }

        document.addEventListener('message', onMessage);
        window.addEventListener('message', onMessage);

        sendEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
      }

      try {
        boot();
      } catch (err) {
        try {
          sendEnvelope({ v: 1, type: 'error', payload: { message: err && err.message ? String(err.message) : 'Failed to load editor' } });
        } catch (e) {}
      }
    </script>
  </body>
</html>`;
}
