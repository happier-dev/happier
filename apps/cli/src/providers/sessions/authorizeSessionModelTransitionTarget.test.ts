import { describe, expect, it, vi } from 'vitest';
import {
  createProviderBindingSecurityFingerprintV1,
  ProviderConnectionIdSchema,
  type ProviderBoundModelRef,
  type ProviderRuntimeBindingBasisV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol';

import {
  authorizeDaemonSessionModelTransitionProviderTarget,
  createSessionModelTransitionAuthorizer,
  resolveDaemonSessionModelTransitionAuthority,
  resolveSessionModelTransitionAuthorizationRoute,
} from './authorizeSessionModelTransitionTarget';
import type {
  AuthorizedSessionModelTransitionTarget,
} from './sessionModelTransitionCoordinator';

type ExternalRuntimeBindingBasis = Extract<
  ProviderRuntimeBindingBasisV1,
  { deployment: { kind: 'external' } }
>;

const native = (modelId: string): ProviderBoundModelRef => ({
  agentTargetKey: 'backend:codex',
  providerConnectionId: null,
  modelId,
});

const provider = (
  connectionId: string,
  modelId: string,
): ProviderBoundModelRef & Readonly<{ providerConnectionId: string }> => ({
  agentTargetKey: 'backend:codex',
  providerConnectionId: ProviderConnectionIdSchema.parse(connectionId),
  modelId,
});

function externalRuntimeBindingBasis(
  selection: ProviderBoundModelRef & Readonly<{ providerConnectionId: string }>,
  applyPolicy: 'live' | 'restart_session' = 'live',
): ExternalRuntimeBindingBasis {
  return {
    v: 1,
    deployment: { kind: 'external' },
    agentTargetKey: selection.agentTargetKey,
    connectionId: selection.providerConnectionId,
    contributionKey: 'provider.test',
    endpoint: {
      endpointTemplateId: 'responses',
      normalizedUrl: 'https://provider.example/v1',
      protocol: 'openai-responses',
      publicHeaders: {},
    },
    runtimeCredentialTransport: {
      id: 'bearer',
      protocols: ['openai-responses'],
      uses: ['runtime'],
      destination: {
        kind: 'httpHeader',
        name: 'authorization',
        format: 'bearer',
      },
    },
    prepared: { v: 1, materialization: 'engineConfig' },
    adapterVersion: 1,
    credentialAuthorization: {
      connectionSecurityFingerprint: 'connection-security',
      grantFingerprint: 'grant',
      selectedSecretBindingId: 'secret-a',
      selectedSecretRecordFingerprint: 'secret-record-a',
    },
    agentSupport: {
      acceptsProtocols: ['openai-responses'],
      required: { streaming: true },
      credentialSupport: {
        supportsNoAuth: false,
        apiKeyTransports: [{
          protocol: 'openai-responses',
          destination: {
            kind: 'httpHeader',
            names: ['authorization'],
            formats: ['bearer'],
          },
        }],
      },
      authIsolation: {
        suppressConnectedServiceIds: [],
        ownedEnvKeys: [],
      },
      materialization: 'engineConfig',
      applyPolicy,
      supportsFreeformModelIds: true,
    },
  };
}

function active(
  selection: ProviderBoundModelRef,
  input?: Readonly<{
    runtimeBindingBasis?: ProviderRuntimeBindingBasisV1;
    managedPurposeBindings?: QualifiedConnectedAccountPurposeBindingsV1;
  }>,
): AuthorizedSessionModelTransitionTarget {
  return {
    selection,
    policy: 'live',
    providerBinding: null,
    sessionBindingMetadata: selection.providerConnectionId
      ? {
          v: 1,
          connectionId: selection.providerConnectionId,
          contributionKey: 'provider.test',
          connectionRevision: 1,
          model: { id: selection.modelId, name: selection.modelId },
          ...(input?.managedPurposeBindings
            ? { managedPurposeBindings: input.managedPurposeBindings }
            : {}),
          protocol: 'openai-responses',
          materialization: 'engineConfig',
          compatibilityFingerprint: 'compatibility',
          bindingSecurityFingerprint: 'binding-security',
          ...(input?.runtimeBindingBasis
            ? { runtimeBindingBasis: input.runtimeBindingBasis }
            : {}),
          displaySnapshot: {
            providerName: 'Provider',
            connectionName: 'Provider',
            connectionRole: 'default',
            connectionDisplayNameMode: 'automatic',
          },
        }
      : null,
    runtimeBindingBasis: input?.runtimeBindingBasis ?? null,
    revalidateBeforeEffect: async () => true,
  };
}

describe('createSessionModelTransitionAuthorizer routing', () => {
  it('retains the active Provider materialization when restart-only reauthorization proves the exact active selection and runtime basis', async () => {
    const selection = provider('pc_restart_only', 'model-active');
    const basis = externalRuntimeBindingBasis(
      selection,
      'restart_session',
    );
    const activeTarget = {
      ...active(selection, { runtimeBindingBasis: basis }),
      providerBinding: {
        connectionId: selection.providerConnectionId,
        upstream: {
          protocol: basis.endpoint.protocol,
          normalizedUrl: basis.endpoint.normalizedUrl,
          credential: 'apiKey',
        },
        model: { id: selection.modelId, name: selection.modelId },
        materialization: {
          v: 1,
          kind: 'engineConfig',
          engineConfig: {},
        },
      },
    } satisfies AuthorizedSessionModelTransitionTarget;
    const authorizeProviderTarget = vi.fn(async () => ({
      selection,
      policy: 'restart_session' as const,
      model: activeTarget.providerBinding.model,
      sessionBindingMetadata: activeTarget.sessionBindingMetadata!,
      runtimeBindingBasis: basis,
    }));
    const authorize = createSessionModelTransitionAuthorizer({
      sessionId: 'session-restart-only',
      machineId: 'machine-a',
      agentId: 'codex',
      agentTargetKey: selection.agentTargetKey,
      nativeModelApplyPolicy: 'restart_session',
      readActiveTarget: () => activeTarget,
      authorizeProviderTarget,
    });

    await expect(authorize(selection)).resolves.toMatchObject({
      selection,
      policy: 'restart_session',
      providerBinding: {
        ...activeTarget.providerBinding,
        upstream: {
          protocol: 'openai-responses',
          normalizedUrl: 'https://provider.example/v1',
          credential: 'apiKey',
        },
      },
      sessionBindingMetadata: activeTarget.sessionBindingMetadata,
      runtimeBindingBasis: basis,
    });
  });

  it('does not retain the active Provider materialization for a restart-only model change', async () => {
    const activeSelection = provider('pc_restart_only', 'model-active');
    const selection = provider('pc_restart_only', 'model-next');
    const basis = externalRuntimeBindingBasis(
      activeSelection,
      'restart_session',
    );
    const activeTarget = {
      ...active(activeSelection, { runtimeBindingBasis: basis }),
      providerBinding: {
        connectionId: activeSelection.providerConnectionId,
        upstream: {
          protocol: basis.endpoint.protocol,
          normalizedUrl: basis.endpoint.normalizedUrl,
          credential: 'apiKey',
        },
        model: {
          id: activeSelection.modelId,
          name: activeSelection.modelId,
        },
        materialization: {
          v: 1,
          kind: 'engineConfig',
          engineConfig: {},
        },
      },
    } satisfies AuthorizedSessionModelTransitionTarget;
    const authorize = createSessionModelTransitionAuthorizer({
      sessionId: 'session-restart-only-model-change',
      machineId: 'machine-a',
      agentId: 'codex',
      agentTargetKey: selection.agentTargetKey,
      nativeModelApplyPolicy: 'restart_session',
      readActiveTarget: () => activeTarget,
      authorizeProviderTarget: async () => ({
        selection,
        policy: 'restart_session',
        model: { id: selection.modelId, name: selection.modelId },
        sessionBindingMetadata: {
          ...activeTarget.sessionBindingMetadata!,
          model: { id: selection.modelId, name: selection.modelId },
        },
        runtimeBindingBasis: basis,
      }),
    });

    await expect(authorize(selection)).resolves.toMatchObject({
      selection,
      policy: 'restart_session',
      providerBinding: null,
    });
  });

  it('does not retain the active Provider materialization when restart-only reauthorization changes the runtime basis', async () => {
    const selection = provider('pc_restart_only', 'model-active');
    const basis = externalRuntimeBindingBasis(
      selection,
      'restart_session',
    );
    const changedBasis = {
      ...basis,
      endpoint: {
        ...basis.endpoint,
        normalizedUrl: 'https://changed.example/v1',
      },
    } satisfies ProviderRuntimeBindingBasisV1;
    const activeTarget = {
      ...active(selection, { runtimeBindingBasis: basis }),
      providerBinding: {
        connectionId: selection.providerConnectionId,
        upstream: {
          protocol: basis.endpoint.protocol,
          normalizedUrl: basis.endpoint.normalizedUrl,
          credential: 'apiKey',
        },
        model: { id: selection.modelId, name: selection.modelId },
        materialization: {
          v: 1,
          kind: 'engineConfig',
          engineConfig: {},
        },
      },
    } satisfies AuthorizedSessionModelTransitionTarget;
    const authorize = createSessionModelTransitionAuthorizer({
      sessionId: 'session-restart-only-basis-change',
      machineId: 'machine-a',
      agentId: 'codex',
      agentTargetKey: selection.agentTargetKey,
      nativeModelApplyPolicy: 'restart_session',
      readActiveTarget: () => activeTarget,
      authorizeProviderTarget: async () => ({
        selection,
        policy: 'restart_session',
        model: activeTarget.providerBinding.model,
        sessionBindingMetadata: {
          ...activeTarget.sessionBindingMetadata!,
          runtimeBindingBasis: changedBasis,
        },
        runtimeBindingBasis: changedBasis,
      }),
    });

    await expect(authorize(selection)).resolves.toMatchObject({
      selection,
      policy: 'restart_session',
      providerBinding: null,
    });
  });

  it('replaces child-authored Provider authority with the daemon-tracked session facts', async () => {
    const trackedSelection = provider('pc_restarted', 'model-at-launch');
    const runtimeBindingBasis = externalRuntimeBindingBasis(trackedSelection);
    const activeTargetBase = active(
      trackedSelection,
      { runtimeBindingBasis },
    );
    const activeModel = activeTargetBase.sessionBindingMetadata?.model;
    const runtimeCredentialTransport =
      runtimeBindingBasis.runtimeCredentialTransport;
    if (!activeModel || !runtimeCredentialTransport) {
      throw new Error('Expected an exact external Provider binding fixture');
    }
    const activeTarget = {
      ...activeTargetBase,
      sessionBindingMetadata: {
        ...activeTargetBase.sessionBindingMetadata!,
        bindingSecurityFingerprint:
          createProviderBindingSecurityFingerprintV1({
            agentTargetKey: runtimeBindingBasis.agentTargetKey,
            connectionId: runtimeBindingBasis.connectionId,
            modelId: activeModel.id,
            modelCapabilities: {},
            endpointTemplateId:
              runtimeBindingBasis.endpoint.endpointTemplateId,
            endpointUrl: runtimeBindingBasis.endpoint.normalizedUrl,
            protocol: runtimeBindingBasis.endpoint.protocol,
            publicHeaders: runtimeBindingBasis.endpoint.publicHeaders,
            materialization:
              runtimeBindingBasis.prepared.materialization,
            credentialDestination:
              runtimeCredentialTransport.destination,
            compatibilityFingerprint:
              activeTargetBase.sessionBindingMetadata!
                .compatibilityFingerprint,
            adapterVersion: runtimeBindingBasis.adapterVersion,
          }),
      },
    } satisfies AuthorizedSessionModelTransitionTarget;

    const requestedSelection = {
      ...trackedSelection,
      modelId: 'requested-next-model',
    };
    const authority = resolveDaemonSessionModelTransitionAuthority({
      trackedAgentId: 'codex',
      trackedSelection,
      trackedSessionBindingMetadata:
        activeTarget.sessionBindingMetadata!,
      requestAgentId: 'codex',
      requestedSelection,
    });
    expect(authority).toEqual({
      agentId: 'codex',
      agentTargetKey: trackedSelection.agentTargetKey,
      input: {
        selection: {
          ...trackedSelection,
          modelId: 'requested-next-model',
        },
        activeSelection: trackedSelection,
        activeSessionBindingMetadata:
          activeTarget.sessionBindingMetadata,
      },
    });

    const authorizeProviderTarget = vi.fn();
    await expect(authorizeDaemonSessionModelTransitionProviderTarget({
      trackedAgentId: 'codex',
      trackedSelection,
      trackedSessionBindingMetadata:
        activeTarget.sessionBindingMetadata!,
      requestAgentId: 'codex',
      requestedSelection: {
        ...requestedSelection,
        providerConnectionId:
          ProviderConnectionIdSchema.parse('pc_attacker-controlled'),
      },
      authorizeProviderTarget,
    })).rejects.toThrow(
      'session_model_transition_daemon_authority_mismatch',
    );
    expect(authorizeProviderTarget).not.toHaveBeenCalled();

    expect(() => resolveDaemonSessionModelTransitionAuthority({
      trackedAgentId: 'codex',
      trackedSelection,
      trackedSessionBindingMetadata: {
        ...activeTarget.sessionBindingMetadata!,
        contributionKey: 'provider.incoherent',
      },
      requestAgentId: 'codex',
      requestedSelection,
    })).toThrow('session_model_transition_daemon_authority_mismatch');
  });

  it('accepts an exact authorized external Agent only when catalog identity is absent', () => {
    const externalAgentId = 'public-handoff-agent';
    const trackedSelection = {
      ...provider('pc_external_agent', 'model-at-launch'),
      agentTargetKey: `backend:${externalAgentId}`,
    };
    const runtimeBindingBasis = {
      ...externalRuntimeBindingBasis(trackedSelection),
      agentTargetKey: trackedSelection.agentTargetKey,
    };
    const trackedSessionBindingMetadataBase = active(
      trackedSelection,
      { runtimeBindingBasis },
    ).sessionBindingMetadata!;
    const runtimeCredentialTransport =
      runtimeBindingBasis.runtimeCredentialTransport;
    const trackedModel = trackedSessionBindingMetadataBase.model;
    if (!runtimeCredentialTransport || !trackedModel) {
      throw new Error('Expected the external Provider fixture binding');
    }
    const trackedSessionBindingMetadata = {
      ...trackedSessionBindingMetadataBase,
      bindingSecurityFingerprint:
        createProviderBindingSecurityFingerprintV1({
          agentTargetKey: runtimeBindingBasis.agentTargetKey,
          connectionId: runtimeBindingBasis.connectionId,
          modelId: trackedModel.id,
          modelCapabilities: {},
          endpointTemplateId:
            runtimeBindingBasis.endpoint.endpointTemplateId,
          endpointUrl: runtimeBindingBasis.endpoint.normalizedUrl,
          protocol: runtimeBindingBasis.endpoint.protocol,
          publicHeaders: runtimeBindingBasis.endpoint.publicHeaders,
          materialization:
            runtimeBindingBasis.prepared.materialization,
          credentialDestination:
            runtimeCredentialTransport.destination,
          compatibilityFingerprint:
            trackedSessionBindingMetadataBase.compatibilityFingerprint,
          adapterVersion: runtimeBindingBasis.adapterVersion,
        }),
    };
    const requestedSelection = {
      ...trackedSelection,
      modelId: 'requested-next-model',
    };
    const resolve = (input: Readonly<{
      trackedAgentId: string | null;
      authorizedAgentId: string | null;
      requestAgentId: string;
    }>) => resolveDaemonSessionModelTransitionAuthority({
      ...input,
      trackedSelection,
      trackedSessionBindingMetadata,
      requestedSelection,
    });

    expect(resolve({
      trackedAgentId: null,
      authorizedAgentId: externalAgentId,
      requestAgentId: externalAgentId,
    })).toMatchObject({
      agentId: externalAgentId,
      agentTargetKey: trackedSelection.agentTargetKey,
    });
    expect(() => resolve({
      trackedAgentId: 'codex',
      authorizedAgentId: externalAgentId,
      requestAgentId: externalAgentId,
    })).toThrow('session_model_transition_daemon_authority_mismatch');
    expect(() => resolve({
      trackedAgentId: null,
      authorizedAgentId: null,
      requestAgentId: externalAgentId,
    })).toThrow('session_model_transition_daemon_authority_mismatch');
    expect(() => resolve({
      trackedAgentId: null,
      authorizedAgentId: 'different-external-agent',
      requestAgentId: externalAgentId,
    })).toThrow('session_model_transition_daemon_authority_mismatch');
  });

  it('uses the daemon-authoritative Provider resolver carried by a restarted child', async () => {
    const selection = provider('pc_restarted', 'model-a');
    const basis = {
      v: 1,
      deployment: { kind: 'external' },
      agentTargetKey: selection.agentTargetKey,
      connectionId: selection.providerConnectionId!,
      contributionKey: 'provider.test',
      endpoint: {
        endpointTemplateId: 'responses',
        normalizedUrl: 'https://provider.example/v1',
        protocol: 'openai-responses',
        publicHeaders: {},
      },
      runtimeCredentialTransport: {
        id: 'bearer',
        protocols: ['openai-responses'],
        uses: ['runtime'],
        destination: {
          kind: 'httpHeader',
          name: 'authorization',
          format: 'bearer',
        },
      },
      prepared: { v: 1, materialization: 'spawnEnv' },
      adapterVersion: 1,
      credentialAuthorization: {
        connectionSecurityFingerprint: 'connection-security',
        grantFingerprint: 'grant',
        selectedSecretBindingId: 'secret-a',
        selectedSecretRecordFingerprint: 'secret-record-a',
      },
      agentSupport: {
        acceptsProtocols: ['openai-responses'],
        required: { streaming: true },
        credentialSupport: {
          supportsNoAuth: false,
          apiKeyTransports: [{
            protocol: 'openai-responses',
            destination: {
              kind: 'httpHeader',
              names: ['authorization'],
              formats: ['bearer'],
            },
          }],
        },
        authIsolation: {
          suppressConnectedServiceIds: [],
          ownedEnvKeys: [],
        },
        materialization: 'spawnEnv',
        applyPolicy: 'live',
        supportsFreeformModelIds: true,
      },
    } satisfies ProviderRuntimeBindingBasisV1;
    const activeTarget = {
      ...active(selection, { runtimeBindingBasis: basis }),
      providerBinding: {
        connectionId: selection.providerConnectionId!,
        upstream: {
          protocol: basis.endpoint.protocol,
          normalizedUrl: basis.endpoint.normalizedUrl,
          credential: 'apiKey',
        },
        model: { id: selection.modelId, name: selection.modelId },
        materialization: { v: 1, kind: 'spawnEnv' },
      },
    } satisfies AuthorizedSessionModelTransitionTarget;
    let bindingSecurityFingerprint =
      activeTarget.sessionBindingMetadata!.bindingSecurityFingerprint;
    const authorizeProviderTarget = vi.fn(async () => ({
      selection,
      policy: 'live' as const,
      model: { id: selection.modelId, name: selection.modelId },
      sessionBindingMetadata: {
        ...activeTarget.sessionBindingMetadata!,
        bindingSecurityFingerprint,
      },
      runtimeBindingBasis: basis,
    }));
    const authorize = createSessionModelTransitionAuthorizer({
      sessionId: 'session-restarted',
      machineId: 'machine-a',
      agentId: 'codex',
      agentTargetKey: 'backend:codex',
      nativeModelApplyPolicy: 'live',
      readActiveTarget: () => activeTarget,
      authorizeProviderTarget,
    } as Parameters<typeof createSessionModelTransitionAuthorizer>[0] & {
      authorizeProviderTarget: typeof authorizeProviderTarget;
    });

    const authorizedTarget = await authorize(selection);
    expect(authorizedTarget).toMatchObject({
      selection,
      policy: 'live',
      providerBinding: {
        connectionId: selection.providerConnectionId,
        materialization: activeTarget.providerBinding.materialization,
      },
      sessionBindingMetadata: activeTarget.sessionBindingMetadata,
      runtimeBindingBasis: basis,
    });
    await expect(authorizedTarget.revalidateBeforeEffect()).resolves.toBe(true);

    bindingSecurityFingerprint = 'binding-security-revoked-or-changed';
    await expect(authorizedTarget.revalidateBeforeEffect()).resolves.toBe(false);

    authorizeProviderTarget.mockRejectedValueOnce(
      new Error('provider_connection_not_found'),
    );
    await expect(authorizedTarget.revalidateBeforeEffect()).rejects.toThrow(
      'provider_connection_not_found',
    );

    authorizeProviderTarget.mockResolvedValueOnce({
      selection: { ...selection, modelId: 'unauthorized-model' },
      policy: 'live',
      model: { id: 'unauthorized-model', name: 'Unauthorized' },
      sessionBindingMetadata:
        activeTarget.sessionBindingMetadata!,
      runtimeBindingBasis: basis,
    });
    await expect(authorize(selection)).rejects.toThrow(
      'session_model_transition_authorized_selection_mismatch',
    );
  });

  it.each([
    ['native to Provider', active(native('native')), provider('pc_managed', 'next')],
    ['different Provider connection', active(provider('pc_old', 'old')), provider('pc_managed', 'next')],
    ['older same-connection metadata without a basis', active(provider('pc_managed', 'old')), provider('pc_managed', 'next')],
  ] as const)('returns restart for %s without entering Provider authorization', async (
    _label,
    activeTarget,
    selection,
  ) => {
    const authorize = createSessionModelTransitionAuthorizer({
      sessionId: 'session-1',
      machineId: 'machine-a',
      agentId: 'codex',
      agentTargetKey: 'backend:codex',
      nativeModelApplyPolicy: 'live',
      readActiveTarget: () => activeTarget,
    });

    await expect(authorize(selection)).resolves.toMatchObject({
      selection,
      policy: 'restart_session',
      providerBinding: null,
      runtimeBindingBasis: null,
    });
  });

  it('classifies a restart-only Agent native model change before runtime effect', async () => {
    const activeTarget = active(native('native-old'));
    const authorize = createSessionModelTransitionAuthorizer({
      sessionId: 'session-1',
      machineId: 'machine-a',
      agentId: 'gemini',
      agentTargetKey: 'backend:gemini',
      nativeModelApplyPolicy: 'restart_session',
      readActiveTarget: () => activeTarget,
    });
    const selection = {
      agentTargetKey: 'backend:gemini',
      providerConnectionId: null,
      modelId: 'native-next',
    } as const;

    await expect(authorize(selection)).resolves.toMatchObject({
      selection,
      policy: 'restart_session',
      providerBinding: null,
      runtimeBindingBasis: null,
    });
  });

  it('routes the immutable managed launch-purpose snapshot into same-binding authorization', () => {
    const selection = provider('pc_managed', 'old');
    const purposes: QualifiedConnectedAccountPurposeBindingsV1 = {
      v: 1,
      bindings: [{
        purpose: {
          consumer: { pluginId: 'provider.test', localId: 'gateway' },
          purpose: 'upstream',
        },
        target: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'connected.test',
              localId: 'account',
            },
            accountId: 'account-a',
          },
        },
      }],
    };
    const basis = {
      v: 1,
      deployment: {
        kind: 'managedLocal',
        implementationIdentity: {
          pluginId: 'provider.test',
          localId: 'gateway',
        },
        managedRuntime: {
          kind: 'managed',
          dependencies: [],
          endpointTemplateIds: ['responses'],
          connectedAccounts: [{
            purpose: 'upstream',
            service: {
              pluginId: 'connected.test',
              localId: 'account',
            },
            required: true,
          }],
          requestAuthUses: [{
            purpose: 'upstream',
            materialization: {
              kind: 'httpHeaders',
              origin: 'https://api.example.test',
              headerNames: ['authorization'],
            },
          }],
        },
        purposeBindings: purposes,
      },
      agentTargetKey: 'backend:codex',
      connectionId: selection.providerConnectionId!,
      contributionKey: 'provider.test',
      endpoint: {
        endpointTemplateId: 'responses',
        protocol: 'openai-responses',
        publicHeaders: {},
      },
      runtimeCredentialTransport: {
        id: 'managed-runtime-bearer',
        protocols: ['openai-responses'],
        uses: ['runtime'],
        destination: {
          kind: 'httpHeader',
          name: 'authorization',
          format: 'bearer',
        },
      },
      prepared: { v: 1, materialization: 'engineConfig' },
      adapterVersion: 1,
      credentialAuthorization: {
        connectionSecurityFingerprint: 'connection-security',
        grantFingerprint: 'grant',
      },
      agentSupport: {
        acceptsProtocols: ['openai-responses'],
        required: { streaming: true },
        credentialSupport: {
          supportsNoAuth: false,
          apiKeyTransports: [],
        },
        authIsolation: {
          suppressConnectedServiceIds: [],
          ownedEnvKeys: [],
        },
        materialization: 'engineConfig',
        applyPolicy: 'live',
        supportsFreeformModelIds: true,
      },
    } satisfies ProviderRuntimeBindingBasisV1;

    expect(resolveSessionModelTransitionAuthorizationRoute(
      active(selection, {
        runtimeBindingBasis: basis,
        managedPurposeBindings: purposes,
      }),
      provider('pc_managed', 'next'),
    )).toEqual({
      kind: 'authorize_same_binding',
      managedPurposeBindingSnapshot: purposes,
    });
  });
});
