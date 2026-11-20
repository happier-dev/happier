import {
    ConnectedServiceAuthGroupSwitchLeaseExpiredError,
    InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
    defaultServiceIdentityKey,
    switchKey,
    type ConnectedServiceAuthGroupAccountScope,
    type LeaseAcquireResult,
    type LeaseCompletion,
    type LeaseResultCompletion,
} from './lease';
export { ConnectedServiceAuthGroupSwitchLeaseExpiredError, InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry } from './lease';
export type { ConnectedServiceAuthGroupAccountScope } from './lease';

import {
    hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason,
    isConnectedServiceAuthGroupProviderLimitSelected,
    selectConnectedServiceAuthGroupCandidate,
    resolveConnectedServiceAuthGroupQuotaResetCandidates,
    type ConnectedServiceAuthGroupCandidateDecisionTrace,
    type ConnectedServiceAuthGroupCandidateSelection,
    type ConnectedServiceAuthGroupMember,
    type ConnectedServiceAuthGroupMemberRuntimeState,
    type ConnectedServiceAuthGroupPolicyV2,
    type ConnectedServiceAuthGroupQuotaSnapshot,
} from '../selection/selectConnectedServiceAuthGroupCandidate';
import { resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds } from '../selection/resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds';
import { readConnectedServiceAuthGenerationApplyFailure } from '../../runtimeAuth/connectedServiceAuthGenerationApplyFailure';
import type { AcceptedConnectedServiceAccountVerificationByServiceId } from '../../accountTransitions/acceptedConnectedServiceAccountVerification';
import { readConnectedServiceApplicationTargetCredentialRevision, readConnectedServiceProviderAdoptedGenerationTarget } from '../../accountTransitions/acceptedConnectedServiceAccountVerification';
import { buildConnectedServiceAuthGroupCommittedGenerationFact, buildConnectedServiceAuthGroupTargetEpochIdentity,
    readConnectedServiceAccountApplicationCredentialError,
    type ConnectedServiceCommittedGenerationApplyResult, type ConnectedServiceMaterializedTargetsByServiceId,
} from '../../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import { readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';
import { QualifiedConnectedAccountServiceRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { evaluatePredictiveSoftSwitchSessionApplyPolicy } from './predictiveSoftSwitchPolicy';
import { resolveConnectedServiceAuthGroupQuotaProbeWait, type ConnectedServiceAuthGroupQuotaProbeResult } from '../quotas/preTurnQuotaProbe';
import type {
    ConnectedServiceCredentialRevisionV1,
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1,
    ConnectedServiceAuthGroupStateV1,
} from '@happier-dev/protocol';
import { logger } from '@/ui/logger';
import { observeCurrentConnectedServiceMaterializationPhase } from '../../materialize/materializationPhase';
import type { AutomaticQuotaResetContext, ConnectedServiceQuotaRecoveryCreditConsumeResult } from '../../quotas/ConnectedServiceQuotasCoordinator';
import type { ConnectedServicePoolSelectionGetRequestV1 } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { switchAfterCredentialHealth, type CredentialHealthSwitchInput } from './credentialHealthSwitch';

const WAITABLE_CLASSIFIED_FAILURE_REASONS: ReadonlySet<string> = new Set([
    'usage_limit',
    'rate_limit',
    'temporary_throttle',
]);

function isRejectedStartModelEntitlementFailure(input: Readonly<{
    rejectedStart?: boolean;
    reason: string;
    limitCategory?: string | null;
    quotaScope?: string | null;
    providerLimitId?: string | null;
}>): boolean {
    return input.rejectedStart === true
        && input.reason === 'plan'
        && input.limitCategory === 'plan_invalid'
        && input.quotaScope === 'model'
        && Boolean(input.providerLimitId?.trim());
}

function shouldWaitForClassifiedFailure(input: Readonly<{
    reason: string;
    recoveryMode: ConnectedServiceAuthGroupPolicyV2['recoveryMode'];
}>): boolean {
    return WAITABLE_CLASSIFIED_FAILURE_REASONS.has(input.reason)
        && (input.recoveryMode === 'wait_until_reset' || input.recoveryMode === 'switch_or_wait');
}

type ConnectedServiceAuthGroupQuotaRecoveryProof = Extract<
    ConnectedServiceAuthGroupSwitchResult,
    { status: 'observed_generation' }
>['quotaRecovery'];

function resolveCurrentProfileQuotaRecoveryProof<TServiceIdentity>(input: Readonly<{
    selected: ReturnType<typeof selectConnectedServiceAuthGroupCandidate>;
    loaded: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>;
    receipt?: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1;
}>): ConnectedServiceAuthGroupQuotaRecoveryProof {
    const chosen = input.selected.selected;
    if (!chosen || chosen.profileId !== input.loaded.activeProfileId) return undefined;
    const evidence = input.selected.decisionTrace.candidates.find(
        (entry) => entry.profileId === chosen.profileId,
    )?.quotaEvidence;
    const snapshot = input.loaded.memberStatesByProfileId.get(chosen.profileId)?.quotaSnapshot;
    if (
        !snapshot
        || evidence?.status !== 'fresh'
        || chosen.leastLimitedScore === null
        || chosen.leastLimitedScore <= 0
        || input.receipt?.status === 'unknown_after_timeout'
    ) return undefined;
    return {
        ...(input.receipt ? { receipt: input.receipt } : {}),
        quotaSnapshot: {
            capturedAtMs: snapshot.capturedAtMs,
            effectiveRemainingPercent: chosen.leastLimitedScore,
        },
    };
}

export type ConnectedServiceAuthGroupSwitchState<
    TServiceIdentity = string,
> = Readonly<{
    serviceId: TServiceIdentity;
    groupId: string;
    activeProfileId: string | null;
    activeSince?: ConnectedServiceAuthGroupStateV1['activeSince'];
    lastSwitchReason?: string | null;
    lastSwitchAt?: number | null;
    incarnation?: string;
    generation: number;
    runtimeStateRevision?: number;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    configurationRevision?: string | null;
    policy: ConnectedServiceAuthGroupPolicyV2;
    members: ReadonlyArray<ConnectedServiceAuthGroupMember>;
    memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
    requiredModelIds?: ReadonlyArray<string>;
    quotaProbeDeferredUntilMsByProfileId?: ReadonlyMap<string, number>;
}>;

export type ConnectedServiceAuthGroupMemberRuntimeStateOverride = Readonly<{
    profileId: string;
    state: ConnectedServiceAuthGroupMemberRuntimeState;
}>;



export type ConnectedServiceAuthGroupGenerationApplyInput<
    TServiceIdentity = string,
> = LeaseCompletion<TServiceIdentity> & Readonly<{
    sessionId?: string;
    reason?: string;
}>;



type ConnectedServiceAccountSwitchMode = 'hot_apply' | 'restart_resume' | 'spawn_next_turn';

type ConnectedServiceGenerationApplyEvidence = Readonly<{
    providerApplication?: string;
    verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
    materializedTargetByServiceId?: ConnectedServiceMaterializedTargetsByServiceId;
}>;

function generationApplyEvidenceFields(input: ConnectedServiceGenerationApplyEvidence & Readonly<{
    mode?: ConnectedServiceAccountSwitchMode;
}>): ConnectedServiceGenerationApplyEvidence & Readonly<{ mode?: ConnectedServiceAccountSwitchMode }> {
    return {
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.providerApplication ? { providerApplication: input.providerApplication } : {}),
        ...(input.verificationByServiceId ? { verificationByServiceId: input.verificationByServiceId } : {}),
        ...(input.materializedTargetByServiceId ? { materializedTargetByServiceId: input.materializedTargetByServiceId } : {}),
    };
}

type ConnectedServiceAuthGroupSwitchDecisionDiagnostics = Readonly<{
    decisionTrace: ConnectedServiceAuthGroupCandidateDecisionTrace;
}>;









function normalizeProfileId(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function canRetryCurrentProfileForObservedProfile(input: Readonly<{
    reason: string;
    allowCurrentProfileRetry?: boolean;
    observedProfileId?: string | null;
    activeProfileId: string | null | undefined;
}>): boolean {
    if (!canRetryObservedProfileDuringPreTurnSelection(input)) return false;
    const observedProfileId = normalizeProfileId(input.observedProfileId);
    const activeProfileId = normalizeProfileId(input.activeProfileId);
    return !observedProfileId || !activeProfileId || observedProfileId === activeProfileId;
}

function canRetryObservedProfileDuringPreTurnSelection(input: Readonly<{
    reason: string;
    allowCurrentProfileRetry?: boolean;
}>): boolean {
    return input.allowCurrentProfileRetry === true || input.reason === 'soft_threshold';
}

function isLeaseResultCompletion<TServiceIdentity>(
    value: LeaseCompletion<TServiceIdentity> | LeaseResultCompletion,
): value is LeaseResultCompletion {
    return 'kind' in value && value.kind === 'result';
}


type ConnectedServiceAuthGroupSwitchRequest<TServiceIdentity> = Readonly<{
    modelId?: string | null;
    sessionId?: string;
    serviceId: TServiceIdentity;
    groupId: string;
    reason: string;
    observedProfileId?: string | null;
    retryAtMs?: number | null;
    retryAfterMs?: number | null;
    resetsAtMs?: number | null;
    limitCategory?: string | null;
    quotaScope?: string | null;
    providerLimitId?: string | null;
    action?: unknown | null;
    planType?: string | null;
    allowCurrentProfileRetry?: boolean;
    /** Caller has proven the model was rejected before any accepted turn/work. */
    rejectedStart?: boolean;
    expectedFailureSource?: ConnectedServiceAuthGroupExpectedFailureSource;
}>;

export type ConnectedServiceAuthGroupSwitchResult =
    | (Readonly<{
        status: 'switched';
        activeProfileId: string;
        generation: number;
        credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
        mode?: ConnectedServiceAccountSwitchMode;
        diagnostics?: unknown;
    }> & ConnectedServiceGenerationApplyEvidence)
    | (Readonly<{
        status: 'observed_generation';
        activeProfileId: string | null;
        generation: number;
        credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
        /** Producer attaches only after canonical selection proves fresh usable quota on this profile. */
        quotaRecovery?: Readonly<{
            receipt?: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1;
            quotaSnapshot: Pick<ConnectedServiceAuthGroupQuotaSnapshot, 'capturedAtMs' | 'effectiveRemainingPercent'>;
        }>;
        mode?: ConnectedServiceAccountSwitchMode;
        diagnostics?: unknown;
    }> & ConnectedServiceGenerationApplyEvidence)
    | Readonly<{
        status: 'superseded_after_apply';
        activeProfileId: string | null;
        generation: number;
        credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
        adoptedProfileId: string | null;
        adoptedGeneration: number;
        adoptedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null;
        reconciliationDisposition: 'superseded_after_apply';
        mode?: ConnectedServiceAccountSwitchMode;
        diagnostics?: unknown;
    }>
    | Readonly<{
        status: 'generation_apply_failed';
        activeProfileId: string | null;
        generation: number;
        errorCode: string;
        diagnostics?: unknown;
    }>
    | Readonly<{
        status: 'predictive_apply_unavailable';
        activeProfileId: string | null;
        generation: number;
        errorCode: string;
        diagnostics?: unknown;
    }>
    | Readonly<{
        status: 'quota_proof_unavailable';
        activeProfileId: string | null;
        generation: number;
        retryAtMs?: number;
        diagnostics?: ConnectedServiceAuthGroupSwitchDecisionDiagnostics;
    }>
    | Readonly<{
        status: 'no_eligible_member';
        /** Present for current-member observation; absent for full-pool selection. */
        activeProfileId?: string | null;
        generation: number;
        groupExhausted: true;
        retryAtMs: number | null;
        excluded: ConnectedServiceAuthGroupCandidateSelection['excluded'];
        diagnostics?: ConnectedServiceAuthGroupSwitchDecisionDiagnostics;
    }>
    | Readonly<{ status: 'manual_strategy'; generation: number }>
    | Readonly<{ status: 'auto_switch_disabled'; generation: number }>
    | Readonly<{ status: 'switch_reason_disabled'; generation: number }>
    | Readonly<{ status: 'stale_context'; generation: number }>;

export type ConnectedServiceAuthGroupExpectedFailureSource = Readonly<{
    profileId: string;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
    groupGeneration: number;
    /** Health-triggered rotation expires if the persisted credential recovers. */
    credentialHealthStatus?: 'needs_reauth';
    /** Supplements the exact account source with its retained runner/lease currentness. */
    isCurrent?: () => boolean;
}>;

export type ConnectedServiceAuthGroupGenerationApplyFailure = Readonly<{
    ok: false;
    errorCode: string;
    serviceId?: unknown;
    diagnostics?: unknown;
}>;

export type ConnectedServiceAuthGroupGenerationApplyResult =
    | (Readonly<{ ok: true; mode?: ConnectedServiceAccountSwitchMode }> & ConnectedServiceGenerationApplyEvidence)
    | ConnectedServiceAuthGroupGenerationApplyFailure;

function isGenerationApplySuccess(
    result: ConnectedServiceAuthGroupGenerationApplyResult | undefined,
): result is Readonly<{ ok: true; mode?: ConnectedServiceAccountSwitchMode }> {
    return Boolean(result)
        && typeof result === 'object'
        && !Array.isArray(result)
        && (result as { ok?: unknown }).ok === true;
}

function isGenerationApplyFailure(
    result: ConnectedServiceAuthGroupGenerationApplyResult | undefined,
): result is ConnectedServiceAuthGroupGenerationApplyFailure {
    return Boolean(result)
        && typeof result === 'object'
        && !Array.isArray(result)
        && (result as { ok?: unknown }).ok === false
        && typeof (result as { errorCode?: unknown }).errorCode === 'string';
}

function resolveGenerationApplyFailure(
    result: ConnectedServiceAuthGroupGenerationApplyResult | undefined,
    input: LeaseCompletion<unknown>,
): ConnectedServiceAuthGroupGenerationApplyFailure | null {
    if (isGenerationApplySuccess(result)) return null;
    if (isGenerationApplyFailure(result)) return result;
    return {
        ok: false,
        errorCode: 'generation_apply_not_confirmed',
        serviceId: input.serviceId,
    };
}

function buildGenerationApplyFailedResult(input: Readonly<{
    activeProfileId: string | null;
    generation: number;
    failure: ConnectedServiceAuthGroupGenerationApplyFailure;
    decisionTrace?: ConnectedServiceAuthGroupCandidateDecisionTrace;
}>): Extract<ConnectedServiceAuthGroupSwitchResult, Readonly<{ status: 'generation_apply_failed' }>> {
    const baseDiagnostics = input.failure.diagnostics !== undefined
        ? input.failure.diagnostics
        : input.failure.serviceId
            ? { serviceId: input.failure.serviceId }
            : undefined;
    const diagnostics = input.decisionTrace === undefined
        ? baseDiagnostics
        : mergeSwitchDecisionDiagnostics({
            diagnostics: baseDiagnostics,
            decisionTrace: input.decisionTrace,
        });
    return {
        status: 'generation_apply_failed',
        activeProfileId: input.activeProfileId,
        generation: input.generation,
        errorCode: input.failure.errorCode,
        ...(diagnostics === undefined ? {} : { diagnostics }),
    };
}

function isPredictiveSessionApplyReason(reason: string | undefined): boolean {
    return reason === 'soft_threshold' || reason === 'same_provider_account_exhausted';
}

function isTransientPredictiveApplyUnavailable(input: Readonly<{
    reason?: string;
    failure: ConnectedServiceAuthGroupGenerationApplyFailure;
}>): boolean {
    return isPredictiveSessionApplyReason(input.reason) && input.failure.errorCode === 'hot_apply_failed';
}

function buildPredictiveApplyUnavailableResult(input: Readonly<{
    activeProfileId: string | null;
    generation: number;
    failure: ConnectedServiceAuthGroupGenerationApplyFailure;
    decisionTrace?: ConnectedServiceAuthGroupCandidateDecisionTrace;
}>): Extract<ConnectedServiceAuthGroupSwitchResult, Readonly<{ status: 'predictive_apply_unavailable' }>> {
    const baseDiagnostics = input.failure.diagnostics !== undefined
        ? input.failure.diagnostics
        : input.failure.serviceId
            ? { serviceId: input.failure.serviceId }
            : undefined;
    const diagnostics = input.decisionTrace === undefined
        ? baseDiagnostics
        : mergeSwitchDecisionDiagnostics({
            diagnostics: baseDiagnostics,
            decisionTrace: input.decisionTrace,
        });
    return {
        status: 'predictive_apply_unavailable',
        activeProfileId: input.activeProfileId,
        generation: input.generation,
        errorCode: input.failure.errorCode,
        ...(diagnostics === undefined ? {} : { diagnostics }),
    };
}

function buildGenerationApplyResult(input: Readonly<{
    activeProfileId: string | null;
    generation: number;
    reason?: string;
    failure: ConnectedServiceAuthGroupGenerationApplyFailure;
    decisionTrace?: ConnectedServiceAuthGroupCandidateDecisionTrace;
}>): Extract<
    ConnectedServiceAuthGroupSwitchResult,
    Readonly<{ status: 'generation_apply_failed' | 'predictive_apply_unavailable' }>
> {
    if (isTransientPredictiveApplyUnavailable({ reason: input.reason, failure: input.failure })) {
        return buildPredictiveApplyUnavailableResult(input);
    }
    return buildGenerationApplyFailedResult(input);
}

export type ConnectedServiceAuthGroupSwitchEvent<
    TServiceIdentity = string,
> = Readonly<{
    type: 'connected_service_auth_group_switch';
    serviceId: TServiceIdentity;
    groupId: string;
    groupLabel?: string;
    fromProfileId: string | null;
    toProfileId: string | null;
    reason: string;
    fromGeneration: number;
    toGeneration: number;
    resultStatus: ConnectedServiceAuthGroupSwitchResult['status'];
    success: boolean;
    latencyMs: number;
    retryAfterMs?: number | null;
    limitCategory?: string | null;
    quotaScope?: string | null;
    providerLimitId?: string | null;
    action?: unknown | null;
    mode?: ConnectedServiceAccountSwitchMode;
    decisionTrace?: ConnectedServiceAuthGroupCandidateDecisionTrace;
}>;

function isReasonEnabled(policy: ConnectedServiceAuthGroupPolicyV2, reason: string): boolean {
    switch (reason) {
        case 'usage_limit':
        case 'rate_limit':
        case 'capacity':
        case 'soft_threshold':
        case 'same_provider_account_exhausted':
            return policy.switchOn.usageLimit;
        case 'auth_expired':
        case 'permission_denied':
        case 'plan':
        case 'account_disabled':
            return policy.switchOn.authExpired;
        case 'account_changed':
            return policy.switchOn.accountChanged;
        case 'refresh_failed':
            return policy.switchOn.refreshFailure || policy.switchOn.authExpired;
        default:
            return false;
    }
}

function resolveEarliestRetryAtMs(excluded: ReadonlyArray<Readonly<{ retryAtMs?: number | null }>>): number | null {
    let earliest: number | null = null;
    for (const item of excluded) {
        if (typeof item.retryAtMs !== 'number' || !Number.isFinite(item.retryAtMs)) continue;
        earliest = earliest === null ? item.retryAtMs : Math.min(earliest, item.retryAtMs);
    }
    return earliest;
}

function buildSwitchDecisionDiagnostics(input: Readonly<{
    decisionTrace: ConnectedServiceAuthGroupCandidateDecisionTrace;
}>): ConnectedServiceAuthGroupSwitchDecisionDiagnostics {
    return { decisionTrace: input.decisionTrace };
}

function isReadonlyRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSwitchDecisionTrace(value: unknown): value is ConnectedServiceAuthGroupCandidateDecisionTrace {
    if (!isReadonlyRecord(value)) return false;
    const reason = value.reason;
    return (
        (reason === 'selected' || reason === 'manual_strategy' || reason === 'no_eligible_members')
        && Array.isArray(value.candidates)
    );
}

function mergeSwitchDecisionDiagnostics(input: Readonly<{
    diagnostics?: unknown;
    decisionTrace: ConnectedServiceAuthGroupCandidateDecisionTrace;
}>): unknown {
    if (input.diagnostics === undefined) {
        return buildSwitchDecisionDiagnostics({ decisionTrace: input.decisionTrace });
    }
    if (isReadonlyRecord(input.diagnostics)) {
        return {
            ...input.diagnostics,
            decisionTrace: input.decisionTrace,
        };
    }
    return {
        applyDiagnostics: input.diagnostics,
        decisionTrace: input.decisionTrace,
    };
}

function readSwitchResultDecisionTrace(
    result: ConnectedServiceAuthGroupSwitchResult,
): ConnectedServiceAuthGroupCandidateDecisionTrace | undefined {
    if (!('diagnostics' in result)) return undefined;
    if (!isReadonlyRecord(result.diagnostics)) return undefined;
    const decisionTrace = result.diagnostics.decisionTrace;
    return isSwitchDecisionTrace(decisionTrace) ? decisionTrace : undefined;
}

function resolvePolicyRecoveryWaitRetryAtMs(input: Readonly<{
    retryAtMs?: number | null;
    resetsAtMs?: number | null;
}>): number | null {
    const values = [input.retryAtMs, input.resetsAtMs]
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return values.length > 0 ? Math.max(...values) : null;
}

function buildPolicyWaitUntilResetResult(input: Readonly<{
    loaded: ConnectedServiceAuthGroupSwitchState<unknown>;
    retryAtMs: number | null;
}>): Extract<ConnectedServiceAuthGroupSwitchResult, Readonly<{ status: 'no_eligible_member' }>> {
    const excluded = input.loaded.members.map((member) => ({
        profileId: member.profileId,
        reason: 'policy_wait_until_reset' as const,
        ...(input.retryAtMs === null ? {} : { retryAtMs: input.retryAtMs }),
    }));
    const candidates = input.loaded.members.map((member) => ({
        profileId: member.profileId,
        decision: 'excluded' as const,
        exclusionReason: 'policy_wait_until_reset' as const,
        ...(input.retryAtMs === null ? {} : { retryAtMs: input.retryAtMs }),
        quotaEvidence: { status: 'stale_or_missing' as const },
    }));
    return {
        status: 'no_eligible_member',
        generation: input.loaded.generation,
        groupExhausted: true,
        retryAtMs: input.retryAtMs,
        excluded,
        diagnostics: buildSwitchDecisionDiagnostics({
            decisionTrace: {
                activeProfileId: input.loaded.activeProfileId,
                reason: 'no_eligible_members',
                candidates,
            },
        }),
    };
}

function isProfileEligibleForObservedGeneration(input: Readonly<{
    modelId?: string | null;
    profileId: string;
    reason: string;
    nowMs: number;
    memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
    selected: ReturnType<typeof selectConnectedServiceAuthGroupCandidate>;
    policy: ConnectedServiceAuthGroupPolicyV2;
    providerLimitId?: string | null;
}>): boolean {
    return input.selected.selected?.profileId === input.profileId
        && hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
            modelId: input.modelId,
            reason: input.reason,
            policy: input.policy,
            providerLimitId: input.providerLimitId,
            profileId: input.profileId,
            nowMs: input.nowMs,
            memberStatesByProfileId: input.memberStatesByProfileId,
        });
}

function isProfileAdoptableForObservedDivergence(input: Readonly<{
    profileId: string;
    members: ReadonlyArray<ConnectedServiceAuthGroupMember>;
    selected: ReturnType<typeof selectConnectedServiceAuthGroupCandidate>;
}>): boolean {
    return input.members.some((member) => member.profileId === input.profileId && member.enabled)
        && !input.selected.excluded.some((excluded) => excluded.profileId === input.profileId);
}

function applyMemberStateOverrides<TServiceIdentity>(input: Readonly<{
    loaded: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>;
    overrides?: ReadonlyArray<ConnectedServiceAuthGroupMemberRuntimeStateOverride>;
}>): ConnectedServiceAuthGroupSwitchState<TServiceIdentity> {
    if (!input.overrides || input.overrides.length === 0) return input.loaded;
    const memberStatesByProfileId = new Map(input.loaded.memberStatesByProfileId);
    for (const override of input.overrides) {
        const profileId = override.profileId.trim();
        if (!profileId) continue;
        memberStatesByProfileId.set(profileId, {
            ...(memberStatesByProfileId.get(profileId) ?? {}),
            ...override.state,
        });
    }
    return {
        ...input.loaded,
        memberStatesByProfileId,
    };
}

type ObservedGenerationApplyResult = Extract<
    ConnectedServiceAuthGroupSwitchResult,
    Readonly<{ status: 'observed_generation' | 'superseded_after_apply' | 'generation_apply_failed' | 'predictive_apply_unavailable' }>
>;

type GenerationConflictResolution<TServiceIdentity = string> =
    | Readonly<{ kind: 'observed_generation'; result: ObservedGenerationApplyResult }>
    | Readonly<{
        kind: 'retry';
        state: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>;
        selectionActiveProfileId?: string | null;
    }>;

type RecordObservedFailureStateOutcome<TServiceIdentity = string> =
    | Readonly<{
        kind: 'recorded';
        state: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>;
    }>
    | Readonly<{ kind: 'observed_generation'; result: ObservedGenerationApplyResult }>;

export class ConnectedServiceAuthGroupSwitchCoordinator<
    TServiceIdentity = string,
> {

    constructor(private readonly deps: Readonly<{
        accountScope?: ConnectedServiceAuthGroupAccountScope;
        leases: InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry<
            TServiceIdentity
        >;
        nowMs: () => number;
        loadState(input: Readonly<{
            signal?: AbortSignal;
            serviceId: TServiceIdentity;
            groupId: string;
        }>): Promise<ConnectedServiceAuthGroupSwitchState<TServiceIdentity>>;
        commitSwitch(input: Readonly<{
            signal?: AbortSignal;
            serviceId: TServiceIdentity;
            groupId: string;
            fromProfileId: string | null;
            toProfileId: string;
            expectedGeneration: number;
            expectedIncarnation?: string;
            expectedRuntimeStateRevision?: number;
            expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
            expectedConfigurationRevision?: string | null;
            reason: string;
        }>): Promise<ConnectedServiceAuthGroupSwitchState<TServiceIdentity>>;
        prepareCandidateForSwitch?(input: Readonly<{
            signal?: AbortSignal;
            serviceId: TServiceIdentity;
            groupId: string;
            profileId: string;
            reason: string;
        }>): Promise<
            | Readonly<{ status: 'ready' }>
            | Readonly<{
                status: 'ineligible';
                memberState: ConnectedServiceAuthGroupMemberRuntimeState;
            }>
        >;
        preflightApplyGeneration?(
            input: ConnectedServiceAuthGroupGenerationApplyInput<
                TServiceIdentity
            >,
        ): Promise<ConnectedServiceAuthGroupGenerationApplyResult>;
        applyGeneration(
            input: ConnectedServiceAuthGroupGenerationApplyInput<
                TServiceIdentity
            >,
        ): Promise<ConnectedServiceAuthGroupGenerationApplyResult>;
        recordObservedFailureState?(input: Readonly<{
            serviceId: TServiceIdentity;
            groupId: string;
            loaded: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>;
            reason: string;
            observedProfileId?: string | null;
            retryAtMs?: number | null;
            retryAfterMs?: number | null;
            resetsAtMs?: number | null;
            limitCategory?: string | null;
            quotaScope?: string | null;
            providerLimitId?: string | null;
            planType?: string | null;
        }>): Promise<void>;
        probeQuotaSnapshotsForGroup?(input: Readonly<{
            signal?: AbortSignal;
            serviceId: TServiceIdentity;
            groupId: string;
            profileIds: ReadonlyArray<string>;
            reason: string;
        }>): Promise<ConnectedServiceAuthGroupQuotaProbeResult | void>;
        consumeAvailableRecoveryCreditForProfile?(input: Readonly<{
            serviceId: TServiceIdentity;
            groupId: string;
            profileId: string;
            automaticResetContext: AutomaticQuotaResetContext;
        }>): Promise<ConnectedServiceQuotaRecoveryCreditConsumeResult>;
        resolveGenerationConflict?(error: unknown): number | null;
        emitEvent?: (
            event: ConnectedServiceAuthGroupSwitchEvent<TServiceIdentity>,
        ) => void;
    }>) {
        this.deps = {
            ...deps,
            loadState: input => observeCurrentConnectedServiceMaterializationPhase('group_state_read', () => deps.loadState(input)),
        };
    }

    async switchAfterCredentialHealth(input: CredentialHealthSwitchInput<TServiceIdentity>): Promise<ConnectedServiceAuthGroupSwitchResult> {
        return await switchAfterCredentialHealth(input, { loadState: this.deps.loadState, coordinator: this });
    }

    /** Observes the canonical selection without probing, preparing, leasing or switching. */
    async readSelection(input: Readonly<{
        modelId?: string | null;
        serviceId: TServiceIdentity;
        groupId: string;
        providerLimitId?: string;
        hypothetical?: ConnectedServicePoolSelectionGetRequestV1['hypothetical'];
    }>): Promise<Readonly<{
        observedAtMs: number;
        selection: ReturnType<typeof selectConnectedServiceAuthGroupCandidate>;
        hypothetical?: Readonly<{ strategy: ConnectedServiceAuthGroupPolicyV2['strategy']; atMs: number }>;
        activeAccountRef: Readonly<{ service: TServiceIdentity; accountId: string }> | null;
        activeSince: NonNullable<ConnectedServiceAuthGroupStateV1['activeSince']> | null;
    }>> {
        const loaded = await this.deps.loadState(input);
        const observedAtMs = this.deps.nowMs();
        const atMs = input.hypothetical?.atMs ?? observedAtMs;
        const policy = input.hypothetical?.strategy === undefined ? loaded.policy
            : { ...loaded.policy, strategy: input.hypothetical.strategy };
        return {
            observedAtMs,
            ...(input.hypothetical ? { hypothetical: { strategy: policy.strategy, atMs } } : {}),
            activeAccountRef: loaded.activeProfileId ? { service: loaded.serviceId, accountId: loaded.activeProfileId } : null,
            // Only the persisted identity-bound clock describes the current account.
            // Observation time and legacy last-switch timestamps are not selection time.
            activeSince: loaded.activeProfileId && loaded.activeSince?.accountId === loaded.activeProfileId ? loaded.activeSince : null,
            selection: selectConnectedServiceAuthGroupCandidate({
                modelId: input.modelId,
                requiredModelIds: loaded.requiredModelIds,
                nowMs: atMs,
                activeProfileId: loaded.activeProfileId,
                policy,
                lastSwitchReason: loaded.lastSwitchReason,
                lastSwitchAt: loaded.lastSwitchAt,
                members: loaded.members,
                memberStatesByProfileId: loaded.memberStatesByProfileId,
                allowCurrentProfileRetry: true,
                providerLimitId: input.providerLimitId,
            }),
        };
    }

    private async selectPreparedCandidate(input: Readonly<{
        modelId?: string | null;
        signal?: AbortSignal;
        state: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>;
        activeProfileId: string | null | undefined;
        reason: string;
        allowCurrentProfileRetry?: boolean;
        unavailableProfileIds?: ReadonlySet<string>;
        requireFreshQuotaEvidence?: boolean;
        providerLimitId?: string | null;
    }>): Promise<ReturnType<typeof selectConnectedServiceAuthGroupCandidate>> {
        const memberStatesByProfileId = new Map(
            input.state.memberStatesByProfileId,
        );
        const unavailableProfileIds = new Set(input.unavailableProfileIds);
        for (;;) {
            input.signal?.throwIfAborted();
            const selected = selectConnectedServiceAuthGroupCandidate({
                modelId: input.modelId,
                reason: input.reason,
                requiredModelIds: input.state.requiredModelIds,
                quotaProbeDeferredUntilMsByProfileId: input.state.quotaProbeDeferredUntilMsByProfileId,
                nowMs: this.deps.nowMs(),
                activeProfileId: input.activeProfileId ?? null,
                policy: input.state.policy,
                lastSwitchReason: input.state.lastSwitchReason,
                lastSwitchAt: input.state.lastSwitchAt,
                members: input.state.members,
                memberStatesByProfileId,
                unavailableProfileIds,
                requireFreshQuotaEvidence: input.requireFreshQuotaEvidence,
                ...(input.providerLimitId === undefined
                    ? {}
                    : { providerLimitId: input.providerLimitId }),
                ...(input.allowCurrentProfileRetry === undefined
                    ? {}
                    : {
                        allowCurrentProfileRetry:
                            input.allowCurrentProfileRetry,
                    }),
            });
            if (!selected.selected || !this.deps.prepareCandidateForSwitch) {
                return selected;
            }
            const prepared = await this.deps.prepareCandidateForSwitch({
                signal: input.signal,
                serviceId: input.state.serviceId,
                groupId: input.state.groupId,
                profileId: selected.selected.profileId,
                reason: input.reason,
            });
            input.signal?.throwIfAborted();
            if (prepared.status === 'ready') return selected;
            // Retryable health remains globally usable, but a failed preflight must not be retried
            // indefinitely in this operation or disappear from the selector's exclusion evidence.
            unavailableProfileIds.add(selected.selected.profileId);
            memberStatesByProfileId.set(selected.selected.profileId, {
                ...(memberStatesByProfileId.get(
                    selected.selected.profileId,
                ) ?? {}),
                ...prepared.memberState,
            });
        }
    }

    private resolvePolicyResult(input: Readonly<{
        trigger: 'classified_failure' | 'pre_turn';
        request: Readonly<{
            modelId?: string | null;
            signal?: AbortSignal;
            serviceId: TServiceIdentity; groupId: string; sessionId?: string; reason: string;
            retryAtMs?: number | null; retryAfterMs?: number | null; resetsAtMs?: number | null;
            rejectedStart?: boolean; limitCategory?: string | null; quotaScope?: string | null; providerLimitId?: string | null;
        }>;
        loaded: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>;
    }>): ConnectedServiceAuthGroupSwitchResult | null {
        const { loaded, request } = input;
        const wait = input.trigger === 'classified_failure' && shouldWaitForClassifiedFailure({
            reason: request.reason, recoveryMode: loaded.policy.recoveryMode,
        });
        const waitResult = () => buildPolicyWaitUntilResetResult({
            loaded, retryAtMs: input.trigger === 'classified_failure' ? resolvePolicyRecoveryWaitRetryAtMs(request) : null,
        });
        if (loaded.policy.recoveryMode === 'off') return { status: 'auto_switch_disabled', generation: loaded.generation };
        if (!loaded.policy.autoSwitch) return wait ? waitResult() : { status: 'auto_switch_disabled', generation: loaded.generation };
        if (!isReasonEnabled(loaded.policy, request.reason)) return wait ? waitResult() : { status: 'switch_reason_disabled', generation: loaded.generation };
        if (loaded.policy.recoveryMode === 'wait_until_reset') return waitResult();
        return null;
    }

    private async selectWithQuotaRecovery(input: Readonly<{
        trigger: 'classified_failure' | 'pre_turn';
        request: Parameters<ConnectedServiceAuthGroupSwitchCoordinator<TServiceIdentity>['resolvePolicyResult']>[0]['request'] & Readonly<{
            expectedFailureSource?: ConnectedServiceAuthGroupExpectedFailureSource;
            providerLimitId?: string | null;
        }>;
        loaded: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>;
        activeProfileId: string | null;
        allowCurrentProfileRetry?: boolean;
        requireFreshQuotaEvidence?: boolean;
        overrides?: ReadonlyArray<ConnectedServiceAuthGroupMemberRuntimeStateOverride>;
    }>): Promise<Readonly<{
        loaded: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>;
        selected: ReturnType<typeof selectConnectedServiceAuthGroupCandidate>;
        quotaRecovery: Extract<ConnectedServiceAuthGroupSwitchResult, { status: 'observed_generation' }>['quotaRecovery'];
        policyResult: ConnectedServiceAuthGroupSwitchResult | null;
    }>> {
        let loaded = input.loaded;
        let selected = await this.selectPreparedCandidate({ modelId: input.request.modelId, state: loaded, activeProfileId: input.activeProfileId,
            requireFreshQuotaEvidence: input.requireFreshQuotaEvidence,
            signal: input.request.signal,
            reason: input.request.reason, allowCurrentProfileRetry: input.allowCurrentProfileRetry,
            providerLimitId: input.request.providerLimitId });
        let quotaRecovery = input.allowCurrentProfileRetry === true
            ? resolveCurrentProfileQuotaRecoveryProof({ selected, loaded })
            : undefined;
        if (selected.selected?.profileId === loaded.activeProfileId && !quotaRecovery
            && !(input.trigger === 'pre_turn' && input.allowCurrentProfileRetry === true)) {
            selected = await this.selectPreparedCandidate({
                modelId: input.request.modelId,
                requireFreshQuotaEvidence: input.requireFreshQuotaEvidence,
                signal: input.request.signal,
                state: loaded,
                activeProfileId: input.activeProfileId,
                reason: input.request.reason,
                providerLimitId: input.request.providerLimitId,
            });
        }
        let policyResult: ConnectedServiceAuthGroupSwitchResult | null = null;
        const unavailableProfileIds = new Set(selected.excluded.filter((entry) => entry.reason === 'credential_unavailable').map((entry) => entry.profileId));
        const selectionInput = () => ({ modelId: input.request.modelId, providerLimitId: input.request.providerLimitId,
            requireFreshQuotaEvidence: input.requireFreshQuotaEvidence,
            requiredModelIds: loaded.requiredModelIds, reason: input.request.reason, nowMs: this.deps.nowMs(),
            activeProfileId: loaded.activeProfileId, policy: loaded.policy, members: loaded.members,
            lastSwitchReason: loaded.lastSwitchReason, lastSwitchAt: loaded.lastSwitchAt,
            memberStatesByProfileId: loaded.memberStatesByProfileId, unavailableProfileIds,
            quotaProbeDeferredUntilMsByProfileId: loaded.quotaProbeDeferredUntilMsByProfileId });
        const reconsider = async (receipt?: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1) => {
            loaded = applyMemberStateOverrides({ loaded: { ...await this.deps.loadState(input.request), quotaProbeDeferredUntilMsByProfileId: loaded.quotaProbeDeferredUntilMsByProfileId }, overrides: input.overrides });
            policyResult = !this.isExpectedFailureSourceCurrent(input.request, loaded)
                ? { status: 'stale_context', generation: loaded.generation }
                : this.resolvePolicyResult({ ...input, loaded });
            if (policyResult) return;
            selected = await this.selectPreparedCandidate({ modelId: input.request.modelId, state: loaded, activeProfileId: loaded.activeProfileId,
                requireFreshQuotaEvidence: input.requireFreshQuotaEvidence,
                signal: input.request.signal,
                reason: input.request.reason, allowCurrentProfileRetry: true, unavailableProfileIds,
                providerLimitId: input.request.providerLimitId });
            for (const entry of selected.excluded) if (entry.reason === 'credential_unavailable') unavailableProfileIds.add(entry.profileId);
            const chosen = selected.selected;
            quotaRecovery = resolveCurrentProfileQuotaRecoveryProof({
                selected,
                loaded,
                ...(receipt ? { receipt } : {}),
            });
            if (chosen?.profileId === loaded.activeProfileId && !quotaRecovery) {
                selected = await this.selectPreparedCandidate({ modelId: input.request.modelId, state: loaded, activeProfileId: loaded.activeProfileId,
                    requireFreshQuotaEvidence: input.requireFreshQuotaEvidence,
                    signal: input.request.signal,
                    reason: input.request.reason, unavailableProfileIds,
                    providerLimitId: input.request.providerLimitId });
            }
        };
        if (!selected.selected && loaded.policy.autoUseQuotaResetsWhenExhausted === true
            && (input.request.reason === 'usage_limit' || input.request.reason === 'same_provider_account_exhausted')
            && this.deps.consumeAvailableRecoveryCreditForProfile) {
            for (const candidate of resolveConnectedServiceAuthGroupQuotaResetCandidates(selectionInput())) {
                const prepared = await this.deps.prepareCandidateForSwitch?.({ ...input.request, profileId: candidate.profileId });
                if (prepared?.status === 'ineligible') {
                    unavailableProfileIds.add(candidate.profileId);
                    selected = selectConnectedServiceAuthGroupCandidate({ ...selectionInput(), allowCurrentProfileRetry: true });
                    break;
                }
                await reconsider();
                if (policyResult || selected.selected || loaded.policy.autoUseQuotaResetsWhenExhausted !== true) break;
                const currentResetCandidate = resolveConnectedServiceAuthGroupQuotaResetCandidates(selectionInput())
                    .find((member) => member.profileId === candidate.profileId);
                if (!currentResetCandidate) break;
                const reset = await this.deps.consumeAvailableRecoveryCreditForProfile({
                    ...input.request, profileId: candidate.profileId,
                    automaticResetContext: { groupId: input.request.groupId,
                        ...(input.request.sessionId ? { sessionId: input.request.sessionId } : {}),
                        providerLimitIds: input.request.providerLimitId?.trim()
                            ? [input.request.providerLimitId.trim()] : currentResetCandidate.providerLimitIds },
                });
                logger.info('[ConnectedServiceAuthGroupSwitch] quota reset result', {
                    serviceId: input.request.serviceId, groupId: input.request.groupId, profileId: candidate.profileId,
                    ok: reset.ok, outcome: reset.receipt?.status ?? (!reset.ok ? reset.errorCode : 'no_receipt'),
                });
                await reconsider(reset.receipt);
                if (policyResult) break;
                // Only a definitive refusal can advance to another reset candidate.
                if (!selected.selected
                    && !reset.ok && reset.errorCode === 'connected_service_quota_recovery_credit_not_available') continue;
                break;
            }
        }
        return { loaded, selected, quotaRecovery, policyResult };
    }

    private isExpectedFailureSourceCurrent(input: Readonly<{
        expectedFailureSource?: ConnectedServiceAuthGroupExpectedFailureSource;
    }>, state: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>): boolean {
        const expected = input.expectedFailureSource;
        if (!expected) return true;
        if (expected.isCurrent && !expected.isCurrent()) return false;
        const expectedProfileId = normalizeProfileId(expected.profileId);
        return expectedProfileId !== null
            && (expected.credentialHealthStatus === undefined
                || state.memberStatesByProfileId.get(expectedProfileId)?.credentialHealthStatus === expected.credentialHealthStatus)
            && normalizeProfileId(state.activeProfileId)
                === expectedProfileId
            && state.credentialRevision
                === expected.credentialRevision
            && state.members.some(
                (member) => normalizeProfileId(member.profileId)
                    === expectedProfileId,
            );
    }

    private completeStaleFailureContext(
        lease: Extract<
            LeaseAcquireResult<TServiceIdentity>,
            Readonly<{ kind: 'owner' }>
        >,
        state: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>,
    ): Extract<
        ConnectedServiceAuthGroupSwitchResult,
        Readonly<{ status: 'stale_context' }>
    > {
        const result = {
            status: 'stale_context',
            generation: state.generation,
        } as const;
        lease.completeResult(result, state);
        return result;
    }

    private async probeQuotaSnapshotsBeforeSelection(input: Readonly<{
        request: Readonly<{
            signal?: AbortSignal;
            serviceId: TServiceIdentity;
            groupId: string;
            reason: string;
        }>;
        loaded: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>;
        activeProfileId?: string | null;
        allowCurrentProfileRetry: boolean;
    }>): Promise<Readonly<{
        loaded: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>;
        probeResult?: ConnectedServiceAuthGroupQuotaProbeResult;
    }>> {
        const probeQuotaSnapshotsForGroup = this.deps.probeQuotaSnapshotsForGroup;
        input.request.signal?.throwIfAborted();
        if (!probeQuotaSnapshotsForGroup) return { loaded: input.loaded };
        const profileIds = resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds({
            activeProfileId: input.activeProfileId ?? input.loaded.activeProfileId,
            members: input.loaded.members,
            memberStatesByProfileId: input.loaded.memberStatesByProfileId,
            policy: input.loaded.policy,
            nowMs: this.deps.nowMs(),
            allowCurrentProfileRetry: input.allowCurrentProfileRetry,
        });
        if (profileIds.length === 0) return { loaded: input.loaded };
        const probeResult = await observeCurrentConnectedServiceMaterializationPhase('group_quota_probe', () => probeQuotaSnapshotsForGroup.call(this.deps, {
            signal: input.request.signal,
            serviceId: input.request.serviceId,
            groupId: input.request.groupId,
            profileIds,
            reason: input.request.reason,
        }));
        input.request.signal?.throwIfAborted();
        if (probeResult?.status === 'incomplete') {
            logger.warn('[ConnectedServiceAuthGroupSwitchCoordinator] Quota probe incomplete', {
                serviceId: input.request.serviceId, groupId: input.request.groupId, reason: probeResult.reason,
            });
        }
        // Reread the quota projection; retain provider backoff only for this selection attempt.
        const loaded = await this.deps.loadState({
            signal: input.request.signal,
            serviceId: input.request.serviceId,
            groupId: input.request.groupId,
        });
        return { loaded: { ...loaded,
            quotaProbeDeferredUntilMsByProfileId: new Map((probeResult?.deferredProfiles ?? []).map(member => [member.profileId, member.retryAtMs])),
        }, ...(probeResult ? { probeResult } : {}) };
    }

    private readPredictiveSessionApplyFailure(input: Readonly<{
        applyResult: ConnectedServiceAuthGroupGenerationApplyResult | undefined;
        sessionId?: string;
        reason?: string;
    }>): ConnectedServiceAuthGroupGenerationApplyFailure | null {
        if (!isGenerationApplySuccess(input.applyResult)) return null;
        const decision = evaluatePredictiveSoftSwitchSessionApplyPolicy({
            reason: (input.reason ?? 'unknown') as Parameters<typeof evaluatePredictiveSoftSwitchSessionApplyPolicy>[0]['reason'],
            sessionId: input.sessionId,
            applyMode: input.applyResult.mode,
        });
        if (decision.status === 'allow') return null;
        return {
            ok: false,
            errorCode: 'hot_apply_restart_required',
            diagnostics: {
                policyReason: decision.reason,
                ...(input.applyResult.mode ? { attemptedMode: input.applyResult.mode } : {}),
            },
        };
    }

    private buildSessionApplyInput(input: Readonly<{
        completion: LeaseCompletion<TServiceIdentity>;
        sessionId?: string;
        reason?: string;
    }>): ConnectedServiceAuthGroupGenerationApplyInput<TServiceIdentity> {
        const sessionId = normalizeProfileId(input.sessionId);
        const { decisionTrace: _decisionTrace, ...completion } = input.completion;
        return {
            ...completion,
            ...(sessionId ? { sessionId } : {}),
            ...(input.reason ? { reason: input.reason } : {}),
        };
    }

    private async preflightPredictiveSessionApply(
        input: ConnectedServiceAuthGroupGenerationApplyInput<
            TServiceIdentity
        >,
    ): Promise<ConnectedServiceAuthGroupGenerationApplyFailure | null> {
        if (!this.deps.preflightApplyGeneration) return null;
        if (input.reason !== 'soft_threshold' && input.reason !== 'same_provider_account_exhausted') return null;
        if (!normalizeProfileId(input.sessionId)) return null;
        let applyResult: ConnectedServiceAuthGroupGenerationApplyResult | undefined;
        try {
            applyResult = await this.deps.preflightApplyGeneration(input);
        } catch (error) {
            const thrownFailure = readConnectedServiceAuthGenerationApplyFailure(error);
            if (!thrownFailure) throw error;
            return {
                ok: false,
                ...thrownFailure,
            };
        }
        return resolveGenerationApplyFailure(applyResult, input)
            ?? this.readPredictiveSessionApplyFailure({
                applyResult,
                sessionId: input.sessionId,
                reason: input.reason,
            });
    }

    private async applyGeneration(
        input: ConnectedServiceAuthGroupGenerationApplyInput<
            TServiceIdentity
        >,
    ): Promise<
        | (Readonly<{ failure: null; credentialRevision: ConnectedServiceCredentialRevisionV1 | null; mode?: ConnectedServiceAccountSwitchMode }> & ConnectedServiceGenerationApplyEvidence)
        | Readonly<{ failure: Extract<
            ConnectedServiceAuthGroupSwitchResult,
            Readonly<{ status: 'generation_apply_failed' | 'predictive_apply_unavailable' }>
        > }>
    > {
        let applyResult: ConnectedServiceAuthGroupGenerationApplyResult | undefined;
        try {
            applyResult = await observeCurrentConnectedServiceMaterializationPhase('group_generation_apply', () => this.deps.applyGeneration(input));
        } catch (error) {
            const thrownFailure = readConnectedServiceAuthGenerationApplyFailure(error);
            if (!thrownFailure) throw error;
            return {
                failure: {
                    ...buildGenerationApplyResult({
                        activeProfileId: input.activeProfileId,
                        generation: input.generation,
                        reason: input.reason,
                        failure: {
                            ok: false,
                            ...thrownFailure,
                        },
                    }),
                },
            };
        }
        const applyFailure = resolveGenerationApplyFailure(applyResult, input);
        if (applyFailure) {
            return {
                failure: buildGenerationApplyResult({
                    activeProfileId: input.activeProfileId,
                    generation: input.generation,
                    reason: input.reason,
                    failure: applyFailure,
                }),
            };
        }
        const predictiveFailure = this.readPredictiveSessionApplyFailure({
            applyResult,
            sessionId: input.sessionId,
            reason: input.reason,
        });
        if (predictiveFailure) {
            return {
                failure: buildGenerationApplyResult({
                    activeProfileId: input.activeProfileId,
                    generation: input.generation,
                    reason: input.reason,
                    failure: predictiveFailure,
                }),
            };
        }
        return {
            failure: null,
            credentialRevision: readConnectedServiceApplicationTargetCredentialRevision({
                ...input, profileId: input.activeProfileId,
                ...(isGenerationApplySuccess(applyResult) ? applyResult : {}),
            }),
            ...generationApplyEvidenceFields(isGenerationApplySuccess(applyResult) ? applyResult : {}),
        };
    }

    private async resolveAuthoritativeRevisionSupersession(input: Readonly<{
        completion: ConnectedServiceAuthGroupGenerationApplyInput<TServiceIdentity>;
        failure: Extract<
            ConnectedServiceAuthGroupSwitchResult,
            Readonly<{ status: 'generation_apply_failed' | 'predictive_apply_unavailable' }>
        >;
        decisionTrace?: ConnectedServiceAuthGroupCandidateDecisionTrace;
    }>): Promise<Extract<ConnectedServiceAuthGroupSwitchResult, Readonly<{ status: 'superseded_after_apply' }>> | null> {
        if (input.failure.errorCode !== 'credential_revision_superseded') return null;
        const observed = await this.deps.loadState({
            serviceId: input.completion.serviceId,
            groupId: input.completion.groupId,
        });
        const attemptedRevision = input.completion.credentialRevision ?? null;
        const observedRevision = observed.credentialRevision ?? null;
        const isAuthoritativeSupersession = observed.generation > input.completion.generation
            || (
                observed.generation === input.completion.generation
                && observed.activeProfileId === input.completion.activeProfileId
                && attemptedRevision !== null
                && observedRevision !== null
                && observedRevision !== attemptedRevision
            );
        if (!isAuthoritativeSupersession) return null;
        const diagnostics = input.decisionTrace === undefined
            ? input.failure.diagnostics
            : mergeSwitchDecisionDiagnostics({
                diagnostics: input.failure.diagnostics,
                decisionTrace: input.decisionTrace,
            });
        return {
            status: 'superseded_after_apply',
            activeProfileId: observed.activeProfileId,
            generation: observed.generation,
            credentialRevision: observedRevision,
            adoptedProfileId: input.completion.activeProfileId,
            adoptedGeneration: input.completion.generation,
            adoptedCredentialRevision: attemptedRevision,
            reconciliationDisposition: 'superseded_after_apply',
            ...(diagnostics === undefined ? {} : { diagnostics }),
        };
    }

    private async applyObservedGeneration(
        input: ConnectedServiceAuthGroupGenerationApplyInput<
            TServiceIdentity
        >,
        decisionTrace?: ConnectedServiceAuthGroupCandidateDecisionTrace,
    ): Promise<ObservedGenerationApplyResult> {
        const preflightFailure = await this.preflightPredictiveSessionApply(input);
        if (preflightFailure) {
            return buildGenerationApplyResult({
                activeProfileId: input.activeProfileId,
                generation: input.generation,
                reason: input.reason,
                failure: preflightFailure,
                ...(decisionTrace === undefined ? {} : { decisionTrace }),
            });
        }
        const applyOutcome = await this.applyGeneration(input);
        if (applyOutcome.failure) {
            const superseded = await this.resolveAuthoritativeRevisionSupersession({
                completion: input,
                failure: applyOutcome.failure,
                ...(decisionTrace === undefined ? {} : { decisionTrace }),
            });
            if (superseded) return superseded;
            return decisionTrace === undefined
                ? applyOutcome.failure
                : {
                    ...applyOutcome.failure,
                    diagnostics: mergeSwitchDecisionDiagnostics({
                        diagnostics: applyOutcome.failure.diagnostics,
                        decisionTrace,
                    }),
                };
        }
        const observedAfterApply = await this.deps.loadState({
            serviceId: input.serviceId,
            groupId: input.groupId,
        });
        if (observedAfterApply.generation >= input.generation
            && (observedAfterApply.generation !== input.generation
                || observedAfterApply.activeProfileId !== input.activeProfileId)) {
            return {
                status: 'superseded_after_apply',
                activeProfileId: observedAfterApply.activeProfileId,
                generation: observedAfterApply.generation,
                credentialRevision: observedAfterApply.credentialRevision ?? null,
                adoptedProfileId: input.activeProfileId,
                adoptedGeneration: input.generation,
                adoptedCredentialRevision: input.credentialRevision ?? null,
                reconciliationDisposition: 'superseded_after_apply',
                ...generationApplyEvidenceFields(applyOutcome),
                ...(decisionTrace === undefined
                    ? {}
                    : { diagnostics: buildSwitchDecisionDiagnostics({ decisionTrace }) }),
            };
        }
        return {
            status: 'observed_generation',
            activeProfileId: input.activeProfileId,
            generation: input.generation,
            credentialRevision: applyOutcome.credentialRevision,
            ...(input.quotaRecovery ? { quotaRecovery: input.quotaRecovery } : {}),
            ...generationApplyEvidenceFields(applyOutcome),
            ...(decisionTrace === undefined
                ? {}
                : { diagnostics: buildSwitchDecisionDiagnostics({ decisionTrace }) }),
        };
    }

    private async resolveStateAfterGenerationConflict(input: Readonly<{
        modelId?: string | null;
        requireFreshQuotaEvidence?: boolean;
        error: unknown;
        serviceId: TServiceIdentity;
        groupId: string;
        loaded: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>;
        sessionId?: string;
        reason?: string;
        observedProfileId?: string | null;
        providerLimitId?: string | null;
        expectedFailureSource?: ConnectedServiceAuthGroupExpectedFailureSource;
        lease: Extract<
            LeaseAcquireResult<TServiceIdentity>,
            Readonly<{ kind: 'owner' }>
        >;
    }>): Promise<GenerationConflictResolution<TServiceIdentity> | null> {
        const conflictGeneration = this.deps.resolveGenerationConflict?.(input.error);
        if (typeof conflictGeneration !== 'number' || !Number.isFinite(conflictGeneration)) return null;
        const observed = await this.deps.loadState({
            serviceId: input.serviceId,
            groupId: input.groupId,
        });
        if (!this.isExpectedFailureSourceCurrent(input, observed)) return { kind: 'retry', state: observed };
        if (observed.generation <= input.loaded.generation) return null;
        if (normalizeProfileId(observed.activeProfileId) === normalizeProfileId(input.loaded.activeProfileId)) {
            return { kind: 'retry', state: observed };
        }
        const failedProfileId = normalizeProfileId(input.observedProfileId)
            ?? normalizeProfileId(input.loaded.activeProfileId);
        const observedActiveProfileId = normalizeProfileId(observed.activeProfileId);
        if (!observedActiveProfileId || !failedProfileId) {
            return { kind: 'retry', state: observed };
        }
        const observedGenerationSelection = selectConnectedServiceAuthGroupCandidate({
            modelId: input.modelId, reason: input.reason, requiredModelIds: observed.requiredModelIds,
            requireFreshQuotaEvidence: input.requireFreshQuotaEvidence,
            nowMs: this.deps.nowMs(),
            activeProfileId: failedProfileId,
            policy: observed.policy,
            lastSwitchReason: observed.lastSwitchReason,
            lastSwitchAt: observed.lastSwitchAt,
            members: observed.members,
            memberStatesByProfileId: observed.memberStatesByProfileId,
            quotaProbeDeferredUntilMsByProfileId: observed.quotaProbeDeferredUntilMsByProfileId,
            providerLimitId: input.providerLimitId,
        });
        if (!isProfileEligibleForObservedGeneration({
            modelId: input.modelId,
            profileId: observedActiveProfileId,
            reason: input.reason ?? '',
            policy: observed.policy,
            nowMs: this.deps.nowMs(),
            memberStatesByProfileId: observed.memberStatesByProfileId,
            selected: observedGenerationSelection,
            providerLimitId: input.providerLimitId,
        })) {
            return {
                kind: 'retry',
                state: observed,
                selectionActiveProfileId: observed.activeProfileId,
            };
        }
        const completion = {
            serviceId: input.serviceId,
            groupId: input.groupId,
            activeProfileId: observed.activeProfileId,
            generation: observed.generation,
            credentialRevision: observed.credentialRevision,
        };
        input.lease.complete(completion);
        return {
            kind: 'observed_generation',
            result: await this.applyObservedGeneration(this.buildSessionApplyInput({
                completion,
                sessionId: input.sessionId,
                reason: input.reason,
            }), observedGenerationSelection.decisionTrace),
        };
    }

    private async recordObservedFailureStateWithConflictRecovery(input: Readonly<{
        modelId?: string | null;
        serviceId: TServiceIdentity;
        groupId: string;
        loaded: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>;
        sessionId?: string;
        reason: string;
        observedProfileId?: string | null;
        retryAtMs?: number | null;
        retryAfterMs?: number | null;
        resetsAtMs?: number | null;
        limitCategory?: string | null;
        quotaScope?: string | null;
        providerLimitId?: string | null;
        planType?: string | null;
        expectedFailureSource?: ConnectedServiceAuthGroupExpectedFailureSource;
        lease: Extract<
            LeaseAcquireResult<TServiceIdentity>,
            Readonly<{ kind: 'owner' }>
        >;
    }>): Promise<RecordObservedFailureStateOutcome<TServiceIdentity>> {
        if (!this.deps.recordObservedFailureState) {
            return { kind: 'recorded', state: input.loaded };
        }

        let loaded = input.loaded;
        for (;;) {
            if (!this.isExpectedFailureSourceCurrent(input, loaded)) return { kind: 'recorded', state: loaded };
            try {
                await this.deps.recordObservedFailureState({
                    serviceId: input.serviceId,
                    groupId: input.groupId,
                    loaded,
                    reason: input.reason,
                    observedProfileId: input.observedProfileId,
                    retryAtMs: input.retryAtMs,
                    retryAfterMs: input.retryAfterMs,
                    resetsAtMs: input.resetsAtMs,
                    limitCategory: input.limitCategory,
                    quotaScope: input.quotaScope,
                    providerLimitId: input.providerLimitId,
                    planType: input.planType,
                });
                return {
                    kind: 'recorded',
                    state: await this.deps.loadState({
                        serviceId: input.serviceId,
                        groupId: input.groupId,
                    }),
                };
            } catch (error) {
                const resolvedConflict = await this.resolveStateAfterGenerationConflict({
                    modelId: input.modelId,
                    error,
                    serviceId: input.serviceId,
                    groupId: input.groupId,
                    loaded,
                    sessionId: input.sessionId,
                    reason: input.reason,
                    observedProfileId: input.observedProfileId,
                    providerLimitId: input.providerLimitId,
                    expectedFailureSource: input.expectedFailureSource,
                    lease: input.lease,
                });
                if (!resolvedConflict) throw error;
                if (resolvedConflict.kind === 'observed_generation') return resolvedConflict;
                loaded = resolvedConflict.state;
            }
        }
    }

    private emitSwitchResult(input: Readonly<{
        request: Readonly<{
            serviceId: TServiceIdentity;
            groupId: string;
            reason: string;
            observedProfileId?: string | null;
            retryAtMs?: number | null;
            retryAfterMs?: number | null;
            limitCategory?: string | null;
            quotaScope?: string | null;
            providerLimitId?: string | null;
            action?: unknown | null;
        }>;
        loaded: Pick<
            ConnectedServiceAuthGroupSwitchState<TServiceIdentity>,
            'activeProfileId' | 'generation'
        >;
        resultStatus: ConnectedServiceAuthGroupSwitchResult['status'];
        toProfileId: string | null;
        toGeneration: number;
        success: boolean;
        startedAtMs: number;
        mode?: ConnectedServiceAccountSwitchMode;
        decisionTrace?: ConnectedServiceAuthGroupCandidateDecisionTrace;
    }>): void {
        const retryAfterMs = input.request.retryAfterMs ?? input.request.retryAtMs ?? undefined;
        const fromProfileId = normalizeProfileId(input.request.observedProfileId) ?? input.loaded.activeProfileId;
        logger.infoFile('[ConnectedServiceAuthGroupSwitch] completed', {
            serviceId: input.request.serviceId, groupId: input.request.groupId, reason: input.request.reason,
            fromProfileId, toProfileId: input.toProfileId,
            fromGeneration: fromProfileId === input.loaded.activeProfileId ? input.loaded.generation : null,
            toGeneration: input.toGeneration, resultStatus: input.resultStatus, success: input.success,
            ...(input.mode ? { mode: input.mode } : {}),
            ...(input.decisionTrace ? { decisionTrace: input.decisionTrace } : {}),
        });
        this.deps.emitEvent?.({
            type: 'connected_service_auth_group_switch',
            serviceId: input.request.serviceId,
            groupId: input.request.groupId,
            fromProfileId: normalizeProfileId(input.request.observedProfileId) ?? input.loaded.activeProfileId,
            toProfileId: input.toProfileId,
            reason: input.request.reason,
            fromGeneration: input.loaded.generation,
            toGeneration: input.toGeneration,
            resultStatus: input.resultStatus,
            success: input.success,
            latencyMs: Math.max(0, this.deps.nowMs() - input.startedAtMs),
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            ...(input.request.limitCategory !== undefined ? { limitCategory: input.request.limitCategory } : {}),
            ...(input.request.quotaScope !== undefined ? { quotaScope: input.request.quotaScope } : {}),
            ...(input.request.providerLimitId !== undefined ? { providerLimitId: input.request.providerLimitId } : {}),
            ...(input.request.action !== undefined ? { action: input.request.action } : {}),
            ...(input.mode ? { mode: input.mode } : {}),
            ...(input.decisionTrace === undefined ? {} : { decisionTrace: input.decisionTrace }),
        });
    }

    private async waitForLeaseOwnerOrAuthoritativeState(input: Readonly<{
        signal?: AbortSignal;
        serviceId: TServiceIdentity;
        groupId: string;
        observedProfileId?: string | null;
    }>, lease: Extract<
        LeaseAcquireResult<TServiceIdentity>,
        Readonly<{ kind: 'loser' }>
    >): Promise<Readonly<{
        observed: LeaseCompletion<TServiceIdentity> | LeaseResultCompletion;
        fromAuthoritativeReread: boolean;
    }>> {
        try {
            return {
                observed: await observeCurrentConnectedServiceMaterializationPhase('group_lease_wait', () => lease.waitForOwner({ signal: input.signal })),
                fromAuthoritativeReread: false,
            };
        } catch (error) {
            const failedProfileId = normalizeProfileId(input.observedProfileId);
            if (
                !(error instanceof ConnectedServiceAuthGroupSwitchLeaseExpiredError)
                || !failedProfileId
            ) {
                throw error;
            }
            const current = await this.deps.loadState(input);
            const currentProfileId = normalizeProfileId(current.activeProfileId);
            if (!currentProfileId || currentProfileId === failedProfileId) {
                throw error;
            }
            // A peer committed current group truth before its longer application work
            // completed. Consume that authoritative generation instead of terminalizing the
            // recovery on a coordination timeout.
            return {
                observed: {
                    serviceId: current.serviceId,
                    groupId: current.groupId,
                    activeProfileId: currentProfileId,
                    generation: current.generation,
                    ...(current.credentialRevision === undefined
                        ? {}
                        : { credentialRevision: current.credentialRevision }),
                },
                fromAuthoritativeReread: true,
            };
        }
    }

    /** Observe current membership while retaining evidence on the profile that actually failed. */
    async observeCurrentGenerationForRecovery(input: Readonly<{
        serviceId: TServiceIdentity;
        groupId: string;
        observedProfileId: string | null;
        modelId?: string | null;
        failure?: Pick<ConnectedServiceAuthGroupSwitchRequest<TServiceIdentity>,
            'reason' | 'retryAtMs' | 'retryAfterMs' | 'resetsAtMs' | 'limitCategory' | 'quotaScope' | 'providerLimitId' | 'planType'>;
    }>): Promise<ConnectedServiceAuthGroupSwitchResult> {
        const startedAtMs = this.deps.nowMs();
        let initial = await this.deps.loadState(input);
        if (input.failure && input.observedProfileId && this.deps.recordObservedFailureState) {
            await this.deps.recordObservedFailureState({ ...input, ...input.failure, loaded: initial });
            initial = await this.deps.loadState(input);
        }
        const request = { ...input, ...input.failure, reason: input.failure?.reason ?? 'usage_limit' };
        const { loaded, probeResult } = await this.probeQuotaSnapshotsBeforeSelection({
            request,
            loaded: { ...initial, members: initial.members.filter(member => member.profileId === initial.activeProfileId) },
            allowCurrentProfileRetry: true,
        });
        const selected = selectConnectedServiceAuthGroupCandidate({
            modelId: input.modelId, reason: request.reason, requiredModelIds: loaded.requiredModelIds,
            providerLimitId: input.failure?.providerLimitId,
            quotaProbeDeferredUntilMsByProfileId: loaded.quotaProbeDeferredUntilMsByProfileId,
            nowMs: this.deps.nowMs(),
            activeProfileId: loaded.activeProfileId, allowCurrentProfileRetry: true,
            policy: loaded.policy, members: loaded.members.filter(member => member.profileId === loaded.activeProfileId),
            memberStatesByProfileId: loaded.memberStatesByProfileId,
            lastSwitchReason: loaded.lastSwitchReason, lastSwitchAt: loaded.lastSwitchAt,
        });
        // A probe of a superseded member cannot lend its retry boundary to the replacement.
        const currentProbeResult = loaded.activeProfileId === initial.activeProfileId ? probeResult : undefined;
        const quotaRecovery = resolveCurrentProfileQuotaRecoveryProof({ selected, loaded });
        const wait = resolveConnectedServiceAuthGroupQuotaProbeWait({ probeResult: quotaRecovery ? undefined : currentProbeResult,
            hasSelectedProfile: Boolean(selected.selected), nowMs: this.deps.nowMs() });
        const diagnostics = buildSwitchDecisionDiagnostics({ decisionTrace: selected.decisionTrace });
        let result: ConnectedServiceAuthGroupSwitchResult;
        if (wait || (selected.selected && !quotaRecovery)) {
            result = { status: 'quota_proof_unavailable', activeProfileId: loaded.activeProfileId, generation: loaded.generation,
                ...wait, diagnostics };
        } else if (!loaded.activeProfileId || !quotaRecovery) {
            result = { status: 'no_eligible_member', generation: loaded.generation, groupExhausted: true,
                activeProfileId: loaded.activeProfileId, retryAtMs: resolveEarliestRetryAtMs(selected.excluded), excluded: selected.excluded, diagnostics };
        } else {
            result = { status: 'observed_generation', activeProfileId: loaded.activeProfileId, generation: loaded.generation,
                credentialRevision: loaded.credentialRevision ?? null,
                ...(loaded.activeProfileId === input.observedProfileId ? { quotaRecovery } : {}) };
        }
        this.emitSwitchResult({ request, loaded: initial, resultStatus: result.status,
            toProfileId: loaded.activeProfileId, toGeneration: loaded.generation,
            success: result.status === 'observed_generation', startedAtMs, decisionTrace: selected.decisionTrace });
        return result;
    }

    async switchAfterClassifiedFailure(input: ConnectedServiceAuthGroupSwitchRequest<TServiceIdentity>): Promise<ConnectedServiceAuthGroupSwitchResult> {
        return await this.switchSelection(input, 'classified_failure');
    }

    private async switchSelection(input: ConnectedServiceAuthGroupSwitchRequest<TServiceIdentity> & Readonly<{
        signal?: AbortSignal;
        memberStateOverridesByProfileId?: ReadonlyArray<ConnectedServiceAuthGroupMemberRuntimeStateOverride>;
    }>, trigger: 'classified_failure' | 'pre_turn'): Promise<ConnectedServiceAuthGroupSwitchResult> {
        input.signal?.throwIfAborted();
        const startedAtMs = this.deps.nowMs();
        let preloaded: ConnectedServiceAuthGroupSwitchState<TServiceIdentity> | undefined;
        if (trigger === 'pre_turn') {
            preloaded = applyMemberStateOverrides({
                loaded: await this.deps.loadState(input),
                overrides: input.memberStateOverridesByProfileId,
            });
            input.signal?.throwIfAborted();
            const policyResult = this.resolvePolicyResult({ trigger, request: input, loaded: preloaded });
            if (policyResult) {
                return policyResult;
            }
        }
        let lease = this.deps.leases.acquire({ ...input, accountScope: this.deps.accountScope });
        while (lease.kind === 'loser') {
            const {
                observed,
                fromAuthoritativeReread: observedFromAuthoritativeReread,
            } = await this.waitForLeaseOwnerOrAuthoritativeState(input, lease);
            input.signal?.throwIfAborted();
            if (input.expectedFailureSource && !observedFromAuthoritativeReread) {
                const current = await this.deps.loadState(input);
                if (!this.isExpectedFailureSourceCurrent(input, current)) {
                    return {
                        status: 'stale_context',
                        generation: current.generation,
                    };
                }
            }
            if (isLeaseResultCompletion(observed)
                || (normalizeProfileId(input.observedProfileId)
                    && normalizeProfileId(input.observedProfileId) === normalizeProfileId(observed.activeProfileId))) {
                // A peer refusal is request-specific; a failure on its selected member
                // is a distinct failure. Acquire selection without replaying this request.
                lease = this.deps.leases.acquire({ ...input, accountScope: this.deps.accountScope });
                preloaded = undefined;
                continue;
            }
            const observedResult = await this.applyObservedGeneration(this.buildSessionApplyInput({
                completion: observed,
                sessionId: input.sessionId,
                reason: input.reason,
            }), observed.decisionTrace);
            if (observedResult.status === 'generation_apply_failed') {
                this.emitSwitchResult({
                    request: input,
                    loaded: observed,
                    resultStatus: 'generation_apply_failed',
                    toProfileId: observed.activeProfileId,
                    toGeneration: observed.generation,
                    success: false,
                    startedAtMs,
                });
                return observedResult;
            }
            if (observedResult.status === 'predictive_apply_unavailable') return observedResult;
            this.emitSwitchResult({
                request: input,
                loaded: observed,
                resultStatus: 'observed_generation',
                toProfileId: observed.activeProfileId,
                toGeneration: observed.generation,
                success: true,
                startedAtMs,
                mode: observedResult.mode,
            });
            return observedResult;
        }

        try {
            let loaded = applyMemberStateOverrides({
                loaded: await this.deps.loadState(input),
                overrides: input.memberStateOverridesByProfileId,
            });
            input.signal?.throwIfAborted();
            if (preloaded && loaded.generation > preloaded.generation && loaded.activeProfileId
                && loaded.activeProfileId !== normalizeProfileId(input.observedProfileId)) {
                const selected = selectConnectedServiceAuthGroupCandidate({
                    modelId: input.modelId, reason: input.reason, requiredModelIds: loaded.requiredModelIds,
                    quotaProbeDeferredUntilMsByProfileId: loaded.quotaProbeDeferredUntilMsByProfileId,
                    nowMs: this.deps.nowMs(),
                    activeProfileId: preloaded.activeProfileId, policy: loaded.policy,
                    members: loaded.members, memberStatesByProfileId: loaded.memberStatesByProfileId,
                    lastSwitchReason: loaded.lastSwitchReason, lastSwitchAt: loaded.lastSwitchAt,
                    providerLimitId: input.providerLimitId,
                });
                if (isProfileAdoptableForObservedDivergence({ profileId: loaded.activeProfileId,
                    members: loaded.members, selected })) {
                    const completion = { serviceId: input.serviceId, groupId: input.groupId,
                        activeProfileId: loaded.activeProfileId, generation: loaded.generation,
                        credentialRevision: loaded.credentialRevision, decisionTrace: selected.decisionTrace };
                    lease.complete(completion);
                    const applied = await this.applyObservedGeneration(this.buildSessionApplyInput({ completion,
                        sessionId: input.sessionId, reason: input.reason }), selected.decisionTrace);
                    this.emitSwitchResult({ request: input, loaded, resultStatus: applied.status,
                        toProfileId: completion.activeProfileId, toGeneration: completion.generation,
                        success: applied.status === 'observed_generation', startedAtMs, decisionTrace: selected.decisionTrace });
                    return applied;
                }
            }
            if (!this.isExpectedFailureSourceCurrent(input, loaded)) {
                return this.completeStaleFailureContext(lease, loaded);
            }
            if (
                input.reason === 'same_provider_account_exhausted'
                && input.providerLimitId != null
                && !isConnectedServiceAuthGroupProviderLimitSelected({
                    policy: loaded.policy,
                    providerLimitId: input.providerLimitId,
                })
            ) {
                const result = {
                    status: 'switch_reason_disabled' as const,
                    generation: loaded.generation,
                };
                lease.completeResult(result, loaded);
                return result;
            }
            const observedFailureOutcome: RecordObservedFailureStateOutcome<
                TServiceIdentity
            > = trigger === 'pre_turn' || (input.expectedFailureSource && !isRejectedStartModelEntitlementFailure(input))
                ? { kind: 'recorded', state: loaded }
                : await this.recordObservedFailureStateWithConflictRecovery({
                    modelId: input.modelId,
                    serviceId: input.serviceId,
                    groupId: input.groupId,
                    loaded,
                    reason: input.reason,
                    observedProfileId: input.observedProfileId,
                    retryAtMs: input.retryAtMs,
                    retryAfterMs: input.retryAfterMs,
                    resetsAtMs: input.resetsAtMs,
                    limitCategory: input.limitCategory,
                    quotaScope: input.quotaScope,
                    providerLimitId: input.providerLimitId,
                    planType: input.planType,
                    expectedFailureSource: input.expectedFailureSource,
                    lease,
                });
            if (observedFailureOutcome.kind === 'observed_generation') {
                this.emitSwitchResult({
                    request: input,
                    loaded,
                    resultStatus: observedFailureOutcome.result.status,
                    toProfileId: observedFailureOutcome.result.activeProfileId,
                    toGeneration: observedFailureOutcome.result.generation,
                    success: observedFailureOutcome.result.status === 'observed_generation',
                    startedAtMs,
                });
                return observedFailureOutcome.result;
            }
            loaded = observedFailureOutcome.state;
            if (!this.isExpectedFailureSourceCurrent(input, loaded)) {
                return this.completeStaleFailureContext(lease, loaded);
            }
            const observedProfileId = normalizeProfileId(input.observedProfileId);
            const loadedActiveProfileId = normalizeProfileId(loaded.activeProfileId);
            let selectionActiveProfileId: string | null = loaded.activeProfileId;
            let didProbeForSelection = false;
            let probeResult: ConnectedServiceAuthGroupQuotaProbeResult | undefined;
            if (observedProfileId && loadedActiveProfileId && loadedActiveProfileId !== observedProfileId) {
                selectionActiveProfileId = observedProfileId;
                ({ loaded, probeResult } = await this.probeQuotaSnapshotsBeforeSelection({
                    request: input,
                    loaded,
                    activeProfileId: selectionActiveProfileId,
                    allowCurrentProfileRetry: trigger === 'pre_turn'
                        ? canRetryObservedProfileDuringPreTurnSelection(input)
                        : input.allowCurrentProfileRetry === true,
                }));
                if (!this.isExpectedFailureSourceCurrent(input, loaded)) {
                    return this.completeStaleFailureContext(lease, loaded);
                }
                didProbeForSelection = true;
                const currentLoadedActiveProfileId = normalizeProfileId(loaded.activeProfileId);
                const observedGenerationSelection = selectConnectedServiceAuthGroupCandidate({
                    modelId: input.modelId, reason: input.reason, requiredModelIds: loaded.requiredModelIds,
                    requireFreshQuotaEvidence: probeResult?.status === 'incomplete',
                    quotaProbeDeferredUntilMsByProfileId: loaded.quotaProbeDeferredUntilMsByProfileId,
                    nowMs: this.deps.nowMs(),
                    activeProfileId: selectionActiveProfileId,
                    policy: loaded.policy,
                    lastSwitchReason: loaded.lastSwitchReason,
                    lastSwitchAt: loaded.lastSwitchAt,
                    members: loaded.members,
                    memberStatesByProfileId: loaded.memberStatesByProfileId,
                    providerLimitId: input.providerLimitId,
                });
                if (
                    currentLoadedActiveProfileId
                    && currentLoadedActiveProfileId !== observedProfileId
                    && (trigger === 'classified_failure' ? isProfileAdoptableForObservedDivergence({
                        profileId: currentLoadedActiveProfileId,
                        members: loaded.members,
                        selected: observedGenerationSelection,
                    }) : isProfileEligibleForObservedGeneration({
                        modelId: input.modelId,
                        profileId: currentLoadedActiveProfileId, reason: input.reason, policy: loaded.policy,
                        nowMs: this.deps.nowMs(),
                        memberStatesByProfileId: loaded.memberStatesByProfileId,
                        selected: observedGenerationSelection, providerLimitId: input.providerLimitId,
                    }))
                ) {
                    const completion = {
                        serviceId: input.serviceId,
                        groupId: input.groupId,
                        activeProfileId: loaded.activeProfileId,
                        generation: loaded.generation,
                        credentialRevision: loaded.credentialRevision,
                        decisionTrace: observedGenerationSelection.decisionTrace,
                    };
                    lease.complete(completion);
                    const applied = await this.applyObservedGeneration(this.buildSessionApplyInput({
                        completion,
                        sessionId: input.sessionId,
                        reason: input.reason,
                    }), observedGenerationSelection.decisionTrace);
                    if (applied.status === 'generation_apply_failed' || applied.status === 'observed_generation') {
                        this.emitSwitchResult({
                            request: input,
                            loaded,
                            resultStatus: applied.status,
                            toProfileId: applied.activeProfileId,
                            toGeneration: applied.generation,
                            success: applied.status === 'observed_generation',
                            startedAtMs,
                            ...(applied.status === 'observed_generation' ? { mode: applied.mode } : {}),
                            decisionTrace: observedGenerationSelection.decisionTrace,
                        });
                    }
                    return applied;
                }
                selectionActiveProfileId = currentLoadedActiveProfileId;
            }
            const waitForClassifiedFailure = trigger === 'classified_failure' && shouldWaitForClassifiedFailure({
                reason: input.reason,
                recoveryMode: loaded.policy.recoveryMode,
            });
            const policyResult = this.resolvePolicyResult({ trigger, request: input, loaded });
            if (policyResult) {
                this.emitSwitchResult({ request: input, loaded, resultStatus: policyResult.status,
                    toProfileId: policyResult.status === 'auto_switch_disabled' || policyResult.status === 'switch_reason_disabled' ? loaded.activeProfileId : null,
                    toGeneration: loaded.generation, success: false, startedAtMs,
                    decisionTrace: readSwitchResultDecisionTrace(policyResult) });
                lease.completeResult(policyResult, loaded);
                return policyResult;
            }
            if (!didProbeForSelection && !(trigger === 'pre_turn' && input.reason === 'plan' && input.providerLimitId?.trim())) {
                ({ loaded, probeResult } = await this.probeQuotaSnapshotsBeforeSelection({
                    request: input,
                    loaded,
                    activeProfileId: selectionActiveProfileId,
                    allowCurrentProfileRetry: trigger === 'pre_turn'
                        ? canRetryObservedProfileDuringPreTurnSelection(input)
                        : input.allowCurrentProfileRetry === true,
                }));
                if (!this.isExpectedFailureSourceCurrent(input, loaded)) {
                    return this.completeStaleFailureContext(lease, loaded);
                }
            }
            loaded = applyMemberStateOverrides({ loaded, overrides: input.memberStateOverridesByProfileId });
            const policyAfterProbe = this.resolvePolicyResult({ trigger, request: input, loaded });
            if (policyAfterProbe) {
                lease.completeResult(policyAfterProbe, loaded);
                return policyAfterProbe;
            }
            const recovery = await this.selectWithQuotaRecovery({
                trigger, request: input, loaded, overrides: input.memberStateOverridesByProfileId, activeProfileId: selectionActiveProfileId,
                requireFreshQuotaEvidence: probeResult?.status === 'incomplete',
                allowCurrentProfileRetry: trigger === 'pre_turn'
                    ? canRetryCurrentProfileForObservedProfile({ ...input, activeProfileId: loaded.activeProfileId })
                    : input.allowCurrentProfileRetry,
            });
            input.signal?.throwIfAborted();
            loaded = recovery.loaded;
            const selected = recovery.selected;
            if (recovery.policyResult) {
                lease.completeResult(recovery.policyResult, loaded);
                return recovery.policyResult;
            }
            // After a partial probe, the selector admits only freshly proven candidates.
            const probeWait = resolveConnectedServiceAuthGroupQuotaProbeWait({
                probeResult: probeResult?.status === 'incomplete' && selected.selected ? undefined
                    : probeResult?.status === 'complete' ? { ...probeResult, deferredProfiles: probeResult.deferredProfiles?.filter(member =>
                    selected.excluded.some(excluded => excluded.profileId === member.profileId && excluded.reason === 'quota_probe_deferred')) } : probeResult,
                hasSelectedProfile: Boolean(selected.selected), nowMs: this.deps.nowMs(),
            });
            if (probeWait) {
                const result = { status: 'quota_proof_unavailable' as const, activeProfileId: loaded.activeProfileId,
                    generation: loaded.generation, ...probeWait,
                    diagnostics: buildSwitchDecisionDiagnostics({ decisionTrace: selected.decisionTrace }) };
                this.emitSwitchResult({ request: input, loaded, resultStatus: result.status,
                    toProfileId: loaded.activeProfileId, toGeneration: loaded.generation, success: false, startedAtMs,
                    decisionTrace: selected.decisionTrace });
                lease.completeResult(result, loaded);
                return result;
            }
            if ((recovery.quotaRecovery || (trigger === 'pre_turn' && canRetryCurrentProfileForObservedProfile({ ...input, activeProfileId: loaded.activeProfileId })))
                && selected.selected?.profileId === loaded.activeProfileId) {
                const completion = { serviceId: input.serviceId, groupId: input.groupId,
                    activeProfileId: loaded.activeProfileId, generation: loaded.generation,
                    credentialRevision: loaded.credentialRevision, decisionTrace: selected.decisionTrace,
                    quotaRecovery: recovery.quotaRecovery };
                lease.complete(completion);
                const applied = await this.applyObservedGeneration(this.buildSessionApplyInput({ completion,
                    sessionId: input.sessionId, reason: input.reason }), selected.decisionTrace);
                this.emitSwitchResult({ request: input, loaded, resultStatus: applied.status,
                    toProfileId: completion.activeProfileId, toGeneration: completion.generation,
                    success: applied.status === 'observed_generation', startedAtMs, decisionTrace: selected.decisionTrace });
                return applied;
            }
            if (!selected.selected) {
                if (selected.reason === 'manual_strategy') {
                    if (waitForClassifiedFailure) {
                        const result = buildPolicyWaitUntilResetResult({
                            loaded,
                            retryAtMs: resolvePolicyRecoveryWaitRetryAtMs(input),
                        });
                        lease.completeResult(result, loaded);
                        return result;
                    }
                    this.emitSwitchResult({
                        request: input,
                        loaded,
                        resultStatus: 'manual_strategy',
                        toProfileId: loaded.activeProfileId,
                        toGeneration: loaded.generation,
                        success: false,
                        startedAtMs,
                    });
                    const result = { status: 'manual_strategy', generation: loaded.generation } as const;
                    lease.completeResult(result, loaded);
                    return result;
                }
                this.emitSwitchResult({
                    request: input,
                    loaded,
                    resultStatus: 'no_eligible_member',
                    toProfileId: null,
                    toGeneration: loaded.generation,
                    success: false,
                    startedAtMs,
                    decisionTrace: selected.decisionTrace,
                });
                const result = {
                    status: 'no_eligible_member',
                    generation: loaded.generation,
                    groupExhausted: true,
                    retryAtMs: resolveEarliestRetryAtMs(selected.excluded),
                    excluded: selected.excluded,
                    diagnostics: buildSwitchDecisionDiagnostics({ decisionTrace: selected.decisionTrace }),
                } as const;
                lease.completeResult(result, loaded);
                return result;
            }

            let selectedProfileId = selected.selected.profileId;
            let selectedDecisionTrace = selected.decisionTrace;
            let commitLoaded = loaded;
            let commitSelectionActiveProfileId = selectionActiveProfileId;
            let committed: ConnectedServiceAuthGroupSwitchState<
                TServiceIdentity
            >;
            for (;;) {
                input.signal?.throwIfAborted();
                try {
                    const preflightFailure = await this.preflightPredictiveSessionApply({
                        sessionId: input.sessionId,
                        serviceId: input.serviceId,
                        groupId: input.groupId,
                        activeProfileId: selectedProfileId,
                        generation: commitLoaded.generation + 1,
                        reason: input.reason,
                    });
                    if (preflightFailure) {
                        const result = buildGenerationApplyResult({
                            activeProfileId: selectedProfileId,
                            generation: commitLoaded.generation + 1,
                            reason: input.reason,
                            failure: preflightFailure,
                            decisionTrace: selectedDecisionTrace,
                        });
                        if (result.status === 'generation_apply_failed') {
                            this.emitSwitchResult({
                                request: input,
                                loaded: commitLoaded,
                                resultStatus: 'generation_apply_failed',
                                toProfileId: selectedProfileId,
                                toGeneration: commitLoaded.generation + 1,
                                success: false,
                                startedAtMs,
                                decisionTrace: selectedDecisionTrace,
                            });
                        }
                        lease.completeResult(result, {
                            activeProfileId: selectedProfileId,
                            generation: commitLoaded.generation + 1,
                        });
                        return result;
                    }
                    if (input.expectedFailureSource) {
                        const current = await this.deps.loadState({
                            serviceId: input.serviceId,
                            groupId: input.groupId,
                        });
                        if (!this.isExpectedFailureSourceCurrent(input, current)) {
                            return this.completeStaleFailureContext(
                                lease,
                                current,
                            );
                        }
                    }
                    committed = await this.deps.commitSwitch({
                        signal: input.signal,
                        serviceId: input.serviceId,
                        groupId: input.groupId,
                        fromProfileId: commitLoaded.activeProfileId,
                        toProfileId: selectedProfileId,
                        expectedGeneration: commitLoaded.generation,
                        ...(commitLoaded.incarnation === undefined
                            ? {}
                            : {
                                expectedIncarnation:
                                    commitLoaded.incarnation,
                            }),
                        ...(commitLoaded.runtimeStateRevision === undefined
                            ? {}
                            : {
                                expectedRuntimeStateRevision:
                                    commitLoaded.runtimeStateRevision,
                            }),
                        ...(commitLoaded.credentialRevision === undefined
                            ? {}
                            : {
                                expectedCredentialRevision:
                                    commitLoaded.credentialRevision,
                            }),
                        ...(commitLoaded.configurationRevision === undefined
                            ? {}
                            : {
                                expectedConfigurationRevision:
                                    commitLoaded.configurationRevision,
                            }),
                        reason: input.reason,
                    });
                    break;
                } catch (error) {
                    if (input.expectedFailureSource) {
                        const current = await this.deps.loadState({
                            serviceId: input.serviceId,
                            groupId: input.groupId,
                        });
                        if (!this.isExpectedFailureSourceCurrent(input, current)) {
                            return this.completeStaleFailureContext(
                                lease,
                                current,
                            );
                        }
                    }
                    const resolvedConflict = await this.resolveStateAfterGenerationConflict({
                        modelId: input.modelId,
                        requireFreshQuotaEvidence: probeResult?.status === 'incomplete',
                        error,
                        serviceId: input.serviceId,
                        groupId: input.groupId,
                        loaded: commitLoaded,
                        sessionId: input.sessionId,
                        reason: input.reason,
                        observedProfileId: input.observedProfileId,
                        providerLimitId: input.providerLimitId,
                        expectedFailureSource: input.expectedFailureSource,
                        lease,
                    });
                    if (resolvedConflict?.kind === 'observed_generation') {
                        if (resolvedConflict.result.status !== 'predictive_apply_unavailable') {
                            this.emitSwitchResult({
                                request: input,
                                loaded: commitLoaded,
                                resultStatus: resolvedConflict.result.status,
                                toProfileId: resolvedConflict.result.activeProfileId,
                                toGeneration: resolvedConflict.result.generation,
                                success: resolvedConflict.result.status === 'observed_generation',
                                startedAtMs,
                            });
                        }
                        return resolvedConflict.result;
                    }
                    if (resolvedConflict?.kind === 'retry') {
                        commitLoaded = resolvedConflict.state;
                        commitSelectionActiveProfileId = resolvedConflict.selectionActiveProfileId ?? commitSelectionActiveProfileId;
                        const retrySelected = await this.selectPreparedCandidate({
                            modelId: input.modelId,
                            requireFreshQuotaEvidence: probeResult?.status === 'incomplete',
                            signal: input.signal,
                            state: commitLoaded,
                            activeProfileId: commitSelectionActiveProfileId,
                            reason: input.reason,
                            providerLimitId: input.providerLimitId,
                            allowCurrentProfileRetry: trigger === 'pre_turn'
                                ? canRetryCurrentProfileForObservedProfile({ ...input, activeProfileId: commitLoaded.activeProfileId })
                                : undefined,
                        });
                        if (!retrySelected.selected) {
                            if (retrySelected.reason === 'manual_strategy') {
                                if (waitForClassifiedFailure) {
                                    const result = buildPolicyWaitUntilResetResult({
                                        loaded: commitLoaded,
                                        retryAtMs: resolvePolicyRecoveryWaitRetryAtMs(input),
                                    });
                                    lease.completeResult(result, commitLoaded);
                                    return result;
                                }
                                this.emitSwitchResult({
                                    request: input,
                                    loaded: commitLoaded,
                                    resultStatus: 'manual_strategy',
                                    toProfileId: commitLoaded.activeProfileId,
                                    toGeneration: commitLoaded.generation,
                                    success: false,
                                    startedAtMs,
                                });
                                const result = { status: 'manual_strategy', generation: commitLoaded.generation } as const;
                                lease.completeResult(result, commitLoaded);
                                return result;
                            }
                            this.emitSwitchResult({
                                request: input,
                                loaded: commitLoaded,
                                resultStatus: 'no_eligible_member',
                                toProfileId: null,
                                toGeneration: commitLoaded.generation,
                                success: false,
                                startedAtMs,
                                decisionTrace: retrySelected.decisionTrace,
                            });
                            const result = {
                                status: 'no_eligible_member',
                                generation: commitLoaded.generation,
                                groupExhausted: true,
                                retryAtMs: resolveEarliestRetryAtMs(retrySelected.excluded),
                                excluded: retrySelected.excluded,
                                diagnostics: buildSwitchDecisionDiagnostics({ decisionTrace: retrySelected.decisionTrace }),
                            } as const;
                            lease.completeResult(result, commitLoaded);
                            return result;
                        }
                        selectedProfileId = retrySelected.selected.profileId;
                        selectedDecisionTrace = retrySelected.decisionTrace;
                        continue;
                    }
                    throw error;
                }
            }
            const completion = {
                serviceId: input.serviceId,
                groupId: input.groupId,
                activeProfileId: committed.activeProfileId,
                generation: committed.generation,
                credentialRevision: committed.credentialRevision,
                decisionTrace: selectedDecisionTrace,
            };
            lease.complete(completion);
            const applyOutcome = await this.applyGeneration(this.buildSessionApplyInput({
                completion,
                sessionId: input.sessionId,
                reason: input.reason,
            }));
            if (applyOutcome.failure) {
                const superseded = await this.resolveAuthoritativeRevisionSupersession({
                    completion: this.buildSessionApplyInput({
                        completion,
                        sessionId: input.sessionId,
                        reason: input.reason,
                    }),
                    failure: applyOutcome.failure,
                    decisionTrace: selectedDecisionTrace,
                });
                if (superseded) return superseded;
                if (applyOutcome.failure.status === 'generation_apply_failed') {
                    this.emitSwitchResult({
                        request: input,
                        loaded: commitLoaded,
                        resultStatus: 'generation_apply_failed',
                        toProfileId: committed.activeProfileId ?? selectedProfileId,
                        toGeneration: committed.generation,
                        success: false,
                        startedAtMs,
                        decisionTrace: selectedDecisionTrace,
                    });
                }
                return applyOutcome.failure.status === 'generation_apply_failed'
                    ? {
                        ...applyOutcome.failure,
                        diagnostics: mergeSwitchDecisionDiagnostics({
                            diagnostics: applyOutcome.failure.diagnostics,
                            decisionTrace: selectedDecisionTrace,
                        }),
                    }
                    : applyOutcome.failure;
            }
            const observedAfterApply = await this.deps.loadState({ serviceId: input.serviceId, groupId: input.groupId });
            if (observedAfterApply.generation >= committed.generation
                && (observedAfterApply.generation !== committed.generation
                    || observedAfterApply.activeProfileId !== (committed.activeProfileId ?? selectedProfileId))) {
                this.emitSwitchResult({ request: input, loaded: commitLoaded, resultStatus: 'superseded_after_apply',
                    toProfileId: observedAfterApply.activeProfileId, toGeneration: observedAfterApply.generation,
                    success: false, startedAtMs, mode: applyOutcome.mode, decisionTrace: selectedDecisionTrace });
                return {
                    status: 'superseded_after_apply',
                    activeProfileId: observedAfterApply.activeProfileId,
                    generation: observedAfterApply.generation,
                    credentialRevision: observedAfterApply.credentialRevision ?? null,
                    adoptedProfileId: committed.activeProfileId ?? selectedProfileId,
                    adoptedGeneration: committed.generation,
                    adoptedCredentialRevision: committed.credentialRevision ?? null,
                    reconciliationDisposition: 'superseded_after_apply',
                    ...generationApplyEvidenceFields(applyOutcome),
                    diagnostics: buildSwitchDecisionDiagnostics({ decisionTrace: selectedDecisionTrace }),
                };
            }
            this.emitSwitchResult({
                request: input,
                loaded: commitLoaded,
                resultStatus: 'switched',
                toProfileId: committed.activeProfileId ?? selectedProfileId,
                toGeneration: committed.generation,
                success: true,
                startedAtMs,
                mode: applyOutcome.mode,
                decisionTrace: selectedDecisionTrace,
            });
            return {
                status: 'switched',
                activeProfileId: committed.activeProfileId ?? selectedProfileId,
                generation: committed.generation,
                credentialRevision: applyOutcome.credentialRevision,
                ...generationApplyEvidenceFields(applyOutcome),
                diagnostics: buildSwitchDecisionDiagnostics({ decisionTrace: selectedDecisionTrace }),
            };
        } catch (error) {
            lease.fail(error);
            throw error;
        } finally {
            lease.finish();
        }
    }

    async applyCommittedGeneration(input: Readonly<{
        sessionId: string;
        serviceId: TServiceIdentity;
        groupId: string;
        activeProfileId: string;
        generation: number;
        credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
        reason: string;
    }>): Promise<Omit<ObservedGenerationApplyResult, 'reconciliationDisposition'> & ConnectedServiceCommittedGenerationApplyResult> {
        const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(typeof input.serviceId === 'string'
            ? input.serviceId : buildQualifiedPluginContributionKey(QualifiedConnectedAccountServiceRefSchema.parse(input.serviceId)));
        if (!serviceId) throw new Error('connected_service_auth_generation_service_id_invalid');
        // A delayed delivery consumes the current selection at native admission;
        // applying its old member could overwrite a successor already installed.
        const current = await this.deps.loadState(input);
        const target = current.activeProfileId && (current.generation > input.generation
            || (current.generation === input.generation && current.activeProfileId === input.activeProfileId
                && current.credentialRevision != null && input.credentialRevision != null
                && current.credentialRevision !== input.credentialRevision))
            ? { ...input, activeProfileId: current.activeProfileId, generation: current.generation,
                credentialRevision: current.credentialRevision }
            : input;
        const result = await this.applyObservedGeneration({
            sessionId: target.sessionId,
            serviceId: target.serviceId,
            groupId: target.groupId,
            activeProfileId: target.activeProfileId,
            generation: target.generation,
            ...(target.credentialRevision === undefined ? {} : { credentialRevision: target.credentialRevision }),
            reason: target.reason,
        });
        const requestedTarget = { serviceId, groupId: input.groupId, profileId: input.activeProfileId,
            generation: input.generation, credentialRevision: input.credentialRevision ?? null };
        if (result.status === 'superseded_after_apply') {
            if (!result.activeProfileId) return { ...result, reconciliationDisposition: 'failed', errorCode: 'superseded_authoritative_generation_missing' };
            if (result.generation === input.generation && input.credentialRevision != null && result.credentialRevision === null) {
                return { ...result, reconciliationDisposition: 'failed', errorCode: 'superseded_authoritative_revision_missing' };
            }
            const authoritativeTarget = { ...requestedTarget, profileId: result.activeProfileId, generation: result.generation,
                credentialRevision: result.credentialRevision };
            return { ...result, reconciliationDisposition: 'superseded_after_apply', errorCode: null,
                authoritativeGeneration: buildConnectedServiceAuthGroupCommittedGenerationFact({
                    decisionId: buildConnectedServiceAuthGroupTargetEpochIdentity(authoritativeTarget), provenance: 'reconciliation',
                    requestedTarget: { profileId: authoritativeTarget.profileId }, decisionCommittedTarget: authoritativeTarget,
                }) };
        }
        if (result.status !== 'observed_generation') {
            return result.errorCode === 'restart_disallowed_by_execution_policy'
                ? { ...result, reconciliationDisposition: 'deferred_restart', restartRequested: false }
                : { ...result, reconciliationDisposition: 'failed' };
        }
        const adopted = result.providerApplication === 'applied' && result.activeProfileId === input.activeProfileId
            && result.generation === input.generation
            ? readConnectedServiceProviderAdoptedGenerationTarget({ target: requestedTarget,
                verificationByServiceId: result.verificationByServiceId }) : null;
        if (!adopted) return { ...result, reconciliationDisposition: 'deferred_restart', errorCode: null,
            restartRequested: result.mode === 'restart_resume' };
        const credentialError = readConnectedServiceAccountApplicationCredentialError(adopted);
        return credentialError ? { ...result, reconciliationDisposition: 'failed', errorCode: credentialError }
            : { ...result, reconciliationDisposition: 'converged', errorCode: null, providerAdoptedTarget: adopted };
    }

    async switchBeforeTurn(input: Readonly<{
        signal?: AbortSignal;
        sessionId?: string;
        serviceId: TServiceIdentity;
        groupId: string;
        reason: 'usage_limit' | 'soft_threshold' | 'same_provider_account_exhausted' | 'auth_expired' | 'account_changed' | 'refresh_failed' | 'plan';
        /** Fresh launches may share the healthy active member; failures still switch away. */
        allowCurrentProfileRetry?: boolean;
        observedProfileId?: string | null;
        providerLimitId?: string | null;
        memberStateOverridesByProfileId?: ReadonlyArray<ConnectedServiceAuthGroupMemberRuntimeStateOverride>;
    }>): Promise<ConnectedServiceAuthGroupSwitchResult> {
        return await this.switchSelection(input, 'pre_turn');
    }
}
