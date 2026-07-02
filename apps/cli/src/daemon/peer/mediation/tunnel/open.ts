import { connect as connectSocket, type Socket } from 'node:net';

import {
    PEER_MEDIATION_RECEIPTS,
    PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
    PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
    PEER_TCP_TUNNEL_ENCODING_V1,
    PEER_TCP_TUNNEL_STREAM_PATH,
    PeerTcpTunnelOpenResponseV1Schema,
    PeerTcpTunnelOpenV1Schema,
    type PeerTcpTunnelOpenResponseV1,
    type PeerTcpTunnelOpenV1,
} from '@happier-dev/protocol';

import {
    verifyDirectRouteGrantV1,
    verifyPeerRouteNonceV1,
    type DirectRouteGrantTrustRoot,
    type DirectRouteGrantVerifyReasonCode,
    type PeerRouteNonceVerifyReasonCode,
} from '../verifyDirectRouteGrantV1';

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
    | 'nonce_invalid'
    | 'grant_scope_mismatch'
    | 'destination_host_not_allowed'
    | 'destination_port_not_allowed'
    | 'tcp_connect_failed'
    | 'route_kind_unsupported'
    | DirectRouteGrantVerifyReasonCode
    | PeerRouteNonceVerifyReasonCode;

export type OpenPeerTcpTunnelResult =
    | Readonly<{
        ok: true;
        response: PeerTcpTunnelOpenResponseV1;
        receipt: typeof PEER_MEDIATION_RECEIPTS.tunnelOpened;
        connection: PeerTcpTunnelTcpConnection;
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

function validateDestination(open: PeerTcpTunnelOpenV1): OpenPeerTcpTunnelReasonCode | null {
    if (!isPeerTcpTunnelLoopbackDestinationHost(open.destination.host)) {
        return 'destination_host_not_allowed';
    }

    const scope = open.grant?.payload.scope;
    if (scope?.kind !== 'tcp_tunnel') return 'grant_scope_mismatch';
    if (scope.tunnelId !== open.tunnelId) return 'grant_scope_mismatch';
    if (!scope.allowedPorts.includes(open.destination.port)) {
        return 'destination_port_not_allowed';
    }

    return null;
}

export async function openPeerTcpTunnel(input: OpenPeerTcpTunnelInput): Promise<OpenPeerTcpTunnelResult> {
    const parsed = PeerTcpTunnelOpenV1Schema.safeParse(input.open);
    if (!parsed.success) return fallback('open_invalid');
    const open = parsed.data;

    if (open.routeKind !== 'loopback_direct') return fallback('route_kind_unsupported');
    if (!open.grant) return fallback('grant_missing');
    if (!open.nonceProof) return fallback('nonce_invalid');

    const grantVerification = verifyDirectRouteGrantV1({
        grant: open.grant,
        trustRoots: input.trustRoots,
        nowMs: input.nowMs,
        expected: {
            accountId: input.expected.accountId,
            machineId: input.expected.machineId,
            flowKind: 'tcp_tunnel',
            routeKind: 'loopback_direct',
            endpointFingerprint: input.expected.endpointFingerprint,
        },
        revokedGrantIds: input.revokedGrantIds,
        revokedGrantFamilyIds: input.revokedGrantFamilyIds,
    });
    if (!grantVerification.valid) return fallback(grantVerification.reasonCode);

    const nonceVerification = input.expected.accountPublicKey
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
    const scope = grantVerification.payload.scope;
    if (scope.kind !== 'tcp_tunnel') return fallback('grant_scope_mismatch');

    let connection: PeerTcpTunnelTcpConnection;
    try {
        connection = await (input.connectTcp ?? connectPeerTcpTunnelTcp)({
            host: normalizeDestinationHost(open.destination.host),
            port: open.destination.port,
        });
    } catch {
        return fallback('tcp_connect_failed');
    }

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
