import { describe, expect, it } from 'vitest';

import { resolveSessionMessageModel } from './resolveSessionMessageModel';

/** The prompt model selector, read off the canonical resolution that keeps Provider identity. */
const modelIdFor = (
  params: Parameters<typeof resolveSessionMessageModel>[0],
): string => resolveSessionMessageModel(params).modelId;

describe('resolveSessionMessageModel', () => {
  it('projects a canonical provider-bound session selection to the final prompt model selector', () => {
    expect(modelIdFor({
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
    expect(modelIdFor({
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
      agentPolicy: 'live',
    })).toBe('default');

    expect(() => modelIdFor({
      metadata: {},
      modelSelectionInput: {
        providerConnectionId: 'pc_work',
        modelId: 'provider-model',
      },
      agentPolicy: 'live',
    })).toThrow(/target.*unavailable/i);

    expect(() => modelIdFor({
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

  it('retains provider identity for the structured per-message transport', () => {
    expect(resolveSessionMessageModel({
      metadata: {
        flavor: 'codex',
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 7,
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
      agentPolicy: 'live',
      nowMs: 42,
    })).toEqual({
      modelId: 'default',
      selection: {
        v: 1,
        updatedAt: 42,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_work',
          modelId: 'default',
        },
      },
    });
  });

  it('inherits omitted active Provider identity from launch facts instead of a pending restart intent', () => {
    expect(resolveSessionMessageModel({
      metadata: {
        flavor: 'codex',
        providerBindingV1: {
          v: 1,
          connectionId: 'pc_active',
          contributionKey: null,
          connectionRevision: 1,
          model: { id: 'active-model', name: 'Active model' },
          protocol: 'openai-responses',
          materialization: 'engineConfig',
          compatibilityFingerprint: 'compatibility:v1:active',
          bindingSecurityFingerprint: 'binding-security:v1:active',
          displaySnapshot: {
            providerName: 'Gateway',
            connectionName: 'Active',
            connectionRole: 'named',
            connectionDisplayNameMode: 'custom',
          },
        },
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 8,
          selection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_pending',
            modelId: 'pending-restart-model',
          },
        },
      },
      sessionActive: true,
      modelSelectionInput: { modelId: 'per-message-model' },
      nowMs: 42,
    }).selection?.ref).toEqual({
      agentTargetKey: 'backend:codex',
      providerConnectionId: 'pc_active',
      modelId: 'per-message-model',
    });
  });

  it('does not resubmit a pending restart intent on an ordinary active prompt', () => {
    const metadata = {
      flavor: 'codex',
      providerBindingV1: {
        v: 1,
        connectionId: 'pc_active',
        contributionKey: null,
        connectionRevision: 1,
        model: { id: 'active-model', name: 'Active model' },
        protocol: 'openai-responses',
        materialization: 'engineConfig',
        compatibilityFingerprint: 'compatibility:v1:active',
        bindingSecurityFingerprint: 'binding-security:v1:active',
        displaySnapshot: {
          providerName: 'Gateway',
          connectionName: 'Active',
          connectionRole: 'named',
          connectionDisplayNameMode: 'custom',
        },
      },
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 8,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_pending',
          modelId: 'pending-restart-model',
        },
      },
    } as const;

    expect(resolveSessionMessageModel({
      metadata,
      sessionActive: true,
    })).toEqual({
      modelId: '',
      selection: null,
    });
    expect(resolveSessionMessageModel({
      metadata,
      sessionActive: false,
    }).selection?.ref).toMatchObject({
      providerConnectionId: 'pc_pending',
      modelId: 'pending-restart-model',
    });
  });

  it('preserves source transitions for the exact prompt-custody coordinator', () => {
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
      expect(resolveSessionMessageModel({
        metadata: providerMetadata,
        modelSelectionInput: { providerConnectionId, modelId: 'default' },
        agentPolicy: 'live',
        nowMs: 10,
      }).selection?.ref).toMatchObject({
        providerConnectionId,
        modelId: 'default',
      });
    }
    expect(resolveSessionMessageModel({
      metadata: { flavor: 'codex' },
      modelSelectionInput: { providerConnectionId: 'pc_a', modelId: 'provider-model' },
      agentPolicy: 'live',
      nowMs: 11,
    }).selection?.ref).toMatchObject({
      providerConnectionId: 'pc_a',
      modelId: 'provider-model',
    });
    expect(modelIdFor({
      metadata: providerMetadata,
      modelSelectionInput: { modelId: 'default' },
      agentPolicy: 'live',
    })).toBe('default');
  });

  it('delegates same-connection policy to the exact prompt-custody coordinator', () => {
    expect(modelIdFor({
      metadata: {
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
      },
      modelSelectionInput: { providerConnectionId: 'pc_a', modelId: 'provider-next' },
      agentPolicy: 'restart_session',
    })).toBe('provider-next');
  });

  it('refuses provider identity without a concrete model and preserves native reset semantics', () => {
    expect(() => modelIdFor({
      metadata: { flavor: 'codex' },
      modelSelectionInput: {
        providerConnectionId: 'pc_work',
        modelId: null,
      },
      agentPolicy: 'live',
    })).toThrow(/concrete model/i);
    expect(modelIdFor({
      metadata: { flavor: 'codex' },
      modelSelectionInput: { providerConnectionId: null, modelId: 'default' },
      agentPolicy: 'unsupported',
    })).toBe('default');
    expect(modelIdFor({
      metadata: { flavor: 'codex' },
      modelSelectionInput: { providerConnectionId: null, modelId: null },
      agentPolicy: 'unsupported',
    })).toBe('default');
  });

  it('keeps the deployed bare override as compatibility-only input', () => {
    expect(modelIdFor({
      metadata: { flavor: 'codex' },
      legacyModelOverride: 'legacy-native',
    })).toBe('legacy-native');
    expect(modelIdFor({
      metadata: { flavor: 'codex' },
      legacyModelOverride: null,
    })).toBe('');
  });
});
