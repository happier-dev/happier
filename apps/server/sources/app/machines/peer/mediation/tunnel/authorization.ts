import { randomUUID } from "node:crypto";

import {
    PEER_MEDIATION_RECEIPTS,
    PEER_TCP_TUNNEL_RELAY_AUTHORIZATION_AUDIENCE_V1,
    PeerTcpTunnelRelayAuthorizationPayloadV1Schema,
    createPeerTcpTunnelRelayAuthorizationSigningInputV1,
    type PeerTcpTunnelDestinationV1,
    type PeerTcpTunnelRelayAuthorizationPayloadV1,
    type PeerTcpTunnelRelayAuthorizationV1,
    type TcpTunnelGrantScopeV1,
} from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";

export type MintPeerTcpTunnelRelayAuthorizationV1Result =
    | Readonly<{
        ok: true;
        relayAuthorization: PeerTcpTunnelRelayAuthorizationV1;
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeGrantMinted;
    }>
    | Readonly<{
        ok: false;
        reasonCode:
        | "blocked_by_server_policy"
        | "destination_host_not_allowed"
        | "destination_port_not_allowed"
        | "relay_cap_exceeded"
        | "invalid_scope"
        | "invalid_ttl";
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeGrantRejected;
    }>;

export type MintPeerTcpTunnelRelayAuthorizationV1Input = Readonly<{
    accountId: string;
    targetMachineId: string;
    destination: PeerTcpTunnelDestinationV1;
    scope: TcpTunnelGrantScopeV1;
    nowMs: number;
    ttlMs: number;
    serverGateEnabled: boolean;
    serverCaps: Readonly<{
        allowedPorts: readonly number[];
        maxBytes: number;
        maxFrameBytes: number;
        maxIdleMs: number;
        maxDurationMs: number;
    }>;
    signingKey: Readonly<{
        keyId: string;
        secretKey: Uint8Array;
    }>;
}>;

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

function normalizeHost(host: string): string {
    const trimmed = host.trim().toLowerCase();
    return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

function isIpv4LoopbackHost(host: string): boolean {
    const parts = host.split(".");
    if (parts.length !== 4 || parts[0] !== "127") return false;
    return parts.slice(1).every((part) => {
        if (!/^\d+$/.test(part)) return false;
        const value = Number(part);
        return Number.isInteger(value) && value >= 0 && value <= 255;
    });
}

function isLoopbackHost(host: string): boolean {
    const normalized = normalizeHost(host);
    return normalized === "localhost" || normalized === "::1" || isIpv4LoopbackHost(normalized);
}

export function mintPeerTcpTunnelRelayAuthorizationV1(
    input: MintPeerTcpTunnelRelayAuthorizationV1Input,
): MintPeerTcpTunnelRelayAuthorizationV1Result {
    if (!input.serverGateEnabled) {
        return {
            ok: false,
            reasonCode: "blocked_by_server_policy",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
        return {
            ok: false,
            reasonCode: "invalid_ttl",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }
    if (input.scope.kind !== "tcp_tunnel") {
        return {
            ok: false,
            reasonCode: "invalid_scope",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }
    if (!isLoopbackHost(input.destination.host)) {
        return {
            ok: false,
            reasonCode: "destination_host_not_allowed",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }
    if (
        !input.scope.allowedPorts.includes(input.destination.port)
        || !input.serverCaps.allowedPorts.includes(input.destination.port)
    ) {
        return {
            ok: false,
            reasonCode: "destination_port_not_allowed",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }
    if (
        input.scope.maxIdleMs > input.serverCaps.maxIdleMs
        || input.scope.maxDurationMs > input.serverCaps.maxDurationMs
        || (typeof input.scope.maxTotalBytes === "number" && input.scope.maxTotalBytes > input.serverCaps.maxBytes)
    ) {
        return {
            ok: false,
            reasonCode: "relay_cap_exceeded",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }

    const payload: PeerTcpTunnelRelayAuthorizationPayloadV1 = PeerTcpTunnelRelayAuthorizationPayloadV1Schema.parse({
        v: 1,
        grantId: `relay_grant_${randomUUID()}`,
        accountId: input.accountId,
        targetMachineId: input.targetMachineId,
        flowKind: "tcp_tunnel",
        routeKind: "server_relay",
        tunnelId: input.scope.tunnelId,
        destination: input.destination,
        capProfileId: "default",
        maxFrameBytes: input.serverCaps.maxFrameBytes,
        maxIdleMs: input.scope.maxIdleMs,
        maxDurationMs: input.scope.maxDurationMs,
        ...(input.scope.maxTotalBytes ? { maxTotalBytes: input.scope.maxTotalBytes } : {}),
        iat: input.nowMs,
        exp: input.nowMs + input.ttlMs,
        aud: PEER_TCP_TUNNEL_RELAY_AUTHORIZATION_AUDIENCE_V1,
    });
    const signature = tweetnacl.sign.detached(
        Buffer.from(createPeerTcpTunnelRelayAuthorizationSigningInputV1(payload), "utf8"),
        input.signingKey.secretKey,
    );

    return {
        ok: true,
        relayAuthorization: {
            payload,
            signature: {
                keyId: input.signingKey.keyId,
                alg: "Ed25519",
                valueBase64Url: toBase64Url(signature),
            },
        },
        receipt: PEER_MEDIATION_RECEIPTS.routeGrantMinted,
    };
}
