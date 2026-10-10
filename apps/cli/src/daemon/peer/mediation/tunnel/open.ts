import { connect as connectSocket } from 'node:net';

import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import { PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES, PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES, PEER_TCP_TUNNEL_STREAM_PATH, PeerTcpTunnelOpenResponseV1Schema } from '@happier-dev/protocol/machines/peer/mediation/tunnel/v1';
import { PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/encoding';
import { PeerTcpTunnelOpenV2Schema } from '@happier-dev/protocol/machines/peer/mediation/tunnel/openAuthorizationV2';
import { isLiteralLoopbackHostname, normalizeHostnameForLoopbackCheck } from '@happier-dev/protocol/server/urls/loopbackHostname';
import type { PeerTcpTunnelDestinationV1, PeerTcpTunnelOpenResponseV1, PeerTcpTunnelOpenV2, PeerFlowKindV1, VoiceMediaApplicationAuthorityV1, LocalServicePreviewDirectBindingV1 } from '@happier-dev/protocol';

import {
    verifyDirectRouteGrantV2,
    type DirectRouteGrantTrustRoot,
    type DirectRouteGrantV2VerifyReasonCode,
} from '../verifyDirectRouteGrant';
import type { AtomicRouteGrantConsumption } from './grantConsumption';
import type { PeerTcpTunnelStreamConnection } from './frames';

export type PeerTcpTunnelTcpConnection = PeerTcpTunnelStreamConnection;

export type PeerTcpTunnelRuntimeLimits = Readonly<{
    maxIdleMs?: number;
    maxDurationMs?: number;
    maxTotalBytes?: number;
}>;

export type OpenPeerTcpTunnelReasonCode =
    | 'open_invalid'
    | 'grant_missing'
    | 'grant_already_consumed'
    | 'nonce_invalid'
    | 'grant_scope_mismatch'
    | 'destination_host_not_allowed'
    | 'destination_port_not_allowed'
    | 'encoding_unsupported'
    | 'tcp_connect_failed'
    | 'route_kind_unsupported'
    | 'preview_registration_unavailable'
    | DirectRouteGrantV2VerifyReasonCode;

export type OpenPeerTcpTunnelResult =
    | Readonly<{
        ok: true;
        /** Actual route established by the signed admission owner. */
        routeKind: 'loopback_direct' | 'iroh_peer';
        response: PeerTcpTunnelOpenResponseV1;
        receipt: typeof PEER_MEDIATION_RECEIPTS.tunnelOpened;
        flowKind: Extract<PeerFlowKindV1, 'tcp_tunnel' | 'voice_media'>;
        /**
         * The admitted tunnel's one canonical destination, already normalized by this owner.
         * Every child dial in the substream mux resolves it from this field rather than re-deriving a second
         * normalization from the open frame. Absent for `voice_media`, which never dials TCP.
         */
        destination?: PeerTcpTunnelDestinationV1;
        voiceMediaApplicationAuthority?: VoiceMediaApplicationAuthorityV1;
        limits: PeerTcpTunnelRuntimeLimits;
        previewApplication?: Readonly<{ signal: AbortSignal; close: () => Promise<void> }>;
      }>
    | Readonly<{
        ok: false;
        reasonCode: OpenPeerTcpTunnelReasonCode;
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeFallback;
      }>;

export type OpenPeerTcpTunnelInput = Readonly<{
    open: unknown;
    nowMs: number;
    expected: Readonly<{
        accountId: string;
        machineId: string;
        endpointFingerprint: string;
        /** Current native Machine identity, supplied by the listener owner. */
        irohEndpointId?: string;
    }>;
    trustRoots: readonly DirectRouteGrantTrustRoot[];
    grantConsumption: AtomicRouteGrantConsumption;
    initialWindowBytes?: number;
    maxFrameBytes?: number;
    connectTcp?: (target: Readonly<{ host: string; port: number }>) => Promise<PeerTcpTunnelTcpConnection>;
    signal?: AbortSignal;
    acquirePreviewApplication?: (binding: LocalServicePreviewDirectBindingV1, grantId: string, signal?: AbortSignal) => Promise<Readonly<{
        destination: PeerTcpTunnelDestinationV1; signal: AbortSignal; close: () => Promise<void>;
    }>>;
}>;

function fallback(reasonCode: OpenPeerTcpTunnelReasonCode): OpenPeerTcpTunnelResult {
    return {
        ok: false,
        reasonCode,
        receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
    };
}

export function isPeerTcpTunnelLoopbackDestinationHost(host: string): boolean {
    return isLiteralLoopbackHostname(host);
}

export async function connectPeerTcpTunnelTcp(
    target: Readonly<{ host: string; port: number }>,
): Promise<PeerTcpTunnelTcpConnection> {
    const socket = connectSocket({ host: target.host, port: target.port, allowHalfOpen: true });
    let connectionError: unknown;
    // Keep the error fact even if a peer resets between connect and session
    // subscription. Node also requires an error listener throughout that gap.
    socket.on('error', (error) => { connectionError = error; });
    await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('connect', () => {
            socket.off('error', reject);
            resolve();
        });
    });
    return {
        write: (bytes) => new Promise<void>((resolve, reject) => {
            socket.write(bytes, (error) => {
                if (error) reject(error);
                else resolve();
            });
        }),
        endWrite: () => new Promise<void>((resolve, reject) => {
            socket.end((error?: Error | null) => error ? reject(error) : resolve());
        }),
        pauseRead: () => {
            socket.pause();
        },
        resumeRead: () => {
            socket.resume();
        },
        onData: (handler) => {
            const dataHandler = (bytes: Buffer) => {
                void handler(bytes);
            };
            socket.on('data', dataHandler);
            return () => {
                socket.off('data', dataHandler);
            };
        },
        onEnd: (handler) => {
            socket.on('end', handler);
            if (socket.readableEnded) queueMicrotask(handler);
            return () => { socket.off('end', handler); };
        },
        onError: (handler) => {
            socket.on('error', handler);
            if (connectionError !== undefined) queueMicrotask(() => handler(connectionError));
            return () => { socket.off('error', handler); };
        },
        onClose: (handler) => {
            socket.on('close', handler);
            if (socket.closed) queueMicrotask(handler);
            return () => { socket.off('close', handler); };
        },
        close: () => new Promise<void>((resolve) => {
            if (socket.closed) { resolve(); return; }
            socket.once('close', () => resolve());
            socket.destroy();
        }),
    };
}

function validateDestination(
    open: PeerTcpTunnelOpenV2,
    destination: PeerTcpTunnelDestinationV1,
): OpenPeerTcpTunnelReasonCode | null {
    if (!isPeerTcpTunnelLoopbackDestinationHost(destination.host)) {
        return 'destination_host_not_allowed';
    }

    const scope = open.grant?.payload.scope;
    if (scope?.kind !== 'tcp_tunnel' && scope?.kind !== 'voice_media') return 'grant_scope_mismatch';
    if (scope.tunnelId !== open.tunnelId) return 'grant_scope_mismatch';
    if (scope.kind === 'tcp_tunnel' && !scope.allowedPorts.includes(destination.port)) {
        return 'destination_port_not_allowed';
    }
    if (scope.kind === 'tcp_tunnel' && scope.preview && (
        scope.preview.target.host !== destination.host || scope.preview.target.port !== destination.port
    )) return 'grant_scope_mismatch';

    return null;
}

function validateEncodingSelection(open: PeerTcpTunnelOpenV2): OpenPeerTcpTunnelReasonCode | null {
    const selectedEncoding = open.selectedEncoding ?? PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2;
    const supportedEncodings = open.supportedEncodings ?? [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2];

    if (!supportedEncodings.includes(selectedEncoding)) return 'encoding_unsupported';
    if (selectedEncoding !== PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2) {
        return 'encoding_unsupported';
    }

    return null;
}

export async function openPeerTcpTunnel(input: OpenPeerTcpTunnelInput): Promise<OpenPeerTcpTunnelResult> {
    const parsedV2 = PeerTcpTunnelOpenV2Schema.safeParse(input.open);
    if (!parsedV2.success) return fallback('open_invalid');
    const open = parsedV2.data;

    if (open.routeKind !== 'loopback_direct' && (
        open.routeKind !== 'iroh_peer' || !input.expected.irohEndpointId
    )) return fallback('route_kind_unsupported');
    const requestedDestination = open.destination;
    if (!requestedDestination) return fallback('open_invalid');
    if (!open.grant) return fallback('grant_missing');
    const requestedFlowKind = open.grant.payload.flowKind;
    if (requestedFlowKind !== 'tcp_tunnel' && requestedFlowKind !== 'voice_media') {
        return fallback('grant_scope_mismatch');
    }
    const requestedScope = open.grant.payload.scope;
    if (open.routeKind === 'iroh_peer' && requestedFlowKind !== 'tcp_tunnel') {
        return fallback('grant_scope_mismatch');
    }

    const grantVerification = verifyDirectRouteGrantV2({
        grant: open.grant,
        proof: open.proof,
        trustRoots: input.trustRoots,
        nowMs: input.nowMs,
        expected: {
            // A source-qualified native preview capability names the authenticated viewer,
            // not this listener's custodian. Its Home signature/proof are still verified here,
            // and the exact current stored grant/control lease is required below before IO.
            accountId: open.routeKind === 'iroh_peer' && requestedScope.kind === 'tcp_tunnel'
                && requestedScope.preview?.serviceTarget && requestedScope.preview.sessionId === undefined
                ? open.grant.payload.accountId : input.expected.accountId,
            machineId: input.expected.machineId,
            flowKind: requestedFlowKind,
            ...(requestedScope.kind === 'voice_media' ? {
                voiceMediaApplicationAuthority: {
                    v: 1,
                    applicationKind: requestedScope.applicationKind,
                    applicationAttemptId: requestedScope.applicationAttemptId,
                    applicationAuthorityDigest: requestedScope.applicationAuthorityDigest,
                },
            } : {}),
            routeKind: open.routeKind,
            endpointFingerprint: open.routeKind === 'iroh_peer'
                ? input.expected.irohEndpointId
                : input.expected.endpointFingerprint,
            ...(open.routeKind === 'iroh_peer' && open.grant.payload.iroh && input.expected.irohEndpointId ? {
                iroh: {
                    // The signed/proof-bound initiator is authenticated by the
                    // outer Machine admission; only this listener supplies the
                    // target identity. No request header selects that target.
                    initiator: open.grant.payload.iroh.initiator,
                    target: { machineId: input.expected.machineId, endpointId: input.expected.irohEndpointId },
                    operationKind: 'tcp_tunnel' as const,
                },
            } : {}),
        },
    });
    if (!grantVerification.valid) return fallback(grantVerification.reasonCode);

    const destinationInvalid = validateDestination(open, requestedDestination);
    if (destinationInvalid) return fallback(destinationInvalid);
    let destination: PeerTcpTunnelDestinationV1 = {
        host: normalizeHostnameForLoopbackCheck(requestedDestination.host),
        port: requestedDestination.port,
    };
    const encodingInvalid = validateEncodingSelection(open);
    if (encodingInvalid) return fallback(encodingInvalid);
    const scope = grantVerification.payload.scope;
    if (scope.kind !== requestedFlowKind) return fallback('grant_scope_mismatch');

    const reservation = input.grantConsumption.reserve({
        grantId: grantVerification.payload.grantId,
        expiresAt: grantVerification.payload.exp,
        nowMs: input.nowMs,
    });
    if (!reservation) return fallback('grant_already_consumed');

    if (scope.kind === 'voice_media') {
        reservation.commit();
        return {
            ok: true,
            routeKind: 'loopback_direct',
            response: PeerTcpTunnelOpenResponseV1Schema.parse({
                v: 1,
                tunnelId: open.tunnelId,
                streamPath: PEER_TCP_TUNNEL_STREAM_PATH,
                encoding: open.selectedEncoding ?? PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                initialWindowBytes: input.initialWindowBytes ?? PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
                maxFrameBytes: input.maxFrameBytes ?? PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
            }),
            receipt: PEER_MEDIATION_RECEIPTS.tunnelOpened,
            flowKind: scope.kind,
            voiceMediaApplicationAuthority: {
                v: 1,
                applicationKind: scope.applicationKind,
                applicationAttemptId: scope.applicationAttemptId,
                applicationAuthorityDigest: scope.applicationAuthorityDigest,
            },
            limits: {
                maxIdleMs: scope.maxIdleMs,
                maxDurationMs: scope.maxDurationMs,
                ...(scope.maxTotalBytes !== undefined ? { maxTotalBytes: scope.maxTotalBytes } : {}),
            },
        };
    }

    let previewApplication: Readonly<{ signal: AbortSignal; close: () => Promise<void> }> | undefined;
    if (scope.preview) {
        if (!input.acquirePreviewApplication) {
            reservation.activationFailed();
            return fallback('preview_registration_unavailable');
        }
        try {
            const application = await input.acquirePreviewApplication(scope.preview, grantVerification.payload.grantId, input.signal);
            if (application.signal.aborted || input.signal?.aborted) {
                await application.close();
                throw new Error('preview_registration_closed');
            }
            destination = application.destination;
            previewApplication = application;
        } catch {
            reservation.activationFailed();
            return fallback('preview_registration_unavailable');
        }
    }
    reservation.commit();

    return {
        ok: true,
        routeKind: open.routeKind === 'iroh_peer' ? 'iroh_peer' : 'loopback_direct',
        response: PeerTcpTunnelOpenResponseV1Schema.parse({
            v: 1,
            tunnelId: open.tunnelId,
            streamPath: PEER_TCP_TUNNEL_STREAM_PATH,
            encoding: open.selectedEncoding ?? PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            initialWindowBytes: input.initialWindowBytes ?? PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
            maxFrameBytes: input.maxFrameBytes ?? PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
        }),
        receipt: PEER_MEDIATION_RECEIPTS.tunnelOpened,
        flowKind: requestedFlowKind,
        destination,
        ...(previewApplication ? { previewApplication } : {}),
        limits: {},
    };
}
