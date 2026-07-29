import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodeBase64,
    encodePeerApplicationEncryptedFrameV1,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    PeerTcpTunnelRelayBinaryEnvelopeV2Schema,
    type PeerTcpTunnelFrameV1,
    type PeerTcpTunnelOpenV1,
    type PeerTcpTunnelRelayEnvelope,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

type DynamicModule = Record<string, unknown>;
type TestStream = Readonly<{
    sendFrame: (frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>) => Promise<void> | void;
    onFrame: (handler: (frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>) => void) => () => void;
    onSubstreamFrame?: (handler: (event: Readonly<{
        substreamId: string;
        frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;
    }>) => void) => () => void;
    close: () => Promise<void> | void;
}>;

async function loadModule(path: string): Promise<DynamicModule> {
    return import(path).catch((importError: unknown) => ({ importError }));
}

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
    it('uses the generic relay socket event for explicit JSON/base64 fallback frames', async () => {
        const mod = await loadModule('./relayStream');
        const openRelayStream = mod.openPeerTcpTunnelRelayStream;
        expect(openRelayStream).toBeTypeOf('function');
        if (typeof openRelayStream !== 'function') return;

        const sent: Array<{ event: string; envelope: PeerTcpTunnelRelayEnvelope }> = [];
        let listener: ((envelope: PeerTcpTunnelRelayEnvelope) => void) | null = null;
        const getListener = (): ((envelope: PeerTcpTunnelRelayEnvelope) => void) => {
            if (!listener) throw new Error('expected relay envelope listener');
            return listener;
        };
        const stream = await openRelayStream({
            scopeUserId: 'user_1',
            relaySocketId: 'relay_socket_1',
            open,
            send: (event: string, envelope: PeerTcpTunnelRelayEnvelope) => sent.push({ event, envelope }),
            onEnvelope: (handler: (envelope: PeerTcpTunnelRelayEnvelope) => void) => {
                listener = handler;
                return () => {
                    listener = null;
                };
            },
        }) as TestStream;
        const seen: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>[] = [];
        stream.onFrame((frame) => seen.push(frame));

        const frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }> = {
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
                    sender: { kind: 'user', socketId: 'relay_socket_1' },
                    recipient: { kind: 'machine', machineId: 'machine_1' },
                    frame: { v: 1, kind: 'open', open },
                },
            },
            {
                event: PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
                envelope: {
                    v: 1,
                    scopeUserId: 'user_1',
                    sender: { kind: 'user', socketId: 'relay_socket_1' },
                    recipient: { kind: 'machine', machineId: 'machine_1' },
                    frame,
                },
            },
        ]);
        expect(seen).toEqual([{ ...frame, direction: 'daemon_to_client' }]);
    });

    it('sends relay data as PeerTcpTunnelRelayBinaryEnvelopeV2 with a Uint8Array binary_frame_v2 payload', async () => {
        const mod = await loadModule('./relayStream');
        const openRelayStream = mod.openPeerTcpTunnelRelayStream;
        expect(openRelayStream).toBeTypeOf('function');
        if (typeof openRelayStream !== 'function') return;

        const sent: Array<{ event: string; envelope: PeerTcpTunnelRelayEnvelope }> = [];
        const stream = await openRelayStream({
            scopeUserId: 'user_1',
            relaySocketId: 'relay_socket_1',
            open: binaryOpen,
            send: (event: string, envelope: PeerTcpTunnelRelayEnvelope) => sent.push({ event, envelope }),
            onEnvelope: () => () => {},
        }) as TestStream;
        const pcmBytes = new Uint8Array([3, 4, 5, 250, 251, 252]);
        const payloadBase64 = encodeBase64(pcmBytes);

        await stream.sendFrame({
            v: 1,
            kind: 'data',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            sequence: 9,
            payloadBase64,
        });

        const binaryEnvelope = sent.at(-1)?.envelope;
        expect(PeerTcpTunnelRelayBinaryEnvelopeV2Schema.safeParse(binaryEnvelope).success).toBe(true);
        expect(binaryEnvelope).toMatchObject({
            v: 2,
            scopeUserId: 'user_1',
            sender: { kind: 'user', socketId: 'relay_socket_1' },
            recipient: { kind: 'machine', machineId: 'machine_1' },
            encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        });
        expect((binaryEnvelope as { frame?: unknown }).frame).toBeInstanceOf(Uint8Array);
        const decoded = decodePeerTcpTunnelBinaryFrameV2({
            frame: (binaryEnvelope as { frame: Uint8Array }).frame,
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
                sequence: 9,
                payloadLength: pcmBytes.byteLength,
            },
        });
        expect(decoded.ok ? [...decoded.payload] : []).toEqual([...pcmBytes]);
        expect(decoded.ok ? decoded.header : {}).not.toHaveProperty('payloadBase64');
        expect(new TextDecoder().decode((binaryEnvelope as { frame: Uint8Array }).frame)).not.toContain(payloadBase64);
    });

    it('normalizes a browser ArrayBuffer relay response before substream correlation', async () => {
        const mod = await loadModule('./relayStream');
        const openRelayStream = mod.openPeerTcpTunnelRelayStream;
        expect(openRelayStream).toBeTypeOf('function');
        if (typeof openRelayStream !== 'function') return;

        let listener: ((envelope: PeerTcpTunnelRelayEnvelope) => void) | null = null;
        const getListener = (): ((envelope: PeerTcpTunnelRelayEnvelope) => void) => {
            if (!listener) throw new Error('expected relay envelope listener');
            return listener;
        };
        const stream = await openRelayStream({
            scopeUserId: 'user_1',
            relaySocketId: 'relay_socket_1',
            open: binaryOpen,
            send: () => {},
            onEnvelope: (handler: (envelope: PeerTcpTunnelRelayEnvelope) => void) => {
                listener = handler;
                return () => { listener = null; };
            },
        }) as TestStream;
        const seen: unknown[] = [];
        stream.onSubstreamFrame?.((event) => seen.push(event));
        const encryptedPayload = encodePeerApplicationEncryptedFrameV1({
            v: 1,
            kind: 'install',
            nonceBase64Url: encodeBase64(new Uint8Array(12).fill(1), 'base64url'),
            ciphertextBase64Url: encodeBase64(new Uint8Array(16).fill(2), 'base64url'),
            encryptedDataKeyEnvelopeBase64Url: encodeBase64(new Uint8Array([3]), 'base64url'),
        });
        const binaryFrame = encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_1',
                substreamId: 'daemon.voiceInference.stt.stream-1.1',
                direction: 'daemon_to_client',
                sequence: 0,
                payloadLength: encryptedPayload.byteLength,
            },
            payload: encryptedPayload,
        });
        const browserArrayBuffer = binaryFrame.buffer.slice(
            binaryFrame.byteOffset,
            binaryFrame.byteOffset + binaryFrame.byteLength,
        );
        getListener()({
            v: 2,
            scopeUserId: 'user_1',
            sender: { kind: 'machine', machineId: 'machine_1' },
            recipient: { kind: 'user' },
            encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            frame: browserArrayBuffer,
        } as unknown as PeerTcpTunnelRelayEnvelope);

        expect(seen).toEqual([
            expect.objectContaining({
                substreamId: 'daemon.voiceInference.stt.stream-1.1',
                frame: expect.objectContaining({
                    kind: 'data',
                    direction: 'daemon_to_client',
                    sequence: 0,
                }),
            }),
        ]);
    });
});
