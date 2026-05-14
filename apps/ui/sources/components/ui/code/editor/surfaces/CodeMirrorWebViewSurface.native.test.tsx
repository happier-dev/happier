import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const postMessageSpy = vi.fn();
let lastWebViewProps: any = null;
const unistylesState = vi.hoisted(() => ({
    themeOverride: {
        dark: true,
        colors: {
            syntax: {
                keyword: '#ff79c6',
            },
        },
    },
}));

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
    const { createThemeFixture } = await import('@/dev/testkit/fixtures/themeFixtures');
    const base = await createUnistylesMock();
    const baseRt = base.useUnistyles().rt;
    return {
        ...base,
        useUnistyles: () => ({
            theme: createThemeFixture(unistylesState.themeOverride),
            rt: baseRt,
        }),
    };
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
    beforeEach(() => {
        unistylesState.themeOverride = {
            dark: true,
            colors: {
                syntax: {
                    keyword: '#ff79c6',
                },
            },
        };
    });

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

    it('does not re-send init when accepting a doc change from the editor', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const onChange = vi.fn();
        let tree: renderer.ReactTestRenderer;

        tree = (await renderScreen(React.createElement(CodeMirrorWebViewSurface, {
                    resetKey: '1',
                    value: 'test',
                    language: 'markdown',
                    onChange,
                    readOnly: false,
                }))).tree;

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        postMessageSpy.mockClear();

        emitEnvelope({ v: 1, type: 'docChanged', payload: { doc: 'test 123' } });
        expect(onChange).toHaveBeenCalledWith('test 123');

        await act(async () => {
            tree!.update(
                React.createElement(CodeMirrorWebViewSurface, {
                    resetKey: '1',
                    value: 'test 123',
                    language: 'markdown',
                    onChange,
                    readOnly: false,
                }),
            );
        });

        expect(findPostedInitPayload(0)).toBeNull();
    });

    it('rebuilds WebView HTML when syntax theme colors change', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        let tree: renderer.ReactTestRenderer;

        tree = (await renderScreen(React.createElement(CodeMirrorWebViewSurface, {
                    resetKey: '1',
                    value: 'const message = \"hello\";',
                    language: 'typescript',
                    onChange: vi.fn(),
                }))).tree;

        const firstHtml = lastWebViewProps?.source?.html;
        expect(firstHtml).toContain('#ff79c6');

        unistylesState.themeOverride = {
            dark: true,
            colors: {
                syntax: {
                    keyword: '#00ffaa',
                },
            },
        };

        await act(async () => {
            tree!.update(
                React.createElement(CodeMirrorWebViewSurface, {
                    resetKey: '1',
                    value: 'const message = \"hello\";',
                    language: 'typescript',
                    onChange: vi.fn(),
                }),
            );
        });

        expect(lastWebViewProps?.source?.html).toContain('#00ffaa');
        expect(lastWebViewProps?.source?.html).not.toBe(firstHtml);
    });
});
