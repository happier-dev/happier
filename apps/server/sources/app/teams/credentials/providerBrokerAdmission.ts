import { brokerFailureForBindingRejection } from './brokerBindingFailure';
export { openTeamCredentialActionBroker, admitTeamCredentialActionBrokerRequest } from './actionBrokerAdmission';
import { z } from 'zod/mini';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { PROVIDER_BROKER_ROUTE_AUDIENCE_V1, ProviderBrokerOpenRequestV1Schema, ProviderBrokerRequestAdmissionV1Schema, SignedProviderBrokerRouteGrantV1Schema, type ProviderBrokerAdmissionFailureCodeV1, type ProviderBrokerOpenRequestV1, type ProviderBrokerOpenResponseV1, type ProviderBrokerRequestAdmissionV1, type SignedProviderBrokerRouteGrantV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { IrohEndpointDescriptorV1Schema } from '@happier-dev/protocol/connectivity/iroh/endpointDescriptorV1';
import { type MachineIrohEndpointAuthorityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { TeamCredentialRequestPolicyV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { type TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import { readTeamCredentialSourceBinding } from './sourceBindingRead';
import { type SessionTeamCredentialBindingRejectionV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingV1';
import { type TeamCredentialUsageLimitDenialV1 } from '@happier-dev/protocol/teams';
import type { VerifiedEphemeralSessionRunnerPrincipal } from '@happier-dev/protocol/ephemeralRunner/principal';

import { auth } from '@/app/auth/auth';
import { readActiveBrokerJobRowsInTx } from './activeBrokerJobRead';
import { logger } from '@/utils/logging/log';
import { classifyMachineDaemonPresence, type MachineDaemonPresenceInventory } from '@/app/machines/machineDaemonPresence';
import { readAvailableMachineIrohEndpointAuthority } from '@/app/machines/machineStateGuards';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { inTx, TransactionReplayRequiredError, type Tx } from '@/storage/inTx';
import { acquireAccountChangePublicationLocksInTx } from '@/app/changes/markAccountChanged';
import { readSessionAccountCursorAudienceInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { readTeamCredentialBrokerPresenceDemand, resolveTeamCredentialBrokerPlacementInTx, resolveTeamCredentialBrokerPlacementFingerprint, resolveTeamCredentialBrokerJobFingerprint, type TeamCredentialBrokerPlacementResolution } from './brokerPlacementResolver';
import { resolveTeamCredentialEntitlementInTx } from './resourceAccess';
import { admitTeamCredentialOperationBindingInTx, type TeamCredentialOperationConsumer } from './sessionBinding';
import { admitTeamCredentialUsageInTx } from './teamCredentialUsageAdmission';
import { signProviderBrokerRouteGrantV1 } from '@/app/machines/peer/mediation/signProviderBrokerRouteGrantV1';
import { projectTeamCredentialProviderModels } from './providerModelProjection';
import type { MachinePoolCandidateSnapshot } from '@/app/machines/pools/machinePoolService';
import { verifyRunnerBrokerOpenSelectionInTx } from '@/app/ephemeralRunner/runnerBrokerOpenSelection';
import { acquireProviderBrokerConsumerAdmissionInTx, admitProviderBrokerConsumerInTx, admitProviderBrokerTopology, readProviderBrokerInitiatorEndpointInTx } from '@/app/providers/brokerConsumerAdmission';

type ProviderProjectionReader = (input: Readonly<{
    custodianAccountId: string;
    brokerMachineId: string;
    source: TeamCredentialSourceBindingV1;
    agentTargetKey: string;
    application: ProviderBrokerOpenRequestV1['application'];
}>) => Promise<unknown>;

type PoolSourceEligibilityReader = (input: Readonly<{
    custodianAccountId: string;
    machineIds: readonly string[];
    teamId: string;
    resourceId: string;
    resourceRevision: number;
    source: TeamCredentialSourceBindingV1;
    application: ProviderBrokerOpenRequestV1['application'];
    modelId: string;
    sourceRevision: string;
    signal: AbortSignal;
}>) => Promise<Readonly<{
    eligibleMachineIds: ReadonlySet<string>;
    reasons: ReadonlyMap<string, string>;
}>>;

type BrokerOpenPresenceReader = (input: Readonly<{
    initiatorAccountId: string;
    initiatorMachineId: string;
    brokerAccountId: string;
    brokerMachineIds: readonly string[];
}>) => Promise<Readonly<{
    initiatorPresence: MachineDaemonPresenceInventory;
    brokerPresence: MachineDaemonPresenceInventory;
}>>;

/**
 * Provider broker streams use the existing native machine/1 HTTP tunnel, so
 * their signed open authority uses that carrier's admission/capture window.
 * This expiry bounds opening a new tunnel only; Session/Run and per-request
 * currentness remain owned by broker admission and are never extended by it.
 */
export const PROVIDER_BROKER_ROUTE_GRANT_TTL_MS =
    DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel;

type BrokerRefusalReason = Extract<TeamCredentialBrokerPlacementResolution, { error: 'broker_unavailable' }>['refusalReason']
    | 'binding_broker_unavailable' | 'broker_endpoint_changed' | 'preparation_endpoint_changed'
    | 'initiator_endpoint_missing' | 'initiator_offline' | 'initiator_presence_unknown'
    | 'placement_endpoint_missing' | 'presence_read_failed' | 'eligibility_read_failed' | 'eligibility_aborted'
    | 'broker_custodian_mismatch' | 'binding_resource_mismatch' | 'binding_delivery_mismatch'
    | 'binding_broker_entitlement_missing' | 'runner_selection_missing' | 'resource_lookup_missing'
    | 'execution_run_resource_entitlement_unavailable' | 'execution_run_broker_entitlement_missing'
    | 'consumer_machine_access_missing' | 'session_missing_or_inactive' | 'session_turn_not_in_progress'
    | 'session_turn_binding_mismatch' | 'execution_run_occurrence_mismatch' | 'execution_run_turn_not_active';

type Failure = Readonly<{
    ok: false;
    reasonCode: ProviderBrokerAdmissionFailureCodeV1 | 'token_limit_unavailable';
    usageLimit?: TeamCredentialUsageLimitDenialV1;
    refusalReason?: BrokerRefusalReason
        | Exclude<SessionTeamCredentialBindingRejectionV1, 'broker_unavailable'>
        | 'binding_missing';
}>;

type PublicFailure = Omit<Failure, 'refusalReason'>;

export type TeamCredentialProviderBrokerOpenResult =
    | Readonly<{
        ok: true;
        authority: SignedProviderBrokerRouteGrantV1;
        target: Extract<ProviderBrokerOpenResponseV1, { ok: true }>['target'];
    }>
    | PublicFailure;

export type TeamCredentialProviderBrokerOpenInput = Readonly<{
    actorAccountId: string;
    authentication: SessionAccessAuthentication;
    request: ProviderBrokerOpenRequestV1;
    readCurrentPresence: BrokerOpenPresenceReader;
    nowMs: number;
    grantId: string;
    signingKey: Readonly<{ keyId: string; secretKey: Uint8Array }>;
    readProviderProjection: ProviderProjectionReader;
    readPoolSourceEligibility?: PoolSourceEligibilityReader;
    resolveExecutionRunCurrentness?: TeamCredentialExecutionRunCurrentnessResolver;
    verifyRefreshAuthority?: (authority: SignedProviderBrokerRouteGrantV1) => boolean;
    signal?: AbortSignal;
}>;

type TeamCredentialProviderBrokerPreparedInput = TeamCredentialProviderBrokerOpenInput & Readonly<{
    initiatorPresence: MachineDaemonPresenceInventory;
    brokerPresence: MachineDaemonPresenceInventory;
}>;

type TeamCredentialProviderBrokerOperation =
    | Readonly<{ kind: 'session'; sessionId: string }>
    | Readonly<{ kind: 'execution_run'; executionRunId: string }>;

const PROVIDER_MODEL_SESSION_SLOT = { kind: 'provider_model' } as const;

function brokerOperationIdentity(consumer: ProviderBrokerOpenRequestV1['consumer']): string {
    return consumer.kind === 'session' ? consumer.sessionId : consumer.executionRunId;
}

type TeamCredentialProviderBrokerRequestAdmissionSuccess<
    TOperation extends TeamCredentialProviderBrokerOperation = TeamCredentialProviderBrokerOperation,
> = Readonly<{
    ok: true;
    resourceId: string;
    brokerMachineId: string;
    source: TeamCredentialSourceBindingV1;
    operation: TOperation;
    usageEventId: string | null;
}>;

export type TeamCredentialProviderBrokerRequestAdmissionResult =
    | TeamCredentialProviderBrokerRequestAdmissionSuccess
    | PublicFailure;

export type TeamCredentialExecutionRunCurrentnessResolver = (input: Readonly<{
    executionRunId: string;
    requestingAccountId: string;
    workerMachineId: string;
    expectedIntent?: import('@happier-dev/protocol').ExecutionRunIntent;
    expectedOccurrenceId: string | null;
    expectedDirectMaterialUse?: import('@happier-dev/protocol/teams').TeamCredentialDirectMaterialUseV1;
}>) => Promise<
    | Readonly<{
        ok: true;
        parentSessionId: string | null;
        occurrenceId: string;
        intent: import('@happier-dev/protocol').ExecutionRunIntent;
        runtimeState: 'active_turn' | 'idle';
        activeTurnId?: string | null;
        /**
         * The Run owner's own accepted provider-model selection, or null when
         * the Run selected nothing and inherits its parent Session's. Only
         * broker admission consumes it; absent means unproven.
         */
        teamCredentialProviderModel?: Readonly<{
            resourceId: string;
            deliveryMode: import('@happier-dev/protocol/teams').TeamCredentialRouteV1;
        }> | null;
    }>
    | Failure
>;

function failure(reasonCode: Failure['reasonCode'], usageLimit?: TeamCredentialUsageLimitDenialV1): Failure {
    return {
        ok: false, reasonCode, ...(usageLimit ? { usageLimit } : {}),
        ...(reasonCode === 'broker_unavailable' ? { refusalReason: 'binding_broker_unavailable' as const } : {}),
    };
}

function brokerUnavailable(refusalReason: BrokerRefusalReason): Failure {
    return { ok: false, reasonCode: 'broker_unavailable', refusalReason };
}

function closedFailure(reasonCode: Failure['reasonCode'], refusalReason: BrokerRefusalReason): Failure {
    return { ok: false, reasonCode, refusalReason };
}

function consumerAdmissionFailure(reasonCode: ProviderBrokerAdmissionFailureCodeV1): Failure {
    return reasonCode === 'resource_forbidden'
        ? closedFailure(reasonCode, 'consumer_machine_access_missing')
        : failure(reasonCode);
}

function bindingFailure(
    reasonCode: Failure['reasonCode'],
    refusalReason: SessionTeamCredentialBindingRejectionV1 | 'binding_missing',
): Failure {
    return {
        ok: false,
        reasonCode,
        refusalReason: refusalReason === 'broker_unavailable' ? 'binding_broker_unavailable' : refusalReason,
    };
}

/** Emit only the settled refusal, outside replayable transactions, and keep diagnostics off the wire. */
function reportBrokerAdmissionFailure(operation: 'open' | 'catalog' | 'request', result: Failure): PublicFailure {
    const { refusalReason, ...response } = result;
    try {
        logger.warn({
            module: 'provider-broker-admission', operation,
            reasonCode: result.reasonCode, refusalReason: refusalReason ?? result.reasonCode,
        });
    } catch {
        // A diagnostic sink failure cannot replace the admission decision.
    }
    return response;
}

/**
 * Whose accepted selection authorizes this broker operation. A Session is its
 * own witness. An Execution Run is authorized on the selection its own Run
 * owner attests (`PLAN.md` §2.3 — an independently owned Run binding), never
 * on whatever resource the open names; a Run that selected nothing inherits,
 * so it is authorized on its parent Session's accepted selection and only on
 * that. The admission owner then requires the admitted resource and route to
 * be this operation's.
 */
function brokerOperationConsumer(
    consumer: ProviderBrokerOpenRequestV1['consumer'],
    executionRun: Pick<CurrentExecutionRun, 'parentSessionId' | 'teamCredentialProviderModel'> | null,
    resourceId: string,
): TeamCredentialOperationConsumer | Failure {
    if (consumer.kind === 'session') return { kind: 'session', sessionId: consumer.sessionId };
    if (executionRun === null || executionRun.teamCredentialProviderModel === undefined) {
        return failure('execution_run_authority_unavailable');
    }
    const own = executionRun.teamCredentialProviderModel;
    if (own === null) {
        return executionRun.parentSessionId === null
            ? failure('operation_not_current')
            : { kind: 'session', sessionId: executionRun.parentSessionId };
    }
    if (own.resourceId !== resourceId || own.deliveryMode !== 'brokered') return failure('operation_not_current');
    return { kind: 'execution_run', parentSessionId: executionRun.parentSessionId, resourceId: own.resourceId };
}


/**
 * Metadata-only authorization for the current source-owned model projection.
 * It intentionally returns no source binding or operation handle: callers can
 * prove current authority, but cannot use this leaf to acquire credentials or
 * commit request usage.
 */
export async function authorizeTeamCredentialProviderModelCatalog(
    input: Parameters<typeof authorizeTeamCredentialProviderModelCatalogUnreported>[0],
): Promise<Readonly<{ ok: true }> | PublicFailure> {
    const result = await authorizeTeamCredentialProviderModelCatalogUnreported(input);
    return result.ok ? result : reportBrokerAdmissionFailure('catalog', result);
}

async function authorizeTeamCredentialProviderModelCatalogUnreported(
    input: Readonly<{
        authenticatedBrokerAccountId: string;
        authority: SignedProviderBrokerRouteGrantV1;
        expectedResourceRevision: number;
        verifyAuthority: (authority: SignedProviderBrokerRouteGrantV1) => boolean;
        resolveExecutionRunCurrentness?: TeamCredentialExecutionRunCurrentnessResolver;
    }>,
): Promise<Readonly<{ ok: true }> | Failure> {
    const authority = SignedProviderBrokerRouteGrantV1Schema.safeParse(input.authority);
    if (!authority.success || !input.verifyAuthority(authority.data)) return failure('invalid_request');
    let executionRun: CurrentExecutionRun | undefined;
    if (authority.data.payload.consumer.kind === 'execution_run') {
        if (!input.resolveExecutionRunCurrentness) return failure('execution_run_authority_unavailable');
        const current = await input.resolveExecutionRunCurrentness({
            executionRunId: authority.data.payload.consumer.executionRunId,
            requestingAccountId: authority.data.payload.initiator.accountId,
            workerMachineId: authority.data.payload.initiator.machineId,
            expectedOccurrenceId: authority.data.payload.executionRunOccurrenceId ?? null,
        });
        if (!current.ok) return current;
        if (!authority.data.payload.executionRunOccurrenceId
            || current.occurrenceId !== authority.data.payload.executionRunOccurrenceId) {
            return closedFailure('operation_not_current', 'execution_run_occurrence_mismatch');
        }
        executionRun = current;
    }
    return await inTx(async tx => {
        const grant = authority.data.payload;
        if (grant.target.custodianAccountId !== input.authenticatedBrokerAccountId) {
            return closedFailure('resource_forbidden', 'broker_custodian_mismatch');
        }
        const job = await readActiveBrokerJobInTx(tx, {
            grant,
            expectedResourceRevision: input.expectedResourceRevision,
            generation: false,
            executionRun: executionRun ?? null,
        });
        return job.ok ? { ok: true } : job;
    }, { isolationLevel: "ReadCommitted" /* Signed admitted-job currentness is one indexed read. */ });
}

type CurrentExecutionRun = Extract<
    Awaited<ReturnType<TeamCredentialExecutionRunCurrentnessResolver>>,
    { ok: true }
>;

type BrokerOpenPreparation = Readonly<{
    request: ProviderBrokerOpenRequestV1;
    sessionId: string | null;
    executionRunOccurrenceId: string | null;
    resource: Readonly<{
        teamId: string;
        custodianAccountId: string;
        brokerMachineId: string | null;
        brokerPoolId: string | null;
        revision: number;
        sourceBindingJson: string;
        requestPolicyJson: string | null;
    }>;
    source: TeamCredentialSourceBindingV1;
    allowedModelIds: readonly string[] | null;
    initiatorEndpoint: Readonly<{ endpointId: string; revision: number; machineKind: string; custodianAccountId: string }>;
    poolSnapshot: MachinePoolCandidateSnapshot | null;
    poolCandidateMachineIds: readonly string[];
    broker: Readonly<{
        machineId: string;
        endpointAuthority: MachineIrohEndpointAuthorityV1;
    }> | null;
}>;

type BrokerOpenDurableAuthorization = Readonly<{
    request: ProviderBrokerOpenRequestV1;
    sessionId: string | null;
    executionRunOccurrenceId: string | null;
    resource: BrokerOpenPreparation['resource'];
    source: TeamCredentialSourceBindingV1;
    allowedModelIds: readonly string[] | null;
    initiatorEndpoint: BrokerOpenPreparation['initiatorEndpoint'];
    pinnedMachineId: string | null;
}>;

type BrokerOpenPreparationResult = BrokerOpenPreparation | Failure;

function isFailure(value: object): value is Failure {
    return 'ok' in value && value.ok === false;
}

function poolSnapshotsEqual(
    left: MachinePoolCandidateSnapshot | null,
    right: MachinePoolCandidateSnapshot | null,
): boolean {
    if (left === null || right === null) return left === right;
    const leftMembers = [...left.members].sort((a, b) => a.machineId.localeCompare(b.machineId));
    const rightMembers = [...right.members].sort((a, b) => a.machineId.localeCompare(b.machineId));
    // Only the Pool definition is compared. Another member's live socket
    // coming or going between the two reads is not a change to this open:
    // the selected Machine's own presence, eligibility and endpoint are
    // rechecked independently by the final placement resolution.
    return left.poolId === right.poolId
        && left.revision === right.revision
        && leftMembers.length === rightMembers.length
        && leftMembers.every((member, index) => {
            const candidate = rightMembers[index];
            return candidate !== undefined
                && member.machineId === candidate.machineId
                && member.priorityTier === candidate.priorityTier
                && member.enabled === candidate.enabled;
        });
}

function preparationChangeFailure(
    left: BrokerOpenPreparation,
    right: BrokerOpenPreparation,
): Failure | null {
    if (left.sessionId !== right.sessionId
        || left.executionRunOccurrenceId !== right.executionRunOccurrenceId) {
        return failure('operation_not_current');
    }
    if (left.resource.teamId !== right.resource.teamId
        || left.resource.custodianAccountId !== right.resource.custodianAccountId
        || left.resource.brokerMachineId !== right.resource.brokerMachineId
        || left.resource.brokerPoolId !== right.resource.brokerPoolId
        || left.resource.revision !== right.resource.revision
        || left.resource.sourceBindingJson !== right.resource.sourceBindingJson
        || left.resource.requestPolicyJson !== right.resource.requestPolicyJson
        || !pluginJsonValuesEqual(left.source, right.source)
        || !pluginJsonValuesEqual(left.allowedModelIds, right.allowedModelIds)
        || !poolSnapshotsEqual(left.poolSnapshot, right.poolSnapshot)) {
        return failure('resource_changed');
    }
    const exactBrokerChanged = left.broker !== null && (
        right.broker === null
        || left.broker.machineId !== right.broker.machineId
        || left.broker.endpointAuthority.endpointId !== right.broker.endpointAuthority.endpointId
        || left.broker.endpointAuthority.revision !== right.broker.endpointAuthority.revision
    );
    if (left.initiatorEndpoint.custodianAccountId !== right.initiatorEndpoint.custodianAccountId
        || left.initiatorEndpoint.endpointId !== right.initiatorEndpoint.endpointId
        || left.initiatorEndpoint.revision !== right.initiatorEndpoint.revision
        || exactBrokerChanged) {
        return brokerUnavailable('preparation_endpoint_changed');
    }
    return null;
}

async function resolveOpenExecutionRunCurrentness(
    input: TeamCredentialProviderBrokerOpenInput,
    request: ProviderBrokerOpenRequestV1,
): Promise<CurrentExecutionRun | Failure | null> {
    if (request.consumer.kind !== 'execution_run') return null;
    if (!input.resolveExecutionRunCurrentness) return failure('execution_run_authority_unavailable');
    const current = await input.resolveExecutionRunCurrentness({
        executionRunId: request.consumer.executionRunId,
        requestingAccountId: input.actorAccountId,
        workerMachineId: request.initiatorMachineId,
        expectedOccurrenceId: request.refreshAuthority?.payload.consumer.kind === 'execution_run'
            ? request.refreshAuthority.payload.executionRunOccurrenceId ?? null
            : null,
    });
    if (!current.ok) return current;
    const expectedOccurrenceId = request.refreshAuthority?.payload.consumer.kind === 'execution_run'
        ? request.refreshAuthority.payload.executionRunOccurrenceId ?? null
        : null;
    if (expectedOccurrenceId !== null && current.occurrenceId !== expectedOccurrenceId) {
        return closedFailure('operation_not_current', 'execution_run_occurrence_mismatch');
    }
    return current;
}

/**
 * Authorizes the durable Session/Run binding and resource before callers read
 * Machine presence or contact any daemon. Availability and endpoint facts are
 * deliberately left to the later preparation stage and its final recheck.
 */
async function authorizeTeamCredentialProviderBrokerOpenDurableInTx(
    tx: Tx,
    input: TeamCredentialProviderBrokerOpenInput & Readonly<{
        runnerPrincipal?: VerifiedEphemeralSessionRunnerPrincipal;
    }>,
    request: ProviderBrokerOpenRequestV1,
    executionRun: CurrentExecutionRun | null,
    finalInitiatorCustodianAccountId?: string,
): Promise<BrokerOpenDurableAuthorization | Failure> {
    const resourceIdentity = await tx.teamCredentialResource.findUnique({
        where: { id: request.resourceId }, select: { custodianAccountId: true },
    });
    const admissionSessionId = request.consumer.kind === 'session' ? request.consumer.sessionId : executionRun?.parentSessionId;
    const admissionAudience = await readSessionAccountCursorAudienceInTx(tx, admissionSessionId ? [admissionSessionId] : [],
        [input.actorAccountId, ...(resourceIdentity ? [resourceIdentity.custodianAccountId] : [])]);
    if (finalInitiatorCustodianAccountId !== undefined) {
        // Preparation supplies custody only as a cohort hint. The final
        // endpoint/consumer reads and preparation comparison recheck it;
        // acquire the whole cohort together, never extend a held requester lock.
        await acquireProviderBrokerConsumerAdmissionInTx(tx, {
            accountIds: admissionAudience.accountIds,
            custodianAccountIds: [finalInitiatorCustodianAccountId],
        });
    } else {
        await acquireAccountChangePublicationLocksInTx(tx, admissionAudience.accountIds, { includeSingleAccount: true });
    }
    if (!await auth.isSignedCredentialCurrent(tx, input.actorAccountId, input.authentication.tokenEpoch)) {
        return failure('operation_not_current');
    }
    let sessionId: string | null;
    let executionRunOccurrenceId: string | null = null;
    if (request.consumer.kind === 'execution_run') {
        if (executionRun === null) return failure('execution_run_authority_unavailable');
        sessionId = executionRun.parentSessionId;
        executionRunOccurrenceId = executionRun.occurrenceId;
    } else {
        sessionId = request.consumer.sessionId;
    }
    const consumerAdmission = await admitProviderBrokerConsumerInTx(tx, {
        accountId: input.actorAccountId, initiatorMachineId: request.initiatorMachineId,
        consumer: request.consumer, executionRun,
    });
    if (!consumerAdmission.ok) return consumerAdmissionFailure(consumerAdmission.reasonCode);
    // A restricted Runner consumes the exact placement its reviewed activation
    // froze. Ordinary fresh opens let the placement owner select a Pool member.
    const runnerSelection = input.runnerPrincipal
        ? await verifyRunnerBrokerOpenSelectionInTx(tx, {
            principal: input.runnerPrincipal,
            request,
        })
        : null;
    if (input.runnerPrincipal && !runnerSelection) {
        return closedFailure('resource_forbidden', 'runner_selection_missing');
    }
    const establishedBrokerMachineId = runnerSelection?.brokerMachineId ?? null;
    const establishedPlacement = establishedBrokerMachineId === null
        ? {}
        : {
            expectedBrokerMachineId: establishedBrokerMachineId,
            brokerSelection: 'established' as const,
        };
    const consumer = brokerOperationConsumer(request.consumer, executionRun, request.resourceId);
    if ('ok' in consumer) return consumer;
    const admitted = await admitTeamCredentialOperationBindingInTx(tx, {
        consumer,
        accountId: input.actorAccountId,
        slot: PROVIDER_MODEL_SESSION_SLOT,
        expectedResourceRevision: request.expectedResourceRevision,
        ...establishedPlacement,
        deliveryMode: 'brokered',
        authentication: input.authentication,
    });
    if (!admitted.ok) {
        // A fresh open answers every resource-authority refusal with one code
        // so that a resource which exists but is not this caller's cannot be
        // told apart from one that does not exist — the enumeration contract
        // `providerBrokerRoutes.spec.ts` pins. Authentication failure
        // is also precise: the binding owner observes it only after entitlement
        // and Team qualification have admitted this caller's exact source.
        return bindingFailure(
            admitted.reason === 'connected_service_credential_reconnect_required'
                ? brokerFailureForBindingRejection(admitted.reason)
                : admitted.reason === 'resource_changed' ? 'resource_changed' : 'resource_forbidden',
            admitted.reason,
        );
    }
    if (admitted.binding.resourceId !== request.resourceId) {
        return closedFailure('resource_forbidden', 'binding_resource_mismatch');
    }
    if (admitted.binding.deliveryMode !== 'brokered') {
        return closedFailure('resource_forbidden', 'binding_delivery_mismatch');
    }
    if (admitted.binding.resourceRevision !== request.expectedResourceRevision) {
        return failure('resource_changed');
    }
    if (!admitted.entitlement.mayBroker) {
        return closedFailure('resource_forbidden', 'binding_broker_entitlement_missing');
    }

    const resource = await tx.teamCredentialResource.findUnique({
        where: { id: request.resourceId },
        select: {
            teamId: true,
            custodianAccountId: true,
            brokerMachineId: true,
            brokerPoolId: true,
            revision: true,
            sourceBindingJson: true,
            requestPolicyJson: true,
        },
    });
    if (!resource) return closedFailure('resource_forbidden', 'resource_lookup_missing');
    if (resource.custodianAccountId !== resourceIdentity?.custodianAccountId) {
        throw new TransactionReplayRequiredError('transaction-account-audience-changed');
    }
    if (resource.revision !== request.expectedResourceRevision) return failure('resource_changed');
    // Team brokerage serves a different Account. Refuse self-custody before
    // presence/projection work or strict route signing; co-hosted daemons with
    // distinct Account/Machine/endpoint identities still use the normal path.
    if (resource.custodianAccountId === input.actorAccountId) return failure('resource_unavailable');
    let rawPolicy: unknown = null;
    try {
        rawPolicy = resource.requestPolicyJson === null ? null : JSON.parse(resource.requestPolicyJson);
    } catch {
        return failure('resource_unavailable');
    }
    const source = readTeamCredentialSourceBinding(resource.sourceBindingJson);
    const policy = z.nullable(TeamCredentialRequestPolicyV1Schema).safeParse(rawPolicy);
    if (!source.success || !policy.success) return failure('resource_unavailable');
    // A fresh Runner open remains bound to its reviewed selection and revision.
    if (runnerSelection !== null && (
        runnerSelection.resourceId !== request.resourceId
        || runnerSelection.revision !== request.expectedResourceRevision
        || !pluginJsonValuesEqual(runnerSelection.application, request.application)
        || runnerSelection.sourceRevision !== request.sourceRevision
    )) return failure('resource_changed');
    const initiatorEndpoint = await readProviderBrokerInitiatorEndpointInTx(tx, {
        accountId: input.actorAccountId,
        machineId: request.initiatorMachineId,
        sessionId,
    });
    if (!initiatorEndpoint) return brokerUnavailable('initiator_endpoint_missing');
    return {
        request,
        sessionId,
        executionRunOccurrenceId,
        resource,
        source: source.data,
        allowedModelIds: policy.data?.allowedModelIds ?? null,
        initiatorEndpoint,
        pinnedMachineId: establishedBrokerMachineId,
    };
}

/**
 * Reads and validates durable broker-open authority only. Presence is a
 * caller-captured snapshot for this stage; orchestration refreshes it before
 * the final signing stage. No daemon or other external RPC is permitted here.
 */
async function prepareTeamCredentialProviderBrokerOpenInTx(
    tx: Tx,
    input: TeamCredentialProviderBrokerPreparedInput & Readonly<{
        runnerPrincipal?: VerifiedEphemeralSessionRunnerPrincipal;
    }>,
    request: ProviderBrokerOpenRequestV1,
    executionRun: CurrentExecutionRun | null,
    selectedPoolMachineId: string | null,
    poolEligibleMachineIds: ReadonlySet<string> | null,
    finalInitiatorCustodianAccountId?: string,
): Promise<BrokerOpenPreparationResult> {
    const authorized = await authorizeTeamCredentialProviderBrokerOpenDurableInTx(
        tx,
        input,
        request,
        executionRun,
        finalInitiatorCustodianAccountId,
    );
    if (isFailure(authorized)) return authorized;
    const { request: parsedRequest, resource, pinnedMachineId } = authorized;
    const initiatorEndpoint = authorized.initiatorEndpoint;
    const initiatorPresence = classifyMachineDaemonPresence(input.initiatorPresence, parsedRequest.initiatorMachineId);
    if (initiatorPresence !== 'connected') {
        return brokerUnavailable(initiatorPresence === 'unknown' ? 'initiator_presence_unknown' : 'initiator_offline');
    }
    const placement = await resolveTeamCredentialBrokerPlacementInTx(tx, {
        resource: {
            id: parsedRequest.resourceId,
            custodianAccountId: resource.custodianAccountId,
            brokerMachineId: resource.brokerMachineId,
            brokerPoolId: resource.brokerPoolId,
        },
        presence: input.brokerPresence,
        requestKey: [
            parsedRequest.resourceId,
            parsedRequest.consumer.kind,
            brokerOperationIdentity(parsedRequest.consumer),
        ].join('\u0000'),
        pinnedMachineId,
        poolInitiator: { machineId: parsedRequest.initiatorMachineId, endpointId: initiatorEndpoint.endpointId },
        ...(poolEligibleMachineIds === null ? {} : { poolEligibleMachineIds }),
        ...(selectedPoolMachineId === null ? {} : { expectedPoolMachineId: selectedPoolMachineId }),
    });
    if (!placement.ok) {
        return placement.error === 'broker_unavailable'
            ? brokerUnavailable(placement.refusalReason)
            : failure(placement.error);
    }
    // The private broker open is an Iroh peer tunnel, so this consumer — unlike
    // the relay-reached resource test and external API key — cannot proceed
    // without the Machine's own endpoint authority.
    const endpointAuthority = placement.broker?.endpointAuthority ?? null;
    if (placement.broker !== null && endpointAuthority === null) return brokerUnavailable('placement_endpoint_missing');
    const broker = placement.broker === null || endpointAuthority === null
        ? null
        : { machineId: placement.broker.machineId, endpointAuthority };
    // Check the resolved target (including Pool selection), not the saved
    // location. The peer carrier requires separate Machine/endpoint identities.
    if (broker !== null) {
        const topology = admitProviderBrokerTopology(
            { machineId: parsedRequest.initiatorMachineId, endpointId: initiatorEndpoint.endpointId },
            { machineId: broker.machineId, endpointId: broker.endpointAuthority.endpointId },
        );
        if (!topology.ok) return topology;
    }
    return {
        request: authorized.request,
        sessionId: authorized.sessionId,
        executionRunOccurrenceId: authorized.executionRunOccurrenceId,
        resource: authorized.resource,
        source: authorized.source,
        allowedModelIds: authorized.allowedModelIds,
        initiatorEndpoint,
        poolSnapshot: placement.poolSnapshot,
        poolCandidateMachineIds: placement.candidateMachineIds,
        broker,
    };
}

function finalizePreparedBrokerOpen(
    input: TeamCredentialProviderBrokerOpenInput,
    prepared: BrokerOpenPreparation,
    projectionResponse: unknown,
): TeamCredentialProviderBrokerOpenResult {
    if (prepared.broker === null) return brokerUnavailable('broker_selection_missing');
    const selection = projectTeamCredentialProviderModels({
        response: projectionResponse,
        resourceId: prepared.request.resourceId,
        teamId: prepared.resource.teamId,
        resourceRevision: prepared.resource.revision,
        agentTargetKey: prepared.request.application.agentTargetKey,
        application: prepared.request.application,
        allowedModelIds: prepared.allowedModelIds,
        source: prepared.source,
        deliveryMode: 'brokered',
    }).models.find(candidate => (
        candidate.selection.modelId === prepared.request.modelId
        && candidate.sourceRevision === prepared.request.sourceRevision
        && pluginJsonValuesEqual(candidate.application, prepared.request.application)
    ));
    if (!selection) return failure('resource_unavailable');
    const brokerPlacementFingerprint = resolveTeamCredentialBrokerJobFingerprint(
        resolveTeamCredentialBrokerPlacementFingerprint({ ...prepared.resource, id: prepared.request.resourceId }),
        prepared.resource.revision,
    );
    if (brokerPlacementFingerprint === null) return failure('resource_unavailable');
    const authority = signProviderBrokerRouteGrantV1({
        payload: {
            v: 1,
            grantId: input.grantId,
            aud: PROVIDER_BROKER_ROUTE_AUDIENCE_V1,
            issuedAt: input.nowMs,
            // This bounds capture of a new Machine HTTP-tunnel admission. It
            // is not a broker/session lifetime and deliberately reuses the
            // existing carrier owner's direct-tunnel anti-capture bound.
            expiresAt: input.nowMs + PROVIDER_BROKER_ROUTE_GRANT_TTL_MS,
            teamId: prepared.resource.teamId,
            resourceId: prepared.request.resourceId,
            sourceRevision: selection.sourceRevision,
            brokerPlacementFingerprint,
            initiatorTokenEpoch: input.authentication.tokenEpoch!,
            initiator: {
                accountId: input.actorAccountId,
                machineId: prepared.request.initiatorMachineId,
                endpointId: prepared.initiatorEndpoint.endpointId,
            },
            target: {
                custodianAccountId: prepared.resource.custodianAccountId,
                machineId: prepared.broker.machineId,
                endpointId: prepared.broker.endpointAuthority.endpointId,
            },
            consumer: prepared.request.consumer,
            ...(prepared.request.consumer.kind === 'execution_run'
                ? { executionRunOccurrenceId: prepared.executionRunOccurrenceId! }
                : {}),
            application: selection.application,
            // Provenance of the exact credential that opened this operation.
            // It is qualified here, at admission; the retained check and model
            // requests do not re-qualify it (sign-in policy changes apply to
            // new opens and turns).
            ...(input.authentication.authenticationEvidence
                && input.authentication.authenticationEvidence.length > 0
                ? {
                    verifiedCredentialEvidence: {
                        v: 1 as const,
                        evidence: [...input.authentication.authenticationEvidence],
                    },
                }
                : {}),
        },
        signingKey: input.signingKey,
    });
    return {
        ok: true,
        authority,
        target: {
            custodianAccountId: prepared.resource.custodianAccountId,
            brokerMachineId: prepared.broker.machineId,
            endpointId: prepared.broker.endpointAuthority.endpointId,
            endpointRevision: prepared.broker.endpointAuthority.revision,
            endpoint: IrohEndpointDescriptorV1Schema.parse({
                endpointId: prepared.broker.endpointAuthority.endpointId,
                relayUrls: prepared.broker.endpointAuthority.relayUrls,
                directAddresses: prepared.broker.endpointAuthority.directAddresses,
            }),
        },
    };
}

async function preauthorizeTeamCredentialProviderBrokerOpen(
    input: TeamCredentialProviderBrokerOpenInput & Readonly<{
        runnerPrincipal?: VerifiedEphemeralSessionRunnerPrincipal;
    }>,
    request: ProviderBrokerOpenRequestV1,
): Promise<Readonly<{
    authorization: BrokerOpenDurableAuthorization;
    executionRun: CurrentExecutionRun | null;
}> | Failure> {
    // Execution Run currentness is process-owned and can require daemon RPC.
    // Gate that call behind current resource entitlement so a missing or
    // foreign resource cannot be used to trigger or observe external work.
    if (request.consumer.kind === 'execution_run') {
        const entitlement = await inTx(tx => resolveTeamCredentialEntitlementInTx(tx, {
            resourceId: request.resourceId,
            accountId: input.actorAccountId,
        }));
        if (!entitlement.ok) {
            return closedFailure('resource_forbidden', 'execution_run_resource_entitlement_unavailable');
        }
        if (!entitlement.mayBroker) {
            return closedFailure('resource_forbidden', 'execution_run_broker_entitlement_missing');
        }
        if (entitlement.resourceRevision !== request.expectedResourceRevision) {
            return failure('resource_changed');
        }
    }
    const executionRun = await resolveOpenExecutionRunCurrentness(input, request);
    if (executionRun !== null && !executionRun.ok) return executionRun;
    const authorization = await inTx(tx => authorizeTeamCredentialProviderBrokerOpenDurableInTx(
        tx,
        input,
        request,
        executionRun,
    ));
    if (isFailure(authorization)) return authorization;
    return { authorization, executionRun };
}

async function openTeamCredentialProviderBrokerWithPrincipal(
    input: TeamCredentialProviderBrokerOpenInput & Readonly<{
        runnerPrincipal?: VerifiedEphemeralSessionRunnerPrincipal;
    }>,
): Promise<TeamCredentialProviderBrokerOpenResult> {
    const parsed = ProviderBrokerOpenRequestV1Schema.safeParse(input.request);
    if (!parsed.success) return failure('invalid_request');
    if (parsed.data.refreshAuthority !== undefined
        && !input.verifyRefreshAuthority?.(parsed.data.refreshAuthority)) {
        return failure('invalid_request');
    }
    if (parsed.data.refreshAuthority !== undefined) {
        const grant = parsed.data.refreshAuthority.payload;
        if (grant.resourceId !== parsed.data.resourceId
            || grant.sourceRevision !== parsed.data.sourceRevision
            || grant.initiator.accountId !== input.actorAccountId
            || grant.initiator.machineId !== parsed.data.initiatorMachineId
            || !pluginJsonValuesEqual(grant.consumer, parsed.data.consumer)
            || !pluginJsonValuesEqual(grant.application, parsed.data.application)
            || (input.runnerPrincipal !== undefined && (
                input.runnerPrincipal.accountId !== grant.initiator.accountId
                || input.runnerPrincipal.machineId !== grant.initiator.machineId
                || grant.consumer.kind !== 'session'
                || input.runnerPrincipal.sessionId !== grant.consumer.sessionId
            ))) return failure('invalid_request');
        const executionRun = await resolveOpenExecutionRunCurrentness(input, parsed.data);
        if (executionRun !== null && !executionRun.ok) return executionRun;
        // Renewal replaces only the carrier proof's lifetime. The signed job
        // already owns source, application and placement admission.
        const job = await inTx(tx => readActiveBrokerJobInTx(tx, {
            grant,
            expectedResourceRevision: parsed.data.expectedResourceRevision,
            generation: false,
            executionRun,
        }), { isolationLevel: 'ReadCommitted' });
        if (!job.ok) return job;
        // The payload carries endpoint identity, not its dial hints. Consume
        // the transport owner's projection for that exact signed target.
        const endpoint = await readAvailableMachineIrohEndpointAuthority({
            accountId: grant.target.custodianAccountId,
            machineId: grant.target.machineId,
        });
        if (endpoint === null) return brokerUnavailable('placement_endpoint_missing');
        if (endpoint.endpointId !== grant.target.endpointId) return brokerUnavailable('broker_endpoint_changed');
        return {
            ok: true,
            authority: signProviderBrokerRouteGrantV1({
                payload: {
                    ...grant,
                    grantId: input.grantId,
                    issuedAt: input.nowMs,
                    expiresAt: input.nowMs + PROVIDER_BROKER_ROUTE_GRANT_TTL_MS,
                },
                signingKey: input.signingKey,
            }),
            target: {
                custodianAccountId: grant.target.custodianAccountId,
                brokerMachineId: grant.target.machineId,
                endpointId: grant.target.endpointId,
                endpointRevision: endpoint.revision,
                endpoint: IrohEndpointDescriptorV1Schema.parse({
                    endpointId: endpoint.endpointId,
                    relayUrls: endpoint.relayUrls,
                    directAddresses: endpoint.directAddresses,
                }),
            },
        };
    }
    const preauthorized = await preauthorizeTeamCredentialProviderBrokerOpen(input, parsed.data);
    if (isFailure(preauthorized)) return preauthorized;
    let initialPresence: Awaited<ReturnType<BrokerOpenPresenceReader>>;
    try {
        const brokerMachineIds = await readTeamCredentialBrokerPresenceDemand({
            resource: preauthorized.authorization.resource, pinnedMachineId: preauthorized.authorization.pinnedMachineId,
        });
        initialPresence = await input.readCurrentPresence({
            initiatorAccountId: preauthorized.authorization.initiatorEndpoint.custodianAccountId,
            initiatorMachineId: parsed.data.initiatorMachineId,
            brokerAccountId: preauthorized.authorization.resource.custodianAccountId,
            brokerMachineIds,
        });
    } catch {
        return brokerUnavailable('presence_read_failed');
    }
    const preparedInput: TeamCredentialProviderBrokerPreparedInput & Readonly<{
        runnerPrincipal?: VerifiedEphemeralSessionRunnerPrincipal;
    }> = {
        ...input,
        initiatorPresence: initialPresence.initiatorPresence,
        brokerPresence: initialPresence.brokerPresence,
    };
    const initial = await inTx(tx => prepareTeamCredentialProviderBrokerOpenInTx(
        tx,
        preparedInput,
        parsed.data,
        preauthorized.executionRun,
        null,
        null,
    ));
    if (isFailure(initial)) return initial;

    let selectedPoolMachineId: string | null = initial.broker?.machineId ?? null;
    let poolEligibleMachineIds: ReadonlySet<string> | null = null;
    let preProjection = initial;
    if (initial.resource.brokerPoolId !== null && initial.broker === null) {
        if (!input.readPoolSourceEligibility || initial.poolSnapshot === null) return failure('resource_unavailable');
        const signal = input.signal ?? new AbortController().signal;
        const genericCandidateIds = initial.poolCandidateMachineIds;
        if (genericCandidateIds.length === 0) return brokerUnavailable('no_pool_candidates');
        const eligibility = await input.readPoolSourceEligibility({
            custodianAccountId: initial.resource.custodianAccountId,
            machineIds: genericCandidateIds,
            teamId: initial.resource.teamId,
            resourceId: initial.request.resourceId,
            resourceRevision: initial.resource.revision,
            source: initial.source,
            application: initial.request.application,
            modelId: initial.request.modelId,
            sourceRevision: initial.request.sourceRevision,
            signal,
        }).catch(() => null);
        if (signal.aborted) return brokerUnavailable('eligibility_aborted');
        if (!eligibility) return brokerUnavailable('eligibility_read_failed');
        poolEligibleMachineIds = eligibility.eligibleMachineIds;
        const selected = await inTx(tx => prepareTeamCredentialProviderBrokerOpenInTx(
            tx,
            preparedInput,
            parsed.data,
            preauthorized.executionRun,
            null,
            poolEligibleMachineIds,
        ));
        if (isFailure(selected)) return selected;
        const changed = preparationChangeFailure(initial, selected);
        if (changed) return changed;
        selectedPoolMachineId = selected.broker?.machineId ?? null;
        if (selectedPoolMachineId === null) return brokerUnavailable('broker_selection_missing');
        preProjection = selected;
    }

    if (selectedPoolMachineId === null) return brokerUnavailable('broker_selection_missing');
    let projectionResponse: unknown;
    try {
        projectionResponse = await input.readProviderProjection({
            custodianAccountId: preProjection.resource.custodianAccountId,
            brokerMachineId: selectedPoolMachineId,
            source: preProjection.source,
            agentTargetKey: preProjection.request.application.agentTargetKey,
            application: preProjection.request.application,
        });
    } catch {
        return failure('resource_unavailable');
    }

    const finalRun = await resolveOpenExecutionRunCurrentness(input, parsed.data);
    if (finalRun !== null && !finalRun.ok) return finalRun;
    let currentPresence: Awaited<ReturnType<BrokerOpenPresenceReader>>;
    try {
        currentPresence = await input.readCurrentPresence({
            initiatorAccountId: preProjection.initiatorEndpoint.custodianAccountId,
            initiatorMachineId: parsed.data.initiatorMachineId,
            brokerAccountId: preProjection.resource.custodianAccountId,
            brokerMachineIds: selectedPoolMachineId ? [selectedPoolMachineId] : [],
        });
    } catch {
        return brokerUnavailable('presence_read_failed');
    }
    return await inTx(async tx => {
        const current = await prepareTeamCredentialProviderBrokerOpenInTx(
            tx,
            {
                ...input,
                initiatorPresence: currentPresence.initiatorPresence,
                brokerPresence: currentPresence.brokerPresence,
            },
            parsed.data,
            finalRun,
            selectedPoolMachineId,
            poolEligibleMachineIds,
            preProjection.initiatorEndpoint.custodianAccountId,
        );
        if (isFailure(current)) return current;
        const changed = preparationChangeFailure(preProjection, current);
        if (changed) return changed;
        // Full serializing Account admission precedes deciding reads; after a
        // lock wait ReadCommitted observes the winning withdrawal before signing.
        return finalizePreparedBrokerOpen(input, current, projectionResponse);
    }, { isolationLevel: 'ReadCommitted' });
}

/** Ordinary Session/Run opens select Pool placement at this Home boundary. */
export async function openTeamCredentialProviderBroker(
    input: TeamCredentialProviderBrokerOpenInput,
): Promise<TeamCredentialProviderBrokerOpenResult> {
    const result = await openTeamCredentialProviderBrokerWithPrincipal(input);
    return result.ok ? result : reportBrokerAdmissionFailure('open', result);
}

/** Restricted Runner opens consume their exact pre-review frozen selection. */
export async function openRunnerTeamCredentialProviderBroker(
    input: TeamCredentialProviderBrokerOpenInput & Readonly<{
        principal: VerifiedEphemeralSessionRunnerPrincipal;
    }>,
): Promise<TeamCredentialProviderBrokerOpenResult> {
    const result = await openTeamCredentialProviderBrokerWithPrincipal({
        ...input,
        runnerPrincipal: input.principal,
    });
    return result.ok ? result : reportBrokerAdmissionFailure('open', result);
}

/**
 * The one Home-side per-request admission owner. The broker job was admitted
 * once, by its signed open. Session turn publication supplies attribution,
 * not another admission prerequisite. Each model request therefore
 * reads only whether that admitted job is still active, then writes the
 * immutable request-count event (usage accounting and limits stay per request).
 */
type TeamCredentialProviderBrokerRequestAdmissionInput = Readonly<{
    authenticatedBrokerAccountId: string;
    request: ProviderBrokerRequestAdmissionV1;
    observedAt: Date;
    verifyAuthority: (authority: SignedProviderBrokerRouteGrantV1) => boolean;
    resolveExecutionRunCurrentness?: TeamCredentialExecutionRunCurrentnessResolver;
}>;

export async function admitTeamCredentialProviderBrokerRequest(
    input: TeamCredentialProviderBrokerRequestAdmissionInput,
): Promise<TeamCredentialProviderBrokerRequestAdmissionResult> {
    const result = await admitTeamCredentialProviderBrokerRequestUnreported(input);
    return result.ok ? result : reportBrokerAdmissionFailure('request', result);
}

async function admitTeamCredentialProviderBrokerRequestUnreported(
    input: TeamCredentialProviderBrokerRequestAdmissionInput,
): Promise<TeamCredentialProviderBrokerRequestAdmissionResult> {
    const parsed = ProviderBrokerRequestAdmissionV1Schema.safeParse(input.request);
    if (!parsed.success || !input.verifyAuthority(parsed.data.authority)) return failure('invalid_request');
    let executionRun: CurrentExecutionRun | null = null;
    const grant = parsed.data.authority.payload;
    if (grant.consumer.kind === 'execution_run') {
        if (!input.resolveExecutionRunCurrentness) return failure('execution_run_authority_unavailable');
        const current = await input.resolveExecutionRunCurrentness({
            executionRunId: grant.consumer.executionRunId,
            requestingAccountId: grant.initiator.accountId,
            workerMachineId: grant.initiator.machineId,
            expectedOccurrenceId: grant.executionRunOccurrenceId ?? null,
        });
        if (!current.ok) return current;
        executionRun = current;
    }
    return await inTx(tx => admitTeamCredentialProviderBrokerRequestInTx(
        tx,
        input,
        parsed.data,
        executionRun,
    ), { isolationLevel: "ReadCommitted" /* Recorded period spend is read from the accounting counter; in-flight overshoot is accepted. */ });
}

type ActiveBrokerJob = Readonly<{
    ok: true;
    sessionId: string | null;
    storageAccountId: string;
    turnId: string | null;
    source: TeamCredentialSourceBindingV1;
}>;

/**
 * "This admitted broker job is still active" (owner rulings 10-29/10-30).
 * Requester permission is decided once at open. Each request checks only the
 * signed job fingerprint against the current resource revision and placement,
 * the signed credential, and the Session/turn or Run occurrence. Withdrawal
 * writers advance the resource revision in their own transaction. The broker
 * source owner pins the member it forwards under, preserving usage attribution.
 */
async function readActiveBrokerJobInTx(
    tx: Tx,
    input: Readonly<{
        grant: SignedProviderBrokerRouteGrantV1['payload'];
        expectedResourceRevision: number;
        generation: boolean;
        executionRun: CurrentExecutionRun | null;
    }>,
): Promise<ActiveBrokerJob | Failure> {
    const { grant } = input;
    let sessionId: string | null;
    if (grant.consumer.kind === 'execution_run') {
        // The Run owner's own currentness, resolved before this transaction.
        const run = input.executionRun;
        if (run === null) return failure('execution_run_authority_unavailable');
        if (!grant.executionRunOccurrenceId || run.occurrenceId !== grant.executionRunOccurrenceId) {
            return closedFailure('operation_not_current', 'execution_run_occurrence_mismatch');
        }
        // Generation needs an active turn; admitted non-generation work
        // (token counting) is still accounted against the Run below.
        if (input.generation && run.runtimeState !== 'active_turn') {
            return closedFailure('operation_not_current', 'execution_run_turn_not_active');
        }
        const consumer = brokerOperationConsumer(grant.consumer, run, grant.resourceId);
        if ('ok' in consumer) return consumer;
        sessionId = run.parentSessionId;
    } else {
        sessionId = grant.consumer.sessionId;
    }
    const row = await readActiveBrokerJobRowsInTx(tx, {
        accountId: grant.initiator.accountId, resourceId: grant.resourceId, sessionId,
    });
    if (!auth.isSignedCredentialAccountCurrent(row && { tokenEpoch: Number(row.tokenEpoch), status: row.status }, grant.initiatorTokenEpoch)) {
        return failure('operation_not_current');
    }
    const resource = row?.resourceId ? {
        id: row.resourceId, teamId: row.teamId, custodianAccountId: row.custodianAccountId,
        enabled: Number(row.enabled) === 1, revision: Number(row.revision),
        sourceBindingJson: row.sourceBindingJson, brokerMachineId: row.brokerMachineId, brokerPoolId: row.brokerPoolId,
    } : null;
    if (!resource) return bindingFailure('resource_unavailable', 'resource_missing');
    if (!resource.enabled) return bindingFailure('resource_forbidden', 'disabled');
    if (resource.teamId !== grant.teamId || resource.custodianAccountId !== grant.target.custodianAccountId) {
        return failure('resource_unavailable');
    }
    // A resource that names no broker any more (its Machine or Pool was
    // removed) has no route for this job, whatever revision is presented.
    const placementFingerprint = resolveTeamCredentialBrokerPlacementFingerprint(resource);
    if (placementFingerprint === null) return bindingFailure('broker_unavailable', 'broker_unavailable');
    if (resolveTeamCredentialBrokerJobFingerprint(placementFingerprint, resource.revision)
        !== grant.brokerPlacementFingerprint) return failure('operation_not_current');
    // The broker evaluates this request's model against the revision it sends;
    // Home checks that the policy read still names this current resource.
    if (resource.revision !== input.expectedResourceRevision) return failure('resource_changed');
    const sourceBinding = readTeamCredentialSourceBinding(resource.sourceBindingJson);
    if (!sourceBinding.success) return bindingFailure('resource_unavailable', 'resource_corrupt');
    const session = row?.sessionAccountId ? {
        accountId: row.sessionAccountId, active: Number(row.sessionActive) === 1,
        archivedAt: Number(row.sessionArchived) === 1 ? true : null,
        latestTurnId: row.latestTurnId, latestTurnStatus: row.latestTurnStatus,
    } : null;
    if (sessionId !== null && (!session || session.accountId !== grant.initiator.accountId
        || !session.active || session.archivedAt !== null)) {
        return closedFailure('session_not_active', 'session_missing_or_inactive');
    }
    let turnId: string | null = null;
    if (grant.consumer.kind === 'execution_run') {
        turnId = input.generation ? input.executionRun?.activeTurnId ?? null : null;
    } else if (input.generation && session?.latestTurnId && session.latestTurnStatus === 'in_progress') {
        // The signed open already admitted this job. A model request can reach
        // Home before its first (or next) turn-begin publication. An available
        // in-progress witness supplies attribution; publication is not job activity.
        const turn = row?.turnId === session.latestTurnId ? row : null;
        if (!turn) return closedFailure('operation_not_current', 'session_turn_not_in_progress');
        if (turn.usageActorAccountId !== grant.initiator.accountId
            || turn.teamCredentialResourceId !== grant.resourceId
            || turn.credentialDeliveryMode !== 'brokered') return closedFailure('operation_not_current', 'session_turn_binding_mismatch');
        turnId = session.latestTurnId;
    }
    return {
        ok: true,
        sessionId,
        storageAccountId: session?.accountId ?? grant.initiator.accountId,
        turnId,
        source: sourceBinding.data,
    };
}

async function admitTeamCredentialProviderBrokerRequestInTx(
    tx: Tx,
    input: TeamCredentialProviderBrokerRequestAdmissionInput,
    request: ProviderBrokerRequestAdmissionV1,
    executionRun: CurrentExecutionRun | null,
): Promise<TeamCredentialProviderBrokerRequestAdmissionResult> {
    const { authority, expectedResourceRevision, requestFacts } = request;
    const grant = authority.payload;
    if (grant.target.custodianAccountId !== input.authenticatedBrokerAccountId) {
        return closedFailure('resource_forbidden', 'broker_custodian_mismatch');
    }
    const routeMatchesApplication = (
        requestFacts.routeKind === 'openai_responses' && grant.application.protocol === 'openai-responses'
    ) || (
        requestFacts.routeKind === 'openai_chat_completions' && grant.application.protocol === 'openai-chat'
    ) || (
        requestFacts.routeKind === 'anthropic_messages' && grant.application.protocol === 'anthropic'
    );
    // The model is a current request fact, not signed identity: one open serves
    // every model the resource allows now. The broker's one request-policy
    // owner evaluated it against the policy at `expectedResourceRevision`,
    // which the active-job lookup requires to be the current revision
    // (`04-private-iroh-broker-transport.md:270`; `PLAN.md:438` "Home does not
    // become another model/effort/cap evaluator").
    if (!routeMatchesApplication) return failure('invalid_request');
    const job = await readActiveBrokerJobInTx(tx, {
        grant,
        expectedResourceRevision,
        generation: requestFacts.generation,
        executionRun,
    });
    if (!job.ok) return job;
    const executionRunId = grant.consumer.kind === 'execution_run' ? grant.consumer.executionRunId : null;
    const usage = await admitTeamCredentialUsageInTx(tx, {
        storageAccountId: job.storageAccountId,
        sessionId: job.sessionId,
        turnId: job.turnId,
        observedAt: input.observedAt,
        requestId: request.requestId,
        modelId: requestFacts.modelId,
        usageRoute: executionRunId === null
            ? 'agent_runtime_session_turn'
            : job.sessionId === null
                ? 'agent_runtime_detached_execution_run'
                : 'agent_runtime_attached_execution_run',
        authority: {
            kind: 'teamCredentialAdmission',
            requestingAccountId: grant.initiator.accountId,
            resourceId: grant.resourceId,
            externalApiKeyId: null,
            sourceCredentialId: request.sourceMemberKey,
            workerMachineId: grant.initiator.machineId,
            brokerMachineId: grant.target.machineId,
            deliveryMode: 'brokered',
            executionRunId,
        },
    });
    if (!usage.ok) return failure(
        usage.reasonCode,
        usage.reasonCode === 'team_credential_usage_limit' ? usage.usageLimit : undefined,
    );
    if (!usage.created) return failure('duplicate_request');
    return {
        ok: true,
        resourceId: grant.resourceId,
        brokerMachineId: grant.target.machineId,
        source: job.source,
        operation: grant.consumer.kind === 'session'
            ? { kind: 'session', sessionId: grant.consumer.sessionId }
            : { kind: 'execution_run', executionRunId: grant.consumer.executionRunId },
        usageEventId: usage.usageEventId,
    };
}
