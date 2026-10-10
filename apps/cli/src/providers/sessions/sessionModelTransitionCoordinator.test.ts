import { describe, expect, it, vi } from 'vitest';

import {
  projectAgentSessionProviderBindingV1,
  ProviderConnectionIdSchema,
  type ProviderConnectionId,
  type ProviderBoundModelRef,
  type ProviderRuntimeBindingBasisV1,
  type SessionProviderBindingMetadataV1,
} from '@happier-dev/protocol';
import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';
import { SessionModelTransitionResultV1Schema } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import { createModelIntentMetadataCasCandidate } from '@happier-dev/agents/session/state/metadataWriters';

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
  agentTargetKey: 'agent:happier.agent.claude/claude',
  providerConnectionId: null,
  modelId,
});
const modelMutationScope = { serverId: 'home', accountId: 'account-1', sessionId: 'session-1' };

const provider = (
  connectionId: string,
  modelId: string,
): ProviderBoundModelRef => ({
  agentTargetKey: 'agent:happier.agent.claude/claude',
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
  agentTargetKey: 'agent:happier.agent.claude/claude',
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
      implementationIdentity: {
        pluginId: 'provider.test',
        localId: 'gateway',
      },
      managedRuntime: {
        kind: 'managed',
        dependencies: [],
        endpointTemplateIds: ['messages'],
        connectedAccounts: purposes.map((purpose) => ({
          purpose,
          service: {
            pluginId: 'connected.test',
            localId: 'account',
          },
          required: true,
          materializationKinds: ['httpHeaders'],
        })),
        requestAuthUses: purposes.map((purpose) => ({
          purpose,
          materialization: {
            kind: 'httpHeaders' as const,
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
          },
        })),
      },
      purposeBindings,
    },
    agentTargetKey: 'agent:happier.agent.claude/claude',
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
  basis = runtimeBindingBasis(connectionId),
): AgentSessionProviderBinding => projectAgentSessionProviderBindingV1({
  metadata: {
    ...providerBindingMetadata(connectionId, modelId),
    runtimeBindingBasis: basis,
  },
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
  publishIntent?: Parameters<typeof createSessionModelTransitionCoordinator>[0]['publishIntent'];
  ownerScope?: typeof modelMutationScope;
  authorize?: Parameters<typeof createSessionModelTransitionCoordinator>[0]['authorize'];
  initial?: ProviderBoundModelRef;
  initialTarget?: AuthorizedSessionModelTransitionTarget;
  authoritativeRuntimeReadback?: boolean;
  checkCurrentPublisherAuthority?: () => Promise<boolean>;
  readRuntimeModelId?: () => Promise<string | null> | string | null;
  subscribeRuntimeModelChanges?: (handler: () => void) => () => void;
}>) {
  let current =
    params?.initialTarget?.selection
    ?? params?.initial
    ?? provider('pc_work', 'old');
  let currentRun = true;
  const events: string[] = [];
  const authorize = vi.fn(params?.authorize ?? (async (selection: ProviderBoundModelRef) => authorized(selection)));
  const publishIntent = vi.fn<Parameters<typeof createSessionModelTransitionCoordinator>[0]['publishIntent']>(params?.publishIntent ?? (async (selection) => {
    events.push(`intent:${selection.modelId}`);
    return { accepted: true, updatedAt: Date.now() };
  }));
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
  const revokeActiveSelectionProof = vi.fn(async () => undefined);
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
    ...(params?.ownerScope ? { ownerScope: params.ownerScope } : {}),
    runId: 'run-1',
    agentTargetKey: 'agent:happier.agent.claude/claude',
    initialActiveTarget: params?.initialTarget ?? authorized(current),
    isCurrentRun: () => currentRun,
    checkCurrentPublisherAuthority:
      params?.checkCurrentPublisherAuthority ?? (async () => true),
    authorize,
    publishIntent,
    applyRuntime,
    publishActive,
    revokeActiveSelectionProof,
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
    revokeActiveSelectionProof,
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
  it('reads applied X while Y is only pending, but refuses unknown runtime custody after effect starts', async () => {
    const initialTarget = authorized(native('X'));
    let active = () => initialTarget;
    const authorizer = createSessionModelTransitionAuthorizer({
      agentId: 'claude', agentTargetKey: native('X').agentTargetKey,
      sessionId: 'session-1', machineId: 'machine-1', nativeModelApplyPolicy: 'live',
      readActiveTarget: () => active(),
    });
    // Publication and Agent application are external custody boundaries; the
    // real coordinator and native authorizer own all transition decisions.
    const publicationStarted = deferred<void>();
    const publicationRelease = deferred<void>();
    const applicationStarted = deferred<void>();
    const applicationRelease = deferred<void>();
    let current = true;
    const coordinator = createSessionModelTransitionCoordinator({
      runId: 'run-1', agentTargetKey: native('X').agentTargetKey, initialActiveTarget: initialTarget,
      isCurrentRun: () => current, checkCurrentPublisherAuthority: async () => current,
      authorize: authorizer,
      publishIntent: async () => {
        publicationStarted.resolve(); await publicationRelease.promise;
        return { accepted: true, updatedAt: 1 };
      },
      applyRuntime: async () => {
        applicationStarted.resolve(); await applicationRelease.promise;
        return { status: 'applied' };
      },
      publishActive: async () => undefined, revokeActiveSelectionProof: async () => undefined,
      fencePromptAdmission: async () => undefined, clearPromptAdmission: async () => undefined,
      transferPromptAdmission: async (_epoch, input) => { await input.dispatch(); return { status: 'dispatched', value: undefined }; },
    });
    active = coordinator.readActiveTarget;
    try {
      const transition = coordinator.submit(native('Y'), { source: 'command' });
      await publicationStarted.promise;
      expect(await coordinator.readAppliedTarget()).toMatchObject({ status: 'applied', target: { selection: native('X') } });
      publicationRelease.resolve();
      await applicationStarted.promise;
      expect(await coordinator.readAppliedTarget()).toEqual({ status: 'unavailable' });
      applicationRelease.resolve();
      await expect(transition).resolves.toMatchObject({ ok: true, activeSelection: native('Y') });
      expect(await coordinator.readAppliedTarget()).toMatchObject({ status: 'applied', target: { selection: native('Y') } });
      current = false;
      expect(await coordinator.readAppliedTarget()).toEqual({ status: 'unavailable' });
    } finally {
      publicationRelease.resolve(); applicationRelease.resolve(); await coordinator.dispose();
    }
  });
  it('captures active owner state and conditionally restores it, refusing an intervening model or a replacement run', async () => {
    let intent = { modelSelectionIntentV1: { v: 1 as const, updatedAt: 1, selection: native('old') } };
    let order = 10;
    let publicationPause: { ready: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | null = null;
    const authorizer = createSessionModelTransitionAuthorizer({ sessionId: 'session-1', machineId: 'machine-1',
      agentId: 'claude', agentTargetKey: native('old').agentTargetKey, nativeModelApplyPolicy: 'live',
      readActiveTarget: () => h.coordinator.readActiveTarget() });
    const h = createHarness({ initial: native('old'), authorize: authorizer, ownerScope: modelMutationScope,
      publishIntent: async (selection, expected, requiredBefore) => {
        const candidate = createModelIntentMetadataCasCandidate({ selection, nowMs: () => ++order, ownerScope: modelMutationScope,
          ...(requiredBefore ? { captureBefore: true, requiredBefore } : {}),
          ...(expected ? { expected: { owner: 'inactive', scope: modelMutationScope, ...expected } } : {}) });
        intent = candidate.update(intent);
        const state = candidate.readState();
        if (publicationPause) {
          publicationPause.ready.resolve(undefined);
          await publicationPause.release.promise;
        }
        return { accepted: state.accepted, updatedAt: state.updatedAt ?? 0 };
      } });
    const priorIntent = intent;
    expect(await h.coordinator.submit(native('unexpected'), { source: 'command',
      expected: { owner: 'active', scope: modelMutationScope, runId: 'run-1', selection: native('different'), updatedAt: 1 } }))
      .toMatchObject({ ok: false, status: 'superseded' });
    expect(intent).toBe(priorIntent);
    expect(h.coordinator.readActiveTarget().selection).toEqual(native('old'));
    expect(await h.coordinator.submit(native('unexpected'), { source: 'command',
      expected: { owner: 'active', scope: { ...modelMutationScope, serverId: 'other-home' }, runId: 'run-1', selection: native('old'), updatedAt: 1 } }))
      .toMatchObject({ ok: false, status: 'superseded' });
    expect(intent).toBe(priorIntent);
    const applied = await h.coordinator.submit(native('new'), { source: 'command', captureBefore: true });
    expect(applied).toMatchObject({ ok: true, reversal: {
      owner: 'active', scope: modelMutationScope, runId: 'run-1', before: native('old'), applied: native('new'), updatedAt: 11,
    } });
    expect(await h.coordinator.submit(native('old'), { source: 'command',
      expected: { owner: 'active', scope: modelMutationScope, runId: 'run-1', selection: native('new'), updatedAt: 11 } })).toMatchObject({ ok: true });
    expect(await h.coordinator.submit(native('new'), { source: 'command', captureBefore: true }))
      .toMatchObject({ ok: true, reversal: { before: native('old'), applied: native('new'), updatedAt: 13 } });
    // The newer intent has won storage, but its acknowledgement is in flight.
    // A stale Undo must not cancel that real transition before its CAS refuses.
    publicationPause = { ready: deferred<void>(), release: deferred<void>() };
    const intervening = h.coordinator.submit(native('intervening'), { source: 'command' });
    await publicationPause.ready.promise;
    const staleUndo = h.coordinator.submit(native('old'), { source: 'command',
      expected: { owner: 'active', scope: modelMutationScope, runId: 'run-1', selection: native('new'), updatedAt: 13 } });
    publicationPause.release.resolve(undefined);
    expect(await intervening).toMatchObject({ ok: true });
    expect(await staleUndo).toMatchObject({ ok: false, status: 'superseded' });
    publicationPause = null;
    expect(h.coordinator.readActiveTarget().selection).toEqual(native('intervening'));
    // A capture queued behind an ordinary same-target write must obtain its
    // own exact receipt rather than inherit the unreceipted command result.
    publicationPause = { ready: deferred<void>(), release: deferred<void>() };
    const ordinary = h.coordinator.submit(native('coalescing'), { source: 'command' });
    await publicationPause.ready.promise;
    const sameTargetCapture = h.coordinator.submit(native('coalescing'), { source: 'command', captureBefore: true });
    publicationPause.release.resolve(undefined);
    expect(await ordinary).toMatchObject({ ok: true });
    expect(await sameTargetCapture).toMatchObject({ ok: true, reversal: {
      before: native('coalescing'), applied: native('coalescing'), updatedAt: 16,
    } });
    publicationPause = null;
    expect(await h.coordinator.submit(native('old'), { source: 'command',
      expected: { owner: 'active', scope: modelMutationScope, runId: 'retired-run', selection: native('coalescing'), updatedAt: 16 } })).toMatchObject({ ok: false, status: 'superseded' });
    const captured = await h.coordinator.submit(native('new'), { source: 'command', captureBefore: true });
    expect(captured.ok).toBe(true);
    const appliedStamp = intent.modelSelectionIntentV1.updatedAt;
    // A restart-required choice can change durable intent while the live
    // selection remains applied. That newer choice must also defeat Undo.
    intent = { modelSelectionIntentV1: { v: 1, updatedAt: appliedStamp + 1, selection: native('future') } };
    expect(await h.coordinator.submit(native('old'), { source: 'command',
      expected: { owner: 'active', scope: modelMutationScope, runId: 'run-1', selection: native('new'), updatedAt: appliedStamp } })).toMatchObject({ ok: false, status: 'superseded' });
    expect(intent.modelSelectionIntentV1.selection).toEqual(native('future'));
    expect(h.coordinator.readActiveTarget().selection).toEqual(native('new'));
    expect(await h.coordinator.submit(native('different'), { source: 'command', captureBefore: true }))
      .toMatchObject({ ok: false });
    expect(intent.modelSelectionIntentV1.selection).toEqual(native('future'));
    expect(h.coordinator.readActiveTarget().selection).toEqual(native('new'));
    await h.coordinator.dispose();
  });

  it('checks each caller before coalescing an unrestricted native transition', async () => {
    const initial = native('A');
    const requested = native('B');
    const harness = createHarness({
      initial,
      authorize: createSessionModelTransitionAuthorizer({
        agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude', machineId: 'm1', sessionId: 's1', nativeModelApplyPolicy: 'live',
        readActiveTarget: () => authorized(initial),
      }),
    });
    const unrestricted = harness.coordinator.submit(requested, { source: 'command' });
    const restricted = harness.coordinator.submit(requested, {
      source: 'command', callerInputConstraints: { models: [initial], permissionModes: null },
    });
    await expect(restricted).resolves.toMatchObject({ ok: false, reason: 'model_not_granted' });
    await expect(unrestricted).resolves.toMatchObject({ ok: true, activeSelection: requested });
    expect(harness.readCurrent()).toEqual(requested);
    await harness.coordinator.dispose();
  });
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

  it('projects a plugin-authored transition reason through the canonical failure redactor', () => {
    // `RuntimeConfigUpdateOutcomeV1.reason` is an open public string. It leaves
    // the daemon through the Session transition result, Action details, and
    // `--json` stdout, so an ordinary runtime that wraps an upstream failure
    // must not carry a credential or a local path with it.
    const result = mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult({
      status: 'failed',
      reason: 'upstream rejected token sk-live-0123456789abcdefghij for /Users/alice/private-project',
    });

    if (result.status === 'applied') throw new Error('Expected a failed transition apply result');
    expect(result.status).toBe('failed');
    expect(result.reason).toBeTruthy();
    expect(result.reason).not.toContain('sk-live-0123456789abcdefghij');
    expect(result.reason).not.toContain('/Users/alice/private-project');
  });

  it('keeps a host-owned closed transition reason code exactly', () => {
    expect(
      mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult({
        status: 'unsupported',
        reason: 'provider_source_change_requires_restart',
      }),
    ).toEqual({
      status: 'unsupported',
      reason: 'provider_source_change_requires_restart',
    });
    expect(
      mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult({
        status: 'failed',
      }),
    ).toEqual({
      status: 'failed',
      reason: 'runtime_model_transition_not_applied',
    });
  });

  it('publishes a complete large plugin transition reason while preserving privacy', () => {
    const message = 'é'.repeat(4_000);
    const result = mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult({
      status: 'failed',
      reason: `client_secret=large-transition-secret path=/Users/alice/private/model.json; ${message}`,
    });

    if (result.status === 'applied') throw new Error('Expected a failed transition apply result');
    expect(result.status).toBe('failed');
    expect(result.reason).toContain(message);
    expect(result.reason).not.toContain('large-transition-secret');
    expect(result.reason).not.toContain('/Users/alice/private/model.json');
    const published = SessionModelTransitionResultV1Schema.parse({
      ok: false,
      status: 'apply_failed',
      activeSelection: native('old'),
      requestedSelection: native('next'),
      reason: result.reason,
    });
    expect(published).toMatchObject({ reason: result.reason });
  });

  it('publishes an admitted same-selection replacement target before making it active', async () => {
    const initial = authorized(provider('pc_work', 'old'));
    const successor = {
      ...initial,
      sessionBindingMetadata: {
        ...initial.sessionBindingMetadata!,
        bindingSecurityFingerprint: 'security:successor',
      },
    } satisfies AuthorizedSessionModelTransitionTarget;
    const harness = createHarness({ initialTarget: initial });

    await harness.coordinator.admitReplacementTarget(successor);

    expect(harness.publishActive).toHaveBeenCalledWith(successor);
    expect(harness.coordinator.readActiveTarget()).toBe(successor);
    expect(harness.events).toEqual(['active:old']);

    await harness.coordinator.dispose();
  });

  it('rejects a replacement admission that changes the active selection', async () => {
    const harness = createHarness();
    const successor = authorized(provider('pc_work', 'next'));

    await expect(
      harness.coordinator.admitReplacementTarget(successor),
    ).rejects.toThrow('replacement_target_selection_mismatch');

    expect(harness.publishActive).not.toHaveBeenCalled();
    expect(harness.coordinator.readActiveTarget().selection).toEqual(
      provider('pc_work', 'old'),
    );

    await harness.coordinator.dispose();
  });

  it('queues transitions while a stable active-target effect is in flight, then applies after release', async () => {
    const harness = createHarness();
    const effectStarted = deferred<void>();
    const releaseEffect = deferred<void>();
    const stable = harness.coordinator.runWithStableActiveTarget(
      async (target) => {
        expect(target.selection).toEqual(provider('pc_work', 'old'));
        effectStarted.resolve();
        await releaseEffect.promise;
        return 'launched';
      },
    );
    await effectStarted.promise;

    const transition = harness.coordinator.submit(
      provider('pc_work', 'next'),
      { source: 'command' },
    );
    await Promise.resolve();
    expect(harness.applyRuntime).not.toHaveBeenCalled();
    expect(harness.publishActive).not.toHaveBeenCalled();

    releaseEffect.resolve();
    await expect(stable).resolves.toEqual({
      status: 'completed',
      value: 'launched',
    });
    await expect(transition).resolves.toMatchObject({
      ok: true,
      status: 'applied',
      activeSelection: provider('pc_work', 'next'),
    });
  });

  it('releases a queued transition when a stable active-target effect fails', async () => {
    const harness = createHarness();
    const effectStarted = deferred<void>();
    const releaseEffect = deferred<void>();
    const stable = harness.coordinator.runWithStableActiveTarget(
      async () => {
        effectStarted.resolve();
        await releaseEffect.promise;
        throw new Error('terminal launch failed');
      },
    );
    await effectStarted.promise;
    const transition = harness.coordinator.submit(
      provider('pc_work', 'next'),
      { source: 'command' },
    );

    releaseEffect.resolve();
    await expect(stable).rejects.toThrow('terminal launch failed');
    await expect(transition).resolves.toMatchObject({
      ok: true,
      status: 'applied',
    });
    expect(harness.applyRuntime).toHaveBeenCalledTimes(1);
    expect(harness.publishActive).toHaveBeenCalledTimes(1);
  });

  it('waits for stable active-target custody before disposing and refuses new transitions', async () => {
    const harness = createHarness();
    const effectStarted = deferred<void>();
    const releaseEffect = deferred<void>();
    const stable = harness.coordinator.runWithStableActiveTarget(
      async () => {
        effectStarted.resolve();
        await releaseEffect.promise;
      },
    );
    await effectStarted.promise;
    const dispose = harness.coordinator.dispose();
    let disposed = false;
    void dispose.then(() => {
      disposed = true;
    });

    await expect(harness.coordinator.submit(
      provider('pc_work', 'next'),
      { source: 'command' },
    )).resolves.toMatchObject({
      ok: false,
      status: 'owner_unavailable',
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseEffect.resolve();
    await expect(stable).resolves.toMatchObject({ status: 'completed' });
    await dispose;
    expect(disposed).toBe(true);
  });

  it('retains prompt custody when superseded after active publication but before the custody check', async () => {
    const checkCurrentPublisherAuthority = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const harness = createHarness({ checkCurrentPublisherAuthority });
    const dispatch = vi.fn(async () => {});

    const result = await harness.coordinator.submit(
      provider('pc_work', 'next'),
      {
        source: 'prompt',
        runWithActiveSelection: async (consume) => {
          await consume({
            abortSignal: new AbortController().signal,
            dispatch,
          });
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'owner_unavailable',
    });
    expect(harness.publishActive).toHaveBeenCalledTimes(1);
    expect(checkCurrentPublisherAuthority).toHaveBeenCalledTimes(2);
    expect(harness.unfence).not.toHaveBeenCalled();
    expect(harness.transferPromptAdmission).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not start a runtime effect when superseded before the immediate effect check', async () => {
    const checkCurrentPublisherAuthority = vi.fn(async () => false);
    const harness = createHarness({ checkCurrentPublisherAuthority });

    const result = await harness.coordinator.submit(
      provider('pc_work', 'next'),
      { source: 'command' },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'owner_unavailable',
    });
    expect(checkCurrentPublisherAuthority).toHaveBeenCalledTimes(1);
    expect(harness.applyRuntime).not.toHaveBeenCalled();
    expect(harness.publishActive).not.toHaveBeenCalled();
    expect(harness.fence).toHaveBeenCalledTimes(1);
    expect(harness.unfence).not.toHaveBeenCalled();
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
      providerBinding: runtimeBinding(connectionId, active.modelId, basis),
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
      providerBinding: runtimeBinding(
        connectionId,
        active.modelId,
        activeMetadataBasis,
      ),
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
      providerBinding: runtimeBinding(
        connectionId,
        active.modelId,
        activeBasis,
      ),
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
