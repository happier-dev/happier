import { describe, expect, it } from 'vitest';
import { ProviderErrorV1Schema } from '@happier-dev/protocol';

import { readPersistedProviderResumeState } from './readPersistedResumeSelection';

const binding = {
  v: 1,
  connectionId: 'pc_gateway',
  contributionKey: 'acme.gateway/gateway',
  connectionRevision: 1,
  model: {
    id: 'vendor/model',
    name: 'Vendor Model',
  },
  protocol: 'openai-responses',
  materialization: 'engineConfig',
  adapterBindingKey: 'gateway',
  compatibilityFingerprint: 'compatibility:v1:one',
  bindingSecurityFingerprint: 'binding-security:v1:one',
  displaySnapshot: {
    providerName: 'Gateway',
    connectionName: 'Gateway',
    connectionRole: 'default',
    connectionDisplayNameMode: 'automatic',
  },
} as const;

describe('readPersistedProviderResumeState', () => {
  it('restores the exact structured selection associated with the persisted binding', () => {
    const metadata = {
      providerBindingV1: binding,
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 123,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_gateway',
          modelId: 'vendor/model',
        },
      },
    } as const;
    const selection = {
      v: 1,
      updatedAt: 123,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_gateway',
        modelId: 'vendor/model',
      },
    } as const;

    expect(readPersistedProviderResumeState(metadata)).toEqual({ selection, binding });
  });

  it('returns null for a native session and accepts a Provider proposal before its first binding exists', () => {
    expect(readPersistedProviderResumeState({ modelSelectionIntentV1: null })).toEqual({
      selection: null,
      binding: null,
    });
    expect(readPersistedProviderResumeState({
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 123,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_gateway',
          modelId: 'vendor/model',
        },
      },
    })).toEqual({
      selection: {
        v: 1,
        updatedAt: 123,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_gateway',
          modelId: 'vendor/model',
        },
      },
      binding: null,
    });
    expect(() => readPersistedProviderResumeState({ providerBindingV1: binding }))
      .toThrowError(expect.objectContaining({
        providerError: expect.objectContaining({ code: 'provider_binding_changed' }),
      }));
  });

  it('keeps the previous active binding separate from a different restart proposal', () => {
    expect(readPersistedProviderResumeState({
      providerBindingV1: binding,
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 123,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_other',
          modelId: 'vendor/model',
        },
      },
    })).toEqual({
      selection: {
        v: 1,
        updatedAt: 123,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_other',
          modelId: 'vendor/model',
        },
      },
      binding,
    });
  });

  it('keeps the previous active model binding separate from a different-model restart proposal', () => {
    const previousBinding = {
      ...binding,
      model: {
        id: 'vendor/other-model',
        name: 'Other Vendor Model',
      },
    } as const;
    expect(readPersistedProviderResumeState({
      providerBindingV1: {
        ...previousBinding,
      },
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 123,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_gateway',
          modelId: 'vendor/model',
        },
      },
    })).toEqual({
      selection: {
        v: 1,
        updatedAt: 123,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_gateway',
          modelId: 'vendor/model',
        },
      },
      binding: previousBinding,
    });
  });

  it('accepts the released compatibility shape whose persisted binding predates exact model descriptors', () => {
    const { model: _model, ...legacyBinding } = binding;
    expect(readPersistedProviderResumeState({
      providerBindingV1: legacyBinding,
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 123,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_gateway',
          modelId: 'vendor/model',
        },
      },
    })).toEqual({
      selection: {
        v: 1,
        updatedAt: 123,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_gateway',
          modelId: 'vendor/model',
        },
      },
      binding: legacyBinding,
    });
  });

  it('refuses incomplete persisted binding state with the canonical typed Provider error', () => {
    try {
      readPersistedProviderResumeState({ providerBindingV1: binding });
      throw new Error('Expected persisted Provider binding refusal');
    } catch (error) {
      const providerError = error && typeof error === 'object' && 'providerError' in error
        ? error.providerError
        : null;
      expect(ProviderErrorV1Schema.parse(providerError)).toMatchObject({
        code: 'provider_binding_changed',
        connectionId: 'pc_gateway',
        retryable: false,
        action: 'review_and_restart',
      });
    }
  });

  it('refuses present-but-invalid Provider envelopes instead of treating them as native state', () => {
    const malformedBinding = {
      v: 1,
      connectionId: 'pc_gateway',
    };
    const malformedProviderIntent = {
      v: 1,
      updatedAt: 123,
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_gateway',
      },
    };

    for (const metadata of [
      { providerBindingV1: malformedBinding },
      { modelSelectionIntentV1: malformedProviderIntent },
      {
        providerBindingV1: malformedBinding,
        modelSelectionIntentV1: malformedProviderIntent,
      },
    ]) {
      expect(() => readPersistedProviderResumeState(metadata)).toThrowError(expect.objectContaining({
        providerError: expect.objectContaining({
          code: 'provider_binding_changed',
          connectionId: 'pc_gateway',
          action: 'review_and_restart',
        }),
      }));
    }
  });

  it('refuses malformed Provider-shaped intent even when its connection id cannot be used as an error hint', () => {
    expect(() => readPersistedProviderResumeState({
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 123,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: ' invalid-connection-id ',
          modelId: 'vendor/model',
        },
      },
    })).toThrowError(expect.objectContaining({
      providerError: expect.objectContaining({
        code: 'provider_binding_changed',
        action: 'review_and_restart',
      }),
    }));

    expect(readPersistedProviderResumeState({
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 123,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: null,
          modelId: 'native-model',
        },
      },
    })).toEqual({
      selection: {
        v: 1,
        updatedAt: 123,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: null,
          modelId: 'native-model',
        },
      },
      binding: null,
    });
  });
});
