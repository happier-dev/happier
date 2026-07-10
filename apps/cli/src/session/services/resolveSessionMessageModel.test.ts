import { describe, expect, it } from 'vitest';

import { resolveSessionMessageModelId } from './resolveSessionMessageModel';

describe('resolveSessionMessageModelId', () => {
  it('projects a canonical provider-bound session selection to the final prompt model selector', () => {
    expect(resolveSessionMessageModelId({
      metadata: {
        flavor: 'codex',
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 12,
          selection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_work',
            modelId: 'provider-model',
          },
        },
      },
    })).toBe('provider-model');
  });

  it('constructs provider identity only after resolving the target and preserves literal default', () => {
    expect(resolveSessionMessageModelId({
      metadata: {
        flavor: 'codex',
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 1,
          selection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_work',
            modelId: 'provider-old',
          },
        },
      },
      modelSelectionInput: {
        providerConnectionId: 'pc_work',
        modelId: 'default',
      },
    })).toBe('default');

    expect(() => resolveSessionMessageModelId({
      metadata: {},
      modelSelectionInput: {
        providerConnectionId: 'pc_work',
        modelId: 'provider-model',
      },
    })).toThrow(/target.*unavailable/i);

    expect(() => resolveSessionMessageModelId({
      metadata: {
        flavor: 'claude',
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 1,
          selection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_work',
            modelId: 'provider-model',
          },
        },
      },
    })).toThrow(/target mismatch/i);
  });

  it('refuses provider switching while allowing omitted connection to use the current binding', () => {
    const providerMetadata = {
      flavor: 'codex',
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_a',
          modelId: 'provider-old',
        },
      },
    } as const;
    for (const providerConnectionId of ['pc_b', null] as const) {
      expect(() => resolveSessionMessageModelId({
        metadata: providerMetadata,
        modelSelectionInput: { providerConnectionId, modelId: 'default' },
      })).toThrowError(expect.objectContaining({ code: 'provider_switch_unsupported' }));
    }
    expect(() => resolveSessionMessageModelId({
      metadata: { flavor: 'codex' },
      modelSelectionInput: { providerConnectionId: 'pc_a', modelId: 'provider-model' },
    })).toThrowError(expect.objectContaining({ code: 'provider_switch_unsupported' }));
    expect(resolveSessionMessageModelId({
      metadata: providerMetadata,
      modelSelectionInput: { modelId: 'default' },
    })).toBe('default');
  });

  it('refuses provider identity without a concrete model and preserves native reset semantics', () => {
    expect(() => resolveSessionMessageModelId({
      metadata: { flavor: 'codex' },
      modelSelectionInput: {
        providerConnectionId: 'pc_work',
        modelId: null,
      },
    })).toThrow(/concrete model/i);
    expect(resolveSessionMessageModelId({
      metadata: { flavor: 'codex' },
      modelSelectionInput: { providerConnectionId: null, modelId: 'default' },
    })).toBe('');
    expect(resolveSessionMessageModelId({
      metadata: { flavor: 'codex' },
      modelSelectionInput: { providerConnectionId: null, modelId: null },
    })).toBe('');
  });

  it('keeps the deployed bare override as compatibility-only input', () => {
    expect(resolveSessionMessageModelId({
      metadata: { flavor: 'codex' },
      legacyModelOverride: 'legacy-native',
    })).toBe('legacy-native');
    expect(resolveSessionMessageModelId({
      metadata: { flavor: 'codex' },
      legacyModelOverride: null,
    })).toBe('');
  });
});
