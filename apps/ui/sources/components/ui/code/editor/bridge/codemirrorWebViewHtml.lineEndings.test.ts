// @vitest-environment jsdom
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import * as commands from '@codemirror/commands';
import * as language from '@codemirror/language';
import * as autocomplete from '@codemirror/autocomplete';
import * as search from '@codemirror/search';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCodeMirrorWebViewHtml } from './codemirrorWebViewHtml';
import { createCodeMirrorDecorations } from './codeMirrorDecorations';
import { createCodeMirrorLanguageIntelligence } from './codeMirrorLanguageIntelligence';
import { createCodeMirrorInlineSuggestions } from './codeMirrorInlineSuggestions';
import { CodeMirrorWebViewSurface } from '../surfaces/CodeMirrorWebViewSurface.native';
import type { CodeEditorHandle } from '../codeEditorTypes';
import { createEditorDocumentHistory } from '../editorDocumentHistory';
import { renderScreen } from '@/dev/testkit';

const nativeBoundary = vi.hoisted(() => ({
    postMessage: vi.fn<(raw: string) => void>(),
    onMessage: null as ((event: { nativeEvent: { data: string } }) => void) | null,
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View', Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-webview', () => ({
    // Only the native transport is replaced; both bridge and surface run unchanged.
    WebView: React.forwardRef((props: { onMessage: NonNullable<typeof nativeBoundary.onMessage> }, ref) => {
        nativeBoundary.onMessage = props.onMessage;
        React.useImperativeHandle(ref, () => ({ postMessage: nativeBoundary.postMessage }));
        return null;
    }),
}));

// Load the installed CodeMirror modules through the WebView's embedded-bundle ABI.
vi.mock('./codemirrorWebViewBundle.generated', () => ({ CODEMIRROR_WEBVIEW_BUNDLE_JS: '/* installed modules supplied by test */' }));

type Envelope = { v: number; type: string; payload: { doc?: string; requestId?: string; message?: string; status?: unknown } };

function bootBridge(onMessage?: (raw: string) => void) {
    const messages: Envelope[] = [];
    document.body.innerHTML = '<div id="root"></div>';
    vi.stubGlobal('__CM6__', { ...state, ...view, ...commands, ...language, ...autocomplete, ...search, createCodeMirrorDecorations, createCodeMirrorLanguageIntelligence, createCodeMirrorInlineSuggestions });
    Object.defineProperty(window, 'ReactNativeWebView', {
        configurable: true,
        value: { postMessage: (raw: string) => { messages.push(JSON.parse(raw)); onMessage?.(raw); } },
    });
    const html = buildCodeMirrorWebViewHtml({
        theme: {
            backgroundColor: '#000', widgetBackgroundColor: '#000', stickyBackgroundColor: '#000', textColor: '#fff', dividerColor: '#333', lineNumberColor: '#777',
            activeLineColor: '#111', selectionColor: '#555', isDark: true, changeAddedColor: '#32d74b', changeDeletedColor: '#8e8e93',
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
    let restoreRangeGeometry: (() => void) | undefined;

    beforeEach(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        // JSDOM has no layout engine; retain the real CodeMirror measurement path over a DOM boundary fixture.
        const descriptors = ['getClientRects', 'getBoundingClientRect'].map((name) => [name, Object.getOwnPropertyDescriptor(Range.prototype, name)] as const);
        Object.defineProperties(Range.prototype, {
            getClientRects: { configurable: true, value: () => [] },
            getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
        });
        restoreRangeGeometry = () => {
            for (const [name, descriptor] of descriptors) {
                if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
                else Reflect.deleteProperty(Range.prototype, name);
            }
        };
    });

    it('publishes buffered typing before a public flush even when inline context already advanced the native mirror', async () => {
        const history = createEditorDocumentHistory();
        let text = 'seed';
        const publications: string[] = [];
        const ref = React.createRef<CodeEditorHandle>();
        const screen = await renderScreen(React.createElement(CodeMirrorWebViewSurface, {
            ref, resetKey: 'inline-flush', value: text, language: 'text', history,
            onChange: next => { publications.push(next); history.record(text, next); text = next; },
        }));
        const outbound: string[] = [];
        nativeBoundary.postMessage.mockImplementation(raw => { outbound.push(raw); });
        const bridge = bootBridge(raw => nativeBoundary.onMessage?.({ nativeEvent: { data: raw } }));
        cleanup = bridge.cleanup;
        const deliver = (raw: string) => {
            const envelope = JSON.parse(raw) as { type: string; payload: object };
            bridge.send(envelope.type, envelope.payload);
        };
        nativeBoundary.postMessage.mockImplementation(deliver);
        for (const raw of outbound) deliver(raw);
        try {
            await act(async () => { bridge.getView().dispatch({ changes: { from: 4, insert: ' typed' } }); });
            expect(ref.current!.getValue()).toBe('seed typed');
            expect(text).toBe('seed');
            await act(async () => { await ref.current!.flushPendingChange(); });
            expect(text).toBe('seed typed');
            await act(async () => { await ref.current!.flushPendingChange(); vi.advanceTimersByTime(101); });
            expect(publications).toEqual(['seed typed']);
            expect(history.undo(text)).toBe('seed');
            expect(history.getSnapshot()).toEqual({ canUndo: false, canRedo: true });
        } finally {
            nativeBoundary.postMessage.mockReset();
            nativeBoundary.onMessage = null;
            await screen.unmount();
        }
    });
    afterEach(() => {
        cleanup?.();
        cleanup = undefined;
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        Reflect.deleteProperty(window, 'ReactNativeWebView');
        restoreRangeGeometry?.();
        restoreRangeGeometry = undefined;
    });

    it('delegates shared Undo before engine history and applies exact tagged bytes without echoing an edit', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'before\r\n', sharedHistory: true });
        const editor = bridge.getView();
        editor.dispatch({ changes: { from: 0, insert: 'after ' } });
        expect(commands.undo(editor)).toBe(false);
        const undo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
        editor.contentDOM.dispatchEvent(undo);
        expect(undo.defaultPrevented).toBe(true);
        expect(bridge.messages.filter(message => message.type === 'history.command').at(-1)?.payload).toEqual({ command: 'undo' });
        const systemRedo = new InputEvent('beforeinput', { inputType: 'historyRedo', bubbles: true, cancelable: true });
        editor.contentDOM.dispatchEvent(systemRedo);
        expect(systemRedo.defaultPrevented).toBe(true);
        expect(bridge.messages.filter(message => message.type === 'history.command').at(-1)?.payload).toEqual({ command: 'redo' });
        editor.contentDOM.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true }));
        expect(bridge.messages.filter(message => message.type === 'history.command')).toHaveLength(2);
        expect(editor.state.doc.toString()).toBe('after before\n');
        bridge.send('command', { command: { replaceDocument: 'before\r\n', history: 'undo' } });
        vi.advanceTimersByTime(101);
        bridge.send('requestDoc', { requestId: 'shared-undo' });
        expect(bridge.messages.filter(message => message.type === 'docSnapshot').at(-1)?.payload).toEqual({ requestId: 'shared-undo', doc: 'before\r\n' });
        expect(bridge.messages.filter(message => message.type === 'docChanged')).toHaveLength(0);
    });

    it('previews an insertion without changing bytes, then accepts through authorization with one isolated undo', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'const café =\r\nnext' });
        const editor = bridge.getView();
        editor.dispatch({ selection: { anchor: editor.state.doc.line(1).to } });
        const rawDoc = () => {
            bridge.send('requestDoc', { requestId: 'inline-bytes' });
            return bridge.messages.filter(message => message.type === 'docSnapshot').at(-1)?.payload.doc;
        };
        bridge.send('inline.set', { id: 'one', text: ' naïve😀\r\nfinish', line: 1, character: 12 });
        expect(editor.dom.querySelector('.happier-editor-inline-suggestion')?.textContent).toBe(' naïve😀\r\nfinish');
        expect(rawDoc()).toBe('const café =\r\nnext');
        bridge.send('command', { command: 'inlineSuggestAccept' });
        expect(rawDoc()).toBe('const café =\r\nnext');
        const request = bridge.messages.filter(message => message.type === 'inline.acceptRequested').at(-1);
        expect(request?.payload).toMatchObject({ id: 'one', partial: false });
        bridge.send('inline.accept', request!.payload);
        expect(rawDoc()).toBe('const café = naïve😀\r\nfinish\r\nnext');
        bridge.send('command', { command: 'undo' });
        expect(rawDoc()).toBe('const café =\r\nnext');
    });

    it('keeps a matching typed prefix, accepts Unicode words separately, and refuses stale authorization', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'x' });
        const editor = bridge.getView();
        editor.dispatch({ selection: { anchor: 1 } });
        bridge.send('inline.set', { id: 'unicode', text: 'café😀\r\nend', line: 1, character: 1 });
        editor.dispatch({ changes: { from: 1, insert: 'c' }, selection: { anchor: 2 } });
        expect(editor.dom.querySelector('.happier-editor-inline-suggestion')?.textContent).toBe('afé😀\r\nend');
        bridge.send('command', { command: 'inlineSuggestAcceptWord' });
        const request = bridge.messages.filter(message => message.type === 'inline.acceptRequested').at(-1)!;
        bridge.send('inline.accept', request.payload);
        expect(editor.state.sliceDoc()).toBe('xcafé');
        expect(editor.dom.querySelector('.happier-editor-inline-suggestion')?.textContent).toBe('😀\r\nend');
        bridge.send('command', { command: 'undo' });
        expect(editor.state.sliceDoc()).toBe('xc');
        bridge.send('inline.accept', request.payload);
        expect(editor.state.sliceDoc()).toBe('xc');
    });

    it('retires a ghost on an incompatible edit or selection and manual trigger never changes bytes', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'x' });
        const editor = bridge.getView();
        editor.dispatch({ selection: { anchor: 1 } });
        bridge.send('inline.set', { id: 'one', text: 'end', line: 1, character: 1 });
        editor.dispatch({ changes: { from: 0, insert: '!' } });
        expect(editor.dom.querySelector('.happier-editor-inline-suggestion')).toBeNull();
        bridge.send('inline.set', { id: 'two', text: 'end', line: 1, character: 1 });
        editor.dispatch({ selection: { anchor: 0, head: 1 } });
        expect(editor.dom.querySelector('.happier-editor-inline-suggestion')).toBeNull();
        bridge.send('command', { command: 'inlineSuggestTrigger' });
        expect(bridge.messages.filter(message => message.type === 'inline.event').at(-1)?.payload).toMatchObject({ kind: 'trigger' });
        expect(editor.state.sliceDoc()).toBe('!x');
    });

    it('suppresses ghost acceptance during composition, with multiple carets, and while a real completion list is pending', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'xy' });
        const editor = bridge.getView();
        editor.dispatch({ effects: state.StateEffect.appendConfig.of(state.EditorState.allowMultipleSelections.of(true)),
            selection: state.EditorSelection.create([state.EditorSelection.cursor(0), state.EditorSelection.cursor(1)]) });
        bridge.send('inline.set', { id: 'multi', text: 'tail', line: 1, character: 1 });
        expect(editor.dom.querySelector('.happier-editor-inline-suggestion')).toBeNull();
        editor.dispatch({ selection: { anchor: 1 } });
        editor.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        bridge.send('inline.set', { id: 'ime', text: 'tail', line: 1, character: 1 });
        bridge.send('command', { command: 'inlineSuggestAccept' });
        expect(editor.dom.querySelector('.happier-editor-inline-suggestion')).toBeNull();
        expect(bridge.messages.some(message => message.type === 'inline.acceptRequested')).toBe(false);
        editor.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        editor.dispatch({ effects: state.StateEffect.appendConfig.of(autocomplete.autocompletion({ override: [() => new Promise(() => {})] })) });
        autocomplete.startCompletion(editor);
        expect(autocomplete.completionStatus(editor.state)).toBe('pending');
        bridge.send('inline.set', { id: 'list', text: 'tail', line: 1, character: 1 });
        bridge.send('command', { command: 'inlineSuggestAccept' });
        expect(editor.dom.querySelector('.happier-editor-inline-suggestion')).toBeNull();
        expect(bridge.messages.some(message => message.type === 'inline.acceptRequested')).toBe(false);
        expect(editor.state.doc.toString()).toBe('xy');
    });

    it('reports a single compact UTF-16 edit for a keystroke on a 5k-line CRLF document', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        const text = Array.from({ length: 5_000 }, (_, index) => `const value${index} = ${index};`).join('\r\n');
        bridge.send('init', { doc: text });
        const editor = bridge.getView();
        editor.dispatch({ changes: { from: editor.state.doc.length, insert: '😀' }, selection: { anchor: editor.state.doc.length + 2 } });
        expect(bridge.messages.filter(message => message.type === 'inline.context').at(-1)?.payload).toMatchObject({
            changes: [{ from: text.length, to: text.length, insert: '😀' }],
            context: { line: 5_000, offset: text.length + 2, eol: '\r\n' },
        });
        expect(bridge.messages.filter(message => message.type === 'docChanged')).toHaveLength(0);
    });

    it('routes the native autocomplete through controller envelopes and cancels after an incompatible edit', async () => {
        const bridge = bootBridge(); cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'ans' });
        bridge.send('intelligence.configure', { path: 'a.ts', inlayHints: 'off', semanticHighlighting: false, capabilities: { completion: true, completionTriggerCharacters: ['.'] } });
        const editor = bridge.getView(); editor.dispatch({ selection: { anchor: 3 } });
        bridge.send('command', { command: 'suggest' });
        await vi.waitFor(() => expect(bridge.messages.some(message => message.type === 'intelligence.request')).toBe(true));
        const sent = bridge.messages.find(message => message.type === 'intelligence.request');
        expect(sent?.payload).toMatchObject({ kind: 'completion', options: { position: { line: 0, character: 3 } } });
        expect(sent?.payload).not.toHaveProperty('text');
        editor.dispatch({ changes: { from: 3, insert: 'x' } });
        expect(bridge.messages.some(message => message.type === 'intelligence.cancel')).toBe(true);
    });

    it('removes one tracked decoration through the bridge without reseeding the shifted remainder', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'first\nsecond\nthird\nlast' });
        bridge.send('decorations.set', { layer: 'change', items: [
            { id: 'first', key: 'first', kind: 'modified', startLine: 1, endLine: 1 },
            { id: 'last', key: 'last', kind: 'modified', startLine: 4, endLine: 4 },
        ] });
        const editor = bridge.getView();
        editor.dispatch({ changes: { from: 0, insert: 'before\n' } });
        bridge.send('decorations.remove', { layer: 'change', id: 'first' });
        bridge.send('command', { command: 'nextChange' });
        expect(bridge.messages.filter(message => message.type === 'decorations.press').at(-1)?.payload)
            .toMatchObject({ layer: 'change', item: { id: 'last', startLine: 5 } });
        bridge.send('decorations.remove', { layer: 'change', id: 'last' });
        const presses = bridge.messages.filter(message => message.type === 'decorations.press').length;
        bridge.send('command', { command: 'nextChange' });
        expect(bridge.messages.filter(message => message.type === 'decorations.press')).toHaveLength(presses);
    });

    it('reads a pressed change from its first column when the editor was scrolled sideways', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: `const label = '${'x'.repeat(400)}';\nlast` });
        bridge.send('decorations.set', { layer: 'change', items: [{ id: 'long', key: 'long', kind: 'modified', startLine: 1, endLine: 1 }] });
        const editor = bridge.getView();
        editor.scrollDOM.scrollLeft = 240;
        expect(editor.scrollDOM.scrollLeft).toBe(240);
        const mark = editor.dom.querySelector('.happier-editor-gutter-change .cm-gutterElement:not(:first-child)')
            ?? editor.dom.querySelector('.happier-editor-gutter-change .cm-gutterElement');
        if (!mark) throw new Error('change gutter missing');
        mark.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
        expect(bridge.messages.filter(message => message.type === 'decorations.press').at(-1)?.payload).toMatchObject({ layer: 'change', item: { id: 'long' } });
        expect(editor.scrollDOM.scrollLeft).toBe(0);
    });

    it('publishes the current line at a caret and exact CRLF selection text with whole-line anchor bounds', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'first\r\nsecond\r\nthird' });
        const selections = () => bridge.messages.filter((message) => message.type === 'selection');
        expect(selections().at(-1)?.payload).toMatchObject({ startLine: 1, endLine: 1, text: 'first' });
        const editor = bridge.getView();
        editor.dispatch({ selection: { anchor: 2, head: editor.state.doc.line(3).from } });
        expect(selections().at(-1)?.payload).toMatchObject({ startLine: 1, endLine: 2, text: 'rst\r\nsecond\r\n' });
        editor.dispatch({ selection: { anchor: editor.state.doc.line(2).from + 1 } });
        expect(selections().at(-1)?.payload).toMatchObject({ startLine: 2, endLine: 2, text: 'second' });
        editor.dispatch({ changes: { from: editor.state.doc.line(2).to, insert: '!' } });
        expect(selections().at(-1)?.payload).toMatchObject({ startLine: 2, endLine: 2, text: 'second!' });
    });

    it('carries original-document UTF-16 caret and selection offsets through the native bridge', async () => {
        const text = '😀 same\r\nsame\r\nlast';
        const ref = React.createRef<CodeEditorHandle>();
        const screen = await renderScreen(React.createElement(CodeMirrorWebViewSurface, {
            ref, resetKey: 'offsets', value: text, language: 'sql', onChange: () => {},
        }));
        const outbound: string[] = [];
        nativeBoundary.postMessage.mockImplementation(raw => { outbound.push(raw); });
        const bridge = bootBridge(raw => nativeBoundary.onMessage?.({ nativeEvent: { data: raw } }));
        cleanup = bridge.cleanup;
        const deliver = (raw: string) => {
            const envelope = JSON.parse(raw) as { type: string; payload: object };
            bridge.send(envelope.type, envelope.payload);
        };
        nativeBoundary.postMessage.mockImplementation(deliver);
        for (const raw of outbound) deliver(raw);
        try {
            const editor = bridge.getView();
            expect(ref.current?.getSelection?.()).toMatchObject({ range: { start: 0, end: 0 } });
            await act(async () => { editor.dispatch({ selection: { anchor: editor.state.doc.line(2).from + 2 } }); });
            expect(ref.current?.getSelection?.()).toMatchObject({ range: { start: 11, end: 11 }, collapsed: true });
            await act(async () => { editor.dispatch({ selection: { anchor: editor.state.doc.line(3).from, head: 3 } }); });
            expect(ref.current?.getSelection?.()).toMatchObject({ range: { start: 3, end: 15 }, text: text.slice(3, 15), collapsed: false });
        } finally {
            nativeBoundary.postMessage.mockReset();
            nativeBoundary.onMessage = null;
            await screen.unmount();
        }
    });

    it('requests and applies portable completions through the native editor without a workspace language server', async () => {
        const text = '😀 same\r\nse';
        const complete = vi.fn(async (_position: { offset: number; line: number; character: number; explicit: boolean }, _signal: AbortSignal) => [
            { label: 'second', detail: 'text', range: { start: 9, end: 11 } },
        ]);
        const ref = React.createRef<CodeEditorHandle>();
        const onChange = vi.fn();
        const screen = await renderScreen(React.createElement(CodeMirrorWebViewSurface, {
            ref, resetKey: 'completion', value: text, language: 'sql', onChange, completionSource: { complete },
        }));
        const outbound: string[] = [];
        nativeBoundary.postMessage.mockImplementation(raw => { outbound.push(raw); });
        const bridge = bootBridge(raw => nativeBoundary.onMessage?.({ nativeEvent: { data: raw } }));
        cleanup = bridge.cleanup;
        const deliver = (raw: string) => {
            const envelope = JSON.parse(raw) as { type: string; payload: object };
            bridge.send(envelope.type, envelope.payload);
        };
        nativeBoundary.postMessage.mockImplementation(deliver);
        for (const raw of outbound) deliver(raw);
        try {
            const editor = bridge.getView();
            editor.dispatch({ selection: { anchor: editor.state.doc.length } });
            await act(async () => { autocomplete.startCompletion(editor); await vi.advanceTimersByTimeAsync(100); });
            expect(complete).toHaveBeenCalledWith({ offset: 11, line: 2, character: 2, explicit: true }, expect.any(AbortSignal));
            expect(autocomplete.currentCompletions(editor.state).map(item => item.label)).toEqual(['second']);
            await act(async () => {
                await vi.waitFor(() => expect(autocomplete.acceptCompletion(editor)).toBe(true));
                await ref.current!.flushPendingChange();
            });
            expect(onChange).toHaveBeenLastCalledWith('😀 same\r\nsecond');
            let pendingSignal: AbortSignal | undefined;
            let settle: (items: Awaited<ReturnType<typeof complete>>) => void = () => {};
            complete.mockResolvedValue([]).mockImplementationOnce((_position, signal) => {
                pendingSignal = signal;
                return new Promise(resolve => { settle = resolve; });
            });
            await act(async () => { autocomplete.startCompletion(editor); await vi.advanceTimersByTimeAsync(100); });
            expect(pendingSignal?.aborted).toBe(false);
            await act(async () => { editor.dispatch({ changes: { from: editor.state.doc.length, insert: 'x' } }); });
            expect(pendingSignal?.aborted).toBe(true);
            await act(async () => { settle([{ label: 'stale', detail: 'text', range: { start: 9, end: 11 } }]); await vi.advanceTimersByTimeAsync(100); });
            expect(autocomplete.currentCompletions(editor.state).map(item => item.label)).not.toContain('stale');
        } finally {
            nativeBoundary.postMessage.mockReset();
            nativeBoundary.onMessage = null;
            await screen.unmount();
        }
    });

    it('forwards only configured editor shortcuts before native CodeMirror handlers and preserves composing input', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'one\ntwo' });
        bridge.send('keyboard.config', { signatures: ['i|shift=false|ctrl=false|meta=true|alt=false'] });
        const editor = bridge.getView();
        const sendKey = (init: KeyboardEventInit) => {
            const event = new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', bubbles: true, cancelable: true, ...init });
            editor.contentDOM.dispatchEvent(event);
            return event;
        };
        expect(sendKey({ metaKey: true }).defaultPrevented).toBe(true);
        const shortcut = bridge.messages.filter((message) => message.type === 'keyboard.shortcut');
        expect(shortcut).toHaveLength(1);
        expect(shortcut[0].payload).toMatchObject({ key: 'i', code: 'KeyI', modifiers: { shift: false, ctrl: false, meta: true, alt: false } });
        expect(sendKey({ metaKey: true, isComposing: true }).defaultPrevented).toBe(false);
        bridge.send('keyboard.config', { signatures: [] });
        expect(sendKey({ metaKey: true }).defaultPrevented).toBe(false);
        expect(bridge.messages.filter((message) => message.type === 'keyboard.shortcut')).toHaveLength(1);
    });

    it('bridges pointer, activation and cursor positions from the real editor in UTF-16', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'one\n😀 symbol' });
        const editor = bridge.getView();
        editor.dispatch({ selection: { anchor: 7 } });
        expect(bridge.messages).toContainEqual({ v: 1, type: 'cursor', payload: { line: 2, character: 3 } });
        vi.spyOn(editor, 'posAtCoords').mockReturnValue(7);
        vi.spyOn(editor, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 20, bottom: 42 });
        editor.contentDOM.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 20 }));
        expect(bridge.messages.at(-1)).toEqual({ v: 1, type: 'pointer', payload: {
            line: 2, character: 3, rect: { x: 10, y: 20, width: 0, height: 22 },
        } });
        const click = new MouseEvent('mousedown', { bubbles: true, cancelable: true, metaKey: true, clientX: 10, clientY: 20 });
        editor.contentDOM.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(true);
        expect(bridge.messages.at(-1)).toEqual({ v: 1, type: 'activate', payload: { line: 2, character: 3 } });
        editor.contentDOM.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        expect(bridge.messages.at(-1)).toEqual({ v: 1, type: 'pointer', payload: null });
        const activations = bridge.messages.filter((message) => message.type === 'activate').length;
        editor.contentDOM.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, metaKey: true, button: 2, clientX: 10, clientY: 20 }));
        expect(bridge.messages.filter((message) => message.type === 'activate')).toHaveLength(activations);
    });

    it('executes accessory commands and whole-document replacement as one undoable edit, guarded during composition', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'one\ntwo\nthree' });
        bridge.send('reveal', { line: 2, select: true });
        const editor = bridge.getView();
        expect(editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to)).toBe('two');
        bridge.send('command', { command: { insert: 'TWO' } });
        expect(editor.state.doc.toString()).toBe('one\nTWO\nthree');
        bridge.send('command', { command: 'indent' });
        expect(editor.state.doc.line(2).text).toBe('  TWO');
        bridge.send('command', { command: 'outdent' });
        expect(editor.state.doc.line(2).text).toBe('TWO');
        bridge.send('command', { command: { replaceDocument: 'one\nSECOND\nthree' } });
        expect(editor.state.doc.toString()).toBe('one\nSECOND\nthree');
        bridge.send('command', { command: 'undo' });
        expect(editor.state.doc.toString()).toBe('one\nTWO\nthree');
        expect(bridge.messages.filter(message => message.type === 'docChanged').at(-1)?.payload)
            .toEqual({ doc: 'one\nTWO\nthree', history: 'undo' });
        expect(bridge.messages).toContainEqual({ v: 1, type: 'history.state', payload: { canUndo: true, canRedo: true } });
        bridge.send('command', { command: 'redo' });
        expect(editor.state.doc.line(2).text).toBe('SECOND');
        expect(bridge.messages.filter(message => message.type === 'docChanged').at(-1)?.payload)
            .toEqual({ doc: 'one\nSECOND\nthree', history: 'redo' });
        Object.defineProperty(editor, 'composing', { configurable: true, value: true });
        bridge.send('command', { command: { insert: 'ignored' } });
        bridge.send('command', { command: 'undo' });
        expect(editor.state.doc.line(2).text).toBe('SECOND');
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
        expect(bridge.messages.filter(message => message.type === 'find.status').at(-1)?.payload.status).toMatchObject({ kind: 'results', total: 2 });
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
