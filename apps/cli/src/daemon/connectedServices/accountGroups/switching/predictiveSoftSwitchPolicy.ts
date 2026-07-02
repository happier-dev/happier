type PredictiveSoftSwitchReason =
  | 'usage_limit'
  | 'soft_threshold'
  | 'auth_expired'
  | 'account_changed'
  | 'refresh_failed';

type PredictiveSoftSwitchCapability = 'supported' | 'unsupported';

type PredictiveSoftSwitchTurnState = Readonly<{
  inFlight: boolean;
}>;

export type PredictiveSoftSwitchPolicyDecision =
  | Readonly<{ status: 'allow' }>
  | Readonly<{
      status: 'suppress';
      reason:
        | 'predictive_soft_switch_restart_required'
        | 'predictive_soft_switch_turn_in_flight';
    }>;

export function evaluatePredictiveSoftSwitchPolicy(input: Readonly<{
  reason: PredictiveSoftSwitchReason;
  predictiveSoftSwitchMode: PredictiveSoftSwitchCapability;
  turnState?: PredictiveSoftSwitchTurnState | null;
}>): PredictiveSoftSwitchPolicyDecision {
  if (input.reason !== 'soft_threshold') return { status: 'allow' };
  if (input.predictiveSoftSwitchMode !== 'supported') {
    return {
      status: 'suppress',
      reason: 'predictive_soft_switch_restart_required',
    };
  }
  if (input.turnState?.inFlight === true) {
    return {
      status: 'suppress',
      reason: 'predictive_soft_switch_turn_in_flight',
    };
  }
  return { status: 'allow' };
}
