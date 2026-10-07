import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { FileEditorPanel } from '@/components/workspaces/files/file/editor/FileEditorPanel';
import { SlideTransitionSwitch } from '@/components/ui/motion/SlideTransitionSwitch';
import { RichMarkdownEditorPanel } from './RichMarkdownEditorPanel';

// Vitest does not resolve the entrypoint's CommonJS native-suffix require.
// Select the real native entry as Metro would; no editor logic is replaced.
vi.mock('@/components/ui/code/editor/CodeEditor', async () => import('@/components/ui/code/editor/CodeEditor.native'));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// The editors and ref publishers stay real. Only the native WebView transport
// is replaced; it replies to each editor's requestDoc with its latest document.
const webViews = vi.hoisted(() => ({ pendingReady: new Set<() => void>() }));
vi.mock('react-native-webview', async () => {
    const ReactModule = await import('react');
    type Props = { onMessage: (event: { nativeEvent: { data: string } }) => void };
    const WebView = ReactModule.forwardRef(function WebView(props: Props, ref) {
        const doc = ReactModule.useRef('');
        ReactModule.useImperativeHandle(ref, () => ({
            postMessage(raw: string) {
                const envelope = JSON.parse(raw);
                if (envelope.type === 'init' || envelope.type === 'setDoc') doc.current = envelope.payload.doc;
                if (envelope.type === 'requestDoc') {
                    props.onMessage({ nativeEvent: { data: JSON.stringify({
                        v: 1,
                        type: 'docSnapshot',
                        payload: { requestId: envelope.payload.requestId, doc: `${doc.current}\nUnflushed edit` },
                    }) } });
                }
            },
        }), [props.onMessage]);
        ReactModule.useEffect(() => {
            const ready = () => props.onMessage({ nativeEvent: { data: JSON.stringify({ v: 1, type: 'ready', payload: { ok: true } }) } });
            webViews.pendingReady.add(ready);
            return () => { webViews.pendingReady.delete(ready); };
        }, []);
        return null;
    });
    return { WebView };
});

const animation = vi.hoisted(() => ({ complete: null as ((finished?: boolean) => void) | null }));
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return {
        ...createReanimatedModuleMock(),
        withSpring: <T,>(value: T, _config: unknown, callback?: (finished?: boolean) => void) => {
            animation.complete = callback ?? null;
            return value;
        },
    };
});

describe('markdown editor transition handle ownership', () => {
    it.each(['raw', 'rich'] as const)('keeps the incoming %s editor flushable after the outgoing editor unmounts', async (incoming) => {
        const editorRef: React.MutableRefObject<CodeEditorHandle | null> = { current: null };
        const onChange = vi.fn();
        const render = (mode: 'raw' | 'rich') => (
            <SlideTransitionSwitch contentKey={mode} direction={mode === 'rich' ? 'forward' : 'backward'} reducedMotion={false}>
                {mode === 'rich' ? (
                    <RichMarkdownEditorPanel resetKey={mode} editorRef={editorRef} value="# Doc" onChange={onChange} hideFooterToolbar />
                ) : (
                    <FileEditorPanel resetKey={mode} editorRef={editorRef} value="# Doc" onChange={onChange} theme={createThemeFixture()} language="markdown" />
                )}
            </SlideTransitionSwitch>
        );
        const screen = await renderScreen(render(incoming === 'raw' ? 'rich' : 'raw'));
        const deliverWebViewReady = async () => {
            await act(async () => {
                for (const ready of webViews.pendingReady) ready();
                webViews.pendingReady.clear();
            });
        };
        // Native ready events arrive after React's mount/reset effects finish.
        await deliverWebViewReady();
        await screen.update(render(incoming));
        await deliverWebViewReady();
        expect(editorRef.current?.getValue()).toBe('# Doc');
        await act(async () => { animation.complete?.(true); });

        expect(editorRef.current).not.toBeNull();
        await act(async () => { await editorRef.current?.flushPendingChange(); });
        expect(editorRef.current?.getValue()).toBe('# Doc\nUnflushed edit');

        await screen.unmount();
        expect(editorRef.current).toBeNull();
    });
});
