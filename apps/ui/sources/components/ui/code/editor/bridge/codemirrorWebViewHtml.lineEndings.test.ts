// @vitest-environment jsdom
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import * as commands from '@codemirror/commands';
import * as language from '@codemirror/language';
import * as autocomplete from '@codemirror/autocomplete';
import * as search from '@codemirror/search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCodeMirrorWebViewHtml } from './codemirrorWebViewHtml';

// Load the installed CodeMirror modules through the WebView's embedded-bundle ABI.
vi.mock('./codemirrorWebViewBundle.generated', () => ({ CODEMIRROR_WEBVIEW_BUNDLE_JS: '/* installed modules supplied by test */' }));

type Envelope = { v: number; type: string; payload: { doc?: string; requestId?: string; message?: string; status?: unknown } };

function bootBridge() {
    const messages: Envelope[] = [];
    document.body.innerHTML = '<div id="root"></div>';
    vi.stubGlobal('__CM6__', { ...state, ...view, ...commands, ...language, ...autocomplete, ...search });
    Object.defineProperty(window, 'ReactNativeWebView', {
        configurable: true,
        value: { postMessage: (raw: string) => messages.push(JSON.parse(raw)) },
    });
    const html = buildCodeMirrorWebViewHtml({
        theme: {
            backgroundColor: '#000', textColor: '#fff', dividerColor: '#333', lineNumberColor: '#777',
            activeLineColor: '#111', selectionColor: '#555', isDark: true,
            syntax: {
                defaultColor: '#fff', keywordColor: '#fff', stringColor: '#fff', commentColor: '#777',
                numberColor: '#fff', functionColor: '#fff',
            },
        },
        wrapLines: true,
        showLineNumbers: true,
        changeDebounceMs: 100,
        maxChunkBytes: 64_000,
    });
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error('WebView bridge script missing');
    const documentListeners = vi.spyOn(document, 'addEventListener');
    const windowListeners = vi.spyOn(window, 'addEventListener');
    new Function(script)();
    expect(messages).toEqual([{ v: 1, type: 'ready', payload: { ok: true } }]);
    const send = (type: string, payload: object) => window.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ v: 1, type, payload }),
    }));
    const getView = () => {
        const element = document.querySelector<HTMLElement>('.cm-editor');
        const editor = element ? view.EditorView.findFromDOM(element) : null;
        if (!editor) throw new Error('CodeMirror view missing');
        return editor;
    };
    const cleanup = () => {
        getView().destroy();
        for (const [type, listener] of documentListeners.mock.calls) {
            if (type === 'message') document.removeEventListener(type, listener);
        }
        for (const [type, listener] of windowListeners.mock.calls) {
            if (type === 'message') window.removeEventListener(type, listener);
        }
    };
    return { messages, send, getView, cleanup };
}

describe('native CodeMirror WebView line endings', () => {
    let cleanup: (() => void) | undefined;

    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
    afterEach(() => {
        cleanup?.();
        cleanup = undefined;
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        Reflect.deleteProperty(window, 'ReactNativeWebView');
    });

    it('finds literal backslashes on the live CRLF document, seeds the addressed hit and preserves selection on close', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: '😀 first\\n\r\nsecond\\n\r\nthird\\n' });
        bridge.send('find.set', { query: '\\n', options: { matchCase: true, regex: false }, target: { line: 2, column: 7 } });
        const editor = bridge.getView();
        expect(editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to)).toBe('\\n');
        expect(editor.state.doc.lineAt(editor.state.selection.main.from).number).toBe(2);
        expect(bridge.messages.at(-1)).toMatchObject({ type: 'find.status', payload: {
            status: { kind: 'results', current: 2, total: 3, coverage: 'complete' },
        } });
        expect(document.querySelector('.cm-search')).toBeNull();
        expect(document.querySelectorAll('.cm-searchMatch')).toHaveLength(3);
        expect(document.querySelectorAll('.cm-searchMatch-selected')).toHaveLength(1);

        bridge.send('find.step', { direction: 1 });
        expect(editor.state.doc.lineAt(editor.state.selection.main.from).number).toBe(3);
        expect(bridge.messages.at(-1)?.payload.status).toMatchObject({ current: 3, total: 3 });
        const selection = editor.state.selection;
        bridge.send('find.close', {});
        expect(editor.state.selection).toBe(selection);
        expect(bridge.messages.at(-1)?.payload.status).toEqual({ kind: 'idle' });
        bridge.send('requestDoc', { requestId: 'after-find' });
        expect(bridge.messages.at(-1)?.payload.doc).toBe('😀 first\\n\r\nsecond\\n\r\nthird\\n');
    });

    it('reports invalid regex and refreshes counts from edits before the host change debounce', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'one two' });
        bridge.send('find.set', { query: '[', options: { matchCase: false, regex: true } });
        expect(bridge.messages.at(-1)?.payload.status).toEqual({ kind: 'invalidPattern' });
        bridge.send('find.set', { query: 'one', options: { matchCase: false, regex: false } });
        bridge.getView().dispatch({ changes: { from: 7, insert: ' one' } });
        expect(bridge.messages.at(-1)?.payload.status).toMatchObject({ kind: 'results', total: 2 });
    });

    it.each(['\r\n', '\r', '\n'])('preserves %j in snapshots, debounced changes and stale-host flushes', (separator) => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        const initial = `one${separator}two${separator}`;
        bridge.send('init', { doc: initial });
        bridge.send('requestDoc', { requestId: 'initial' });
        expect(bridge.messages.at(-1)).toEqual({ v: 1, type: 'docSnapshot', payload: { requestId: 'initial', doc: initial } });

        const editor = bridge.getView();
        editor.dispatch({ changes: { from: editor.state.doc.length, insert: `three${separator}` } });
        vi.advanceTimersByTime(100);
        const changed = `${initial}three${separator}`;
        expect(bridge.messages.at(-1)).toEqual({ v: 1, type: 'docChanged', payload: { doc: changed } });

        editor.dispatch({ selection: { anchor: 2 } });
        const beforeEcho = editor.state;
        bridge.send('setDoc', { doc: changed });
        expect(editor.state).toBe(beforeEcho);
        expect(editor.state.selection.main.anchor).toBe(2);

        editor.dispatch({ changes: { from: editor.state.doc.length, insert: 'four' } });
        bridge.send('setDoc', { doc: changed });
        expect(bridge.messages.at(-1)).toEqual({ v: 1, type: 'docChanged', payload: { doc: `${changed}four` } });
        bridge.send('requestDoc', { requestId: 'latest' });
        expect(bridge.messages.at(-1)?.payload.doc).toBe(`${changed}four`);
    });

    it('detects the separator again when the host replaces the document', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'one\r\ntwo\r\n' });
        bridge.send('setDoc', { doc: 'alpha\rbeta\r' });
        bridge.send('requestDoc', { requestId: 'replacement' });
        expect(bridge.messages.at(-1)?.payload.doc).toBe('alpha\rbeta\r');
        const editor = bridge.getView();
        editor.dispatch({ changes: { from: editor.state.doc.length, insert: 'gamma\r' } });
        vi.advanceTimersByTime(100);
        expect(bridge.messages.at(-1)?.payload.doc).toBe('alpha\rbeta\rgamma\r');
    });
});
