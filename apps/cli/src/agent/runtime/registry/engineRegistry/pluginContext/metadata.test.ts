import { describe, expect, it } from 'vitest';

import { preserveSessionStateMetadataKeys } from './metadata';

describe('preserveSessionStateMetadataKeys', () => {
  it('protects canonical model-selection intent from plugin metadata replacement', () => {
    const intent = {
      v: 1,
      updatedAt: 12,
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'provider-model',
      },
    };
    expect(preserveSessionStateMetadataKeys(
      { modelSelectionIntentV1: intent },
      { modelSelectionIntentV1: { v: 1, updatedAt: 99, selection: null }, plugin: true },
    )).toEqual({ modelSelectionIntentV1: intent, plugin: true });
  });
});
