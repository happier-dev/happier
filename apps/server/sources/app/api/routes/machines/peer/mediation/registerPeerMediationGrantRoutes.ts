import { z } from "zod/mini";
import type { RouteShorthandOptions, FastifyRequest } from "fastify";
import { DIRECT_ROUTE_GRANT_TTL_MS, clampDirectRouteGrantTtlMs } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { DirectRouteGrantScopeV1Schema, VoiceMediaGrantScopeV1Schema, LiveStreamGrantScopeV1Schema, TcpTunnelGrantScopeV1Schema, type DirectRouteGrantScopeV1, type LiveStreamGrantScopeV1 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantScopesV1';
import { DirectRouteGrantRequestV2Schema, type DirectRouteGrantScopeV2, type IrohPeerRouteBindingV2 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { MachineLiveStreamCapsV1Schema, MachineLiveStreamSourceAdmissionV1Schema, type MachineLiveStreamCapsV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { MachineLiveStreamCodecIdV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/codecsV1';
import { PeerTcpTunnelDestinationV1Schema } from '@happier-dev/protocol/machines/peer/mediation/tunnel/v1';
import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import { PEER_TCP_TUNNEL_RELAY_SOCKET_ID_MAX_LENGTH } from '@happier-dev/protocol/machines/peer/mediation/tunnel/authorizationSchemas';
import { resolvePeerRouteFeatureId } from '@happier-dev/protocol/machines/peer/mediation/routeFeature';
import { DAEMON_VOICE_AUDIO_RELAY_CAP_PROFILE_ID } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { type FeatureId } from '@happier-dev/protocol/features/catalog';
import { type MachineIrohEndpointAuthorityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { type PeerFlowKindV1 } from '@happier-dev/protocol/machines/peer/mediation/flowKind';

import { readMachineLiveStreamFeatureEnv, readMachineTunnelFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    readAvailableMachineIrohEndpointAuthority,
    readAvailableMachineIrohTransportEndpointAuthority,
} from "@/app/machines/machineStateGuards";
import { resolveMachineAdmission, resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { inTx } from '@/storage/inTx';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import {
    createServerFeatureGatePreHandler,
    isPeerMediationGrantSigningAdvertisedForRequest,
    readHomeEffectiveEnv,
} from "@/app/features/catalog/serverFeatureGate";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    mintDirectRouteGrantV1,
    mintDirectRouteGrantV2,
    isWorkspaceSyncMachineCarrierGrant,
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
}> & Partial<Pick<FastifyRequest, 'externalActionExecutionAuthorized' | 'externalActionExecutionAuthorizationBinding'
    | 'externalActionDeploymentChildMachineRead' | 'externalActionDeploymentChildSigner' | 'authTokenAuthenticationEvidence'>>;

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
    readMachineIrohTransportEndpointAuthority?: (params: Readonly<{ machineId: string }>) => Promise<MachineIrohEndpointAuthorityV1 | null>;
    verifyViewerSocketOwnership?: PeerMediationViewerSocketOwnershipVerifier;
}>;

const LoopbackPeerMediationGrantRequestSchema = z.strictObject({
    machineId: z.string().check(z.minLength(1)),
    flowKind: z.enum(["bounded_transfer", "tcp_tunnel", "voice_media", "live_stream", "machine_rpc"]),
    routeKind: z.literal("loopback_direct"),
    endpointFingerprint: z.string().check(z.minLength(1)),
    ttlMs: z.number().check(z.int(), z.positive()),
    scope: DirectRouteGrantScopeV1Schema,
});

// Native machine/1 grants use the same signed grant authority as loopback
// mediation, but are admitted only for the endpoint-bound Iroh route. The
// machine/1 binding (initiator, target, both endpoint ids, operation
// kind) is required here; the payload-level invariants (target aliases, flow
// compatibility) are owned by the protocol grant schema and enforced at mint.
const LiveStreamServerRelayAuthorizationRequestSchema = z.strictObject({
    machineId: z.string().check(z.minLength(1)),
    targetMachineId: z.string().check(z.minLength(1)),
    flowKind: z.literal("live_stream"),
    routeKind: z.literal("server_relay"),
    ttlMs: z.number().check(z.int(), z.positive()),
    maxFramesPerSecond: z.optional(z.number().check(z.int(), z.positive())),
    maxFrameBytes: z.optional(z.number().check(z.int(), z.positive())),
    codecId: z.optional(MachineLiveStreamCodecIdV1Schema),
    viewerCodecs: z.optional(z.array(MachineLiveStreamCodecIdV1Schema)),
    // Optional per-tab viewer socket id (C1). When the watcher is a user-scoped browser socket the
    // grant is minted bound to it so the relay delivers frames to exactly that tab. It is part of
    // the signed payload, so it must round-trip mint → start-request → handler-verify unchanged.
    viewerSocketId: z.optional(z.string().check(z.minLength(1))),
    sourceAdmission: z.optional(MachineLiveStreamSourceAdmissionV1Schema),
    scope: LiveStreamGrantScopeV1Schema,
});

const TcpTunnelServerRelayAuthorizationRequestSchema = z.strictObject({
    v: z.literal(2),
    machineId: z.string().check(z.minLength(1)),
    flowKind: z.literal("tcp_tunnel"),
    routeKind: z.literal("server_relay"),
    ttlMs: z.number().check(z.int(), z.positive()),
    destination: PeerTcpTunnelDestinationV1Schema,
    relaySocketId: z.string().check(z.minLength(1), z.maxLength(PEER_TCP_TUNNEL_RELAY_SOCKET_ID_MAX_LENGTH)),
    scope: TcpTunnelGrantScopeV1Schema,
});

const VoiceMediaServerRelayAuthorizationRequestSchema = z.strictObject({
    v: z.literal(2),
    machineId: z.string().check(z.minLength(1)),
    flowKind: z.literal("voice_media"),
    routeKind: z.literal("server_relay"),
    ttlMs: z.number().check(z.int(), z.positive()),
    destination: PeerTcpTunnelDestinationV1Schema,
    relaySocketId: z.string().check(z.minLength(1), z.maxLength(PEER_TCP_TUNNEL_RELAY_SOCKET_ID_MAX_LENGTH)),
    scope: VoiceMediaGrantScopeV1Schema,
});

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
    const readMachineIrohTransportEndpointAuthority =
        options.readMachineIrohTransportEndpointAuthority ?? readAvailableMachineIrohTransportEndpointAuthority;
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
        sharedReasonCode: 'route_unavailable' | 'machine_rpc_method_server_required' | null = 'route_unavailable',
    ): Promise<{ ok: false; reasonCode: string; receipt: string } | null> {
        for (const machineId of new Set(machineIds)) {
            const admission = await resolveMachineAdmission({ actorAccountId: accountId, machineId });
            // Custodian carriers have one Account identity. Personal live viewing
            // instead consumes the installed source admission at its mint boundary.
            // A null shared code admits current shared access (transport-only grants).
            const reasonCode = admission.kind === 'denied' ? admission.code
                : sharedReasonCode !== null && admission.custodianAccountId !== accountId ? sharedReasonCode : null;
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
        transportOnly = false,
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
            const authority = transportOnly ? await readMachineIrohTransportEndpointAuthority({ machineId: expected.machineId }) : await readMachineIrohEndpointAuthority({
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

        // Preview authority belongs to its access owner. Service exports use
        // only the endpoint-bound V2 carrier and B's local export admission.
        if (parsed.data.scope.kind === 'tcp_tunnel' && (parsed.data.scope.preview
            || parsed.data.scope.serviceExport && !("v" in parsed.data && parsed.data.v === 2
                && parsed.data.routeKind === 'iroh_peer'))) {
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
            const sourceAdmission = parsed.data.sourceAdmission;
            let personalSourceCustodianAccountId: string | undefined;
            if (sourceAdmission) {
                const binding = sourceAdmission.payload.liveStreamSourceAdmission;
                const sourceDenied = { ok: false, reasonCode: 'capture_source_denied', receipt: PEER_MEDIATION_RECEIPTS.routeGrantRejected } as const;
                if (request.authAuthority !== 'present_user' || !parsed.data.viewerSocketId
                    || parsed.data.machineId !== parsed.data.targetMachineId
                    || sourceAdmission.payload.machineId !== parsed.data.machineId
                    || binding.actorAccountId !== accountId
                    || binding.streamFamily !== parsed.data.scope.streamFamily
                    || binding.sourceId !== parsed.data.scope.sourceId
                    || binding.homeServerIdentityId !== await getOrCreateServerIdentityId()) return sourceDenied;
                const admitted = await inTx(async tx => {
                    const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: accountId,
                        machineId: sourceAdmission.payload.machineId, requireOnline: true,
                        callerAuthority: 'present_user', rpcMethod: RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT });
                    if (admission.kind !== 'admitted') return null;
                    if (admission.custodianAccountId !== sourceAdmission.payload.accountId
                        || admission.installationId !== sourceAdmission.payload.installationId) return null;
                    const machine = await tx.machine.findUnique({ where: { id: admission.machineId }, select: { installationPublicKey: true } });
                    if (!machine?.installationPublicKey || !verifyMachineInstallationProof({
                        payload: sourceAdmission.payload, proof: sourceAdmission.proof, publicKey: machine.installationPublicKey,
                    })) return null;
                    return admission;
                });
                if (!admitted) return sourceDenied;
                personalSourceCustodianAccountId = admitted.custodianAccountId;
            } else {
                const ownershipRejection = await rejectUnlessMachinesOwned(accountId, [
                    parsed.data.machineId,
                    parsed.data.targetMachineId,
                ]);
                if (ownershipRejection) return ownershipRejection;
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
                accountId: personalSourceCustodianAccountId ?? accountId,
                sourceMachineId: parsed.data.machineId,
                targetMachineId: parsed.data.targetMachineId,
                streamId: parsed.data.scope.streamId,
                streamFamily: parsed.data.scope.streamFamily,
                ...(parsed.data.scope.sourceId ? { sourceId: parsed.data.scope.sourceId } : {}),
                ...(parsed.data.viewerSocketId ? { viewerSocketId: parsed.data.viewerSocketId } : {}),
                ...(sourceAdmission ? { personalViewer: { viewerAccountId: accountId,
                    sourceMachineInstallationId: sourceAdmission.payload.installationId,
                    personalSourceAdmission: sourceAdmission.payload.liveStreamSourceAdmission } } : {}),
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
        const childAdmission = request.externalActionDeploymentChildMachineRead;
        const childSigner = request.externalActionDeploymentChildSigner;
        const workspaceCarrier = isWorkspaceSyncMachineCarrierGrant({
            routeKind: parsed.data.routeKind, scope: parsed.data.scope, iroh: irohBinding,
        });
        // B resolves its signed binding against the current local export at
        // inner open. Home admits only this authenticated actor's A/B access.
        const serviceExportCarrier = parsed.data.routeKind === 'iroh_peer'
            && parsed.data.scope.kind === 'tcp_tunnel' && parsed.data.scope.serviceExport !== undefined;
        // Authentication already admitted the exact child and codec holder.
        // Consume its typed result rather than repeating job/receiver admission.
        // The exact native Sync envelope grants transport only, so current
        // shared Machine access suffices. Its receiving prepared target owns
        // filesystem authority and binds the signed actor.
        const directOwnershipRejection = childAdmission && !serviceExportCarrier ? null : await rejectUnlessMachinesOwned(accountId, [
            parsed.data.machineId,
            ...(irohBinding?.initiator.kind === "machine"
                ? [irohBinding.initiator.machineId]
                : []),
        ], workspaceCarrier || serviceExportCarrier ? null
            : parsed.data.flowKind === 'machine_rpc' ? 'machine_rpc_method_server_required' : 'route_unavailable');
        if (directOwnershipRejection) return directOwnershipRejection;
        if (irohBinding) {
            const endpointAuthorityRejection = await rejectUnlessIrohMachineEndpointsCurrent(
                childAdmission?.codecAdmission.custodianAccountId ?? accountId,
                irohBinding,
                workspaceCarrier || serviceExportCarrier,
            );
            if (endpointAuthorityRejection) return endpointAuthorityRejection;
        }

        const directGrantInput = {
            accountId: childAdmission && childSigner && !serviceExportCarrier ? childSigner.custodianAccountId : accountId,
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
                        || method === RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START
                        || method === RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT
                        || method === RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_PERSONAL_RELAY_START
                        || method === RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE
                        || method === RPC_METHODS.DAEMON_COMPUTER_PERSONAL_ACTION_EXECUTE
                        || method === RPC_METHODS.DAEMON_BROWSER_VIEW_LIST
                        || method === RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH)
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
