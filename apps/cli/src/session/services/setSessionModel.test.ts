import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
  type SessionOwnerMetadataEnvelopeV1,
} from '@happier-dev/protocol';

const {
  callSessionRpc,
  resolveSessionTransportContext,
  updateSessionMetadataWithRetry,
} = vi.hoisted(() => ({
  callSessionRpc: vi.fn(),
  resolveSessionTransportContext: vi.fn(),
  updateSessionMetadataWithRetry: vi.fn(),
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc }));
vi.mock('./resolveSessionTransportContext', () => ({ resolveSessionTransportContext }));
vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry,
}));

import { setSessionModel } from './setSessionModel';

const credentials = {
  token: 'token',
  encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
};

const metadata = {
  flavor: 'codex',
  modelSelectionIntentV1: {
    v: 1,
    updatedAt: 10,
    selection: {
      agentTargetKey: 'backend:codex',
      providerConnectionId: 'pc_work',
      modelId: 'old-model',
    },
  },
} as const;

function transport(
  active: boolean,
  rawMetadata: Readonly<{
    metadata: string;
    metadataLayoutVersion: number;
    ownerMetadata?: SessionOwnerMetadataEnvelopeV1;
    encryptionMode: 'plain' | 'e2ee';
  }> = {
    metadata: JSON.stringify(metadata),
    metadataLayoutVersion: 0,
    encryptionMode: 'plain',
  },
) {
  return {
    ok: true as const,
    sessionId: 'sess-1',
    accountEncryptionCurrentness: {
      mode: rawMetadata.encryptionMode,
      version: 1,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      updatedAt: 1,
    },
    rawSession: {
      id: 'sess-1',
      active,
      metadataVersion: 1,
      ...rawMetadata,
    },
    ...(rawMetadata.encryptionMode === 'plain'
      ? { mode: 'plain' as const, ctx: null }
      : {
          mode: 'e2ee' as const,
          ctx: {
            encryptionKey: new Uint8Array([1, 2, 3, 4]),
            encryptionVariant: 'legacy' as const,
          },
        }),
  };
}

describe('setSessionModel', () => {
  beforeEach(() => {
    vi.useRealTimers();
    callSessionRpc.mockReset();
    resolveSessionTransportContext.mockReset();
    updateSessionMetadataWithRetry.mockReset();
  });

  it('routes an active literal native-default selection to the exact private owner', async () => {
    resolveSessionTransportContext.mockResolvedValue(transport(true));
    callSessionRpc.mockResolvedValue({
      ok: false,
      status: 'restart_required',
      activeSelection: metadata.modelSelectionIntentV1.selection,
      requestedSelection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: null,
        modelId: 'default',
      },
    });

    await expect(setSessionModel({
      credentials,
      idOrPrefix: 'sess-1',
      modelId: 'default',
      providerConnectionId: null,
    })).resolves.toMatchObject({
      ok: false,
      status: 'restart_required',
      requestedSelection: {
        providerConnectionId: null,
        modelId: 'default',
      },
    });

    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: 'sess-1:session.model.transition',
      request: {
        v: 1,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: null,
          modelId: 'default',
        },
      },
    }));
    expect(updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('returns owner_unavailable for an active transport failure without metadata fallback', async () => {
    resolveSessionTransportContext.mockResolvedValue(transport(true));
    callSessionRpc.mockRejectedValue(new Error('runner disconnected'));

    await expect(setSessionModel({
      credentials,
      idOrPrefix: 'sess-1',
      modelId: 'next-model',
    })).resolves.toMatchObject({
      ok: false,
      status: 'owner_unavailable',
      activeSelection: null,
      requestedSelection: {
        providerConnectionId: null,
        modelId: 'next-model',
      },
    });
    expect(updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('inherits an omitted provider id from active binding facts, not a pending restart proposal', async () => {
    resolveSessionTransportContext.mockResolvedValue(transport(true, {
      metadata: JSON.stringify({
      ...metadata,
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
        updatedAt: 11,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_pending',
          modelId: 'pending-restart-model',
        },
      },
      }),
      metadataLayoutVersion: 0,
      encryptionMode: 'plain',
    }));
    callSessionRpc.mockResolvedValue({
      ok: false,
      status: 'restart_required',
      activeSelection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_active',
        modelId: 'active-model',
      },
      requestedSelection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_active',
        modelId: 'next-model',
      },
    });

    await setSessionModel({
      credentials,
      idOrPrefix: 'sess-1',
      modelId: 'next-model',
    });

    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      request: {
        v: 1,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_active',
          modelId: 'next-model',
        },
      },
    }));
  });

  it.each([
    { active: true, expectedProviderConnectionId: 'pc_active' },
    { active: false, expectedProviderConnectionId: 'pc_pending' },
  ])(
    'reads layout-v1 owner target and $active session model facts from the owner envelope',
    async ({ active, expectedProviderConnectionId }) => {
      const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
        v: 1,
        workspace: {
          flavor: 'codex',
        },
        runtime: {
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
            updatedAt: 11,
            selection: {
              agentTargetKey: 'backend:codex',
              providerConnectionId: 'pc_pending',
              modelId: 'pending-restart-model',
            },
          },
        },
      });
      resolveSessionTransportContext.mockResolvedValue(transport(active, {
        metadata: JSON.stringify({
          v: 1,
          agentPresentation: { agentId: 'codex' },
        }),
        metadataLayoutVersion: 1,
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
        encryptionMode: 'plain',
      }));
      callSessionRpc.mockResolvedValue({
        ok: false,
        status: 'restart_required',
        activeSelection: null,
        requestedSelection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: expectedProviderConnectionId,
          modelId: 'next-model',
        },
      });
      updateSessionMetadataWithRetry.mockImplementation(async (input) => ({
        metadata: input.updater({
          flavor: 'codex',
          modelSelectionIntentV1: ownerMetadata.runtime?.modelSelectionIntentV1,
        }),
        version: 2,
      }));

      const result = await setSessionModel({
        credentials,
        idOrPrefix: 'sess-1',
        modelId: 'next-model',
      });

      expect(result).toMatchObject({
        [active ? 'requestedSelection' : 'selection']: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: expectedProviderConnectionId,
          modelId: 'next-model',
        },
      });
    },
  );

  it('fails closed when layout-v1 owner metadata is unreadable', async () => {
    resolveSessionTransportContext.mockResolvedValue(transport(true, {
      metadata: JSON.stringify({
        v: 1,
        agentPresentation: { agentId: 'codex' },
      }),
      metadataLayoutVersion: 1,
      ownerMetadata: {
        t: 'encrypted',
        c: 'not-an-owner-envelope',
      },
      encryptionMode: 'plain',
    }));

    await expect(setSessionModel({
      credentials,
      idOrPrefix: 'sess-1',
      modelId: 'next-model',
    })).resolves.toEqual({ ok: false, code: 'unsupported' });
    expect(callSessionRpc).not.toHaveBeenCalled();
    expect(updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('preserves a session lookup timeout before resolving a model selection', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: false,
      code: 'session_lookup_timeout',
    });

    await expect(setSessionModel({
      credentials,
      idOrPrefix: 'c123456789012345678901234',
      modelId: 'next-model',
    })).resolves.toEqual({ ok: false, code: 'session_lookup_timeout' });

    expect(callSessionRpc).not.toHaveBeenCalled();
    expect(updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('accepts a restart-required source proposal while inactive using owner-assigned order', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    resolveSessionTransportContext.mockResolvedValue(transport(false));
    updateSessionMetadataWithRetry.mockImplementation(async (input) => {
      const next = input.updater(metadata);
      return { metadata: next, version: 2 };
    });

    await expect(setSessionModel({
      credentials,
      idOrPrefix: 'sess-1',
      modelId: 'default',
      providerConnectionId: null,
      updatedAt: 9_999_999,
    })).resolves.toMatchObject({
      ok: true,
      status: 'intent_updated',
      updatedAt: 100,
      selection: {
        providerConnectionId: null,
        modelId: 'default',
      },
    });
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('reroutes an inactive snapshot through the exact live owner when the conditioned metadata CAS observes activation', async () => {
    resolveSessionTransportContext
      .mockResolvedValueOnce(transport(false))
      .mockResolvedValueOnce(transport(true, {
        metadata: JSON.stringify({
          ...metadata,
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
              providerName: 'Provider',
              connectionName: 'Active',
              connectionRole: 'named',
              connectionDisplayNameMode: 'custom',
            },
          },
        }),
        metadataLayoutVersion: 0,
        encryptionMode: 'plain',
      }));
    updateSessionMetadataWithRetry.mockRejectedValue(
      Object.assign(new Error('Session became active'), {
        code: 'session_active' as const,
        retryable: false as const,
      }),
    );
    const liveResult = {
      ok: true as const,
      status: 'applied' as const,
      activeSelection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_active',
        modelId: 'next-model',
      },
    };
    callSessionRpc.mockResolvedValue(liveResult);

    await expect(setSessionModel({
      credentials,
      idOrPrefix: 'sess-1',
      modelId: 'next-model',
    })).resolves.toEqual({
      ...liveResult,
      sessionId: 'sess-1',
    });

    expect(resolveSessionTransportContext).toHaveBeenCalledTimes(2);
    expect(updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
    expect(updateSessionMetadataWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionExpectation: { kind: 'inactive_model_intent' },
      }),
    );
    expect(callSessionRpc).toHaveBeenCalledTimes(1);
    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      method: 'sess-1:session.model.transition',
      request: {
        v: 1,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_active',
          modelId: 'next-model',
        },
      },
    }));
  });

  it('does not retry metadata or invoke an unproven owner after an active conflict', async () => {
    resolveSessionTransportContext
      .mockResolvedValueOnce(transport(false))
      .mockResolvedValueOnce(transport(false));
    updateSessionMetadataWithRetry.mockRejectedValue(
      Object.assign(new Error('Session became active'), {
        code: 'session_active' as const,
        retryable: false as const,
      }),
    );

    await expect(setSessionModel({
      credentials,
      idOrPrefix: 'sess-1',
      modelId: 'next-model',
      providerConnectionId: null,
    })).resolves.toMatchObject({
      ok: false,
      status: 'owner_unavailable',
      sessionId: 'sess-1',
      reason: 'session_model_transition_owner_unproven',
    });

    expect(updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('does not promote a stale CAS retry over a newer accepted intent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    resolveSessionTransportContext.mockResolvedValue(transport(false));
    updateSessionMetadataWithRetry.mockImplementation(async (input) => {
      input.updater(metadata);
      const newer = {
        ...metadata,
        modelSelectionIntentV1: {
          ...metadata.modelSelectionIntentV1,
          updatedAt: 101,
          selection: {
            ...metadata.modelSelectionIntentV1.selection,
            modelId: 'newer-model',
          },
        },
      };
      return { metadata: input.updater(newer), version: 3 };
    });

    await expect(setSessionModel({
      credentials,
      idOrPrefix: 'sess-1',
      modelId: 'stale-model',
    })).resolves.toMatchObject({
      ok: false,
      status: 'superseded',
      requestedSelection: { modelId: 'stale-model' },
    });
  });

  it('refuses an omitted-connection model set when the ACTIVE binding is unreadable', async () => {
    // A present-but-unparsable applied binding cannot prove the runner is
    // native. Publishing a native transition here would ask the live owner to
    // re-point the Session at the Agent's own catalog.
    resolveSessionTransportContext.mockResolvedValue(transport(true, {
      metadata: JSON.stringify({
        flavor: 'codex',
        providerBindingV1: {
          v: 1,
          connectionId: 'pc_active',
          contributionKey: null,
          connectionRevision: 'not-a-number',
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
      }),
      metadataLayoutVersion: 0,
      encryptionMode: 'plain',
    }));

    await expect(setSessionModel({
      credentials,
      idOrPrefix: 'sess-1',
      modelId: 'next-model',
    })).rejects.toMatchObject({
      code: 'model_selection_session_provider_state_unreadable',
    });

    expect(callSessionRpc).not.toHaveBeenCalled();
    expect(updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('refuses an omitted-connection model set when the INACTIVE persisted intent is unreadable', async () => {
    resolveSessionTransportContext.mockResolvedValue(transport(false, {
      metadata: JSON.stringify({
        flavor: 'codex',
        modelSelectionIntentV1: { selection: { providerConnectionId: 'pc_work' } },
      }),
      metadataLayoutVersion: 0,
      encryptionMode: 'plain',
    }));

    await expect(setSessionModel({
      credentials,
      idOrPrefix: 'sess-1',
      modelId: 'next-model',
    })).rejects.toMatchObject({
      code: 'model_selection_session_provider_state_unreadable',
    });

    expect(updateSessionMetadataWithRetry).not.toHaveBeenCalled();
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('still applies an explicitly named connection over unreadable ambient state', async () => {
    resolveSessionTransportContext.mockResolvedValue(transport(false, {
      metadata: JSON.stringify({
        flavor: 'codex',
        modelSelectionIntentV1: { selection: { providerConnectionId: 'pc_work' } },
      }),
      metadataLayoutVersion: 0,
      encryptionMode: 'plain',
    }));
    updateSessionMetadataWithRetry.mockImplementation(async (input) => ({
      metadata: input.updater({ flavor: 'codex' }),
      version: 2,
    }));

    await expect(setSessionModel({
      credentials,
      idOrPrefix: 'sess-1',
      modelId: 'next-model',
      providerConnectionId: 'pc_explicit',
    })).resolves.toMatchObject({
      ok: true,
      status: 'intent_updated',
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_explicit',
        modelId: 'next-model',
      },
    });
  });
});
