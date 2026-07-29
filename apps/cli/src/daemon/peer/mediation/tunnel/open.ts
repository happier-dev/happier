import { connect as connectSocket, type Socket } from 'node:net';

import {
    PEER_MEDIATION_RECEIPTS,
    PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
    PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
    PEER_TCP_TUNNEL_ENCODING_V1,
    PEER_TCP_TUNNEL_STREAM_PATH,
    PeerTcpTunnelOpenResponseV1Schema,
    PeerTcpTunnelOpenV1Schema,
    PeerTcpTunnelOpenV2Schema,
    type PeerTcpTunnelOpenResponseV1,
    type PeerTcpTunnelOpenV1,
    type PeerTcpTunnelOpenV2,
    type PeerFlowKindV1,
    type VoiceMediaApplicationAuthorityV1,
} from '@happier-dev/protocol';

import {
    verifyDirectRouteGrantV1,
    verifyDirectRouteGrantV2,
    verifyPeerRouteNonceV1,
    type DirectRouteGrantTrustRoot,
    type DirectRouteGrantVerifyReasonCode,
    type DirectRouteGrantV2VerifyReasonCode,
    type PeerRouteNonceVerifyReasonCode,
} from '../verifyDirectRouteGrantV1';
import type { AtomicRouteGrantConsumption } from './grantConsumption';

export type PeerTcpTunnelTcpConnection = Readonly<{
    write?: (bytes: Uint8Array) => Promise<void> | void;
    endWrite?: () => Promise<void> | void;
    pauseRead?: () => Promise<void> | void;
    resumeRead?: () => Promise<void> | void;
    onData?: (handler: (bytes: Uint8Array) => Promise<void> | void) => (() => void) | void;
    close: () => Promise<void> | void;
}>;

export type PeerTcpTunnelRuntimeLimits = Readonly<{
    maxIdleMs: number;
    maxDurationMs: number;
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
    | DirectRouteGrantVerifyReasonCode
    | DirectRouteGrantV2VerifyReasonCode
    | PeerRouteNonceVerifyReasonCode;

export type OpenPeerTcpTunnelResult =
    | Readonly<{
        ok: true;
        response: PeerTcpTunnelOpenResponseV1;
        receipt: typeof PEER_MEDIATION_RECEIPTS.tunnelOpened;
        flowKind: Extract<PeerFlowKindV1, 'tcp_tunnel' | 'voice_media'>;
        voiceMediaApplicationAuthority?: VoiceMediaApplicationAuthorityV1;
        connection?: PeerTcpTunnelTcpConnection;
        limits: PeerTcpTunnelRuntimeLimits;
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
        accountPublicKey?: string;
    }>;
    trustRoots: readonly DirectRouteGrantTrustRoot[];
    revokedGrantIds?: ReadonlySet<string>;
    revokedGrantFamilyIds?: ReadonlySet<string>;
    grantConsumption: AtomicRouteGrantConsumption;
    initialWindowBytes?: number;
    maxFrameBytes?: number;
    connectTcp?: (target: Readonly<{ host: string; port: number }>) => Promise<PeerTcpTunnelTcpConnection>;
}>;

function fallback(reasonCode: OpenPeerTcpTunnelReasonCode): OpenPeerTcpTunnelResult {
    return {
        ok: false,
        reasonCode,
        receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
    };
}

function normalizeDestinationHost(host: string): string {
    const trimmed = host.trim().toLowerCase();
    return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

function isIpv4LoopbackHost(host: string): boolean {
    const parts = host.split('.');
    if (parts.length !== 4 || parts[0] !== '127') return false;
    return parts.slice(1).every((part) => {
        if (!/^\d+$/.test(part)) return false;
        const value = Number(part);
        return Number.isInteger(value) && value >= 0 && value <= 255;
    });
}

export function isPeerTcpTunnelLoopbackDestinationHost(host: string): boolean {
    const normalized = normalizeDestinationHost(host);
    return normalized === 'localhost' || normalized === '::1' || isIpv4LoopbackHost(normalized);
}

export async function connectPeerTcpTunnelTcp(
    target: Readonly<{ host: string; port: number }>,
): Promise<PeerTcpTunnelTcpConnection> {
    const socket = await new Promise<Socket>((resolve, reject) => {
        const tcpSocket = connectSocket({ host: target.host, port: target.port }, () => resolve(tcpSocket));
        tcpSocket.once('error', reject);
    });
    return {
        write: (bytes) => new Promise<void>((resolve, reject) => {
            socket.write(bytes, (error) => {
                if (error) reject(error);
                else resolve();
            });
        }),
        endWrite: () => new Promise<void>((resolve) => {
            socket.end(() => resolve());
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
        close: () => new Promise<void>((resolve) => {
            socket.end(() => resolve());
            socket.destroy();
        }),
    };
}

function validateDestination(open: PeerTcpTunnelOpenV1 | PeerTcpTunnelOpenV2): OpenPeerTcpTunnelReasonCode | null {
    if (!isPeerTcpTunnelLoopbackDestinationHost(open.destination.host)) {
        return 'destination_host_not_allowed';
    }

    const scope = open.grant?.payload.scope;
    if (scope?.kind !== 'tcp_tunnel' && scope?.kind !== 'voice_media') return 'grant_scope_mismatch';
    if (scope.tunnelId !== open.tunnelId) return 'grant_scope_mismatch';
    if (scope.kind === 'tcp_tunnel' && !scope.allowedPorts.includes(open.destination.port)) {
        return 'destination_port_not_allowed';
    }

    return null;
}

function validateEncodingSelection(open: PeerTcpTunnelOpenV1 | PeerTcpTunnelOpenV2): OpenPeerTcpTunnelReasonCode | null {
    const selectedEncoding = open.selectedEncoding ?? PEER_TCP_TUNNEL_ENCODING_V1;
    const supportedEncodings = open.supportedEncodings ?? [PEER_TCP_TUNNEL_ENCODING_V1];

    if (!supportedEncodings.includes(selectedEncoding)) return 'encoding_unsupported';
    if (selectedEncoding === PEER_TCP_TUNNEL_ENCODING_V1 && open.allowV1Fallback === false) {
        return 'encoding_unsupported';
    }

    return null;
}

export async function openPeerTcpTunnel(input: OpenPeerTcpTunnelInput): Promise<OpenPeerTcpTunnelResult> {
    const parsedV2 = PeerTcpTunnelOpenV2Schema.safeParse(input.open);
    const parsedV1 = parsedV2.success ? null : PeerTcpTunnelOpenV1Schema.safeParse(input.open);
    if (!parsedV2.success && !parsedV1?.success) return fallback('open_invalid');
    const open: PeerTcpTunnelOpenV1 | PeerTcpTunnelOpenV2 = parsedV2.success
        ? parsedV2.data
        : PeerTcpTunnelOpenV1Schema.parse(input.open);

    if (open.routeKind !== 'loopback_direct') return fallback('route_kind_unsupported');
    if (!open.grant) return fallback('grant_missing');
    if (open.v === 1 && !open.nonceProof) return fallback('nonce_invalid');
    const requestedFlowKind = open.grant.payload.flowKind;
    if (requestedFlowKind !== 'tcp_tunnel' && requestedFlowKind !== 'voice_media') {
        return fallback('grant_scope_mismatch');
    }
    const requestedScope = open.grant.payload.scope;

    const grantVerification = open.v === 2
      ? verifyDirectRouteGrantV2({
        grant: open.grant,
        proof: open.proof,
        trustRoots: input.trustRoots,
        nowMs: input.nowMs,
        expected: {
            accountId: input.expected.accountId,
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
            routeKind: 'loopback_direct',
            endpointFingerprint: input.expected.endpointFingerprint,
        },
        revokedGrantIds: input.revokedGrantIds,
        revokedGrantFamilyIds: input.revokedGrantFamilyIds,
      })
      : verifyDirectRouteGrantV1({
        grant: open.grant,
        trustRoots: input.trustRoots,
        nowMs: input.nowMs,
        expected: {
            accountId: input.expected.accountId,
            machineId: input.expected.machineId,
            flowKind: requestedFlowKind,
            routeKind: 'loopback_direct',
            endpointFingerprint: input.expected.endpointFingerprint,
        },
        revokedGrantIds: input.revokedGrantIds,
        revokedGrantFamilyIds: input.revokedGrantFamilyIds,
      });
    if (!grantVerification.valid) return fallback(grantVerification.reasonCode);

    const nonceVerification = open.v === 2
        ? { valid: true as const }
        : input.expected.accountPublicKey
        ? verifyPeerRouteNonceV1({
            proof: open.nonceProof,
            accountPublicKey: input.expected.accountPublicKey,
            expected: {
                grantId: grantVerification.payload.grantId,
                routeKind: grantVerification.payload.routeKind,
                flowKind: grantVerification.payload.flowKind,
                endpointFingerprint: grantVerification.payload.endpointFingerprint,
            },
        })
        : { valid: false as const, reasonCode: 'nonce_invalid' as const };
    if (!nonceVerification.valid) return fallback(nonceVerification.reasonCode);

    const destinationInvalid = validateDestination(open);
    if (destinationInvalid) return fallback(destinationInvalid);
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
            response: PeerTcpTunnelOpenResponseV1Schema.parse({
                v: 1,
                tunnelId: open.tunnelId,
                streamPath: PEER_TCP_TUNNEL_STREAM_PATH,
                encoding: open.selectedEncoding ?? PEER_TCP_TUNNEL_ENCODING_V1,
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

    let connection: PeerTcpTunnelTcpConnection;
    try {
        connection = await (input.connectTcp ?? connectPeerTcpTunnelTcp)({
            host: normalizeDestinationHost(open.destination.host),
            port: open.destination.port,
        });
    } catch {
        // Safe direct retry rule: connectTcp rejects before it returns an
        // activated connection, so no tunnel was exposed to the caller.
        reservation.activationFailed();
        return fallback('tcp_connect_failed');
    }

    reservation.commit();

    return {
        ok: true,
        response: PeerTcpTunnelOpenResponseV1Schema.parse({
            v: 1,
            tunnelId: open.tunnelId,
            streamPath: PEER_TCP_TUNNEL_STREAM_PATH,
            encoding: open.selectedEncoding ?? PEER_TCP_TUNNEL_ENCODING_V1,
            initialWindowBytes: input.initialWindowBytes ?? PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
            maxFrameBytes: input.maxFrameBytes ?? PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
        }),
        receipt: PEER_MEDIATION_RECEIPTS.tunnelOpened,
        flowKind: requestedFlowKind,
        connection,
        limits: {
            maxIdleMs: scope.maxIdleMs,
            maxDurationMs: scope.maxDurationMs,
            ...(scope.maxTotalBytes !== undefined
                ? { maxTotalBytes: scope.maxTotalBytes }
                : {}),
        },
    };
}
