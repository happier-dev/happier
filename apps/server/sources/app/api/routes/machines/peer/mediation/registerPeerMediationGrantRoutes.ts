import { z } from "zod";
import type { RouteShorthandOptions } from "fastify";
import {
    DIRECT_ROUTE_GRANT_TTL_MS,
    DirectRouteGrantScopeV1Schema,
    DirectRouteGrantRequestV2Schema,
    VoiceMediaGrantScopeV1Schema,
    LiveStreamGrantScopeV1Schema,
    MachineLiveStreamCapsV1Schema,
    PeerTcpTunnelDestinationV1Schema,
    PEER_MEDIATION_RECEIPTS,
    PEER_TCP_TUNNEL_RELAY_SOCKET_ID_MAX_LENGTH,
    TcpTunnelGrantScopeV1Schema,
    clampDirectRouteGrantTtlMs,
    DAEMON_VOICE_AUDIO_RELAY_CAP_PROFILE_ID,
    type FeatureId,
    type DirectRouteGrantScopeV1,
    type LiveStreamGrantScopeV1,
    type MachineLiveStreamCapsV1,
    type PeerFlowKindV1,
} from "@happier-dev/protocol";

import { readMachineLiveStreamFeatureEnv, readMachineTunnelFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    readMachineAvailabilityState,
    type MachineAvailabilityState,
} from "@/app/machines/machineStateGuards";
import {
    createServerFeatureGatePreHandler,
    isPeerMediationGrantSigningAdvertisedForRequest,
} from "@/app/features/catalog/serverFeatureGate";
import {
    mintDirectRouteGrantV1,
    mintDirectRouteGrantV2,
    resolvePeerMediationGrantSigningConfig,
} from "@/app/machines/peer/mediation/mintDirectRouteGrantV1";
import { mintMachineLiveStreamRelayAuthorizationV1 } from "@/app/machines/peer/mediation/stream";
import { mintPeerTcpTunnelRelayAuthorizationV2 } from "@/app/machines/peer/mediation/tunnel";
import type { PeerMediationViewerSocketOwnershipVerifier } from "@/app/api/socket/viewerSocketOwnership";

type PeerMediationGrantRouteRequest = Readonly<{
    body?: unknown;
    userId?: unknown;
}>;

type RoutePreHandlerArray = Extract<NonNullable<RouteShorthandOptions["preHandler"]>, readonly unknown[]>;
type RoutePreHandler = RoutePreHandlerArray extends readonly (infer T)[] ? T : never;

type PeerMediationGrantRouteApp = Readonly<{
    authenticate: RoutePreHandler;
    verifyPeerMediationViewerSocketOwnership?: PeerMediationViewerSocketOwnershipVerifier;
    post: (
        path: string,
        opts: RouteShorthandOptions,
        handler: (request: PeerMediationGrantRouteRequest) => unknown | Promise<unknown>,
    ) => void;
}>;

/**
 * Ownership-state reader (C2). The mint route signs client-supplied machine ids; before signing
 * ANY grant we must confirm each referenced machine is an `available` machine owned by the
 * authenticated account. Injectable so route tests can supply ownership facts without a live db;
 * the production default reads `db.machine` via `readMachineAvailabilityState`.
 */
export type PeerMediationMachineOwnershipReader = (params: Readonly<{
    accountId: string;
    machineId: string;
}>) => Promise<MachineAvailabilityState>;

export type RegisterPeerMediationGrantRoutesOptions = Readonly<{
    env?: NodeJS.ProcessEnv;
    nowMs?: () => number;
    readMachineOwnershipState?: PeerMediationMachineOwnershipReader;
    verifyViewerSocketOwnership?: PeerMediationViewerSocketOwnershipVerifier;
}>;

/**
 * Maps a non-available ownership state to the grant-rejection reason code (C2). `available`
 * returns null (passes). A `missing` machine covers the "a profile id is never accepted as a
 * machine id" case — a profile id will never resolve to an owned `db.machine` row.
 */
function ownershipRejectionReasonCode(state: MachineAvailabilityState): string | null {
    switch (state) {
        case "available":
            return null;
        case "revoked":
            return "machine_revoked";
        case "replaced":
            return "machine_replaced";
        case "missing":
            return "machine_not_owned";
    }
}

const LoopbackPeerMediationGrantRequestSchema = z.object({
    machineId: z.string().min(1),
    flowKind: z.enum(["bounded_transfer", "tcp_tunnel", "voice_media", "live_stream", "machine_rpc"]),
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
    // Optional per-tab viewer socket id (C1). When the watcher is a user-scoped browser socket the
    // grant is minted bound to it so the relay delivers frames to exactly that tab. It is part of
    // the signed payload, so it must round-trip mint → start-request → handler-verify unchanged.
    viewerSocketId: z.string().min(1).optional(),
    scope: LiveStreamGrantScopeV1Schema,
}).strict();

const TcpTunnelServerRelayAuthorizationRequestSchema = z.object({
    v: z.literal(2),
    machineId: z.string().min(1),
    flowKind: z.literal("tcp_tunnel"),
    routeKind: z.literal("server_relay"),
    ttlMs: z.number().int().positive(),
    destination: PeerTcpTunnelDestinationV1Schema,
    relaySocketId: z.string().min(1).max(PEER_TCP_TUNNEL_RELAY_SOCKET_ID_MAX_LENGTH),
    scope: TcpTunnelGrantScopeV1Schema,
}).strict();

const VoiceMediaServerRelayAuthorizationRequestSchema = z.object({
    v: z.literal(2),
    machineId: z.string().min(1),
    flowKind: z.literal("voice_media"),
    routeKind: z.literal("server_relay"),
    ttlMs: z.number().int().positive(),
    destination: PeerTcpTunnelDestinationV1Schema,
    relaySocketId: z.string().min(1).max(PEER_TCP_TUNNEL_RELAY_SOCKET_ID_MAX_LENGTH),
    scope: VoiceMediaGrantScopeV1Schema,
}).strict();

const PeerMediationGrantRequestSchema = z.union([
    DirectRouteGrantRequestV2Schema,
    LoopbackPeerMediationGrantRequestSchema,
    LiveStreamServerRelayAuthorizationRequestSchema,
    TcpTunnelServerRelayAuthorizationRequestSchema,
    VoiceMediaServerRelayAuthorizationRequestSchema,
]);

function resolveDirectPeerFeatureId(flowKind: PeerFlowKindV1): FeatureId {
    switch (flowKind) {
        case "bounded_transfer":
            return "machines.transfer.directPeer";
        case "tcp_tunnel":
            return "machines.tunnel.directPeer";
        case "voice_media":
            return "machines.liveStream.directPeer";
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
    if (input.flowKind === "voice_media") return DIRECT_ROUTE_GRANT_TTL_MS.directLiveStream;
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
    const readMachineOwnershipState = options.readMachineOwnershipState ?? readMachineAvailabilityState;
    const verifyViewerSocketOwnership =
        options.verifyViewerSocketOwnership ?? app.verifyPeerMediationViewerSocketOwnership;

    /**
     * Validate that every referenced machine id is an `available` machine owned by the
     * authenticated account BEFORE signing (C2). Returns a `routeGrantRejected` response on the
     * first failure, else null. De-duplicates ids so source/target equality is checked once.
     */
    async function rejectUnlessMachinesOwned(
        accountId: string,
        machineIds: readonly string[],
    ): Promise<{ ok: false; reasonCode: string; receipt: string } | null> {
        for (const machineId of new Set(machineIds)) {
            const state = await readMachineOwnershipState({ accountId, machineId });
            const reasonCode = ownershipRejectionReasonCode(state);
            if (reasonCode) {
                return {
                    ok: false,
                    reasonCode,
                    receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
                };
            }
        }
        return null;
    }

    async function rejectUnlessUserSocketOwned(
        accountId: string,
        socketId: string | undefined,
        reasonCode: "viewer_socket_not_owned" | "relay_socket_not_owned",
    ): Promise<{ ok: false; reasonCode: string; receipt: string } | null> {
        if (!socketId) return null;
        const owned = await verifyViewerSocketOwnership?.({ accountId, socketId });
        if (owned === true) return null;
        return {
            ok: false,
            reasonCode,
            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
        };
    }

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
            if (parsed.data.flowKind === "tcp_tunnel" || parsed.data.flowKind === "voice_media") {
                const relaySocketOwnershipRejection = await rejectUnlessUserSocketOwned(
                    accountId,
                    parsed.data.relaySocketId,
                    "relay_socket_not_owned",
                );
                if (relaySocketOwnershipRejection) return relaySocketOwnershipRejection;
                const ownershipRejection = await rejectUnlessMachinesOwned(accountId, [parsed.data.machineId]);
                if (ownershipRejection) return ownershipRejection;

                if (parsed.data.flowKind === "voice_media") {
                    const liveStreamFeatureEnv = readMachineLiveStreamFeatureEnv(env);
                    const tunnelFeatureEnv = readMachineTunnelFeatureEnv(env);
                    if (!liveStreamFeatureEnv.serverRoutedEnabled || !liveStreamFeatureEnv.serverRoutedCaps) {
                        return {
                            ok: false,
                            reasonCode: "relay_cap_missing",
                            receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
                        };
                    }
                    return mintPeerTcpTunnelRelayAuthorizationV2({
                        accountId,
                        targetMachineId: parsed.data.machineId,
                        relaySocketId: parsed.data.relaySocketId,
                        destination: parsed.data.destination,
                        scope: {
                            kind: "tcp_tunnel",
                            tunnelId: parsed.data.scope.tunnelId,
                            allowedPorts: [parsed.data.destination.port],
                            maxIdleMs: parsed.data.scope.maxIdleMs,
                            maxDurationMs: parsed.data.scope.maxDurationMs,
                            ...(parsed.data.scope.maxTotalBytes !== undefined
                                ? { maxTotalBytes: parsed.data.scope.maxTotalBytes }
                                : {}),
                        },
                        nowMs: nowMs(),
                        ttlMs: resolveServerRelayedTcpTunnelTtlMs(parsed.data.ttlMs),
                        serverGateEnabled: liveStreamFeatureEnv.serverRoutedEnabled,
                        serverCaps: {
                            allowedPorts: tunnelFeatureEnv.allowedPorts,
                            maxBytes: liveStreamFeatureEnv.serverRoutedCaps.maxTotalBytes,
                            maxFrameBytes: liveStreamFeatureEnv.serverRoutedCaps.maxFrameBytes,
                            maxIdleMs: Math.min(
                                tunnelFeatureEnv.maxIdleMs,
                                liveStreamFeatureEnv.serverRoutedCaps.maxDurationMs,
                            ),
                            maxDurationMs: Math.min(
                                tunnelFeatureEnv.maxDurationMs,
                                liveStreamFeatureEnv.serverRoutedCaps.maxDurationMs,
                            ),
                        },
                        capProfileId: DAEMON_VOICE_AUDIO_RELAY_CAP_PROFILE_ID,
                        flowKind: "voice_media",
                        applicationAuthority: {
                            v: 1,
                            applicationKind: parsed.data.scope.applicationKind,
                            applicationAttemptId: parsed.data.scope.applicationAttemptId,
                            applicationAuthorityDigest: parsed.data.scope.applicationAuthorityDigest,
                        },
                        signingKey: {
                            keyId: signing.keyId,
                            secretKey: signing.secretKey,
                        },
                    });
                }

                const featureEnv = readMachineTunnelFeatureEnv(env);
                return mintPeerTcpTunnelRelayAuthorizationV2({
                    accountId,
                    targetMachineId: parsed.data.machineId,
                    relaySocketId: parsed.data.relaySocketId,
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

            const ownershipRejection = await rejectUnlessMachinesOwned(accountId, [
                parsed.data.machineId,
                parsed.data.targetMachineId,
            ]);
            if (ownershipRejection) return ownershipRejection;
            const viewerSocketOwnershipRejection = await rejectUnlessUserSocketOwned(
                accountId,
                parsed.data.viewerSocketId,
                "viewer_socket_not_owned",
            );
            if (viewerSocketOwnershipRejection) return viewerSocketOwnershipRejection;

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
                ...(parsed.data.viewerSocketId ? { viewerSocketId: parsed.data.viewerSocketId } : {}),
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

        const directOwnershipRejection = await rejectUnlessMachinesOwned(accountId, [parsed.data.machineId]);
        if (directOwnershipRejection) return directOwnershipRejection;

        const directGrantInput = {
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
        };
        return "v" in parsed.data && parsed.data.v === 2
            ? mintDirectRouteGrantV2({
                ...directGrantInput,
                ephemeralPublicKeyBase64Url: parsed.data.ephemeralPublicKeyBase64Url,
            })
            : mintDirectRouteGrantV1(directGrantInput);
    });
}
