import { randomUUID } from "node:crypto";

import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { decodePeerTcpTunnelBinaryFrameV2, encodePeerTcpTunnelBinaryFrameV2, type PeerTcpTunnelBinaryFrameHeaderV2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/v2';
import { PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/encoding';
import { PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES } from '@happier-dev/protocol/machines/peer/mediation/tunnel/v1';
import { PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, type PeerTcpTunnelRelayEnvelope } from '@happier-dev/protocol/machines/peer/mediation/tunnel/relay';
import { localServicePreviewDirectBindingV1, type LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';
import {
    createPeerTcpTunnelRelayStream,
    type PeerTcpTunnelRelayStream,
    type PeerTcpTunnelRelayTransport,
    type PeerTcpTunnelRelayTransportFactory,
} from "@/app/machines/peer/mediation/tunnel/peerRelayStreamTransport";

import { readMachineTunnelFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolvePeerMediationGrantSigningConfig } from "@/app/machines/peer/mediation/mintDirectRouteGrantV1";
import { mintPeerTcpTunnelRelayAuthorizationV2 } from "@/app/machines/peer/mediation/tunnel";
import type {
    LocalServicePreviewTunnelStream,
    OpenLocalServicePreviewTunnel,
} from "@/app/local/services/preview/httpAdapter";

export type CreateLocalServicePreviewTunnelOpenerInput = Readonly<{
    env: NodeJS.ProcessEnv;
    resolvePreviewAccountId(previewId: string): string | null | undefined;
    createRelayTransport: PeerTcpTunnelRelayTransportFactory;
    nowMs?: () => number;
    generateId?: () => string;
}>;

type PreviewTunnelSession = {
    accountId: string;
    preview: LocalServicePreviewResourceV1;
    tunnelId: string;
    transport: PeerTcpTunnelRelayTransport;
    unsubscribe: () => void;
    activeStreams: number;
    closed: boolean;
    streams: Map<string, PreviewSubstream>;
};

type PreviewSubstream = {
    substreamId: string;
    relaySubstream: PeerTcpTunnelRelayStream;
};

function normalizeAccountId(value: string | null | undefined): string | null {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Carry the failed prerequisite on the error itself. The HTTP/WebSocket adapters classify a tunnel
 * that will not open into a typed transport failure, and parsing it back out of the message string
 * would be the fragile way to learn which one it was.
 */
function createTunnelUnavailableError(reasonCode: string): Error {
    return Object.assign(
        new Error(`local_service_preview_tunnel_unavailable:${reasonCode}`),
        { reasonCode },
    );
}

export function createLocalServicePreviewTunnelOpener(
    input: CreateLocalServicePreviewTunnelOpenerInput,
): OpenLocalServicePreviewTunnel {
    const nowMs = input.nowMs ?? Date.now;
    const generateId = input.generateId ?? randomUUID;
    const sessions = new Map<string, PreviewTunnelSession>();

    function sessionKey(accountId: string, preview: LocalServicePreviewResourceV1): string {
        return [
            accountId,
            preview.machineId,
            preview.target.scheme,
            preview.target.host,
            preview.target.port,
        ].join(":");
    }

    function sendEnvelope(session: PreviewTunnelSession, envelope: PeerTcpTunnelRelayEnvelope): void {
        session.transport.send(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope);
    }

    function sendBinaryFrame(
        session: PreviewTunnelSession,
        header: PeerTcpTunnelBinaryFrameHeaderV2,
        payload?: Uint8Array,
    ): void {
        sendEncodedBinaryFrame(session, encodePeerTcpTunnelBinaryFrameV2({ header, payload }));
    }

    function sendEncodedBinaryFrame(session: PreviewTunnelSession, frame: Uint8Array): void {
        sendEnvelope(session, {
            v: 2,
            scopeUserId: session.accountId,
            sender: { kind: "user", socketId: session.transport.relaySocketId },
            recipient: { kind: "machine", machineId: session.preview.machineId },
            encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            frame,
        });
    }

    function closeSession(key: string, session: PreviewTunnelSession): void {
        if (session.closed) return;
        session.closed = true;
        for (const stream of session.streams.values()) stream.relaySubstream.closeFromTunnel();
        session.streams.clear();
        sendBinaryFrame(session, {
            version: 2,
            kind: "close",
            tunnelId: session.tunnelId,
            halfClose: false,
            reasonCode: "preview_tunnel_closed",
            payloadLength: 0,
        });
        session.unsubscribe();
        session.transport.close();
        sessions.delete(key);
    }

    function getOrCreateSession(accountId: string, preview: LocalServicePreviewResourceV1): PreviewTunnelSession {
        const key = sessionKey(accountId, preview);
        const existing = sessions.get(key);
        if (existing && !existing.closed) {
            return existing;
        }

        const featureEnv = readMachineTunnelFeatureEnv(input.env);
        const signing = resolvePeerMediationGrantSigningConfig(input.env, nowMs());
        if (!signing.ok) {
            throw createTunnelUnavailableError("grant_signing_unavailable");
        }

        const tunnelId = `preview_tunnel_${generateId()}`;
        const transport = input.createRelayTransport({ accountId });
        const authorization = mintPeerTcpTunnelRelayAuthorizationV2({
            accountId,
            targetMachineId: preview.machineId,
            relaySocketId: transport.relaySocketId,
            destination: {
                host: preview.target.host,
                port: preview.target.port,
            },
            scope: {
                kind: "tcp_tunnel",
                tunnelId,
                allowedPorts: [preview.target.port],
                preview: localServicePreviewDirectBindingV1(preview),
            },
            nowMs: nowMs(),
            ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.serverRelayedTcpTunnel,
            serverGateEnabled: featureEnv.serverRoutedEnabled,
            serverCaps: {
                allowedPorts: featureEnv.allowedPorts,
                maxFrameBytes: featureEnv.serverRoutedMaxFrameBytes,
            },
            signingKey: {
                keyId: signing.keyId,
                secretKey: signing.secretKey,
            },
        });
        if (!authorization.ok) {
            transport.close();
            throw createTunnelUnavailableError(authorization.reasonCode);
        }

        const session: PreviewTunnelSession = {
            accountId,
            preview,
            tunnelId,
            transport,
            unsubscribe: () => undefined,
            activeStreams: 0,
            closed: false,
            streams: new Map(),
        };
        session.unsubscribe = transport.subscribe((envelope) => {
            if (envelope.scopeUserId !== accountId) return;
            if (envelope.sender.kind !== "machine" || envelope.sender.machineId !== preview.machineId) return;
            if (envelope.recipient.kind !== "user") return;
            if (envelope.v === 1) {
                const tunnelIdFromFrame = envelope.frame.kind === "open" ? envelope.frame.open.tunnelId : envelope.frame.tunnelId;
                if (tunnelIdFromFrame === session.tunnelId && envelope.frame.kind === "abort") {
                    closeSession(key, session);
                }
                return;
            }
            const decoded = decodePeerTcpTunnelBinaryFrameV2({
                frame: envelope.frame,
                maxHeaderBytes: featureEnv.serverRoutedMaxBinaryHeaderBytes,
                maxPayloadBytes: featureEnv.serverRoutedMaxRawPayloadBytes,
            });
            if (!decoded.ok || decoded.header.tunnelId !== session.tunnelId) return;
            const substreamId = decoded.header.substreamId;
            if (!substreamId) {
                if (decoded.header.kind === "close" || decoded.header.kind === "abort") {
                    closeSession(key, session);
                }
                return;
            }
            session.streams.get(substreamId)?.relaySubstream.acceptEnvelope(envelope);
        });

        sendEnvelope(session, {
            v: 1,
            scopeUserId: accountId,
            sender: { kind: "user", socketId: transport.relaySocketId },
            recipient: { kind: "machine", machineId: preview.machineId },
            frame: {
                v: 1,
                kind: "open",
                open: {
                    v: 1,
                    kind: "open",
                    tunnelId,
                    targetMachineId: preview.machineId,
                    routeKind: "server_relay",
                    destination: {
                        host: preview.target.host,
                        port: preview.target.port,
                    },
                    relayAuthorization: authorization.relayAuthorization,
                    supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2],
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });

        sessions.set(key, session);
        return session;
    }

    return async ({ preview }) => {
        const accountId = normalizeAccountId(input.resolvePreviewAccountId(preview.previewId));
        if (!accountId) {
            throw createTunnelUnavailableError("preview_account_missing");
        }

        const key = sessionKey(accountId, preview);
        const session = getOrCreateSession(accountId, preview);
        const featureEnv = readMachineTunnelFeatureEnv(input.env);
        const substreamId = `preview_substream_${generateId()}`;
        let closed = false;

        function releaseStream(): void {
            if (closed) return;
            closed = true;
            session.streams.delete(substreamId);
            session.activeStreams = Math.max(0, session.activeStreams - 1);
            if (session.activeStreams === 0) {
                closeSession(key, session);
            }
        }

        const relaySubstream = createPeerTcpTunnelRelayStream({
            tunnelId: session.tunnelId,
            substreamId,
            initialWindowBytes: PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
            maxFrameBytes: featureEnv.serverRoutedMaxFrameBytes,
            maxDecodedPayloadBytes: featureEnv.serverRoutedMaxRawPayloadBytes,
            maxSendChunkBytes: featureEnv.serverRoutedMaxRawPayloadBytes,
            sendEncodedBinaryFrame: (frame) => sendEncodedBinaryFrame(session, frame),
            onRelease: releaseStream,
        });

        const stream: PreviewSubstream = {
            substreamId,
            relaySubstream,
        };

        session.streams.set(substreamId, stream);
        session.activeStreams += 1;
        relaySubstream.open();

        const tunnelStream: LocalServicePreviewTunnelStream = {
            tunnelId: session.tunnelId,
            substreamId,
            write: async (chunk) => {
                const result = await relaySubstream.stream.write(chunk);
                if (!result.ok) throw createTunnelUnavailableError(result.reasonCode);
            },
            endWrite: async () => {
                const result = await relaySubstream.stream.endWrite();
                if (!result.ok) throw createTunnelUnavailableError(result.reasonCode);
            },
            read: relaySubstream.stream.read,
            close: async () => {
                await relaySubstream.stream.close();
            },
            abort: async (reasonCode) => {
                await relaySubstream.stream.abort(reasonCode);
            },
        };

        return tunnelStream;
    };
}

export function createUnavailableLocalServicePreviewTunnelOpener(reasonCode: string): OpenLocalServicePreviewTunnel {
    return async () => {
        throw createTunnelUnavailableError(reasonCode);
    };
}
