import { CODE_GUTTER_METRICS, resolveCodeEditorFontMetrics } from '../codeEditorFontMetrics';
import { minimalCodeEditorEdit } from '../codeEditorDocumentEdit';
import { formatCodeEditorBlameMarkCss, formatCodeEditorChangeMarkCss, formatCodeEditorDiagnosticCss, formatCodeEditorNextEditCss, type CodeEditorTheme } from '../editorTheme';
import { CODEMIRROR_INLINE_SUGGESTIONS_FACTORY_JS, CODEMIRROR_WEBVIEW_BUNDLE_JS } from './codemirrorWebViewBundle.generated';

export type CodeMirrorWebViewTheme = Omit<CodeEditorTheme, 'monacoThemeName'>;

export function buildCodeMirrorWebViewHtml(params: Readonly<{
    theme: CodeMirrorWebViewTheme;
    wrapLines: boolean;
    showLineNumbers: boolean;
    changeDebounceMs: number;
    maxChunkBytes: number;
    uiFontScale?: number;
    osFontScale?: number;
    lineNumberDigits?: number;
    reviewLaneWidth?: number;
    fontFamily?: string;
    /** The code view's canvas inset (`CodeLinesView` `contentPadding*`): the first line and the numbers sit where View drew them. */
    contentPaddingHorizontal?: number;
    contentPaddingVertical?: number;
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
    const numberFontSizePx = fontMetrics.lineNumberFontSize;
    // No divider: the code view has none, so the text starts the number gap after the digits, as in View.
    const gutterEnd = CODE_GUTTER_METRICS.numberPaddingRight;
    const insetLeft = Math.max(0, params.contentPaddingHorizontal ?? 0);
    const insetVertical = Math.max(0, params.contentPaddingVertical ?? 0);
    const markerLane = CODE_GUTTER_METRICS.numberPaddingRight / 3;

    const embeddedBundle = typeof CODEMIRROR_WEBVIEW_BUNDLE_JS === 'string'
        ? CODEMIRROR_WEBVIEW_BUNDLE_JS.trim()
        : '';
    const hasEmbeddedBundle = embeddedBundle.length > 0;

    // NOTE: Keep the CDN ESM fallback.
    // This has come up in reviews before, but it's intentional: when the embedded bundle is unavailable
    // (e.g. bundle generation issues, certain dev/test environments), we prefer the editor to remain
    // usable best-effort rather than hard-failing.
    const cdnModuleImports = hasEmbeddedBundle
        ? ''
        : `[
            import('https://cdn.jsdelivr.net/npm/@codemirror/state@6.5.4/+esm'),
            import('https://cdn.jsdelivr.net/npm/@codemirror/view@6.39.15/+esm'),
            import('https://cdn.jsdelivr.net/npm/@codemirror/commands@6.10.2/+esm'),
            import('https://cdn.jsdelivr.net/npm/@codemirror/language@6.12.1/+esm'),
            import('https://cdn.jsdelivr.net/npm/@codemirror/autocomplete@6.20.0/+esm'),
            import('https://cdn.jsdelivr.net/npm/@codemirror/lang-javascript@6.2.4/+esm'),
            import('https://cdn.jsdelivr.net/npm/@codemirror/lang-python@6.2.1/+esm'),
            import('https://cdn.jsdelivr.net/npm/@codemirror/lang-markdown@6.5.0/+esm'),
            import('https://cdn.jsdelivr.net/npm/@codemirror/lang-json@6.0.2/+esm'),
            import('https://cdn.jsdelivr.net/npm/@lezer/highlight@1.2.3/+esm'),
            import('https://cdn.jsdelivr.net/npm/@codemirror/search@6.7.2/+esm'),
          ]`;

    // Notes:
    // - Prefer embedded CM6 bundle (offline + deterministic).
    // - Fall back to CDN ESM modules when the bundle is not available (best-effort).
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
        font-family: ${params.fontFamily ?? 'monospace'};
        font-size: ${fontSizePx}px;
        line-height: ${lineHeightPx}px;
      }
      .cm-gutters {
        border-right: none;
        background: ${params.theme.backgroundColor};
        color: ${params.theme.lineNumberColor};
      }
      .happier-editor-marker { display: block; position: relative; height: 100%; }
      ${formatCodeEditorChangeMarkCss(params.theme, (kind) => '.happier-editor-marker.happier-editor-change-' + kind)}
      ${formatCodeEditorDiagnosticCss(params.theme, (severity) => '.happier-editor-diagnostic-' + severity)}
      ${formatCodeEditorBlameMarkCss(params.theme, (tone) => '.happier-editor-marker.happier-editor-blame-' + tone)}
      .happier-editor-inline-suggestion { color: ${params.theme.syntax.commentColor}; }
      ${formatCodeEditorNextEditCss(params.theme, (part) => '.happier-next-edit-' + part)}
    </style>
  </head>
  <body>
    <div id="root"></div>
    ${hasEmbeddedBundle ? `<script>${embeddedBundle}</script>` : `<script>${CODEMIRROR_INLINE_SUGGESTIONS_FACTORY_JS}</script>`}
    <script type="module">
      const MAX_CHUNK_BYTES = ${maxChunkBytes};
      const CHANGE_DEBOUNCE_MS = ${changeDebounceMs};
      const DEFAULT_CONFIG = {
        wrapLines: ${wrapLines},
        showLineNumbers: ${showLineNumbers},
        lineNumberDigits: ${Math.max(1, Math.floor(params.lineNumberDigits ?? 1))},
        reviewLaneWidth: ${params.reviewLaneWidth ?? 0},
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
        if (!lang) return null;

        if (typeof lang === 'string') {
          const v = (lang || '').toLowerCase();
          if (v === 'typescript' || v === 'ts' || v === 'tsx') return mod.javascript({ typescript: true });
          if (v === 'javascript' || v === 'js' || v === 'jsx') return mod.javascript({ typescript: false });
          if (v === 'json' || v === 'jsonc' || v === 'json5') return mod.json ? mod.json() : null;
          if (v === 'markdown' || v === 'md' || v === 'mdx') return mod.markdown ? mod.markdown() : null;
          if (v === 'python' || v === 'py') return mod.python ? mod.python() : null;
          return null;
        }

        if (typeof lang === 'object') {
          const id = String(lang.id || '').toLowerCase();
          if (id === 'javascript') {
            const ts = lang.typescript === true;
            return mod.javascript ? mod.javascript({ typescript: ts }) : null;
          }
          const fn = mod[id];
          return typeof fn === 'function' ? fn() : null;
        }

        return null;
      }

      let view = null;
      let changeTimer = null;
      let applyingRemote = false;
      let currentLanguage = null;
      let currentReadOnly = false;
      let sharedHistory = false;
      let lineSeparator = '\\n';
      let findRequest = null;
      let keyboardSignatures = new Set();
      // Lines and text positions the host draws over (Track's caret and wash); answered as they move.
      let geometryWatch = [];
      let geometryFrame = 0;
      const minimalDocumentEdit = ${minimalCodeEditorEdit.toString()};

      function detectLineSeparator(doc) {
        const match = doc.match(/\\r\\n|\\r|\\n/);
        return match ? match[0] : '\\n';
      }

      function serializeDoc(doc) {
        return doc.sliceString(0, doc.length, lineSeparator);
      }

      function cancelPendingDocChange() {
        if (changeTimer) {
          clearTimeout(changeTimer);
          changeTimer = null;
        }
      }

      function flushPendingDocChange() {
        if (!changeTimer) return;
        cancelPendingDocChange();
        try {
          sendEnvelope({ v: 1, type: 'docChanged', payload: { doc: serializeDoc(view.state.doc) } });
        } catch (e) {}
      }

      async function boot() {
        let decorationRuntime = null;
        let intelligenceRuntime = null;
        let intelligenceFactory = null;
        let intelligenceCompartment = null;
        let intelligenceConfig = null;
        let intelligenceSequence = 0;
        const intelligenceRequests = new Map();
        let inlineRuntime = null;
        let inlineApi = null;
        let stateApi, viewApi, autocompleteApi;
        const decorationLayers = new Map();
        const embedded = ${hasEmbeddedBundle ? 'true' : 'false'};
        let EditorState;
        let EditorView;
        let lineNumbers;
        let keymap;
        let defaultKeymap;
        let history;
        let historyKeymap;
        let indentMore, indentLess, undo, redo, undoDepth, redoDepth, cursorCharLeft, cursorCharRight, isolateHistory;
        let indentOnInput;
        let bracketMatching;
        let closeBrackets;
        let closeBracketsKeymap;
        let highlightActiveLine;
        let highlightActiveLineGutter;
        let drawSelection;
        let highlightSpecialChars;
        let syntaxHighlighting;
        let defaultHighlightStyle;
        let HighlightStyle;
        let tags;
        let search;
        let SearchQuery;
        let setSearchQuery;
        let getSearchQuery;
        let findNext;
        let findPrevious;
        let openSearchPanel;
        let closeSearchPanel;
        let langJavascript;
        let langPython;
        let langMarkdown;
        let langJson;
        let langYaml = null;
        let langShell = null;
        let langDockerfile = null;
        let langToml = null;
        let langIni = null;
        let langCss = null;
        let langScss = null;
        let langLess = null;
        let langHtml = null;
        let langXml = null;
        let langSql = null;
        let langRust = null;
        let langGo = null;
        let langJava = null;
        let langCpp = null;
        let langPhp = null;

        if (embedded) {
          const bundle = globalThis.HAPPIER_CODEMIRROR_WEBVIEW || globalThis.__CM6__ || null;
          if (!bundle) throw new Error('CodeMirror bundle missing');
          ({ EditorState } = bundle);
          intelligenceFactory = bundle.createCodeMirrorLanguageIntelligence;
          intelligenceCompartment = bundle.Compartment ? new bundle.Compartment() : null;
          inlineApi = bundle;
          if (bundle.createCodeMirrorDecorations) {
            decorationRuntime = bundle.createCodeMirrorDecorations(bundle, (layer, item) => {
              flushPendingDocChange();
              // A pressed change opens its peek: the change reads from its first column, as Monaco's peek zone does.
              if (layer === 'change' && view) view.scrollDOM.scrollLeft = 0;
              sendEnvelope({ v: 1, type: 'decorations.press', payload: { layer, item } });
            });
          }
          ({ EditorView, lineNumbers, keymap, drawSelection, highlightSpecialChars, highlightActiveLine, highlightActiveLineGutter } = bundle);
          ({ defaultKeymap, history, historyKeymap } = bundle);
          ({ indentMore, indentLess, undo, redo, undoDepth, redoDepth, cursorCharLeft, cursorCharRight, isolateHistory } = bundle);
          ({ indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle, HighlightStyle } = bundle);
          ({ closeBrackets, closeBracketsKeymap } = bundle);
          ({ tags } = bundle);
          ({ search, SearchQuery, setSearchQuery, getSearchQuery, findNext, findPrevious, openSearchPanel, closeSearchPanel } = bundle);
          langJavascript = bundle.langs?.javascript;
          langPython = bundle.langs?.python;
          langMarkdown = bundle.langs?.markdown;
          langJson = bundle.langs?.json;
          langYaml = bundle.langs?.yaml;
          langShell = bundle.langs?.shell;
          langDockerfile = bundle.langs?.dockerfile;
          langToml = bundle.langs?.toml;
          langIni = bundle.langs?.ini;
          langCss = bundle.langs?.css;
          langScss = bundle.langs?.scss;
          langLess = bundle.langs?.less;
          langHtml = bundle.langs?.html;
          langXml = bundle.langs?.xml;
          langSql = bundle.langs?.sql;
          langRust = bundle.langs?.rust;
          langGo = bundle.langs?.go;
          langJava = bundle.langs?.java;
          langCpp = bundle.langs?.cpp;
          langPhp = bundle.langs?.php;
        } else {
          [
            stateApi,
            viewApi,
            { defaultKeymap, history, historyKeymap, indentMore, indentLess, undo, redo, undoDepth, redoDepth, cursorCharLeft, cursorCharRight, isolateHistory },
            { indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle, HighlightStyle },
            autocompleteApi,
            langJavascript,
            langPython,
            langMarkdown,
            langJson,
            { tags },
            { search, SearchQuery, setSearchQuery, getSearchQuery, findNext, findPrevious, openSearchPanel, closeSearchPanel },
          ] = await Promise.all(${cdnModuleImports});
          ({ EditorState } = stateApi);
          ({ EditorView, lineNumbers, keymap, drawSelection, highlightSpecialChars, highlightActiveLine, highlightActiveLineGutter } = viewApi);
          ({ closeBrackets, closeBracketsKeymap } = autocompleteApi);
          inlineApi = { ...stateApi, ...viewApi, ...autocompleteApi, isolateHistory };
        }

        const createInline = inlineApi.createCodeMirrorInlineSuggestions || globalThis.HAPPIER_CODEMIRROR_INLINE_FACTORY;
        inlineRuntime = createInline(inlineApi, {
          separator: () => lineSeparator,
          event: payload => {
            if (payload.kind === 'accepted' || payload.kind === 'partiallyAccepted') flushPendingDocChange();
            sendEnvelope({ v: 1, type: 'inline.event', payload });
          },
          context: (context, changes, suggestion) => sendEnvelope({ v: 1, type: 'inline.context', payload: { context, changes: applyingRemote ? [] : changes, suggestion } }),
          requestAccept: payload => {
            flushPendingDocChange();
            sendEnvelope({ v: 1, type: 'inline.acceptRequested', payload });
          },
          nextEdit: kind => {
            flushPendingDocChange();
            sendEnvelope({ v: 1, type: 'nextEdit.key', payload: { kind } });
          },
        });

        function publishHistory() {
          if (view && undoDepth && redoDepth) sendEnvelope({ v: 1, type: 'history.state', payload: {
            canUndo: undoDepth(view.state) > 0, canRedo: redoDepth(view.state) > 0,
          } });
        }
        function applyGutterDigits(editor) {
          const digits = String(Math.max(DEFAULT_CONFIG.lineNumberDigits, String(editor.state.doc.lines).length));
          if (editor.dom.style.getPropertyValue('--happier-line-number-digits') !== digits) editor.dom.style.setProperty('--happier-line-number-digits', digits);
          editor.dom.style.setProperty('--happier-review-lane-width', DEFAULT_CONFIG.reviewLaneWidth + 'px');
        }
        function reveal(lineNumber, options = {}) {
          if (!view) return;
          const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, Math.floor(lineNumber) || 1)));
          const top = options.top && Number.isFinite(options.top.line) ? options.top : null;
          view.dispatch({ selection: { anchor: line.from, head: options.select ? line.to : line.from },
            ...(options.behavior === 'smooth' || top ? {} : { effects: EditorView.scrollIntoView(line.from, { y: 'center' }) }) });
          if (top) {
            const editor = view;
            const topLine = editor.state.doc.line(Math.max(1, Math.min(editor.state.doc.lines, Math.floor(top.line) || 1)));
            editor.requestMeasure({
              read: () => Math.max(0, editor.lineBlockAt(topLine.from).top + editor.documentPadding.top - (Number(top.offset) || 0)),
              write: scrollTop => { editor.scrollDOM.scrollTop = scrollTop; },
            });
          } else if (options.behavior === 'smooth') {
            const editor = view;
            editor.requestMeasure({
              read: () => { const block = editor.lineBlockAt(line.from); return Math.max(0, block.top - (editor.scrollDOM.clientHeight - block.height) / 2); },
              write: top => editor.scrollDOM.scrollTo({ top, behavior: 'smooth' }),
            });
          }
          if (options.focus) view.focus();
        }
        function runCommand(command) {
          if (!view || view.composing) return;
          if (typeof command === 'string' && intelligenceRuntime?.command(view, command)) return;
          if (command === 'inlineSuggestAccept' || command === 'inlineSuggestAcceptWord') {
            if (!inlineRuntime.request(view, command === 'inlineSuggestAcceptWord') && command === 'inlineSuggestAccept') inlineRuntime.nextEditKey?.(view, 'tab');
            return;
          }
          if (command === 'inlineSuggestDismiss') { if (!inlineRuntime.dismiss(view)) inlineRuntime.nextEditKey?.(view, 'dismiss'); return; }
          if (command === 'inlineSuggestTrigger') { sendEnvelope({ v: 1, type: 'inline.event', payload: { kind: 'trigger' } }); return; }
          if (command === 'find') { sendEnvelope({ v: 1, type: 'find.open', payload: {} }); return; }
          if (command === 'nextChange' || command === 'prevChange') {
            if (decorationRuntime) decorationRuntime.navigate(view, command === 'nextChange' ? 1 : -1);
            return;
          }
          if (command === 'moveLeft' || command === 'moveRight') { (command === 'moveLeft' ? cursorCharLeft : cursorCharRight)?.(view); return; }
          if (view.state.readOnly) return;
          if (sharedHistory && (command === 'undo' || command === 'redo')) {
            sendEnvelope({ v: 1, type: 'history.command', payload: { command } });
            return;
          }
          if (typeof command === 'object' && command) {
            if (typeof command.replaceDocument === 'string') {
              if (command.history === 'undo' || command.history === 'redo') {
                cancelPendingDocChange();
                lineSeparator = detectLineSeparator(command.replaceDocument);
                applyingRemote = true;
                try {
                  const changes = minimalDocumentEdit(view.state.doc.toString(), view.state.toText(command.replaceDocument).toString());
                  if (changes) view.dispatch({ changes });
                } finally { applyingRemote = false; }
                return;
              }
              const changes = minimalDocumentEdit(view.state.doc.toString(), view.state.toText(command.replaceDocument).toString());
              if (changes) view.dispatch({ changes, annotations: isolateHistory.of('full'), userEvent: 'input' });
            } else if (typeof command.insert === 'string') view.dispatch(view.state.replaceSelection(command.insert), { userEvent: 'input' });
          } else ({ indent: indentMore, outdent: indentLess, undo, redo })[command]?.(view);
          publishHistory();
        }

        const root = document.getElementById('root');
        const theme = DEFAULT_CONFIG.theme;
        const syntax = theme.syntax || {};
        const syntaxHighlightStyle = HighlightStyle && tags
          ? HighlightStyle.define([
              { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: syntax.commentColor },
              { tag: [tags.string, tags.docString, tags.character, tags.attributeValue, tags.regexp, tags.escape, tags.url], color: syntax.stringColor },
              { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.atom, tags.null], color: syntax.numberColor },
              { tag: [tags.keyword, tags.self, tags.modifier, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: syntax.keywordColor },
              { tag: [tags.operator, tags.derefOperator, tags.arithmeticOperator, tags.logicOperator, tags.bitwiseOperator, tags.compareOperator, tags.updateOperator, tags.definitionOperator, tags.typeOperator, tags.controlOperator], color: syntax.keywordColor },
              { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName), tags.definition(tags.propertyName), tags.labelName], color: syntax.functionColor },
              { tag: [tags.typeName, tags.className, tags.tagName, tags.attributeName, tags.propertyName, tags.namespace, tags.macroName], color: syntax.functionColor },
              { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: syntax.keywordColor },
              { tag: [tags.punctuation, tags.separator, tags.bracket, tags.angleBracket, tags.squareBracket, tags.paren, tags.brace], color: syntax.defaultColor },
              { tag: tags.invalid, color: syntax.keywordColor },
            ])
          : defaultHighlightStyle;
        const baseExtensions = [
          ...(intelligenceCompartment ? [intelligenceCompartment.of([])] : []),
          ...inlineRuntime.extensions,
          ...(decorationRuntime ? decorationRuntime.extensions : []),
          EditorView.domEventHandlers({ keydown: (event, editor) => {
            if (editor.composing || event.isComposing) return false;
            const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
            const signature = [key, 'shift=' + event.shiftKey, 'ctrl=' + event.ctrlKey, 'meta=' + event.metaKey, 'alt=' + event.altKey].join('|');
            if (!keyboardSignatures.has(signature)) return false;
            event.preventDefault();
            sendEnvelope({ v: 1, type: 'keyboard.shortcut', payload: { key: event.key, code: event.code,
              modifiers: { shift: event.shiftKey, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey }, repeat: event.repeat } });
            return true;
          }, beforeinput: (event, editor) => {
            if (!sharedHistory || editor.state.readOnly || editor.composing || event.isComposing
              || (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo')) return false;
            event.preventDefault();
            runCommand(event.inputType === 'historyUndo' ? 'undo' : 'redo');
            return true;
          } }),
          // The host owns the visible FindBar. This input-free panel enables engine decorations.
          search({ createPanel: () => { const dom = document.createElement('span'); dom.hidden = true; return { dom }; } }),
          keymap.of([
            { key: 'Mod-z', run: editor => { if (!sharedHistory || editor.state.readOnly || editor.composing) return false; runCommand('undo'); return true; } },
            { key: 'Mod-Shift-z', run: editor => { if (!sharedHistory || editor.state.readOnly || editor.composing) return false; runCommand('redo'); return true; } },
            { key: 'Mod-y', run: editor => { if (!sharedHistory || editor.state.readOnly || editor.composing) return false; runCommand('redo'); return true; } },
            { key: 'Alt-F5', run: () => { runCommand('nextChange'); return true; } },
            { key: 'Alt-Shift-F5', run: () => { runCommand('prevChange'); return true; } },
            ...defaultKeymap,
            ...closeBracketsKeymap,
          ]),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSpecialChars(),
          drawSelection(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          syntaxHighlighting(syntaxHighlightStyle, { fallback: true }),
        ];

        const themeExt = EditorView.theme({
          '&': {
            backgroundColor: theme.backgroundColor,
            color: theme.textColor,
          },
          '.cm-scroller': {
            backgroundColor: theme.backgroundColor,
            fontFamily: ${JSON.stringify(params.fontFamily ?? 'monospace')},
          },
          '.cm-content': {
            color: syntax.defaultColor,
            caretColor: theme.textColor,
            padding: '${insetVertical}px 0',
          },
          '.cm-line': { padding: '0' },
          '.cm-cursor, .cm-dropCursor': {
            borderLeftColor: theme.textColor,
          },
          '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
            backgroundColor: theme.selectionColor,
          },
          '.cm-gutters': {
            backgroundColor: theme.backgroundColor,
            borderRight: 'none',
            color: theme.lineNumberColor,
            paddingLeft: 'calc(${insetLeft + CODE_GUTTER_METRICS.rowPadding + CODE_GUTTER_METRICS.numberPaddingLeft}px + var(--happier-review-lane-width, ${params.reviewLaneWidth ?? 0}px))',
            paddingRight: '${gutterEnd}px',
          },
          '.cm-lineNumbers .cm-gutterElement': {
            color: theme.lineNumberColor,
            padding: '0',
            fontSize: '${numberFontSizePx}px',
            minWidth: ${JSON.stringify(params.showLineNumbers ? `max(${CODE_GUTTER_METRICS.numberMinWidth}px, calc(var(--happier-line-number-digits, 1) * ${fontSizePx / numberFontSizePx}ch))` : '0')},
          },
          '.happier-editor-gutter-change, .happier-editor-gutter-diagnostic, .happier-editor-gutter-blame': { position: 'absolute', top: '0', bottom: '0', width: '${markerLane}px' },
          '.happier-editor-gutter-change': { right: '${markerLane * 2}px' },
          '.happier-editor-gutter-diagnostic': { right: '${markerLane}px' },
          '.happier-editor-gutter-blame': { right: '0' },
          '.cm-activeLine': {
            backgroundColor: theme.activeLineColor,
          },
          '.cm-activeLineGutter': {
            backgroundColor: theme.activeLineColor,
            color: theme.textColor,
          },
          '.cm-searchMatch': { backgroundColor: theme.findMatchColor },
          '.happier-editor-inlay': { color: theme.lineNumberColor },
          '.happier-editor-occurrence': { backgroundColor: theme.selectionColor },
          '.happier-editor-semantic-function': { color: syntax.functionColor },
          '.happier-editor-semantic-keyword': { color: syntax.keywordColor },
          '.happier-editor-semantic-string': { color: syntax.stringColor },
          '.happier-editor-semantic-number': { color: syntax.numberColor },
          '.happier-editor-semantic-comment': { color: syntax.commentColor },
          '.cm-searchMatch.cm-searchMatch-selected': {
            backgroundColor: theme.findCurrentMatchColor,
            color: theme.findCurrentMatchForeground,
          },
        }, { dark: Boolean(theme.isDark) });

        function createView(doc, language, readOnly) {
          lineSeparator = detectLineSeparator(doc || '');
          const langExt = resolveLanguageExtension(language, {
            javascript: langJavascript && (langJavascript.javascript ?? langJavascript),
            json: langJson && (langJson.json ?? langJson),
            markdown: langMarkdown && (langMarkdown.markdown ?? langMarkdown),
            python: langPython && (langPython.python ?? langPython),
            yaml: langYaml && (langYaml.yaml ?? langYaml),
            shell: langShell && (langShell.shell ?? langShell),
            dockerfile: langDockerfile && (langDockerfile.dockerfile ?? langDockerfile),
            toml: langToml && (langToml.toml ?? langToml),
            ini: langIni && (langIni.ini ?? langIni),
            css: langCss && (langCss.css ?? langCss),
            scss: langScss && (langScss.scss ?? langScss),
            less: langLess && (langLess.less ?? langLess),
            html: langHtml && (langHtml.html ?? langHtml),
            xml: langXml && (langXml.xml ?? langXml),
            sql: langSql && (langSql.sql ?? langSql),
            rust: langRust && (langRust.rust ?? langRust),
            go: langGo && (langGo.go ?? langGo),
            java: langJava && (langJava.java ?? langJava),
            cpp: langCpp && (langCpp.cpp ?? langCpp),
            php: langPhp && (langPhp.php ?? langPhp),
          });

          const extensions = baseExtensions.slice();
          extensions.push(themeExt);
          extensions.push(EditorView.domEventHandlers({
            mousemove(event, editor) {
              const offset = editor.posAtCoords({ x: event.clientX, y: event.clientY });
              const coords = offset === null ? null : editor.coordsAtPos(offset);
              const position = offset === null ? null : documentPosition(editor, offset);
              sendEnvelope({ v: 1, type: 'pointer', payload: position && coords ? {
                ...position, rect: { x: coords.left, y: coords.top, width: coords.right - coords.left, height: coords.bottom - coords.top },
              } : null });
              return false;
            },
            mouseleave() {
              sendEnvelope({ v: 1, type: 'pointer', payload: null });
              return false;
            },
            mousedown(event, editor) {
              if (event.button !== 0 || (!event.metaKey && !event.ctrlKey) || editor.composing || !editor.contentDOM.contains(event.target)) return false;
              const offset = editor.posAtCoords({ x: event.clientX, y: event.clientY });
              if (offset === null) return false;
              event.preventDefault();
              sendEnvelope({ v: 1, type: 'activate', payload: documentPosition(editor, offset) });
              return true;
            },
          }));
          extensions.push(lineNumbers({ formatNumber: number => DEFAULT_CONFIG.showLineNumbers ? String(number) : '' }));
          if (DEFAULT_CONFIG.wrapLines) extensions.push(EditorView.lineWrapping);
          if (langExt) extensions.push(langExt);
          if (readOnly) extensions.push(EditorState.readOnly.of(true));
          if (!sharedHistory) extensions.push(history(), keymap.of(historyKeymap));

          const state = EditorState.create({
            doc: doc || '',
            extensions: extensions.concat([
              EditorView.updateListener.of((update) => {
                if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged) publishSelection(update.view);
                if (update.docChanged || update.viewportChanged || update.geometryChanged) scheduleGeometry();
                if (update.docChanged || update.selectionSet) publishCursor(update.view);
                if (update.focusChanged) sendEnvelope({ v: 1, type: 'editor.focus', payload: { focused: update.view.hasFocus } });
                if (findRequest && (update.docChanged || update.selectionSet)) publishFindStatus();
                if (!update.docChanged) return;
                applyGutterDigits(update.view);
                publishHistory();
                if (applyingRemote) return;
                if (changeTimer) clearTimeout(changeTimer);
                const history = update.transactions.some(transaction => transaction.isUserEvent('undo')) ? 'undo'
                  : update.transactions.some(transaction => transaction.isUserEvent('redo')) ? 'redo' : null;
                if (history) {
                  changeTimer = null;
                  sendEnvelope({ v: 1, type: 'docChanged', payload: { doc: serializeDoc(update.state.doc), history } });
                  return;
                }
                changeTimer = setTimeout(() => {
                  changeTimer = null;
                  try {
                    sendEnvelope({ v: 1, type: 'docChanged', payload: { doc: serializeDoc(update.state.doc) } });
                  } catch (e) {}
                }, CHANGE_DEBOUNCE_MS);
              }),
            ]),
          });

          const editor = new EditorView({ state, parent: root });
          editor.scrollDOM.addEventListener('scroll', scheduleGeometry, { passive: true });
          applyGutterDigits(editor);
          return editor;
        }

        function recreateView(doc, language, readOnly) {
          cancelPendingDocChange();
          if (view) {
            view.destroy();
            view = null;
          }
          view = createView(doc, language, readOnly);
          inlineRuntime.publish(view);
          publishSelection(view);
          publishCursor(view);
          if (decorationRuntime) for (const [layer, items] of decorationLayers) view.dispatch({ effects: decorationRuntime.set.of({ layer, items }) });
          currentLanguage = language;
          currentReadOnly = readOnly;
          if (findRequest) setFind(findRequest);
          publishHistory();
        }

        function documentPosition(editor, offset) {
          const line = editor.state.doc.lineAt(offset);
          return { line: line.number, character: offset - line.from };
        }

        function publishCursor(editor) {
          sendEnvelope({ v: 1, type: 'cursor', payload: documentPosition(editor, editor.state.selection.main.head) });
        }

        function publishSelection(editor) {
          const selection = editor.state.selection.main;
          const first = editor.state.doc.lineAt(selection.from);
          const last = editor.state.doc.lineAt(selection.to);
          let rect = null;
          try {
            const coords = editor.coordsAtPos(selection.from);
            if (coords) rect = { x: coords.left, y: coords.top, width: coords.right - coords.left, height: coords.bottom - coords.top };
          } catch (e) {
            // A selection can be outside the rendered viewport.
          }
          sendEnvelope({ v: 1, type: 'selection', payload: {
            startLine: first.number,
            endLine: last.number > first.number && selection.to === last.from ? last.number - 1 : last.number,
            text: selection.empty ? first.text : editor.state.doc.sliceString(selection.from, selection.to, lineSeparator),
            rect,
            collapsed: selection.empty,
          } });
        }

        function geometryOf(editor, position) {
          const doc = editor.state.doc;
          if (!Number.isInteger(position.line) || position.line < 1 || position.line > doc.lines) return null;
          const line = doc.line(position.line);
          try {
            if (position.character === null) {
              // The text column of the line, every visual row of it when it wraps.
              const start = editor.coordsAtPos(line.from, 1);
              const end = editor.coordsAtPos(line.to, -1);
              if (!start || !end) return null;
              const content = editor.contentDOM.getBoundingClientRect();
              return { x: start.left, y: start.top, width: Math.max(0, content.right - start.left), height: end.bottom - start.top };
            }
            const caret = editor.coordsAtPos(Math.min(line.from + Math.max(0, position.character), line.to), -1);
            return caret ? { x: caret.left, y: caret.top, width: 0, height: caret.bottom - caret.top } : null;
          } catch (e) {
            return null;
          }
        }

        function publishGeometry() {
          geometryFrame = 0;
          if (!view || !geometryWatch.length) return;
          const editor = view;
          editor.requestMeasure({
            read: () => geometryWatch.map(position => ({ line: position.line, character: position.character, rect: geometryOf(editor, position) })),
            write: items => sendEnvelope({ v: 1, type: 'geometry', payload: { items } }),
          });
        }

        function scheduleGeometry() {
          if (!geometryWatch.length || geometryFrame) return;
          geometryFrame = requestAnimationFrame(publishGeometry);
        }

        function publishFindStatus() {
          if (!view) return;
          let status = { kind: 'idle' };
          if (findRequest && findRequest.query.length) {
            const query = getSearchQuery(view.state);
            if (!query.valid) {
              status = { kind: 'invalidPattern' };
            } else {
              const cursor = query.getCursor(view.state);
              const selection = view.state.selection.main;
              let total = 0;
              let current = null;
              while (!cursor.next().done) {
                total++;
                if (cursor.value.from === selection.from && cursor.value.to === selection.to) current = total;
              }
              status = { kind: 'results', current, total, coverage: 'complete' };
            }
          }
          sendEnvelope({ v: 1, type: 'find.status', payload: {
            query: findRequest ? findRequest.query : '',
            options: findRequest ? findRequest.options : { matchCase: false, regex: false },
            status,
          } });
        }

        function setFind(request) {
          findRequest = request;
          if (!view) return;
          const options = request.options || {};
          const query = new SearchQuery({ search: request.query, caseSensitive: options.matchCase === true,
            regexp: options.regex === true, literal: options.regex !== true });
          openSearchPanel(view);
          view.dispatch({ effects: setSearchQuery.of(query) });
          if (query.valid && request.query.length) {
            let position = view.state.selection.main.from;
            if (request.target) {
              const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, request.target.line)));
              position = line.from + Math.max(0, Math.min(line.length, (request.target.column || 1) - 1));
            }
            let first = null;
            let selected = null;
            const cursor = query.getCursor(view.state);
            while (!cursor.next().done) {
              if (!first) first = cursor.value;
              if (cursor.value.from >= position) { selected = cursor.value; break; }
            }
            selected = selected || first;
            if (selected) view.dispatch({ selection: { anchor: selected.from, head: selected.to }, scrollIntoView: true });
          }
          publishFindStatus();
        }

        function setDoc(nextDoc) {
          if (!view) return;
          const normalizedDoc = nextDoc || '';
          if (serializeDoc(view.state.doc) === normalizedDoc) {
            // Editor and host agree; any still-pending change is a settled echo.
            cancelPendingDocChange();
            return;
          }
          if (changeTimer) {
            // Unflushed local edits: the incoming doc is stale relative to the editor.
            // Replacing the document would reset the cursor and drop in-flight keystrokes.
            // Local text wins; flush it upward so the host state converges instead.
            flushPendingDocChange();
            return;
          }
          const previousSelection = view.state.selection;
          const scrollDOM = view.scrollDOM || null;
          const previousScrollTop = scrollDOM ? scrollDOM.scrollTop : null;
          const previousScrollLeft = scrollDOM ? scrollDOM.scrollLeft : null;
          const changes = { from: 0, to: view.state.doc.length, insert: normalizedDoc };
          lineSeparator = detectLineSeparator(normalizedDoc);
          applyingRemote = true;
          try {
            try {
              view.dispatch({
                changes,
                selection: previousSelection,
                scrollIntoView: false,
              });
            } catch (e) {
              view.dispatch({ changes });
            }
          } finally {
            if (scrollDOM && typeof previousScrollTop === 'number') {
              scrollDOM.scrollTop = previousScrollTop;
            }
            if (scrollDOM && typeof previousScrollLeft === 'number') {
              scrollDOM.scrollLeft = previousScrollLeft;
            }
            applyingRemote = false;
          }
        }

        function configureIntelligence(config) {
          intelligenceConfig = config;
          intelligenceRuntime?.dispose(); intelligenceRuntime = null;
          if (!view || !intelligenceCompartment) return;
          if (!config || !intelligenceFactory) { view.dispatch({ effects: intelligenceCompartment.reconfigure([]) }); return; }
          intelligenceRuntime = intelligenceFactory({ ...config, subscribe: () => () => {}, getSnapshot: () => ({ capabilities: config.capabilities }),
            request: (kind, options, signal) => new Promise(resolve => {
              if (signal?.aborted) { resolve(null); return; }
              const id = String(++intelligenceSequence);
              const abort = () => { intelligenceRequests.delete(id); sendEnvelope({ v: 1, type: 'intelligence.cancel', payload: { id } }); resolve(null); };
              signal?.addEventListener('abort', abort, { once: true });
              intelligenceRequests.set(id, result => { signal?.removeEventListener('abort', abort); resolve(result); });
              flushPendingDocChange();
              sendEnvelope({ v: 1, type: 'intelligence.request', payload: { id, kind, options } });
            }),
          }, help => sendEnvelope({ v: 1, type: 'intelligence.signature', payload: { help } }));
          view.dispatch({ effects: intelligenceCompartment.reconfigure(intelligenceRuntime.extensions) });
        }

      function onEnvelope(envelope) {
          if (!envelope || envelope.v !== 1 || typeof envelope.type !== 'string') return;
          if (envelope.type === 'intelligence.configure') { configureIntelligence(envelope.payload); return; }
          if (envelope.type === 'intelligence.result') {
            const payload = envelope.payload || {}; const resolve = intelligenceRequests.get(payload.id);
            intelligenceRequests.delete(payload.id); resolve?.(payload.result); return;
          }
          if (envelope.type === 'intelligence.format') {
            Promise.resolve(view && intelligenceRuntime ? intelligenceRuntime.formatDocument(view) : null).then(() => {
              flushPendingDocChange(); sendEnvelope({ v: 1, type: 'intelligence.formatted', payload: { id: envelope.payload?.id } });
            }); return;
          }
          if (envelope.type === 'keyboard.config') {
            keyboardSignatures = new Set(Array.isArray(envelope.payload?.signatures) ? envelope.payload.signatures.filter(value => typeof value === 'string') : []);
            return;
          }
          if (envelope.type === 'focus') { if (view) view.focus(); return; }
          if (envelope.type === 'geometry.watch') {
            const positions = Array.isArray(envelope.payload?.positions) ? envelope.payload.positions : [];
            geometryWatch = positions.filter(position => position && Number.isInteger(position.line)
              && (position.character === null || Number.isInteger(position.character)));
            publishGeometry();
            return;
          }
          if (envelope.type === 'reveal') { const payload = envelope.payload || {}; reveal(payload.line, payload); return; }
          if (envelope.type === 'command') { runCommand(envelope.payload?.command); return; }
          if (envelope.type === 'inline.set') { if (view) inlineRuntime.set(view, envelope.payload); return; }
          if (envelope.type === 'inline.accept') { if (view) inlineRuntime.accept(view, envelope.payload || {}); return; }
          if (envelope.type === 'nextEdit.set') { if (view) inlineRuntime.setNextEdit?.(view, envelope.payload || null); return; }
          if (envelope.type === 'nextEdit.jump') {
            const payload = envelope.payload || {};
            if (view && Number.isInteger(payload.line) && payload.line >= 0 && payload.line < view.state.doc.lines) {
              const line = view.state.doc.line(payload.line + 1);
              const anchor = line.from + Math.max(0, Math.min(line.length, Number(payload.character) || 0));
              view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) });
              view.focus();
            }
            return;
          }
          if (envelope.type === 'nextEdit.apply') {
            const payload = envelope.payload || {};
            if (typeof payload.requestId !== 'string') return;
            const applied = Boolean(view && inlineRuntime.applyNextEdit?.(view, payload));
            if (applied) flushPendingDocChange();
            sendEnvelope({ v: 1, type: 'nextEdit.applied', payload: { requestId: payload.requestId, applied } });
            return;
          }
          if (envelope.type === 'decorations.set') {
            const payload = envelope.payload || {};
            if ((payload.layer === 'change' || payload.layer === 'diagnostic' || payload.layer === 'blame') && Array.isArray(payload.items)) {
              decorationLayers.set(payload.layer, payload.items);
              if (view && decorationRuntime) view.dispatch({ effects: decorationRuntime.set.of(payload) });
            }
            return;
          }
          if (envelope.type === 'decorations.remove') {
            const payload = envelope.payload || {};
            if ((payload.layer === 'change' || payload.layer === 'diagnostic' || payload.layer === 'blame') && typeof payload.id === 'string') {
              const items = decorationLayers.get(payload.layer);
              if (items) decorationLayers.set(payload.layer, items.filter(item => item.id !== payload.id));
              if (view && decorationRuntime) view.dispatch({ effects: decorationRuntime.remove.of(payload) });
            }
            return;
          }
          if (envelope.type === 'find.set') {
            const payload = envelope.payload || {};
            if (typeof payload.query === 'string') setFind(payload);
            return;
          }
          if (envelope.type === 'find.step') {
            if (view && findRequest && getSearchQuery(view.state).valid) {
              if (envelope.payload && envelope.payload.direction === -1) findPrevious(view);
              else findNext(view);
              publishFindStatus();
            }
            return;
          }
          if (envelope.type === 'find.close') {
            findRequest = null;
            if (view) {
              closeSearchPanel(view);
              view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '', literal: true })) });
              publishFindStatus();
            }
            return;
          }
          if (envelope.type === 'init') {
            const payload = envelope.payload || {};
            const previousSharedHistory = sharedHistory;
            sharedHistory = payload.sharedHistory === true;
            DEFAULT_CONFIG.lineNumberDigits = Math.max(1, payload.lineNumberDigits ?? DEFAULT_CONFIG.lineNumberDigits);
            DEFAULT_CONFIG.reviewLaneWidth = payload.reviewLaneWidth ?? DEFAULT_CONFIG.reviewLaneWidth;
            const doc = typeof payload.doc === 'string' ? payload.doc : '';
            const language = payload.language ?? null;
            const readOnly = payload.readOnly === true;
            if (view && previousSharedHistory === sharedHistory && currentLanguage === language && currentReadOnly === readOnly) {
              setDoc(doc);
            } else { recreateView(doc, language, readOnly); configureIntelligence(intelligenceConfig); }
            applyGutterDigits(view);
            if (payload.reveal) reveal(payload.reveal.line, payload.reveal);
            scheduleGeometry();
            view.requestMeasure({ read: () => null, write: () => sendEnvelope({ v: 1, type: 'editor.ready', payload: {} }) });
            return;
          }
          if (envelope.type === 'setDoc') {
            const payload = envelope.payload || {};
            setDoc(typeof payload.doc === 'string' ? payload.doc : '');
          }
          if (envelope.type === 'requestDoc') {
            const payload = envelope.payload || {};
            const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
            flushPendingDocChange();
            const doc = view ? serializeDoc(view.state.doc) : '';
            try {
              sendEnvelope({ v: 1, type: 'docSnapshot', payload: { requestId, doc } });
            } catch (e) {}
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
