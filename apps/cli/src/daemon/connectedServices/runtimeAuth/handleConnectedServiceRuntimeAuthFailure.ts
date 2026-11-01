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
    serviceId?: string;
    profileId?: string | null;
    groupId?: string | null;
    retryAfterMs?: number | null;
    resetAtMs?: number | null;
  }>): Promise<Readonly<{
    status: string;
    nextRetryAtMs: number | null;
    attemptCount: number;
  }>>;
}>;

type RuntimeRecoveryActionRequired = Readonly<{
  status: 'recovery_action_required';
  action: Readonly<{
    kind: 'reconnect_profile' | 're_resolve_binding' | 'profile_action_required' | 'provider_state_sharing_required' | 'connected_service_required';
    serviceId: string;
    profileId: string | null;
    groupId: string | null;
    reason: ConnectedServiceRuntimeFailureClassification['kind'];
  }>;
}>;

type RuntimeTemporaryRetryArmed = Readonly<{
  status: 'temporary_retry_armed';
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  retryAfterMs: number | null;
  resetAtMs: number | null;
  recovery: Awaited<ReturnType<TemporaryThrottleRecoveryLike['enable']>>;
}>;

type RuntimeTemporaryRetryUnavailable = Readonly<{
  status: 'temporary_retry_unavailable';
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  retryAfterMs: number | null;
  resetAtMs: number | null;
  reason: 'session_id_missing' | 'scheduler_unavailable' | 'manual_retry_required';
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
    && decision.action !== 're_resolve_binding'
  ) return null;

  return {
    status: 'recovery_action_required',
    action: {
      kind: decision.action === 'reconnect_required'
        ? 'reconnect_profile'
        : decision.action === 'shared_state_required'
        ? 'provider_state_sharing_required'
        : decision.action === 're_resolve_binding'
        ? 're_resolve_binding'
        : decision.action,
      serviceId: decision.serviceId,
      profileId: decision.profileId,
      groupId: decision.groupId,
      reason: input.classification.kind,
    },
  };
}

function normalizeFingerprintPart(value: string | null | undefined, fallback: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : fallback;
}

function buildTemporaryThrottleIssueFingerprint(
  decision: Extract<ConnectedServiceRecoveryPolicyDecision, Readonly<{ action: 'temporary_retry' }>>,
): string {
  return [
    'temporary-throttle',
    normalizeFingerprintPart(decision.serviceId, 'unknown-service'),
    normalizeFingerprintPart(decision.groupId, 'no-group'),
    normalizeFingerprintPart(decision.profileId, 'no-profile'),
  ].join(':');
}

export async function handleConnectedServiceRuntimeAuthFailure(input: Readonly<{
  sessionId?: string;
  selection: RuntimeSelection | null;
  classification: ConnectedServiceRuntimeFailureClassification | null;
  switchesThisTurn: number;
  sessionSwitchesThisHour?: number;
  allowCurrentProfileRetry?: boolean;
  switchCoordinator: SwitchCoordinatorLike;
  temporaryThrottleRecovery?: TemporaryThrottleRecoveryLike | null;
}>): Promise<
  | Readonly<{ status: 'not_classified' }>
  | RuntimeRecoveryActionRequired
  | RuntimeTemporaryRetryArmed
  | RuntimeTemporaryRetryUnavailable
  | Readonly<{ status: 'selection_mismatch' }>
  | Readonly<{
      status: 'switch_attempted';
      result: Awaited<ReturnType<SwitchCoordinatorLike['switchAfterClassifiedFailure']>>;
    }>
> {
  if (!input.classification) return { status: 'not_classified' };
  const decision = decideConnectedServiceRecovery({
    actor: 'automatic',
    issue: input.classification,
    selection: input.selection,
  });
  const actionRequired = mapRecoveryDecisionToActionRequired({
    decision,
    classification: input.classification,
  });
  if (actionRequired) return actionRequired;

  if (decision.action === 'temporary_retry') {
    if (!input.sessionId) {
      return {
        status: 'temporary_retry_unavailable',
        serviceId: decision.serviceId,
        profileId: decision.profileId,
        groupId: decision.groupId,
        retryAfterMs: decision.retryAfterMs,
        resetAtMs: decision.resetAtMs,
        reason: 'session_id_missing',
      };
    }
    if (!input.temporaryThrottleRecovery) {
      return {
        status: 'temporary_retry_unavailable',
        serviceId: decision.serviceId,
        profileId: decision.profileId,
        groupId: decision.groupId,
        retryAfterMs: decision.retryAfterMs,
        resetAtMs: decision.resetAtMs,
        reason: 'scheduler_unavailable',
      };
    }
    const recovery = await input.temporaryThrottleRecovery.enable({
      sessionId: input.sessionId,
      issueFingerprint: buildTemporaryThrottleIssueFingerprint(decision),
      serviceId: decision.serviceId,
      profileId: decision.profileId,
      groupId: decision.groupId,
      retryAfterMs: decision.retryAfterMs,
      resetAtMs: decision.resetAtMs,
    });
    return {
      status: 'temporary_retry_armed',
      serviceId: decision.serviceId,
      profileId: decision.profileId,
      groupId: decision.groupId,
      retryAfterMs: decision.retryAfterMs,
      resetAtMs: decision.resetAtMs,
      recovery,
    };
  }

  if (!input.selection || input.selection.kind !== 'group') {
    return {
      status: 'recovery_action_required',
      action: {
        kind: 'connected_service_required',
        serviceId: input.classification.serviceId,
        profileId: input.classification.profileId,
        groupId: input.classification.groupId,
        reason: input.classification.kind,
      },
    };
  }

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
    observedProfileId: input.classification.profileId,
    retryAfterMs: input.classification.retryAfterMs,
    resetsAtMs: input.classification.resetsAtMs,
    limitCategory: input.classification.limitCategory,
    quotaScope: input.classification.quotaScope,
    providerLimitId: input.classification.providerLimitId,
    action: input.classification.action,
    planType: input.classification.planType,
    switchesThisTurn: input.switchesThisTurn,
    ...(input.sessionSwitchesThisHour === undefined
      ? {}
      : { sessionSwitchesThisHour: input.sessionSwitchesThisHour }),
    ...(input.allowCurrentProfileRetry === undefined
      ? {}
      : { allowCurrentProfileRetry: input.allowCurrentProfileRetry }),
  });
  return { status: 'switch_attempted', result };
}
