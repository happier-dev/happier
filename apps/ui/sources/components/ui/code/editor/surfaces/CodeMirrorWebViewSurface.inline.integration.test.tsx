// @vitest-environment jsdom
import React from 'react';
import { act } from 'react-test-renderer';
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import * as commands from '@codemirror/commands';
import * as language from '@codemirror/language';
import * as autocomplete from '@codemirror/autocomplete';
import * as search from '@codemirror/search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createCodeMirrorDecorations } from '../bridge/codeMirrorDecorations';
import { createCodeMirrorInlineSuggestions } from '../bridge/codeMirrorInlineSuggestions';
import { createEditorDocumentHistory } from '../editorDocumentHistory';
import type { CodeEditorHandle } from '../codeEditorTypes';
import { useFileEditorNavigationAnchor } from '@/components/workspaces/files/details/workspaceFileDetails/useFileEditorNavigationAnchor';

const boundary = vi.hoisted(() => ({ props: null as null | { source: { html: string }; onMessage: (event: { nativeEvent: { data: string } }) => void } }));
vi.mock('../bridge/codemirrorWebViewBundle.generated', () => ({ CODEMIRROR_WEBVIEW_BUNDLE_JS: '/* installed engine modules */' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default }, PixelRatio: { getFontScale: () => 1 } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// The native WebView is the OS boundary. Both sides of its actual bridge and the installed editor remain real.
vi.mock('react-native-webview', () => ({ WebView: React.forwardRef((props: NonNullable<typeof boundary.props>, ref) => {
    boundary.props = props;
    React.useImperativeHandle(ref, () => ({ postMessage: (data: string) => window.dispatchEvent(new MessageEvent('message', { data })) }));
    return React.createElement('WebView');
}) }));

import { CodeMirrorWebViewSurface } from './CodeMirrorWebViewSurface.native';

describe('native inline acceptance and document history', () => {
    let editor: view.EditorView | null = null;
    let cleanupListeners = () => {};
    let restoreGeometry = () => {};
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        document.body.innerHTML = '<div id="root"></div>';
        vi.stubGlobal('__CM6__', { ...state, ...view, ...commands, ...language, ...autocomplete, ...search, createCodeMirrorDecorations, createCodeMirrorInlineSuggestions });
        const geometryDescriptors = ['getClientRects', 'getBoundingClientRect'].map(name => [name, Object.getOwnPropertyDescriptor(Range.prototype, name)] as const);
        Object.defineProperties(Range.prototype, {
            getClientRects: { configurable: true, value: () => [] },
            getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
        });
        restoreGeometry = () => {
            for (const [name, descriptor] of geometryDescriptors) {
                if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
                else Reflect.deleteProperty(Range.prototype, name);
            }
        };
        Object.defineProperty(window, 'ReactNativeWebView', { configurable: true,
            value: { postMessage: (data: string) => boundary.props!.onMessage({ nativeEvent: { data } }) } });
    });
    afterEach(() => {
        editor?.destroy(); editor = null; cleanupListeners(); restoreGeometry();
        vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
        Reflect.deleteProperty(window, 'ReactNativeWebView'); boundary.props = null;
    });

    it('keeps preceding typing and each rapid partial acceptance as separate shared undo steps', async () => {
        const history = createEditorDocumentHistory();
        let text = 'a';
        const ref = React.createRef<CodeEditorHandle>();
        const screen = await renderScreen(<CodeMirrorWebViewSurface ref={ref} resetKey="inline-history" value={text} language="text" history={history}
            onChange={(next, change) => { if (!change?.history) history.record(text, next); text = next; }} />);
        try {
            const script = boundary.props!.source.html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
            if (!script) throw new Error('WebView source missing');
            const documentListeners = vi.spyOn(document, 'addEventListener');
            const windowListeners = vi.spyOn(window, 'addEventListener');
            cleanupListeners = () => {
                for (const [type, listener] of documentListeners.mock.calls) if (type === 'message') document.removeEventListener(type, listener);
                for (const [type, listener] of windowListeners.mock.calls) if (type === 'message') window.removeEventListener(type, listener);
            };
            await act(async () => { new Function(script)(); });
            const element = document.querySelector<HTMLElement>('.cm-editor');
            editor = element ? view.EditorView.findFromDOM(element) : null;
            if (!editor) throw new Error('Installed editor missing');
            const engine = editor;
            await act(async () => {
                engine.dispatch({ changes: { from: 1, insert: 'x' }, selection: { anchor: 2 } });
                ref.current!.inlineSuggestions!.setAcceptGuard(() => true);
                ref.current!.inlineSuggestions!.set({ id: 'one', text: ' café 😀', line: 1, character: 2 });
                ref.current!.runCommand('inlineSuggestAcceptWord');
                ref.current!.runCommand('inlineSuggestAcceptWord');
            });
            expect(ref.current!.getValue()).toBe('ax café 😀');
            await act(async () => { ref.current!.runCommand('undo'); });
            expect(ref.current!.getValue()).toBe('ax café');
            await act(async () => { ref.current!.runCommand('undo'); });
            expect(ref.current!.getValue()).toBe('ax');
            await act(async () => { ref.current!.runCommand('undo'); });
            expect(ref.current!.getValue()).toBe('a');
        } finally { await screen.unmount(); }
    });

    it('lands a changed same-file anchor through the real native bridge and incumbent CodeMirror document', async () => {
        const text = Array.from({ length: 56 }, (_, index) => `line ${index + 1}`).join('\n');
        function Scene({ line }: { line: number }) {
            const ref = React.useRef<CodeEditorHandle | null>(null);
            const [ready, setReady] = React.useState(false);
            useFileEditorNavigationAnchor({ filePath: 'a.ts', anchorKey: `a.ts:${line}`,
                anchor: { kind: 'fileLine', startLine: line }, source: 'file', active: true,
                editing: true, enteringEdit: false, editor: ready ? ref.current : null });
            return <CodeMirrorWebViewSurface ref={ref} resetKey="same-file" value={text} language="text"
                onChange={() => {}} onReady={() => setReady(true)} />;
        }
        const screen = await renderScreen(<Scene line={52} />);
        try {
            const script = boundary.props!.source.html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
            if (!script) throw new Error('WebView source missing');
            const documentListeners = vi.spyOn(document, 'addEventListener');
            const windowListeners = vi.spyOn(window, 'addEventListener');
            cleanupListeners = () => {
                for (const [type, listener] of documentListeners.mock.calls) if (type === 'message') document.removeEventListener(type, listener);
                for (const [type, listener] of windowListeners.mock.calls) if (type === 'message') window.removeEventListener(type, listener);
            };
            await act(async () => { new Function(script)(); });
            const element = document.querySelector<HTMLElement>('.cm-editor');
            editor = element ? view.EditorView.findFromDOM(element) : null;
            if (!editor) throw new Error('Installed editor missing');
            const incumbent = editor;
            // The engine reports ready after its first measured animation frame, as the native page requires.
            await act(async () => { await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())); });
            expect(incumbent.state.doc.lineAt(incumbent.state.selection.main.head).number).toBe(52);
            await screen.update(<Scene line={18} />);
            expect(view.EditorView.findFromDOM(element!)).toBe(incumbent);
            expect(editor.state.doc.toString()).toBe(text);
            expect(editor.state.doc.lineAt(editor.state.selection.main.head).number).toBe(18);
            await act(async () => { incumbent.dispatch({ selection: { anchor: incumbent.state.doc.line(30).from } }); });
            await screen.update(<Scene line={18} />);
            expect(editor.state.doc.lineAt(editor.state.selection.main.head).number).toBe(30);
        } finally { await screen.unmount(); }
    });
});
