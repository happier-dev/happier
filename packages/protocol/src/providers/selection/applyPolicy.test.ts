import { describe, expect, it } from 'vitest';

import { resolveModelSelectionApplyPolicyV1 } from './applyPolicy.js';

const nativeA = { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'native-a' } as const;
const providerA1 = { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_a', modelId: 'model-1' } as const;
const providerA2 = { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_a', modelId: 'model-2' } as const;
const providerB = { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_b', modelId: 'model-1' } as const;

describe('resolveModelSelectionApplyPolicyV1', () => {
  it('uses the agent policy for a model-only change within the same source', () => {
    expect(resolveModelSelectionApplyPolicyV1({
      current: providerA1, next: providerA2, agentPolicy: 'live', liveProviderRebindingVerified: false,
    })).toBe('live');
  });

  it.each([[nativeA, providerA1], [providerA1, providerB]] as const)(
    'defaults a provider-source change to restart even when model switching is live',
    (current, next) => {
      expect(resolveModelSelectionApplyPolicyV1({
        current, next, agentPolicy: 'live', liveProviderRebindingVerified: false,
      })).toBe('restart_session');
    },
  );

  it('allows live source rebinding only when the adapter explicitly proves it', () => {
    expect(resolveModelSelectionApplyPolicyV1({
      current: providerA1, next: providerB, agentPolicy: 'live', liveProviderRebindingVerified: true,
    })).toBe('live');
  });

  it('preserves unsupported as an actionable refusal', () => {
    expect(resolveModelSelectionApplyPolicyV1({
      current: providerA1, next: providerA2, agentPolicy: 'unsupported', liveProviderRebindingVerified: true,
    })).toBe('unsupported');
  });
});
