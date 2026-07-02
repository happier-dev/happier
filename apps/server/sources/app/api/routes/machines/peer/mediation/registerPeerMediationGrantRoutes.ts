import { z } from "zod";
import type { RouteShorthandOptions } from "fastify";
import {
    DIRECT_ROUTE_GRANT_TTL_MS,
    DirectRouteGrantScopeV1Schema,
    LiveStreamGrantScopeV1Schema,
    MachineLiveStreamCapsV1Schema,
    PeerTcpTunnelDestinationV1Schema,
    PEER_MEDIATION_RECEIPTS,
    TcpTunnelGrantScopeV1Schema,
    clampDirectRouteGrantTtlMs,
    type FeatureId,
    type DirectRouteGrantScopeV1,
    type LiveStreamGrantScopeV1,
    type MachineLiveStreamCapsV1,
    type PeerFlowKindV1,
} from "@happier-dev/protocol";

import { readMachineLiveStreamFeatureEnv, readMachineTunnelFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    createServerFeatureGatePreHandler,
    isPeerMediationGrantSigningAdvertisedForRequest,
} from "@/app/features/catalog/serverFeatureGate";
import {
    mintDirectRouteGrantV1,
    resolvePeerMediationGrantSigningConfig,
} from "@/app/machines/peer/mediation/mintDirectRouteGrantV1";
import { mintMachineLiveStreamRelayAuthorizationV1 } from "@/app/machines/peer/mediation/stream";
import { mintPeerTcpTunnelRelayAuthorizationV1 } from "@/app/machines/peer/mediation/tunnel";

type PeerMediationGrantRouteRequest = Readonly<{
    body?: unknown;
    userId?: unknown;
}>;

type RoutePreHandlerArray = Extract<NonNullable<RouteShorthandOptions["preHandler"]>, readonly unknown[]>;
type RoutePreHandler = RoutePreHandlerArray extends readonly (infer T)[] ? T : never;

type PeerMediationGrantRouteApp = Readonly<{
    authenticate: RoutePreHandler;
    post: (
        path: string,
        opts: RouteShorthandOptions,
        handler: (request: PeerMediationGrantRouteRequest) => unknown | Promise<unknown>,
    ) => void;
}>;

export type RegisterPeerMediationGrantRoutesOptions = Readonly<{
    env?: NodeJS.ProcessEnv;
    nowMs?: () => number;
}>;

const LoopbackPeerMediationGrantRequestSchema = z.object({
    machineId: z.string().min(1),
    flowKind: z.enum(["bounded_transfer", "tcp_tunnel", "live_stream", "machine_rpc"]),
    routeKind: z.literal("loopback_direct"),
    endpointFingerprint: z.string().min(1),
    ttlMs: z.number().int().positive(),
    scope: DirectRouteGrantScopeV1Schema,
}).strict();

const LiveStreamServerRelayAuthorizationRequestSchema = z.object({
    machineId: z.string().min(1),
    targetMachineId: z.string().min(1),
    flowKind: z.literal("live_stream"),
    routeKind: z.literal("server_relay"),
    ttlMs: z.number().int().positive(),
    maxFramesPerSecond: z.number().int().positive(),
    maxFrameBytes: z.number().int().positive(),
    scope: LiveStreamGrantScopeV1Schema,
}).strict();

const TcpTunnelServerRelayAuthorizationRequestSchema = z.object({
    machineId: z.string().min(1),
    flowKind: z.literal("tcp_tunnel"),
    routeKind: z.literal("server_relay"),
    ttlMs: z.number().int().positive(),
    destination: PeerTcpTunnelDestinationV1Schema,
    scope: TcpTunnelGrantScopeV1Schema,
}).strict();

const PeerMediationGrantRequestSchema = z.union([
    LoopbackPeerMediationGrantRequestSchema,
    LiveStreamServerRelayAuthorizationRequestSchema,
    TcpTunnelServerRelayAuthorizationRequestSchema,
]);

function resolveDirectPeerFeatureId(flowKind: PeerFlowKindV1): FeatureId {
    switch (flowKind) {
        case "bounded_transfer":
            return "machines.transfer.directPeer";
        case "tcp_tunnel":
            return "machines.tunnel.directPeer";
        case "live_stream":
            return "machines.liveStream.directPeer";
        case "machine_rpc":
            return "machines.rpc.directPeer";
    }
}

function resolveRouteGrantFeatureId(input: z.infer<typeof PeerMediationGrantRequestSchema>): FeatureId {
    if (input.routeKind === "server_relay") {
        return input.flowKind === "tcp_tunnel"
            ? "machines.tunnel.serverRouted"
            : "machines.liveStream.serverRouted";
    }
    return resolveDirectPeerFeatureId(input.flowKind);
}

function createPeerMediationGrantFeatureGatePreHandler(
    env: NodeJS.ProcessEnv,
): RoutePreHandler {
    return async (request, reply) => {
        const parsed = PeerMediationGrantRequestSchema.safeParse(request.body);
        if (!parsed.success) return undefined;

        const featureId = resolveRouteGrantFeatureId(parsed.data);
        return createServerFeatureGatePreHandler(featureId, env)(request, reply);
    };
}

function createPeerMediationGrantSigningGatePreHandler(
    env: NodeJS.ProcessEnv,
): RoutePreHandler {
    return async (_request, reply) => {
        if (isPeerMediationGrantSigningAdvertisedForRequest(env)) {
            return undefined;
        }
        return reply.code(404).send({ error: "not_found" });
    };
}

function resolveRouteGrantTtlMs(input: Readonly<{
    flowKind: PeerFlowKindV1;
    scope: DirectRouteGrantScopeV1;
    requestedTtlMs: number;
}>): number {
    if (input.flowKind === "bounded_transfer") {
        if (input.scope.kind === "bounded_transfer" && input.scope.mode === "scope") {
            return clampDirectRouteGrantTtlMs(
                input.requestedTtlMs,
                DIRECT_ROUTE_GRANT_TTL_MS.boundedTransferScopedMin,
                DIRECT_ROUTE_GRANT_TTL_MS.boundedTransferScopedMax,
            );
        }
        return DIRECT_ROUTE_GRANT_TTL_MS.boundedTransferSingle;
    }

    if (input.flowKind === "tcp_tunnel") return DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel;
    if (input.flowKind === "live_stream") return DIRECT_ROUTE_GRANT_TTL_MS.directLiveStream;
    return DIRECT_ROUTE_GRANT_TTL_MS.loopbackMachineRpcDefault;
}

function resolveServerRelayedLiveStreamTtlMs(requestedTtlMs: number): number {
    return Math.min(
        Math.max(1, Math.floor(requestedTtlMs)),
        DIRECT_ROUTE_GRANT_TTL_MS.serverRelayedLiveStream,
    );
}

function resolveServerRelayedTcpTunnelTtlMs(requestedTtlMs: number): number {
    return Math.min(
        Math.max(1, Math.floor(requestedTtlMs)),
        DIRECT_ROUTE_GRANT_TTL_MS.serverRelayedTcpTunnel,
    );
}

function buildLiveStreamRelayRequestedCaps(input: Readonly<{
    scope: LiveStreamGrantScopeV1;
    maxFramesPerSecond: number;
    maxFrameBytes: number;
}>): MachineLiveStreamCapsV1 {
    return MachineLiveStreamCapsV1Schema.parse({
        maxBitrateBps: input.scope.maxBitrateBps,
        maxFramesPerSecond: input.maxFramesPerSecond,
        maxFrameBytes: input.maxFrameBytes,
        maxDurationMs: input.scope.maxDurationMs,
        ...(input.scope.maxTotalBytes ? { maxTotalBytes: input.scope.maxTotalBytes } : {}),
    });
}

function validateLiveStreamRelayCaps(input: Readonly<{
    requested: MachineLiveStreamCapsV1;
    serverCaps: MachineLiveStreamCapsV1;
}>): "relay_cap_missing" | "relay_cap_exceeded" | null {
    const requested = input.requested;
    const serverCaps = input.serverCaps;
    if (
        requested.maxBitrateBps > serverCaps.maxBitrateBps
        || requested.maxFramesPerSecond > serverCaps.maxFramesPerSecond
        || requested.maxFrameBytes > serverCaps.maxFrameBytes
        || requested.maxDurationMs > serverCaps.maxDurationMs
    ) {
        return "relay_cap_exceeded";
    }
    if (
        typeof requested.maxTotalBytes === "number"
        && typeof serverCaps.maxTotalBytes === "number"
        && requested.maxTotalBytes > serverCaps.maxTotalBytes
    ) {
        return "relay_cap_exceeded";
    }
    return null;
}

export function registerPeerMediationGrantRoutes(
    app: PeerMediationGrantRouteApp,
    options: RegisterPeerMediationGrantRoutesOptions = {},
): void {
    const env = options.env ?? process.env;
    const nowMs = options.nowMs ?? Date.now;

    app.post("/v1/machines/peer/mediation/route-grants", {
        preHandler: [
            createPeerMediationGrantSigningGatePreHandler(env),
            createPeerMediationGrantFeatureGatePreHandler(env),
            app.authenticate,
        ],
    }, async (request: PeerMediationGrantRouteRequest) => {
        const parsed = PeerMediationGrantRequestSchema.safeParse(request.body);
        if (!parsed.success) {
            return {
                ok: false,
                reasonCode: "invalid_request",
                receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
            };
        }

        const accountId = typeof request.userId === "string" && request.userId.length > 0
            ? request.userId
            : "";
        if (!accountId) {
            return {
                ok: false,
                reasonCode: "unauthenticated",
                receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
            };
        }

        const signing = resolvePeerMediationGrantSigningConfig(env);
        if (!signing.ok) {
            return {
                ok: false,
                reasonCode: "grant_signing_unavailable",
                receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
            };
        }

        if (parsed.data.routeKind === "server_relay") {
            if (parsed.data.flowKind === "tcp_tunnel") {
                const featureEnv = readMachineTunnelFeatureEnv(env);
                return mintPeerTcpTunnelRelayAuthorizationV1({
                    accountId,
                    targetMachineId: parsed.data.machineId,
                    destination: parsed.data.destination,
                    scope: parsed.data.scope,
                    nowMs: nowMs(),
                    ttlMs: resolveServerRelayedTcpTunnelTtlMs(parsed.data.ttlMs),
                    serverGateEnabled: featureEnv.serverRoutedEnabled,
                    serverCaps: {
                        allowedPorts: featureEnv.allowedPorts,
                        maxBytes: featureEnv.serverRoutedMaxBytes,
                        maxFrameBytes: featureEnv.serverRoutedMaxFrameBytes,
                        maxIdleMs: featureEnv.maxIdleMs,
                        maxDurationMs: featureEnv.maxDurationMs,
                    },
                    signingKey: {
                        keyId: signing.keyId,
                        secretKey: signing.secretKey,
                    },
                });
            }

            const featureEnv = readMachineLiveStreamFeatureEnv(env);
            if (!featureEnv.serverRoutedEnabled || !featureEnv.serverRoutedCaps) {
                return {
                    ok: false,
                    reasonCode: "relay_cap_missing",
                    receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
                };
            }
            const requestedCaps = buildLiveStreamRelayRequestedCaps({
                scope: parsed.data.scope,
                maxFramesPerSecond: parsed.data.maxFramesPerSecond,
                maxFrameBytes: parsed.data.maxFrameBytes,
            });
            const capsFailure = validateLiveStreamRelayCaps({
                requested: requestedCaps,
                serverCaps: featureEnv.serverRoutedCaps,
            });
            if (capsFailure) {
                return {
                    ok: false,
                    reasonCode: capsFailure,
                    receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
                };
            }

            return mintMachineLiveStreamRelayAuthorizationV1({
                accountId,
                sourceMachineId: parsed.data.machineId,
                targetMachineId: parsed.data.targetMachineId,
                streamId: parsed.data.scope.streamId,
                streamFamily: parsed.data.scope.streamFamily,
                caps: requestedCaps,
                nowMs: nowMs(),
                ttlMs: resolveServerRelayedLiveStreamTtlMs(parsed.data.ttlMs),
                serverGateEnabled: true,
                signingKey: {
                    keyId: signing.keyId,
                    secretKey: signing.secretKey,
                },
            });
        }

        return mintDirectRouteGrantV1({
            accountId,
            machineId: parsed.data.machineId,
            flowKind: parsed.data.flowKind,
            routeKind: parsed.data.routeKind,
            scope: parsed.data.scope,
            endpointFingerprint: parsed.data.endpointFingerprint,
            nowMs: nowMs(),
            ttlMs: resolveRouteGrantTtlMs({
                flowKind: parsed.data.flowKind,
                scope: parsed.data.scope,
                requestedTtlMs: parsed.data.ttlMs,
            }),
            serverGateEnabled: true,
            signingKey: {
                keyId: signing.keyId,
                secretKey: signing.secretKey,
            },
        });
    });
}
