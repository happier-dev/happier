import type { ModelSelectionApplyPolicy } from '../compatibility/v1.js';
import type { ProviderBoundModelRef } from './v1.js';

export function resolveModelSelectionApplyPolicyV1(params: Readonly<{
  current: ProviderBoundModelRef;
  next: ProviderBoundModelRef;
  agentPolicy: ModelSelectionApplyPolicy;
  liveProviderRebindingVerified: boolean;
}>): ModelSelectionApplyPolicy {
  if (params.agentPolicy === 'unsupported') return 'unsupported';
  if (params.current.agentTargetKey !== params.next.agentTargetKey) return 'unsupported';
  const sourceChanged = params.current.providerConnectionId !== params.next.providerConnectionId;
  if (!sourceChanged) return params.agentPolicy;
  if (params.agentPolicy === 'live' && params.liveProviderRebindingVerified) return 'live';
  return 'restart_session';
}
