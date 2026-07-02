import type { ConnectedServiceRuntimeFailureClassification } from './types';

export type ConnectedServiceRecoveryPolicyActor = 'automatic' | 'manual';

export type ConnectedServiceRecoveryPolicySelection =
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

export type ConnectedServiceRecoveryPolicyIssue =
  | ConnectedServiceRuntimeFailureClassification
  | Readonly<{
      kind: 'temporary_throttle' | 'soft_limit';
      serviceId: string;
      profileId: string | null;
      groupId: string | null;
      resetsAtMs: number | null;
      retryAfterMs?: number | null;
    }>;

export type ConnectedServiceCredentialHealthPolicyInput = Readonly<{
  cachedStatus?: 'connected' | 'refreshing' | 'needs_reauth' | 'refresh_failed_retryable' | 'unknown' | null;
  liveEvidence?: 'accepted' | 'auth_failed' | null;
}>;

export type ConnectedServiceRecoveryGroupCandidatePolicyInput =
  | Readonly<{
      status: 'selected';
      profileId: string;
      applyMode: 'hot_apply' | 'restart_rematerialize';
    }>
  | Readonly<{
      status: 'none';
      reason: 'manual_strategy' | 'no_eligible_members' | 'no_safe_better_candidate';
      retryAtMs?: number | null;
    }>;

export type ConnectedServiceRecoveryPolicyDecision =
  | Readonly<{
      action: 'no_op';
      reason: 'no_issue' | 'soft_limit_no_safe_candidate' | 'live_provider_evidence_supersedes_cached_health';
      healthConvergence?: Readonly<{
        serviceId: string;
        profileId: string;
        status: 'connected';
      }>;
    }>
  | Readonly<{
      action: 'temporary_retry';
      serviceId: string;
      profileId: string | null;
      groupId: string | null;
      retryAfterMs: number | null;
    }>
  | Readonly<{
      action: 'refresh';
      serviceId: string;
      profileId: string;
      reason: ConnectedServiceRecoveryPolicyIssue['kind'];
    }>
  | Readonly<{
      action: 'switch_account';
      mode: 'hot_apply' | 'restart_rematerialize' | 'delegate_to_group_switch';
      serviceId: string;
      groupId: string;
      fromProfileId: string | null;
      toProfileId: string | null;
      reason: ConnectedServiceRecoveryPolicyIssue['kind'];
      actor: ConnectedServiceRecoveryPolicyActor;
    }>
  | Readonly<{
      action: 'wait_for_group_switch';
      serviceId: string;
      groupId: string;
      reEvaluateAfterObservedResult: true;
    }>
  | Readonly<{
      action: 'wait_until_reset';
      serviceId: string;
      profileId: string | null;
      groupId: string | null;
      retryAtMs: number | null;
    }>
  | Readonly<{
      action: 'reconnect_required';
      serviceId: string;
      profileId: string | null;
      groupId: string | null;
      reason: ConnectedServiceRecoveryPolicyIssue['kind'];
      actor: ConnectedServiceRecoveryPolicyActor;
    }>
  | Readonly<{
      action: 'profile_action_required' | 'connected_service_required' | 'shared_state_required' | 'retry_required';
      serviceId: string;
      profileId: string | null;
      groupId: string | null;
      reason: ConnectedServiceRecoveryPolicyIssue['kind'];
    }>;

type DecideConnectedServiceRecoveryInput = Readonly<{
  actor: ConnectedServiceRecoveryPolicyActor;
  issue: ConnectedServiceRecoveryPolicyIssue | null;
  selection: ConnectedServiceRecoveryPolicySelection | null;
  credentialHealth?: ConnectedServiceCredentialHealthPolicyInput | null;
  groupSwitch?: Readonly<{ status: 'idle' | 'in_progress' }> | null;
  groupCandidate?: ConnectedServiceRecoveryGroupCandidatePolicyInput | null;
  providerContinuity?: Readonly<{ restart: 'available' | 'unavailable' | 'shared_state_required' }> | null;
  credentialRefresh?: Readonly<{ status: 'refreshable' | 'not_refreshable' }> | null;
}>;

function issueProfileId(
  issue: ConnectedServiceRecoveryPolicyIssue,
  selection: ConnectedServiceRecoveryPolicySelection | null,
): string | null {
  if (typeof issue.profileId === 'string' && issue.profileId.trim().length > 0) return issue.profileId;
  if (selection?.kind === 'profile') return selection.profileId;
  if (selection?.kind === 'group') return selection.activeProfileId || null;
  return null;
}

function issueGroupId(
  issue: ConnectedServiceRecoveryPolicyIssue,
  selection: ConnectedServiceRecoveryPolicySelection | null,
): string | null {
  if (typeof issue.groupId === 'string' && issue.groupId.trim().length > 0) return issue.groupId;
  if (selection?.kind === 'group') return selection.groupId;
  return null;
}

function isCredentialFailure(kind: ConnectedServiceRecoveryPolicyIssue['kind']): boolean {
  return kind === 'auth_expired'
    || kind === 'account_changed'
    || kind === 'refresh_failed'
    || kind === 'permission_denied'
    || kind === 'account_disabled';
}

function isSwitchableGroupIssue(kind: ConnectedServiceRecoveryPolicyIssue['kind']): boolean {
  return kind === 'usage_limit'
    || kind === 'rate_limit'
    || kind === 'auth_expired'
    || kind === 'account_changed'
    || kind === 'refresh_failed'
    || kind === 'dependency_failure'
    || kind === 'account_disabled'
    || kind === 'soft_limit'
    || kind === 'unknown';
}

function hasProviderSharedStateRecoveryAction(issue: ConnectedServiceRecoveryPolicyIssue): boolean {
  return 'recoveryAction' in issue
    && issue.recoveryAction?.kind === 'provider_state_sharing_required';
}

function isSwitchableGroupSelection(
  issue: ConnectedServiceRecoveryPolicyIssue,
  selection: ConnectedServiceRecoveryPolicySelection | null,
): selection is Extract<ConnectedServiceRecoveryPolicySelection, Readonly<{ kind: 'group' }>> {
  return selection?.kind === 'group' && isSwitchableGroupIssue(issue.kind);
}

export function decideConnectedServiceRecovery(
  input: DecideConnectedServiceRecoveryInput,
): ConnectedServiceRecoveryPolicyDecision {
  const issue = input.issue;
  if (!issue) return { action: 'no_op', reason: 'no_issue' };

  const profileId = issueProfileId(issue, input.selection);
  const groupId = issueGroupId(issue, input.selection);

  // Provider capacity ("Overloaded"/529) is server-side and account-independent: switching
  // accounts or restarting the session never helps. Retry the SAME session with backoff,
  // exactly like temporary throttles (incident 2026-06-12, lane TRANSIENT).
  if (issue.kind === 'temporary_throttle' || issue.kind === 'capacity') {
    return {
      action: 'temporary_retry',
      serviceId: issue.serviceId,
      profileId,
      groupId,
      retryAfterMs: issue.retryAfterMs ?? null,
    };
  }

  if (
    (
      hasProviderSharedStateRecoveryAction(issue)
      || input.providerContinuity?.restart === 'shared_state_required'
    )
    && !isSwitchableGroupSelection(issue, input.selection)
  ) {
    return {
      action: 'shared_state_required',
      serviceId: issue.serviceId,
      profileId,
      groupId,
      reason: issue.kind,
    };
  }

  if (input.providerContinuity?.restart === 'unavailable') {
    return {
      action: 'retry_required',
      serviceId: issue.serviceId,
      profileId,
      groupId,
      reason: issue.kind,
    };
  }

  if (
    input.credentialHealth?.cachedStatus === 'needs_reauth'
    && input.credentialHealth.liveEvidence === 'accepted'
    && profileId
  ) {
    return {
      action: 'no_op',
      reason: 'live_provider_evidence_supersedes_cached_health',
      healthConvergence: {
        serviceId: issue.serviceId,
        profileId,
        status: 'connected',
      },
    };
  }

  if (
    isCredentialFailure(issue.kind)
    && input.credentialRefresh?.status === 'refreshable'
    && profileId
    && input.credentialHealth?.liveEvidence !== 'auth_failed'
    && input.credentialHealth?.cachedStatus !== 'needs_reauth'
  ) {
    return {
      action: 'refresh',
      serviceId: issue.serviceId,
      profileId,
      reason: issue.kind,
    };
  }

  if (
    isCredentialFailure(issue.kind)
    && (
      input.credentialHealth?.cachedStatus === 'needs_reauth'
      || input.credentialHealth?.liveEvidence === 'auth_failed'
    )
  ) {
    if (input.selection?.kind === 'group' && input.groupCandidate?.status === 'selected') {
      return {
        action: 'switch_account',
        mode: input.groupCandidate.applyMode,
        serviceId: input.selection.serviceId,
        groupId: input.selection.groupId,
        fromProfileId: input.selection.activeProfileId,
        toProfileId: input.groupCandidate.profileId,
        reason: issue.kind,
        actor: input.actor,
      };
    }
    return {
      action: 'reconnect_required',
      serviceId: issue.serviceId,
      profileId,
      groupId,
      reason: issue.kind,
      actor: input.actor,
    };
  }

  if (input.selection?.kind === 'group' && input.groupSwitch?.status === 'in_progress') {
    return {
      action: 'wait_for_group_switch',
      serviceId: input.selection.serviceId,
      groupId: input.selection.groupId,
      reEvaluateAfterObservedResult: true,
    };
  }

  if (issue.kind === 'soft_limit' && input.groupCandidate?.status === 'none') {
    return {
      action: 'no_op',
      reason: 'soft_limit_no_safe_candidate',
    };
  }

  if (input.groupCandidate?.status === 'none' && input.groupCandidate.retryAtMs !== undefined) {
    return {
      action: 'wait_until_reset',
      serviceId: issue.serviceId,
      profileId,
      groupId,
      retryAtMs: input.groupCandidate.retryAtMs ?? issue.resetsAtMs ?? null,
    };
  }

  if (input.selection?.kind === 'group' && input.groupCandidate?.status === 'selected') {
    return {
      action: 'switch_account',
      mode: input.groupCandidate.applyMode,
      serviceId: input.selection.serviceId,
      groupId: input.selection.groupId,
      fromProfileId: input.selection.activeProfileId,
      toProfileId: input.groupCandidate.profileId,
      reason: issue.kind,
      actor: input.actor,
    };
  }

  if (input.selection?.kind === 'group' && isSwitchableGroupIssue(issue.kind)) {
    return {
      action: 'switch_account',
      mode: 'delegate_to_group_switch',
      serviceId: input.selection.serviceId,
      groupId: input.selection.groupId,
      fromProfileId: input.selection.activeProfileId,
      toProfileId: null,
      reason: issue.kind,
      actor: input.actor,
    };
  }

  if (input.selection?.kind === 'profile') {
    if (isCredentialFailure(issue.kind)) {
      return {
        action: 'reconnect_required',
        serviceId: input.selection.serviceId,
        profileId,
        groupId,
        reason: issue.kind,
        actor: input.actor,
      };
    }
    return {
      action: 'profile_action_required',
      serviceId: input.selection.serviceId,
      profileId,
      groupId,
      reason: issue.kind,
    };
  }

  return {
    action: 'connected_service_required',
    serviceId: issue.serviceId,
    profileId,
    groupId,
    reason: issue.kind,
  };
}
