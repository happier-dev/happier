import type { ConnectedServiceAuthGroupSwitchCoordinator } from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import type { ConnectedServiceRuntimeFailureClassification } from './types';
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

type SwitchCoordinatorLike = Pick<ConnectedServiceAuthGroupSwitchCoordinator, 'switchAfterClassifiedFailure'>;
type TemporaryThrottleRecoveryLike = Readonly<{
    enable(input: Readonly<{
        sessionId: string;
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
    selection: RuntimeSelection | null;
    classification: ConnectedServiceRuntimeFailureClassification | null;
    switchesThisTurn: number;
    sessionSwitchesThisHour?: number;
    switchCoordinator: SwitchCoordinatorLike;
    temporaryThrottleRecovery?: TemporaryThrottleRecoveryLike | null;
}>): Promise<
    | Readonly<{ status: 'not_classified' }>
    | Readonly<{ status: 'not_group_selection' }>
    | Readonly<{ status: 'selection_mismatch' }>
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
        if (!input.sessionId) {
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
            sessionId: input.sessionId,
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
            sessionId: input.sessionId,
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

    const result = await input.switchCoordinator.switchAfterClassifiedFailure({
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        serviceId: input.selection.serviceId,
        groupId: input.selection.groupId,
        reason: input.classification.kind,
        observedProfileId: input.classification.profileId ?? input.selection.activeProfileId,
        retryAfterMs: input.classification.retryAfterMs,
        resetsAtMs: input.classification.resetsAtMs,
        limitCategory: input.classification.limitCategory,
        quotaScope: input.classification.quotaScope,
        providerLimitId: input.classification.providerLimitId,
        action: input.classification.action,
        planType: input.classification.planType,
        switchesThisTurn: input.switchesThisTurn,
        sessionSwitchesThisHour: input.sessionSwitchesThisHour,
    });
    return { status: 'switch_attempted', result };
}
