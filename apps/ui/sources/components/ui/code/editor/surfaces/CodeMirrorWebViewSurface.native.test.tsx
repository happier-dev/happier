import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const postMessageSpy = vi.fn();
let lastWebViewProps: any = null;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    PixelRatio: {
                        getFontScale: () => 1,
                    },
                }
    );
});

vi.mock('react-native-webview', () => ({
    WebView: React.forwardRef((props: any, ref: any) => {
        lastWebViewProps = props;
        if (ref) {
            ref.current = {
                postMessage: postMessageSpy,
            };
        }
        return React.createElement('WebView', props, props.children);
    }),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            dark: true,
            colors: {
                surfaceHighest: '#000',
                text: '#fff',
                divider: '#222',
            },
        },
    });
});

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 1,
}));

import { CodeMirrorWebViewSurface } from './CodeMirrorWebViewSurface.native';
import { renderScreen } from '@/dev/testkit';


function emitEnvelope(envelope: any) {
    if (!lastWebViewProps?.onMessage) throw new Error('WebView onMessage missing');
    lastWebViewProps.onMessage({ nativeEvent: { data: JSON.stringify(envelope) } });
}

function readRequestDocRequestIdFromPostedMessages(callStartIndex: number): string {
    for (const call of postMessageSpy.mock.calls.slice(callStartIndex)) {
        const raw = call?.[0];
        if (typeof raw !== 'string') continue;
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') continue;
            if (parsed.type !== 'requestDoc') continue;
            const payload = (parsed as any).payload;
            const requestId = payload && typeof payload.requestId === 'string' ? payload.requestId : '';
            if (requestId) return requestId;
        } catch {
            // ignore
        }
    }
    throw new Error('requestDoc envelope not found in posted messages');
}

function findPostedInitPayload(callStartIndex: number): any {
    for (const call of postMessageSpy.mock.calls.slice(callStartIndex)) {
        const raw = call?.[0];
        if (typeof raw !== 'string') continue;
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') continue;
            if (parsed.type !== 'init') continue;
            return (parsed as any).payload ?? null;
        } catch {
            // ignore
        }
    }
    return null;
}

describe('CodeMirrorWebViewSurface (native)', () => {
    it('exposes imperative handle and can flush current doc via request/response', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const ref = React.createRef<any>();

        await renderScreen(React.createElement(CodeMirrorWebViewSurface, {
                    ref,
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange: vi.fn(),
                    changeDebounceMs: 10,
                }));

        expect(ref.current).toBeTruthy();
        expect(typeof ref.current.getValue).toBe('function');
        expect(typeof ref.current.flushPendingChange).toBe('function');

        // Editor reports ready; host sends init.
        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        expect(postMessageSpy).toHaveBeenCalled();

        // Editor emits a debounced change update.
        emitEnvelope({ v: 1, type: 'docChanged', payload: { doc: 'hello world' } });
        expect(ref.current.getValue()).toBe('hello world');

        // Flush should request the doc snapshot and resolve once received.
        const callCountBeforeFlush = postMessageSpy.mock.calls.length;
        const flushPromise = ref.current.flushPendingChange();
        expect(postMessageSpy).toHaveBeenCalled();

        // Respond with a snapshot (requestId matching is handled by the implementation).
        const requestId = readRequestDocRequestIdFromPostedMessages(callCountBeforeFlush);
        emitEnvelope({ v: 1, type: 'docSnapshot', payload: { requestId, doc: 'final' } });

        await flushPromise;
        expect(ref.current.getValue()).toBe('final');
    });

    it('re-sends init when readOnly changes after ready', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        let tree: renderer.ReactTestRenderer;

        tree = (await renderScreen(React.createElement(CodeMirrorWebViewSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange: vi.fn(),
                    readOnly: false,
                }))).tree;

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        postMessageSpy.mockClear();

        await act(async () => {
            tree!.update(
                React.createElement(CodeMirrorWebViewSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange: vi.fn(),
                    readOnly: true,
                }),
            );
        });

        expect(findPostedInitPayload(0)).toEqual(expect.objectContaining({
            doc: 'hello',
            readOnly: true,
        }));
    });
});
