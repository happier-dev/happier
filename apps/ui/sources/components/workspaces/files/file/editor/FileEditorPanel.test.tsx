import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createThemeFixture, renderScreen } from '@/dev/testkit';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import type { FileFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import { FindBar } from '@/components/ui/find/FindBar';
import { KeyboardShortcutProvider, useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock, createFocusableTextInputMock } = await import('@/dev/testkit/mocks/reactNative');
    const TextInput = Object.assign(createFocusableTextInputMock(() => {}), { State: { currentlyFocusedInput: () => null } });
    return createReactNativeWebMock({ TextInput, AccessibilityInfo: { announceForAccessibility() {} },
        Platform: { OS: 'ios', select: <T,>(choices: { ios?: T; native?: T; default?: T }) => choices.ios ?? choices.native ?? choices.default } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// Vitest does not implement Metro's platform-file resolution. Project the actual native adapter;
// the editor handle, lifecycle publication, bridge, registry and FindBar remain real.
vi.mock('@/components/ui/code/editor/CodeEditor', async () => import('@/components/ui/code/editor/CodeEditor.native'));

const webView = vi.hoisted(() => ({ onMessage: null as null | ((event: { nativeEvent: { data: string } }) => void), post: vi.fn() }));
vi.mock('react-native-webview', async () => {
    const React = await import('react');
    return { WebView: React.forwardRef((props: { onMessage: typeof webView.onMessage }, ref) => {
        webView.onMessage = props.onMessage;
        React.useImperativeHandle(ref, () => ({ postMessage: webView.post, requestFocus() {} }));
        return React.createElement('WebView');
    }) };
});

import { FileEditorPanel } from './FileEditorPanel';

describe('file editor Find host', () => {
    it('keeps an inactive seed, then queues the correct file into the real native facet and renders live status once', async () => {
        webView.post.mockClear();
        const editorRef = { current: null as CodeEditorHandle | null };
        const consume = vi.fn();
        const seed: FileFindSeed = { query: '\\n', options: { matchCase: true, regex: false },
            target: { kind: 'file', path: 'a.ts', anchor: { kind: 'fileLine', startLine: 2 } } };
        let open: ReturnType<typeof useFindSurfaceRuntime>['open'] = () => false;
        function Probe() { open = useFindSurfaceRuntime().open; return null; }
        const element = (active: boolean, filePath: string) => <KeyboardShortcutProvider handlers={{}}>
            <PluginSurfaceFocusEligibilityProvider active={true}>
                <Probe />
                <FileEditorPanel theme={createThemeFixture()} editorRef={editorRef} resetKey="a.ts"
                    surfaceId="file:editor" filePath={filePath} active={active}
                    value={'first\\n\r\nsecond\\n'} language="typescript" onChange={() => {}}
                    findSeed={seed} onFindSeedConsumed={consume} />
            </PluginSurfaceFocusEligibilityProvider>
        </KeyboardShortcutProvider>;
        const screen = await renderScreen(element(false, 'a.ts'));
        expect(consume).not.toHaveBeenCalled();
        expect(open('file:editor')).toBe(false);
        await act(async () => { screen.tree.update(element(true, 'other.ts')); });
        expect(consume).not.toHaveBeenCalled();
        await act(async () => { screen.tree.update(element(true, 'a.ts')); });
        expect(consume).toHaveBeenCalledTimes(1);
        expect(editorRef.current!.find!.isOpen()).toBe(true);
        const emit = (type: string, payload: object) => webView.onMessage!({ nativeEvent: { data: JSON.stringify({ v: 1, type, payload }) } });
        await act(async () => { emit('ready', { ok: true }); });
        expect(webView.post.mock.calls.map(([raw]) => JSON.parse(String(raw))).at(-1)).toEqual({
            v: 1, type: 'find.set', payload: { query: '\\n', options: seed.options, target: { line: 2 } },
        });
        await act(async () => { emit('find.status', { query: seed.query, options: seed.options,
            status: { kind: 'results', total: 2, current: 2, coverage: 'complete' } }); });
        const bars = screen.tree.root.findAllByType(FindBar);
        expect(bars).toHaveLength(1);
        expect(bars[0].props.status).toMatchObject({ total: 2, current: 2 });
        await act(async () => { bars[0].props.onClose(); });
        expect(screen.tree.root.findAllByType(FindBar)).toHaveLength(0);
        expect(editorRef.current!.find!.isOpen()).toBe(false);
    });
});
