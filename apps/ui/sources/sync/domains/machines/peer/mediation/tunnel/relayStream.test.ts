import { describe, expect, it } from 'vitest';

import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    type PeerTcpTunnelFrameV1,
    type PeerTcpTunnelOpenV1,
    type PeerTcpTunnelRelayEnvelope,
} from '@happier-dev/protocol';

const open: PeerTcpTunnelOpenV1 = {
    v: 1,
    kind: 'open',
    tunnelId: 'tun_1',
    targetMachineId: 'machine_1',
    routeKind: 'server_relay',
    destination: { host: '127.0.0.1', port: 3000 },
};

const binaryOpen: PeerTcpTunnelOpenV1 = {
    ...open,
    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
};

describe('openPeerTcpTunnelRelayStream', () => {
    it('uses the generic PMS relay socket event for open, data, and inbound frames', async () => {
        const mod = await import('./relayStream').catch((error: unknown) => ({ importError: error }));
        expect(mod).toHaveProperty('openPeerTcpTunnelRelayStream');
        if (!('openPeerTcpTunnelRelayStream' in mod)) return;

        const sent: Array<{ event: string; envelope: PeerTcpTunnelRelayEnvelope }> = [];
        let listener: ((envelope: PeerTcpTunnelRelayEnvelope) => void) | null = null;
        const getListener = (): ((envelope: PeerTcpTunnelRelayEnvelope) => void) => {
            if (!listener) throw new Error('expected relay envelope listener');
            return listener;
        };
        const stream = await mod.openPeerTcpTunnelRelayStream({
            scopeUserId: 'user_1',
            open,
            send: (event, envelope) => sent.push({ event, envelope }),
            onEnvelope: (handler) => {
                listener = handler;
                return () => {
                    listener = null;
                };
            },
        });
        const seen: PeerTcpTunnelFrameV1[] = [];
        stream.onFrame((frame) => seen.push(frame));

        const frame: PeerTcpTunnelFrameV1 = {
            v: 1,
            kind: 'ack',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            nextSequence: 1,
            windowBytes: 1024,
        };
        await stream.sendFrame(frame);
        getListener()({
            v: 1,
            scopeUserId: 'user_1',
            sender: { kind: 'machine', machineId: 'machine_1' },
            recipient: { kind: 'user' },
            frame: {
                ...frame,
                direction: 'daemon_to_client',
            },
        });

        expect(sent).toEqual([
            {
                event: PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
                envelope: {
                    v: 1,
                    scopeUserId: 'user_1',
                    sender: { kind: 'user' },
                    recipient: { kind: 'machine', machineId: 'machine_1' },
                    frame: { v: 1, kind: 'open', open },
                },
            },
            {
                event: PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
                envelope: {
                    v: 1,
                    scopeUserId: 'user_1',
                    sender: { kind: 'user' },
                    recipient: { kind: 'machine', machineId: 'machine_1' },
                    frame,
                },
            },
        ]);
        expect(seen).toEqual([{ ...frame, direction: 'daemon_to_client' }]);
    });

    it('sends a terminal close frame before detaching the shared relay listener', async () => {
        const mod = await import('./relayStream').catch((error: unknown) => ({ importError: error }));
        expect(mod).toHaveProperty('openPeerTcpTunnelRelayStream');
        if (!('openPeerTcpTunnelRelayStream' in mod)) return;

        const sent: Array<{ event: string; envelope: PeerTcpTunnelRelayEnvelope }> = [];
        let detached = false;
        const stream = await mod.openPeerTcpTunnelRelayStream({
            scopeUserId: 'user_1',
            open,
            send: (event, envelope) => sent.push({ event, envelope }),
            onEnvelope: () => () => {
                detached = true;
            },
        });

        await stream.close();

        expect(sent.at(-1)).toEqual({
            event: PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
            envelope: {
                v: 1,
                scopeUserId: 'user_1',
                sender: { kind: 'user' },
                recipient: { kind: 'machine', machineId: 'machine_1' },
                frame: {
                    v: 1,
                    kind: 'close',
                    tunnelId: 'tun_1',
                    halfClose: false,
                    reasonCode: 'client_stream_closed',
                },
            },
        });
        expect(detached).toBe(true);
    });

    it('sends and receives binary_frame_v2 substream frames without changing the legacy frame channel', async () => {
        const mod = await import('./relayStream').catch((error: unknown) => ({ importError: error }));
        expect(mod).toHaveProperty('openPeerTcpTunnelRelayStream');
        if (!('openPeerTcpTunnelRelayStream' in mod)) return;

        const sent: Array<{ event: string; envelope: PeerTcpTunnelRelayEnvelope }> = [];
        let listener: ((envelope: PeerTcpTunnelRelayEnvelope) => void) | null = null;
        const requireListener = (): ((envelope: PeerTcpTunnelRelayEnvelope) => void) => {
            if (!listener) throw new Error('expected relay envelope listener');
            return listener;
        };
        const stream = await mod.openPeerTcpTunnelRelayStream({
            scopeUserId: 'user_1',
            open: binaryOpen,
            send: (event, envelope) => sent.push({ event, envelope }),
            onEnvelope: (handler) => {
                listener = handler;
                return () => {
                    listener = null;
                };
            },
        });
        const substreamStream = stream as typeof stream & Partial<{
            sendSubstreamFrame: (substreamId: string, frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>) => void;
            onSubstreamFrame: (
                handler: (event: Readonly<{ substreamId: string; frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }> }>) => void,
            ) => () => void;
        }>;
        expect(substreamStream.sendSubstreamFrame).toBeTypeOf('function');
        expect(substreamStream.onSubstreamFrame).toBeTypeOf('function');
        if (!substreamStream.sendSubstreamFrame || !substreamStream.onSubstreamFrame) return;
        const relayListener = requireListener();

        const seen: Array<{ substreamId: string; frame: PeerTcpTunnelFrameV1 }> = [];
        substreamStream.onSubstreamFrame((event) => seen.push(event));
        const frame: PeerTcpTunnelFrameV1 = {
            v: 1,
            kind: 'data',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            sequence: 0,
            payloadBase64: Buffer.from('hello').toString('base64'),
        };
        substreamStream.sendSubstreamFrame('sub_a', frame);

        const substreamEnvelope = sent.at(-1)?.envelope;
        expect(substreamEnvelope?.v).toBe(2);
        const decoded = decodePeerTcpTunnelBinaryFrameV2({
            frame: (substreamEnvelope as { frame: Uint8Array }).frame,
            maxHeaderBytes: 1024,
            maxPayloadBytes: 1024,
        });
        expect(decoded.ok ? decoded.header.substreamId : null).toBe('sub_a');

        relayListener({
            v: 2,
            scopeUserId: 'user_1',
            sender: { kind: 'machine', machineId: 'machine_1' },
            recipient: { kind: 'user' },
            encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            frame: encodePeerTcpTunnelBinaryFrameV2({
                header: {
                    version: 2,
                    kind: 'data',
                    tunnelId: 'tun_1',
                    substreamId: 'sub_a',
                    direction: 'daemon_to_client',
                    sequence: 0,
                    payloadLength: 5,
                },
                payload: Buffer.from('world'),
            }),
        });

        expect(seen).toEqual([{
            substreamId: 'sub_a',
            frame: {
                v: 1,
                kind: 'data',
                tunnelId: 'tun_1',
                direction: 'daemon_to_client',
                sequence: 0,
                payloadBase64: Buffer.from('world').toString('base64'),
            },
        }]);
    });
});
