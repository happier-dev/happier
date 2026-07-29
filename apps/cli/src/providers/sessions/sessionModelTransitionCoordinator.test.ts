import { describe, expect, it, vi } from 'vitest';

import {
  ProviderConnectionIdSchema,
  type ProviderConnectionId,
  type ProviderBoundModelRef,
  type ProviderRuntimeBindingBasisV1,
  type SessionProviderBindingMetadataV1,
} from '@happier-dev/protocol';
import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agent-runtime';

import {
  createSessionModelTransitionAuthorizer,
} from './authorizeSessionModelTransitionTarget';
import {
  createSessionModelTransitionCoordinator,
  mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult,
  type AuthorizedSessionModelTransitionTarget,
  type SessionModelTransitionApplyResult,
} from './sessionModelTransitionCoordinator';

const native = (modelId: string): ProviderBoundModelRef => ({
  agentTargetKey: 'backend:claude',
  providerConnectionId: null,
  modelId,
});

const provider = (
  connectionId: string,
  modelId: string,
): ProviderBoundModelRef => ({
  agentTargetKey: 'backend:claude',
  providerConnectionId: ProviderConnectionIdSchema.parse(connectionId),
  modelId,
});

const runtimeBindingBasis = (
  connectionId: ProviderConnectionId,
  normalizedUrl = 'https://provider.example/v1',
  applyPolicy: 'live' | 'restart_session' = 'live',
): ProviderRuntimeBindingBasisV1 => ({
  v: 1,
  deployment: { kind: 'external' },
  agentTargetKey: 'backend:claude',
  connectionId,
  contributionKey: 'provider.test',
  endpoint: {
    endpointTemplateId: 'messages',
    normalizedUrl,
    protocol: 'anthropic',
    publicHeaders: {},
  },
  runtimeCredentialTransport: {
    id: 'bearer',
    protocols: ['anthropic'],
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
    acceptsProtocols: ['anthropic'],
    required: { streaming: true },
    credentialSupport: {
      supportsNoAuth: false,
      apiKeyTransports: [{
        protocol: 'anthropic',
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
    applyPolicy,
    supportsFreeformModelIds: true,
  },
});

function managedRuntimeBindingBasis(
  connectionId: ProviderConnectionId,
  purposes: readonly string[],
  applyPolicy: 'live' | 'restart_session' = 'restart_session',
): Extract<
  ProviderRuntimeBindingBasisV1,
  { deployment: { kind: 'managedLocal' } }
> {
  const purposeBindings = {
    v: 1 as const,
    bindings: purposes.map((purpose) => ({
      purpose: {
        consumer: {
          pluginId: 'provider.test',
          localId: 'gateway',
        },
        purpose,
      },
      target: {
        kind: 'account' as const,
        account: {
          service: {
            pluginId: 'connected.test',
            localId: 'account',
          },
          accountId: `account-${purpose}`,
        },
      },
    })),
  };
  return {
    v: 1,
    deployment: {
      kind: 'managedLocal',
      securityFacts: {
        implementationIdentity: {
          pluginId: 'provider.test',
          localId: 'gateway',
        },
        managedEndpoint: {
          localService: {
            id: 'gateway',
            launch: {
              kind: 'packaged-runtime-binary',
              directorySegments: ['gateway'],
              executableBaseName: 'gateway',
              privateConfigPathFlag: '--config',
            },
            launchMode: {
              kind: 'assignAndInject',
              portPolicy: { kind: 'allocated' },
            },
            hostPolicy: { kind: 'loopback' },
            name: { strategy: 'fixed', name: 'Gateway' },
            healthCheck: { kind: 'http', path: '/health' },
            restart: { kind: 'never' },
            cleanup: { staleAfterMs: 60_000 },
          },
          protocols: ['anthropic'],
        },
        connectedAccounts: purposes.map((purpose) => ({
          purpose,
          service: {
            pluginId: 'connected.test',
            localId: 'account',
          },
          required: true,
        })),
        requestAuthUses: purposes.map((purpose) => ({
          purpose,
          materialization: {
            kind: 'httpHeaders' as const,
            origin: `https://${purpose}.example.test`,
            headerNames: ['authorization'],
          },
        })),
      },
      purposeBindings,
    },
    agentTargetKey: 'backend:claude',
    connectionId,
    contributionKey: 'provider.test',
    endpoint: {
      endpointTemplateId: 'messages',
      protocol: 'anthropic',
      publicHeaders: {},
    },
    runtimeCredentialTransport: {
      id: 'managed-runtime-bearer',
      protocols: ['anthropic'],
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
    },
    agentSupport: {
      acceptsProtocols: ['anthropic'],
      required: { streaming: true },
      credentialSupport: {
        supportsNoAuth: false,
        apiKeyTransports: [],
      },
      authIsolation: {
        suppressConnectedServiceIds: [],
        ownedEnvKeys: [],
      },
      materialization: 'spawnEnv',
      applyPolicy,
      supportsFreeformModelIds: true,
    },
  };
}

const providerBindingMetadata = (
  connectionId: ProviderConnectionId,
  modelId: string,
): SessionProviderBindingMetadataV1 => ({
  v: 1,
  connectionId,
  contributionKey: 'provider.test',
  connectionRevision: 1,
  model: { id: modelId, name: modelId },
  protocol: 'anthropic',
  materialization: 'spawnEnv',
  compatibilityFingerprint: 'compatible',
  bindingSecurityFingerprint: `security:${modelId}`,
  runtimeBindingBasis: runtimeBindingBasis(connectionId),
  displaySnapshot: {
    providerName: 'Test Provider',
    connectionName: 'Test connection',
    connectionRole: 'default',
    connectionDisplayNameMode: 'automatic',
  },
});

const runtimeBinding = (
  connectionId: ProviderConnectionId,
  modelId: string,
): AgentSessionProviderBinding => ({
  connectionId,
  model: { id: modelId, name: modelId },
  materialization: { v: 1, kind: 'spawnEnv' },
});

function authorized(
  selection: ProviderBoundModelRef,
  policy: AuthorizedSessionModelTransitionTarget['policy'] = 'live',
): AuthorizedSessionModelTransitionTarget {
  const connectionId = selection.providerConnectionId;
  return {
    selection,
    policy,
    providerBinding: connectionId
      ? runtimeBinding(connectionId, selection.modelId)
      : null,
    sessionBindingMetadata: connectionId
      ? providerBindingMetadata(connectionId, selection.modelId)
      : null,
    runtimeBindingBasis: connectionId
      ? runtimeBindingBasis(connectionId)
      : null,
    revalidateBeforeEffect: async () => true,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createHarness(params?: Readonly<{
  initial?: ProviderBoundModelRef;
  initialTarget?: AuthorizedSessionModelTransitionTarget;
  authoritativeRuntimeReadback?: boolean;
  readRuntimeModelId?: () => Promise<string | null> | string | null;
  subscribeRuntimeModelChanges?: (handler: () => void) => () => void;
}>) {
  let current =
    params?.initialTarget?.selection
    ?? params?.initial
    ?? provider('pc_work', 'old');
  let currentRun = true;
  const events: string[] = [];
  const authorize = vi.fn(async (selection: ProviderBoundModelRef) => authorized(selection));
  const publishIntent = vi.fn<
    (
      selection: ProviderBoundModelRef,
    ) => Promise<Readonly<{ accepted: boolean; updatedAt: number }>>
  >(async (selection) => {
    events.push(`intent:${selection.modelId}`);
    return { accepted: true, updatedAt: Date.now() };
  });
  const applyRuntime = vi.fn<
    (
      target: AuthorizedSessionModelTransitionTarget,
    ) => Promise<SessionModelTransitionApplyResult>
  >(async (target) => {
    events.push(`apply:${target.selection.modelId}`);
    current = target.selection;
    return { status: 'applied' as const };
  });
  const publishActive = vi.fn(async (target: AuthorizedSessionModelTransitionTarget) => {
    events.push(`active:${target.selection.modelId}`);
  });
  const fence = vi.fn(async () => {
    events.push('fence');
  });
  const unfence = vi.fn(async () => {
    events.push('unfence');
  });
  const transferPromptAdmission = vi.fn(
    async (
      _epochId: string,
      opts: Readonly<{
        abortSignal: AbortSignal;
        dispatch: () => Promise<void>;
      }>,
    ) => {
      events.push('transfer');
      if (opts.abortSignal.aborted) return { status: 'cancelled' as const };
      await opts.dispatch();
      return { status: 'dispatched' as const, value: undefined };
    },
  );
  const coordinator = createSessionModelTransitionCoordinator({
    runId: 'run-1',
    agentTargetKey: 'backend:claude',
    initialActiveTarget: params?.initialTarget ?? authorized(current),
    isCurrentRun: () => currentRun,
    authorize,
    publishIntent,
    applyRuntime,
    publishActive,
    fencePromptAdmission: fence,
    clearPromptAdmission: unfence,
    transferPromptAdmission,
    ...(params?.readRuntimeModelId || params?.authoritativeRuntimeReadback
      ? {
          readRuntimeModelId:
            params.readRuntimeModelId ?? (() => current.modelId),
        }
      : {}),
    ...(params?.subscribeRuntimeModelChanges
      ? { subscribeRuntimeModelChanges: params.subscribeRuntimeModelChanges }
      : {}),
  });
  return {
    coordinator,
    authorize,
    publishIntent,
    applyRuntime,
    publishActive,
    fence,
    unfence,
    transferPromptAdmission,
    events,
    readCurrent: () => current,
    retireRun: () => {
      currentRun = false;
    },
  };
}

describe('createSessionModelTransitionCoordinator', () => {
  it('does not treat a legacy void runtime outcome as authoritative transition proof', () => {
    expect(
      mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult(
        undefined,
      ),
    ).toEqual({
      status: 'unproven',
      reason: 'runtime_model_transition_outcome_unproven',
      readbackAfterCompletion: true,
    });
    expect(
      mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult({
        status: 'applied',
      }),
    ).toEqual({ status: 'applied' });
  });

  it('fences, applies the exact structured Provider binding, publishes active facts, then unfences', async () => {
    const harness = createHarness();
    const next = provider('pc_work', 'next');

    await expect(harness.coordinator.submit(next, { source: 'command' })).resolves.toMatchObject({
      ok: true,
      status: 'applied',
      activeSelection: next,
    });

    expect(harness.applyRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: next,
        providerBinding: expect.objectContaining({
          connectionId: 'pc_work',
          model: expect.objectContaining({ id: 'next' }),
        }),
      }),
    );
    expect(harness.events).toEqual([
      'intent:next',
      'fence',
      'apply:next',
      'active:next',
      'unfence',
    ]);
  });

  it.each([
    [native('native-next'), 'native to Provider', provider('pc_work', 'provider-next')],
    [provider('pc_work', 'old'), 'Provider to native', native('native-next')],
    [provider('pc_work', 'old'), 'Provider A to B', provider('pc_other', 'next')],
  ] as const)(
    'keeps the old active target and publishes only pending intent for restart-required %s',
    async (initial, _label, next) => {
      const harness = createHarness({ initial });
      harness.authorize.mockResolvedValueOnce(authorized(next, 'restart_session'));

      await expect(harness.coordinator.submit(next, { source: 'command' })).resolves.toMatchObject({
        ok: false,
        status: 'restart_required',
        activeSelection: initial,
        requestedSelection: next,
      });

      expect(harness.publishIntent).toHaveBeenCalledWith(next);
      expect(harness.applyRuntime).not.toHaveBeenCalled();
      expect(harness.fence).not.toHaveBeenCalled();
      expect(harness.publishActive).not.toHaveBeenCalled();
    },
  );

  it('rolls the runtime back before releasing the fence when active-fact publication fails', async () => {
    const harness = createHarness({ authoritativeRuntimeReadback: true });
    harness.publishActive.mockRejectedValueOnce(new Error('metadata unavailable'));

    await expect(
      harness.coordinator.submit(provider('pc_work', 'next'), { source: 'command' }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'publication_failed_rolled_back',
      activeSelection: provider('pc_work', 'old'),
    });

    expect(harness.applyRuntime.mock.calls.map(([target]) => target.selection.modelId))
      .toEqual(['next', 'old']);
    expect(harness.unfence).toHaveBeenCalledTimes(1);
  });

  it('does not suppress contradictory forward-model evidence during rollback', async () => {
    let runtimeModelId = 'old';
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const harness = createHarness({
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    harness.publishActive.mockRejectedValueOnce(
      new Error('metadata unavailable'),
    );
    harness.applyRuntime
      .mockImplementationOnce(async (target) => {
        runtimeModelId = target.selection.modelId;
        return { status: 'applied' };
      })
      .mockImplementationOnce(async () => {
        runtimeModelId = 'next';
        notifyRuntimeModelChange(runtimeModelId);
        return { status: 'applied' };
      });

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      reason: 'runtime_model_drift_observed_during_rollback',
    });
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('does not release a retired run fence after rollback fact publication completes late', async () => {
    const harness = createHarness({ authoritativeRuntimeReadback: true });
    const rollbackPublication = deferred<void>();
    harness.publishActive
      .mockRejectedValueOnce(new Error('metadata unavailable'))
      .mockImplementationOnce(async () => await rollbackPublication.promise);

    const result = harness.coordinator.submit(
      provider('pc_work', 'next'),
      { source: 'command' },
    );
    await vi.waitFor(() => expect(harness.publishActive).toHaveBeenCalledTimes(2));
    harness.retireRun();
    rollbackPublication.resolve();

    await expect(result).resolves.toMatchObject({
      ok: false,
      status: 'owner_unavailable',
    });
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('does not roll a retired run back when active-fact publication rejects late', async () => {
    const harness = createHarness();
    let rejectActivePublication!: (error: Error) => void;
    const activePublication = new Promise<void>((_resolve, reject) => {
      rejectActivePublication = reject;
    });
    harness.publishActive.mockImplementationOnce(
      async () => await activePublication,
    );

    const result = harness.coordinator.submit(
      provider('pc_work', 'next'),
      { source: 'command' },
    );
    await vi.waitFor(() => expect(harness.publishActive).toHaveBeenCalledTimes(1));
    harness.retireRun();
    rejectActivePublication(new Error('metadata unavailable'));

    await expect(result).resolves.toMatchObject({
      ok: false,
      status: 'owner_unavailable',
    });
    expect(harness.applyRuntime).toHaveBeenCalledTimes(1);
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('keeps input and later transitions fenced when publication and rollback cannot be proven', async () => {
    const harness = createHarness();
    harness.publishActive.mockRejectedValueOnce(new Error('metadata unavailable'));
    harness.applyRuntime
      .mockResolvedValueOnce({ status: 'applied' })
      .mockResolvedValueOnce({ status: 'failed', reason: 'rollback failed' });

    await expect(
      harness.coordinator.submit(provider('pc_work', 'next'), { source: 'command' }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
    });
    await expect(
      harness.coordinator.submit(provider('pc_work', 'later'), { source: 'command' }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
    });

    expect(harness.unfence).not.toHaveBeenCalled();
    expect(harness.applyRuntime).toHaveBeenCalledTimes(2);
  });

  it('keeps known old active truth when rollback applied but reconciliation publication failed', async () => {
    const harness = createHarness({ authoritativeRuntimeReadback: true });
    harness.publishActive
      .mockRejectedValueOnce(new Error('next publication unavailable'))
      .mockRejectedValueOnce(new Error('rollback publication unavailable'));

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: provider('pc_work', 'old'),
      reason: 'rollback_publication_failed',
    });

    expect(harness.applyRuntime.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['next', 'old']);
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('keeps input fenced when runtime application may have occurred without authoritative proof', async () => {
    const harness = createHarness();
    harness.applyRuntime.mockResolvedValueOnce({
      status: 'unproven',
      reason: 'runtime_model_transition_outcome_unproven',
    } as never);

    await expect(
      harness.coordinator.submit(provider('pc_work', 'next'), { source: 'command' }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
      reason: 'runtime_model_transition_outcome_unproven',
    });

    expect(harness.publishActive).not.toHaveBeenCalled();
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('publishes and unfences only after exact live-runtime model readback proves an unproven apply', async () => {
    const harness = createHarness({
      readRuntimeModelId: () => 'next',
    });
    harness.applyRuntime.mockResolvedValueOnce({
      status: 'unproven',
      reason: 'runtime_model_transition_outcome_unproven',
      readbackAfterCompletion: true,
    });

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: 'applied',
      activeSelection: provider('pc_work', 'next'),
    });

    expect(harness.publishActive.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['next']);
    expect(harness.unfence).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.readActiveTarget().selection)
      .toEqual(provider('pc_work', 'next'));
  });

  it('keeps readback recovery fenced when runtime drift arrives during active-fact publication', async () => {
    let runtimeModelId = 'old';
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const harness = createHarness({
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    harness.applyRuntime.mockImplementationOnce(async (target) => {
      runtimeModelId = target.selection.modelId;
      return {
        status: 'unproven',
        reason: 'runtime_model_transition_outcome_unproven',
        readbackAfterCompletion: true,
      };
    });
    harness.publishActive.mockImplementationOnce(async () => {
      runtimeModelId = 'contradictory-runtime-model';
      notifyRuntimeModelChange(runtimeModelId);
    });

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
      reason: 'runtime_model_drift_observed_during_readback_publication',
    });
    expect(harness.publishActive).toHaveBeenCalledTimes(1);
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('does not publish readback recovery after drift arrives during revalidation', async () => {
    let runtimeModelId = 'old';
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const harness = createHarness({
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    const revalidateBeforeEffect = vi.fn()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => {
        runtimeModelId = 'contradictory-runtime-model';
        notifyRuntimeModelChange(runtimeModelId);
        return true;
      });
    harness.authorize.mockResolvedValueOnce({
      ...authorized(provider('pc_work', 'next')),
      revalidateBeforeEffect,
    });
    harness.applyRuntime.mockImplementationOnce(async (target) => {
      runtimeModelId = target.selection.modelId;
      return {
        status: 'unproven',
        reason: 'runtime_model_transition_outcome_unproven',
        readbackAfterCompletion: true,
      };
    });

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
      reason: 'runtime_model_drift_observed_during_readback_revalidation',
    });
    expect(revalidateBeforeEffect).toHaveBeenCalledTimes(2);
    expect(harness.publishActive).not.toHaveBeenCalled();
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('keeps readback recovery fenced when authorization changes during publication', async () => {
    let runtimeModelId = 'old';
    const publication = deferred<void>();
    let authorizationCurrent = true;
    const harness = createHarness({
      readRuntimeModelId: () => runtimeModelId,
    });
    const revalidateBeforeEffect = vi.fn(async () => authorizationCurrent);
    harness.authorize.mockResolvedValueOnce({
      ...authorized(provider('pc_work', 'next')),
      revalidateBeforeEffect,
    });
    harness.applyRuntime.mockImplementationOnce(async (target) => {
      runtimeModelId = target.selection.modelId;
      return {
        status: 'unproven',
        reason: 'runtime_model_transition_outcome_unproven',
        readbackAfterCompletion: true,
      };
    });
    harness.publishActive.mockImplementationOnce(
      async () => await publication.promise,
    );

    const result = harness.coordinator.submit(
      provider('pc_work', 'next'),
      { source: 'command' },
    );
    await vi.waitFor(() => expect(harness.publishActive).toHaveBeenCalledTimes(1));
    authorizationCurrent = false;
    publication.resolve();

    await expect(result).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
      reason: 'provider_authorization_changed_during_readback_publication',
    });
    expect(revalidateBeforeEffect).toHaveBeenCalledTimes(3);
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('re-fences readback recovery when runtime drift arrives during fence release', async () => {
    let runtimeModelId = 'old';
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const harness = createHarness({
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    harness.applyRuntime.mockImplementationOnce(async (target) => {
      runtimeModelId = target.selection.modelId;
      return {
        status: 'unproven',
        reason: 'runtime_model_transition_outcome_unproven',
        readbackAfterCompletion: true,
      };
    });
    harness.unfence.mockImplementationOnce(async () => {
      runtimeModelId = 'contradictory-runtime-model';
      notifyRuntimeModelChange(runtimeModelId);
    });

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
      reason: 'runtime_model_drift_observed_during_readback_fence_release',
    });
    expect(harness.publishActive).toHaveBeenCalledTimes(1);
    expect(harness.fence).toHaveBeenCalledTimes(2);
    expect(harness.unfence).toHaveBeenCalledTimes(1);
  });

  it('treats a thrown runtime application as uncertain and keeps input fenced', async () => {
    const harness = createHarness();
    harness.applyRuntime.mockRejectedValueOnce(
      new Error('runtime control transport disconnected'),
    );

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
      reason: 'runtime control transport disconnected',
    });

    expect(harness.publishActive).not.toHaveBeenCalled();
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('recovers a thrown runtime application only when exact readback proves the target', async () => {
    const harness = createHarness({
      readRuntimeModelId: () => 'next',
    });
    harness.applyRuntime.mockRejectedValueOnce(
      new Error('runtime control transport disconnected'),
    );

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: 'applied',
      activeSelection: provider('pc_work', 'next'),
    });

    expect(harness.publishActive).toHaveBeenCalledTimes(1);
    expect(harness.unfence).toHaveBeenCalledTimes(1);
  });

  it('keeps reconciliation fenced until a later exact runtime-model publication proves the target', async () => {
    let runtimeModelId = 'old';
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const unsubscribe = vi.fn();
    const harness = createHarness({
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return unsubscribe;
      },
    });
    harness.applyRuntime.mockResolvedValueOnce({
      status: 'unproven',
      reason: 'runtime_model_transition_outcome_unproven',
      readbackAfterCompletion: true,
    });

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
    });
    expect(harness.unfence).not.toHaveBeenCalled();

    runtimeModelId = 'next';
    notifyRuntimeModelChange(runtimeModelId);

    await vi.waitFor(() => {
      expect(harness.publishActive).toHaveBeenCalledTimes(1);
      expect(harness.unfence).toHaveBeenCalledTimes(1);
    });
    expect(harness.coordinator.readActiveTarget().selection)
      .toEqual(provider('pc_work', 'next'));

    await harness.coordinator.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps reconciliation fenced when authorization changes during recovered-target publication', async () => {
    let runtimeModelId = 'old';
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const publication = deferred<void>();
    let authorizationCurrent = true;
    const harness = createHarness({
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    const revalidateBeforeEffect = vi.fn(async () => authorizationCurrent);
    harness.authorize.mockResolvedValueOnce({
      ...authorized(provider('pc_work', 'next')),
      revalidateBeforeEffect,
    });
    harness.applyRuntime.mockResolvedValueOnce({
      status: 'unproven',
      reason: 'runtime_model_transition_outcome_unproven',
      readbackAfterCompletion: true,
    });

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
    });

    harness.publishActive.mockImplementationOnce(
      async () => await publication.promise,
    );
    runtimeModelId = 'next';
    notifyRuntimeModelChange(runtimeModelId);
    await vi.waitFor(() => expect(harness.publishActive).toHaveBeenCalledTimes(1));
    authorizationCurrent = false;
    publication.resolve();

    await vi.waitFor(() => expect(revalidateBeforeEffect).toHaveBeenCalledTimes(3));
    expect(harness.unfence).not.toHaveBeenCalled();
    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'another'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
    });
  });

  it('fences and restores the accepted active target when runtime-origin evidence drifts', async () => {
    let runtimeModelId = 'old';
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const harness = createHarness({
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    harness.applyRuntime.mockImplementationOnce(async (target) => {
      runtimeModelId = target.selection.modelId;
      return { status: 'applied' };
    });

    runtimeModelId = 'runtime-observed';
    notifyRuntimeModelChange(runtimeModelId);

    await vi.waitFor(() => {
      expect(harness.fence).toHaveBeenCalledTimes(1);
      expect(harness.publishActive).toHaveBeenCalledWith(
        expect.objectContaining({
          selection: provider('pc_work', 'old'),
        }),
      );
      expect(harness.unfence).toHaveBeenCalledTimes(1);
    });
    expect(harness.coordinator.readActiveTarget().selection)
      .toEqual(provider('pc_work', 'old'));
    expect(harness.authorize).toHaveBeenCalledWith(provider('pc_work', 'old'));
    expect(harness.authorize).not.toHaveBeenCalledWith(
      provider('pc_work', 'runtime-observed'),
    );

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'old'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: 'already_active',
      activeSelection: provider('pc_work', 'old'),
    });
    expect(harness.applyRuntime).toHaveBeenCalledTimes(1);
  });

  it('keeps drift restoration fenced when authorization changes during active publication', async () => {
    let runtimeModelId = 'unexpected-runtime-model';
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const publication = deferred<void>();
    let authorizationCurrent = true;
    const harness = createHarness({
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    const restorationTarget = {
      ...authorized(provider('pc_work', 'old')),
      revalidateBeforeEffect: vi.fn(async () => authorizationCurrent),
    };
    harness.authorize.mockResolvedValueOnce(restorationTarget);
    harness.applyRuntime.mockImplementationOnce(async (target) => {
      runtimeModelId = target.selection.modelId;
      return { status: 'applied' };
    });
    harness.publishActive.mockImplementationOnce(
      async () => await publication.promise,
    );

    notifyRuntimeModelChange('unexpected-runtime-model');
    await vi.waitFor(() => expect(harness.publishActive).toHaveBeenCalledTimes(1));
    authorizationCurrent = false;
    publication.resolve();

    await vi.waitFor(() => {
      expect(restorationTarget.revalidateBeforeEffect).toHaveBeenCalledTimes(4);
    });
    expect(harness.unfence).not.toHaveBeenCalled();
    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
    });
  });

  it('keeps drift restoration fenced when authorization changes during runtime apply', async () => {
    let runtimeModelId = 'unexpected-runtime-model';
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const application = deferred<Readonly<{ status: 'applied' }>>();
    let authorizationCurrent = true;
    const harness = createHarness({
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    const restorationTarget = {
      ...authorized(provider('pc_work', 'old')),
      revalidateBeforeEffect: vi.fn(async () => authorizationCurrent),
    };
    harness.authorize.mockResolvedValueOnce(restorationTarget);
    harness.applyRuntime.mockImplementationOnce(async (target) => {
      runtimeModelId = target.selection.modelId;
      return await application.promise;
    });

    notifyRuntimeModelChange('unexpected-runtime-model');
    await vi.waitFor(() => expect(harness.applyRuntime).toHaveBeenCalledTimes(1));
    authorizationCurrent = false;
    application.resolve({ status: 'applied' });

    await vi.waitFor(() => {
      expect(restorationTarget.revalidateBeforeEffect).toHaveBeenCalledTimes(2);
    });
    expect(harness.publishActive).not.toHaveBeenCalled();
    expect(harness.unfence).not.toHaveBeenCalled();
    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
    });
  });

  it('keeps drift restoration fenced when authorization changes during confirmation readback', async () => {
    let runtimeModelId = 'unexpected-runtime-model';
    let readCount = 0;
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const confirmationReadback = deferred<string | null>();
    let authorizationCurrent = true;
    const harness = createHarness({
      readRuntimeModelId: () => {
        readCount += 1;
        return readCount === 2
          ? confirmationReadback.promise
          : runtimeModelId;
      },
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    const restorationTarget = {
      ...authorized(provider('pc_work', 'old')),
      revalidateBeforeEffect: vi.fn(async () => authorizationCurrent),
    };
    harness.authorize.mockResolvedValueOnce(restorationTarget);
    harness.applyRuntime.mockImplementationOnce(async (target) => {
      runtimeModelId = target.selection.modelId;
      return { status: 'applied' };
    });

    notifyRuntimeModelChange('unexpected-runtime-model');
    await vi.waitFor(() => expect(readCount).toBe(2));
    authorizationCurrent = false;
    confirmationReadback.resolve('old');

    await vi.waitFor(() => {
      expect(restorationTarget.revalidateBeforeEffect).toHaveBeenCalledTimes(3);
    });
    expect(harness.publishActive).not.toHaveBeenCalled();
    expect(harness.unfence).not.toHaveBeenCalled();
    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
    });
  });

  it('does not publish or unfence a proposal when runtime drift arrives during its effect', async () => {
    let runtimeModelId = 'old';
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const harness = createHarness({
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    harness.applyRuntime
      .mockImplementationOnce(async () => {
        runtimeModelId = 'unexpected-runtime-model';
        notifyRuntimeModelChange(runtimeModelId);
        return { status: 'applied' };
      })
      .mockImplementationOnce(async (target) => {
        runtimeModelId = target.selection.modelId;
        return { status: 'applied' };
      });

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
    });

    await vi.waitFor(() => {
      expect(harness.publishActive).toHaveBeenCalledTimes(1);
      expect(harness.publishActive).toHaveBeenCalledWith(
        expect.objectContaining({
          selection: provider('pc_work', 'old'),
        }),
      );
      expect(harness.unfence).toHaveBeenCalledTimes(1);
    });
    expect(harness.publishActive).not.toHaveBeenCalledWith(
      expect.objectContaining({
        selection: provider('pc_work', 'next'),
      }),
    );
    expect(harness.coordinator.readActiveTarget().selection)
      .toEqual(provider('pc_work', 'old'));
  });

  it('keeps the fence when runtime evidence proves an effect after apply reports failure', async () => {
    let runtimeModelId = 'old';
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const harness = createHarness({
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    harness.applyRuntime.mockImplementationOnce(async (target) => {
      runtimeModelId = target.selection.modelId;
      notifyRuntimeModelChange(runtimeModelId);
      return { status: 'failed', reason: 'runtime_reported_failure' };
    });

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
      reason: 'runtime_effect_observed_after_failed_apply',
    });
    expect(harness.publishActive).not.toHaveBeenCalled();
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('re-fences when runtime drift arrives while the transition fence is clearing', async () => {
    let runtimeModelId = 'old';
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const harness = createHarness({
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    harness.applyRuntime
      .mockImplementationOnce(async (target) => {
        runtimeModelId = target.selection.modelId;
        return { status: 'applied' };
      })
      .mockImplementationOnce(async (target) => {
        runtimeModelId = target.selection.modelId;
        return { status: 'applied' };
      });
    harness.unfence.mockImplementationOnce(async () => {
      runtimeModelId = 'unexpected-runtime-model';
      notifyRuntimeModelChange(runtimeModelId);
    });

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
    });
    expect(harness.fence).toHaveBeenCalledTimes(2);

    await vi.waitFor(() => {
      expect(harness.publishActive).toHaveBeenLastCalledWith(
        expect.objectContaining({
          selection: provider('pc_work', 'next'),
        }),
      );
      expect(harness.unfence).toHaveBeenCalledTimes(2);
    });
    expect(harness.coordinator.readActiveTarget().selection)
      .toEqual(provider('pc_work', 'next'));
  });

  it('bounds drift restoration to one attempt per runtime observation', async () => {
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const harness = createHarness({
      readRuntimeModelId: () => 'unexpected-runtime-model',
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    harness.applyRuntime.mockResolvedValue({ status: 'applied' });

    notifyRuntimeModelChange('unexpected-runtime-model');

    await vi.waitFor(() => {
      expect(harness.applyRuntime).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.applyRuntime).toHaveBeenCalledTimes(1);
    expect(harness.publishActive).not.toHaveBeenCalled();
    expect(harness.unfence).not.toHaveBeenCalled();
    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
    });
  });

  it('retries exact fact publication before unfencing when drift restoration publication fails', async () => {
    let runtimeModelId = 'unexpected-runtime-model';
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const harness = createHarness({
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    harness.applyRuntime.mockImplementationOnce(async (target) => {
      runtimeModelId = target.selection.modelId;
      notifyRuntimeModelChange(runtimeModelId);
      return { status: 'applied' };
    });
    harness.publishActive.mockRejectedValueOnce(
      new Error('metadata unavailable'),
    );

    notifyRuntimeModelChange('unexpected-runtime-model');

    await vi.waitFor(() => {
      expect(harness.publishActive).toHaveBeenCalledTimes(2);
      expect(harness.unfence).toHaveBeenCalledTimes(1);
    });
    expect(harness.publishActive).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selection: provider('pc_work', 'old'),
      }),
    );
  });

  it('does not erase newer runtime drift observed during restoration publication', async () => {
    let runtimeModelId = 'unexpected-runtime-model';
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const harness = createHarness({
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    harness.applyRuntime.mockImplementationOnce(async (target) => {
      runtimeModelId = target.selection.modelId;
      return { status: 'applied' };
    });
    harness.publishActive.mockImplementationOnce(async () => {
      runtimeModelId = 'newer-runtime-drift';
      notifyRuntimeModelChange(runtimeModelId);
    });

    notifyRuntimeModelChange('unexpected-runtime-model');

    await vi.waitFor(() => {
      expect(harness.publishActive).toHaveBeenCalledTimes(1);
    });
    expect(harness.unfence).not.toHaveBeenCalled();
    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
    });
  });

  it('does not erase newer runtime drift delivered after restoration readback is captured', async () => {
    let runtimeModelId = 'unexpected-runtime-model';
    let readCount = 0;
    const releaseConfirmationRead = deferred<void>();
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const harness = createHarness({
      readRuntimeModelId: () => {
        readCount += 1;
        if (readCount !== 2) return runtimeModelId;
        const capturedModelId = runtimeModelId;
        return releaseConfirmationRead.promise.then(() => capturedModelId);
      },
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    harness.applyRuntime.mockImplementationOnce(async (target) => {
      runtimeModelId = target.selection.modelId;
      return { status: 'applied' };
    });

    notifyRuntimeModelChange('unexpected-runtime-model');
    await vi.waitFor(() => expect(readCount).toBe(2));
    runtimeModelId = 'newer-runtime-drift';
    notifyRuntimeModelChange(runtimeModelId);
    releaseConfirmationRead.resolve();

    await vi.waitFor(() => {
      expect(harness.applyRuntime).toHaveBeenCalledTimes(2);
    });
    expect(harness.publishActive).not.toHaveBeenCalled();
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('re-fences and restores newer runtime drift observed during restoration fence release', async () => {
    let runtimeModelId = 'unexpected-runtime-model';
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const harness = createHarness({
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    harness.applyRuntime.mockImplementation(async (target) => {
      runtimeModelId = target.selection.modelId;
      notifyRuntimeModelChange(runtimeModelId);
      return { status: 'applied' };
    });
    harness.unfence.mockImplementationOnce(async () => {
      runtimeModelId = 'newer-runtime-drift';
      notifyRuntimeModelChange(runtimeModelId);
    });

    notifyRuntimeModelChange('unexpected-runtime-model');

    await vi.waitFor(() => {
      expect(harness.applyRuntime).toHaveBeenCalledTimes(2);
      expect(harness.publishActive).toHaveBeenCalledTimes(2);
      expect(harness.fence).toHaveBeenCalledTimes(2);
      expect(harness.unfence).toHaveBeenCalledTimes(2);
    });
    expect(harness.applyRuntime.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['old', 'old']);
    expect(harness.coordinator.readActiveTarget().selection).toEqual(
      provider('pc_work', 'old'),
    );
  });

  it('does not strand an exact readback publication at the pump release boundary', async () => {
    let runtimeModelId = 'old';
    let notifyRuntimeModelChange: () => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const harness = createHarness({
      readRuntimeModelId: () => {
        const observed = runtimeModelId;
        if (observed === 'old') {
          queueMicrotask(() => {
            queueMicrotask(() => {
              runtimeModelId = 'next';
              notifyRuntimeModelChange();
            });
          });
        }
        return observed;
      },
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    harness.applyRuntime.mockResolvedValueOnce({
      status: 'unproven',
      reason: 'runtime_model_transition_outcome_unproven',
      readbackAfterCompletion: true,
    });

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
    });
    await vi.waitFor(() => {
      expect(harness.publishActive).toHaveBeenCalledTimes(1);
      expect(harness.unfence).toHaveBeenCalledTimes(1);
    });
  });

  it('replaces a not-yet-effectful proposal with the latest accepted proposal', async () => {
    const harness = createHarness();
    const firstAuthorization = deferred<AuthorizedSessionModelTransitionTarget>();
    harness.authorize.mockImplementationOnce(async () => await firstAuthorization.promise);

    const first = harness.coordinator.submit(provider('pc_work', 'first'), { source: 'command' });
    await vi.waitFor(() => expect(harness.authorize).toHaveBeenCalledTimes(1));
    const second = harness.coordinator.submit(provider('pc_work', 'second'), { source: 'command' });
    firstAuthorization.resolve(authorized(provider('pc_work', 'first')));

    await expect(first).resolves.toMatchObject({ ok: false, status: 'superseded' });
    await expect(second).resolves.toMatchObject({ ok: true, status: 'applied' });
    expect(harness.applyRuntime.mock.calls.map(([target]) => target.selection.modelId))
      .toEqual(['second']);
  });

  it('awaits an older durable intent CAS but lets only the newer pending proposal affect runtime', async () => {
    const harness = createHarness();
    const firstPublication = deferred<Readonly<{ accepted: boolean; updatedAt: number }>>();
    harness.publishIntent.mockImplementationOnce(
      async () => await firstPublication.promise,
    );

    const first = harness.coordinator.submit(
      provider('pc_work', 'first'),
      { source: 'command' },
    );
    await vi.waitFor(() => expect(harness.publishIntent).toHaveBeenCalledTimes(1));
    const second = harness.coordinator.submit(
      provider('pc_work', 'second'),
      { source: 'command' },
    );
    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    await Promise.resolve();

    expect(firstSettled).toBe(false);
    firstPublication.resolve({ accepted: true, updatedAt: 10 });

    await expect(first).resolves.toMatchObject({ ok: false, status: 'superseded' });
    await expect(second).resolves.toMatchObject({ ok: true, status: 'applied' });
    expect(harness.publishIntent.mock.calls.map(([selection]) => selection.modelId))
      .toEqual(['first', 'second']);
    expect(harness.applyRuntime.mock.calls.map(([target]) => target.selection.modelId))
      .toEqual(['second']);
  });

  it('does not let a late rejected CAS retry apply an older runtime target', async () => {
    const harness = createHarness();
    const firstPublication =
      deferred<Readonly<{ accepted: boolean; updatedAt: number }>>();
    harness.publishIntent.mockImplementationOnce(
      async () => await firstPublication.promise,
    );

    const first = harness.coordinator.submit(
      provider('pc_work', 'first'),
      { source: 'command' },
    );
    await vi.waitFor(() =>
      expect(harness.publishIntent).toHaveBeenCalledTimes(1));
    const second = harness.coordinator.submit(
      provider('pc_work', 'second'),
      { source: 'command' },
    );
    firstPublication.resolve({ accepted: false, updatedAt: 20 });

    await expect(first).resolves.toMatchObject({
      ok: false,
      status: 'superseded',
    });
    await expect(second).resolves.toMatchObject({
      ok: true,
      status: 'applied',
    });
    expect(harness.applyRuntime.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['second']);
  });

  it('retains one prompt fence while a newer proposal supersedes before runtime effect', async () => {
    const harness = createHarness();
    const fence = deferred<void>();
    harness.fence.mockImplementationOnce(async () => await fence.promise);

    const first = harness.coordinator.submit(provider('pc_work', 'first'), { source: 'command' });
    await vi.waitFor(() => expect(harness.fence).toHaveBeenCalledTimes(1));
    const second = harness.coordinator.submit(provider('pc_work', 'second'), { source: 'command' });
    fence.resolve();

    await expect(first).resolves.toMatchObject({ ok: false, status: 'superseded' });
    await expect(second).resolves.toMatchObject({ ok: true, status: 'applied' });
    expect(harness.applyRuntime.mock.calls.map(([target]) => target.selection.modelId))
      .toEqual(['second']);
    expect(harness.fence).toHaveBeenCalledTimes(1);
    expect(harness.unfence).toHaveBeenCalledTimes(1);
  });

  it('holds the coordinator slot through prompt custody so a newer setting cannot replace the selected model before provider acceptance', async () => {
    const harness = createHarness();
    const providerAccepted = deferred<void>();
    const runWithActiveSelection = vi.fn(async (transferPromptAdmission) => {
      harness.events.push('prompt-custody');
      await transferPromptAdmission({
        abortSignal: new AbortController().signal,
        dispatch: async () => {
          await providerAccepted.promise;
        },
      });
      harness.events.push('prompt-accepted');
    });
    const promptSelection = provider('pc_work', 'prompt-model');
    const laterSetting = provider('pc_work', 'later-setting');

    const prompt = harness.coordinator.submit(
      promptSelection,
      {
        source: 'prompt',
        runWithActiveSelection,
      },
    );
    await vi.waitFor(() =>
      expect(runWithActiveSelection).toHaveBeenCalledTimes(1));

    const setting = harness.coordinator.submit(
      laterSetting,
      { source: 'command' },
    );
    let settingSettled = false;
    void setting.then(() => {
      settingSettled = true;
    });
    await Promise.resolve();

    expect(settingSettled).toBe(false);
    expect(harness.applyRuntime.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['prompt-model']);
    expect(harness.events).toEqual([
      'intent:prompt-model',
      'fence',
      'apply:prompt-model',
      'active:prompt-model',
      'prompt-custody',
      'transfer',
    ]);

    providerAccepted.resolve();
    await expect(prompt).resolves.toMatchObject({
      ok: true,
      status: 'applied',
      activeSelection: promptSelection,
    });
    await expect(setting).resolves.toMatchObject({
      ok: true,
      status: 'applied',
      activeSelection: laterSetting,
    });
    expect(harness.applyRuntime.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['prompt-model', 'later-setting']);
  });

  it('fails a prompt proposal closed when canonical custody transfer is absent', async () => {
    const harness = createHarness();
    const selection = provider('pc_work', 'prompt-without-custody');

    await expect(
      harness.coordinator.submit(selection, { source: 'prompt' }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'owner_unavailable',
      requestedSelection: selection,
      reason: 'canonical_prompt_custody_unavailable',
    });
    expect(harness.authorize).not.toHaveBeenCalled();
    expect(harness.publishIntent).not.toHaveBeenCalled();
    expect(harness.applyRuntime).not.toHaveBeenCalled();
  });

  it('never transfers prompt custody for a structured selection superseded before runtime effect', async () => {
    const harness = createHarness();
    const promptAuthorization =
      deferred<AuthorizedSessionModelTransitionTarget>();
    harness.authorize.mockImplementationOnce(
      async () => await promptAuthorization.promise,
    );
    const runWithActiveSelection = vi.fn(async () => {
      throw new Error('superseded prompt must not dispatch');
    });
    const promptSelection = provider('pc_work', 'stale-prompt');
    const latestSelection = provider('pc_work', 'latest-setting');

    const prompt = harness.coordinator.submit(promptSelection, {
      source: 'prompt',
      runWithActiveSelection,
    });
    await vi.waitFor(() =>
      expect(harness.authorize).toHaveBeenCalledTimes(1));
    const latest = harness.coordinator.submit(
      latestSelection,
      { source: 'command' },
    );
    promptAuthorization.resolve(authorized(promptSelection));

    await expect(prompt).resolves.toMatchObject({
      ok: false,
      status: 'superseded',
    });
    await expect(latest).resolves.toMatchObject({
      ok: true,
      status: 'applied',
      activeSelection: latestSelection,
    });
    expect(runWithActiveSelection).not.toHaveBeenCalled();
    expect(harness.transferPromptAdmission).not.toHaveBeenCalled();
    expect(harness.applyRuntime.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['latest-setting']);
  });

  it('reauthorizes after the async prompt fence and refuses runtime effect when facts changed', async () => {
    const harness = createHarness();
    const next = provider('pc_work', 'next');
    const revalidateBeforeEffect = vi.fn(async () => false);
    harness.authorize.mockResolvedValueOnce({
      ...authorized(next),
      revalidateBeforeEffect,
    });

    await expect(
      harness.coordinator.submit(next, { source: 'command' }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'apply_failed',
      reason: 'provider_authorization_changed_before_effect',
    });

    expect(revalidateBeforeEffect).toHaveBeenCalledTimes(1);
    expect(harness.fence).toHaveBeenCalledTimes(1);
    expect(harness.applyRuntime).not.toHaveBeenCalled();
    expect(harness.unfence).toHaveBeenCalledTimes(1);
  });

  it('rolls runtime back when authorization changes after apply but before active publication', async () => {
    const harness = createHarness({ authoritativeRuntimeReadback: true });
    const next = provider('pc_work', 'next');
    const revalidateBeforeEffect = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    harness.authorize.mockResolvedValueOnce({
      ...authorized(next),
      revalidateBeforeEffect,
    });

    await expect(
      harness.coordinator.submit(next, { source: 'command' }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'publication_failed_rolled_back',
      activeSelection: provider('pc_work', 'old'),
      reason: 'provider_authorization_changed_before_publication',
    });

    expect(revalidateBeforeEffect).toHaveBeenCalledTimes(2);
    expect(harness.applyRuntime.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['next', 'old']);
    expect(harness.publishActive.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['old']);
    expect(harness.unfence).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.readActiveTarget().selection)
      .toEqual(provider('pc_work', 'old'));
  });

  it('rolls runtime back when authorization changes during active publication', async () => {
    const harness = createHarness({ authoritativeRuntimeReadback: true });
    const next = provider('pc_work', 'next');
    const publication = deferred<void>();
    let authorizationCurrent = true;
    const revalidateBeforeEffect = vi.fn(async () => authorizationCurrent);
    harness.authorize.mockResolvedValueOnce({
      ...authorized(next),
      revalidateBeforeEffect,
    });
    harness.publishActive.mockImplementationOnce(
      async () => await publication.promise,
    );

    const result = harness.coordinator.submit(next, { source: 'command' });
    await vi.waitFor(() => expect(harness.publishActive).toHaveBeenCalledTimes(1));
    authorizationCurrent = false;
    publication.resolve();

    await expect(result).resolves.toMatchObject({
      ok: false,
      status: 'publication_failed_rolled_back',
      activeSelection: provider('pc_work', 'old'),
      reason: 'provider_authorization_changed_during_publication',
    });
    expect(revalidateBeforeEffect).toHaveBeenCalledTimes(3);
    expect(harness.applyRuntime.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['next', 'old']);
    expect(harness.publishActive.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['next', 'old']);
    expect(harness.unfence).toHaveBeenCalledTimes(1);
  });

  it('keeps rollback fenced when previous authorization changes during rollback publication', async () => {
    const previousSelection = provider('pc_work', 'old');
    const rollbackPublication = deferred<void>();
    let previousAuthorizationCurrent = true;
    const revalidatePreviousAuthorization = vi.fn(
      async () => previousAuthorizationCurrent,
    );
    const harness = createHarness({
      authoritativeRuntimeReadback: true,
      initialTarget: {
        ...authorized(previousSelection),
        revalidateBeforeEffect: revalidatePreviousAuthorization,
      },
    });
    harness.publishActive
      .mockRejectedValueOnce(new Error('target publication failed'))
      .mockImplementationOnce(
        async () => await rollbackPublication.promise,
      );

    const result = harness.coordinator.submit(
      provider('pc_work', 'next'),
      { source: 'command' },
    );
    await vi.waitFor(() => expect(harness.publishActive).toHaveBeenCalledTimes(2));
    previousAuthorizationCurrent = false;
    rollbackPublication.resolve();

    await expect(result).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
      reason: 'provider_authorization_changed_during_rollback_publication',
    });
    expect(revalidatePreviousAuthorization).toHaveBeenCalledTimes(3);
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('does not roll back to a startup target whose authorization changed during the forward effect', async () => {
    const previousSelection = provider('pc_work', 'old');
    const application = deferred<Readonly<{ status: 'applied' }>>();
    let previousAuthorizationCurrent = true;
    const revalidatePreviousAuthorization = vi.fn(
      async () => previousAuthorizationCurrent,
    );
    const harness = createHarness({
      initialTarget: {
        ...authorized(previousSelection),
        revalidateBeforeEffect: revalidatePreviousAuthorization,
      },
    });
    harness.authorize.mockResolvedValueOnce({
      ...authorized(provider('pc_work', 'next')),
      revalidateBeforeEffect: async () => true,
    });
    harness.applyRuntime.mockImplementationOnce(
      async () => await application.promise,
    );
    harness.publishActive.mockRejectedValueOnce(
      new Error('target publication failed'),
    );

    const result = harness.coordinator.submit(
      provider('pc_work', 'next'),
      { source: 'command' },
    );
    await vi.waitFor(() => expect(harness.applyRuntime).toHaveBeenCalledTimes(1));
    previousAuthorizationCurrent = false;
    application.resolve({ status: 'applied' });

    await expect(result).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
      reason: 'provider_authorization_changed_before_rollback',
    });
    expect(harness.applyRuntime.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['next']);
    expect(harness.publishActive.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['next']);
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('does not publish rollback facts when previous authorization changes during rollback apply', async () => {
    const previousSelection = provider('pc_work', 'old');
    let runtimeModelId = previousSelection.modelId;
    let previousAuthorizationCurrent = true;
    const rollbackApplication = deferred<Readonly<{ status: 'applied' }>>();
    const harness = createHarness({
      initialTarget: {
        ...authorized(previousSelection),
        revalidateBeforeEffect: async () => previousAuthorizationCurrent,
      },
      readRuntimeModelId: () => runtimeModelId,
    });
    harness.applyRuntime
      .mockImplementationOnce(async (target) => {
        runtimeModelId = target.selection.modelId;
        return { status: 'applied' };
      })
      .mockImplementationOnce(async (target) => {
        runtimeModelId = target.selection.modelId;
        return await rollbackApplication.promise;
      });
    harness.publishActive.mockRejectedValueOnce(
      new Error('target publication failed'),
    );

    const result = harness.coordinator.submit(
      provider('pc_work', 'next'),
      { source: 'command' },
    );
    await vi.waitFor(() => expect(harness.applyRuntime).toHaveBeenCalledTimes(2));
    previousAuthorizationCurrent = false;
    rollbackApplication.resolve({ status: 'applied' });

    await expect(result).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
      reason: 'provider_authorization_changed_after_rollback',
    });
    expect(harness.publishActive.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['next']);
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('does not publish rollback facts when runtime drifts during rollback apply', async () => {
    const previousSelection = provider('pc_work', 'old');
    let runtimeModelId = previousSelection.modelId;
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const harness = createHarness({
      initialTarget: authorized(previousSelection),
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    harness.applyRuntime
      .mockImplementationOnce(async (target) => {
        runtimeModelId = target.selection.modelId;
        return { status: 'applied' };
      })
      .mockImplementationOnce(async () => {
        runtimeModelId = 'rogue-runtime-model';
        notifyRuntimeModelChange(runtimeModelId);
        return { status: 'applied' };
      });
    harness.publishActive.mockRejectedValueOnce(
      new Error('target publication failed'),
    );

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
      reason: 'runtime_model_drift_observed_during_rollback',
    });
    expect(harness.publishActive.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['next']);
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('does not reconcile or unfence an unvalidated startup target from runtime readback', async () => {
    let runtimeModelId = 'old';
    let notifyRuntimeModelChange: (currentModelId?: string | null) => void = () => {
      throw new Error('Runtime model subscription was not installed');
    };
    const unvalidatedStartupTarget = {
      ...authorized(provider('pc_work', 'old')),
    };
    Reflect.deleteProperty(
      unvalidatedStartupTarget,
      'revalidateBeforeEffect',
    );
    const harness = createHarness({
      initialTarget: unvalidatedStartupTarget,
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: (handler) => {
        notifyRuntimeModelChange = handler;
        return () => undefined;
      },
    });
    harness.authorize.mockResolvedValueOnce({
      ...authorized(provider('pc_work', 'next')),
      revalidateBeforeEffect: async () => true,
    });
    harness.applyRuntime.mockImplementation(async (target) => {
      runtimeModelId = target.selection.modelId;
      return { status: 'applied' };
    });
    harness.publishActive
      .mockRejectedValueOnce(new Error('target publication failed'))
      .mockRejectedValueOnce(new Error('rollback publication failed'));

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'next'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
    });
    expect(runtimeModelId).toBe('next');
    expect(harness.publishActive).toHaveBeenCalledTimes(1);

    runtimeModelId = 'old';
    notifyRuntimeModelChange(runtimeModelId);
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.publishActive).toHaveBeenCalledTimes(1);
    expect(harness.unfence).not.toHaveBeenCalled();
    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'another'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
    });
  });

  it('does not apply runtime when the run retires during post-fence authorization revalidation', async () => {
    const harness = createHarness();
    const next = provider('pc_work', 'next');
    const revalidation = deferred<boolean>();
    const revalidateBeforeEffect = vi.fn(async () => await revalidation.promise);
    harness.authorize.mockResolvedValueOnce({
      ...authorized(next),
      revalidateBeforeEffect,
    });

    const result = harness.coordinator.submit(next, { source: 'command' });
    await vi.waitFor(() => expect(revalidateBeforeEffect).toHaveBeenCalledTimes(1));
    harness.retireRun();
    revalidation.resolve(true);

    await expect(result).resolves.toMatchObject({
      ok: false,
      status: 'owner_unavailable',
    });
    expect(harness.applyRuntime).not.toHaveBeenCalled();
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('reauthorizes the same structured ref and restarts when exact binding facts changed', async () => {
    const selection = provider('pc_work', 'old');
    const harness = createHarness({ initial: selection });
    harness.authorize.mockResolvedValueOnce({
      ...authorized(selection, 'restart_session'),
      sessionBindingMetadata: {
        ...providerBindingMetadata(ProviderConnectionIdSchema.parse('pc_work'), 'old'),
        connectionRevision: 2,
        protocol: 'openai-responses',
        bindingSecurityFingerprint: 'security:rotated-endpoint',
      },
      runtimeBindingBasis: runtimeBindingBasis(
        ProviderConnectionIdSchema.parse('pc_work'),
        'https://rotated.example/v1',
      ),
    });

    await expect(
      harness.coordinator.submit(selection, { source: 'metadata' }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'restart_required',
      activeSelection: selection,
    });

    expect(harness.authorize).toHaveBeenCalledWith(selection);
    expect(harness.applyRuntime).not.toHaveBeenCalled();
  });

  it('publishes the already-active selection to cancel a prior restart-required intent', async () => {
    const active = provider('pc_work', 'old');
    const harness = createHarness({ initial: active });

    await expect(
      harness.coordinator.submit(active, { source: 'command' }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'already_active',
      activeSelection: active,
    });

    expect(harness.publishIntent).toHaveBeenCalledWith(active);
    expect(harness.applyRuntime).not.toHaveBeenCalled();
    expect(harness.fence).not.toHaveBeenCalled();
    expect(harness.publishActive).not.toHaveBeenCalled();
  });

  it('treats an exact restart-only Provider reauthorization as already active without a runtime effect or active-fact publication', async () => {
    const active = provider('pc_work', 'old');
    const connectionId =
      ProviderConnectionIdSchema.parse('pc_work');
    const basis = runtimeBindingBasis(
      connectionId,
      'https://provider.example/v1',
      'restart_session',
    );
    const initialTarget = {
      ...authorized(active),
      sessionBindingMetadata: {
        ...providerBindingMetadata(connectionId, active.modelId),
        runtimeBindingBasis: basis,
      },
      runtimeBindingBasis: basis,
    } satisfies AuthorizedSessionModelTransitionTarget;
    const harness = createHarness({ initialTarget });
    const authorizeProviderTarget = vi.fn(async () => ({
      selection: {
        ...active,
        providerConnectionId: connectionId,
      },
      policy: 'restart_session' as const,
      model: initialTarget.providerBinding!.model,
      sessionBindingMetadata: initialTarget.sessionBindingMetadata!,
      runtimeBindingBasis: basis,
    }));
    const authorize =
      createSessionModelTransitionAuthorizer({
        sessionId: 'session-restart-only',
        machineId: 'machine-a',
        agentId: 'restart-only-agent',
        agentTargetKey: active.agentTargetKey,
        nativeModelApplyPolicy: 'restart_session',
        readActiveTarget: harness.coordinator.readActiveTarget,
        authorizeProviderTarget,
      });
    harness.authorize.mockImplementation(authorize);

    await expect(
      harness.coordinator.submit(active, { source: 'command' }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'already_active',
      activeSelection: active,
    });

    expect(authorizeProviderTarget).toHaveBeenCalledTimes(1);
    expect(harness.applyRuntime).not.toHaveBeenCalled();
    expect(harness.fence).not.toHaveBeenCalled();
    expect(harness.publishActive).not.toHaveBeenCalled();
  });

  it('preserves each active raw managed basis projection when restart-only reauthorization is canonically equal', async () => {
    const active = provider('pc_managed', 'old');
    const connectionId =
      ProviderConnectionIdSchema.parse('pc_managed');
    const activeTargetBasis = managedRuntimeBindingBasis(
      connectionId,
      ['ä-upstream', 'Z-upstream'],
    );
    const activeMetadataBasis = managedRuntimeBindingBasis(
      connectionId,
      ['Z-upstream', 'ä-upstream'],
    );
    const activeMetadata = {
      ...providerBindingMetadata(connectionId, active.modelId),
      managedPurposeBindings:
        activeMetadataBasis.deployment.purposeBindings,
      runtimeBindingBasis: activeMetadataBasis,
    } satisfies SessionProviderBindingMetadataV1;
    const initialTarget = {
      ...authorized(active),
      sessionBindingMetadata: activeMetadata,
      runtimeBindingBasis: activeTargetBasis,
    } satisfies AuthorizedSessionModelTransitionTarget;
    const harness = createHarness({ initialTarget });
    const nextBasis = managedRuntimeBindingBasis(
      connectionId,
      ['Z-upstream', 'ä-upstream'],
    );
    const nextMetadata = {
      ...activeMetadata,
      managedPurposeBindings: nextBasis.deployment.purposeBindings,
      runtimeBindingBasis: nextBasis,
    } satisfies SessionProviderBindingMetadataV1;
    const authorizeProviderTarget = vi.fn(async () => ({
      selection: {
        ...active,
        providerConnectionId: connectionId,
      },
      policy: 'restart_session' as const,
      model: initialTarget.providerBinding!.model,
      sessionBindingMetadata: nextMetadata,
      runtimeBindingBasis: nextBasis,
    }));
    const authorize = createSessionModelTransitionAuthorizer({
      sessionId: 'session-managed-restart-only',
      machineId: 'machine-a',
      agentId: 'restart-only-agent',
      agentTargetKey: active.agentTargetKey,
      nativeModelApplyPolicy: 'restart_session',
      readActiveTarget: harness.coordinator.readActiveTarget,
      authorizeProviderTarget,
    });
    const observedTargets:
      AuthorizedSessionModelTransitionTarget[] = [];
    harness.authorize.mockImplementation(async (selection) => {
      const target = await authorize(selection);
      observedTargets.push(target);
      return target;
    });

    await expect(
      harness.coordinator.submit(active, { source: 'command' }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'already_active',
      activeSelection: active,
    });

    const observedTarget = observedTargets[0];
    if (!observedTarget) {
      throw new Error('Expected the composed authorizer target');
    }
    expect(observedTarget.runtimeBindingBasis).toEqual(
      activeTargetBasis,
    );
    expect(
      observedTarget.sessionBindingMetadata?.runtimeBindingBasis,
    ).toEqual(activeMetadataBasis);
    expect(authorizeProviderTarget).toHaveBeenCalledTimes(1);
    expect(harness.applyRuntime).not.toHaveBeenCalled();
    expect(harness.fence).not.toHaveBeenCalled();
    expect(harness.publishActive).not.toHaveBeenCalled();
  });

  it('preserves active raw managed basis and purpose projections when live reauthorization is canonically equal', async () => {
    const active = provider('pc_managed_live', 'old');
    const connectionId =
      ProviderConnectionIdSchema.parse('pc_managed_live');
    const activeBasis = managedRuntimeBindingBasis(
      connectionId,
      ['ä-upstream', 'Z-upstream'],
      'live',
    );
    const activeMetadata = {
      ...providerBindingMetadata(connectionId, active.modelId),
      managedPurposeBindings:
        activeBasis.deployment.purposeBindings,
      runtimeBindingBasis: activeBasis,
    } satisfies SessionProviderBindingMetadataV1;
    const initialTarget = {
      ...authorized(active),
      sessionBindingMetadata: activeMetadata,
      runtimeBindingBasis: activeBasis,
    } satisfies AuthorizedSessionModelTransitionTarget;
    const harness = createHarness({ initialTarget });
    const nextBasis = managedRuntimeBindingBasis(
      connectionId,
      ['Z-upstream', 'ä-upstream'],
      'live',
    );
    const nextMetadata = {
      ...activeMetadata,
      managedPurposeBindings:
        nextBasis.deployment.purposeBindings,
      runtimeBindingBasis: nextBasis,
    } satisfies SessionProviderBindingMetadataV1;
    const authorizeProviderTarget = vi.fn(async () => ({
      selection: {
        ...active,
        providerConnectionId: connectionId,
      },
      policy: 'live' as const,
      model: initialTarget.providerBinding!.model,
      sessionBindingMetadata: nextMetadata,
      runtimeBindingBasis: nextBasis,
    }));
    const authorize = createSessionModelTransitionAuthorizer({
      sessionId: 'session-managed-live',
      machineId: 'machine-a',
      agentId: 'live-agent',
      agentTargetKey: active.agentTargetKey,
      nativeModelApplyPolicy: 'live',
      readActiveTarget: harness.coordinator.readActiveTarget,
      authorizeProviderTarget,
    });
    const observedTargets:
      AuthorizedSessionModelTransitionTarget[] = [];
    harness.authorize.mockImplementation(async (selection) => {
      const target = await authorize(selection);
      observedTargets.push(target);
      return target;
    });

    await expect(
      harness.coordinator.submit(active, { source: 'command' }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'already_active',
      activeSelection: active,
    });

    const observedTarget = observedTargets[0];
    if (!observedTarget) {
      throw new Error('Expected the composed live authorizer target');
    }
    expect(observedTarget.runtimeBindingBasis).toEqual(activeBasis);
    expect(
      observedTarget.sessionBindingMetadata?.runtimeBindingBasis,
    ).toEqual(activeBasis);
    expect(
      observedTarget.sessionBindingMetadata?.managedPurposeBindings,
    ).toEqual(activeBasis.deployment.purposeBindings);
    expect(authorizeProviderTarget).toHaveBeenCalledTimes(1);
    expect(harness.applyRuntime).not.toHaveBeenCalled();
    expect(harness.fence).not.toHaveBeenCalled();
    expect(harness.publishActive).not.toHaveBeenCalled();
  });

  it('reapplies refreshed binding facts before publishing the same structured selection', async () => {
    const active = provider('pc_work', 'old');
    const harness = createHarness({ initial: active });
    const refreshedTarget = {
      ...authorized(active),
      providerBinding: {
        ...runtimeBinding(
          ProviderConnectionIdSchema.parse('pc_work'),
          'old',
        ),
        model: {
          id: 'old',
          name: 'Refreshed model',
          contextWindowTokens: 200_000,
        },
      },
      sessionBindingMetadata: {
        ...providerBindingMetadata(
          ProviderConnectionIdSchema.parse('pc_work'),
          'old',
        ),
        model: {
          id: 'old',
          name: 'Refreshed model',
          contextWindowTokens: 200_000,
        },
        bindingSecurityFingerprint: 'security:old:refreshed-capabilities',
      },
    } satisfies AuthorizedSessionModelTransitionTarget;
    harness.authorize.mockResolvedValueOnce(refreshedTarget);

    await expect(
      harness.coordinator.submit(active, { source: 'command' }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'applied',
      activeSelection: active,
    });

    expect(harness.fence).toHaveBeenCalledTimes(1);
    expect(harness.applyRuntime).toHaveBeenCalledExactlyOnceWith(
      refreshedTarget,
    );
    expect(harness.publishActive).toHaveBeenCalledExactlyOnceWith(
      refreshedTarget,
    );
    expect(harness.unfence).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.readActiveTarget()).toBe(refreshedTarget);
  });

  it('does not promote refreshed same-model binding facts from model-id-only readback', async () => {
    const active = provider('pc_work', 'old');
    const harness = createHarness({
      initial: active,
      readRuntimeModelId: () => active.modelId,
    });
    const refreshedTarget = {
      ...authorized(active),
      providerBinding: {
        ...runtimeBinding(
          ProviderConnectionIdSchema.parse('pc_work'),
          'old',
        ),
        model: {
          id: 'old',
          name: 'Refreshed model',
          contextWindowTokens: 200_000,
        },
      },
      sessionBindingMetadata: {
        ...providerBindingMetadata(
          ProviderConnectionIdSchema.parse('pc_work'),
          'old',
        ),
        model: {
          id: 'old',
          name: 'Refreshed model',
          contextWindowTokens: 200_000,
        },
        bindingSecurityFingerprint: 'security:old:refreshed-capabilities',
      },
    } satisfies AuthorizedSessionModelTransitionTarget;
    harness.authorize.mockResolvedValueOnce(refreshedTarget);
    harness.applyRuntime.mockResolvedValueOnce({
      status: 'unproven',
      reason: 'runtime_model_transition_outcome_unproven',
      readbackAfterCompletion: true,
    });

    await expect(
      harness.coordinator.submit(active, { source: 'command' }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
    });
    expect(harness.publishActive).not.toHaveBeenCalled();
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('does not republish an already-persisted metadata-origin selection', async () => {
    const active = provider('pc_work', 'old');
    const harness = createHarness({ initial: active });

    await expect(
      harness.coordinator.submit(active, { source: 'metadata' }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'already_active',
      activeSelection: active,
    });

    expect(harness.publishIntent).not.toHaveBeenCalled();
    expect(harness.applyRuntime).not.toHaveBeenCalled();
  });

  it('coalesces a command publication echo without superseding the command or applying twice', async () => {
    const harness = createHarness();
    const next = provider('pc_work', 'next');
    let metadataEcho: Promise<unknown> | null = null;
    harness.publishIntent.mockImplementationOnce(async (selection) => {
      metadataEcho = harness.coordinator.submit(selection, { source: 'metadata' });
      return { accepted: true, updatedAt: 10 };
    });

    const command = harness.coordinator.submit(next, { source: 'command' });

    await expect(command).resolves.toMatchObject({
      ok: true,
      status: 'applied',
      activeSelection: next,
    });
    await expect(metadataEcho).resolves.toMatchObject({
      ok: true,
      status: 'applied',
      activeSelection: next,
    });
    expect(harness.publishIntent).toHaveBeenCalledTimes(1);
    expect(harness.applyRuntime).toHaveBeenCalledTimes(1);
  });

  it('keeps the latest A proposal after a not-yet-effectful A to B to A sequence', async () => {
    const harness = createHarness();
    const firstAuthorization = deferred<AuthorizedSessionModelTransitionTarget>();
    const firstSelection = provider('pc_work', 'first');
    const secondSelection = provider('pc_work', 'second');
    harness.authorize.mockImplementationOnce(
      async () => await firstAuthorization.promise,
    );

    const first = harness.coordinator.submit(firstSelection, { source: 'command' });
    await vi.waitFor(() => expect(harness.authorize).toHaveBeenCalledTimes(1));
    const second = harness.coordinator.submit(secondSelection, { source: 'command' });
    const latest = harness.coordinator.submit(firstSelection, { source: 'command' });
    firstAuthorization.resolve(authorized(firstSelection));

    await expect(first).resolves.toMatchObject({ ok: false, status: 'superseded' });
    await expect(second).resolves.toMatchObject({ ok: false, status: 'superseded' });
    await expect(latest).resolves.toMatchObject({
      ok: true,
      status: 'applied',
      activeSelection: firstSelection,
    });
    expect(harness.applyRuntime.mock.calls.map(([target]) => target.selection.modelId))
      .toEqual(['first']);
  });

  it('finishes reconciliation for an effected proposal without erasing the latest pending proposal', async () => {
    const harness = createHarness();
    const firstApply = deferred<Readonly<{ status: 'applied' }>>();
    harness.applyRuntime.mockImplementationOnce(async (target) => {
      harness.events.push(`apply:${target.selection.modelId}`);
      return await firstApply.promise;
    });

    const first = harness.coordinator.submit(provider('pc_work', 'first'), { source: 'command' });
    await vi.waitFor(() => expect(harness.fence).toHaveBeenCalledTimes(1));
    const second = harness.coordinator.submit(provider('pc_work', 'second'), { source: 'command' });
    firstApply.resolve({ status: 'applied' });

    await expect(first).resolves.toMatchObject({ ok: true, status: 'applied' });
    await expect(second).resolves.toMatchObject({ ok: true, status: 'applied' });
    expect(harness.applyRuntime.mock.calls.map(([target]) => target.selection.modelId))
      .toEqual(['first', 'second']);
    expect(harness.publishActive.mock.calls.map(([target]) => target.selection.modelId))
      .toEqual(['first', 'second']);
  });

  it('finishes an effected live proposal before classifying the latest proposal as restart-required', async () => {
    const harness = createHarness();
    const firstApply = deferred<Readonly<{ status: 'applied' }>>();
    harness.applyRuntime.mockImplementationOnce(async (target) => {
      harness.events.push(`apply:${target.selection.modelId}`);
      return await firstApply.promise;
    });

    const firstSelection = provider('pc_work', 'first');
    const restartSelection = provider('pc_other', 'restart-next');
    const first = harness.coordinator.submit(
      firstSelection,
      { source: 'command' },
    );
    await vi.waitFor(() => expect(harness.applyRuntime).toHaveBeenCalledTimes(1));
    harness.authorize.mockResolvedValueOnce(
      authorized(restartSelection, 'restart_session'),
    );
    const restart = harness.coordinator.submit(
      restartSelection,
      { source: 'command' },
    );
    firstApply.resolve({ status: 'applied' });

    await expect(first).resolves.toMatchObject({
      ok: true,
      status: 'applied',
      activeSelection: firstSelection,
    });
    await expect(restart).resolves.toMatchObject({
      ok: false,
      status: 'restart_required',
      activeSelection: firstSelection,
      requestedSelection: restartSelection,
    });
    expect(harness.applyRuntime.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['first']);
    expect(harness.publishActive.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['first']);
    expect(harness.publishIntent.mock.calls.map(
      ([selection]) => selection.modelId,
    )).toEqual(['first', 'restart-next']);
    expect(harness.events).toEqual([
      'intent:first',
      'fence',
      'apply:first',
      'active:first',
      'intent:restart-next',
      'unfence',
    ]);
    expect(harness.fence).toHaveBeenCalledTimes(1);
    expect(harness.unfence).toHaveBeenCalledTimes(1);
  });

  it('does not publish or unfence a completion from a retired run', async () => {
    const harness = createHarness();
    const apply = deferred<Readonly<{ status: 'applied' }>>();
    harness.applyRuntime.mockImplementationOnce(async () => await apply.promise);

    const result = harness.coordinator.submit(provider('pc_work', 'next'), { source: 'command' });
    await vi.waitFor(() => expect(harness.fence).toHaveBeenCalledTimes(1));
    harness.retireRun();
    apply.resolve({ status: 'applied' });

    await expect(result).resolves.toMatchObject({ ok: false, status: 'owner_unavailable' });
    expect(harness.publishActive).not.toHaveBeenCalled();
    expect(harness.unfence).not.toHaveBeenCalled();
  });

  it('drains an in-flight active-fact publication before retiring the run owner', async () => {
    const harness = createHarness();
    const publication = deferred<void>();
    harness.publishActive.mockImplementationOnce(async (target) => {
      await publication.promise;
      harness.events.push(`active:${target.selection.modelId}`);
    });

    const result = harness.coordinator.submit(
      provider('pc_work', 'next'),
      { source: 'command' },
    );
    await vi.waitFor(() => expect(harness.publishActive).toHaveBeenCalledTimes(1));

    let retirementSettled = false;
    const retirement = harness.coordinator.dispose().then(() => {
      retirementSettled = true;
    });
    await Promise.resolve();

    expect(retirementSettled).toBe(false);
    await expect(harness.coordinator.submit(
      provider('pc_work', 'after-retirement-started'),
      { source: 'command' },
    )).resolves.toMatchObject({ ok: false, status: 'owner_unavailable' });

    publication.resolve();
    await expect(result).resolves.toMatchObject({ ok: true, status: 'applied' });
    await retirement;
    expect(harness.events).toEqual([
      'intent:next',
      'fence',
      'apply:next',
      'active:next',
      'unfence',
    ]);
  });

  it('cancels and clears a pre-runtime fence during disposal without applying', async () => {
    const harness = createHarness();
    const fence = deferred<void>();
    harness.fence.mockImplementationOnce(async () => await fence.promise);

    const result = harness.coordinator.submit(
      provider('pc_work', 'next'),
      { source: 'command' },
    );
    await vi.waitFor(() => expect(harness.fence).toHaveBeenCalledTimes(1));

    const retirement = harness.coordinator.dispose();
    fence.resolve();

    await expect(result).resolves.toMatchObject({
      ok: false,
      status: 'owner_unavailable',
    });
    await retirement;
    expect(harness.applyRuntime).not.toHaveBeenCalled();
    expect(harness.publishActive).not.toHaveBeenCalled();
    expect(harness.unfence).toHaveBeenCalledTimes(1);
  });

  it('clears a retained pre-runtime fence when retirement removes its pending successor', async () => {
    const harness = createHarness();
    const fence = deferred<void>();
    harness.fence.mockImplementationOnce(async () => await fence.promise);

    const first = harness.coordinator.submit(
      provider('pc_work', 'first'),
      { source: 'command' },
    );
    await vi.waitFor(() => expect(harness.fence).toHaveBeenCalledTimes(1));
    const second = harness.coordinator.submit(
      provider('pc_work', 'second'),
      { source: 'command' },
    );
    const retirementAfterFirst = first.then(async (result) => {
      await harness.coordinator.dispose();
      return result;
    });
    fence.resolve();

    await expect(retirementAfterFirst).resolves.toMatchObject({
      ok: false,
      status: 'superseded',
    });
    await expect(second).resolves.toMatchObject({
      ok: false,
      status: 'owner_unavailable',
    });
    expect(harness.applyRuntime).not.toHaveBeenCalled();
    expect(harness.unfence).toHaveBeenCalledTimes(1);
  });
});
