import {
    hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason,
    selectConnectedServiceAuthGroupCandidate,
    type ConnectedServiceAuthGroupCandidateDecisionTrace,
    type ConnectedServiceAuthGroupMember,
    type ConnectedServiceAuthGroupMemberRuntimeState,
    type ConnectedServiceAuthGroupPolicyV1,
} from '../selection/selectConnectedServiceAuthGroupCandidate';
import { resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds } from '../selection/resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds';
import { readConnectedServiceAuthGenerationApplyFailure } from '../../runtimeAuth/connectedServiceAuthGenerationApplyFailure';
import type { AcceptedConnectedServiceAccountVerificationByServiceId } from '../../accountTransitions/acceptedConnectedServiceAccountVerification';
import { evaluatePredictiveSoftSwitchSessionApplyPolicy } from './predictiveSoftSwitchPolicy';
import type { ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol';

const WAITABLE_CLASSIFIED_FAILURE_REASONS: ReadonlySet<string> = new Set([
    'usage_limit',
    'rate_limit',
    'temporary_throttle',
]);

function shouldWaitForClassifiedFailure(input: Readonly<{
    reason: string;
    recoveryMode: ConnectedServiceAuthGroupPolicyV1['recoveryMode'];
}>): boolean {
    return WAITABLE_CLASSIFIED_FAILURE_REASONS.has(input.reason)
        && (input.recoveryMode === 'wait_until_reset' || input.recoveryMode === 'switch_or_wait');
}

export type ConnectedServiceAuthGroupSwitchState<
    TServiceIdentity = string,
> = Readonly<{
    serviceId: TServiceIdentity;
    groupId: string;
    activeProfileId: string | null;
    generation: number;
    runtimeStateRevision?: number;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    configurationRevision?: string | null;
    policy: ConnectedServiceAuthGroupPolicyV1;
    members: ReadonlyArray<ConnectedServiceAuthGroupMember>;
    memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
}>;

export type ConnectedServiceAuthGroupMemberRuntimeStateOverride = Readonly<{
    profileId: string;
    state: ConnectedServiceAuthGroupMemberRuntimeState;
}>;

type LeaseCompletion<TServiceIdentity = string> = Readonly<{
    serviceId: TServiceIdentity;
    groupId: string;
    activeProfileId: string | null;
    generation: number;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    decisionTrace?: ConnectedServiceAuthGroupCandidateDecisionTrace;
}>;

export type ConnectedServiceAuthGroupGenerationApplyInput<
    TServiceIdentity = string,
> = LeaseCompletion<TServiceIdentity> & Readonly<{
    sessionId?: string;
    reason?: string;
}>;

type LeaseResultCompletion = Readonly<{
    kind: 'result';
    activeProfileId: string | null;
    generation: number;
    result: ConnectedServiceAuthGroupSwitchResult;
}>;

type ConnectedServiceAccountSwitchMode = 'hot_apply' | 'restart_resume' | 'spawn_next_turn';

type ConnectedServiceGenerationApplyEvidence = Readonly<{
    providerApplication?: string;
    verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
}>;

function generationApplyEvidenceFields(input: ConnectedServiceGenerationApplyEvidence & Readonly<{
    mode?: ConnectedServiceAccountSwitchMode;
}>): ConnectedServiceGenerationApplyEvidence & Readonly<{ mode?: ConnectedServiceAccountSwitchMode }> {
    return {
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.providerApplication ? { providerApplication: input.providerApplication } : {}),
        ...(input.verificationByServiceId ? { verificationByServiceId: input.verificationByServiceId } : {}),
    };
}

type ConnectedServiceAuthGroupSwitchDecisionDiagnostics = Readonly<{
    decisionTrace: ConnectedServiceAuthGroupCandidateDecisionTrace;
}>;

type LeaseOutcome<TServiceIdentity = string> =
    | Readonly<{
        status: 'completed';
        completion: LeaseCompletion<TServiceIdentity>;
    }>
    | Readonly<{ status: 'completed_result'; completion: LeaseResultCompletion }>
    | Readonly<{ status: 'failed'; error: unknown }>;

type LeaseAcquireResult<TServiceIdentity = string> =
    | Readonly<{
        kind: 'owner';
        complete(completion: LeaseCompletion<TServiceIdentity>): void;
        completeResult(
            result: ConnectedServiceAuthGroupSwitchResult,
            context?: Readonly<{ activeProfileId: string | null; generation: number }>,
        ): void;
        finish(): void;
        fail(error: unknown): void;
    }>
    | Readonly<{
        kind: 'loser';
        waitForOwner(options?: Readonly<{ timeoutMs?: number }>): Promise<
            LeaseCompletion<TServiceIdentity> | LeaseResultCompletion
        >;
    }>;

export const SESSION_SWITCH_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function defaultServiceIdentityKey(serviceId: unknown): string {
    if (typeof serviceId === 'string') return `legacy:${JSON.stringify(serviceId)}`;
    return `qualified:${JSON.stringify(serviceId)}`;
}

function switchKey(
    serviceIdentityKey: string,
    groupId: string,
): string {
    return `${serviceIdentityKey}\0${groupId}`;
}

function normalizeProfileId(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function canRetryCurrentProfileForObservedProfile(input: Readonly<{
    reason: string;
    observedProfileId?: string | null;
    activeProfileId: string | null | undefined;
}>): boolean {
    if (input.reason !== 'soft_threshold') return false;
    const observedProfileId = normalizeProfileId(input.observedProfileId);
    const activeProfileId = normalizeProfileId(input.activeProfileId);
    return !observedProfileId || !activeProfileId || observedProfileId === activeProfileId;
}

function canRetryObservedProfileDuringPreTurnSelection(reason: string): boolean {
    return reason === 'soft_threshold';
}

function isLeaseResultCompletion<TServiceIdentity>(
    value: LeaseCompletion<TServiceIdentity> | LeaseResultCompletion,
): value is LeaseResultCompletion {
    return 'kind' in value && value.kind === 'result';
}

function buildLeaseResultCompletion(
    result: ConnectedServiceAuthGroupSwitchResult,
    context?: Readonly<{ activeProfileId: string | null; generation: number }>,
): LeaseResultCompletion {
    return {
        kind: 'result',
        activeProfileId: context?.activeProfileId ?? ('activeProfileId' in result ? result.activeProfileId : null),
        generation: context?.generation ?? result.generation,
        result,
    };
}

export class ConnectedServiceAuthGroupSwitchLeaseExpiredError extends Error {
    constructor() {
        super('connected_service_auth_group_switch_lease_expired');
    }
}

export class InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry<
    TServiceIdentity = string,
> {
    private readonly pendingByKey = new Map<string, {
        promise: Promise<LeaseOutcome<TServiceIdentity>>;
        resolve: (outcome: LeaseOutcome<TServiceIdentity>) => void;
        settled: boolean;
    }>();

    constructor(private readonly options: Readonly<{
        leaseTimeoutMs?: number;
        serviceIdentityKey?: (serviceId: TServiceIdentity) => string;
    }> = {}) {}

    acquire(input: Readonly<{
        serviceId: TServiceIdentity;
        groupId: string;
    }>): LeaseAcquireResult<TServiceIdentity> {
        const key = switchKey(
            this.options.serviceIdentityKey?.(input.serviceId)
                ?? defaultServiceIdentityKey(input.serviceId),
            input.groupId,
        );
        const pending = this.pendingByKey.get(key);
        if (pending) {
            return {
                kind: 'loser',
                waitForOwner: async (waitOptions) => {
                    const timeoutMs = waitOptions?.timeoutMs ?? this.options.leaseTimeoutMs ?? 30_000;
                    let timeout: ReturnType<typeof setTimeout> | null = null;
                    const outcome = await Promise.race([
                        pending.promise,
                        new Promise<LeaseOutcome<TServiceIdentity>>(
                            (_resolve, reject) => {
                            timeout = setTimeout(() => reject(new ConnectedServiceAuthGroupSwitchLeaseExpiredError()), timeoutMs);
                            timeout.unref?.();
                            },
                        ),
                    ]).finally(() => {
                        if (timeout) clearTimeout(timeout);
                    });
                    if (outcome.status === 'failed') throw outcome.error;
                    if (outcome.status === 'completed_result') return outcome.completion;
                    return outcome.completion;
                },
            };
        }

        let resolveCompletion: (
            outcome: LeaseOutcome<TServiceIdentity>,
        ) => void = () => {};
        const promise = new Promise<LeaseOutcome<TServiceIdentity>>((resolve) => {
            resolveCompletion = resolve;
        });
        const entry = { promise, resolve: resolveCompletion, settled: false };
        this.pendingByKey.set(key, entry);
        return {
            kind: 'owner',
            complete: (completion) => {
                const current = this.pendingByKey.get(key);
                if (current !== entry || entry.settled) return;
                entry.settled = true;
                current.resolve({ status: 'completed', completion });
            },
            completeResult: (result, context) => {
                const current = this.pendingByKey.get(key);
                if (current !== entry || entry.settled) return;
                entry.settled = true;
                current.resolve({ status: 'completed_result', completion: buildLeaseResultCompletion(result, context) });
            },
            finish: () => {
                if (this.pendingByKey.get(key) !== entry) return;
                this.pendingByKey.delete(key);
            },
            fail: (error) => {
                const current = this.pendingByKey.get(key);
                if (current !== entry) return;
                this.pendingByKey.delete(key);
                if (!entry.settled) {
                    entry.settled = true;
                    current.resolve({ status: 'failed', error });
                }
            },
        };
    }
}

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
        status: 'no_eligible_member';
        generation: number;
        groupExhausted: true;
        retryAtMs: number | null;
        excluded: ReadonlyArray<Readonly<{
            profileId: string;
            reason: string;
            retryAtMs?: number | null;
        }>>;
        diagnostics?: ConnectedServiceAuthGroupSwitchDecisionDiagnostics;
    }>
    | Readonly<{ status: 'manual_strategy'; generation: number }>
    | Readonly<{ status: 'auto_switch_disabled'; generation: number }>
    | Readonly<{ status: 'switch_reason_disabled'; generation: number }>
    | Readonly<{ status: 'switch_limit_reached'; generation: number }>
    | Readonly<{ status: 'stale_context'; generation: number }>;

export type ConnectedServiceAuthGroupExpectedFailureSource = Readonly<{
    profileId: string;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
    groupGeneration: number;
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

function isReasonEnabled(policy: ConnectedServiceAuthGroupPolicyV1, reason: string): boolean {
    switch (reason) {
        case 'usage_limit':
        case 'rate_limit':
        case 'capacity':
        case 'soft_threshold':
        case 'same_provider_account_exhausted':
            return policy.switchOn.usageLimit;
        case 'auth_expired':
        case 'permission_denied':
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
    profileId: string;
    reason: string;
    nowMs: number;
    quotaFreshnessMs: number;
    memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
    selected: ReturnType<typeof selectConnectedServiceAuthGroupCandidate>;
}>): boolean {
    return input.selected.selected?.profileId === input.profileId
        && hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
            reason: input.reason,
            profileId: input.profileId,
            nowMs: input.nowMs,
            quotaFreshnessMs: input.quotaFreshnessMs,
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
    private readonly switchTimestampsBySessionKey = new Map<string, number[]>();

    constructor(private readonly deps: Readonly<{
        leases: InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry<
            TServiceIdentity
        >;
        nowMs: () => number;
        quotaFreshnessMs: number;
        loadState(input: Readonly<{
            serviceId: TServiceIdentity;
            groupId: string;
        }>): Promise<ConnectedServiceAuthGroupSwitchState<TServiceIdentity>>;
        commitSwitch(input: Readonly<{
            serviceId: TServiceIdentity;
            groupId: string;
            fromProfileId: string | null;
            toProfileId: string;
            expectedGeneration: number;
            expectedRuntimeStateRevision?: number;
            expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
            expectedConfigurationRevision?: string | null;
            reason: string;
        }>): Promise<ConnectedServiceAuthGroupSwitchState<TServiceIdentity>>;
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
            planType?: string | null;
        }>): Promise<void>;
        probeQuotaSnapshotsForGroup?(input: Readonly<{
            serviceId: TServiceIdentity;
            groupId: string;
            profileIds: ReadonlyArray<string>;
            reason: string;
        }>): Promise<void>;
        resolveGenerationConflict?(error: unknown): number | null;
        emitEvent?: (
            event: ConnectedServiceAuthGroupSwitchEvent<TServiceIdentity>,
        ) => void;
    }>) {}

    private isExpectedFailureSourceCurrent(input: Readonly<{
        expectedFailureSource?: ConnectedServiceAuthGroupExpectedFailureSource;
    }>, state: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>): boolean {
        const expected = input.expectedFailureSource;
        if (!expected) return true;
        const expectedProfileId = normalizeProfileId(expected.profileId);
        return expectedProfileId !== null
            && state.generation === expected.groupGeneration
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

    private async probeQuotaSnapshotsBeforePreTurnSelection(input: Readonly<{
        request: Readonly<{
            serviceId: TServiceIdentity;
            groupId: string;
            reason: string;
        }>;
        loaded: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>;
        activeProfileId?: string | null;
        allowCurrentProfileRetry: boolean;
    }>): Promise<ConnectedServiceAuthGroupSwitchState<TServiceIdentity>> {
        if (!this.deps.probeQuotaSnapshotsForGroup) return input.loaded;
        const profileIds = resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds({
            activeProfileId: input.activeProfileId ?? input.loaded.activeProfileId,
            members: input.loaded.members,
            memberStatesByProfileId: input.loaded.memberStatesByProfileId,
            policy: input.loaded.policy,
            nowMs: this.deps.nowMs(),
            quotaFreshnessMs: this.deps.quotaFreshnessMs,
            allowCurrentProfileRetry: input.allowCurrentProfileRetry,
        });
        if (profileIds.length === 0) return input.loaded;
        await this.deps.probeQuotaSnapshotsForGroup({
            serviceId: input.request.serviceId,
            groupId: input.request.groupId,
            profileIds,
            reason: input.request.reason,
        });
        return await this.deps.loadState({
            serviceId: input.request.serviceId,
            groupId: input.request.groupId,
        });
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
        | (Readonly<{ failure: null; mode?: ConnectedServiceAccountSwitchMode }> & ConnectedServiceGenerationApplyEvidence)
        | Readonly<{ failure: Extract<
            ConnectedServiceAuthGroupSwitchResult,
            Readonly<{ status: 'generation_apply_failed' | 'predictive_apply_unavailable' }>
        > }>
    > {
        let applyResult: ConnectedServiceAuthGroupGenerationApplyResult | undefined;
        try {
            applyResult = await this.deps.applyGeneration(input);
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
        const revisionWasSuperseded = observedAfterApply.generation === input.generation
            && input.credentialRevision != null
            && observedAfterApply.credentialRevision != null
            && observedAfterApply.credentialRevision !== input.credentialRevision;
        if (observedAfterApply.generation > input.generation || revisionWasSuperseded) {
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
            credentialRevision: input.credentialRevision ?? null,
            ...generationApplyEvidenceFields(applyOutcome),
            ...(decisionTrace === undefined
                ? {}
                : { diagnostics: buildSwitchDecisionDiagnostics({ decisionTrace }) }),
        };
    }

    private async resolveStateAfterGenerationConflict(input: Readonly<{
        error: unknown;
        serviceId: TServiceIdentity;
        groupId: string;
        loaded: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>;
        sessionId?: string;
        reason?: string;
        observedProfileId?: string | null;
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
            nowMs: this.deps.nowMs(),
            quotaFreshnessMs: this.deps.quotaFreshnessMs,
            activeProfileId: failedProfileId,
            policy: observed.policy,
            members: observed.members,
            memberStatesByProfileId: observed.memberStatesByProfileId,
        });
        if (!isProfileEligibleForObservedGeneration({
            profileId: observedActiveProfileId,
            reason: input.reason ?? '',
            nowMs: this.deps.nowMs(),
            quotaFreshnessMs: this.deps.quotaFreshnessMs,
            memberStatesByProfileId: observed.memberStatesByProfileId,
            selected: observedGenerationSelection,
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
        serviceId: TServiceIdentity;
        groupId: string;
        loaded: ConnectedServiceAuthGroupSwitchState<TServiceIdentity>;
        sessionId?: string;
        reason: string;
        observedProfileId?: string | null;
        retryAtMs?: number | null;
        retryAfterMs?: number | null;
        resetsAtMs?: number | null;
        planType?: string | null;
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
                    error,
                    serviceId: input.serviceId,
                    groupId: input.groupId,
                    loaded,
                    sessionId: input.sessionId,
                    reason: input.reason,
                    observedProfileId: input.observedProfileId,
                    lease: input.lease,
                });
                if (!resolvedConflict) throw error;
                if (resolvedConflict.kind === 'observed_generation') return resolvedConflict;
                loaded = resolvedConflict.state;
            }
        }
    }

    private resolveSessionSwitchKey(input: Readonly<{
        sessionId?: string;
        serviceId: TServiceIdentity;
        groupId: string;
    }>): string | null {
        const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim()
            ? input.sessionId.trim()
            : null;
        return sessionId
            ? switchKey(
                `${sessionId}\0${defaultServiceIdentityKey(input.serviceId)}`,
                input.groupId,
            )
            : null;
    }

    private countRecentSessionSwitches(key: string, nowMs: number): number {
        const cutoffMs = nowMs - SESSION_SWITCH_LIMIT_WINDOW_MS;
        const recent = (this.switchTimestampsBySessionKey.get(key) ?? [])
            .filter((timestamp) => timestamp >= cutoffMs);
        this.switchTimestampsBySessionKey.set(key, recent);
        return recent.length;
    }

    private recordSessionSwitch(key: string | null, nowMs: number): void {
        if (!key) return;
        const cutoffMs = nowMs - SESSION_SWITCH_LIMIT_WINDOW_MS;
        const recent = (this.switchTimestampsBySessionKey.get(key) ?? [])
            .filter((timestamp) => timestamp >= cutoffMs);
        recent.push(nowMs);
        this.switchTimestampsBySessionKey.set(key, recent);
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

    async switchAfterClassifiedFailure(input: Readonly<{
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
        switchesThisTurn?: number;
        sessionSwitchesThisHour?: number;
        expectedFailureSource?: ConnectedServiceAuthGroupExpectedFailureSource;
    }>): Promise<ConnectedServiceAuthGroupSwitchResult> {
        const startedAtMs = this.deps.nowMs();
        const lease = this.deps.leases.acquire(input);
        if (lease.kind === 'loser') {
            let observed: LeaseCompletion<TServiceIdentity> | LeaseResultCompletion;
            let observedFromAuthoritativeReread = false;
            try {
                observed = await lease.waitForOwner();
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
                observed = {
                    serviceId: current.serviceId,
                    groupId: current.groupId,
                    activeProfileId: currentProfileId,
                    generation: current.generation,
                    ...(current.credentialRevision === undefined
                        ? {}
                        : { credentialRevision: current.credentialRevision }),
                };
                observedFromAuthoritativeReread = true;
            }
            if (input.expectedFailureSource && !observedFromAuthoritativeReread) {
                const current = await this.deps.loadState(input);
                if (!this.isExpectedFailureSourceCurrent(input, current)) {
                    return {
                        status: 'stale_context',
                        generation: current.generation,
                    };
                }
                if (
                    isLeaseResultCompletion(observed)
                    && observed.result.status === 'stale_context'
                ) {
                    return await this.switchAfterClassifiedFailure(input);
                }
            }
            if (isLeaseResultCompletion(observed)) {
                if (
                    observed.result.status !== 'predictive_apply_unavailable'
                    && observed.result.status !== 'stale_context'
                ) {
                    this.emitSwitchResult({
                        request: input,
                        loaded: observed,
                        resultStatus: observed.result.status,
                        toProfileId: observed.activeProfileId,
                        toGeneration: observed.generation,
                        success: false,
                        startedAtMs,
                        decisionTrace: readSwitchResultDecisionTrace(observed.result),
                    });
                }
                return observed.result;
            }
            if (
                normalizeProfileId(input.observedProfileId)
                && normalizeProfileId(input.observedProfileId) === normalizeProfileId(observed.activeProfileId)
            ) {
                return await this.switchAfterClassifiedFailure(input);
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
            let loaded = await this.deps.loadState(input);
            if (!this.isExpectedFailureSourceCurrent(input, loaded)) {
                return this.completeStaleFailureContext(lease, loaded);
            }
            const observedFailureOutcome: RecordObservedFailureStateOutcome<
                TServiceIdentity
            > = input.expectedFailureSource
                ? { kind: 'recorded', state: loaded }
                : await this.recordObservedFailureStateWithConflictRecovery({
                    serviceId: input.serviceId,
                    groupId: input.groupId,
                    loaded,
                    reason: input.reason,
                    observedProfileId: input.observedProfileId,
                    retryAtMs: input.retryAtMs,
                    retryAfterMs: input.retryAfterMs,
                    resetsAtMs: input.resetsAtMs,
                    planType: input.planType,
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
            if (observedProfileId && loadedActiveProfileId && loadedActiveProfileId !== observedProfileId) {
                selectionActiveProfileId = observedProfileId;
                loaded = await this.probeQuotaSnapshotsBeforePreTurnSelection({
                    request: input,
                    loaded,
                    activeProfileId: selectionActiveProfileId,
                    allowCurrentProfileRetry: false,
                });
                if (!this.isExpectedFailureSourceCurrent(input, loaded)) {
                    return this.completeStaleFailureContext(lease, loaded);
                }
                didProbeForSelection = true;
                const currentLoadedActiveProfileId = normalizeProfileId(loaded.activeProfileId);
                const observedGenerationSelection = selectConnectedServiceAuthGroupCandidate({
                    nowMs: this.deps.nowMs(),
                    quotaFreshnessMs: this.deps.quotaFreshnessMs,
                    activeProfileId: selectionActiveProfileId,
                    policy: loaded.policy,
                    members: loaded.members,
                    memberStatesByProfileId: loaded.memberStatesByProfileId,
                });
                if (
                    currentLoadedActiveProfileId
                    && currentLoadedActiveProfileId !== observedProfileId
                    && isProfileAdoptableForObservedDivergence({
                        profileId: currentLoadedActiveProfileId,
                        members: loaded.members,
                        selected: observedGenerationSelection,
                    })
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
                            decisionTrace: observedGenerationSelection.decisionTrace,
                        });
                        if (superseded) return superseded;
                        if (applyOutcome.failure.status === 'generation_apply_failed') {
                            this.emitSwitchResult({
                                request: input,
                                loaded,
                                resultStatus: 'generation_apply_failed',
                                toProfileId: loaded.activeProfileId,
                                toGeneration: loaded.generation,
                                success: false,
                                startedAtMs,
                                decisionTrace: observedGenerationSelection.decisionTrace,
                            });
                        }
                        return {
                            ...applyOutcome.failure,
                            diagnostics: mergeSwitchDecisionDiagnostics({
                                diagnostics: applyOutcome.failure.diagnostics,
                                decisionTrace: observedGenerationSelection.decisionTrace,
                            }),
                        };
                    }
                    this.emitSwitchResult({
                        request: input,
                        loaded,
                        resultStatus: 'observed_generation',
                        toProfileId: loaded.activeProfileId,
                        toGeneration: loaded.generation,
                        success: true,
                        startedAtMs,
                        mode: applyOutcome.mode,
                        decisionTrace: observedGenerationSelection.decisionTrace,
                    });
                    return {
                        status: 'observed_generation',
                        activeProfileId: loaded.activeProfileId,
                        generation: loaded.generation,
                        credentialRevision: loaded.credentialRevision ?? null,
                        ...generationApplyEvidenceFields(applyOutcome),
                        diagnostics: buildSwitchDecisionDiagnostics({
                            decisionTrace: observedGenerationSelection.decisionTrace,
                        }),
                    };
                }
                selectionActiveProfileId = currentLoadedActiveProfileId;
            }
            const waitForClassifiedFailure = shouldWaitForClassifiedFailure({
                reason: input.reason,
                recoveryMode: loaded.policy.recoveryMode,
            });
            if (loaded.policy.recoveryMode === 'off') {
                this.emitSwitchResult({
                    request: input,
                    loaded,
                    resultStatus: 'auto_switch_disabled',
                    toProfileId: loaded.activeProfileId,
                    toGeneration: loaded.generation,
                    success: false,
                    startedAtMs,
                });
                const result = { status: 'auto_switch_disabled', generation: loaded.generation } as const;
                lease.completeResult(result, loaded);
                return result;
            }
            if (!loaded.policy.autoSwitch) {
                if (waitForClassifiedFailure) {
                    const result = buildPolicyWaitUntilResetResult({
                        loaded,
                        retryAtMs: resolvePolicyRecoveryWaitRetryAtMs(input),
                    });
                    this.emitSwitchResult({
                        request: input,
                        loaded,
                        resultStatus: 'no_eligible_member',
                        toProfileId: null,
                        toGeneration: loaded.generation,
                        success: false,
                        startedAtMs,
                        decisionTrace: readSwitchResultDecisionTrace(result),
                    });
                    lease.completeResult(result, loaded);
                    return result;
                }
                this.emitSwitchResult({
                    request: input,
                    loaded,
                    resultStatus: 'auto_switch_disabled',
                    toProfileId: loaded.activeProfileId,
                    toGeneration: loaded.generation,
                    success: false,
                    startedAtMs,
                });
                const result = { status: 'auto_switch_disabled', generation: loaded.generation } as const;
                lease.completeResult(result, loaded);
                return result;
            }
            if (!isReasonEnabled(loaded.policy, input.reason)) {
                if (waitForClassifiedFailure) {
                    const result = buildPolicyWaitUntilResetResult({
                        loaded,
                        retryAtMs: resolvePolicyRecoveryWaitRetryAtMs(input),
                    });
                    this.emitSwitchResult({
                        request: input,
                        loaded,
                        resultStatus: 'no_eligible_member',
                        toProfileId: null,
                        toGeneration: loaded.generation,
                        success: false,
                        startedAtMs,
                        decisionTrace: readSwitchResultDecisionTrace(result),
                    });
                    lease.completeResult(result, loaded);
                    return result;
                }
                this.emitSwitchResult({
                    request: input,
                    loaded,
                    resultStatus: 'switch_reason_disabled',
                    toProfileId: loaded.activeProfileId,
                    toGeneration: loaded.generation,
                    success: false,
                    startedAtMs,
                });
                const result = { status: 'switch_reason_disabled', generation: loaded.generation } as const;
                lease.completeResult(result, loaded);
                return result;
            }
            if (loaded.policy.recoveryMode === 'wait_until_reset') {
                const result = buildPolicyWaitUntilResetResult({
                    loaded,
                    retryAtMs: resolvePolicyRecoveryWaitRetryAtMs(input),
                });
                this.emitSwitchResult({
                    request: input,
                    loaded,
                    resultStatus: 'no_eligible_member',
                    toProfileId: null,
                    toGeneration: loaded.generation,
                    success: false,
                    startedAtMs,
                    decisionTrace: readSwitchResultDecisionTrace(result),
                });
                lease.completeResult(result, loaded);
                return result;
            }
            const switchesThisTurn = typeof input.switchesThisTurn === 'number' && Number.isFinite(input.switchesThisTurn)
                ? Math.max(0, Math.trunc(input.switchesThisTurn))
                : 0;
            const sessionSwitchKey = this.resolveSessionSwitchKey(input);
            const hourlySwitchCount = typeof input.sessionSwitchesThisHour === 'number' && Number.isFinite(input.sessionSwitchesThisHour)
                ? Math.max(0, Math.trunc(input.sessionSwitchesThisHour))
                : sessionSwitchKey
                    ? this.countRecentSessionSwitches(sessionSwitchKey, this.deps.nowMs())
                    : 0;
            if (
                switchesThisTurn >= loaded.policy.maxSwitchesPerTurn
                || hourlySwitchCount >= loaded.policy.maxSwitchesPerSessionHour
            ) {
                this.emitSwitchResult({
                    request: input,
                    loaded,
                    resultStatus: 'switch_limit_reached',
                    toProfileId: null,
                    toGeneration: loaded.generation,
                    success: false,
                    startedAtMs,
                });
                const result = { status: 'switch_limit_reached', generation: loaded.generation } as const;
                lease.completeResult(result, loaded);
                return result;
            }
            if (!didProbeForSelection) {
                loaded = await this.probeQuotaSnapshotsBeforePreTurnSelection({
                    request: input,
                    loaded,
                    activeProfileId: selectionActiveProfileId,
                    allowCurrentProfileRetry: false,
                });
                if (!this.isExpectedFailureSourceCurrent(input, loaded)) {
                    return this.completeStaleFailureContext(lease, loaded);
                }
            }
            const selected = selectConnectedServiceAuthGroupCandidate({
                nowMs: this.deps.nowMs(),
                quotaFreshnessMs: this.deps.quotaFreshnessMs,
                activeProfileId: selectionActiveProfileId,
                policy: loaded.policy,
                members: loaded.members,
                memberStatesByProfileId: loaded.memberStatesByProfileId,
            });
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
                        serviceId: input.serviceId,
                        groupId: input.groupId,
                        fromProfileId: commitLoaded.activeProfileId,
                        toProfileId: selectedProfileId,
                        expectedGeneration: commitLoaded.generation,
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
                        error,
                        serviceId: input.serviceId,
                        groupId: input.groupId,
                        loaded: commitLoaded,
                        sessionId: input.sessionId,
                        reason: input.reason,
                        observedProfileId: input.observedProfileId,
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
                        const retrySelected = selectConnectedServiceAuthGroupCandidate({
                            nowMs: this.deps.nowMs(),
                            quotaFreshnessMs: this.deps.quotaFreshnessMs,
                            activeProfileId: commitSelectionActiveProfileId,
                            policy: commitLoaded.policy,
                            members: commitLoaded.members,
                            memberStatesByProfileId: commitLoaded.memberStatesByProfileId,
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
            const revisionWasSuperseded = observedAfterApply.generation === committed.generation
                && committed.credentialRevision != null
                && observedAfterApply.credentialRevision != null
                && observedAfterApply.credentialRevision !== committed.credentialRevision;
            if (observedAfterApply.generation > committed.generation || revisionWasSuperseded) {
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
            this.recordSessionSwitch(sessionSwitchKey, this.deps.nowMs());
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
                credentialRevision: committed.credentialRevision ?? null,
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
    }>): Promise<ObservedGenerationApplyResult> {
        return await this.applyObservedGeneration({
            sessionId: input.sessionId,
            serviceId: input.serviceId,
            groupId: input.groupId,
            activeProfileId: input.activeProfileId,
            generation: input.generation,
            ...(input.credentialRevision === undefined ? {} : { credentialRevision: input.credentialRevision }),
            reason: input.reason,
        });
    }

    async switchBeforeTurn(input: Readonly<{
        sessionId?: string;
        serviceId: TServiceIdentity;
        groupId: string;
        reason: 'usage_limit' | 'soft_threshold' | 'same_provider_account_exhausted' | 'auth_expired' | 'account_changed' | 'refresh_failed';
        observedProfileId?: string | null;
        switchesThisTurn?: number;
        sessionSwitchesThisHour?: number;
        memberStateOverridesByProfileId?: ReadonlyArray<ConnectedServiceAuthGroupMemberRuntimeStateOverride>;
    }>): Promise<ConnectedServiceAuthGroupSwitchResult> {
        const startedAtMs = this.deps.nowMs();
        const lease = this.deps.leases.acquire(input);
        if (lease.kind === 'loser') {
            const observed = await lease.waitForOwner();
            if (isLeaseResultCompletion(observed)) return observed.result;
            const observedResult = await this.applyObservedGeneration(this.buildSessionApplyInput({
                completion: observed,
                sessionId: input.sessionId,
                reason: input.reason,
            }), observed.decisionTrace);
            return observedResult;
        }

        try {
            let loaded = applyMemberStateOverrides({
                loaded: await this.deps.loadState(input),
                overrides: input.memberStateOverridesByProfileId,
            });
            if (!loaded.policy.autoSwitch) {
                const result = { status: 'auto_switch_disabled', generation: loaded.generation } as const;
                lease.completeResult(result);
                return result;
            }
            if (loaded.policy.recoveryMode === 'off') {
                const result = { status: 'auto_switch_disabled', generation: loaded.generation } as const;
                lease.completeResult(result);
                return result;
            }
            if (!isReasonEnabled(loaded.policy, input.reason)) {
                const result = { status: 'switch_reason_disabled', generation: loaded.generation } as const;
                lease.completeResult(result);
                return result;
            }
            if (loaded.policy.recoveryMode === 'wait_until_reset') {
                const result = buildPolicyWaitUntilResetResult({
                    loaded,
                    retryAtMs: null,
                });
                lease.completeResult(result);
                return result;
            }
            const switchesThisTurn = typeof input.switchesThisTurn === 'number' && Number.isFinite(input.switchesThisTurn)
                ? Math.max(0, Math.trunc(input.switchesThisTurn))
                : 0;
            const sessionSwitchKey = this.resolveSessionSwitchKey(input);
            const hourlySwitchCount = typeof input.sessionSwitchesThisHour === 'number' && Number.isFinite(input.sessionSwitchesThisHour)
                ? Math.max(0, Math.trunc(input.sessionSwitchesThisHour))
                : sessionSwitchKey
                    ? this.countRecentSessionSwitches(sessionSwitchKey, this.deps.nowMs())
                    : 0;
            if (
                switchesThisTurn >= loaded.policy.maxSwitchesPerTurn
                || hourlySwitchCount >= loaded.policy.maxSwitchesPerSessionHour
            ) {
                this.emitSwitchResult({
                    request: input,
                    loaded,
                    resultStatus: 'switch_limit_reached',
                    toProfileId: null,
                    toGeneration: loaded.generation,
                    success: false,
                    startedAtMs,
                });
                const result = { status: 'switch_limit_reached', generation: loaded.generation } as const;
                lease.completeResult(result);
                return result;
            }
            const allowCurrentProfileRetry = canRetryObservedProfileDuringPreTurnSelection(input.reason);
            loaded = applyMemberStateOverrides({
                loaded: await this.probeQuotaSnapshotsBeforePreTurnSelection({
                    request: input,
                    loaded,
                    allowCurrentProfileRetry,
                }),
                overrides: input.memberStateOverridesByProfileId,
            });
            const observedProfileId = normalizeProfileId(input.observedProfileId);
            const loadedActiveProfileId = normalizeProfileId(loaded.activeProfileId);
            if (observedProfileId && loadedActiveProfileId && loadedActiveProfileId !== observedProfileId) {
                const observedGenerationSelection = selectConnectedServiceAuthGroupCandidate({
                    nowMs: this.deps.nowMs(),
                    quotaFreshnessMs: this.deps.quotaFreshnessMs,
                    activeProfileId: observedProfileId,
                    policy: loaded.policy,
                    members: loaded.members,
                    memberStatesByProfileId: loaded.memberStatesByProfileId,
                    allowCurrentProfileRetry,
                });
                if (isProfileEligibleForObservedGeneration({
                    profileId: loadedActiveProfileId,
                    reason: input.reason,
                    nowMs: this.deps.nowMs(),
                    quotaFreshnessMs: this.deps.quotaFreshnessMs,
                    memberStatesByProfileId: loaded.memberStatesByProfileId,
                    selected: observedGenerationSelection,
                })) {
                    const completion = {
                        serviceId: input.serviceId,
                        groupId: input.groupId,
                        activeProfileId: loaded.activeProfileId,
                        generation: loaded.generation,
                        credentialRevision: loaded.credentialRevision,
                    };
                    lease.complete(completion);
                    return await this.applyObservedGeneration(this.buildSessionApplyInput({
                        completion,
                        sessionId: input.sessionId,
                        reason: input.reason,
                    }), observedGenerationSelection.decisionTrace);
                }
            }
            const allowLoadedActiveProfileRetry = canRetryCurrentProfileForObservedProfile({
                reason: input.reason,
                observedProfileId,
                activeProfileId: loaded.activeProfileId,
            });
            const selected = selectConnectedServiceAuthGroupCandidate({
                nowMs: this.deps.nowMs(),
                quotaFreshnessMs: this.deps.quotaFreshnessMs,
                activeProfileId: loaded.activeProfileId,
                policy: loaded.policy,
                members: loaded.members,
                memberStatesByProfileId: loaded.memberStatesByProfileId,
                allowCurrentProfileRetry: allowLoadedActiveProfileRetry,
            });
            if (!selected.selected) {
                if (selected.reason === 'manual_strategy') {
                    const result = { status: 'manual_strategy', generation: loaded.generation } as const;
                    lease.completeResult(result);
                    return result;
                }
                const result = {
                    status: 'no_eligible_member',
                    generation: loaded.generation,
                    groupExhausted: true,
                    retryAtMs: resolveEarliestRetryAtMs(selected.excluded),
                    excluded: selected.excluded,
                    diagnostics: buildSwitchDecisionDiagnostics({ decisionTrace: selected.decisionTrace }),
                } as const;
                lease.completeResult(result);
                return result;
            }
            if (selected.selected.profileId === loaded.activeProfileId && allowLoadedActiveProfileRetry) {
                const result = {
                    status: 'observed_generation',
                    activeProfileId: loaded.activeProfileId,
                    generation: loaded.generation,
                    credentialRevision: loaded.credentialRevision ?? null,
                } as const;
                lease.completeResult(result);
                return result;
            }

            let selectedProfileId = selected.selected.profileId;
            let commitLoaded = loaded;
            let committed: ConnectedServiceAuthGroupSwitchState<
                TServiceIdentity
            >;
            for (;;) {
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
                            decisionTrace: selected.decisionTrace,
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
                                decisionTrace: selected.decisionTrace,
                            });
                        }
                        lease.completeResult(result, {
                            activeProfileId: selectedProfileId,
                            generation: commitLoaded.generation + 1,
                        });
                        return result;
                    }
                    committed = await this.deps.commitSwitch({
                        serviceId: input.serviceId,
                        groupId: input.groupId,
                        fromProfileId: commitLoaded.activeProfileId,
                        toProfileId: selectedProfileId,
                        expectedGeneration: commitLoaded.generation,
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
                    const resolvedConflict = await this.resolveStateAfterGenerationConflict({
                        error,
                        serviceId: input.serviceId,
                        groupId: input.groupId,
                        loaded: commitLoaded,
                        sessionId: input.sessionId,
                        reason: input.reason,
                        lease,
                    });
                    if (resolvedConflict?.kind === 'observed_generation') return resolvedConflict.result;
                    if (resolvedConflict?.kind === 'retry') {
                        commitLoaded = applyMemberStateOverrides({
                            loaded: resolvedConflict.state,
                            overrides: input.memberStateOverridesByProfileId,
                        });
                        const retrySelected = selectConnectedServiceAuthGroupCandidate({
                            nowMs: this.deps.nowMs(),
                            quotaFreshnessMs: this.deps.quotaFreshnessMs,
                            activeProfileId: commitLoaded.activeProfileId,
                            policy: commitLoaded.policy,
                            members: commitLoaded.members,
                            memberStatesByProfileId: commitLoaded.memberStatesByProfileId,
                            allowCurrentProfileRetry: canRetryCurrentProfileForObservedProfile({
                                reason: input.reason,
                                observedProfileId: input.observedProfileId,
                                activeProfileId: commitLoaded.activeProfileId,
                            }),
                        });
                        if (!retrySelected.selected) {
                            if (retrySelected.reason === 'manual_strategy') {
                                const result = { status: 'manual_strategy', generation: commitLoaded.generation } as const;
                                lease.completeResult(result);
                                return result;
                            }
                            const result = {
                                status: 'no_eligible_member',
                                generation: commitLoaded.generation,
                                groupExhausted: true,
                                retryAtMs: resolveEarliestRetryAtMs(retrySelected.excluded),
                                excluded: retrySelected.excluded,
                                diagnostics: buildSwitchDecisionDiagnostics({ decisionTrace: retrySelected.decisionTrace }),
                            } as const;
                            lease.completeResult(result);
                            return result;
                        }
                        if (
                            retrySelected.selected.profileId === commitLoaded.activeProfileId
                            && canRetryCurrentProfileForObservedProfile({
                                reason: input.reason,
                                observedProfileId: input.observedProfileId,
                                activeProfileId: commitLoaded.activeProfileId,
                            })
                        ) {
                            const result = {
                                status: 'observed_generation',
                                activeProfileId: commitLoaded.activeProfileId,
                                generation: commitLoaded.generation,
                                credentialRevision: commitLoaded.credentialRevision ?? null,
                            } as const;
                            lease.completeResult(result);
                            return result;
                        }
                        selectedProfileId = retrySelected.selected.profileId;
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
                decisionTrace: selected.decisionTrace,
            };
            lease.complete(completion);
            const applyOutcome = await this.applyGeneration(this.buildSessionApplyInput({
                completion,
                sessionId: input.sessionId,
                reason: input.reason,
            }));
            if (applyOutcome.failure) {
                if (applyOutcome.failure.status === 'generation_apply_failed') {
                    this.emitSwitchResult({
                        request: input,
                        loaded: commitLoaded,
                        resultStatus: 'generation_apply_failed',
                        toProfileId: committed.activeProfileId ?? selectedProfileId,
                                toGeneration: committed.generation,
                                success: false,
                                startedAtMs,
                                decisionTrace: selected.decisionTrace,
                            });
                        }
                return {
                    ...applyOutcome.failure,
                    diagnostics: mergeSwitchDecisionDiagnostics({
                        diagnostics: applyOutcome.failure.diagnostics,
                        decisionTrace: selected.decisionTrace,
                    }),
                };
            }
            const observedAfterApply = await this.deps.loadState({ serviceId: input.serviceId, groupId: input.groupId });
            const revisionWasSuperseded = observedAfterApply.generation === committed.generation
                && committed.credentialRevision != null
                && observedAfterApply.credentialRevision != null
                && observedAfterApply.credentialRevision !== committed.credentialRevision;
            if (observedAfterApply.generation > committed.generation || revisionWasSuperseded) {
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
                    diagnostics: buildSwitchDecisionDiagnostics({ decisionTrace: selected.decisionTrace }),
                };
            }
            this.recordSessionSwitch(sessionSwitchKey, this.deps.nowMs());
            this.emitSwitchResult({
                request: input,
                loaded: commitLoaded,
                resultStatus: 'switched',
                toProfileId: committed.activeProfileId ?? selectedProfileId,
                toGeneration: committed.generation,
                success: true,
                startedAtMs,
                mode: applyOutcome.mode,
                decisionTrace: selected.decisionTrace,
            });
            return {
                status: 'switched',
                activeProfileId: committed.activeProfileId ?? selectedProfileId,
                generation: committed.generation,
                credentialRevision: committed.credentialRevision ?? null,
                ...generationApplyEvidenceFields(applyOutcome),
                diagnostics: buildSwitchDecisionDiagnostics({ decisionTrace: selected.decisionTrace }),
            };
        } catch (error) {
            lease.fail(error);
            throw error;
        } finally {
            lease.finish();
        }
    }
}
