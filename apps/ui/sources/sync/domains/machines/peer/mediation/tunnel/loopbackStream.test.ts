import { describe, expect, it, vi } from 'vitest';

import type { PeerTcpTunnelFrameV1, PeerTcpTunnelOpenResponseV1, PeerTcpTunnelOpenV1 } from '@happier-dev/protocol';

const open: PeerTcpTunnelOpenV1 = {
    v: 1,
    kind: 'open',
    tunnelId: 'tun_1',
    targetMachineId: 'machine_1',
    routeKind: 'loopback_direct',
    destination: { host: '127.0.0.1', port: 3000 },
};

const response: PeerTcpTunnelOpenResponseV1 = {
    v: 1,
    tunnelId: 'tun_1',
    streamPath: '/peer-mediation/v1/tunnel/stream',
    encoding: 'json_base64_v1',
    initialWindowBytes: 1024,
    maxFrameBytes: 1024,
};

describe('openPeerTcpTunnelLoopbackStream', () => {
    it('opens the daemon loopback websocket and relays V1 frames', async () => {
        const mod = await import('./loopbackStream').catch((error: unknown) => ({ importError: error }));
        expect(mod).toHaveProperty('openPeerTcpTunnelLoopbackStream');
        if (!('openPeerTcpTunnelLoopbackStream' in mod)) return;

        type TestWebSocket = {
            url: string;
            sent: unknown[];
            onopen?: () => void;
            onmessage?: (event: { data: unknown }) => void;
            onclose?: () => void;
            send: (payload: unknown) => void;
            close: () => void;
        };
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

        const streamPromise = mod.openPeerTcpTunnelLoopbackStream({
            endpointUrl: 'http://127.0.0.1:1234/base',
            open,
            response,
            WebSocketCtor,
        });
        getSocket().onopen?.();
        const stream = await streamPromise;
        const seen: PeerTcpTunnelFrameV1[] = [];
        stream.onFrame((frame) => seen.push(frame));

        const frame: PeerTcpTunnelFrameV1 = { v: 1, kind: 'ack', tunnelId: 'tun_1', direction: 'client_to_daemon', nextSequence: 5, windowBytes: 1024 };
        await stream.sendFrame(frame);
        getSocket().onmessage?.({ data: JSON.stringify(frame) });

        expect(getSocket().url).toBe('ws://127.0.0.1:1234/peer-mediation/v1/tunnel/stream');
        expect(getSocket().sent).toEqual([JSON.stringify(frame)]);
        expect(seen).toEqual([frame]);
    });

    it('drops malformed inbound JSON frames before dispatching handlers', async () => {
        const mod = await import('./loopbackStream').catch((error: unknown) => ({ importError: error }));
        expect(mod).toHaveProperty('openPeerTcpTunnelLoopbackStream');
        if (!('openPeerTcpTunnelLoopbackStream' in mod)) return;

        type TestWebSocket = {
            onopen?: () => void;
            onmessage?: (event: { data: unknown }) => void;
            send: (payload: unknown) => void;
            close: () => void;
        };
        let socket: TestWebSocket | null = null;
        const getSocket = (): TestWebSocket => {
            if (!socket) throw new Error('expected websocket fixture');
            return socket;
        };
        const WebSocketCtor = vi.fn((url: string) => {
            void url;
            socket = {
                send: vi.fn(),
                close: vi.fn(),
            };
            return getSocket();
        });

        const streamPromise = mod.openPeerTcpTunnelLoopbackStream({
            endpointUrl: 'http://127.0.0.1:1234',
            open,
            response,
            WebSocketCtor,
        });
        getSocket().onopen?.();
        const stream = await streamPromise;
        const seen: PeerTcpTunnelFrameV1[] = [];
        stream.onFrame((frame) => seen.push(frame));

        getSocket().onmessage?.({
            data: JSON.stringify({
                v: 1,
                kind: 'ack',
                tunnelId: 'tun_1',
            }),
        });
        const validFrame: PeerTcpTunnelFrameV1 = {
            v: 1,
            kind: 'ack',
            tunnelId: 'tun_1',
            direction: 'daemon_to_client',
            nextSequence: 5,
            windowBytes: 1024,
        };
        getSocket().onmessage?.({ data: JSON.stringify(validFrame) });

        expect(seen).toEqual([validFrame]);
    });
});
