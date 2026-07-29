import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const postMessageSpy = vi.fn();
const requestFocusSpy = vi.fn();
let lastWebViewProps: any = null;
let webViewRenderCount = 0;

function requireWebViewSurfaceHandle(ref: React.RefObject<XtermWebViewSurfaceHandle | null>): XtermWebViewSurfaceHandle {
    if (!ref.current) {
        throw new Error('xterm WebView surface handle missing');
    }
    return ref.current;
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            View: 'View',
                        }
    );
});

vi.mock('react-native-webview', () => ({
    WebView: React.forwardRef((props: any, ref: any) => {
        webViewRenderCount += 1;
        lastWebViewProps = props;
        if (ref) {
            ref.current = {
                postMessage: postMessageSpy,
                requestFocus: requestFocusSpy,
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
                surface: '#000',
                text: '#fff',
                surfaceSelected: '#222',
                divider: '#333',
            },
        },
    });
});

import { encodeChunkedEnvelope } from '@/components/ui/webview/bridge/chunkedBridge';

import { XtermWebViewSurface } from './XtermWebViewSurface.native';
import type { XtermWebViewSurfaceHandle } from './XtermWebViewSurface.native';
import { renderScreen } from '@/dev/testkit';


function emitEnvelope(envelope: any) {
    if (!lastWebViewProps?.onMessage) throw new Error('WebView onMessage missing');
    lastWebViewProps.onMessage({ nativeEvent: { data: JSON.stringify(envelope) } });
}

function findPostedEnvelopeByType(type: string): any {
    for (const call of postMessageSpy.mock.calls) {
        const raw = call?.[0];
        if (typeof raw !== 'string') continue;
        try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.type === type) return parsed;
        } catch {
            // ignore
        }
    }
    return null;
}

function findPostedEnvelopePayloadByType(type: string): any {
    return findPostedEnvelopeByType(type)?.payload ?? null;
}

describe('XtermWebViewSurface (native)', () => {
    it('buffers writes until ready and forwards input/resize', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;
        webViewRenderCount = 0;

        const onInput = vi.fn();
        const onResize = vi.fn();
        const onReady = vi.fn();
        const ref = React.createRef<XtermWebViewSurfaceHandle>();

        await renderScreen(React.createElement(XtermWebViewSurface, {
                    ref,
                    fontSize: 12,
                    lineHeightPx: 18,
                    onInput,
                    onResize,
                    onReady,
                    bridgeMaxChunkBytes: 64_000,
                }));

        const handle = requireWebViewSurfaceHandle(ref);
        expect(typeof handle.write).toBe('function');
        expect(typeof handle.clear).toBe('function');

        // Buffer write before terminal is ready.
        handle.write('hello');
        expect(findPostedEnvelopeByType('write')).toBeNull();

        // Terminal reports ready; host should flush pending writes.
        emitEnvelope({ v: 1, type: 'ready', payload: { cols: 80, rows: 24 } });
        expect(onReady).toHaveBeenCalledWith(80, 24);

        expect(findPostedEnvelopeByType('write')).toEqual(
            expect.objectContaining({
                v: 1,
                type: 'write',
                payload: { data: 'hello' },
            }),
        );

        emitEnvelope({ v: 1, type: 'resize', payload: { cols: 90, rows: 30 } });
        expect(onResize).toHaveBeenCalledWith(90, 30);

        emitEnvelope({ v: 1, type: 'input', payload: { data: 'ls' } });
        expect(onInput).toHaveBeenCalledWith('ls');
    });

    it('opts into native keyboard focus and requests WebView focus for ready and focus transitions', async () => {
        postMessageSpy.mockClear();
        requestFocusSpy.mockClear();
        lastWebViewProps = null;
        webViewRenderCount = 0;

        const ref = React.createRef<XtermWebViewSurfaceHandle>();

        await renderScreen(React.createElement(XtermWebViewSurface, {
                    ref,
                    fontSize: 12,
                    lineHeightPx: 18,
                    onInput: vi.fn(),
                    onResize: vi.fn(),
                    onReady: vi.fn(),
                    bridgeMaxChunkBytes: 64_000,
                }));

        expect(lastWebViewProps?.keyboardDisplayRequiresUserAction).toBe(false);

        requireWebViewSurfaceHandle(ref).focus();
        expect(requestFocusSpy).toHaveBeenCalledTimes(1);
        expect(findPostedEnvelopeByType('focus')).toBeNull();

        emitEnvelope({ v: 1, type: 'ready', payload: { cols: 80, rows: 24 } });
        expect(requestFocusSpy).toHaveBeenCalledTimes(2);
        postMessageSpy.mockClear();
        requestFocusSpy.mockClear();

        requireWebViewSurfaceHandle(ref).focus();
        expect(requestFocusSpy).toHaveBeenCalledTimes(1);
        expect(findPostedEnvelopeByType('focus')).toEqual(
            expect.objectContaining({
                v: 1,
                type: 'focus',
            }),
        );
    });

    it('buffers byte writes until ready and posts base64 byte payloads', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;
        webViewRenderCount = 0;

        const onInput = vi.fn();
        const onResize = vi.fn();
        const onReady = vi.fn();
        const ref = React.createRef<XtermWebViewSurfaceHandle>();

        await renderScreen(React.createElement(XtermWebViewSurface, {
                    ref,
                    fontSize: 12,
                    lineHeightPx: 18,
                    onInput,
                    onResize,
                    onReady,
                    bridgeMaxChunkBytes: 64_000,
                }));

        const handle = requireWebViewSurfaceHandle(ref);
        expect(typeof handle.writeBytes).toBe('function');

        handle.writeBytes({
            terminalId: 'native-terminal',
            seq: 3,
            byteOffset: 9,
            bytes: new Uint8Array([0x00, 0xff, 0x41, 0xc3, 0x28]),
        });
        expect(findPostedEnvelopeByType('writeBytes')).toBeNull();

        emitEnvelope({ v: 1, type: 'ready', payload: { cols: 80, rows: 24 } });

        const payload = findPostedEnvelopePayloadByType('writeBytes');
        expect(payload).toEqual(
            expect.objectContaining({
                terminalId: 'native-terminal',
                seq: 3,
                byteOffset: 9,
                byteLength: 5,
                dataBase64: 'AP9Bwyg=',
            }),
        );
    });

    it('measures pending text writes in UTF-8 bytes before accepting them', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;
        webViewRenderCount = 0;

        const ref = React.createRef<XtermWebViewSurfaceHandle>();

        await renderScreen(React.createElement(XtermWebViewSurface, {
            ref,
            fontSize: 12,
            lineHeightPx: 18,
            onInput: vi.fn(),
            onResize: vi.fn(),
            onReady: vi.fn(),
            bridgeMaxChunkBytes: 64_000,
            maxPendingWriteBytes: 3,
        }));

        const handle = requireWebViewSurfaceHandle(ref);

        expect(handle.write('éé')).toBe(false);
        expect(handle.write('é')).toBe(true);
        expect(handle.write('a')).toBe(true);
        expect(handle.write('b')).toBe(false);

        emitEnvelope({ v: 1, type: 'ready', payload: { cols: 80, rows: 24 } });

        const writeEnvelopes = postMessageSpy.mock.calls
            .map((call) => {
                try {
                    return JSON.parse(call[0]);
                } catch {
                    return null;
                }
            })
            .filter((message) => message?.type === 'write');

        expect(writeEnvelopes.map((message) => message.payload.data)).toEqual(['é', 'a']);
    });

    it('reports native WebView byte write completion events from the embedded xterm parser callback', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;
        webViewRenderCount = 0;

        const onInput = vi.fn();
        const onResize = vi.fn();
        const onReady = vi.fn();
        const onWriteComplete = vi.fn();

        await renderScreen(React.createElement(XtermWebViewSurface, {
                    fontSize: 12,
                    lineHeightPx: 18,
                    onInput,
                    onResize,
                    onReady,
                    onWriteComplete,
                    bridgeMaxChunkBytes: 64_000,
                }));

        emitEnvelope({
            v: 1,
            type: 'writeComplete',
            payload: {
                terminalId: 'native-terminal',
                seq: 4,
                byteOffset: 20,
                byteLength: 6,
                ackedByteOffset: 26,
            },
        });

        expect(onWriteComplete).toHaveBeenCalledWith({
            terminalId: 'native-terminal',
            seq: 4,
            byteOffset: 20,
            byteLength: 6,
            ackedByteOffset: 26,
        });
    });

    it('ignores byte write completion events with inconsistent acknowledged offsets', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;
        webViewRenderCount = 0;

        const onInput = vi.fn();
        const onResize = vi.fn();
        const onReady = vi.fn();
        const onWriteComplete = vi.fn();

        await renderScreen(React.createElement(XtermWebViewSurface, {
                    fontSize: 12,
                    lineHeightPx: 18,
                    onInput,
                    onResize,
                    onReady,
                    onWriteComplete,
                    bridgeMaxChunkBytes: 64_000,
                }));

        emitEnvelope({
            v: 1,
            type: 'writeComplete',
            payload: {
                terminalId: 'native-terminal',
                seq: 4,
                byteOffset: 20,
                byteLength: 6,
                ackedByteOffset: 99,
            },
        });

        expect(onWriteComplete).not.toHaveBeenCalled();
    });

    it('decodes chunked incoming messages', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;
        webViewRenderCount = 0;

        const onInput = vi.fn();
        const onResize = vi.fn();
        const onReady = vi.fn();

        await renderScreen(React.createElement(XtermWebViewSurface, {
                    fontSize: 12,
                    lineHeightPx: 18,
                    onInput,
                    onResize,
                    onReady,
                    bridgeMaxChunkBytes: 1_000,
                }));

        const chunks = encodeChunkedEnvelope({
            envelope: { v: 1, type: 'input', payload: { data: 'chunked' } },
            maxChunkBytes: 30,
            messageId: 'm-input',
        });

        for (const msg of chunks) {
            emitEnvelope(msg);
        }

        expect(onInput).toHaveBeenCalledWith('chunked');
    });

    it('re-buffers writes after the webview html changes until ready fires again', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;
        webViewRenderCount = 0;

        const onInput = vi.fn();
        const onResize = vi.fn();
        const onReady = vi.fn();
        const ref = React.createRef<XtermWebViewSurfaceHandle>();

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(XtermWebViewSurface, {
                    ref,
                    fontSize: 12,
                    lineHeightPx: 18,
                    onInput,
                    onResize,
                    onReady,
                    bridgeMaxChunkBytes: 64_000,
                }))).tree;

        emitEnvelope({ v: 1, type: 'ready', payload: { cols: 80, rows: 24 } });
        postMessageSpy.mockClear();

        await act(async () => {
            tree.update(
                React.createElement(XtermWebViewSurface, {
                    ref,
                    fontSize: 14,
                    lineHeightPx: 21,
                    onInput,
                    onResize,
                    onReady,
                    bridgeMaxChunkBytes: 64_000,
                }),
            );
        });

        requireWebViewSurfaceHandle(ref).write('after-reload');
        expect(findPostedEnvelopeByType('write')).toBeNull();

        emitEnvelope({ v: 1, type: 'ready', payload: { cols: 80, rows: 24 } });

        expect(findPostedEnvelopeByType('write')).toEqual(
            expect.objectContaining({
                v: 1,
                type: 'write',
                payload: { data: 'after-reload' },
            }),
        );
    });

    it('reloads the WebView once when the embedded terminal reports a boot error', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;
        webViewRenderCount = 0;

        const onInput = vi.fn();
        const onResize = vi.fn();
        const onReady = vi.fn();
        const ref = React.createRef<XtermWebViewSurfaceHandle>();

        await renderScreen(React.createElement(XtermWebViewSurface, {
            ref,
            fontSize: 12,
            lineHeightPx: 18,
            onInput,
            onResize,
            onReady,
            bridgeMaxChunkBytes: 64_000,
        }));

        const initialRenderCount = webViewRenderCount;
        requireWebViewSurfaceHandle(ref).write('queued while booting');
        await act(async () => {
            emitEnvelope({ v: 1, type: 'bootError', payload: { code: 'terminal_boot_failed' } });
        });

        expect(webViewRenderCount).toBeGreaterThan(initialRenderCount);
        expect(onReady).not.toHaveBeenCalled();

        emitEnvelope({ v: 1, type: 'ready', payload: { cols: 80, rows: 24 } });

        expect(onReady).toHaveBeenCalledWith(80, 24);
        expect(findPostedEnvelopeByType('write')).toEqual(
            expect.objectContaining({
                v: 1,
                type: 'write',
                payload: { data: 'queued while booting' },
            }),
        );
    });

    it('forwards embedded xterm link activations to the host link policy handler', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;
        webViewRenderCount = 0;

        const onInput = vi.fn();
        const onResize = vi.fn();
        const onReady = vi.fn();
        const onLink = vi.fn();

        await renderScreen(React.createElement(XtermWebViewSurface, {
            fontSize: 12,
            lineHeightPx: 18,
            onInput,
            onResize,
            onReady,
            onLink,
            bridgeMaxChunkBytes: 64_000,
        }));

        emitEnvelope({ v: 1, type: 'link', payload: { url: 'https://example.com/docs' } });

        expect(onLink).toHaveBeenCalledWith('https://example.com/docs');
    });
});
