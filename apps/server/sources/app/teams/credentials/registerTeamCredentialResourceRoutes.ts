import { TeamCredentialErrorCodeV1Schema, teamCredentialErrorHttpStatusV1, TeamCredentialResourceAudienceInputV1Schema, TeamCredentialResourceCreateInputV1Schema, TeamCredentialResourceDeleteInputV1Schema, TeamCredentialResourceErrorV1Schema, TeamCredentialResourcePageV1Schema, TeamCredentialResourceEntitledPageV1Schema, TeamCredentialResourceGetInputV1Schema, TeamCredentialResourceReadInputV1Schema, TeamCredentialResourceListInputV1Schema, TeamCredentialResourceSummaryV1Schema, TeamCredentialResourceMutationResultV1Schema, TeamCredentialResourceUpdateInputV1Schema, TeamCredentialResourceActivityReadInputV1Schema, TeamCredentialResourceActivityPageV1Schema, TeamCredentialRequestPolicySupportInputV1Schema, TeamCredentialRequestPolicySupportOutputV1Schema, type TeamCredentialErrorCodeV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { TeamCredentialTestActionInputV1Schema, TeamCredentialTestActionOutputV1Schema, TeamCredentialPreparationOutputV1Schema } from '@happier-dev/protocol/teams/credentials/actionsV1';
import { TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, TeamCredentialResourceDiscoverInputV1Schema, TeamCredentialResourceDiscoveryPageV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { TeamCredentialSourceCandidateListInputV1Schema, TeamCredentialSourceCandidateListOutputV1Schema, TeamCredentialSourceResourceListInputV1Schema, TeamCredentialSourceResourceListOutputV1Schema, TeamCredentialSourceResourceAdministrationV1Schema, TeamCredentialUsageLimitDeleteInputV1Schema, TeamCredentialUsageLimitListInputV1Schema, TeamCredentialUsageLimitListOutputV1Schema, TeamCredentialUsageLimitUpsertInputV1Schema, TeamCredentialUsageLimitUpsertOutputV1Schema, TeamCredentialUsageQueryInputV1Schema, TeamCredentialUsageQueryResultV1Schema, TeamCredentialExternalApiKeyCreateInputV1Schema, TeamCredentialExternalApiKeyAuthorizeInputV1Schema, TeamCredentialExternalApiKeyAuthorizeOutputV1Schema, TeamCredentialExternalApiKeyCreateOutputV1Schema, TeamCredentialExternalApiKeyListInputV1Schema, TeamCredentialExternalApiKeyListOutputV1Schema, TeamCredentialExternalApiKeyRevokeInputV1Schema, TeamCredentialExternalApiKeyRevokeOutputV1Schema, TeamCredentialExternalApiKeyRevokeAllInputV1Schema, TeamCredentialExternalApiKeyRevokeAllOutputV1Schema } from '@happier-dev/protocol/teams';
import { RunnerBrokerReadinessRequestV1Schema } from '@happier-dev/protocol/ephemeralRunner/brokerReadinessRequestV1';
import { RunnerBrokerReadinessResponseV1Schema } from '@happier-dev/protocol/teams/credentials/readinessV1';
import { TeamCredentialDirectMaterialRouteParamsV1Schema, TeamCredentialDirectMaterialReadQueryV1Schema, TeamCredentialDirectMaterialMineResponseV1Schema, TeamCredentialDirectMaterialOpenRequestV1Schema, TeamCredentialDirectMaterialPreparationResponseV1Schema, TeamCredentialDirectMaterialUpsertRequestV1Schema, TeamCredentialDirectMaterialUpsertResponseV1Schema, TeamCredentialDirectMaterialWithdrawRequestV1Schema, TeamCredentialDirectMaterialWithdrawResponseV1Schema } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { TeamCredentialNativeBindingReadRequestV1Schema, TeamCredentialNativeBindingReadResponseV1Schema } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { readManagedNativeCredentialBindingForGuestInTx } from '@/app/machines/managed/credentialDeliveryAdmission';
import { TeamCredentialDirectMaterialCensusOutputV1Schema } from '@happier-dev/protocol/teams/credentials/directMaterialCensusV1';
import { PROVIDER_BROKER_READINESS_AUTHORIZE_HTTP_PATH_V1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { resolveTeamCredentialExternalApiAvailability } from '@happier-dev/protocol/features/payload/capabilities/teamCredentialCapabilities';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { parseProviderContributionIdentityV1 } from "@happier-dev/protocol/providers/contribution-identity";
import { DaemonProviderConnectionsDescribeResponseV1Schema, DaemonProviderTeamCredentialBrokerEligibilityResponseV1Schema, DaemonProviderTeamCredentialResourceTestCandidateResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { z } from "zod/mini";
import { logger } from "@/utils/logging/log";
import type { Fastify } from "@/app/api/types";
import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import { AccountRouteAuthenticationForbiddenResponseSchema } from "@/app/api/utils/enableAuthentication";
import { inTx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import { readHomeEffectiveEnv, resolveServerFeaturesForGating } from "@/app/features/catalog/serverFeatureGate";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { readTeamOperationAuthenticationFromRequest } from "../actorContext";
import { readTeamCredentialCustodianResourcePageInTx } from './resourceCustodianRead';
import { publishTeamCredentialMaterialChangedInTx } from "../teamChanges";
import { acquireTeamMutationAccountAdmissionInTx } from "../memberships/sessionAccessEffects";
import { classifyMachineDaemonPresence, getMachineDaemonPresenceInventory } from "@/app/machines/machineDaemonPresence";
import {
    getMachinePoolCandidateSnapshot,
    getMachinePoolCandidateSnapshots,
    type MachinePoolCandidateSnapshot,
} from "@/app/machines/pools/machinePoolService";
import { createTeamCredentialResourceInTx } from "./resourceCreate";
import { listTeamCredentialSourceCandidatesInTx } from "./resourceSourceCandidates";
import { deleteTeamCredentialResourceInTx } from "./resourceDelete";
import { setTeamCredentialAudienceInTx } from "./resourceAudience";
import { updateTeamCredentialResourceInTx } from "./resourceUpdate";
import { readTeamCredentialActivityInTx } from "./resourceActivity";
import { deleteTeamCredentialUsageLimitInTx, listTeamCredentialUsageLimitsInTx, upsertTeamCredentialUsageLimitInTx } from "./resourceLimits";
import { queryTeamCredentialUsage } from "./resourceUsage";
import {
    createTeamCredentialExternalApiKeyInTx,
    authorizeTeamCredentialExternalApiKeyInTx,
    listTeamCredentialExternalApiKeysInTx,
    revokeAllTeamCredentialExternalApiKeysInTx,
    revokeTeamCredentialExternalApiKeyInTx,
} from "./externalApiKey";
import { authorizeRunnerBrokerReadiness } from "./runnerBrokerReadinessAuthorization";
import { registerTeamCredentialProviderBrokerRoutes } from "./providerBrokerRoutes";
import { projectTeamCredentialCatalogModels } from './catalogModels';
import { readTeamCredentialBrokerPresenceDemand } from './brokerPlacementResolver';
import { projectTeamCredentialCatalogBrokerReadiness, readTeamCredentialBrokerReadiness } from './brokerReadiness';
import {
    prepareTeamCredentialRecipientMaterialInTx,
    readTeamCredentialDirectMaterialCensusInTx,
    readTeamCredentialPreparationInTx,
    readCurrentTeamCredentialRecipientMaterialInTx,
    upsertTeamCredentialRecipientMaterialInTx,
    withdrawTeamCredentialRecipientMaterialInTx,
} from "./recipientMaterial";
import {
    projectTeamCredentialResourceSummaryInTx,
    projectTeamCredentialBrokerPresentationInTx,
    readTeamCredentialCatalogInTx,
    readTeamCredentialDiscoveryInTx,
    readTeamCredentialResourceAdministrationInTx,
    readTeamCredentialResourcePageInTx,
    readTeamCredentialSourceResourceAdministrationInTx,
} from "./resourceRead";
import {
    authorizeTeamCredentialResourceTestInTx,
    resolveAuthorizedTeamCredentialResourceTestPlacementInTx,
    selectAuthorizedTeamCredentialResourceTestBrokerInTx,
} from "./resourceTest";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { createExecutionRunBrokerCurrentnessResolver } from "./executionRunBrokerAuthorityResolver";
import {
    prepareTeamCredentialRequestPolicySupportInTx,
    readTeamCredentialBrokerRefusalReason,
    resolveTeamCredentialRequestPolicySupport,
    type TeamCredentialRequestPolicySupportEvidence,
} from "./resourceRequestPolicySupport";

const errors = { 400: TeamCredentialResourceErrorV1Schema,
    403: z.union([TeamCredentialResourceErrorV1Schema, AccountRouteAuthenticationForbiddenResponseSchema]),
    404: TeamCredentialResourceErrorV1Schema, 409: TeamCredentialResourceErrorV1Schema,
    503: TeamCredentialResourceErrorV1Schema } as const;
type ErrorReply = Readonly<{
    code: (status: 400 | 403 | 404 | 409 | 503) => {
        send: (body: Readonly<{ error: TeamCredentialErrorCodeV1; message?: string }>) => void;
    };
}>;
/**
 * The status is decided by the protocol's own mapper rather than repeated here,
 * so a client that reads the vocabulary back cannot disagree with the route that
 * sent it. An unrecognized string keeps the previous default instead of becoming
 * a 500.
 */
function fail(reply: ErrorReply, error: TeamCredentialErrorCodeV1, message?: string): void {
    const parsed = TeamCredentialErrorCodeV1Schema.parse(error);
    const status = teamCredentialErrorHttpStatusV1(parsed);
    reply.code(status).send({ error, ...(message === undefined ? {} : { message }) });
}

class TeamCredentialCreateProjectionFailure extends Error {
    constructor(readonly code: 'resource_corrupt' | 'resource_not_found') {
        super(code);
    }
}

type TeamCredentialResourceSummary = z.infer<typeof TeamCredentialResourceSummaryV1Schema>;
type TeamCredentialResourceTestCandidate = z.infer<typeof DaemonProviderTeamCredentialResourceTestCandidateResponseV1Schema>
    | Readonly<{ status: 'unavailable'; reason: 'response_invalid' }>;
type TeamCredentialBrokerEligibility = z.infer<typeof DaemonProviderTeamCredentialBrokerEligibilityResponseV1Schema>;

async function readTeamCredentialProviderConnectionPresentation(
    app: Fastify,
    input: Readonly<{
        custodianAccountId: string;
        machineId: string;
        source: Extract<NonNullable<TeamCredentialResourceSummary['source']>, { kind: 'provider_connection' }>;
    }>,
) {
    const rpc = await app.forwardRpcForUser({
        userId: input.custodianAccountId,
        method: `${input.machineId}:${RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE}`,
        params: { machineId: input.machineId, connectionId: input.source.connectionId },
    });
    if (!rpc.ok) return { status: 'unknown' } as const;
    const parsed = DaemonProviderConnectionsDescribeResponseV1Schema.safeParse(rpc.result);
    if (!parsed.success || parsed.data.status !== 'success') return { status: 'unknown' } as const;
    const connection = parsed.data.connections.find(candidate => candidate.connectionId === input.source.connectionId);
    if (!connection) return { status: 'changed' } as const;
    const offer = connection.teamCredentialSourceOffer;
    if (offer === null
        || offer.connectionId !== input.source.connectionId
        || offer.connectionSecurityFingerprint !== input.source.connectionSecurityFingerprint
        || offer.credentialSlotId !== input.source.credentialSlotId) {
        return { status: 'changed' } as const;
    }
    const contribution = parseProviderContributionIdentityV1(connection.contributionKey);
    if (contribution === null) return { status: 'unknown' } as const;
    return {
        status: 'current',
        sourcePresentation: {
            kind: 'provider' as const,
            provider: { identity: contribution.identity, definitionRevision: 1 as const },
        },
    } as const;
}

async function readTeamCredentialResourceCandidates(
    app: Fastify,
    input: Readonly<{
        custodianAccountId: string;
        machineIds: readonly string[];
        teamId: string;
        resourceId: string;
        resourceRevision: number;
        source: NonNullable<TeamCredentialResourceSummary['source']>;
        currentOnly: boolean;
    }>,
): Promise<readonly Readonly<{ machineId: string; candidate: TeamCredentialResourceTestCandidate | null }>[]> {
    return await Promise.all(input.machineIds.map(async machineId => {
        const rpc = await app.forwardRpcForUser({
            userId: input.custodianAccountId,
            method: `${machineId}:${RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_RESOURCE_TEST_CANDIDATE}`,
            params: {
                machineId,
                teamId: input.teamId,
                resourceId: input.resourceId,
                expectedResourceRevision: input.resourceRevision,
                source: input.source,
                ...(input.currentOnly ? { refreshPolicy: 'current_only' as const } : {}),
            },
        });
        if (!rpc.ok) return { machineId, candidate: null };
        const parsed = DaemonProviderTeamCredentialResourceTestCandidateResponseV1Schema.safeParse(rpc.result);
        // Preserve the Home's content-free parse observation without echoing broker payloads.
        return { machineId, candidate: parsed.success ? parsed.data : { status: 'unavailable', reason: 'response_invalid' } as const };
    }));
}

async function readTeamCredentialBrokerSourceEligibility(
    app: Fastify,
    input: Readonly<{
        custodianAccountId: string;
        machineIds: readonly string[];
        teamId: string;
        resourceId: string;
        resourceRevision: number;
        source: NonNullable<TeamCredentialResourceSummary['source']>;
    }>,
): Promise<readonly Readonly<{ machineId: string; eligibility: TeamCredentialBrokerEligibility | null }>[]> {
    return await Promise.all(input.machineIds.map(async machineId => {
        const rpc = await app.forwardRpcForUser({
            userId: input.custodianAccountId,
            method: `${machineId}:${RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_BROKER_ELIGIBILITY}`,
            params: {
                machineId,
                teamId: input.teamId,
                resourceId: input.resourceId,
                expectedResourceRevision: input.resourceRevision,
                source: input.source,
                scope: 'source_any' as const,
            },
        });
        if (!rpc.ok) return { machineId, eligibility: null };
        const parsed = DaemonProviderTeamCredentialBrokerEligibilityResponseV1Schema.safeParse(rpc.result);
        return { machineId, eligibility: parsed.success ? parsed.data : null };
    }));
}

/**
 * Composes the source owner's current broker/Provider facts into administration.
 * Other Team managers receive only safe readiness and Provider identity; exact
 * source bindings, Machine ids, Pool ids, and placement remain owner-private.
 */
async function projectTeamCredentialBrokerAdministrationReadiness(
    app: Fastify,
    viewerAccountId: string,
    resources: readonly TeamCredentialResourceSummary[],
    privateReadinessResources?: ReadonlyMap<string, TeamCredentialResourceSummary>,
): Promise<TeamCredentialResourceSummary[]> {
    const sourceViews = (await Promise.all(resources.map(async resource => {
        const prepared = privateReadinessResources?.get(resource.id);
        if (prepared !== undefined) {
            return { visible: resource, sourceView: prepared, revealPlacement: resource.custodianAccountId === viewerAccountId } as const;
        }
        if (resource.custodianAccountId === viewerAccountId && resource.source !== null) {
            return { visible: resource, sourceView: resource, revealPlacement: true } as const;
        }
        const projected = await inTx(tx => projectTeamCredentialResourceSummaryInTx(
            tx,
            resource.id,
            resource.custodianAccountId,
            resource.sourceOwnerDisplayName,
        ));
        return projected.ok && projected.resource.source !== null
            ? { visible: resource, sourceView: projected.resource, revealPlacement: false } as const
            : null;
    }))).filter(entry => entry !== null);
    if (sourceViews.length === 0) return [...resources];
    const presenceByAccountId = new Map<string, Awaited<ReturnType<typeof getMachineDaemonPresenceInventory>>>();
    await Promise.all([...new Set(sourceViews.map(entry => entry.sourceView.custodianAccountId))].map(async accountId => {
        presenceByAccountId.set(accountId, await getMachineDaemonPresenceInventory({
            accountId,
            io: app.machineDaemonPresence,
        }));
    }));
    const poolIdsByAccountId = new Map<string, Set<string>>();
    for (const { sourceView } of sourceViews) {
        const poolIds = poolIdsByAccountId.get(sourceView.custodianAccountId) ?? new Set<string>();
        for (const pool of sourceView.brokerPresentation.eligiblePools) poolIds.add(pool.poolId);
        if (sourceView.brokerPlacement?.kind === 'machine_pool') poolIds.add(sourceView.brokerPlacement.poolId);
        poolIdsByAccountId.set(sourceView.custodianAccountId, poolIds);
    }
    const poolSnapshots = new Map<string, MachinePoolCandidateSnapshot>();
    await Promise.all([...poolIdsByAccountId].map(async ([accountId, poolIds]) => {
        const snapshots = await getMachinePoolCandidateSnapshots({
            accountId,
            poolIds: [...poolIds],
            presence: presenceByAccountId.get(accountId)!,
        });
        for (const [poolId, snapshot] of snapshots) {
            poolSnapshots.set(`${accountId}\u0000${poolId}`, snapshot);
        }
    }));
    const { unavailable: placementReadiness } = await readTeamCredentialBrokerReadiness(app, sourceViews.map(({ sourceView }) => ({
        id: sourceView.id, custodianAccountId: sourceView.custodianAccountId,
        brokerMachineId: sourceView.brokerPlacement?.kind === 'machine' ? sourceView.brokerPlacement.machineId : null,
        brokerPoolId: sourceView.brokerPlacement?.kind === 'machine_pool' ? sourceView.brokerPlacement.poolId : null,
    })), presenceByAccountId, new Set(), poolSnapshots);
    const brokerEligibilityPromises = new Map<string, Promise<Readonly<{
        machineId: string;
        eligibility: TeamCredentialBrokerEligibility | null;
    }>>>();
    const providerPresentationPromises = new Map<string, ReturnType<typeof readTeamCredentialProviderConnectionPresentation>>();
    const readPoolSnapshot = async (resource: TeamCredentialResourceSummary, poolId: string) => {
        const key = `${resource.custodianAccountId}\u0000${poolId}`;
        const snapshot = poolSnapshots.get(key);
        return snapshot
            ? { ok: true as const, value: snapshot }
            : { ok: false as const, error: { code: 'pool_not_found' as const } };
    };
    const readBrokerEligibility = async (
        resource: TeamCredentialResourceSummary,
        source: NonNullable<TeamCredentialResourceSummary['source']>,
        machineIds: readonly string[],
    ) => await Promise.all([...new Set(machineIds)].map(machineId => {
        // `source_any` asks only whether this exact source can be materialized
        // on the Machine. Resource policy and audience are enforced by the
        // Home before this projection, so resources sharing one immutable
        // source binding share the Machine-local observation instead of
        // multiplying the same RPC by resource count.
        const key = `${resource.custodianAccountId}\u0000${machineId}\u0000${JSON.stringify(source)}`;
        const existing = brokerEligibilityPromises.get(key);
        if (existing) return existing;
        const promise = readTeamCredentialBrokerSourceEligibility(app, {
            custodianAccountId: resource.custodianAccountId,
            machineIds: [machineId],
            teamId: resource.teamId,
            resourceId: resource.id,
            resourceRevision: resource.revision,
            source,
        }).then(rows => rows[0] ?? { machineId, eligibility: null });
        brokerEligibilityPromises.set(key, promise);
        return promise;
    }));
    const readProviderPresentation = (
        resource: TeamCredentialResourceSummary,
        source: Extract<NonNullable<TeamCredentialResourceSummary['source']>, { kind: 'provider_connection' }>,
        machineId: string,
    ) => {
        const key = `${resource.custodianAccountId}\u0000${machineId}\u0000${source.connectionId}\u0000${source.connectionSecurityFingerprint}\u0000${source.credentialSlotId}`;
        const existing = providerPresentationPromises.get(key);
        if (existing) return existing;
        const promise = readTeamCredentialProviderConnectionPresentation(app, {
            custodianAccountId: resource.custodianAccountId,
            machineId,
            source,
        });
        providerPresentationPromises.set(key, promise);
        return promise;
    };
    const projectedByResourceId = new Map<string, TeamCredentialResourceSummary>();
    await Promise.all(sourceViews.map(async ({ visible, sourceView: resource, revealPlacement }) => {
        const source = resource.source;
        if (source === null) return;
        const presence = presenceByAccountId.get(resource.custodianAccountId);
        if (!presence) return;
        const onlineMachineIds = resource.brokerPresentation.eligibleTargets.flatMap(target => (
            target.availability !== 'update_required'
            && classifyMachineDaemonPresence(presence, target.machineId) === 'connected'
                ? [target.machineId]
                : []
        ));
        const eligibleTargets = resource.brokerPresentation.eligibleTargets.map(target => ({
            ...target,
            availability: target.availability === 'update_required'
                ? 'update_required' as const
                : onlineMachineIds.includes(target.machineId)
                    ? 'available' as const
                    : presence.state === 'known' ? 'offline' as const : 'not_verified' as const,
        }));
        const selectedTarget = resource.brokerPresentation.selectedTarget === null
            ? null
            : eligibleTargets.find(target => target.machineId === resource.brokerPresentation.selectedTarget?.machineId)
                ?? resource.brokerPresentation.selectedTarget;
        const availability = new Map<string, Readonly<{
            availability: 'available' | 'unavailable' | 'not_verified';
            availableMachineCount: number | null;
        }>>();
        const eligibilityByPoolId = new Map<string, readonly Readonly<{
            machineId: string;
            eligibility: TeamCredentialBrokerEligibility | null;
        }>[]>();
        await Promise.all(resource.brokerPresentation.eligiblePools.map(async pool => {
            const snapshot = await readPoolSnapshot(resource, pool.poolId);
            if (!snapshot.ok || snapshot.value.presenceState === 'unavailable') {
                availability.set(pool.poolId, {
                    availability: 'not_verified',
                    availableMachineCount: null,
                });
                return;
            }
            const candidateMachineIds = snapshot.value.members.flatMap(member => (
                member.enabled && snapshot.value.availableMachineIds.has(member.machineId)
                    ? [member.machineId]
                    : []
            ));
            const candidates = await readBrokerEligibility(resource, source, candidateMachineIds);
            eligibilityByPoolId.set(pool.poolId, candidates);
            if (candidates.some(result => result.eligibility === null)) {
                availability.set(pool.poolId, {
                    availability: 'not_verified',
                    availableMachineCount: null,
                });
                return;
            }
            const availableMachineCount = candidates.filter(result => result.eligibility?.status === 'eligible').length;
            availability.set(pool.poolId, {
                availability: availableMachineCount > 0 ? 'available'
                    : snapshot.value.presenceState === 'known' ? 'unavailable' : 'not_verified',
                availableMachineCount: snapshot.value.presenceState === 'known' ? availableMachineCount : null,
            });
        }));
        const eligiblePools = resource.brokerPresentation.eligiblePools.map(pool => ({
            ...pool,
            ...(availability.get(pool.poolId) ?? {
                availability: 'not_verified' as const,
                availableMachineCount: null,
            }),
        }));
        const selectedPool = resource.brokerPresentation.selectedPool === null
            ? null
            : eligiblePools.find(pool => pool.poolId === resource.brokerPresentation.selectedPool?.poolId) ?? {
                ...resource.brokerPresentation.selectedPool,
                availability: 'not_verified' as const,
                availableMachineCount: null,
            };
        let candidateMachineIds = resource.brokerPlacement?.kind === 'machine'
            ? selectedTarget?.availability === 'available' ? [resource.brokerPlacement.machineId] : []
            : [];
        if (candidateMachineIds.length === 0 && resource.brokerPlacement === null) {
            candidateMachineIds = onlineMachineIds;
        }
        if (resource.brokerPlacement?.kind === 'machine_pool') {
            const selectedSnapshot = await readPoolSnapshot(resource, resource.brokerPlacement.poolId);
            candidateMachineIds = selectedSnapshot.ok && selectedSnapshot.value.presenceState !== 'unavailable'
                ? selectedSnapshot.value.members.flatMap(member => (
                    member.enabled && selectedSnapshot.value.availableMachineIds.has(member.machineId)
                        ? [member.machineId]
                        : []
                ))
                : [];
        }
        const eligibility = resource.brokerPlacement?.kind === 'machine_pool'
            ? eligibilityByPoolId.get(resource.brokerPlacement.poolId) ?? []
            : candidateMachineIds.length === 0 ? [] : await readBrokerEligibility(resource, source, candidateMachineIds);
        const hasEligibleSource = eligibility.some(candidate => candidate.eligibility?.status === 'eligible');
        const hasChangedSource = eligibility.some(candidate => candidate.eligibility?.status === 'unavailable'
            && (candidate.eligibility.reason === 'source_changed' || candidate.eligibility.reason === 'source_unavailable'));
        const brokerRefusalReason = readTeamCredentialBrokerRefusalReason(eligibility.map(({ eligibility }) => (
            eligibility?.status === 'unavailable' ? eligibility.reason : null
        )));
        let sourcePresentation = resource.sourcePresentation;
        let providerSourceState: 'current' | 'changed' | 'unknown' = source.kind === 'provider_connection' ? 'unknown' : 'current';
        if (source.kind === 'provider_connection') {
            for (const machineId of candidateMachineIds) {
                const inspected = await readProviderPresentation(resource, source, machineId);
                if (inspected.status === 'current') {
                    providerSourceState = 'current';
                    sourcePresentation = inspected.sourcePresentation;
                    break;
                }
                if (inspected.status === 'changed') providerSourceState = 'changed';
            }
        }
        const sourceChanged = hasChangedSource || providerSourceState === 'changed';
        const sourceAuthenticationFailure = eligibility.some(candidate => candidate.eligibility?.status === 'unavailable'
            && candidate.eligibility.reason === 'connected_service_credential_reconnect_required');
        const nonBrokerAllowed = resource.deliveryPolicy.preferredAllowedModes.some(route => route !== 'brokered');
        const brokerReady = nonBrokerAllowed
            ? hasEligibleSource
            : !placementReadiness.has(resource.id) && hasEligibleSource;
        const brokerObservationUnknown = presence.state !== 'known'
            || eligibility.some(candidate => candidate.eligibility === null)
            || selectedPool?.availability === 'not_verified'
            || (hasEligibleSource && source.kind === 'provider_connection' && providerSourceState === 'unknown');
        const readiness = !resource.enabled
            || resource.readiness.kind === 'resource_corrupt'
            || resource.readiness.kind === 'source_unavailable'
            ? resource.readiness
            : source.kind !== 'provider_connection' && nonBrokerAllowed
                ? resource.readiness
            : sourceAuthenticationFailure
            ? { kind: 'source_unavailable' as const, reason: 'connected_service_credential_reconnect_required' as const }
            : sourceChanged
            ? { kind: 'source_unavailable' as const }
            : !nonBrokerAllowed && placementReadiness.has(resource.id)
                ? placementReadiness.get(resource.id)!
            : brokerReady && (source.kind !== 'provider_connection' || providerSourceState === 'current')
                ? { kind: 'available' as const }
                : resource.readiness.kind === 'update_required'
                    ? resource.readiness
                    : {
                        kind: 'broker_unavailable' as const,
                        ...(brokerRefusalReason !== null ? { reason: brokerRefusalReason }
                            : brokerObservationUnknown ? { reason: 'projection_unavailable' as const } : {}),
                    };
        const recoveryAction = !resource.enabled
            || readiness.kind === 'resource_corrupt'
            || (readiness.kind === resource.readiness.kind
                && (resource.recoveryAction === 'select_broker'
                    || resource.recoveryAction === 'update_required'
                    || resource.recoveryAction === 'source_owner_action'))
            ? resource.recoveryAction
            : readiness.kind === 'available'
            ? null
            : readiness.kind === 'source_unavailable'
                ? 'source_owner_action' as const
                : readiness.kind === 'update_required'
                    ? 'update_required' as const
                    : resource.brokerPlacement === null ? 'select_broker' as const : 'retry' as const;
        projectedByResourceId.set(resource.id, TeamCredentialResourceSummaryV1Schema.parse({
            ...(revealPlacement ? resource : visible),
            sourcePresentation,
            readiness,
            recoveryAction,
            ...(revealPlacement ? { brokerPresentation: {
                ...resource.brokerPresentation,
                selectedTarget,
                eligibleTargets,
                selectedPool,
                eligiblePools,
            } } : {}),
        }));
    }));
    return resources.map(resource => projectedByResourceId.get(resource.id) ?? resource);
}

export function registerTeamCredentialResourceRoutes(
    app: Fastify,
    env: NodeJS.ProcessEnv = process.env,
): void {
    // The family gate and the external Provider API readiness gate below both
    // answer their disabled state with the one typed credential error vocabulary
    // these routes declare, so a client decoding any refusal — feature off,
    // resource missing, or policy refused — reads the same strict schema instead
    // of a generic body that vocabulary rejects.
    const routes = createServerFeatureGatedRouteApp(
        app,
        "teams.credentialResources",
        env,
        { error: "feature_disabled" },
        503,
        { allowLegacyHomeToken: false },
    );
    // Personal Provider connections use their own feature and Account admission;
    // only the Team source arm consumes the Team-resource gate.
    registerTeamCredentialProviderBrokerRoutes(routes, app);
    const resolveExecutionRunCurrentness = createExecutionRunBrokerCurrentnessResolver({
        app,
        resolveServerIdentityId: () => getOrCreateServerIdentityId(env),
        createNonce: () => crypto.randomUUID(),
    });
    const directMaterialPath = "/v2/teams/:teamId/credential-resources/:resourceId/direct-material";
    routes.delete(directMaterialPath, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            params: TeamCredentialDirectMaterialRouteParamsV1Schema,
            body: TeamCredentialDirectMaterialWithdrawRequestV1Schema,
            response: { 200: TeamCredentialDirectMaterialWithdrawResponseV1Schema, ...errors },
        },
    }, async (request, reply) => {
        const params = TeamCredentialDirectMaterialRouteParamsV1Schema.safeParse(request.params);
        const body = TeamCredentialDirectMaterialWithdrawRequestV1Schema.safeParse(request.body);
        if (request.validationError || !params.success || !body.success) return fail(reply, 'invalid_resource_input');
        const result = await inTx(async tx => {
            const withdrawn = await withdrawTeamCredentialRecipientMaterialInTx(tx, {
                ...params.data, ...body.data, actorAccountId: request.userId,
                authentication: readTeamOperationAuthenticationFromRequest(request),
            });
            if (withdrawn.ok && withdrawn.changed) await publishTeamCredentialMaterialChangedInTx(tx, { teamId: params.data.teamId });
            return withdrawn;
        }, { isolationLevel: "ReadCommitted" /* Exclusive complete Account admission precedes withdrawal's Team/resource and source-version checks. */ });
        if (!result.ok) return fail(reply, result.reason === 'source_changed' || result.reason === 'resource_changed'
            ? 'source_replaced_or_missing' : result.reason);
        return reply.send(TeamCredentialDirectMaterialWithdrawResponseV1Schema.parse({ status: 'withdrawn' }));
    });
    routes.get(directMaterialPath, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            params: TeamCredentialDirectMaterialRouteParamsV1Schema,
            querystring: TeamCredentialDirectMaterialReadQueryV1Schema,
            response: {
                200: z.union([
                    TeamCredentialDirectMaterialPreparationResponseV1Schema,
                    TeamCredentialDirectMaterialCensusOutputV1Schema,
                    TeamCredentialPreparationOutputV1Schema,
                ]),
                ...errors,
            },
        },
    }, async (request, reply) => {
        const params = TeamCredentialDirectMaterialRouteParamsV1Schema.safeParse(request.params);
        const query = TeamCredentialDirectMaterialReadQueryV1Schema.safeParse(request.query);
        if (request.validationError || !params.success || !query.success) return fail(reply, "invalid_resource_input");
        const queryData = query.data;
        if (queryData.view === "census" || queryData.view === "readiness") {
            const result = await inTx(async tx => queryData.view === "readiness" ? await readTeamCredentialPreparationInTx(tx, {
                actorAccountId: request.userId,
                ...params.data,
                authentication: readTeamOperationAuthenticationFromRequest(request),
            }) : await readTeamCredentialDirectMaterialCensusInTx(tx, {
                actorAccountId: request.userId,
                ...params.data,
                cursor: queryData.cursor ?? null,
                authentication: readTeamOperationAuthenticationFromRequest(request),
            }), { isolationLevel: "Serializable" /* Credential preparation and direct-material census must share one authority snapshot. */ });
            if (!result.ok) {
                if (result.reason === "team_authentication_required"
                    || result.reason === "team_authentication_policy_unavailable") return fail(reply, result.reason);
                const error = result.reason === "resource_not_found" ? "resource_not_found"
                    : result.reason === "source_owner_required" ? "source_owner_required"
                        : result.reason === "resource_corrupt" ? "resource_corrupt"
                            : "source_replaced_or_missing";
                return fail(reply, error);
            }
            const { ok: _ok, ...census } = result;
            return reply.send(queryData.view === "readiness"
                ? TeamCredentialPreparationOutputV1Schema.parse(census)
                : TeamCredentialDirectMaterialCensusOutputV1Schema.parse(census));
        }
        const result = await inTx(tx => prepareTeamCredentialRecipientMaterialInTx(tx, {
            actorAccountId: request.userId,
            ...params.data,
            sourceMemberKey: queryData.sourceMemberKey,
            cursor: queryData.cursor ?? null,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }), { isolationLevel: "Serializable" /* Recipient material preparation composes resource, audience and recipient epoch currentness. */ });
        if (!result.ok) {
            if (result.reason === "team_authentication_required"
                || result.reason === "team_authentication_policy_unavailable") return fail(reply, result.reason);
            const error = result.reason === "resource_not_found" ? "resource_not_found"
                : result.reason === "source_owner_required" ? "source_owner_required"
                    : result.reason === "resource_corrupt" ? "resource_corrupt"
                        : "source_replaced_or_missing";
            return fail(reply, error);
        }
        return reply.send(TeamCredentialDirectMaterialPreparationResponseV1Schema.parse({
            homeServerIdentityId: await getOrCreateServerIdentityId(env),
            teamId: result.teamId,
            resourceId: result.resourceId,
            resourceRevision: result.resourceRevision,
            source: result.source,
            sourceMember: result.sourceMember,
            sourceCredentialIncarnation: result.sourceCredentialIncarnation,
            publishedSourceVersion: result.publishedSourceVersion,
            recipients: result.recipients,
            nextCursor: result.nextCursor,
        }));
    });

    routes.post(directMaterialPath, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            params: TeamCredentialDirectMaterialRouteParamsV1Schema,
            body: z.union([TeamCredentialDirectMaterialOpenRequestV1Schema, TeamCredentialNativeBindingReadRequestV1Schema]),
            response: { 200: z.union([TeamCredentialDirectMaterialMineResponseV1Schema, TeamCredentialNativeBindingReadResponseV1Schema]), ...errors },
        },
    }, async (request, reply) => {
        const params = TeamCredentialDirectMaterialRouteParamsV1Schema.safeParse(request.params);
        const native = TeamCredentialNativeBindingReadRequestV1Schema.safeParse(request.body);
        if (native.success) {
            if (request.validationError || !params.success || native.data.resourceId !== params.data.resourceId
                || native.data.teamId !== params.data.teamId) return fail(reply, 'invalid_resource_input');
            const homeId = await getOrCreateServerIdentityId(env);
            const result = await inTx(tx => readManagedNativeCredentialBindingForGuestInTx(tx, {
                actorAccountId: request.userId, homeId, request: native.data,
                authentication: readSessionAccessAuthenticationFromRequest(request),
            }), { isolationLevel: 'Serializable' });
            return reply.send(TeamCredentialNativeBindingReadResponseV1Schema.parse(result));
        }
        const body = TeamCredentialDirectMaterialOpenRequestV1Schema.safeParse(request.body);
        if (request.validationError || !params.success || !body.success
            || body.data.resourceId !== params.data.resourceId) return fail(reply, "invalid_resource_input");
        if (body.data.consumer.kind === 'platform_operation' && !request.externalActionPlatformMaterialAdmission
            || body.data.consumer.kind === 'action_operation' && !request.externalActionActionMaterialAdmission) {
            return reply.send(TeamCredentialDirectMaterialMineResponseV1Schema.parse({ status: 'unavailable', reason: 'access_removed' }));
        }
        const run = body.data.consumer.kind === "execution_run"
            ? await resolveExecutionRunCurrentness({
                executionRunId: body.data.consumer.executionRunId,
                requestingAccountId: request.userId,
                workerMachineId: body.data.consumer.workerMachineId,
                expectedOccurrenceId: null,
                expectedDirectMaterialUse: {
                    resourceId: body.data.resourceId,
                    ...("sourceMemberKey" in body.data
                        ? { slot: body.data.slot, sourceMemberKey: body.data.sourceMemberKey }
                        : { slot: body.data.slot, disclosedMember: body.data.disclosedMember }),
                },
            })
            : null;
        if (run && !run.ok) {
            return reply.send(TeamCredentialDirectMaterialMineResponseV1Schema.parse({
                status: "unavailable", reason: "access_removed",
            }));
        }
        const result = await inTx(tx => readCurrentTeamCredentialRecipientMaterialInTx(tx, {
            ...params.data,
            recipientAccountId: request.userId,
            ...(request.externalActionActionMaterialAdmission ? { actionAdmission: request.externalActionActionMaterialAdmission } : {}),
            ...("sourceMemberKey" in body.data
                ? { slot: body.data.slot, sourceMemberKey: body.data.sourceMemberKey }
                : { slot: body.data.slot, disclosedMember: body.data.disclosedMember }),
            consumer: body.data.consumer.kind !== "execution_run"
                ? body.data.consumer
                : {
                    kind: "execution_run" as const,
                    executionRunId: body.data.consumer.executionRunId,
                    parentSessionId: run?.ok ? run.parentSessionId : null,
                },
            sessionAuthentication: readSessionAccessAuthenticationFromRequest(request),
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }), { isolationLevel: "Serializable" /* Material disclosure composes access, source version and recipient encryption epoch. */ });
        if (!result.ok) {
            if (result.outcome === "operation_error") return fail(reply, result.error);
            return reply.send(TeamCredentialDirectMaterialMineResponseV1Schema.parse({ status: "unavailable", reason: result.reason }));
        }
        return reply.send(TeamCredentialDirectMaterialMineResponseV1Schema.parse({
            status: "ready",
            recipientMode: result.recipientMode,
            admittedResource: result.admittedResource,
            stored: result.stored,
            expected: {
                homeServerIdentityId: await getOrCreateServerIdentityId(env),
                teamId: params.data.teamId,
                resourceId: params.data.resourceId,
                resourceRevision: result.resourceRevision,
                recipientAccountId: request.userId,
                sourceMemberKey: result.sourceMemberKey,
                sourceVersion: result.sourceVersion,
            },
        }));
    });

    routes.put(directMaterialPath, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            params: TeamCredentialDirectMaterialRouteParamsV1Schema,
            body: TeamCredentialDirectMaterialUpsertRequestV1Schema,
            response: { 200: TeamCredentialDirectMaterialUpsertResponseV1Schema, ...errors },
        },
    }, async (request, reply) => {
        const params = TeamCredentialDirectMaterialRouteParamsV1Schema.safeParse(request.params);
        const body = TeamCredentialDirectMaterialUpsertRequestV1Schema.safeParse(request.body);
        if (request.validationError || !params.success || !body.success) return fail(reply, "invalid_resource_input");
        const results = await inTx(async tx => {
            const resource = await tx.teamCredentialResource.findUnique({
                where: { id: params.data.resourceId },
                select: { teamId: true },
            });
            if (resource?.teamId !== params.data.teamId) {
                return { ok: false as const, error: "resource_not_found" as const };
            }
            // Admit every batch recipient before the first tuple takes the
            // Team guard; later unavailable recipients still need Account order.
            await acquireTeamMutationAccountAdmissionInTx(tx, {
                teamId: params.data.teamId,
                accountIds: [request.userId, ...body.data.items.map(item => item.recipientAccountId)],
            });
            const itemResults: z.infer<typeof TeamCredentialDirectMaterialUpsertResponseV1Schema>["results"] = [];
            let changedAnyTuple = false;
            for (const item of body.data.items) {
                const result = await upsertTeamCredentialRecipientMaterialInTx(tx, {
                    actorAccountId: request.userId,
                    resourceId: params.data.resourceId,
                    authentication: readTeamOperationAuthenticationFromRequest(request),
                    ...item,
                });
                if (!result.ok && (result.reason === "team_authentication_required"
                    || result.reason === "team_authentication_policy_unavailable")) {
                    return { ok: false as const, error: result.reason };
                }
                if (result.ok && result.changed) changedAnyTuple = true;
                itemResults.push(result.ok ? {
                    status: "stored" as const,
                    recipientAccountId: result.recipientAccountId,
                    sourceMemberKey: result.sourceMemberKey,
                    sourceVersion: result.sourceVersion,
                } : {
                    status: "unavailable" as const,
                    recipientAccountId: item.recipientAccountId,
                    sourceMemberKey: item.sourceMemberKey,
                    reason: result.reason === "resource_changed" || result.reason === "material_changed"
                        ? "source_changed" as const
                        : result.reason === "resource_not_found" || result.reason === "source_owner_required"
                            ? "access_removed" as const
                            : result.reason === "team_authentication_required"
                                || result.reason === "team_authentication_policy_unavailable"
                                ? "temporarily_unavailable" as const
                            : result.reason,
                });
            }
            // Only changed material is news to its readers. It does not change
            // source authority and must not start another source census.
            if (changedAnyTuple) {
                await publishTeamCredentialMaterialChangedInTx(tx, { teamId: params.data.teamId });
            }
            return { ok: true as const, results: itemResults };
        }, { isolationLevel: "ReadCommitted" /* Complete batch Account admission precedes the Team guard and fresh tuple currentness checks. */ });
        if (!results.ok) return fail(reply, results.error);
        return reply.send(TeamCredentialDirectMaterialUpsertResponseV1Schema.parse({ results: results.results }));
    });
    routes.post(PROVIDER_BROKER_READINESS_AUTHORIZE_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        schema: {
            params: TeamCredentialResourceGetInputV1Schema,
            body: RunnerBrokerReadinessRequestV1Schema,
            response: {
                200: RunnerBrokerReadinessResponseV1Schema,
                400: TeamCredentialResourceErrorV1Schema,
                403: z.union([z.strictObject({}), TeamCredentialResourceErrorV1Schema]),
                404: TeamCredentialResourceErrorV1Schema,
                409: TeamCredentialResourceErrorV1Schema,
                503: TeamCredentialResourceErrorV1Schema,
            },
        },
    }, async (request, reply) => {
        const result = await authorizeRunnerBrokerReadiness({
            custodianAccountId: request.userId,
            resourceId: request.params.resourceId,
            request: request.body,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        });
        if (!result) return reply.code(403).send({});
        if (!result.ok) return fail(reply, result.error);
        const checked = result.request;
        return reply.send({
            v: 1,
            binding: {
                homeServerIdentityId: checked.homeServerIdentityId,
                activationId: checked.activationId,
                launchManifestCommitment: checked.launchManifestCommitment,
                resourceId: checked.resourceId,
                agentTargetKey: checked.agentTargetKey,
                modelId: checked.modelId,
                protocol: checked.protocol,
                initiator: checked.initiator,
                target: checked.target,
            },
            credentialSelectionBinding: result.credentialSelectionBinding,
            readiness: result.readiness,
        });
    });
    routes.post(homeDomainActionPathForMethod("teams.credentials.list", "POST"), {
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: TeamCredentialResourceListInputV1Schema, response: { 200: TeamCredentialResourcePageV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialResourceListInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const authentication = readTeamOperationAuthenticationFromRequest(request);
        const selection = body.data;
        const result = await inTx(tx => 'scope' in selection ? readTeamCredentialCustodianResourcePageInTx(tx, {
                actorAccountId: request.userId, authentication, cursor: selection.cursor, limit: selection.limit,
            }) : readTeamCredentialResourcePageInTx(tx, {
                teamId: selection.teamId,
                cursor: selection.cursor,
                limit: selection.limit,
                search: selection.search,
                filter: selection.filter,
                actorAccountId: request.userId,
                authentication,
            }));
            if (!result.ok) return fail(reply, result.error);
            const enriched = await projectTeamCredentialBrokerAdministrationReadiness(
                app,
                request.userId,
                result.page.resources,
                new Map(result.readinessResources.map(resource => [resource.id, resource])),
            );
            if (body.data.filter !== 'needs_attention') {
                return reply.send({ ...result.page, resources: enriched });
            }
            const attention = enriched.filter(resource => resource.readiness.kind !== 'available');
            return reply.send({ ...result.page, resources: attention });
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.requestPolicySupport.get", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamCredentialRequestPolicySupportInputV1Schema,
            response: { 200: TeamCredentialRequestPolicySupportOutputV1Schema, ...errors },
        },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialRequestPolicySupportInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const prepared = await inTx(tx => prepareTeamCredentialRequestPolicySupportInTx(tx, {
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            ...body.data,
        }));
        if (!prepared.ok) {
            if ("error" in prepared) return fail(reply, prepared.error);
            return reply.send(TeamCredentialRequestPolicySupportOutputV1Schema.parse({
                status: "unavailable",
                reason: prepared.unavailable,
            }));
        }
        return reply.send(await resolveTeamCredentialRequestPolicySupport(app, prepared));
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.sources.list", "POST"), {
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: TeamCredentialSourceCandidateListInputV1Schema, response: { 200: TeamCredentialSourceCandidateListOutputV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialSourceCandidateListInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const result = await inTx(async tx => {
            const sources = await listTeamCredentialSourceCandidatesInTx(tx, {
                actorAccountId: request.userId, teamId: body.data.teamId,
                authentication: readTeamOperationAuthenticationFromRequest(request),
            });
            if (!sources.ok) return sources;
            return { ...sources, brokerPresentation: await projectTeamCredentialBrokerPresentationInTx(tx, request.userId) };
        });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(TeamCredentialSourceCandidateListOutputV1Schema.parse({
            candidates: result.candidates,
            supportedKinds: result.supportedKinds,
            brokerPresentation: { selectedTarget: null, selectedPool: null, ...result.brokerPresentation },
        }));
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.sourceResources.list", "POST"), {
        preHandler: app.authenticate, attachValidation: true,
        schema: {
            body: TeamCredentialSourceResourceListInputV1Schema,
            response: { 200: TeamCredentialSourceResourceListOutputV1Schema, ...errors },
        },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialSourceResourceListInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const sourceRows = await inTx(tx => readTeamCredentialSourceResourceAdministrationInTx(tx, {
            actorAccountId: request.userId,
            source: body.data.source,
            ...(body.data.cursor ? { cursor: body.data.cursor } : {}),
            limit: body.data.limit,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }));
        if (!sourceRows.ok) return fail(reply, sourceRows.error);
        const enriched = await projectTeamCredentialBrokerAdministrationReadiness(
            app,
            request.userId,
            sourceRows.readinessResources,
            new Map(sourceRows.readinessResources.map(resource => [resource.id, resource])),
        );
        return reply.send(TeamCredentialSourceResourceListOutputV1Schema.parse({
            resources: enriched.map(resource => TeamCredentialSourceResourceAdministrationV1Schema.parse({
                id: resource.id,
                displayName: resource.displayName,
                enabled: resource.enabled,
                revision: resource.revision,
                deliveryPolicy: resource.deliveryPolicy,
                ...(resource.directExportFailure ? { directExportFailure: resource.directExportFailure } : {}),
                brokerPlacement: resource.brokerPlacement,
                brokerPresentation: resource.brokerPresentation,
                readiness: resource.readiness,
                recoveryAction: resource.recoveryAction,
                capabilities: sourceRows.page.resources.find(row => row.id === resource.id)?.capabilities
                    ?? resource.capabilities,
                createdAt: resource.createdAt,
                updatedAt: resource.updatedAt,
            })),
            nextCursor: sourceRows.page.nextCursor,
        }));
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.get", "POST"), {
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: TeamCredentialResourceGetInputV1Schema, response: { 200: TeamCredentialResourceSummaryV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialResourceGetInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const result = await inTx(tx => readTeamCredentialResourceAdministrationInTx(tx, {
            resourceId: body.data.resourceId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }));
        if (!result.ok) return fail(reply, result.error);
        const [resource] = await projectTeamCredentialBrokerAdministrationReadiness(app, request.userId, [result.resource]);
        return reply.send(resource!);
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.test", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamCredentialTestActionInputV1Schema,
            response: { 200: TeamCredentialTestActionOutputV1Schema, ...errors },
        },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialTestActionInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const sendResult = (result: z.infer<typeof TeamCredentialTestActionOutputV1Schema>) => reply.send(
            TeamCredentialTestActionOutputV1Schema.parse({ ...result, requestId: result.requestId ?? request.id }),
        );
        const authorized = await inTx(tx => authorizeTeamCredentialResourceTestInTx(tx, {
            actorAccountId: request.userId,
            ...body.data,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }));
        if (!authorized.ok) return fail(reply, authorized.error);
        if (authorized.authenticationFailure) return sendResult({
            result: "needs_attention", code: authorized.authenticationFailure,
            readiness: { kind: "source_unavailable", reason: authorized.authenticationFailure },
            recovery: "Reconnect the shared account and try again.",
        });
        const brokerPresence = await getMachineDaemonPresenceInventory({
            accountId: authorized.authorization.custodianAccountId,
            io: app.machineDaemonPresence,
            machineIds: await readTeamCredentialBrokerPresenceDemand({ resource: authorized.authorization }),
        });
        const prepared = await inTx(tx => resolveAuthorizedTeamCredentialResourceTestPlacementInTx(tx, {
            authorization: authorized.authorization,
            actorAccountId: request.userId,
            brokerPresence,
        }));
        if (!prepared.ok) {
            if (prepared.error === "broker_unavailable" || prepared.error === "update_required") {
                if (prepared.error === "broker_unavailable") {
                    logger.warn({ module: "team-credential-resource-test", stage: "placement", code: "broker_unavailable" });
                }
                return sendResult({
                    result: "needs_attention",
                    readiness: { kind: prepared.error },
                    recovery: prepared.error === "update_required"
                        ? "Update the selected broker Machine and try again."
                        : "Reconnect or select the broker Machine and try again.",
                });
            }
            return fail(reply, prepared.error);
        }
        const { snapshot } = prepared;
        const candidateResults = await readTeamCredentialResourceCandidates(app, {
            custodianAccountId: snapshot.custodianAccountId,
            machineIds: snapshot.candidateMachineIds,
            teamId: snapshot.teamId,
            resourceId: snapshot.resourceId,
            resourceRevision: snapshot.expectedResourceRevision,
            source: snapshot.source,
            currentOnly: snapshot.brokerPoolId !== null,
        });
        const successfulIds = new Set(candidateResults.flatMap(({ machineId, candidate }) => (
            candidate?.status === "success" ? [machineId] : []
        )));
        let brokerMachineId = snapshot.candidateMachineIds.find(machineId => successfulIds.has(machineId)) ?? null;
        if (snapshot.brokerPoolId) {
            const currentPresence = await getMachineDaemonPresenceInventory({
                accountId: snapshot.custodianAccountId,
                io: app.machineDaemonPresence,
                machineIds: snapshot.candidateMachineIds,
            });
            const selection = await inTx(tx => selectAuthorizedTeamCredentialResourceTestBrokerInTx(tx, {
                authorization: authorized.authorization,
                actorAccountId: request.userId,
                brokerPresence: currentPresence,
                eligibleMachineIds: successfulIds,
            }));
            if (!selection.ok && selection.error === "resource_changed") return fail(reply, "resource_changed");
            brokerMachineId = selection.ok ? selection.brokerMachineId : null;
        }
        const selected = candidateResults.find(result => result.machineId === brokerMachineId)?.candidate ?? null;
        if (brokerMachineId === null || selected === null || selected.status === "unavailable") {
            const authenticationFailure = candidateResults.some(({ candidate }) => candidate?.status === 'unavailable'
                && candidate.reason === 'connected_service_credential_reconnect_required');
            if (authenticationFailure) return sendResult({
                result: 'needs_attention', code: 'connected_service_credential_reconnect_required',
                readiness: { kind: 'source_unavailable', reason: 'connected_service_credential_reconnect_required' },
                recovery: 'Reconnect the shared account and try again.',
            });
            const sourceUnavailable = candidateResults.some(({ candidate }) => candidate?.status === "unavailable"
                && candidate.reason === "source_unavailable");
            const brokerRefusalReason = readTeamCredentialBrokerRefusalReason(candidateResults.map(({ candidate }) => (
                candidate?.status === "unavailable" ? candidate.reason : null
            )));
            if (sourceUnavailable || brokerRefusalReason === null) {
                logger.warn({ module: "team-credential-resource-test", stage: "candidate", code: sourceUnavailable ? "source_unavailable" : "candidate_unavailable" });
            }
            return sendResult({
                result: "needs_attention",
                readiness: sourceUnavailable
                    ? { kind: "source_unavailable" }
                    : { kind: "broker_unavailable", ...(brokerRefusalReason ? { reason: brokerRefusalReason } : {}) },
                ...(sourceUnavailable ? { code: "source_unavailable" } : {}),
                recovery: sourceUnavailable
                    ? "Repair the credential source and try again."
                    : brokerRefusalReason === 'response_invalid'
                        ? "Review the broker Machine logs and try again."
                        : brokerRefusalReason
                            ? "Review the broker application and model availability, then try again."
                            : "Reconnect the broker Machine and try again.",
            });
        }
        if (
            selected.request.teamId !== snapshot.teamId
            || selected.request.resourceId !== snapshot.resourceId
        ) {
            return sendResult({
                result: "needs_attention",
                readiness: { kind: "resource_unavailable" },
                recovery: "Refresh the credential resource and try again.",
            });
        }
        const dispatch = app.forwardTeamCredentialBrokerResourceTest;
        if (!dispatch) {
            logger.warn({ module: "team-credential-resource-test", stage: "dispatch", code: "dispatcher_unavailable" });
            return sendResult({
                result: "needs_attention",
                readiness: { kind: "broker_unavailable" },
                recovery: "Reconnect the broker Machine and try again.",
            });
        }
        const cancellation = new AbortController();
        const abort = () => cancellation.abort();
        request.raw.once("aborted", abort);
        reply.raw.once("close", abort);
        let stage: "dispatch" | "response_body" = "dispatch";
        try {
            const dispatched = await dispatch({
                actorAccountId: request.userId,
                resourceId: snapshot.resourceId,
                expectedResourceRevision: snapshot.expectedResourceRevision,
                brokerMachineId,
                application: selected.application,
                source: snapshot.source,
                verifiedCredentialEvidence: authorized.authorization.verifiedCredentialEvidence,
                request: selected.request,
                signal: cancellation.signal,
            });
            if (!dispatched.ok) {
                const readiness = dispatched.error === "broker_unavailable"
                    ? "broker_unavailable" as const
                    : dispatched.error === "policy_denied"
                        ? "policy_denied" as const
                        : "source_unavailable" as const;
                const code = dispatched.failureDetail?.code ?? dispatched.error;
                logger.warn({ module: "team-credential-resource-test", stage, code });
                return sendResult({
                    result: "needs_attention",
                    code,
                    requestId: selected.request.requestId,
                    failureDetail: dispatched.failureDetail,
                    // Each readiness kind carries only the reason its schema admits.
                    readiness: readiness === "broker_unavailable"
                        ? { kind: readiness, ...("reason" in dispatched && dispatched.reason === "incompatible"
                            ? { reason: dispatched.reason } : {}) }
                        : readiness === "source_unavailable"
                            ? { kind: readiness, ...(code === 'connected_service_credential_reconnect_required' ? { reason: code } : {}) }
                            : { kind: readiness },
                    recovery: readiness === "broker_unavailable"
                        ? "reason" in dispatched && dispatched.reason === "incompatible"
                            ? "Update the broker Machine and try again."
                            : "Reconnect the broker Machine and try again."
                        : "Review the credential source and policy, then try again.",
                });
            }
            stage = "response_body";
            for await (const _chunk of dispatched.body) {
                // Drain the bounded production response so the carrier closes.
            }
            return sendResult({
                result: "available",
                requestId: selected.request.requestId,
                readiness: { kind: "available" },
            });
        } catch {
            logger.warn({ module: "team-credential-resource-test", stage,
                code: cancellation.signal.aborted ? "request_cancelled" : "exception" });
            return sendResult({
                result: "needs_attention",
                requestId: selected.request.requestId,
                failureDetail: { code: "broker_unavailable", stage },
                readiness: { kind: "broker_unavailable" },
                recovery: "Reconnect the broker Machine and try again.",
            });
        } finally {
            request.raw.off("aborted", abort);
            reply.raw.off("close", abort);
        }
    });


    routes.post(homeDomainActionPathForMethod("teams.credentials.entitled.list", "POST"), {
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: TeamCredentialResourceReadInputV1Schema, response: { 200: TeamCredentialResourceEntitledPageV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialResourceReadInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const result = await inTx(tx => readTeamCredentialCatalogInTx(tx, {
            teamId: body.data.teamId,
            actorAccountId: request.userId,
            ...(body.data.resourceId ? { resourceId: body.data.resourceId } : {}),
            ...(body.data.application ? { application: body.data.application } : {}),
            ...(body.data.executionMachineId ? { executionMachineId: body.data.executionMachineId } : {}),
            ...(body.data.cursor ? { cursor: body.data.cursor } : {}),
            limit: body.data.limit,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }));
        if (!result.ok) return fail(reply, result.error);
        const current = await projectTeamCredentialCatalogBrokerReadiness(app, result);
        if (!body.data.application || current.projectionRequests.length === 0) return reply.send(current.page);
        return reply.send(await projectTeamCredentialCatalogModels(app, current, body.data.application));
    });

    routes.post(TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, {
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: TeamCredentialResourceDiscoverInputV1Schema, response: { 200: TeamCredentialResourceDiscoveryPageV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialResourceDiscoverInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const result = await inTx(tx => readTeamCredentialDiscoveryInTx(tx, {
            ...body.data,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }));
        if (!result.ok) return fail(reply, result.error);
        const current = await projectTeamCredentialCatalogBrokerReadiness(app, result);
        const page = body.data.application && current.projectionRequests.length > 0
            ? await projectTeamCredentialCatalogModels(app, current, body.data.application) : current.page;
        return reply.send({ ...page, failures: result.page.failures });
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.activity.list", "POST"), {
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: TeamCredentialResourceActivityReadInputV1Schema, response: { 200: TeamCredentialResourceActivityPageV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialResourceActivityReadInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const result = await inTx(tx => readTeamCredentialActivityInTx(tx, {
            actorAccountId: request.userId,
            resourceId: body.data.resourceId,
            cursor: body.data.cursor,
            limit: body.data.limit,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }));
        if (!result.ok) return fail(reply, result.error);
        return reply.send(TeamCredentialResourceActivityPageV1Schema.parse(result.page));
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.limits.list", "POST"), {
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: TeamCredentialUsageLimitListInputV1Schema, response: { 200: TeamCredentialUsageLimitListOutputV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_limit");
        const body = TeamCredentialUsageLimitListInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_limit");
        const result = await inTx(tx => listTeamCredentialUsageLimitsInTx(tx, {
            actorAccountId: request.userId,
            resourceId: body.data.resourceId,
            cursor: body.data.cursor,
            limit: body.data.limit,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }));
        if (!result.ok) return fail(reply, result.error);
        return reply.send(TeamCredentialUsageLimitListOutputV1Schema.parse({
            limits: result.limits,
            nextCursor: result.nextCursor,
        }));
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.limits.upsert", "POST"), {
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: TeamCredentialUsageLimitUpsertInputV1Schema, response: { 200: TeamCredentialUsageLimitUpsertOutputV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_limit");
        const body = TeamCredentialUsageLimitUpsertInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_limit");
        const result = await inTx(tx => upsertTeamCredentialUsageLimitInTx(tx, {
            actorAccountId: request.userId,
            body: body.data,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }), { isolationLevel: "Serializable" /* Limit mutation participates in the read-usage-then-admit quota family. */ });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(TeamCredentialUsageLimitUpsertOutputV1Schema.parse({
            resourceId: result.resourceId,
            revision: result.revision,
            limit: result.limit,
        }));
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.limits.delete", "POST"), {
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: TeamCredentialUsageLimitDeleteInputV1Schema, response: { 200: TeamCredentialResourceMutationResultV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_limit");
        const body = TeamCredentialUsageLimitDeleteInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_limit");
        const result = await inTx(tx => deleteTeamCredentialUsageLimitInTx(tx, {
            actorAccountId: request.userId,
            body: body.data,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }), { isolationLevel: "ReadCommitted" /* Exclusive complete Account admission precedes Team/resource locks and revision-fenced limit removal. */ });
        if (!result.ok) return fail(reply, result.error);
        return reply.send({ resourceId: result.resourceId, revision: result.revision });
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.usage.query", "POST"), {
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: TeamCredentialUsageQueryInputV1Schema, response: { 200: TeamCredentialUsageQueryResultV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialUsageQueryInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const result = await queryTeamCredentialUsage(
            request.userId,
            body.data,
            readTeamOperationAuthenticationFromRequest(request),
        );
        if ("ok" in result && !result.ok) return fail(reply, result.error);
        return reply.send(TeamCredentialUsageQueryResultV1Schema.parse(result));
    });

    // One admission decision for the external Provider API family, taken by the
    // shared policy owner: it already reads the `teams.credentialResources
    // .externalApi` bit fail-closed and only narrows further on deployment
    // readiness (public HTTPS base URL). A second route-app feature gate in
    // front of it could answer nothing this one does not, so the family keeps a
    // single decision-maker — the same shape the sibling external Provider API
    // routes use.
    const requireExternalApiDeploymentReadiness = async (request: object, reply: ErrorReply) => {
        const availability = resolveTeamCredentialExternalApiAvailability(
            resolveServerFeaturesForGating(await readHomeEffectiveEnv({ env, request })),
        );
        if (!availability.available) return reply.code(503).send({ error: "feature_disabled" });
    };

    routes.post(homeDomainActionPathForMethod("teams.credentials.externalKeys.create", "POST"), {
        preHandler: [requireExternalApiDeploymentReadiness, app.authenticate], attachValidation: true,
        schema: { body: TeamCredentialExternalApiKeyCreateInputV1Schema, response: { 200: TeamCredentialExternalApiKeyCreateOutputV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialExternalApiKeyCreateInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const result = await inTx(tx => createTeamCredentialExternalApiKeyInTx(tx, {
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            ...body.data,
        }), { isolationLevel: "Serializable" /* Key creation participates in resource currentness and membership/audience revocation. */ });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(TeamCredentialExternalApiKeyCreateOutputV1Schema.parse({ token: result.token, key: result.key }));
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.externalKeys.authorize", "POST"), {
        preHandler: [requireExternalApiDeploymentReadiness, app.authenticate], attachValidation: true,
        schema: { body: TeamCredentialExternalApiKeyAuthorizeInputV1Schema, response: { 200: TeamCredentialExternalApiKeyAuthorizeOutputV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialExternalApiKeyAuthorizeInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const result = await inTx(tx => authorizeTeamCredentialExternalApiKeyInTx(tx, {
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            ...body.data,
        }), { isolationLevel: "Serializable" /* Key authorization participates in resource currentness and membership/audience revocation. */ });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(TeamCredentialExternalApiKeyAuthorizeOutputV1Schema.parse({ key: result.key }));
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.externalKeys.list", "POST"), {
        preHandler: [requireExternalApiDeploymentReadiness, app.authenticate], attachValidation: true,
        schema: { body: TeamCredentialExternalApiKeyListInputV1Schema, response: { 200: TeamCredentialExternalApiKeyListOutputV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialExternalApiKeyListInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const result = await inTx(tx => listTeamCredentialExternalApiKeysInTx(tx, {
            actorAccountId: request.userId,
            resourceId: body.data.resourceId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }));
        if (!result.ok) return fail(reply, result.error);
        return reply.send(TeamCredentialExternalApiKeyListOutputV1Schema.parse({ keys: result.keys }));
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.externalKeys.revoke", "POST"), {
        preHandler: [requireExternalApiDeploymentReadiness, app.authenticate], attachValidation: true,
        schema: { body: TeamCredentialExternalApiKeyRevokeInputV1Schema, response: { 200: TeamCredentialExternalApiKeyRevokeOutputV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialExternalApiKeyRevokeInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const result = await inTx(tx => revokeTeamCredentialExternalApiKeyInTx(tx, {
            actorAccountId: request.userId,
            resourceId: body.data.resourceId,
            keyId: body.data.keyId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }), { isolationLevel: "ReadCommitted" /* Exclusive complete Account admission precedes Team/resource locks and the key census. */ });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(TeamCredentialExternalApiKeyRevokeOutputV1Schema.parse({ keyId: result.keyId, revoked: result.revoked }));
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.externalKeys.revokeAll", "POST"), {
        preHandler: [requireExternalApiDeploymentReadiness, app.authenticate], attachValidation: true,
        schema: { body: TeamCredentialExternalApiKeyRevokeAllInputV1Schema, response: { 200: TeamCredentialExternalApiKeyRevokeAllOutputV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialExternalApiKeyRevokeAllInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const result = await inTx(tx => revokeAllTeamCredentialExternalApiKeysInTx(tx, {
            actorAccountId: request.userId,
            resourceId: body.data.resourceId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }), { isolationLevel: "ReadCommitted" /* Exclusive complete Account admission fences concurrently admitted keys before the census. */ });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(TeamCredentialExternalApiKeyRevokeAllOutputV1Schema.parse({ resourceId: result.resourceId, revokedCount: result.revokedCount }));
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.create", "POST"), {
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: TeamCredentialResourceCreateInputV1Schema, response: { 200: TeamCredentialResourceSummaryV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialResourceCreateInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const result = await (async () => {
            try {
                let requestPolicySupport: TeamCredentialRequestPolicySupportEvidence | undefined;
                const attempt = async () => await inTx(async tx => {
                    const created = await createTeamCredentialResourceInTx(tx, {
                        actorAccountId: request.userId,
                        authentication: readTeamOperationAuthenticationFromRequest(request),
                        requestPolicySupport,
                        ...body.data,
                    });
                    if (!created.ok) return created;
                    const projected = await projectTeamCredentialResourceSummaryInTx(tx, created.resourceId, request.userId);
                    if (!projected.ok) throw new TeamCredentialCreateProjectionFailure(projected.error);
                    return { ok: true as const, resource: projected.resource };
                }, { isolationLevel: "ReadCommitted" /* Exclusive complete Team/recipient admission precedes source, audience and broker currentness reads. */ });
                let attempted = await attempt();
                if (!attempted.ok && attempted.error === "update_required" && body.data.requestPolicy !== null) {
                    const prepared = await inTx(tx => prepareTeamCredentialRequestPolicySupportInTx(tx, {
                        actorAccountId: request.userId,
                        authentication: readTeamOperationAuthenticationFromRequest(request),
                        scope: "source_draft",
                        teamId: body.data.teamId,
                        source: body.data.source,
                        brokerPlacement: body.data.brokerPlacement,
                    }));
                    if (!prepared.ok) {
                        if ("error" in prepared) return { ok: false as const, error: prepared.error };
                        return {
                            ok: false as const,
                            error: prepared.unavailable === 'connected_service_credential_reconnect_required'
                                ? prepared.unavailable : prepared.unavailable === "broker_unavailable"
                                ? "broker_unavailable" as const
                                : prepared.unavailable === "source_unavailable"
                                    ? "source_replaced_or_missing" as const
                                    : "update_required" as const,
                        };
                    }
                    const support = await resolveTeamCredentialRequestPolicySupport(app, prepared);
                    if (support.status !== "available") {
                        return {
                            ok: false as const,
                            error: support.reason === 'connected_service_credential_reconnect_required'
                                ? support.reason : support.reason === "broker_unavailable"
                                ? "broker_unavailable" as const
                                : support.reason === "source_unavailable"
                                    ? "source_replaced_or_missing" as const
                                    : "update_required" as const,
                        };
                    }
                    requestPolicySupport = {
                        source: prepared.source,
                        sourceCurrentness: prepared.sourceCurrentness,
                        models: support.models,
                    };
                    attempted = await attempt();
                }
                return attempted;
            } catch (cause) {
                if (cause instanceof TeamCredentialCreateProjectionFailure) {
                    fail(reply, cause.code);
                    return null;
                }
                throw cause;
            }
        })();
        if (result === null) return;
        if (!result.ok) return fail(reply, result.error, 'message' in result && typeof result.message === 'string' ? result.message : undefined);
        const [resource] = await projectTeamCredentialBrokerAdministrationReadiness(app, request.userId, [result.resource]);
        return reply.send(resource!);
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.audience.set", "POST"), {
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: TeamCredentialResourceAudienceInputV1Schema, response: { 200: TeamCredentialResourceMutationResultV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialResourceAudienceInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const result = await inTx(async tx => {
            const changed = await setTeamCredentialAudienceInTx(tx, {
                actorAccountId: request.userId,
                input: body.data,
                authentication: readTeamOperationAuthenticationFromRequest(request),
            });
            return changed.ok
                ? { resourceId: changed.resourceId, revision: changed.revision }
                : changed;
        }, { isolationLevel: "ReadCommitted" /* The canonical Team guard serializes fresh audience authority and recipient cleanup with material production. */ });
        if ('ok' in result && !result.ok) return fail(reply, result.error, 'message' in result && typeof result.message === 'string' ? result.message : undefined);
        return reply.send(TeamCredentialResourceMutationResultV1Schema.parse(result));
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.update", "POST"), {
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: TeamCredentialResourceUpdateInputV1Schema, response: { 200: TeamCredentialResourceMutationResultV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialResourceUpdateInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const proposedRequestPolicy = body.data.replacement?.requestPolicy ?? body.data.requestPolicy;
        const attempt = async (requestPolicySupport?: TeamCredentialRequestPolicySupportEvidence) => await inTx(async tx => {
            const changed = await updateTeamCredentialResourceInTx(tx, {
                actorAccountId: request.userId,
                patch: body.data,
                authentication: readTeamOperationAuthenticationFromRequest(request),
                requestPolicySupport,
            });
            return changed.ok
                ? { resourceId: changed.resourceId, revision: changed.revision }
                : changed;
        }, { isolationLevel: "ReadCommitted" /* The canonical Team guard and resource CAS precede fresh authority and material withdrawal. */ });
        let result = await attempt();
        if ("ok" in result && !result.ok && result.error === "update_required"
            && proposedRequestPolicy !== undefined && proposedRequestPolicy !== null) {
            const prepared = await inTx(tx => prepareTeamCredentialRequestPolicySupportInTx(tx, {
                actorAccountId: request.userId,
                authentication: readTeamOperationAuthenticationFromRequest(request),
                scope: "resource",
                resourceId: body.data.resourceId,
                ...(body.data.replacement?.custodian
                    ? {
                        custodian: {
                            source: body.data.replacement.custodian.source,
                            brokerPlacement: body.data.replacement.custodian.brokerPlacement,
                        },
                    }
                    : {}),
            }));
            if (!prepared.ok && "error" in prepared) return fail(reply, prepared.error);
            if (!prepared.ok && prepared.unavailable === 'connected_service_credential_reconnect_required') return fail(reply, prepared.unavailable);
            if (prepared.ok) {
                const support = await resolveTeamCredentialRequestPolicySupport(app, prepared);
                if (support.status === 'unavailable' && support.reason === 'connected_service_credential_reconnect_required') return fail(reply, support.reason);
                if (support.status === "available") {
                    result = await attempt({
                        source: prepared.source,
                        sourceCurrentness: prepared.sourceCurrentness,
                        models: support.models,
                    });
                }
            }
        }
        if ('ok' in result && !result.ok) return fail(reply, result.error, 'message' in result && typeof result.message === 'string' ? result.message : undefined);
        return reply.send(TeamCredentialResourceMutationResultV1Schema.parse(result));
    });

    routes.post(homeDomainActionPathForMethod("teams.credentials.delete", "POST"), {
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: TeamCredentialResourceDeleteInputV1Schema, response: { 200: TeamCredentialResourceMutationResultV1Schema, ...errors } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_resource_input");
        const body = TeamCredentialResourceDeleteInputV1Schema.safeParse(request.body);
        if (!body.success) return fail(reply, "invalid_resource_input");
        const result = await inTx(async tx => {
            const deleted = await deleteTeamCredentialResourceInTx(tx, {
                actorAccountId: request.userId,
                ...body.data,
                authentication: readTeamOperationAuthenticationFromRequest(request),
            });
            return deleted.ok ? { ok: true as const, result: { resourceId: body.data.resourceId, revision: body.data.expectedRevision } } : deleted;
        }, { transactionClass: "teams.credentials.delete", isolationLevel: "ReadCommitted" /* Exclusive complete Account admission precedes Team/resource locks and currentness reads. */ });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.result);
    });
}
