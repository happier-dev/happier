import {
    decodePeerTcpTunnelBinaryFrameV2} from '@happier-dev/protocol/machines/peer/mediation/tunnel/v2';
import {
    encodeBase64} from '@happier-dev/protocol/crypto/base64';
import {
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2} from '@happier-dev/protocol/machines/peer/mediation/tunnel/encoding';
import {
    type PeerTcpTunnelOpenResponseV1,
    type PeerTcpTunnelOpenV1,
} from '@happier-dev/protocol/machines/peer/mediation/tunnel/v1';
import type { PeerTcpTunnelFrame } from '@happier-dev/peer-transport/duplexFrames';
import { describe, expect, it, vi } from 'vitest';

import type { PeerTcpTunnelClientStream } from './client';

type DynamicModule = Record<string, unknown>;
type TestStream = Readonly<{
    sendFrame: (frame: PeerTcpTunnelFrame) => Promise<void> | void;
    onFrame: (handler: (frame: PeerTcpTunnelFrame) => void) => () => void;
    close: () => Promise<void> | void;
}>;
type TestWebSocket = {
    url: string;
    binaryType?: string;
    sent: unknown[];
    onopen?: () => void;
    onmessage?: (event: { data: unknown }) => void;
    onclose?: () => void;
    onerror?: (event: unknown) => void;
    send: (payload: unknown) => void;
    close: () => void;
};

async function loadModule(path: string): Promise<DynamicModule> {
    return import(path).catch((importError: unknown) => ({ importError }));
}

function createWebSocketFixture() {
    let socket: TestWebSocket | null = null;
    const getSocket = (): TestWebSocket => {
        if (!socket) throw new Error('expected websocket fixture');
        return socket;
    };
    const WebSocketCtor = vi.fn((url: string) => {
        socket = {
            url,
            sent: [],
            send(payload: unknown) {
                this.sent.push(payload);
            },
            close: vi.fn(),
        };
        return getSocket();
    });
    return { getSocket, WebSocketCtor };
}

const open: PeerTcpTunnelOpenV1 = {
    v: 1,
    kind: 'open',
    tunnelId: 'tun_1',
    targetMachineId: 'machine_1',
    routeKind: 'loopback_direct',
    destination: { host: '127.0.0.1', port: 3000 },
};

const jsonResponse: PeerTcpTunnelOpenResponseV1 = {
    v: 1,
    tunnelId: 'tun_1',
    streamPath: '/peer-mediation/v1/tunnel/stream',
    encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    initialWindowBytes: 1024,
    maxFrameBytes: 1024,
};

const binaryResponse: PeerTcpTunnelOpenResponseV1 = {
    ...jsonResponse,
    encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
};

describe('openPeerTcpTunnelLoopbackStream', () => {
    it('keeps native authentication out of the URL and returns cleanup custody on peer closure', async () => {
        const mod = await loadModule('./loopbackStream');
        const openStream = mod.openPeerTcpTunnelLoopbackStream;
        if (typeof openStream !== 'function') throw new Error('canonical stream owner missing');
        const { getSocket, WebSocketCtor } = createWebSocketFixture();
        let retired = 0;
        const opening = openStream({
            endpointUrl: 'http://127.0.0.1:48127', open, response: binaryResponse, WebSocketCtor,
            webSocketProtocols: ['happier.iroh.cap.private'],
            onRetired: () => { retired += 1; },
        }) as Promise<TestStream>;
        getSocket().onopen?.();
        const stream = await opening;
        expect(WebSocketCtor).toHaveBeenCalledWith(
            'ws://127.0.0.1:48127/peer-mediation/v1/tunnel/stream', ['happier.iroh.cap.private'],
        );
        getSocket().onclose?.();
        await stream.close();
        expect(retired).toBe(1);
        expect(() => stream.sendFrame({ v: 1, kind: 'data', tunnelId: 'tun_1', direction: 'client_to_daemon', sequence: 0, payload: new Uint8Array([1]) }))
            .toThrow(expect.objectContaining({ code: 'peer_tunnel_stream_closed' }));
    });
    it('closes exactly once when opening times out and ignores a late open event', async () => {
        const mod = await loadModule('./loopbackStream');
        const openLoopbackStream = mod.openPeerTcpTunnelLoopbackStream;
        expect(openLoopbackStream).toBeTypeOf('function');
        if (typeof openLoopbackStream !== 'function') return;

        vi.useFakeTimers();
        try {
            const { getSocket, WebSocketCtor } = createWebSocketFixture();
            const streamPromise = openLoopbackStream({
                endpointUrl: 'http://127.0.0.1:1234/base',
                open,
                response: jsonResponse,
                WebSocketCtor,
                openTimeoutMs: 10,
            }) as Promise<TestStream>;
            const lateOpen = getSocket().onopen;
            const rejection = expect(streamPromise).rejects.toThrow('open timed out');

            await vi.advanceTimersByTimeAsync(10);
            await rejection;
            expect(getSocket().close).toHaveBeenCalledOnce();

            lateOpen?.();
            expect(getSocket().close).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('closes an opening or active websocket exactly once when its caller aborts', async () => {
        const mod = await loadModule('./loopbackStream');
        const openLoopbackStream = mod.openPeerTcpTunnelLoopbackStream;
        expect(openLoopbackStream).toBeTypeOf('function');
        if (typeof openLoopbackStream !== 'function') return;

        const openingFixture = createWebSocketFixture();
        const openingAbort = new AbortController();
        const opening = openLoopbackStream({
            endpointUrl: 'http://127.0.0.1:1234/base',
            open,
            response: jsonResponse,
            WebSocketCtor: openingFixture.WebSocketCtor,
            signal: openingAbort.signal,
        }) as Promise<TestStream>;
        openingAbort.abort();
        await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
        expect(openingFixture.getSocket().close).toHaveBeenCalledOnce();

        const activeFixture = createWebSocketFixture();
        const activeAbort = new AbortController();
        const active = openLoopbackStream({
            endpointUrl: 'http://127.0.0.1:1234/base',
            open,
            response: jsonResponse,
            WebSocketCtor: activeFixture.WebSocketCtor,
            signal: activeAbort.signal,
        }) as Promise<TestStream>;
        activeFixture.getSocket().onopen?.();
        const stream = await active;
        activeAbort.abort();
        await stream.close();
        expect(activeFixture.getSocket().close).toHaveBeenCalledOnce();
    });

    it('rejects application sends after closure instead of reporting them delivered', async () => {
        const mod = await loadModule('./loopbackStream');
        const openLoopbackStream = mod.openPeerTcpTunnelLoopbackStream;
        expect(openLoopbackStream).toBeTypeOf('function');
        if (typeof openLoopbackStream !== 'function') return;

        const { getSocket, WebSocketCtor } = createWebSocketFixture();
        const streamPromise = openLoopbackStream({
            endpointUrl: 'http://127.0.0.1:1234/base',
            open,
            response: binaryResponse,
            WebSocketCtor,
        }) as Promise<PeerTcpTunnelClientStream>;
        getSocket().onopen?.();
        const stream = await streamPromise;

        await stream.close();
        const sentAfterClose = getSocket().sent.length;

        const dataFrame: PeerTcpTunnelFrame = {
            v: 1,
            kind: 'data',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            sequence: 0,
            payload: new Uint8Array([1]),
        };
        expect(() => stream.sendFrame(dataFrame))
            .toThrow(expect.objectContaining({ code: 'peer_tunnel_stream_closed' }));
        expect(() => stream.sendSubstreamOpen?.('application.stream-1'))
            .toThrow(expect.objectContaining({ code: 'peer_tunnel_stream_closed' }));
        expect(() => stream.sendSubstreamDataFrame?.('application.stream-1', {
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            sequence: 0,
            payloadBytes: new Uint8Array([1]),
        })).toThrow(expect.objectContaining({ code: 'peer_tunnel_stream_closed' }));
        expect(() => stream.sendSubstreamFrame?.('application.stream-1', dataFrame))
            .toThrow(expect.objectContaining({ code: 'peer_tunnel_stream_closed' }));

        expect(getSocket().sent).toHaveLength(sentAfterClose);
    });

    it('does not publish a closed stream when abort wins after open settlement', async () => {
        const mod = await loadModule('./loopbackStream');
        const openLoopbackStream = mod.openPeerTcpTunnelLoopbackStream;
        expect(openLoopbackStream).toBeTypeOf('function');
        if (typeof openLoopbackStream !== 'function') return;

        const fixture = createWebSocketFixture();
        const controller = new AbortController();
        const opening = openLoopbackStream({
            endpointUrl: 'http://127.0.0.1:1234/base',
            open,
            response: jsonResponse,
            WebSocketCtor: fixture.WebSocketCtor,
            signal: controller.signal,
        }) as Promise<TestStream>;

        fixture.getSocket().onopen?.();
        controller.abort();

        await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
        expect(fixture.getSocket().close).toHaveBeenCalledOnce();
        expect(fixture.getSocket().onmessage).toBeUndefined();
    });

    it('sends binary_frame_v2 loopback data as Uint8Array bytes without JSON/base64 on the websocket payload', async () => {
        const mod = await loadModule('./loopbackStream');
        const openLoopbackStream = mod.openPeerTcpTunnelLoopbackStream;
        expect(openLoopbackStream).toBeTypeOf('function');
        if (typeof openLoopbackStream !== 'function') return;

        const { getSocket, WebSocketCtor } = createWebSocketFixture();
        const streamPromise = openLoopbackStream({
            endpointUrl: 'http://127.0.0.1:1234/base',
            open,
            response: binaryResponse,
            WebSocketCtor,
        }) as Promise<TestStream>;
        getSocket().onopen?.();
        const stream = await streamPromise;
        const pcmBytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
        const payloadBase64 = encodeBase64(pcmBytes);

        await stream.sendFrame({
            v: 1,
            kind: 'data',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            sequence: 7,
            payload: pcmBytes,
        });

        const sent = getSocket().sent[0];
        expect(sent).toBeInstanceOf(Uint8Array);
        expect(typeof sent).not.toBe('string');
        const decoded = decodePeerTcpTunnelBinaryFrameV2({
            frame: sent as Uint8Array,
            maxHeaderBytes: 1024,
            maxPayloadBytes: 1024,
        });
        expect(decoded).toMatchObject({
            ok: true,
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_1',
                direction: 'client_to_daemon',
                sequence: 7,
                payloadLength: pcmBytes.byteLength,
            },
        });
        expect(decoded.ok ? [...decoded.payload] : []).toEqual([...pcmBytes]);
        expect(decoded.ok ? decoded.header : {}).not.toHaveProperty('payloadBase64');
        expect(new TextDecoder().decode(sent as Uint8Array)).not.toContain(payloadBase64);
    });
});
