import { PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/encoding';
import { PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, PeerTcpTunnelRelayEnvelopeSchema, type PeerTcpTunnelRelayEnvelope } from '@happier-dev/protocol/machines/peer/mediation/tunnel/relay';
import type { PeerTcpTunnelFrameV1, PeerTcpTunnelOpenV1 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/v1';
import {
    decodePeerTcpTunnelBinaryFrameForSession,
    decodePeerTcpTunnelBinarySubstreamFrame,
    encodePeerTcpTunnelBinaryFrameForSession,
    encodePeerTcpTunnelBinaryFrameForSubstream,
    encodePeerTcpTunnelBinarySubstreamOpen,
    type PeerTcpTunnelFrame,
} from '@happier-dev/peer-transport/duplexFrames';

import type { PeerTcpTunnelClientStream } from './client';
import { assertPeerTcpTunnelStreamWritable } from './streamClosed';

type SendPeerTcpTunnelRelayEnvelope = (
    event: typeof PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    envelope: PeerTcpTunnelRelayEnvelope,
) => void;

function userToMachineEnvelope(input: Readonly<{
    scopeUserId: string;
    relaySocketId: string;
    open: PeerTcpTunnelOpenV1;
    frame: PeerTcpTunnelFrameV1;
}>): PeerTcpTunnelRelayEnvelope {
    return {
        v: 1,
        scopeUserId: input.scopeUserId,
        sender: { kind: 'user', socketId: input.relaySocketId },
        recipient: { kind: 'machine', machineId: input.open.targetMachineId },
        frame: input.frame,
    };
}

export async function openPeerTcpTunnelRelayStream(input: Readonly<{
    scopeUserId: string;
    relaySocketId: string;
    open: PeerTcpTunnelOpenV1;
    send: SendPeerTcpTunnelRelayEnvelope;
    onEnvelope: (handler: (envelope: PeerTcpTunnelRelayEnvelope) => void) => () => void;
    signal?: AbortSignal | null;
}>): Promise<PeerTcpTunnelClientStream> {
    if (input.signal?.aborted) {
        throw Object.assign(new Error('Peer TCP tunnel relay stream open aborted'), { name: 'AbortError' });
    }
    const encoding = input.open.selectedEncoding ?? PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2;
    const handlers = new Set<(frame: PeerTcpTunnelFrame) => void>();
    const substreamHandlers = new Set<(event: Readonly<{
        substreamId: string;
        frame: PeerTcpTunnelFrame;
    }>) => void>();
    let closed = false;
    const abort = (): void => {
        try {
            close();
        } catch {
            // Caller cancellation remains authoritative after exact local retirement.
        }
    };

    function sendRelayFrame(frame: PeerTcpTunnelFrame): void {
        const envelope: PeerTcpTunnelRelayEnvelope = {
                v: 2,
                scopeUserId: input.scopeUserId,
                sender: { kind: 'user', socketId: input.relaySocketId },
                recipient: { kind: 'machine', machineId: input.open.targetMachineId },
                encoding,
                frame: encodePeerTcpTunnelBinaryFrameForSession(frame),
            };
        input.send(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope);
    }

    function sendRelayBinaryFrame(frame: Uint8Array): void {
        input.send(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            v: 2,
            scopeUserId: input.scopeUserId,
            sender: { kind: 'user', socketId: input.relaySocketId },
            recipient: { kind: 'machine', machineId: input.open.targetMachineId },
            encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            frame,
        });
    }

    const detach = input.onEnvelope((raw) => {
        if (closed) return;
        const parsed = PeerTcpTunnelRelayEnvelopeSchema.safeParse(raw);
        if (!parsed.success || parsed.data.scopeUserId !== input.scopeUserId) return;
        const envelope = parsed.data;
        if (envelope.sender.kind !== 'machine' || envelope.sender.machineId !== input.open.targetMachineId) return;
        if (envelope.recipient.kind !== 'user') return;

        if (envelope.v === 2) {
            const decodedSubstream = decodePeerTcpTunnelBinarySubstreamFrame({
                frame: envelope.frame,
                maxBinaryHeaderBytes: input.open.relayAuthorization?.payload.maxFrameBytes ?? Number.MAX_SAFE_INTEGER,
                maxRawPayloadBytes: input.open.relayAuthorization?.payload.maxFrameBytes ?? Number.MAX_SAFE_INTEGER,
            });
            if (decodedSubstream.ok && decodedSubstream.frame.tunnelId === input.open.tunnelId) {
                for (const handler of substreamHandlers) handler({
                    substreamId: decodedSubstream.substreamId,
                    frame: decodedSubstream.frame,
                });
                return;
            }
        }

        if (envelope.v !== 2) return;
        const decoded = decodePeerTcpTunnelBinaryFrameForSession({
                frame: envelope.frame,
                maxBinaryHeaderBytes: input.open.relayAuthorization?.payload.maxFrameBytes ?? Number.MAX_SAFE_INTEGER,
                maxRawPayloadBytes: input.open.relayAuthorization?.payload.maxFrameBytes ?? Number.MAX_SAFE_INTEGER,
            });
        if (!decoded?.ok || !decoded.frame || decoded.frame.tunnelId !== input.open.tunnelId) return;
        for (const handler of handlers) handler(decoded.frame);
    });

    try {
        input.send(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, userToMachineEnvelope({
            scopeUserId: input.scopeUserId,
            relaySocketId: input.relaySocketId,
            open: input.open,
            frame: { v: 1, kind: 'open', open: input.open },
        }));
    } catch (error) {
        // Subscription installation precedes OPEN so an immediate daemon reply cannot be
        // missed. If the transport rejects that OPEN, retire the exact subscription before
        // returning the original typed transport failure to the caller.
        closed = true;
        handlers.clear();
        substreamHandlers.clear();
        try {
            detach();
        } catch {
            // The OPEN transport failure remains the operation's deciding result.
        }
        throw error;
    }

    input.signal?.addEventListener('abort', abort, { once: true });

    function close(): void {
        if (closed) return;
        closed = true;
        input.signal?.removeEventListener('abort', abort);
        let sendFailed = false;
        let sendError: unknown;
        try {
            sendRelayFrame({
                v: 1,
                kind: 'close',
                tunnelId: input.open.tunnelId,
                halfClose: false,
                reasonCode: 'client_stream_closed',
            });
        } catch (error) {
            sendFailed = true;
            sendError = error;
        }
        handlers.clear();
        substreamHandlers.clear();
        try {
            detach();
        } catch (detachError) {
            // If CLOSE transport itself failed, that exact operation failure is
            // authoritative. Subscription retirement remains best-effort and
            // must not replace it with a cleanup error.
            if (!sendFailed) throw detachError;
        }
        if (sendFailed) throw sendError;
    }

    if (input.signal?.aborted) {
        try {
            close();
        } catch {
            // Preserve the caller's exact AbortError rather than a best-effort CLOSE send failure.
        }
        throw Object.assign(new Error('Peer TCP tunnel relay stream open aborted'), { name: 'AbortError' });
    }

    return {
        sendFrame: (frame) => {
            assertPeerTcpTunnelStreamWritable(closed);
            sendRelayFrame(frame);
        },
        onFrame: (handler) => {
            if (closed) return () => undefined;
            handlers.add(handler);
            return () => {
                handlers.delete(handler);
            };
        },
        sendSubstreamOpen: (substreamId) => {
            assertPeerTcpTunnelStreamWritable(closed);
            sendRelayBinaryFrame(encodePeerTcpTunnelBinarySubstreamOpen({
                tunnelId: input.open.tunnelId,
                substreamId,
            }));
        },
        sendSubstreamDataFrame: (substreamId, frame) => {
            assertPeerTcpTunnelStreamWritable(closed);
            sendRelayBinaryFrame(encodePeerTcpTunnelBinaryFrameForSubstream({ substreamId, frame: {
                v: 1,
                kind: 'data',
                tunnelId: frame.tunnelId,
                direction: frame.direction,
                sequence: frame.sequence,
                payload: frame.payloadBytes,
            } }));
        },
        sendSubstreamFrame: (substreamId, frame) => {
            assertPeerTcpTunnelStreamWritable(closed);
            sendRelayBinaryFrame(encodePeerTcpTunnelBinaryFrameForSubstream({
                substreamId,
                frame,
            }));
        },
        onSubstreamFrame: (handler) => {
            if (closed) return () => undefined;
            substreamHandlers.add(handler);
            return () => {
                substreamHandlers.delete(handler);
            };
        },
        close: () => {
            close();
        },
    };
}
