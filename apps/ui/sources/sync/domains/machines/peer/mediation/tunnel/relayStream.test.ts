import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2} from '@happier-dev/protocol/machines/peer/mediation/tunnel/v2';
import {
    encodeBase64} from '@happier-dev/protocol/crypto/base64';
import {
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2} from '@happier-dev/protocol/machines/peer/mediation/tunnel/encoding';
import {
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    PeerTcpTunnelRelayBinaryEnvelopeV2Schema,
    PeerTcpTunnelRelayEnvelopeSchema,
    type PeerTcpTunnelRelayEnvelope,
} from '@happier-dev/protocol/machines/peer/mediation/tunnel/relay';
import {
    type PeerTcpTunnelOpenV1} from '@happier-dev/protocol/machines/peer/mediation/tunnel/v1';
import type { PeerTcpTunnelFrame } from '@happier-dev/peer-transport/duplexFrames';
import { describe, expect, it, vi } from 'vitest';

type DynamicModule = Record<string, unknown>;
type TestStream = Readonly<{
    sendFrame: (frame: PeerTcpTunnelFrame) => Promise<void> | void;
    onFrame: (handler: (frame: PeerTcpTunnelFrame) => void) => () => void;
    onSubstreamFrame?: (handler: (event: Readonly<{
        substreamId: string;
        frame: PeerTcpTunnelFrame;
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

function binaryEnvelopeKind(envelope: PeerTcpTunnelRelayEnvelope): string | null {
    if (envelope.v !== 2) return null;
    const decoded = decodePeerTcpTunnelBinaryFrameV2({
        frame: envelope.frame,
        maxHeaderBytes: 1024 * 1024,
        maxPayloadBytes: 1024 * 1024,
    });
    return decoded.ok ? decoded.header.kind : null;
}

describe('openPeerTcpTunnelRelayStream', () => {
    it.each(['daemon-v1', 'server-v1', 'daemon-v2'] as const)('retires %s tunnel failures and replays them to a late response waiter', async source => {
        const { openPeerTcpTunnelRelayStream } = await import('./relayStream');
        let receive!: (envelope: PeerTcpTunnelRelayEnvelope) => void;
        const detach = vi.fn();
        const stream = await openPeerTcpTunnelRelayStream({
            scopeUserId: 'user_1', relaySocketId: 'relay_socket_1', open: binaryOpen,
            send: () => undefined,
            onEnvelope: handler => { receive = handler; return detach; },
        });
        const frame = { v: 1 as const, kind: 'abort' as const, tunnelId: open.tunnelId, reasonCode: 'relay_authorization_invalid' };
        const envelope = PeerTcpTunnelRelayEnvelopeSchema.parse(source === 'daemon-v2' ? {
            v: 2, scopeUserId: 'user_1', sender: { kind: 'machine', machineId: 'machine_1' },
            recipient: { kind: 'user', socketId: 'relay_socket_1' }, encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            frame: encodePeerTcpTunnelBinaryFrameV2({ header: {
                version: 2, kind: 'abort', tunnelId: open.tunnelId, reasonCode: frame.reasonCode, payloadLength: 0,
            } }),
        } : {
            v: 1, scopeUserId: 'user_1', frame,
            sender: source === 'server-v1' ? { kind: 'user', socketId: 'relay_socket_1' } : { kind: 'machine', machineId: 'machine_1' },
            recipient: source === 'server-v1' ? { kind: 'machine', machineId: 'machine_1' } : { kind: 'user', socketId: 'relay_socket_1' },
        });
        const seen: PeerTcpTunnelFrame[] = [];
        stream.onFrame(value => seen.push(value));
        // Another tab, Account or Machine must not terminate this carrier.
        receive({ ...envelope, scopeUserId: 'other-account' });
        receive({ ...envelope, sender: { kind: 'machine', machineId: 'other-machine' } });
        if (source === 'server-v1') receive({ ...envelope, sender: { kind: 'user', socketId: 'other-socket' } });
        expect(seen).toEqual([]);
        receive(envelope);
        expect(seen).toEqual([frame]);
        const late: PeerTcpTunnelFrame[] = [];
        stream.onFrame(value => late.push(value));
        expect(late).toEqual([frame]);
        expect(detach).toHaveBeenCalledOnce();
        expect(() => stream.sendFrame({ v: 1, kind: 'close', tunnelId: open.tunnelId, halfClose: false, reasonCode: 'closed' }))
            .toThrow(expect.objectContaining({ code: 'peer_tunnel_stream_closed' }));
        await stream.close();
    });

    it('retires its exact subscription when the initial OPEN send fails', async () => {
        const mod = await loadModule('./relayStream');
        const openRelayStream = mod.openPeerTcpTunnelRelayStream;
        expect(openRelayStream).toBeTypeOf('function');
        if (typeof openRelayStream !== 'function') return;

        const detach = vi.fn(() => {
            throw new Error('subscription detach failed');
        });
        const transportFailure = Object.assign(new Error('relay transport unavailable'), {
            code: 'relay_transport_unavailable',
        });

        await expect(openRelayStream({
            scopeUserId: 'user_1',
            relaySocketId: 'relay_socket_1',
            open,
            send: () => {
                throw transportFailure;
            },
            onEnvelope: () => detach,
        })).rejects.toBe(transportFailure);

        expect(detach).toHaveBeenCalledOnce();
    });

    it('retires the exact relay subscription and emits one close when its caller aborts', async () => {
        const mod = await loadModule('./relayStream');
        const openRelayStream = mod.openPeerTcpTunnelRelayStream;
        expect(openRelayStream).toBeTypeOf('function');
        if (typeof openRelayStream !== 'function') return;

        const sent: PeerTcpTunnelRelayEnvelope[] = [];
        const detach = vi.fn();
        const controller = new AbortController();
        const stream = await openRelayStream({
            scopeUserId: 'user_1',
            relaySocketId: 'relay_socket_1',
            open,
            signal: controller.signal,
            send: (_event: string, envelope: PeerTcpTunnelRelayEnvelope) => sent.push(envelope),
            onEnvelope: () => detach,
        }) as TestStream;

        controller.abort();
        await stream.close();

        expect(detach).toHaveBeenCalledOnce();
        expect(sent.filter((envelope) => binaryEnvelopeKind(envelope) === 'close')).toHaveLength(1);
        expect(() => stream.sendFrame({
            v: 1,
            kind: 'ack',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            nextSequence: 1,
            windowBytes: 1,
        })).toThrow(expect.objectContaining({ code: 'peer_tunnel_stream_closed' }));

        const preAborted = new AbortController();
        preAborted.abort();
        await expect(openRelayStream({
            scopeUserId: 'user_1',
            relaySocketId: 'relay_socket_1',
            open,
            signal: preAborted.signal,
            send: () => undefined,
            onEnvelope: () => () => undefined,
        })).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('does not publish a closed stream when abort wins during the initial OPEN send', async () => {
        const mod = await loadModule('./relayStream');
        const openRelayStream = mod.openPeerTcpTunnelRelayStream;
        expect(openRelayStream).toBeTypeOf('function');
        if (typeof openRelayStream !== 'function') return;

        const controller = new AbortController();
        const detach = vi.fn();
        const sent: PeerTcpTunnelRelayEnvelope[] = [];
        const opening = openRelayStream({
            scopeUserId: 'user_1',
            relaySocketId: 'relay_socket_1',
            open,
            signal: controller.signal,
            send: (_event: string, envelope: PeerTcpTunnelRelayEnvelope) => {
                sent.push(envelope);
                if (envelope.v === 1 && envelope.frame.kind === 'open') controller.abort();
                if (binaryEnvelopeKind(envelope) === 'close') throw new Error('relay close unavailable');
            },
            onEnvelope: () => detach,
        });

        await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
        expect(detach).toHaveBeenCalledOnce();
        expect(sent.filter((envelope) => binaryEnvelopeKind(envelope) === 'close')).toHaveLength(1);
    });

    it('preserves an exact CLOSE transport failure when subscription retirement also fails', async () => {
        const mod = await loadModule('./relayStream');
        const openRelayStream = mod.openPeerTcpTunnelRelayStream;
        expect(openRelayStream).toBeTypeOf('function');
        if (typeof openRelayStream !== 'function') return;

        const closeFailure = Object.assign(new Error('relay close unavailable'), {
            code: 'relay_close_unavailable',
        });
        const detach = vi.fn(() => {
            throw new Error('subscription detach failed');
        });
        const stream = await openRelayStream({
            scopeUserId: 'user_1',
            relaySocketId: 'relay_socket_1',
            open,
            send: (_event: string, envelope: PeerTcpTunnelRelayEnvelope) => {
                if (binaryEnvelopeKind(envelope) === 'close') throw closeFailure;
            },
            onEnvelope: () => detach,
        }) as TestStream;

        expect(() => stream.close()).toThrow(closeFailure);
        expect(detach).toHaveBeenCalledOnce();
        // Local retirement is final even when both transport and detach report
        // failures; a repeated close cannot touch the shared socket/subscription.
        expect(() => stream.close()).not.toThrow();
        expect(detach).toHaveBeenCalledOnce();
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
            payload: pcmBytes,
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
        // An opaque stream-key ciphertext (or PCM): the relay reader only forwards bytes.
        const encryptedPayload = new Uint8Array(28).fill(2);
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
