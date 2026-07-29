import type { ConnectedServiceId } from '@happier-dev/protocol';
import type { ConnectedServiceRuntimeAuthApplyCapability } from '@/agent/catalog/types';

import { evaluatePredictiveSoftSwitchPolicy } from './predictiveSoftSwitchPolicy';

export type ConnectedServicePredictiveSwitchGuardInput = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
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
type RuntimeAuthApplyCapabilityResolver = (
  input: ConnectedServicePredictiveSwitchGuardInput,
) => ConnectedServiceRuntimeAuthApplyCapability | Promise<ConnectedServiceRuntimeAuthApplyCapability>;

const UNSUPPORTED_RUNTIME_AUTH_APPLY_CAPABILITY: ConnectedServiceRuntimeAuthApplyCapability = {
  directLiveHotAuth: 'unsupported',
};

export function createConnectedServicePredictiveSwitchGuard(deps: Readonly<{
  readTurnState?: (sessionId: string) => ConnectedServicePredictiveSwitchTurnState | null;
  resolvePredictiveSoftSwitchMode?: (
    input: ConnectedServicePredictiveSwitchGuardInput,
  ) => PredictiveSoftSwitchMode | Promise<PredictiveSoftSwitchMode>;
  runtimeAuthApplyCapabilityResolver?: RuntimeAuthApplyCapabilityResolver | null;
}>): (input: ConnectedServicePredictiveSwitchGuardInput) => Promise<ConnectedServicePredictiveSwitchGuardResult> {
  return async (input) => {
    if (input.reason === 'soft_threshold' || input.reason === 'same_provider_account_exhausted') {
      let runtimeAuthApply: ConnectedServiceRuntimeAuthApplyCapability | null = null;
      if (deps.runtimeAuthApplyCapabilityResolver) {
        try {
          runtimeAuthApply = await deps.runtimeAuthApplyCapabilityResolver(input);
        } catch {
          runtimeAuthApply = UNSUPPORTED_RUNTIME_AUTH_APPLY_CAPABILITY;
        }
      }
      const predictiveDecision = evaluatePredictiveSoftSwitchPolicy({
        reason: input.reason,
        predictiveSoftSwitchMode: deps.resolvePredictiveSoftSwitchMode
          ? await deps.resolvePredictiveSoftSwitchMode(input)
          : 'supported',
        turnState: deps.readTurnState?.(input.sessionId) ?? null,
        runtimeAuthApply,
      });
      if (predictiveDecision.status === 'suppress') {
        return predictiveDecision;
      }
    }
    return { status: 'allow' };
  };
}
