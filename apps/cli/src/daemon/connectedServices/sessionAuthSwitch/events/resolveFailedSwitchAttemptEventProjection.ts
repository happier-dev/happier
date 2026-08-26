export type FailedSwitchAttemptEventProjection = Readonly<{
  action: 'restart_requested' | 'hot_applied';
  attemptedContinuityMode: 'hot_apply' | 'restart';
  outcome: 'failed';
  outcomeAction: 'none';
}>;

export function resolveFailedSwitchAttemptEventProjection(input: Readonly<{
  errorCode: string;
  attemptedAction?: 'restart_requested' | 'hot_applied' | 'metadata_updated';
  applicationPhase?: 'hot_apply' | 'restart' | string;
}>): FailedSwitchAttemptEventProjection | null {
  if (input.attemptedAction === 'metadata_updated' || input.errorCode === 'metadata_update_failed') {
    return null;
  }
  if (
    input.attemptedAction === 'hot_applied'
    || input.errorCode === 'hot_apply_failed'
    || input.errorCode === 'hot_apply_succeeded_but_recovery_failed'
    || input.applicationPhase === 'hot_apply'
  ) {
    return {
      action: 'hot_applied',
      attemptedContinuityMode: 'hot_apply',
      outcome: 'failed',
      outcomeAction: 'none',
    };
  }
  if (input.attemptedAction === 'restart_requested' || input.errorCode === 'restart_failed' || input.applicationPhase === 'restart') {
    return {
      action: 'restart_requested',
      attemptedContinuityMode: 'restart',
      outcome: 'failed',
      outcomeAction: 'none',
    };
  }
  return null;
}

export function resolveFailedSwitchAttemptPartialState(input: Readonly<{
  errorCode: string;
  applicationStatus?: string;
}>): 'runtime_auth_partially_applied' | null {
  return input.errorCode === 'partial_applied_pending_reconciliation'
    || input.applicationStatus === 'partial_applied_pending_reconciliation'
    ? 'runtime_auth_partially_applied'
    : null;
}
