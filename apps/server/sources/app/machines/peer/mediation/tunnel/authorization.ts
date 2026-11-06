import { randomUUID } from "node:crypto";

import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import { PEER_TCP_TUNNEL_RELAY_AUTHORIZATION_AUDIENCE_V1, PeerTcpTunnelRelayAuthorizationPayloadV2Schema, createPeerTcpTunnelRelayAuthorizationSigningInputV2, type PeerTcpTunnelRelayAuthorizationFlowKindV1, type PeerTcpTunnelRelayAuthorizationPayloadV2, type PeerTcpTunnelRelayAuthorizationV2, type ProviderBrokerRelayApplicationBindingV1 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/authorizationSchemas';
import { isLiteralLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';
import { type PeerTcpTunnelDestinationV1 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/v1';
import { type TcpTunnelGrantScopeV1, type VoiceMediaGrantScopeV1 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantScopesV1';
import type { LocalServicePreviewDirectBindingV1 } from '@happier-dev/protocol/local/services/preview/v1';
import tweetnacl from "tweetnacl";

export type MintPeerTcpTunnelRelayAuthorizationV2Result =
    | Readonly<{
        ok: true;
        relayAuthorization: PeerTcpTunnelRelayAuthorizationV2;
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

export type MintPeerTcpTunnelRelayAuthorizationV2Input = Readonly<{
    accountId: string;
    targetMachineId: string;
    relaySocketId: string;
    destination: PeerTcpTunnelDestinationV1;
    scope: TcpTunnelGrantScopeV1 | VoiceMediaGrantScopeV1;
    nowMs: number;
    ttlMs: number;
    serverGateEnabled: boolean;
    serverCaps: Readonly<{
        allowedPorts: readonly number[];
        maxBytes?: number;
        maxFrameBytes: number;
        maxIdleMs?: number;
        maxDurationMs?: number;
    }>;
    capProfileId?: string;
    flowKind?: PeerTcpTunnelRelayAuthorizationFlowKindV1;
    signingKey: Readonly<{
        keyId: string;
        secretKey: Uint8Array;
    }>;
}>;

export type MintProviderBrokerRelayAuthorizationV2Input = Readonly<{
    accountId: string;
    targetMachineId: string;
    relaySocketId: string;
    binding: ProviderBrokerRelayApplicationBindingV1;
    tunnelId: string;
    nowMs: number;
    ttlMs: number;
    serverGateEnabled: boolean;
    serverCaps: Omit<MintPeerTcpTunnelRelayAuthorizationV2Input['serverCaps'], 'allowedPorts'>;
    signingKey: Readonly<{ keyId: string; secretKey: Uint8Array }>;
}>;

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

/** Shared by relay minting and preview URL admission, before any renderer loads a document.
 * admittedPreview comes only from the preview owner after Machine/service admission;
 * generic route-grant requests cannot supply preview bindings.
 */
export function isPeerTcpTunnelRelayPortAllowed(input: Readonly<{
    port: number;
    grantedPorts: readonly number[];
    serverAllowedPorts: readonly number[];
    admittedPreview?: LocalServicePreviewDirectBindingV1;
}>): boolean {
    return input.grantedPorts.includes(input.port) && (
        input.serverAllowedPorts.includes(input.port)
        || (input.admittedPreview?.serviceTarget !== undefined && input.admittedPreview.target.port === input.port)
    );
}

/** Dedicated Home-to-broker application authority. It deliberately has no
 * TCP destination: the target daemon resolves only its installed Provider
 * broker application for the signed binding. */
export function mintProviderBrokerRelayAuthorizationV2(
    input: MintProviderBrokerRelayAuthorizationV2Input,
): MintPeerTcpTunnelRelayAuthorizationV2Result {
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
    const payload = PeerTcpTunnelRelayAuthorizationPayloadV2Schema.safeParse({
        v: 2,
        grantId: `relay_grant_${randomUUID()}`,
        accountId: input.accountId,
        targetMachineId: input.targetMachineId,
        flowKind: "provider_broker",
        routeKind: "server_relay",
        tunnelId: input.tunnelId,
        relaySocketId: input.relaySocketId,
        providerBroker: input.binding,
        capProfileId: "provider_broker_application_v1",
        maxFrameBytes: input.serverCaps.maxFrameBytes,
        ...(input.serverCaps.maxIdleMs !== undefined ? { maxIdleMs: input.serverCaps.maxIdleMs } : {}),
        ...(input.serverCaps.maxDurationMs !== undefined ? { maxDurationMs: input.serverCaps.maxDurationMs } : {}),
        ...(input.serverCaps.maxBytes !== undefined ? { maxTotalBytes: input.serverCaps.maxBytes } : {}),
        iat: input.nowMs,
        exp: input.nowMs + input.ttlMs,
        aud: PEER_TCP_TUNNEL_RELAY_AUTHORIZATION_AUDIENCE_V1,
    });
    if (!payload.success) {
        return {
            ok: false,
            reasonCode: "invalid_scope",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }
    const signature = tweetnacl.sign.detached(
        Buffer.from(createPeerTcpTunnelRelayAuthorizationSigningInputV2(payload.data), "utf8"),
        input.signingKey.secretKey,
    );
    return {
        ok: true,
        relayAuthorization: {
            payload: payload.data,
            signature: {
                keyId: input.signingKey.keyId,
                alg: "Ed25519",
                valueBase64Url: toBase64Url(signature),
            },
        },
        receipt: PEER_MEDIATION_RECEIPTS.routeGrantMinted,
    };
}

export function mintPeerTcpTunnelRelayAuthorizationV2(
    input: MintPeerTcpTunnelRelayAuthorizationV2Input,
): MintPeerTcpTunnelRelayAuthorizationV2Result {
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
    const flowKind = input.flowKind ?? input.scope.kind;
    if (flowKind !== input.scope.kind) {
        return {
            ok: false,
            reasonCode: "invalid_scope",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }
    if (!isLiteralLoopbackHostname(input.destination.host)) {
        return {
            ok: false,
            reasonCode: "destination_host_not_allowed",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }
    if (
        input.scope.kind === "tcp_tunnel" && !isPeerTcpTunnelRelayPortAllowed({
            port: input.destination.port, grantedPorts: input.scope.allowedPorts, serverAllowedPorts: input.serverCaps.allowedPorts,
            admittedPreview: input.scope.preview,
        })
    ) {
        return {
            ok: false,
            reasonCode: "destination_port_not_allowed",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }
    const budgets = input.scope.kind === "voice_media" ? input.scope : undefined;
    if (
        budgets && (
            (input.serverCaps.maxIdleMs !== undefined && budgets.maxIdleMs !== undefined && budgets.maxIdleMs > input.serverCaps.maxIdleMs)
            || (input.serverCaps.maxDurationMs !== undefined && budgets.maxDurationMs !== undefined && budgets.maxDurationMs > input.serverCaps.maxDurationMs)
            || (input.serverCaps.maxBytes !== undefined && budgets.maxTotalBytes !== undefined && budgets.maxTotalBytes > input.serverCaps.maxBytes)
        )
    ) {
        return {
            ok: false,
            reasonCode: "relay_cap_exceeded",
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }

    const maxIdleMs = budgets?.maxIdleMs ?? input.serverCaps.maxIdleMs;
    const maxDurationMs = budgets?.maxDurationMs ?? input.serverCaps.maxDurationMs;
    const maxTotalBytes = budgets?.maxTotalBytes ?? input.serverCaps.maxBytes;
    const payload: PeerTcpTunnelRelayAuthorizationPayloadV2 = PeerTcpTunnelRelayAuthorizationPayloadV2Schema.parse({
        v: 2,
        grantId: `relay_grant_${randomUUID()}`,
        accountId: input.accountId,
        targetMachineId: input.targetMachineId,
        flowKind,
        routeKind: "server_relay",
        tunnelId: input.scope.tunnelId,
        ...(budgets ? {
            applicationKind: budgets.applicationKind,
            applicationAttemptId: budgets.applicationAttemptId,
            applicationAuthorityDigest: budgets.applicationAuthorityDigest,
        } : {}),
        relaySocketId: input.relaySocketId,
        destination: input.destination,
        capProfileId: input.capProfileId ?? "default",
        maxFrameBytes: input.serverCaps.maxFrameBytes,
        ...(budgets ? {
            ...(maxIdleMs !== undefined ? { maxIdleMs } : {}),
            ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
            ...(maxTotalBytes !== undefined ? { maxTotalBytes } : {}),
        } : {}),
        iat: input.nowMs,
        exp: input.nowMs + input.ttlMs,
        aud: PEER_TCP_TUNNEL_RELAY_AUTHORIZATION_AUDIENCE_V1,
    });
    const signature = tweetnacl.sign.detached(
        Buffer.from(createPeerTcpTunnelRelayAuthorizationSigningInputV2(payload), "utf8"),
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
