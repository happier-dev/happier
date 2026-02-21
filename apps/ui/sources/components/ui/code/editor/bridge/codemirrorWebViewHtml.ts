import { resolveCodeEditorFontMetrics } from '../codeEditorFontMetrics';

export type CodeMirrorWebViewTheme = Readonly<{
    backgroundColor: string;
    textColor: string;
    dividerColor: string;
    isDark: boolean;
}>;

export function buildCodeMirrorWebViewHtml(params: Readonly<{
    theme: CodeMirrorWebViewTheme;
    wrapLines: boolean;
    showLineNumbers: boolean;
    changeDebounceMs: number;
    maxChunkBytes: number;
    uiFontScale?: number;
    osFontScale?: number;
}>): string {
    const themeJson = JSON.stringify(params.theme);
    const wrapLines = params.wrapLines ? 'true' : 'false';
    const showLineNumbers = params.showLineNumbers ? 'true' : 'false';
    const changeDebounceMs = Math.max(0, Math.floor(params.changeDebounceMs));
    const maxChunkBytes = Math.max(8_000, Math.floor(params.maxChunkBytes));
    const fontMetrics = resolveCodeEditorFontMetrics({
        uiFontScale: typeof params.uiFontScale === 'number' && Number.isFinite(params.uiFontScale) ? params.uiFontScale : 1,
        osFontScale: typeof params.osFontScale === 'number' && Number.isFinite(params.osFontScale) ? params.osFontScale : 1,
    });
    const fontSizePx = fontMetrics.fontSize;
    const lineHeightPx = fontMetrics.lineHeight;

    // Notes:
    // - We load CodeMirror 6 via CDN ESM modules (experimental; best-effort).
    // - The document content is sent after "ready" via an init message; this avoids embedding large docs in HTML.
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
      }
      .cm-editor {
        height: 100%;
        font-family: Menlo, ui-monospace, SFMono-Regular, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: ${fontSizePx}px;
        line-height: ${lineHeightPx}px;
      }
      .cm-gutters {
        border-right: 1px solid ${params.theme.dividerColor};
        background: ${params.theme.backgroundColor};
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      const MAX_CHUNK_BYTES = ${maxChunkBytes};
      const CHANGE_DEBOUNCE_MS = ${changeDebounceMs};
      const DEFAULT_CONFIG = {
        wrapLines: ${wrapLines},
        showLineNumbers: ${showLineNumbers},
        theme: ${themeJson},
      };

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

      function resolveLanguageExtension(lang, mod) {
        const v = (lang || '').toLowerCase();
        if (v === 'typescript' || v === 'ts' || v === 'javascript' || v === 'js') return mod.javascript({ typescript: v === 'typescript' || v === 'ts' });
        if (v === 'json') return mod.json();
        if (v === 'markdown' || v === 'md') return mod.markdown();
        if (v === 'python' || v === 'py') return mod.python();
        return null;
      }

      let view = null;
      let changeTimer = null;
      let applyingRemote = false;

      async function boot() {
        const [
          { EditorState },
          { EditorView, lineNumbers },
          { keymap },
          { defaultKeymap },
          { history, historyKeymap },
          { indentOnInput },
          { bracketMatching },
          { closeBrackets, closeBracketsKeymap },
          { highlightActiveLine, highlightActiveLineGutter },
          { drawSelection, highlightSpecialChars },
          { syntaxHighlighting, defaultHighlightStyle },
          langJavascript,
          langPython,
          langMarkdown,
          langJson,
        ] = await Promise.all([
          import('https://cdn.jsdelivr.net/npm/@codemirror/state@6.4.1/+esm'),
          import('https://cdn.jsdelivr.net/npm/@codemirror/view@6.26.3/+esm'),
          import('https://cdn.jsdelivr.net/npm/@codemirror/commands@6.5.0/+esm'),
          import('https://cdn.jsdelivr.net/npm/@codemirror/commands@6.5.0/+esm'),
          import('https://cdn.jsdelivr.net/npm/@codemirror/history@6.4.0/+esm'),
          import('https://cdn.jsdelivr.net/npm/@codemirror/history@6.4.0/+esm'),
          import('https://cdn.jsdelivr.net/npm/@codemirror/language@6.10.2/+esm'),
          import('https://cdn.jsdelivr.net/npm/@codemirror/language@6.10.2/+esm'),
          import('https://cdn.jsdelivr.net/npm/@codemirror/autocomplete@6.13.0/+esm'),
          import('https://cdn.jsdelivr.net/npm/@codemirror/view@6.26.3/+esm'),
          import('https://cdn.jsdelivr.net/npm/@codemirror/view@6.26.3/+esm'),
          import('https://cdn.jsdelivr.net/npm/@codemirror/language@6.10.2/+esm'),
          import('https://cdn.jsdelivr.net/npm/@codemirror/language@6.10.2/+esm'),
          import('https://cdn.jsdelivr.net/npm/@codemirror/lang-javascript@6.2.2/+esm'),
          import('https://cdn.jsdelivr.net/npm/@codemirror/lang-python@6.1.6/+esm'),
          import('https://cdn.jsdelivr.net/npm/@codemirror/lang-markdown@6.2.5/+esm'),
          import('https://cdn.jsdelivr.net/npm/@codemirror/lang-json@6.0.1/+esm'),
        ]);

        const root = document.getElementById('root');
        const baseExtensions = [
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...closeBracketsKeymap,
          ]),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSpecialChars(),
          drawSelection(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        ];

        const theme = DEFAULT_CONFIG.theme;
        const themeExt = EditorView.theme({
          '&': {
            backgroundColor: theme.backgroundColor,
            color: theme.textColor,
          },
          '.cm-content': {
            caretColor: theme.textColor,
          },
        }, { dark: Boolean(theme.isDark) });

        function createView(doc, language, readOnly) {
          const langExt = resolveLanguageExtension(language, {
            javascript: langJavascript.javascript,
            python: langPython.python,
            markdown: langMarkdown.markdown,
            json: langJson.json,
          });

          const extensions = baseExtensions.slice();
          extensions.push(themeExt);
          if (DEFAULT_CONFIG.showLineNumbers) extensions.push(lineNumbers());
          if (DEFAULT_CONFIG.wrapLines) extensions.push(EditorView.lineWrapping);
          if (langExt) extensions.push(langExt);
          if (readOnly) extensions.push(EditorState.readOnly.of(true));

          const state = EditorState.create({
            doc: doc || '',
            extensions: extensions.concat([
              EditorView.updateListener.of((update) => {
                if (!update.docChanged) return;
                if (applyingRemote) return;
                if (changeTimer) clearTimeout(changeTimer);
                changeTimer = setTimeout(() => {
                  try {
                    sendEnvelope({ v: 1, type: 'docChanged', payload: { doc: update.state.doc.toString() } });
                  } catch (e) {}
                }, CHANGE_DEBOUNCE_MS);
              }),
            ]),
          });

          return new EditorView({ state, parent: root });
        }

        function setDoc(nextDoc) {
          if (!view) return;
          applyingRemote = true;
          try {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: nextDoc || '' },
            });
          } finally {
            applyingRemote = false;
          }
        }

        function onEnvelope(envelope) {
          if (!envelope || envelope.v !== 1 || typeof envelope.type !== 'string') return;
          if (envelope.type === 'init') {
            const payload = envelope.payload || {};
            const doc = typeof payload.doc === 'string' ? payload.doc : '';
            const language = typeof payload.language === 'string' ? payload.language : null;
            const readOnly = payload.readOnly === true;
            if (view) {
              setDoc(doc);
              return;
            }
            view = createView(doc, language, readOnly);
            return;
          }
          if (envelope.type === 'setDoc') {
            const payload = envelope.payload || {};
            setDoc(typeof payload.doc === 'string' ? payload.doc : '');
          }
        }

        function onMessage(event) {
          const raw = event && event.data ? String(event.data) : '';
          const decoded = decodeIncomingMessage(raw);
          if (decoded) {
            onEnvelope(decoded);
          }
        }

        document.addEventListener('message', onMessage);
        window.addEventListener('message', onMessage);

        sendEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
      }

      boot().catch((err) => {
        try {
          sendEnvelope({ v: 1, type: 'error', payload: { message: err && err.message ? String(err.message) : 'Failed to load editor' } });
        } catch {}
      });
    </script>
  </body>
</html>`;
}
