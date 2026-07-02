import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { encodeChunkedEnvelope, type WebViewBridgeEnvelopeV1 } from './chunkedBridge';
import {
    useWebViewBridgeMessenger,
    type UseWebViewBridgeMessengerParams,
} from './useWebViewBridgeMessenger';

type FakeWebView = { postMessage: (message: string) => void };

function attachFakeWebView(ref: { current: any }): { postMessageSpy: ReturnType<typeof vi.fn> } {
    const postMessageSpy = vi.fn();
    const fake: FakeWebView = { postMessage: postMessageSpy };
    ref.current = fake;
    return { postMessageSpy };
}

function makeMessageEvent(message: unknown): any {
    return { nativeEvent: { data: JSON.stringify(message) } };
}

describe('useWebViewBridgeMessenger', () => {
    it('fires onReady exactly once on the ready handshake', async () => {
        const onReady = vi.fn();
        const { getCurrent } = await renderHook<ReturnType<typeof useWebViewBridgeMessenger>, UseWebViewBridgeMessengerParams>(
            (props) => useWebViewBridgeMessenger(props),
            { initialProps: { onReady } },
        );

        const messenger = getCurrent();
        expect(messenger.isReady()).toBe(false);

        messenger.onMessage(makeMessageEvent({ v: 1, type: 'ready', payload: { ok: true } }));
        messenger.onMessage(makeMessageEvent({ v: 1, type: 'ready', payload: { ok: true } }));

        expect(onReady).toHaveBeenCalledTimes(1);
        expect(messenger.isReady()).toBe(true);
    });

    it('forwards every decoded envelope to onEnvelope (including ready)', async () => {
        const onEnvelope = vi.fn();
        const { getCurrent } = await renderHook<ReturnType<typeof useWebViewBridgeMessenger>, UseWebViewBridgeMessengerParams>(
            (props) => useWebViewBridgeMessenger(props),
            { initialProps: { onEnvelope } },
        );

        const messenger = getCurrent();
        messenger.onMessage(makeMessageEvent({ v: 1, type: 'ready', payload: { ok: true } }));
        messenger.onMessage(makeMessageEvent({ v: 1, type: 'docChanged', payload: { doc: 'hello' } }));

        expect(onEnvelope).toHaveBeenCalledTimes(2);
        expect(onEnvelope).toHaveBeenNthCalledWith(1, { v: 1, type: 'ready', payload: { ok: true } });
        expect(onEnvelope).toHaveBeenNthCalledWith(2, { v: 1, type: 'docChanged', payload: { doc: 'hello' } });
    });

    it('encodes and posts an envelope through the attached WebView ref', async () => {
        const { getCurrent } = await renderHook(() => useWebViewBridgeMessenger({}));
        const messenger = getCurrent();
        const { postMessageSpy } = attachFakeWebView(messenger.webViewRef);

        const envelope: WebViewBridgeEnvelopeV1 = { v: 1, type: 'init', payload: { doc: 'seed' } };
        const posted = messenger.postEnvelope(envelope);

        expect(posted).toBe(true);
        expect(postMessageSpy).toHaveBeenCalledTimes(1);
        expect(JSON.parse(postMessageSpy.mock.calls[0]![0] as string)).toEqual(envelope);
    });

    it('round-trips a posted envelope back through onEnvelope (decode of the wire form)', async () => {
        const onEnvelope = vi.fn();
        const { getCurrent } = await renderHook(() => useWebViewBridgeMessenger({ onEnvelope }));
        const messenger = getCurrent();
        const { postMessageSpy } = attachFakeWebView(messenger.webViewRef);

        const envelope: WebViewBridgeEnvelopeV1 = {
            v: 1,
            type: 'command',
            payload: { name: 'toggleBold' },
        };
        messenger.postEnvelope(envelope);

        // Simulate the editor echoing the exact wire message back to the host.
        const wire = JSON.parse(postMessageSpy.mock.calls[0]![0] as string);
        messenger.onMessage(makeMessageEvent(wire));

        expect(onEnvelope).toHaveBeenCalledWith(envelope);
    });

    it('reassembles chunked inbound messages before dispatching once', async () => {
        const onEnvelope = vi.fn();
        const { getCurrent } = await renderHook(() => useWebViewBridgeMessenger({ onEnvelope }));
        const messenger = getCurrent();

        const big = 'z'.repeat(200_000);
        const envelope: WebViewBridgeEnvelopeV1 = { v: 1, type: 'docSnapshot', payload: { doc: big, requestId: 'r1' } };
        const chunks = encodeChunkedEnvelope({ envelope, maxChunkBytes: 25_000, messageId: 'm-inbound' });
        expect(chunks.length).toBeGreaterThan(2);

        for (const chunk of chunks) {
            messenger.onMessage(makeMessageEvent(chunk));
        }

        expect(onEnvelope).toHaveBeenCalledTimes(1);
        expect(onEnvelope).toHaveBeenCalledWith(envelope);
    });

    it('returns false and does not throw when posting before the WebView is attached', async () => {
        const { getCurrent } = await renderHook(() => useWebViewBridgeMessenger({}));
        const messenger = getCurrent();

        expect(messenger.postEnvelope({ v: 1, type: 'init', payload: {} })).toBe(false);
    });

    it('ignores malformed inbound payloads without dispatching', async () => {
        const onEnvelope = vi.fn();
        const { getCurrent } = await renderHook(() => useWebViewBridgeMessenger({ onEnvelope }));
        const messenger = getCurrent();

        messenger.onMessage({ nativeEvent: { data: 'not json' } } as any);

        expect(onEnvelope).not.toHaveBeenCalled();
    });
});
