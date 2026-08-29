import type { ConnectedAccountServiceKey } from '@happier-dev/protocol';
import { evaluatePredictiveSoftSwitchPolicy } from './predictiveSoftSwitchPolicy';

export type ConnectedServicePredictiveSwitchGuardInput = Readonly<{
  sessionId: string;
  serviceId: ConnectedAccountServiceKey;
  groupId: string;
  activeProfileId: string;
  agentId?: string | null;
  reason: 'soft_threshold' | 'same_provider_account_exhausted' | 'usage_limit' | 'auth_expired';
}>;

export type ConnectedServicePredictiveSwitchGuardResult =
  | Readonly<{ status: 'allow' }>
  | Readonly<{ status: 'suppress'; reason: string }>;

type PredictiveSoftSwitchMode = 'supported' | 'unsupported';
type ConnectedServicePredictiveSwitchTurnState = Readonly<{
  inFlight: boolean;
}>;
export function createConnectedServicePredictiveSwitchGuard(deps: Readonly<{
  readTurnState?: (sessionId: string) => ConnectedServicePredictiveSwitchTurnState | null;
  resolvePredictiveSoftSwitchMode?: (
    input: ConnectedServicePredictiveSwitchGuardInput,
  ) => PredictiveSoftSwitchMode | Promise<PredictiveSoftSwitchMode>;
}>): (input: ConnectedServicePredictiveSwitchGuardInput) => Promise<ConnectedServicePredictiveSwitchGuardResult> {
  return async (input) => {
    if (input.reason === 'soft_threshold' || input.reason === 'same_provider_account_exhausted') {
      const predictiveDecision = evaluatePredictiveSoftSwitchPolicy({
        reason: input.reason,
        predictiveSoftSwitchMode: deps.resolvePredictiveSoftSwitchMode
          ? await deps.resolvePredictiveSoftSwitchMode(input)
          : 'supported',
        turnState: deps.readTurnState?.(input.sessionId) ?? null,
      });
      if (predictiveDecision.status === 'suppress') {
        return predictiveDecision;
      }
    }
    return { status: 'allow' };
  };
}
