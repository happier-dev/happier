import { z } from "zod";
import type { RouteShorthandOptions } from "fastify";
import {
    DIRECT_ROUTE_GRANT_TTL_MS,
    DirectRouteGrantScopeV1Schema,
    DirectRouteGrantRequestV2Schema,
    VoiceMediaGrantScopeV1Schema,
    LiveStreamGrantScopeV1Schema,
    MachineLiveStreamCapsV1Schema,
    MachineLiveStreamCodecIdV1Schema,
    PeerTcpTunnelDestinationV1Schema,
    PEER_MEDIATION_RECEIPTS,
    PEER_TCP_TUNNEL_RELAY_SOCKET_ID_MAX_LENGTH,
    TcpTunnelGrantScopeV1Schema,
    clampDirectRouteGrantTtlMs,
    resolvePeerRouteFeatureId,
    DAEMON_VOICE_AUDIO_RELAY_CAP_PROFILE_ID,
    type FeatureId,
    type DirectRouteGrantScopeV1,
    type DirectRouteGrantScopeV2,
    type IrohPeerRouteBindingV2,
    type MachineIrohEndpointAuthorityV1,
    type LiveStreamGrantScopeV1,
    type MachineLiveStreamCapsV1,
    type PeerFlowKindV1,
} from "@happier-dev/protocol";

import { readMachineLiveStreamFeatureEnv, readMachineTunnelFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    readAvailableMachineIrohEndpointAuthority,
} from "@/app/machines/machineStateGuards";
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import {
    createServerFeatureGatePreHandler,
    isPeerMediationGrantSigningAdvertisedForRequest,
    readHomeEffectiveEnv,
} from "@/app/features/catalog/serverFeatureGate";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    mintDirectRouteGrantV1,
    mintDirectRouteGrantV2,
    resolvePeerMediationGrantSigningConfig,
} from "@/app/machines/peer/mediation/mintDirectRouteGrantV1";
import { resolveMachineLiveStreamRelayCaps } from "@/app/machines/peer/mediation/stream/relayCaps";
import { mintMachineLiveStreamRelayAuthorizationV1 } from "@/app/machines/peer/mediation/stream";
import { mintPeerTcpTunnelRelayAuthorizationV2 } from "@/app/machines/peer/mediation/tunnel";
import type { PeerMediationViewerSocketOwnershipVerifier } from "@/app/api/socket/viewerSocketOwnership";
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

type PeerMediationGrantRouteRequest = Readonly<{
    body?: unknown;
    userId?: unknown;
    authAuthority?: "present_user" | "account_automation";
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

export type PeerMediationMachineIrohEndpointAuthorityReader = (params: Readonly<{
    accountId: string;
    machineId: string;
}>) => Promise<MachineIrohEndpointAuthorityV1 | null>;

export type RegisterPeerMediationGrantRoutesOptions = Readonly<{
    env?: NodeJS.ProcessEnv;
    nowMs?: () => number;
    readMachineIrohEndpointAuthority?: PeerMediationMachineIrohEndpointAuthorityReader;
    verifyViewerSocketOwnership?: PeerMediationViewerSocketOwnershipVerifier;
}>;

const LoopbackPeerMediationGrantRequestSchema = z.object({
    machineId: z.string().min(1),
    flowKind: z.enum(["bounded_transfer", "tcp_tunnel", "voice_media", "live_stream", "machine_rpc"]),
    routeKind: z.literal("loopback_direct"),
    endpointFingerprint: z.string().min(1),
    ttlMs: z.number().int().positive(),
    scope: DirectRouteGrantScopeV1Schema,
}).strict();

// Native machine/1 grants use the same signed grant authority as loopback
// mediation, but are admitted only for the endpoint-bound Iroh route. The
// machine/1 binding (initiator, target, both endpoint ids, operation
// kind) is required here; the payload-level invariants (target aliases, flow
// compatibility) are owned by the protocol grant schema and enforced at mint.
const LiveStreamServerRelayAuthorizationRequestSchema = z.object({
    machineId: z.string().min(1),
    targetMachineId: z.string().min(1),
    flowKind: z.literal("live_stream"),
    routeKind: z.literal("server_relay"),
    ttlMs: z.number().int().positive(),
    maxFramesPerSecond: z.number().int().positive().optional(),
    maxFrameBytes: z.number().int().positive().optional(),
    codecId: MachineLiveStreamCodecIdV1Schema.optional(),
    viewerCodecs: z.array(MachineLiveStreamCodecIdV1Schema).optional(),
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

/**
 * The mint gate must consult the same feature bit the client uses to attempt the route and the
 * daemon uses to register the flow it accepts; `resolvePeerRouteFeatureId` in the protocol is the
 * single owner of that mapping.
 */
function resolveRouteGrantFeatureId(input: z.infer<typeof PeerMediationGrantRequestSchema>): FeatureId {
    return resolvePeerRouteFeatureId({ flowKind: input.flowKind, routeKind: input.routeKind });
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
    return async (request, reply) => {
        if (isPeerMediationGrantSigningAdvertisedForRequest(await readHomeEffectiveEnv({ env, request }))) {
            return undefined;
        }
        return reply.code(404).send({ error: "not_found" });
    };
}

function resolveRouteGrantTtlMs(input: Readonly<{
    flowKind: PeerFlowKindV1;
    scope: DirectRouteGrantScopeV1 | DirectRouteGrantScopeV2;
    requestedTtlMs: number;
}>): number {
    if (input.flowKind === "bounded_transfer") {
        if (input.scope.kind === "bounded_transfer" && input.scope.mode === "carrier") {
            return DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier;
        }
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
    maxFramesPerSecond?: number;
    maxFrameBytes?: number;
}>): MachineLiveStreamCapsV1 {
    return MachineLiveStreamCapsV1Schema.parse({
        maxBitrateBps: input.scope.maxBitrateBps,
        maxFramesPerSecond: input.maxFramesPerSecond,
        maxFrameBytes: input.maxFrameBytes,
        maxDurationMs: input.scope.maxDurationMs,
        ...(input.scope.maxTotalBytes ? { maxTotalBytes: input.scope.maxTotalBytes } : {}),
    });
}

export function registerPeerMediationGrantRoutes(
    app: PeerMediationGrantRouteApp,
    options: RegisterPeerMediationGrantRoutesOptions = {},
): void {
    const env = options.env ?? process.env;
    const nowMs = options.nowMs ?? Date.now;
    const readMachineIrohEndpointAuthority =
        options.readMachineIrohEndpointAuthority ?? readAvailableMachineIrohEndpointAuthority;
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
        sharedReasonCode: 'route_unavailable' | 'machine_rpc_method_server_required' = 'route_unavailable',
    ): Promise<{ ok: false; reasonCode: string; receipt: string } | null> {
        for (const machineId of new Set(machineIds)) {
            const admission = await resolveMachineAdmission({ actorAccountId: accountId, machineId });
            // Existing signed carriers have one Account identity, not separate
            // actor/custodian currentness. A share cannot authorize such a ticket.
            const reasonCode = admission.kind === 'denied' ? admission.code
                : admission.custodianAccountId !== accountId ? sharedReasonCode : null;
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

    async function rejectUnlessIrohMachineEndpointsCurrent(
        accountId: string,
        binding: IrohPeerRouteBindingV2,
    ): Promise<{ ok: false; reasonCode: string; receipt: string } | null> {
        const machineEndpoints = [
            { machineId: binding.target.machineId, endpointId: binding.target.endpointId },
            ...(binding.initiator.kind === "machine"
                ? [{
                    machineId: binding.initiator.machineId,
                    endpointId: binding.initiator.endpointId,
                }]
                : []),
        ];
        for (const expected of machineEndpoints) {
            const authority = await readMachineIrohEndpointAuthority({
                accountId,
                machineId: expected.machineId,
            });
            if (!authority) {
                return {
                    ok: false,
                    reasonCode: "machine_iroh_endpoint_unavailable",
                    receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
                };
            }
            if (authority.endpointId !== expected.endpointId) {
                return {
                    ok: false,
                    reasonCode: "machine_iroh_endpoint_mismatch",
                    receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
                };
            }
        }
        return null;
    }

    app.post("/v1/machines/peer/mediation/route-grants", {
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(env, "machines.peerMediation.routeGrant"),
        },
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

        // Only the preview access owner can mint resource/policy-bound authority.
        if (parsed.data.scope.kind === 'tcp_tunnel' && parsed.data.scope.preview) {
            return { ok: false, reasonCode: 'invalid_scope', receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected };
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
                        scope: parsed.data.scope,
                        nowMs: nowMs(),
                        ttlMs: resolveServerRelayedTcpTunnelTtlMs(parsed.data.ttlMs),
                        serverGateEnabled: liveStreamFeatureEnv.serverRoutedEnabled,
                        serverCaps: {
                            allowedPorts: tunnelFeatureEnv.allowedPorts,
                            maxBytes: liveStreamFeatureEnv.serverRoutedCaps.maxTotalBytes,
                            maxFrameBytes: liveStreamFeatureEnv.serverRoutedCaps.maxFrameBytes ?? tunnelFeatureEnv.serverRoutedMaxFrameBytes,
                            maxDurationMs: liveStreamFeatureEnv.serverRoutedCaps.maxDurationMs,
                        },
                        capProfileId: DAEMON_VOICE_AUDIO_RELAY_CAP_PROFILE_ID,
                        flowKind: "voice_media",
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
                        maxFrameBytes: featureEnv.serverRoutedMaxFrameBytes,
                    },
                    signingKey: {
                        keyId: signing.keyId,
                        secretKey: signing.secretKey,
                    },
                });
            }

            const viewerSocketOwnershipRejection = await rejectUnlessUserSocketOwned(
                accountId,
                parsed.data.viewerSocketId,
                "viewer_socket_not_owned",
            );
            if (viewerSocketOwnershipRejection) return viewerSocketOwnershipRejection;
            const ownershipRejection = await rejectUnlessMachinesOwned(accountId, [
                parsed.data.machineId,
                parsed.data.targetMachineId,
            ]);
            if (ownershipRejection) return ownershipRejection;

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
            const effectiveCaps = resolveMachineLiveStreamRelayCaps({
                requested: requestedCaps,
                serverCaps: featureEnv.serverRoutedCaps,
            });
            if (!effectiveCaps) {
                return {
                    ok: false,
                    reasonCode: "relay_cap_exceeded",
                    receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected,
                };
            }

            return mintMachineLiveStreamRelayAuthorizationV1({
                accountId,
                sourceMachineId: parsed.data.machineId,
                targetMachineId: parsed.data.targetMachineId,
                streamId: parsed.data.scope.streamId,
                streamFamily: parsed.data.scope.streamFamily,
                ...(parsed.data.scope.sourceId ? { sourceId: parsed.data.scope.sourceId } : {}),
                ...(parsed.data.viewerSocketId ? { viewerSocketId: parsed.data.viewerSocketId } : {}),
                ...(parsed.data.codecId ? { codecId: parsed.data.codecId } : {}),
                ...(parsed.data.viewerCodecs ? { viewerCodecs: parsed.data.viewerCodecs } : {}),
                caps: effectiveCaps,
                nowMs: nowMs(),
                ttlMs: resolveServerRelayedLiveStreamTtlMs(parsed.data.ttlMs),
                serverGateEnabled: true,
                signingKey: {
                    keyId: signing.keyId,
                    secretKey: signing.secretKey,
                },
            });
        }

        const irohBinding: IrohPeerRouteBindingV2 | undefined = "iroh" in parsed.data
            ? parsed.data.iroh
            : undefined;
        const directOwnershipRejection = await rejectUnlessMachinesOwned(accountId, [
            parsed.data.machineId,
            ...(irohBinding?.initiator.kind === "machine"
                ? [irohBinding.initiator.machineId]
                : []),
        ], parsed.data.flowKind === 'machine_rpc' ? 'machine_rpc_method_server_required' : 'route_unavailable');
        if (directOwnershipRejection) return directOwnershipRejection;
        if (irohBinding) {
            const endpointAuthorityRejection = await rejectUnlessIrohMachineEndpointsCurrent(
                accountId,
                irohBinding,
            );
            if (endpointAuthorityRejection) return endpointAuthorityRejection;
        }

        const directGrantInput = {
            accountId,
            machineId: parsed.data.machineId,
            flowKind: parsed.data.flowKind,
            routeKind: parsed.data.routeKind,
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
                expiresAt: signing.capability.expiresAt,
            },
        };
        if ("v" in parsed.data && parsed.data.v === 2) {
            return mintDirectRouteGrantV2({
                ...directGrantInput,
                scope: parsed.data.scope,
                ...(parsed.data.scope.kind === 'machine_rpc'
                    && parsed.data.scope.allowedMethods.some(method => method === RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE
                        || method === RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START)
                    ? { callerAuthority: request.authAuthority === 'present_user' ? 'present_user' as const : 'account_automation' as const }
                    : {}),
                ...(irohBinding ? { iroh: irohBinding } : {}),
                ephemeralPublicKeyBase64Url: parsed.data.ephemeralPublicKeyBase64Url,
            });
        }
        return mintDirectRouteGrantV1({
            ...directGrantInput,
            scope: DirectRouteGrantScopeV1Schema.parse(parsed.data.scope),
        });
    });
}
