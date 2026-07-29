import { describe, expect, it } from 'vitest';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol';

import { resolveSessionStartModelSelection } from './resolveSessionStartModelSelection';

describe('resolveSessionStartModelSelection', () => {
  it('binds separate model and provider-connection flags into one structured selection', () => {
    expect(resolveSessionStartModelSelection({
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      legacyModelId: 'model-a',
      providerConnectionId: 'pc_work',
      nowMs: 123,
    })).toEqual({
      v: 1,
      updatedAt: 123,
      ref: { agentTargetKey: 'backend:codex', providerConnectionId: 'pc_work', modelId: 'model-a' },
    });
  });
  it('preserves canonical provider identity and literal default for a built-in target', () => {
    const selection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 20,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'default',
      },
    });

    expect(resolveSessionStartModelSelection({
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      canonicalSelection: selection,
      legacyModelId: 'legacy-native',
      legacyModelUpdatedAt: 10,
    })).toEqual(selection);
  });

  it('validates configured target identity without collapsing it to a built-in id', () => {
    const selection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 30,
      ref: {
        agentTargetKey: 'backend:review-bot:configured:review-bot',
        providerConnectionId: 'pc_gateway',
        modelId: 'vendor/model',
      },
    });

    expect(resolveSessionStartModelSelection({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      canonicalSelection: selection,
    })).toEqual(selection);
  });

  it('refuses canonical selections for another target', () => {
    const selection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 30,
      ref: {
        agentTargetKey: 'backend:claude',
        providerConnectionId: 'pc_gateway',
        modelId: 'vendor/model',
      },
    });

    expect(() => resolveSessionStartModelSelection({
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      canonicalSelection: selection,
    })).toThrowError(expect.objectContaining({ code: 'model_selection_agent_target_mismatch' }));
  });

  it('keeps legacy native input read-only and treats legacy default as reset', () => {
    expect(resolveSessionStartModelSelection({
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      legacyModelId: 'native-model',
      legacyModelUpdatedAt: 40,
    })).toEqual({
      v: 1,
      updatedAt: 40,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: null,
        modelId: 'native-model',
      },
    });
    expect(resolveSessionStartModelSelection({
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      legacyModelId: 'default',
      legacyModelUpdatedAt: 41,
    })).toBeUndefined();
  });

  it('uses a profile preference only when no explicit canonical or legacy model input exists', () => {
    const preferred = SessionModelSelectionV1Schema.parse({
      v: 1, updatedAt: 10,
      ref: { agentTargetKey: 'backend:codex', providerConnectionId: 'pc_profile', modelId: 'profile-model' },
    });
    expect(resolveSessionStartModelSelection({
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      fallbackSelection: preferred,
    })).toEqual(preferred);
    expect(resolveSessionStartModelSelection({
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      fallbackSelection: preferred,
      legacyModelId: 'explicit-model',
      nowMs: 20,
    })?.ref).toMatchObject({ providerConnectionId: null, modelId: 'explicit-model' });
    expect(resolveSessionStartModelSelection({
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      fallbackSelection: preferred,
      legacyModelId: 'default',
    })).toBeUndefined();
  });
});
