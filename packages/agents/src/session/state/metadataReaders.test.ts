import { describe, expect, it } from 'vitest';

import { resolveModelSelectionIntentFromSessionMetadata } from './metadataReaders.js';

describe('resolveModelSelectionIntentFromSessionMetadata', () => {
  it('normalizes legacy input only after the exact target is supplied', () => {
    expect(resolveModelSelectionIntentFromSessionMetadata({
      modelOverrideV1: { v: 1, updatedAt: 4, modelId: 'legacy-native' },
    }, 'backend:codex')).toEqual({
      v: 1,
      updatedAt: 4,
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: null,
        modelId: 'legacy-native',
      },
    });
  });

  it('refuses a canonical selection for another target', () => {
    expect(() => resolveModelSelectionIntentFromSessionMetadata({
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 4,
        selection: {
          agentTargetKey: 'backend:claude',
          providerConnectionId: 'pc_work',
          modelId: 'provider-model',
        },
      },
    }, 'backend:codex')).toThrowError(expect.objectContaining({
      code: 'model_selection_agent_target_mismatch',
    }));
  });
});
