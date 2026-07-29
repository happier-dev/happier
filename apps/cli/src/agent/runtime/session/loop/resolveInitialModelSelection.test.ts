import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema, SessionModelSelectionV1Schema } from '@happier-dev/protocol';

import { resolveInitialHostSessionModelSelection } from './resolveInitialModelSelection';

const providerSelection = SessionModelSelectionV1Schema.parse({
  v: 1,
  updatedAt: 12,
  ref: {
    agentTargetKey: 'backend:codex',
    providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
    modelId: 'default',
  },
});

describe('resolveInitialHostSessionModelSelection', () => {
  it('preserves provider identity and literal provider model id default', () => {
    expect(resolveInitialHostSessionModelSelection({
      agentTargetKey: 'backend:codex',
      lifecycleSelection: providerSelection,
    })).toEqual(providerSelection);
  });

  it('prefers an explicit runtime selection and refuses target mismatch', () => {
    const runtimeSelection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 13,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: null,
        modelId: 'native-model',
      },
    });
    expect(resolveInitialHostSessionModelSelection({
      agentTargetKey: 'backend:codex',
      runtimeSelection,
      lifecycleSelection: providerSelection,
    })).toEqual(runtimeSelection);
    expect(() => resolveInitialHostSessionModelSelection({
      agentTargetKey: 'backend:claude',
      lifecycleSelection: providerSelection,
    })).toThrow(/target mismatch/i);
  });

  it('normalizes a predecessor built-in target key to the current runtime binding basis', () => {
    const predecessorSelection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 14,
      ref: {
        agentTargetKey: 'agent:claude',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'claude-sonnet',
      },
    });
    const runtimeBindingBasis = {
      agentTargetKey: 'backend:claude',
      connectionId: ProviderConnectionIdSchema.parse('pc_work'),
    } as const;

    const resolved = resolveInitialHostSessionModelSelection({
      agentTargetKey: runtimeBindingBasis.agentTargetKey,
      lifecycleSelection: predecessorSelection,
    });

    expect(resolved).toEqual({
      ...predecessorSelection,
      ref: {
        ...predecessorSelection.ref,
        agentTargetKey: runtimeBindingBasis.agentTargetKey,
      },
    });
  });

  it('keeps a predecessor configured target distinct from the built-in target', () => {
    const configuredSelection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 15,
      ref: {
        agentTargetKey: 'acpBackend:claude',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'claude-sonnet',
      },
    });

    expect(() => resolveInitialHostSessionModelSelection({
      agentTargetKey: 'backend:claude',
      lifecycleSelection: configuredSelection,
    })).toThrow(/target mismatch/i);
  });
});
