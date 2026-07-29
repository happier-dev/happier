import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodeBase64,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    type PeerTcpTunnelFrameV1,
    type PeerTcpTunnelOpenResponseV1,
    type PeerTcpTunnelOpenV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

type DynamicModule = Record<string, unknown>;
type TestStream = Readonly<{
    sendFrame: (frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>) => Promise<void> | void;
    onFrame: (handler: (frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>) => void) => () => void;
    close: () => Promise<void> | void;
}>;
type TestWebSocket = {
    url: string;
    binaryType?: string;
    sent: unknown[];
    onopen?: () => void;
    onmessage?: (event: { data: unknown }) => void;
    onclose?: () => void;
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
    encoding: 'json_base64_v1',
    initialWindowBytes: 1024,
    maxFrameBytes: 1024,
};

const binaryResponse: PeerTcpTunnelOpenResponseV1 = {
    ...jsonResponse,
    encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
};

describe('openPeerTcpTunnelLoopbackStream', () => {
    it('opens the daemon loopback websocket and relays explicit JSON/base64 fallback frames', async () => {
        const mod = await loadModule('./loopbackStream');
        const openLoopbackStream = mod.openPeerTcpTunnelLoopbackStream;
        expect(openLoopbackStream).toBeTypeOf('function');
        if (typeof openLoopbackStream !== 'function') return;

        const { getSocket, WebSocketCtor } = createWebSocketFixture();
        const streamPromise = openLoopbackStream({
            endpointUrl: 'http://127.0.0.1:1234/base',
            open,
            response: jsonResponse,
            WebSocketCtor,
        }) as Promise<TestStream>;
        getSocket().onopen?.();
        const stream = await streamPromise;
        const seen: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>[] = [];
        stream.onFrame((frame) => seen.push(frame));

        const frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }> = {
            v: 1,
            kind: 'ack',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            nextSequence: 5,
            windowBytes: 1024,
        };
        await stream.sendFrame(frame);
        getSocket().onmessage?.({ data: JSON.stringify(frame) });

        expect(getSocket().url).toBe('ws://127.0.0.1:1234/peer-mediation/v1/tunnel/stream');
        expect(getSocket().binaryType).toBe('arraybuffer');
        expect(getSocket().sent).toEqual([JSON.stringify(frame)]);
        expect(seen).toEqual([frame]);
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
            payloadBase64,
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
