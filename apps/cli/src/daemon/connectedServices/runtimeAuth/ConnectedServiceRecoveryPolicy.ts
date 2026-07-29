import type { ConnectedServiceRuntimeFailureClassification } from './types';

export type ConnectedServiceRecoveryPolicyActor = 'automatic' | 'manual';

export type ConnectedServiceRecoveryPolicySelection<
  TServiceIdentity = string,
> =
  | Readonly<{
      kind: 'profile';
      serviceId: TServiceIdentity;
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: TServiceIdentity;
      groupId: string;
      activeProfileId: string;
    }>;

export type ConnectedServiceRecoveryPolicyIssue<
  TServiceIdentity = string,
> =
  | (Omit<ConnectedServiceRuntimeFailureClassification, 'serviceId'>
      & Readonly<{ serviceId: TServiceIdentity }>)
  | Readonly<{
      kind: 'temporary_throttle' | 'soft_limit';
      serviceId: TServiceIdentity;
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

export type ConnectedServiceRecoveryPolicyDecision<
  TServiceIdentity = string,
> =
  | Readonly<{
      action: 'no_op';
      reason: 'no_issue' | 'soft_limit_no_safe_candidate' | 'live_provider_evidence_supersedes_cached_health';
      healthConvergence?: Readonly<{
        serviceId: TServiceIdentity;
        profileId: string;
        status: 'connected';
      }>;
    }>
  | Readonly<{
      action: 'temporary_retry';
      serviceId: TServiceIdentity;
      profileId: string | null;
      groupId: string | null;
      retryAfterMs: number | null;
    }>
  | Readonly<{
      action: 'refresh';
      serviceId: TServiceIdentity;
      profileId: string;
      reason: ConnectedServiceRecoveryPolicyIssue<TServiceIdentity>['kind'];
    }>
  | Readonly<{
      action: 'switch_account';
      mode: 'hot_apply' | 'restart_rematerialize' | 'delegate_to_group_switch';
      serviceId: TServiceIdentity;
      groupId: string;
      fromProfileId: string | null;
      toProfileId: string | null;
      reason: ConnectedServiceRecoveryPolicyIssue<TServiceIdentity>['kind'];
      actor: ConnectedServiceRecoveryPolicyActor;
    }>
  | Readonly<{
      action: 'wait_for_group_switch';
      serviceId: TServiceIdentity;
      groupId: string;
      reEvaluateAfterObservedResult: true;
    }>
  | Readonly<{
      action: 'wait_until_reset';
      serviceId: TServiceIdentity;
      profileId: string | null;
      groupId: string | null;
      retryAtMs: number | null;
    }>
  | Readonly<{
      action: 'reconnect_required';
      serviceId: TServiceIdentity;
      profileId: string | null;
      groupId: string | null;
      reason: ConnectedServiceRecoveryPolicyIssue<TServiceIdentity>['kind'];
      actor: ConnectedServiceRecoveryPolicyActor;
    }>
  | Readonly<{
      action: 'profile_action_required' | 'connected_service_required' | 'shared_state_required' | 'retry_required';
      serviceId: TServiceIdentity;
      profileId: string | null;
      groupId: string | null;
      reason: ConnectedServiceRecoveryPolicyIssue<TServiceIdentity>['kind'];
    }>;

type DecideConnectedServiceRecoveryInput<TServiceIdentity> = Readonly<{
  actor: ConnectedServiceRecoveryPolicyActor;
  issue: ConnectedServiceRecoveryPolicyIssue<TServiceIdentity> | null;
  selection: ConnectedServiceRecoveryPolicySelection<TServiceIdentity> | null;
  credentialHealth?: ConnectedServiceCredentialHealthPolicyInput | null;
  groupSwitch?: Readonly<{ status: 'idle' | 'in_progress' }> | null;
  groupCandidate?: ConnectedServiceRecoveryGroupCandidatePolicyInput | null;
  credentialRefresh?: Readonly<{ status: 'refreshable' | 'not_refreshable' }> | null;
}>;

function issueProfileId(
  issue: ConnectedServiceRecoveryPolicyIssue<unknown>,
  selection: ConnectedServiceRecoveryPolicySelection<unknown> | null,
): string | null {
  if (typeof issue.profileId === 'string' && issue.profileId.trim().length > 0) return issue.profileId;
  if (selection?.kind === 'profile') return selection.profileId;
  if (selection?.kind === 'group') return selection.activeProfileId || null;
  return null;
}

function issueGroupId(
  issue: ConnectedServiceRecoveryPolicyIssue<unknown>,
  selection: ConnectedServiceRecoveryPolicySelection<unknown> | null,
): string | null {
  if (typeof issue.groupId === 'string' && issue.groupId.trim().length > 0) return issue.groupId;
  if (selection?.kind === 'group') return selection.groupId;
  return null;
}

function isCredentialFailure(
  kind: ConnectedServiceRecoveryPolicyIssue<unknown>['kind'],
): boolean {
  return kind === 'auth_expired'
    || kind === 'account_changed'
    || kind === 'refresh_failed'
    || kind === 'permission_denied'
    || kind === 'account_disabled';
}

function isSwitchableGroupIssue(
  kind: ConnectedServiceRecoveryPolicyIssue<unknown>['kind'],
): boolean {
  return kind === 'usage_limit'
    || kind === 'rate_limit'
    || kind === 'capacity'
    || kind === 'dependency_failure'
    || kind === 'soft_limit'
    || kind === 'auth_expired'
    || kind === 'refresh_failed'
    || kind === 'permission_denied';
}

function isCanonicalLimitIssue<TServiceIdentity>(
  issue: ConnectedServiceRecoveryPolicyIssue<TServiceIdentity>,
): issue is Omit<ConnectedServiceRuntimeFailureClassification, 'serviceId'>
  & Readonly<{
  serviceId: TServiceIdentity;
  kind: 'usage_limit' | 'rate_limit' | 'capacity';
}> {
  return issue.kind === 'usage_limit'
    || issue.kind === 'rate_limit'
    || issue.kind === 'capacity';
}

function hasProviderSharedStateRecoveryAction(
  issue: ConnectedServiceRecoveryPolicyIssue<unknown>,
): boolean {
  return 'recoveryAction' in issue
    && issue.recoveryAction?.kind === 'provider_state_sharing_required';
}

function isSwitchableGroupSelection<TServiceIdentity>(
  issue: ConnectedServiceRecoveryPolicyIssue<TServiceIdentity>,
  selection: ConnectedServiceRecoveryPolicySelection<TServiceIdentity> | null,
): selection is Extract<
  ConnectedServiceRecoveryPolicySelection<TServiceIdentity>,
  Readonly<{ kind: 'group' }>
> {
  return selection?.kind === 'group' && isSwitchableGroupIssue(issue.kind);
}

export function decideConnectedServiceRecovery<TServiceIdentity = string>(
  input: DecideConnectedServiceRecoveryInput<TServiceIdentity>,
): ConnectedServiceRecoveryPolicyDecision<TServiceIdentity> {
  const issue = input.issue;
  if (!issue) return { action: 'no_op', reason: 'no_issue' };

  const profileId = issueProfileId(issue, input.selection);
  const groupId = issueGroupId(issue, input.selection);

  // Only exact account-scoped limit evidence may rotate a group member. Provider-wide and
  // unknown-scope limits stay on the same account and use the existing bounded retry/backoff
  // disposition. Missing scope is deliberately treated as unknown rather than inferred from
  // the category.
  if (
    issue.kind === 'temporary_throttle'
    || (isCanonicalLimitIssue(issue) && issue.quotaScope !== 'account')
  ) {
    return {
      action: 'temporary_retry',
      serviceId: issue.serviceId,
      profileId,
      groupId,
      retryAfterMs: issue.retryAfterMs ?? null,
    };
  }

  if (
    hasProviderSharedStateRecoveryAction(issue)
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

  if (issue.kind === 'account_changed') {
    return {
      action: 'profile_action_required',
      serviceId: issue.serviceId,
      profileId,
      groupId,
      reason: issue.kind,
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
    && input.selection?.kind !== 'group'
    && (
      input.credentialHealth?.cachedStatus === 'needs_reauth'
      || input.credentialHealth?.liveEvidence === 'auth_failed'
    )
  ) {
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

  if (
    input.selection?.kind === 'group'
    && input.groupCandidate?.status === 'selected'
    && isSwitchableGroupIssue(issue.kind)
  ) {
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
