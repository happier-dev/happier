import {
    PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
    PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES,
    decodePeerTcpTunnelBinaryFrameV2,
    PeerTcpTunnelRelayEnvelopeSchema,
    verifyPeerTcpTunnelRelayAuthorizationV1,
    type PeerTcpTunnelEncoding,
    type PeerTcpTunnelFrameV1,
    type PeerTcpTunnelRelayAuthorizationTrustRootV1,
    type PeerTcpTunnelRelayBinaryEnvelopeV2,
    type PeerTcpTunnelRelayEnvelope,
    type PeerTcpTunnelRelayEnvelopeV1,
} from '@happier-dev/protocol';

import {
    createPeerTcpTunnelSubstreamMuxSession,
    createPeerTcpTunnelStreamSession,
    decodePeerTcpTunnelBinaryFrameForSession,
    encodePeerTcpTunnelBinaryFrameForSession,
} from './frames';
import { isPeerTcpTunnelLoopbackDestinationHost, type PeerTcpTunnelTcpConnection } from './open';

type PeerTcpTunnelRelaySocket = Readonly<{
    on: (event: string, handler: (payload?: unknown) => void | Promise<void>) => unknown;
    emit: (event: string, payload: unknown) => unknown;
}>;

type ActiveRelayTunnel = Readonly<{
    connection: PeerTcpTunnelTcpConnection;
    session: ReturnType<typeof createPeerTcpTunnelStreamSession>;
    substreamMux?: ReturnType<typeof createPeerTcpTunnelSubstreamMuxSession>;
    encoding: PeerTcpTunnelEncoding;
}>;

export type RegisterPeerTcpTunnelRelayTerminatorOptions = Readonly<{
    accountId: string;
    machineId: string;
    socket: PeerTcpTunnelRelaySocket;
    nowMs: () => number;
    relayAuthorizationTrustRoots: readonly PeerTcpTunnelRelayAuthorizationTrustRootV1[];
    connectTcp: (target: Readonly<{ host: string; port: number }>) => Promise<PeerTcpTunnelTcpConnection>;
    initialWindowBytes?: number;
    maxFrameBytes?: number;
    maxActiveTunnels?: number;
}>;

function normalizeDestinationHost(host: string): string {
    const trimmed = host.trim().toLowerCase();
    return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

function frameTunnelId(frame: PeerTcpTunnelFrameV1): string {
    return frame.kind === 'open' ? frame.open.tunnelId : frame.tunnelId;
}

function selectedOpenEncoding(frame: PeerTcpTunnelFrameV1): PeerTcpTunnelEncoding {
    return frame.kind === 'open'
        ? frame.open.selectedEncoding ?? PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1
        : PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1;
}

function buildEnvelope(input: Readonly<{
    accountId: string;
    machineId: string;
    frame: PeerTcpTunnelFrameV1;
}>): PeerTcpTunnelRelayEnvelopeV1 {
    return {
        v: 1,
        scopeUserId: input.accountId,
        sender: { kind: 'machine', machineId: input.machineId },
        recipient: { kind: 'user' },
        frame: input.frame,
    };
}

function buildBinaryEnvelope(input: Readonly<{
    accountId: string;
    machineId: string;
    frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;
}>): PeerTcpTunnelRelayBinaryEnvelopeV2 {
    return {
        v: 2,
        scopeUserId: input.accountId,
        sender: { kind: 'machine', machineId: input.machineId },
        recipient: { kind: 'user' },
        encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        frame: encodePeerTcpTunnelBinaryFrameForSession(input.frame),
    };
}

function abortFrame(tunnelId: string, reasonCode: string): PeerTcpTunnelFrameV1 {
    return {
        v: 1,
        kind: 'abort',
        tunnelId,
        reasonCode,
    };
}

export function registerPeerTcpTunnelRelayTerminator(
    options: RegisterPeerTcpTunnelRelayTerminatorOptions,
): void {
    const activeTunnels = new Map<string, ActiveRelayTunnel>();
    const openingTunnels = new Set<string>();
    const pendingFramesByOpeningTunnel = new Map<string, PeerTcpTunnelRelayEnvelope[]>();
    const consumedRelayAuthorizationExpByGrantId = new Map<string, number>();
    const maxActiveTunnels = Math.max(1, Math.floor(options.maxActiveTunnels ?? 8));

    function emitFrame(frame: PeerTcpTunnelFrameV1): void {
        options.socket.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, buildEnvelope({
            accountId: options.accountId,
            machineId: options.machineId,
            frame,
        }));
    }

    function emitSessionFrame(encoding: PeerTcpTunnelEncoding, frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>): void {
        if (encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2) {
            options.socket.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, buildBinaryEnvelope({
                accountId: options.accountId,
                machineId: options.machineId,
                frame,
            }));
            return;
        }
        emitFrame(frame);
    }

    function emitAbort(tunnelId: string, reasonCode: string): void {
        emitFrame(abortFrame(tunnelId, reasonCode));
    }

    async function closeTunnel(tunnelId: string): Promise<void> {
        const active = activeTunnels.get(tunnelId);
        activeTunnels.delete(tunnelId);
        openingTunnels.delete(tunnelId);
        pendingFramesByOpeningTunnel.delete(tunnelId);
        await active?.substreamMux?.close();
        await active?.connection.close();
    }

    function cleanupConsumedRelayAuthorizations(nowMs: number): void {
        for (const [grantId, expiresAt] of consumedRelayAuthorizationExpByGrantId) {
            if (expiresAt <= nowMs) consumedRelayAuthorizationExpByGrantId.delete(grantId);
        }
    }

    function consumeRelayAuthorizationGrant(input: Readonly<{ grantId: string; expiresAt: number; nowMs: number }>): boolean {
        cleanupConsumedRelayAuthorizations(input.nowMs);
        if (consumedRelayAuthorizationExpByGrantId.has(input.grantId)) return false;
        consumedRelayAuthorizationExpByGrantId.set(input.grantId, input.expiresAt);
        return true;
    }

    function isTerminalFrame(frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>): boolean {
        return frame.kind === 'close' || frame.kind === 'abort';
    }

    function queueFrameForOpeningTunnel(tunnelId: string, envelope: PeerTcpTunnelRelayEnvelope): boolean {
        if (!openingTunnels.has(tunnelId)) return false;
        if (envelope.v === 1 && isTerminalFrame(envelope.frame as Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>)) {
            pendingFramesByOpeningTunnel.delete(tunnelId);
            return true;
        }
        const existing = pendingFramesByOpeningTunnel.get(tunnelId) ?? [];
        existing.push(envelope);
        pendingFramesByOpeningTunnel.set(tunnelId, existing);
        return true;
    }

    async function drainFramesForOpenedTunnel(tunnelId: string): Promise<void> {
        const pending = pendingFramesByOpeningTunnel.get(tunnelId) ?? [];
        pendingFramesByOpeningTunnel.delete(tunnelId);
        for (const envelope of pending) {
            await handleEnvelope(envelope);
        }
    }

    async function openTunnel(envelope: PeerTcpTunnelRelayEnvelopeV1): Promise<void> {
        const open = envelope.frame.kind === 'open' ? envelope.frame.open : null;
        if (!open) return;
        const tunnelId = open.tunnelId;

        if (envelope.scopeUserId !== options.accountId || envelope.sender.kind !== 'user') {
            emitAbort(tunnelId, 'relay_authorization_invalid');
            return;
        }
        if (envelope.recipient.kind !== 'machine' || envelope.recipient.machineId !== options.machineId) {
            emitAbort(tunnelId, 'relay_authorization_invalid');
            return;
        }
        if (open.targetMachineId !== options.machineId || open.routeKind !== 'server_relay') {
            emitAbort(tunnelId, 'relay_authorization_invalid');
            return;
        }

        const verification = verifyPeerTcpTunnelRelayAuthorizationV1({
            authorization: open.relayAuthorization,
            nowMs: options.nowMs(),
            trustRoots: options.relayAuthorizationTrustRoots,
        });
        if (!verification.valid || verification.payload.accountId !== options.accountId) {
            emitAbort(tunnelId, 'relay_authorization_invalid');
            return;
        }
        if (activeTunnels.has(tunnelId) || openingTunnels.has(tunnelId)) {
            emitAbort(tunnelId, 'tunnel_id_already_open');
            return;
        }
        if (activeTunnels.size + openingTunnels.size >= maxActiveTunnels) {
            emitAbort(tunnelId, 'relay_cap_exceeded');
            return;
        }
        if (!isPeerTcpTunnelLoopbackDestinationHost(open.destination.host)) {
            emitAbort(tunnelId, 'destination_host_not_allowed');
            return;
        }
        if (!consumeRelayAuthorizationGrant({
            grantId: verification.payload.grantId,
            expiresAt: verification.payload.exp,
            nowMs: options.nowMs(),
        })) {
            emitAbort(tunnelId, 'relay_authorization_invalid');
            return;
        }

        let connection: PeerTcpTunnelTcpConnection;
        openingTunnels.add(tunnelId);
        try {
            connection = await options.connectTcp({
                host: normalizeDestinationHost(open.destination.host),
                port: open.destination.port,
            });
        } catch {
            openingTunnels.delete(tunnelId);
            pendingFramesByOpeningTunnel.delete(tunnelId);
            emitAbort(tunnelId, 'tcp_connect_failed');
            return;
        }

        const encoding = selectedOpenEncoding(envelope.frame);
        const session = createPeerTcpTunnelStreamSession({
            tunnelId,
            initialWindowBytes: options.initialWindowBytes ?? PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
            maxFrameBytes: options.maxFrameBytes ?? Math.min(
                verification.payload.maxFrameBytes,
                PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
            ),
            maxIdleMs: verification.payload.maxIdleMs,
            maxDurationMs: verification.payload.maxDurationMs,
            maxTotalBytes: verification.payload.maxTotalBytes,
            connection,
            sendFrame: (frame) => {
                if (frame.kind === 'open') return;
                emitSessionFrame(encoding, frame);
            },
            nowMs: options.nowMs,
        });
        const substreamMux = encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
            ? createPeerTcpTunnelSubstreamMuxSession({
                tunnelId,
                destination: {
                    host: normalizeDestinationHost(open.destination.host),
                    port: open.destination.port,
                },
                initialWindowBytes: options.initialWindowBytes ?? PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
                maxFrameBytes: options.maxFrameBytes ?? Math.min(
                    verification.payload.maxFrameBytes,
                    PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
                ),
                maxBinaryHeaderBytes: options.maxFrameBytes ?? PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
                maxRawPayloadBytes: options.maxFrameBytes ?? PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
                caps: {
                    ...DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES,
                    maxBytesPerSubstream: verification.payload.maxTotalBytes
                        ?? DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES.maxBytesPerSubstream,
                    maxAggregateBytes: verification.payload.maxTotalBytes
                        ?? DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES.maxAggregateBytes,
                    maxSubstreamIdleMs: verification.payload.maxIdleMs,
                    maxSessionIdleMs: verification.payload.maxIdleMs,
                },
                connectTcp: options.connectTcp,
                sendBinaryFrame: (frame) => {
                    options.socket.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
                        v: 2,
                        scopeUserId: options.accountId,
                        sender: { kind: 'machine', machineId: options.machineId },
                        recipient: { kind: 'user' },
                        encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                        frame,
                    });
                },
                nowMs: options.nowMs,
            })
            : undefined;
        activeTunnels.set(tunnelId, {
            connection,
            session,
            encoding,
            ...(substreamMux ? { substreamMux } : {}),
        });
        openingTunnels.delete(tunnelId);
        await drainFramesForOpenedTunnel(tunnelId);
    }

    async function handleEnvelope(envelope: PeerTcpTunnelRelayEnvelope): Promise<void> {
        if (envelope.v === 1 && envelope.frame.kind === 'open') {
            await openTunnel(envelope);
            return;
        }

        let tunnelId: string;
        let frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;
        if (envelope.v === 1) {
            tunnelId = frameTunnelId(envelope.frame);
            frame = envelope.frame as Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;
        } else {
            const decodedHeader = decodePeerTcpTunnelBinaryFrameV2({
                frame: envelope.frame,
                maxHeaderBytes: options.maxFrameBytes ?? PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
                maxPayloadBytes: options.maxFrameBytes ?? PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
            });
            if (decodedHeader.ok && decodedHeader.header.substreamId) {
                const active = activeTunnels.get(decodedHeader.header.tunnelId);
                if (!active) {
                    if (queueFrameForOpeningTunnel(decodedHeader.header.tunnelId, envelope)) return;
                    emitAbort(decodedHeader.header.tunnelId, 'tunnel_not_open');
                    return;
                }
                if (active.encoding !== PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 || !active.substreamMux) {
                    emitAbort(decodedHeader.header.tunnelId, 'encoding_unsupported');
                    return;
                }
                await active.substreamMux.acceptBinaryFrame(envelope.frame);
                return;
            }
            const decoded = decodePeerTcpTunnelBinaryFrameForSession({
                frame: envelope.frame,
                maxBinaryHeaderBytes: options.maxFrameBytes ?? PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
                maxRawPayloadBytes: options.maxFrameBytes ?? PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
            });
            if (!decoded.ok) return;
            tunnelId = decoded.frame.tunnelId;
            frame = decoded.frame;
        }

        const active = activeTunnels.get(tunnelId);
        if (!active) {
            if (queueFrameForOpeningTunnel(tunnelId, envelope)) return;
            if (isTerminalFrame(frame)) return;
            emitAbort(tunnelId, 'tunnel_not_open');
            return;
        }
        if (envelope.v === 2 && active.encoding !== PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2) {
            emitAbort(tunnelId, 'encoding_unsupported');
            return;
        }
        await active.session.acceptFrame(frame);
        if (isTerminalFrame(frame)) {
            await closeTunnel(tunnelId);
        }
    }

    options.socket.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, async (raw: unknown) => {
        const parsed = PeerTcpTunnelRelayEnvelopeSchema.safeParse(raw);
        if (!parsed.success) return;

        await handleEnvelope(parsed.data);
    });
}
