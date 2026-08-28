type PredictiveSoftSwitchReason =
  | 'usage_limit'
  | 'soft_threshold'
  | 'same_provider_account_exhausted'
  | 'auth_expired'
  | 'account_changed'
  | 'refresh_failed';

type PredictiveSoftSwitchCapability = 'supported' | 'unsupported';
type PredictiveSoftSwitchSessionApplyMode = 'hot_apply' | 'restart_resume' | 'spawn_next_turn';

type PredictiveSoftSwitchTurnState = Readonly<{
  inFlight: boolean;
}>;

export type PredictiveSoftSwitchPolicyDecision =
  | Readonly<{ status: 'allow' }>
  | Readonly<{
      status: 'defer';
      reason: 'predictive_soft_switch_defer_until_turn_boundary';
    }>
  | Readonly<{
      status: 'suppress';
      reason:
        | 'predictive_soft_switch_restart_required'
        | 'predictive_soft_switch_turn_in_flight';
    }>;

export type PredictiveSoftSwitchSessionApplyDecision =
  | Readonly<{ status: 'allow' }>
  | Readonly<{
      status: 'suppress';
      reason: 'predictive_soft_switch_hot_apply_required';
    }>;

export function evaluatePredictiveSoftSwitchPolicy(input: Readonly<{
  reason: PredictiveSoftSwitchReason;
  predictiveSoftSwitchMode: PredictiveSoftSwitchCapability;
  turnState?: PredictiveSoftSwitchTurnState | null;
}>): PredictiveSoftSwitchPolicyDecision {
  if (input.reason !== 'soft_threshold' && input.reason !== 'same_provider_account_exhausted') {
    return { status: 'allow' };
  }
  if (input.predictiveSoftSwitchMode !== 'supported') {
    return {
      status: 'suppress',
      reason: 'predictive_soft_switch_restart_required',
    };
  }
  if (input.turnState?.inFlight === true) {
    if (input.reason === 'same_provider_account_exhausted') {
      return {
        status: 'defer',
        reason: 'predictive_soft_switch_defer_until_turn_boundary',
      };
    }
    return {
      status: 'suppress',
      reason: 'predictive_soft_switch_turn_in_flight',
    };
  }
  return { status: 'allow' };
}

export function evaluatePredictiveSoftSwitchSessionApplyPolicy(input: Readonly<{
  reason: PredictiveSoftSwitchReason;
  sessionId?: string | null;
  applyMode?: PredictiveSoftSwitchSessionApplyMode | null;
}>): PredictiveSoftSwitchSessionApplyDecision {
  if (input.reason !== 'soft_threshold' && input.reason !== 'same_provider_account_exhausted') return { status: 'allow' };
  if (typeof input.sessionId !== 'string' || input.sessionId.trim().length === 0) return { status: 'allow' };
  if (input.applyMode === undefined || input.applyMode === null || input.applyMode === 'hot_apply') {
    return { status: 'allow' };
  }
  return {
    status: 'suppress',
    reason: 'predictive_soft_switch_hot_apply_required',
  };
}
