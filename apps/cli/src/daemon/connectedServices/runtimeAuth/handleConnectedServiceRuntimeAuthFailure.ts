import type { ConnectedServiceAuthGroupSwitchCoordinator } from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import type { ConnectedServiceRuntimeFailureClassification } from './types';
import type { ConnectedServiceDaemonAuthBridgeRefreshResult } from '../daemonAuthBridgeTypes';
import { connectedServiceRecoveryScopeKey, type ConnectedServiceRecoveryScope, type ConnectedServiceRuntimeTarget } from '../runtimeRegistry/target';
import type { ConnectedServiceTemporaryThrottleRetryScheduler, ConnectedServiceTemporaryThrottleContinuationIntent } from './temporaryThrottleRetryScheduler';
import { continueConnectedServiceRecoveryForScope } from '../continuation/continuationResumePrompt';
import { resolveRuntimeAuthRecoveryResultDisposition } from './resolveRuntimeAuthRecoveryResultDisposition';
import {
    decideConnectedServiceRecovery,
    type ConnectedServiceRecoveryPolicyDecision,
} from './ConnectedServiceRecoveryPolicy';

type RuntimeSelection =
    | Readonly<{
        kind: 'profile';
        serviceId: string;
        profileId: string;
    }>
    | Readonly<{
        kind: 'group';
        serviceId: string;
        groupId: string;
        activeProfileId: string;
    }>;

/** A binding is supplied only by the scope's existing runtime authority. */
export function applyConnectedServiceRuntimeAuthFailureSourceBinding(
    classification: ConnectedServiceRuntimeFailureClassification,
    binding: Readonly<{ serviceId: string; profileId: string; groupId: string | null; generation: number | null;
        credentialRevision: ConnectedServiceRuntimeFailureClassification['expectedCredentialRevision'] }>,
): ConnectedServiceRuntimeFailureClassification {
    return { ...classification, serviceId: binding.serviceId, profileId: binding.profileId, groupId: binding.groupId,
        groupGeneration: binding.generation, expectedCredentialRevision: binding.credentialRevision };
}

export function readConnectedServiceRuntimeAuthFailureSourceBinding(target: ConnectedServiceRuntimeTarget, serviceId: string) {
    const binding = target.activeBindings.find((candidate) => candidate.serviceId === serviceId);
    return binding ? { serviceId: binding.serviceId, groupId: binding.groupId, profileId: binding.profileId,
        generation: binding.groupGeneration, credentialRevision: binding.credentialRevision } : null;
}

type SwitchCoordinatorLike = Pick<ConnectedServiceAuthGroupSwitchCoordinator, 'switchAfterClassifiedFailure'>;
type TemporaryThrottleRecoveryLike = Readonly<{
    enable(input: Readonly<{
        sessionId: string;
        scope?: ConnectedServiceRecoveryScope;
        issueFingerprint: string;
        retryAfterMs?: number | null;
        resetAtMs?: number | null;
        serviceId: string;
        profileId: string | null;
        groupId: string | null;
    }>): Promise<Readonly<{
        status: string;
        nextRetryAtMs: number | null;
        attemptCount: number;
        maxAttempts?: number;
    }>>;
}>;

/** Credential preparation precedes pool policy for both authoritative runtime scopes. */
export async function prepareConnectedServiceRuntimeCredentialRecovery<Refresh extends Readonly<{ status: string; runtimeAuthDisposition?: string }>, Result>(input: Readonly<{
    scope: ConnectedServiceRecoveryScope;
    classification: ConnectedServiceRuntimeFailureClassification;
    activeProfileId: string | null;
    refresh?: ((scope: ConnectedServiceRecoveryScope) => Promise<Refresh>) | null;
    onRefreshed: (refresh: Refresh, scope: ConnectedServiceRecoveryScope, activeProfileId: string) => Promise<Result>;
}>): Promise<Readonly<{ status: 'prepared'; result: Result }> | Readonly<{ status: 'policy'; refreshFailed: boolean }>> {
    if (input.classification.kind !== 'auth_expired' || !input.activeProfileId || !input.refresh) return { status: 'policy', refreshFailed: false };
    const refresh = await input.refresh(input.scope);
    // A refresh whose member was superseded must use ordinary current group adoption.
    if (refresh.runtimeAuthDisposition === 'superseded_by_current_group') return { status: 'policy', refreshFailed: false };
    if (refresh.status === 'refreshed') return { status: 'prepared', result: await input.onRefreshed(refresh, input.scope, input.activeProfileId) };
    return { status: 'policy', refreshFailed: true };
}

type RuntimeRecoveryActionRequired = Readonly<{
    status: 'recovery_action_required';
    action: Readonly<{
        kind: 'reconnect_profile' | 'profile_action_required' | 'provider_state_sharing_required' | 'connected_service_required';
        serviceId: string;
        profileId: string | null;
        groupId: string | null;
        reason: ConnectedServiceRuntimeFailureClassification['kind'];
    }>;
}>;

function mapRecoveryDecisionToActionRequired(input: Readonly<{
    decision: ConnectedServiceRecoveryPolicyDecision;
    classification: ConnectedServiceRuntimeFailureClassification;
}>): RuntimeRecoveryActionRequired | null {
    const decision = input.decision;
    if (
        decision.action !== 'reconnect_required'
        && decision.action !== 'profile_action_required'
        && decision.action !== 'connected_service_required'
        && decision.action !== 'shared_state_required'
    ) return null;

    return {
        status: 'recovery_action_required',
        action: {
            kind: decision.action === 'reconnect_required'
                ? 'reconnect_profile'
                : decision.action === 'shared_state_required'
                    ? 'provider_state_sharing_required'
                    : decision.action,
            serviceId: decision.serviceId,
            profileId: decision.profileId,
            groupId: decision.groupId,
            reason: input.classification.kind,
        },
    };
}

function readTemporaryThrottleProfileId(input: Readonly<{
    selection: RuntimeSelection | null;
    classification: ConnectedServiceRuntimeFailureClassification;
}>): string | null {
    if (input.classification.profileId) return input.classification.profileId;
    if (input.selection?.kind === 'profile') return input.selection.profileId;
    if (input.selection?.kind === 'group') return input.selection.activeProfileId;
    return null;
}

function readTemporaryThrottleGroupId(input: Readonly<{
    selection: RuntimeSelection | null;
    classification: ConnectedServiceRuntimeFailureClassification;
}>): string | null {
    if (input.classification.groupId) return input.classification.groupId;
    if (input.selection?.kind === 'group') return input.selection.groupId;
    return null;
}

function temporaryRetryUnavailable(input: Readonly<{
    sessionId?: string;
    serviceId: string;
    profileId: string | null;
    groupId: string | null;
    retryAfterMs: number | null;
    resetAtMs: number | null;
    reason: 'session_id_missing' | 'session_unavailable' | 'scheduler_unavailable' | 'manual_retry_required';
}>): RuntimeTemporaryRetryUnavailable {
    return {
        status: 'temporary_retry_unavailable',
        sessionId: input.sessionId ?? '',
        serviceId: input.serviceId,
        profileId: input.profileId,
        groupId: input.groupId,
        attemptCount: 0,
        maxAttempts: 0,
        reason: input.reason,
        retryAfterMs: input.retryAfterMs,
        retryAtMs: null,
        resetAtMs: input.resetAtMs,
    };
}

type RuntimeTemporaryRetryUnavailable = Readonly<{
    status: 'temporary_retry_unavailable';
    sessionId: string;
    serviceId: string;
    profileId: string | null;
    groupId: string | null;
    attemptCount: 0;
    maxAttempts: 0;
    reason: 'session_id_missing' | 'session_unavailable' | 'scheduler_unavailable' | 'manual_retry_required';
    retryAfterMs: number | null;
    retryAtMs: null;
    resetAtMs: number | null;
}>;

type RuntimeTemporaryRetryArmed = Readonly<{
    status: 'temporary_retry_armed';
    sessionId: string;
    serviceId: string;
    profileId: string | null;
    groupId: string | null;
    attemptCount: number;
    maxAttempts: number;
    retryAfterMs: number | null;
    retryAtMs: number | null;
    resetAtMs: number | null;
    recovery: Awaited<ReturnType<TemporaryThrottleRecoveryLike['enable']>>;
}>;

function normalizeFingerprintPart(value: string | null | undefined, fallback: string): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : fallback;
}

function buildTemporaryThrottleIssueFingerprint(input: Readonly<{
    kind: ConnectedServiceRuntimeFailureClassification['kind'];
    serviceId: string;
    profileId: string | null;
    groupId: string | null;
}>): string {
    return [
        input.kind === 'temporary_throttle'
            ? 'temporary-throttle'
            : `temporary-retry:${input.kind}`,
        normalizeFingerprintPart(input.serviceId, 'unknown-service'),
        normalizeFingerprintPart(input.groupId, 'no-group'),
        normalizeFingerprintPart(input.profileId, 'no-profile'),
    ].join(':');
}

export async function handleConnectedServiceRuntimeAuthFailure(input: Readonly<{
    sessionId?: string;
    scope?: ConnectedServiceRecoveryScope;
    selection: RuntimeSelection | null;
    classification: ConnectedServiceRuntimeFailureClassification | null;
    switchesThisTurn?: number;
    allowCurrentProfileRetry?: boolean;
    expectedFailureSource?: Parameters<SwitchCoordinatorLike['switchAfterClassifiedFailure']>[0]['expectedFailureSource'];
    switchCoordinator: SwitchCoordinatorLike | null;
    temporaryThrottleRecovery?: TemporaryThrottleRecoveryLike | null;
}>): Promise<
    | Readonly<{ status: 'not_classified' }>
    | Readonly<{ status: 'not_group_selection' }>
    | Readonly<{ status: 'selection_mismatch' }>
    | Readonly<{ status: 'switch_coordinator_unavailable'; blocker: 'CLI has no connected-service auth-group load/commit API in this branch.' }>
    | RuntimeRecoveryActionRequired
    | RuntimeTemporaryRetryArmed
    | RuntimeTemporaryRetryUnavailable
    | Readonly<{
        status: 'switch_attempted';
        result: Awaited<ReturnType<SwitchCoordinatorLike['switchAfterClassifiedFailure']>>;
    }>
> {
    if (!input.classification) return { status: 'not_classified' };
    const recoveryDecision = decideConnectedServiceRecovery({
        actor: 'automatic',
        issue: input.classification,
        selection: input.selection,
    });
    if (recoveryDecision.action === 'no_op') return { status: 'not_classified' };
    if (recoveryDecision.action === 'temporary_retry') {
        const profileId = readTemporaryThrottleProfileId({
            selection: input.selection,
            classification: input.classification,
        });
        const groupId = readTemporaryThrottleGroupId({
            selection: input.selection,
            classification: input.classification,
        });
        const retryAfterMs = input.classification.retryAfterMs ?? null;
        const resetAtMs = input.classification.resetsAtMs;
        const recoveryKey = input.scope ? connectedServiceRecoveryScopeKey(input.scope) : input.sessionId;
        if (!recoveryKey) {
            return temporaryRetryUnavailable({
                serviceId: input.classification.serviceId,
                profileId,
                groupId,
                retryAfterMs,
                resetAtMs,
                reason: 'session_id_missing',
            });
        }
        if (!input.temporaryThrottleRecovery) {
            return temporaryRetryUnavailable({
                sessionId: input.sessionId,
                serviceId: input.classification.serviceId,
                profileId,
                groupId,
                retryAfterMs,
                resetAtMs,
                reason: 'scheduler_unavailable',
            });
        }
        const recovery = await input.temporaryThrottleRecovery.enable({
            sessionId: recoveryKey,
            ...(input.scope ? { scope: input.scope } : {}),
            serviceId: input.classification.serviceId,
            profileId,
            groupId,
            issueFingerprint: buildTemporaryThrottleIssueFingerprint({
                kind: input.classification.kind,
                serviceId: input.classification.serviceId,
                profileId,
                groupId,
            }),
            retryAfterMs,
            resetAtMs,
        });
        if (recovery.status === 'unsupported') {
            return temporaryRetryUnavailable({
                sessionId: input.sessionId,
                serviceId: input.classification.serviceId,
                profileId,
                groupId,
                retryAfterMs,
                resetAtMs,
                reason: 'scheduler_unavailable',
            });
        }
        return {
            status: 'temporary_retry_armed',
            sessionId: input.sessionId ?? '',
            serviceId: input.classification.serviceId,
            profileId,
            groupId,
            attemptCount: recovery.attemptCount,
            maxAttempts: typeof recovery.maxAttempts === 'number' ? recovery.maxAttempts : 0,
            retryAfterMs,
            retryAtMs: recovery.nextRetryAtMs,
            resetAtMs,
            recovery,
        };
    }
    const actionRequired = mapRecoveryDecisionToActionRequired({
        decision: recoveryDecision,
        classification: input.classification,
    });
    if (
        actionRequired
        && (
            input.selection?.kind === 'profile'
            || actionRequired.action.kind === 'provider_state_sharing_required'
        )
    ) {
        return actionRequired;
    }
    if (!input.selection || input.selection.kind !== 'group') return { status: 'not_group_selection' };
    if (
        input.selection.serviceId !== input.classification.serviceId
        || input.selection.groupId !== input.classification.groupId
    ) {
        return { status: 'selection_mismatch' };
    }

    if (!input.switchCoordinator) {
        return { status: 'switch_coordinator_unavailable', blocker: 'CLI has no connected-service auth-group load/commit API in this branch.' };
    }
    const result = await input.switchCoordinator.switchAfterClassifiedFailure({
        ...(input.scope?.kind !== 'run' && input.sessionId ? { sessionId: input.sessionId } : {}),
        serviceId: input.selection.serviceId,
        groupId: input.selection.groupId,
        reason: input.classification.kind,
        observedProfileId: input.classification.profileId,
        retryAfterMs: input.classification.retryAfterMs,
        resetsAtMs: input.classification.resetsAtMs,
        limitCategory: input.classification.limitCategory,
        quotaScope: input.classification.quotaScope,
        providerLimitId: input.classification.providerLimitId,
        action: input.classification.action,
        planType: input.classification.planType,
        ...(input.expectedFailureSource ? { expectedFailureSource: input.expectedFailureSource } : {}),
        ...(input.allowCurrentProfileRetry === undefined
            ? {}
            : { allowCurrentProfileRetry: input.allowCurrentProfileRetry }),
    });
    return { status: 'switch_attempted', result };
}

/** Consumes the shared policy and scheduler for a retained runtime continuation. */
export async function recoverConnectedServiceRuntimeFailure(input: Readonly<{
    scope: Extract<ConnectedServiceRecoveryScope, { kind: 'run' }>;
    selection: RuntimeSelection;
    classification: ConnectedServiceRuntimeFailureClassification;
    switchesThisTurn?: number;
    switchCoordinator: SwitchCoordinatorLike;
    temporaryThrottleScheduler: Pick<ConnectedServiceTemporaryThrottleRetryScheduler, 'waitForRecovery' | 'enable'>;
    continuation: ConnectedServiceTemporaryThrottleContinuationIntent;
    signal: AbortSignal;
    isCurrent(): boolean;
    nowMs(): number;
    onRecoveryWaiting?: (recovery: import('@happier-dev/protocol').SessionUsageLimitRecoveryV1) => void;
    refreshCredential?: () => Promise<ConnectedServiceDaemonAuthBridgeRefreshResult>;
}>): Promise<Readonly<{ status: 'continue'; input: string; rematerialize: boolean }> | Readonly<{ status: 'failed'; reason: string }>> {
    if (!input.isCurrent() || input.signal.aborted) return { status: 'failed', reason: 'runtime_recovery_stale' };
    const schedulerInput = (timing: Readonly<{ issueFingerprint: string; retryAfterMs?: number | null; resetAtMs?: number | null }>) => ({
        ...timing, scope: input.scope, continuation: input.continuation,
        serviceId: input.selection.serviceId,
        profileId: input.selection.kind === 'group' ? input.selection.activeProfileId : input.selection.profileId,
        groupId: input.selection.kind === 'group' ? input.selection.groupId : null,
    });
    const arm = async (timing: Parameters<typeof schedulerInput>[0]) => await input.temporaryThrottleScheduler.enable({
        ...schedulerInput(timing), sessionId: connectedServiceRecoveryScopeKey(input.scope),
    });
    const wait = async (timing: Parameters<typeof schedulerInput>[0]) => {
        const outcome = await input.temporaryThrottleScheduler.waitForRecovery(schedulerInput(timing), input.signal, input.onRecoveryWaiting);
        return outcome.status === 'resumed' && input.isCurrent() && !input.signal.aborted;
    };
    let rematerialize = false;
    let failureReason = 'runtime_recovery_stale';
    const continuation = await continueConnectedServiceRecoveryForScope({ ...input.continuation,
        scope: input.scope, interruption: 'provider_failed_turn',
        prepare: async ({ continuationEnabled }) => {
            const credential = await prepareConnectedServiceRuntimeCredentialRecovery({ scope: input.scope, classification: input.classification,
                activeProfileId: input.selection.kind === 'group' ? input.selection.activeProfileId : input.selection.profileId,
                refresh: input.refreshCredential,
                onRefreshed: async (refresh) => ({ status: 'credential_refreshed' as const, refresh }),
            });
            const result = credential.status === 'prepared' ? credential.result : await handleConnectedServiceRuntimeAuthFailure({ ...input,
                temporaryThrottleRecovery: { enable: async (timing) => continuationEnabled ? ({
                    status: await wait(timing) ? 'resumed' : 'unsupported', nextRetryAtMs: null, attemptCount: 0,
                }) : await arm(timing) },
            });
            const disposition = resolveRuntimeAuthRecoveryResultDisposition({ result,
                classificationProfileId: input.classification.profileId,
                classificationFailureKind: input.classification.kind, classificationResetsAtMs: input.classification.resetsAtMs,
                nowMs: input.nowMs() });
            if (disposition?.kind === 'durable_wait') {
                failureReason = 'runtime_recovery_cancelled';
                const timing = { issueFingerprint: `runtime-wait:${input.classification.serviceId}:${input.classification.groupId}:${input.continuation.interruptedOriginId}`,
                    resetAtMs: disposition.nextRetryAtMs };
                if (continuationEnabled) {
                    if (!await wait(timing)) return false;
                } else await arm(timing);
                rematerialize = true;
            } else if (disposition?.kind === 'local_completion') rematerialize = disposition.targetChanged;
            else if (disposition?.kind === 'temporary_retry_handoff'
                && (disposition.ready || (!continuationEnabled && disposition.status === 'temporary_retry_armed'))) rematerialize = false;
            else if (disposition?.kind !== 'provider_outcome_proven') {
                failureReason = disposition?.kind === 'terminal' ? disposition.reason : result.status;
                return false;
            }
            return input.isCurrent() && !input.signal.aborted;
        },
        deliver: async ({ prompt }) => ({ status: 'continue' as const, input: prompt, rematerialize }),
    });
    return continuation.status === 'delivered' ? continuation.value : {
        status: 'failed', reason: continuation.status === 'disabled' ? 'continuation_disabled' : failureReason,
    };
}
