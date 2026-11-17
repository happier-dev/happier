import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import { createAgentRuntimeDaemonServiceAuthorityFixture } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthority.testkit';
import { publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { authorizeCurrentAgentRuntimeDaemonModelTransition } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import { AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';

import {
  projectAgentSessionProviderBindingV1,
  ProviderConnectionIdSchema,
  type ProviderConnectionId,
  type ProviderBoundModelRef,
  type TeamCredentialProviderModelSelectionV1,
  type ProviderRuntimeBindingBasisV1,
  type SessionProviderBindingMetadataV1,
  SessionProviderBindingMetadataV1Schema,
} from '@happier-dev/protocol';
import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';
import { SessionModelTransitionResultV1Schema } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import { createModelIntentMetadataCasCandidate, createModelIntentV2MetadataCasCandidate } from '@happier-dev/agents/session/state/metadataWriters';
import { readSessionModelSelectionV2FromMetadata } from '@happier-dev/agents/session/state/metadataReaders';
import { SessionModelSelectionV2Schema } from '@happier-dev/protocol/providers/selection/v2';

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
      gatewayPlacement: { kind: 'sessionMachine' },
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
  initialActiveTargetConfirmed?: boolean;
  readModelSelectionIntent?: Parameters<typeof createSessionModelTransitionCoordinator>[0]['readModelSelectionIntent'];
  authoritativeRuntimeReadback?: boolean;
  checkCurrentPublisherAuthority?: () => Promise<boolean>;
  readRuntimeModelId?: () => Promise<string | null> | string | null;
  subscribeRuntimeModelChanges?: Parameters<typeof createSessionModelTransitionCoordinator>[0]['subscribeRuntimeModelChanges'];
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
  const publishActive = vi.fn<Parameters<typeof createSessionModelTransitionCoordinator>[0]['publishActive']>(async (target) => {
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
    initialActiveTargetConfirmed: params?.initialActiveTargetConfirmed ?? true,
    readModelSelectionIntent: params?.readModelSelectionIntent ?? (() => null),
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

it('retains the external Agent source-read cause during native model authorization', async () => {
  const failureCause = { phase: 'turn_start', failureReason: 'rate_limit' } as const;
  let sourceReads = 0;
  const initialTarget = { ...authorized(native('old')),
    // The native Agent's opened-source reader is the system boundary.
    readAppliedTeamCredentialModel: () => {
      if (++sourceReads === 1) return null;
      throw Object.assign(new Error('private native source detail'), { failureCause });
    },
  };
  const authorize = createSessionModelTransitionAuthorizer({ sessionId: 'session-1', machineId: 'machine-1', agentId: 'claude',
    agentTargetKey: initialTarget.selection.agentTargetKey, nativeModelApplyPolicy: 'live', readActiveTarget: () => initialTarget });
  const unused = async (): Promise<never> => { throw new Error('Authorization failure must precede publication and runtime effects'); };
  const coordinator = createSessionModelTransitionCoordinator({ runId: 'source-read-failure',
    agentTargetKey: initialTarget.selection.agentTargetKey, initialActiveTarget: initialTarget, initialActiveTargetConfirmed: true,
    readModelSelectionIntent: () => null, isCurrentRun: () => true,
    // This is the admitted Home publisher transport response, not model authorization.
    checkCurrentPublisherAuthority: async () => true, authorize,
    publishIntent: unused, applyRuntime: unused, publishActive: unused, revokeActiveSelectionProof: unused,
    fencePromptAdmission: unused, clearPromptAdmission: unused, transferPromptAdmission: unused,
  });
  try {
    await expect(coordinator.submit(native('next'), { source: 'command' })).resolves.toMatchObject({
      ok: false, status: 'unsupported', failureCause,
    });
  } finally { await coordinator.dispose(); }
});

it.each(['withdrawn', 'unavailable'] as const)('retains the Home publisher decision during a stable model effect: %s', async state => {
  const initialTarget = authorized(native('old'));
  const failureCause = { phase: 'turn_start', failureReason: 'rate_limit' } as const;
  const authorize = createSessionModelTransitionAuthorizer({ sessionId: 'session-1', machineId: 'machine-1', agentId: 'claude',
    agentTargetKey: initialTarget.selection.agentTargetKey, nativeModelApplyPolicy: 'live', readActiveTarget: () => initialTarget });
  const unused = async (): Promise<never> => { throw new Error('Refused publisher must not perform effects'); };
  const coordinator = createSessionModelTransitionCoordinator({ runId: 'publisher-unavailable',
    agentTargetKey: initialTarget.selection.agentTargetKey, initialActiveTarget: initialTarget, initialActiveTargetConfirmed: true,
    readModelSelectionIntent: () => null, isCurrentRun: () => true, authorize,
    checkCurrentPublisherAuthority: async () => {
      if (state === 'unavailable') throw Object.assign(new Error('private Home transport detail'), { failureCause });
      return false;
    },
    publishIntent: unused, applyRuntime: unused, publishActive: unused, revokeActiveSelectionProof: unused,
    fencePromptAdmission: unused, clearPromptAdmission: unused, transferPromptAdmission: unused,
  });
  try {
    await expect(coordinator.runWithStableActiveTarget(unused)).resolves.toEqual({
      status: 'blocked', ...(state === 'unavailable' ? { failureCause } : {}),
    });
  } finally { await coordinator.dispose(); }
});

it.each([
  ['before', 'changed'], ['before', 'rejected'], ['after', 'changed'], ['after', 'rejected'],
  ['readback', 'rejected'], ['readback_publication', 'rejected'],
] as const)('retains Provider authority diagnostics %s the runtime effect: %s', async (phase, outcome) => {
  const root = await mkdtemp(join(tmpdir(), 'model-transition-currentness-'));
  const authority = await createAgentRuntimeDaemonServiceAuthorityFixture({ happyHomeDir: root,
    runner: { pid: 1234, processStartTimeMs: 1, processCommandHash: 'a'.repeat(64), snapshotIdentity: 'snapshot:fixture' } });
  const admitted = authorized(provider('pc_work', 'old'));
  const metadata = SessionProviderBindingMetadataV1Schema.parse(admitted.sessionBindingMetadata);
  const initial = { ...admitted, sessionBindingMetadata: metadata,
    runtimeBindingBasis: metadata.runtimeBindingBasis ?? null,
    providerBinding: projectAgentSessionProviderBindingV1({ metadata, materialization: { v: 1, kind: 'spawnEnv' } }),
  };
  const selection = provider('pc_work', 'next');
  const failureCause = { phase: 'provider.model_projection', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null } as const;
  let reads = 0;
  // Only the daemon HTTP boundary is replaced. The strict decoder, authorizer,
  // admission proof, transition coordinator and prompt-fence owner stay real.
  const server = createServer((_request, reply) => {
    const next = authorized(selection);
    const unavailable = ++reads >= (phase === 'before' ? 2 : phase === 'readback_publication' ? 4 : 3);
    const response = unavailable && outcome === 'rejected'
      ? { ok: false, error: { code: 'provider_endpoint_unavailable', message: 'provider_endpoint_unavailable', failureCause } }
      : { ok: true, result: { kind: 'model_transition', status: 'authorized', authorization: {
        selection, policy: 'live', model: { id: selection.modelId, name: 'Next' },
        sessionBindingMetadata: { ...next.sessionBindingMetadata,
          ...(unavailable ? { bindingSecurityFingerprint: 'security:changed' } : {}) },
        runtimeBindingBasis: next.runtimeBindingBasis,
      } } };
    AgentRuntimeDaemonServiceResponseV1Schema.parse(response);
    reply.setHeader('content-type', 'application/json');
    reply.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback daemon port');
  await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: address.port, capability: 'A'.repeat(43) });
  const input = createSessionProviderInputConsumer({
    messageQueue: new MessageQueue2<{ id: string }, string>(() => 'mode'),
    session: { waitForMetadataUpdate: () => new Promise<boolean>(() => {}) },
  });
  let coordinator: ReturnType<typeof createSessionModelTransitionCoordinator> | undefined;
  const authorize = createSessionModelTransitionAuthorizer({ sessionId: authority.sessionId, machineId: 'machine-1', agentId: 'claude',
    agentTargetKey: initial.selection.agentTargetKey, nativeModelApplyPolicy: 'live',
    readActiveTarget: () => coordinator?.readActiveTarget() ?? initial,
    authorizeProviderTarget: (request, signal) => authorizeCurrentAgentRuntimeDaemonModelTransition({
      authority, selection: request.selection, requestId: 'currentness', signal, timeoutMs: null,
    }),
  });
  let runtimeModelId = initial.selection.modelId;
  const unused = async (): Promise<never> => { throw new Error('Unexpected prompt custody transfer'); };
  coordinator = createSessionModelTransitionCoordinator({ runId: 'currentness', agentTargetKey: initial.selection.agentTargetKey,
    initialActiveTarget: initial, initialActiveTargetConfirmed: true, readModelSelectionIntent: () => null,
    isCurrentRun: () => true, checkCurrentPublisherAuthority: async () => true, authorize,
    publishIntent: async () => ({ accepted: true, updatedAt: 1 }),
    applyRuntime: async target => { runtimeModelId = target.selection.modelId;
      return phase.startsWith('readback') ? { status: 'unproven', readbackAfterCompletion: true } : { status: 'applied' }; },
    readRuntimeModelId: () => runtimeModelId,
    publishActive: async () => {}, revokeActiveSelectionProof: async () => {},
    fencePromptAdmission: async epochId => { await input.enforceProviderInputAdmission({ kind: 'action_required',
      reason: 'generation_pending', serviceId: 'host-runtime', groupId: 'model-transition', epochId }); },
    clearPromptAdmission: async epochId => { await input.clearProviderInputAdmission({ serviceId: 'host-runtime', groupId: 'model-transition', epochId }); },
    transferPromptAdmission: unused,
  });
  try {
    const result = await coordinator.submit(selection, { source: 'command' });
    expect(result).toMatchObject({ ok: false, status: phase === 'before' ? 'apply_failed' : 'reconciliation_required' });
    if (outcome === 'rejected') expect(result).toMatchObject({ failureCause: { actionCause: failureCause } });
    else expect(result).not.toMatchObject({ failureCause: { actionCause: { errorCode: 'ECONNRESET' } } });
    expect(runtimeModelId).toBe(phase === 'before' ? 'old' : 'next');
  } finally {
    await coordinator.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

describe('createSessionModelTransitionCoordinator', () => {
  it.each(['metadata', 'prompt'] as const)('retains an admitted Connected Account source when %s echoes its native model intent', async source => {
    const selection = native('meta/muse-spark-1.3-contributor');
    const descriptor = runtimeBinding(ProviderConnectionIdSchema.parse('pc_fixture'), 'muse-spark-1.3-contributor');
    let sourceCurrent = true;
    const initialTarget: AuthorizedSessionModelTransitionTarget = {
      ...authorized(selection, 'restart_session'),
      revalidateBeforeEffect: async () => sourceCurrent,
      providerBinding: {
        source: { kind: 'connected_account',
          purpose: { consumer: { pluginId: 'agent.test', localId: 'coding' }, purpose: 'inference' },
          account: { service: { pluginId: 'connected.test', localId: 'muse' }, accountId: 'selected' } },
        model: descriptor.model, upstream: descriptor.upstream, materialization: descriptor.materialization,
      },
    };
    const authorize = createSessionModelTransitionAuthorizer({
      sessionId: 'source-session', machineId: 'machine-1', agentId: 'claude',
      agentTargetKey: selection.agentTargetKey, nativeModelApplyPolicy: 'live',
      readActiveTarget: () => initialTarget,
    });
    const harness = createHarness({ initialTarget, authorize });
    try {
      await expect(harness.coordinator.submit(selection, { source, reuseInitialAdmission: source === 'metadata',
        runWithActiveSelection: async transfer => {
          await transfer({ abortSignal: new AbortController().signal, dispatch: async () => {
            expect(harness.coordinator.readActiveTarget().providerBinding).toEqual(initialTarget.providerBinding);
          } });
        },
      }))
        .resolves.toMatchObject({ ok: true, status: 'already_active' });
      expect(harness.coordinator.readActiveTarget().providerBinding).toEqual(initialTarget.providerBinding);
      expect(harness.applyRuntime).not.toHaveBeenCalled();
      const replacement = await authorize({ ...selection, modelId: 'meta/another-model' });
      expect(replacement).toMatchObject({ policy: 'restart_session', providerBinding: null });
      sourceCurrent = false;
      expect(await authorize.bindCurrentAuthorizationProof(initialTarget).revalidateBeforeEffect()).toBe(false);
      await expect(harness.coordinator.readAppliedTarget()).resolves.toMatchObject({
        status: 'unavailable', reason: 'runtime_model_unconfirmed',
      });
    } finally { await harness.coordinator.dispose(); }
  });

  it.each(['native refusal', 'spawn policy', 'provider spawn policy'] as const)('reprepares a %s model inside prompt custody before dispatch', async source => {
    const selection = source === 'provider spawn policy' ? provider('pc_next', 'next') : native('next');
    let runtimeModelId = 'old';
    const harness = createHarness({ initial: source === 'provider spawn policy' ? provider('pc_old', 'old') : native('old'), authorize: async requested => ({
      ...authorized(requested), policy: source === 'native refusal' ? 'live' : 'restart_session',
    }) });
    // Native configuration/reopen are external effects. The scheduler,
    // authorization, publication and custody transfer below remain real.
    harness.applyRuntime.mockImplementation(async () => runtimeModelId === selection.modelId
      ? { status: 'applied' } : { status: 'requires_restart' });
    let restartCount = 0;
    let dispatched = false;
    const context = {
      source: 'prompt' as const,
      restartRuntime: { required: false, run: async () => {
          restartCount++;
          expect(harness.publishIntent).toHaveBeenCalledWith(selection);
          expect(harness.publishActive).not.toHaveBeenCalled();
          if (source === 'provider spawn policy') {
            const openedTarget = harness.coordinator.readReplacementTarget();
            expect(openedTarget.selection).toEqual(selection);
            await harness.coordinator.admitReplacementTarget(openedTarget);
          }
          runtimeModelId = selection.modelId;
        } },
      runWithActiveSelection: async (transfer: Parameters<NonNullable<Parameters<typeof harness.coordinator.submit>[1]['runWithActiveSelection']>>[0]) => {
        await transfer({ abortSignal: new AbortController().signal, dispatch: async () => {
          expect(runtimeModelId).toBe(selection.modelId);
          expect(harness.coordinator.readActiveTarget().selection).toEqual(selection);
          dispatched = true;
        } });
      },
    };
    await expect(harness.coordinator.submit(selection, context)).resolves.toMatchObject({ ok: true, activeSelection: selection });
    expect(restartCount).toBe(1);
    expect(dispatched).toBe(true);
    await harness.coordinator.dispose();
  });

  it('reopens a current V2 Team revision carried by the next prompt before dispatch', async () => {
    const selection = native('model');
    let appliedTeam = { kind: 'team_credential_provider_model' as const, resourceId: 'resource', teamId: 'team',
      expectedResourceRevision: 0, deliveryMode: 'brokered' as const, agentTargetKey: selection.agentTargetKey, modelId: selection.modelId };
    const { kind: _kind, ...ref } = appliedTeam;
    const current = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 42, ref: {
      source: 'team_resource', ...ref, expectedResourceRevision: 2,
    } });
    const initialTarget = { ...authorized(selection), readAppliedTeamCredentialModel: () => appliedTeam };
    const authorize = createSessionModelTransitionAuthorizer({ sessionId: 'session-1', machineId: 'machine-1',
      agentId: 'claude', agentTargetKey: selection.agentTargetKey, nativeModelApplyPolicy: 'live',
      readActiveTarget: () => initialTarget });
    const harness = createHarness({ initialTarget, authorize });
    let dispatched = false;
    try {
      const result = await harness.coordinator.submit(current.ref, { source: 'prompt',
        restartRuntime: { required: false, run: async () => { appliedTeam = { ...appliedTeam, expectedResourceRevision: 2 }; } },
        runWithActiveSelection: async transfer => { await transfer({ abortSignal: new AbortController().signal,
          dispatch: async () => { dispatched = true; expect(appliedTeam.expectedResourceRevision).toBe(2); } }); },
      });
      expect(result).toMatchObject({ ok: true });
      expect(dispatched).toBe(true);
      expect(harness.publishIntent).toHaveBeenCalledWith(current.ref);
    } finally { await harness.coordinator.dispose(); }
  });

  it('clears the opened Team route before dispatching an explicit V2 native choice', async () => {
    const selection = native('same-model');
    let appliedTeam: TeamCredentialProviderModelSelectionV1 | null = {
      kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team',
      expectedResourceRevision: 2, deliveryMode: 'brokered', ...selection,
    };
    const initialTarget = { ...authorized(selection), readAppliedTeamCredentialModel: () => appliedTeam };
    const authorize = createSessionModelTransitionAuthorizer({ sessionId: 'session-1', machineId: 'machine-1',
      agentId: 'claude', agentTargetKey: selection.agentTargetKey, nativeModelApplyPolicy: 'live',
      readActiveTarget: () => initialTarget });
    const harness = createHarness({ initialTarget, authorize });
    const ref = { source: 'native' as const, agentTargetKey: selection.agentTargetKey, modelId: selection.modelId };
    try {
      await expect(harness.coordinator.submit(ref, { source: 'prompt',
        restartRuntime: { run: async () => { appliedTeam = null; } },
        runWithActiveSelection: async transfer => { await transfer({ abortSignal: new AbortController().signal,
          dispatch: async () => { expect(appliedTeam).toBeNull(); } }); },
      })).resolves.toMatchObject({ ok: true });
      expect(harness.publishIntent).toHaveBeenCalledWith(ref);
    } finally { await harness.coordinator.dispose(); }
  });

  it.each([false, true])('compares the startup Team metadata echo with its opened source (changed: %s)', async changed => {
    const selection = native('same-model');
    const team = { kind: 'team_credential_provider_model' as const,
      resourceId: 'resource-1', teamId: 'team-1', expectedResourceRevision: 4,
      deliveryMode: 'brokered' as const, agentTargetKey: selection.agentTargetKey, modelId: selection.modelId };
    const initialTarget = { ...authorized(selection), readAppliedTeamCredentialModel: () => team };
    const { kind: _kind, ...ref } = team;
    const intent = { v: 2 as const, updatedAt: 42,
      ref: { ...ref, source: 'team_resource' as const, resourceId: changed ? 'resource-2' : team.resourceId } };
    const authorize = createSessionModelTransitionAuthorizer({ sessionId: 'session-1', machineId: 'machine-1',
      agentId: 'claude', agentTargetKey: selection.agentTargetKey, nativeModelApplyPolicy: 'live',
      readActiveTarget: () => harness.coordinator.readActiveTarget() });
    const harness = createHarness({ initialTarget, authorize, readModelSelectionIntent: () => intent });
    try {
      const result = await harness.coordinator.submit(selection, { source: 'metadata', reuseInitialAdmission: true });
      expect(result).toMatchObject(changed ? { ok: false, status: 'restart_required' }
        : { ok: true, status: 'already_active', activeSelection: selection });
      expect(harness.coordinator.readActiveTarget().readAppliedTeamCredentialModel?.()).toEqual(team);
    } finally { await harness.coordinator.dispose(); }
  });

  it.each([['brokered', 0, true], ['brokered', 1, false], ['vendor-native', 0, false]] as const)(
    'reopens the same Team broker binding for a carried model change before dispatching the next prompt (%s, revision %s)', async (deliveryMode, expectedResourceRevision, canApply) => {
    const selection = native('muse-spark-1.2');
    const next = native('muse-spark-1.3');
    let appliedTeam = { kind: 'team_credential_provider_model' as const,
      resourceId: 'qa-team-delivery-2-1112-muse', teamId: 'team-1', expectedResourceRevision: 0,
      deliveryMode, agentTargetKey: selection.agentTargetKey, modelId: selection.modelId };
    const initialTarget = { ...authorized(selection), readAppliedTeamCredentialModel: () => appliedTeam };
    const candidate = createModelIntentV2MetadataCasCandidate({ selection: { v: 2, updatedAt: 0, ref: {
      source: 'team_resource', resourceId: appliedTeam.resourceId, teamId: appliedTeam.teamId,
      expectedResourceRevision, deliveryMode, agentTargetKey: selection.agentTargetKey, modelId: next.modelId,
    } } });
    const metadata = candidate.update({});
    const authorize = createSessionModelTransitionAuthorizer({ sessionId: 'session-1', machineId: 'machine-1',
      agentId: 'claude', agentTargetKey: selection.agentTargetKey, nativeModelApplyPolicy: 'live',
      readActiveTarget: () => harness.coordinator.readActiveTarget() });
    const harness = createHarness({ initialTarget, authorize,
      readModelSelectionIntent: () => readSessionModelSelectionV2FromMetadata(metadata) });
    let restarts = 0;
    let dispatched = false;
    try {
      const requested = harness.coordinator.readArmedSelection();
      expect(requested).toEqual(next);
      if (!requested) throw new Error('Expected pending Team model intent for the next prompt');
      const result = await harness.coordinator.submit(requested, { source: 'prompt',
        restartRuntime: { required: false, run: async () => {
          restarts++;
          // The process boundary opens the replacement with the requested model.
          expect(harness.coordinator.readReplacementTarget().selection).toEqual(next);
          appliedTeam = { ...appliedTeam, modelId: next.modelId };
        } },
        runWithActiveSelection: async transfer => {
          await transfer({ abortSignal: new AbortController().signal, dispatch: async () => {
            dispatched = true;
            expect(harness.coordinator.readActiveTarget().readAppliedTeamCredentialModel?.())
              .toEqual(appliedTeam);
          } });
        },
      });
      if (!canApply) {
        expect(result).toMatchObject({ ok: false, status: 'restart_required', reason: 'team_resource_binding_changed' });
        expect(restarts).toBe(0);
        expect(dispatched).toBe(false);
        expect(harness.publishIntent).not.toHaveBeenCalled();
        return;
      }
      expect(result).toMatchObject({ ok: true, status: 'applied', activeSelection: next });
      expect(restarts).toBe(1);
      expect(dispatched).toBe(true);
      expect(harness.coordinator.readArmedSelection()).toBeNull();
      expect(harness.publishIntent).not.toHaveBeenCalled();
      expect(readSessionModelSelectionV2FromMetadata(metadata)?.ref).toMatchObject({
        source: 'team_resource', resourceId: appliedTeam.resourceId, modelId: next.modelId,
      });
    } finally { await harness.coordinator.dispose(); }
  });

  it.each(['brokered', 'vendor-native'] as const)('retains a %s Team model intent through repeated carried prompts and a failed turn, while explicit native selection replaces it', async deliveryMode => {
    const selection = native('same-model');
    const nativeDelivery = deliveryMode === 'vendor-native' ? { managedId: 'managed', controllerInstallationId: 'controller-installation',
      guestInstallationId: 'guest-installation', bindingKey: 'binding', placeholderRef: 'placeholder',
      sourceRevision: 'source-v1', providerTicket: 't'.repeat(43) } : undefined;
    const team = { kind: 'team_credential_provider_model' as const, resourceId: 'resource-1', teamId: 'team-1',
      expectedResourceRevision: 7, deliveryMode, agentTargetKey: selection.agentTargetKey, modelId: selection.modelId,
      ...(nativeDelivery ? { nativeDelivery } : {}) };
    const initialTarget = { ...authorized(selection), readAppliedTeamCredentialModel: () => team };
    let metadata = { modelSelectionIntentV2: { v: 2 as const, updatedAt: 10, ref: {
      source: 'team_resource' as const, resourceId: team.resourceId, teamId: team.teamId,
      expectedResourceRevision: team.expectedResourceRevision, deliveryMode: team.deliveryMode,
      agentTargetKey: selection.agentTargetKey, modelId: selection.modelId,
      ...(nativeDelivery ? { nativeDelivery } : {}),
    } } };
    const retained = metadata;
    let intentWrites = 0;
    const authorize = createSessionModelTransitionAuthorizer({ sessionId: 'session-1', machineId: 'machine-1',
      agentId: 'claude', agentTargetKey: selection.agentTargetKey, nativeModelApplyPolicy: 'live',
      readActiveTarget: () => initialTarget });
    const harness = createHarness({ initialTarget, authorize,
      readModelSelectionIntent: () => readSessionModelSelectionV2FromMetadata(metadata), publishIntent: async requested => {
      intentWrites++;
      if ('source' in requested) throw new Error('This legacy projection fixture expects a V1 tuple');
      const candidate = createModelIntentMetadataCasCandidate({ selection: requested, nowMs: () => 20 });
      metadata = candidate.update(metadata);
      return { accepted: candidate.readState().accepted, updatedAt: candidate.readState().updatedAt! };
    } });
    try {
      for (let i = 0; i < 3; i++) {
        let dispatched = false;
        const request = harness.coordinator.submit(selection, { source: 'prompt', runWithActiveSelection: async transfer => {
          await transfer({ abortSignal: new AbortController().signal, dispatch: async () => {
            dispatched = true;
            if (i === 1) throw new Error('controlled turn failure');
          } });
        } });
        if (i === 1) await expect(request).rejects.toThrow('controlled turn failure');
        else await expect(request).resolves.toMatchObject({ ok: true });
        expect(dispatched).toBe(true);
        expect(metadata).toBe(retained);
      }
      expect(intentWrites).toBe(0);
      expect(harness.coordinator.readActiveTarget()).toBe(initialTarget);
      if (nativeDelivery) {
        metadata = { ...metadata, modelSelectionIntentV2: { ...metadata.modelSelectionIntentV2,
          ref: { ...metadata.modelSelectionIntentV2.ref, nativeDelivery: { ...nativeDelivery, placeholderRef: 'changed-placeholder' } } } };
        let wrongBindingDispatched = false;
        await expect(harness.coordinator.submit(selection, { source: 'prompt', runWithActiveSelection: async transfer => {
          await transfer({ abortSignal: new AbortController().signal, dispatch: async () => { wrongBindingDispatched = true; } });
        } })).resolves.toMatchObject({ ok: false, status: 'restart_required', reason: 'team_resource_binding_changed' });
        expect(wrongBindingDispatched).toBe(false);
        metadata = retained;
      }
      await expect(harness.coordinator.submit(selection, { source: 'command' }))
        .resolves.toMatchObject({ ok: false, status: 'restart_required' });
      expect(intentWrites).toBe(1);
      expect(metadata).not.toHaveProperty('modelSelectionIntentV2');
      expect(metadata).toMatchObject({ modelSelectionIntentV1: { selection } });
      let reusedTeamAfterNativeSwitch = false;
      await expect(harness.coordinator.submit(selection, { source: 'prompt', runWithActiveSelection: async transfer => {
        await transfer({ abortSignal: new AbortController().signal, dispatch: async () => { reusedTeamAfterNativeSwitch = true; } });
      } })).resolves.toMatchObject({ ok: false, status: 'restart_required' });
      expect(reusedTeamAfterNativeSwitch).toBe(false);
      const replacement = createModelIntentV2MetadataCasCandidate({ selection: { ...retained.modelSelectionIntentV2,
        updatedAt: 30, ref: { ...retained.modelSelectionIntentV2.ref, resourceId: 'resource-2' } }, nowMs: () => 30 });
      metadata = replacement.update(metadata);
      const pendingTeam = metadata;
      const writesBeforePendingTeamPrompt = intentWrites;
      await expect(harness.coordinator.submit(selection, { source: 'prompt', runWithActiveSelection: async transfer => {
        await transfer({ abortSignal: new AbortController().signal, dispatch: async () => { reusedTeamAfterNativeSwitch = true; } });
      } })).resolves.toMatchObject({ ok: false, status: 'restart_required' });
      expect(reusedTeamAfterNativeSwitch).toBe(false);
      expect(metadata).toBe(pendingTeam);
      expect(intentWrites).toBe(writesBeforePendingTeamPrompt);
    } finally { await harness.coordinator.dispose(); }
  });

  it.each(['actual-provider-model', ' model/opaque '])('confirms observed native model identity without inventing proof for an unavailable opened credential source (%s)', async (observedModelId) => {
    let nativeProven = false;
    const initialTarget = { ...authorized(native('default')),
      readAppliedTeamCredentialModel: () => nativeProven ? null : undefined };
    const authorize = createSessionModelTransitionAuthorizer({
      sessionId: 'session-1', machineId: 'machine-1', agentId: 'claude',
      agentTargetKey: initialTarget.selection.agentTargetKey, nativeModelApplyPolicy: 'live',
      readActiveTarget: () => initialTarget,
    });
    const harness = createHarness({ initialTarget, initialActiveTargetConfirmed: false, authorize,
      readRuntimeModelId: () => observedModelId,
      subscribeRuntimeModelChanges: handler => { handler(observedModelId); return () => undefined; } });
    try {
      await vi.waitFor(async () => expect(await harness.coordinator.readAppliedTarget()).toMatchObject({
        status: 'applied', target: { selection: native(observedModelId) },
      }));
      const applied = await harness.coordinator.readAppliedTarget();
      if (applied.status !== 'applied') throw new Error('Observed model must be available');
      expect(applied.target.readAppliedTeamCredentialModel).toBe(initialTarget.readAppliedTeamCredentialModel);
      expect(applied.target.readAppliedTeamCredentialModel?.()).toBeUndefined();
      nativeProven = true;
      expect(applied.target.readAppliedTeamCredentialModel?.()).toBeNull();
      expect(harness.applyRuntime).not.toHaveBeenCalled();
    } finally { await harness.coordinator.dispose(); }
  });
  it('keeps an unavailable opened credential source distinct from native auth and consumes later native proof', async () => {
    let nativeProven = false;
    const initialTarget = { ...authorized(native('old')), readAppliedTeamCredentialModel: () => nativeProven ? null : undefined };
    const authorize = createSessionModelTransitionAuthorizer({
      sessionId: 'session-1', machineId: 'machine-1', agentId: 'claude',
      agentTargetKey: initialTarget.selection.agentTargetKey, nativeModelApplyPolicy: 'live',
      readActiveTarget: () => initialTarget,
    });
    const harness = createHarness({ initialTarget, authorize });
    await expect(harness.coordinator.submit(native('old'), { source: 'command' }))
      .resolves.toMatchObject({ ok: false, status: 'restart_required' });
    expect(harness.applyRuntime).not.toHaveBeenCalled();
    nativeProven = true;
    await expect(harness.coordinator.submit(native('next'), { source: 'command' }))
      .resolves.toMatchObject({ ok: true, status: 'applied' });
    await harness.coordinator.dispose();
  });
  it.each(['old', 'next'])('requires restart from Team custody to native model %s, even for the same model id', async modelId => {
    const initialTarget = { ...authorized(native('old')), readAppliedTeamCredentialModel: () => ({
      kind: 'team_credential_provider_model' as const, teamId: 'team-1', resourceId: 'resource-1',
      expectedResourceRevision: 7, deliveryMode: 'brokered' as const,
      agentTargetKey: native('old').agentTargetKey, modelId: 'old',
    }) };
    const authorize = createSessionModelTransitionAuthorizer({
      sessionId: 'session-1', machineId: 'machine-1', agentId: 'claude',
      agentTargetKey: initialTarget.selection.agentTargetKey, nativeModelApplyPolicy: 'live',
      readActiveTarget: () => initialTarget,
    });
    const harness = createHarness({ initialTarget, authorize });
    await expect(harness.coordinator.submit(native(modelId), { source: 'command' }))
      .resolves.toMatchObject({ ok: false, status: 'restart_required' });
    expect(harness.applyRuntime).not.toHaveBeenCalled();
    expect(harness.coordinator.readActiveTarget()).toEqual(initialTarget);
    await harness.coordinator.dispose();
  });
  it('dispatches an unconfirmed native startup selector without inferring alias equivalence or restoring it over actual readback', async () => {
    const harness = createHarness({ initial: native('default'), initialActiveTargetConfirmed: false,
      readRuntimeModelId: () => 'actual-provider-model',
      subscribeRuntimeModelChanges: handler => { handler('actual-provider-model'); return () => undefined; } });
    const dispatch = vi.fn(async () => undefined);
    const result = await harness.coordinator.submit(native('default'), { source: 'prompt', runWithActiveSelection: async transfer => {
      await transfer({ abortSignal: new AbortController().signal, dispatch });
    } });
    expect(result.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(harness.applyRuntime).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect(await harness.coordinator.readAppliedTarget()).toMatchObject({ status: 'applied',
      target: { selection: native('actual-provider-model') } }));
    const before = await harness.coordinator.readAppliedTarget();
    const after = await harness.coordinator.readAppliedTarget();
    if (before.status !== 'applied' || after.status !== 'applied') throw new Error('Actual model is unavailable');
    expect(after.target).toBe(before.target);
    expect(harness.coordinator.readActiveTarget().selection).toEqual(native('default'));
    expect(harness.publishActive).toHaveBeenLastCalledWith(expect.objectContaining({ selection: native('actual-provider-model') }), 'runtime_readback');
    await harness.coordinator.dispose();
  });
  it('dispatches accepted next-prompt configuration without verifying Running until actual readback', async () => {
    let runtimeModelId = 'old';
    let observe!: (modelId?: string | null) => void;
    const harness = createHarness({
      initial: native('old'),
      readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: handler => { observe = handler; return () => undefined; },
    });
    harness.applyRuntime.mockImplementation(async () =>
      mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult({ status: 'applied', timing: 'before_next_prompt' }));
    const next = native('next');
    const configured = await harness.coordinator.submit(next, { source: 'command' });
    expect(configured).toMatchObject({ ok: true, status: 'armed', requestedSelection: next });
    await vi.waitFor(async () => expect(await harness.coordinator.readAppliedTarget()).toMatchObject({ status: 'applied',
      target: { selection: native('old') } }));
    expect(harness.publishActive.mock.calls.some(([target, evidence]) => target.selection.modelId === 'next' && evidence !== null)).toBe(false);
    observe('old');
    await harness.coordinator.submit(next, { source: 'prompt', runWithActiveSelection: async transfer => {
      await transfer({ abortSignal: new AbortController().signal, dispatch: async () => {
        harness.events.push('send');
      } });
    } });
    expect(harness.events).toContain('send');
    expect(harness.applyRuntime).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.readActiveTarget().selection).toEqual(next);
    runtimeModelId = 'next';
    observe('next');
    await vi.waitFor(async () => expect(await harness.coordinator.readAppliedTarget()).toMatchObject({ status: 'applied', target: { selection: next } }));
    expect(harness.publishActive).toHaveBeenLastCalledWith(expect.objectContaining({ selection: next }), 'runtime_readback');
    await harness.coordinator.dispose();
  });
  it('keeps a configured route usable after prompt dispatch fails and never publishes proof from the retry', async () => {
    const harness = createHarness({ initial: native('old'), readRuntimeModelId: () => 'old' });
    harness.applyRuntime.mockImplementation(async () =>
      mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult({ status: 'applied', timing: 'before_next_prompt' }));
    const next = native('next');
    await expect(harness.coordinator.submit(next, { source: 'prompt', runWithActiveSelection: async transfer => {
      await transfer({ abortSignal: new AbortController().signal, dispatch: async () => { throw new Error('provider unavailable'); } });
    } })).rejects.toThrow('provider unavailable');
    const dispatch = vi.fn(async () => undefined);
    await harness.coordinator.submit(next, { source: 'prompt', runWithActiveSelection: async transfer => {
      await transfer({ abortSignal: new AbortController().signal, dispatch });
    } });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(harness.applyRuntime).toHaveBeenCalledOnce();
    await vi.waitFor(async () => expect(await harness.coordinator.readAppliedTarget()).toMatchObject({ status: 'applied',
      target: { selection: native('old') } }));
    expect(harness.publishActive.mock.calls.some(([target, evidence]) => target.selection.modelId === 'next' && evidence !== null)).toBe(false);
    await harness.coordinator.unarm();
    expect(harness.coordinator.readActiveTarget().selection).toEqual(native('old'));
    await harness.coordinator.dispose();
  });

  it('checks current publisher custody after Provider authorization finishes', async () => {
    const validationStarted = deferred<void>();
    const validation = deferred<boolean>();
    let publisherCurrent = true;
    const harness = createHarness({ initialTarget: { ...authorized(provider('pc_work', 'old')),
      revalidateBeforeEffect: async () => { validationStarted.resolve(); return validation.promise; } },
      checkCurrentPublisherAuthority: async () => publisherCurrent });
    const applied = harness.coordinator.readAppliedTarget();
    await validationStarted.promise;
    publisherCurrent = false;
    validation.resolve(true);
    expect(await applied).toMatchObject({ status: 'unavailable', reason: 'publisher_authority_unavailable' });
    await harness.coordinator.dispose();
  });

  it('retains same-source actual proof while pending, and invalidates unknown or revoked runtime evidence', async () => {
    let runtimeModelId: string | null = 'old';
    let observe!: (modelId?: string | null) => void;
    let authorizationCurrent = true;
    const initial = provider('pc_work', 'old');
    const target = (selection: ProviderBoundModelRef): AuthorizedSessionModelTransitionTarget => ({
      ...authorized(selection), revalidateBeforeEffect: async () => authorizationCurrent,
    });
    const harness = createHarness({ initialTarget: target(initial), ownerScope: modelMutationScope,
      authorize: async selection => target(selection), readRuntimeModelId: () => runtimeModelId,
      subscribeRuntimeModelChanges: handler => { observe = handler; return () => undefined; } });
    harness.applyRuntime.mockResolvedValue({ status: 'deferred' });
    await harness.coordinator.submit(provider('pc_work', 'next'), { source: 'command' });
    await vi.waitFor(async () => expect(await harness.coordinator.readAppliedTarget()).toMatchObject({ status: 'applied', target: { selection: initial } }));
    const before = await harness.coordinator.readAppliedTarget();
    observe('old');
    await vi.waitFor(async () => expect((await harness.coordinator.runWithStableActiveTarget(async () => undefined)).status).toBe('completed'));
    const after = await harness.coordinator.readAppliedTarget();
    if (before.status !== 'applied' || after.status !== 'applied') throw new Error('Actual model is unavailable');
    expect(after.target).toBe(before.target);
    runtimeModelId = null;
    observe(null);
    expect(await harness.coordinator.readAppliedTarget()).toMatchObject({ status: 'unavailable' });
    expect(await harness.coordinator.submit(provider('pc_work', 'next'), { source: 'command', captureBefore: true }))
      .toMatchObject({ ok: false, status: 'unsupported', reason: 'exact_model_mutation_requires_confirmed_runtime' });
    runtimeModelId = 'old';
    observe('old');
    await vi.waitFor(async () => expect(await harness.coordinator.readAppliedTarget()).toMatchObject({ status: 'applied' }));
    authorizationCurrent = false;
    expect(await harness.coordinator.readAppliedTarget()).toMatchObject({ status: 'unavailable' });
    await harness.coordinator.dispose();
  });

  it('does not use a model-id-only observation to confirm deferred cross-provider materialization', async () => {
    let observe!: (modelId?: string | null) => void;
    const initial = provider('pc_old', 'shared-model');
    const next = provider('pc_new', 'shared-model');
    const harness = createHarness({ initial, ownerScope: modelMutationScope, readRuntimeModelId: () => 'shared-model',
      subscribeRuntimeModelChanges: handler => { observe = handler; return () => undefined; } });
    harness.applyRuntime.mockImplementation(async () =>
      mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult({ status: 'applied', timing: 'before_next_prompt' }));
    await harness.coordinator.submit(next, { source: 'command' });
    observe('shared-model');
    await vi.waitFor(async () => expect((await harness.coordinator.runWithStableActiveTarget(async () => undefined)).status).toBe('completed'));
    expect(harness.publishActive).toHaveBeenCalledOnce();
    expect(harness.publishActive).toHaveBeenLastCalledWith(expect.objectContaining({ selection: next }), null);
    expect(await harness.coordinator.readAppliedTarget()).toMatchObject({ status: 'unavailable' });
    expect(await harness.coordinator.submit(next, { source: 'command', captureBefore: true }))
      .toMatchObject({ ok: false, status: 'unsupported', reason: 'exact_model_mutation_requires_confirmed_runtime' });
    await harness.coordinator.dispose();
  });
  it('keeps the actual old model and failure when next-prompt configuration publication fails', async () => {
    const harness = createHarness({ initial: native('old'), readRuntimeModelId: () => 'old' });
    harness.applyRuntime.mockImplementation(async () =>
      mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult({ status: 'applied', timing: 'before_next_prompt' }));
    harness.publishActive.mockRejectedValueOnce(new Error('publication failed'));
    expect(await harness.coordinator.submit(native('next'), { source: 'command' })).toMatchObject({
      ok: false, status: 'reconciliation_required', activeSelection: native('old'), reason: 'publication failed',
    });
    expect(harness.applyRuntime.mock.calls.map(([target]) => target.selection.modelId)).toEqual(['next']);
    expect(harness.unfence).not.toHaveBeenCalled();
    expect(await harness.coordinator.readAppliedTarget()).toMatchObject({ status: 'unavailable' });
    await harness.coordinator.dispose();
  });


  function createNativeHarness() {
    const authorizer = createSessionModelTransitionAuthorizer({
      agentId: 'claude', agentTargetKey: native('old').agentTargetKey,
      sessionId: 'session-1', machineId: 'machine-1', nativeModelApplyPolicy: 'live',
      readActiveTarget: (): AuthorizedSessionModelTransitionTarget => harness.coordinator.readActiveTarget(),
    });
    const harness = createHarness({ initial: native('old'), authorize: authorizer });
    return harness;
  }
  it.each([[true, 'old'], [false, 'old'], [true, 'resolved-old'], [false, 'resolved-old']] as const)('publishes no active model facts for turns that keep the same model (startup confirmed: %s, runtime reports %s)', async (initialActiveTargetConfirmed, reported) => {
    let observe!: (modelId?: string | null) => void;
    const harness = createHarness({ initial: native('old'), initialActiveTargetConfirmed, readRuntimeModelId: () => reported,
      subscribeRuntimeModelChanges: handler => { observe = handler; return () => undefined; } });
    const settle = async () => { for (let tick = 0; tick < 20; tick++) await new Promise(resolve => setTimeout(resolve, 0)); };
    // One turn: the prompt carries the Session's model, and the provider reports its model again.
    const turn = async () => {
      await harness.coordinator.submit(native('old'), { source: 'prompt', runWithActiveSelection: async transfer => {
        await transfer({ abortSignal: new AbortController().signal, dispatch: async () => undefined });
      } });
      observe(reported);
      await settle();
    };
    try {
      await turn();
      const actives = harness.publishActive.mock.calls.length;
      await turn();
      await turn();
      expect({ actives: harness.publishActive.mock.calls.length - actives, applies: harness.applyRuntime.mock.calls.length })
        .toEqual({ actives: 0, applies: 0 });
    } finally { await harness.coordinator.dispose(); }
  });

  it('still publishes a readback whose runtime model changed after an unchanged one', async () => {
    let observe!: (modelId?: string | null) => void;
    let reported = 'resolved-old';
    const harness = createHarness({ initial: native('old'), initialActiveTargetConfirmed: false, readRuntimeModelId: () => reported,
      subscribeRuntimeModelChanges: handler => { observe = handler; return () => undefined; } });
    const settle = async () => { for (let tick = 0; tick < 20; tick++) await new Promise(resolve => setTimeout(resolve, 0)); };
    try {
      observe(reported);
      await settle();
      observe(reported);
      await settle();
      const actives = harness.publishActive.mock.calls.length;
      reported = 'resolved-new';
      observe(reported);
      await settle();
      expect(harness.publishActive.mock.calls.slice(actives).map(([target, evidence]) => [target.selection.modelId, evidence]))
        .toEqual([['resolved-new', 'runtime_readback']]);
    } finally { await harness.coordinator.dispose(); }
  });

  it('arms a live model at the owner, ignores its metadata echo, and applies only at prompt custody', async () => {
    const harness = createNativeHarness();
    const next = native('next');
    const armed = await harness.coordinator.submit(next, { source: 'command', applyTiming: 'next_prompt' });
    expect(armed).toMatchObject({ ok: true, status: 'armed', activeSelection: native('old'), requestedSelection: next });
    expect(harness.coordinator.readArmedSelection()).toEqual(next);
    expect(harness.readCurrent()).toEqual(native('old'));
    await vi.waitFor(async () => expect((await harness.coordinator.runWithStableActiveTarget(async () => undefined)).status).toBe('completed'));
    await harness.coordinator.submit(next, { source: 'metadata' });
    expect(harness.readCurrent()).toEqual(native('old'));
    await harness.coordinator.submit(next, { source: 'prompt', runWithActiveSelection: async transfer => {
      await transfer({ abortSignal: new AbortController().signal, dispatch: async () => { harness.events.push('send'); } });
    } });
    expect(harness.readCurrent()).toEqual(next);
    expect(harness.coordinator.readArmedSelection()).toBeNull();
    expect(harness.events.indexOf('apply:next')).toBeLessThan(harness.events.indexOf('send'));
    await harness.coordinator.dispose();
  });
  it('un-arms a deferred live model without applying it or sending', async () => {
    const harness = createNativeHarness();
    await harness.coordinator.submit(native('next'), { source: 'command', applyTiming: 'next_prompt' });
    expect(await harness.coordinator.unarm()).toMatchObject({ ok: true, status: 'already_active' });
    expect(harness.coordinator.readArmedSelection()).toBeNull();
    expect(harness.readCurrent()).toEqual(native('old'));
    expect(harness.events).not.toContain('apply:next');
    expect(harness.events).not.toContain('send');
    await harness.coordinator.dispose();
  });
  it('keeps a failed immediate command armed so a metadata echo cannot retry it', async () => {
    const harness = createNativeHarness();
    const next = native('next');
    await harness.coordinator.submit(next, { source: 'command', applyTiming: 'next_prompt' });
    harness.applyRuntime.mockResolvedValueOnce({ status: 'failed', reason: 'provider_unavailable' });
    expect(await harness.coordinator.submit(next, { source: 'command', applyTiming: 'immediate' })).toMatchObject({ ok: false, status: 'apply_failed' });
    await vi.waitFor(async () => expect((await harness.coordinator.runWithStableActiveTarget(async () => undefined)).status).toBe('completed'));
    expect(await harness.coordinator.submit(next, { source: 'metadata' })).toMatchObject({ ok: true, status: 'armed' });
    expect(harness.readCurrent()).toEqual(native('old'));
    await harness.coordinator.dispose();
  });
  it('consumes a refused armed model so the next prompt can use the active target', async () => {
    const harness = createNativeHarness();
    const next = native('next');
    await harness.coordinator.submit(next, { source: 'command', applyTiming: 'next_prompt' });
    harness.applyRuntime.mockResolvedValueOnce({ status: 'failed', reason: 'acp_model_not_available' });
    expect(await harness.coordinator.submit(next, { source: 'prompt', runWithActiveSelection: async transfer => {
      await transfer({ abortSignal: new AbortController().signal, dispatch: async () => { harness.events.push('refused-send'); } });
    } })).toMatchObject({ ok: false, status: 'apply_failed' });
    await vi.waitFor(async () => expect((await harness.coordinator.runWithStableActiveTarget(async () => { harness.events.push('later-send'); })).status).toBe('completed'));
    expect(harness.coordinator.readArmedSelection()).toBeNull();
    expect(harness.readCurrent()).toEqual(native('old'));
    expect(harness.publishIntent).toHaveBeenLastCalledWith(native('old'), {
      selection: next, updatedAt: expect.any(Number),
    });
    expect(harness.events).not.toContain('refused-send');
    expect(harness.events).toContain('later-send');
    await harness.coordinator.dispose();
  });
  it.each(['superseded', 'unavailable'] as const)('settles a refused prompt when intent restoration is %s', async scenario => {
    const harness = createNativeHarness();
    const next = native('next');
    await harness.coordinator.submit(next, { source: 'command', applyTiming: 'next_prompt' });
    // The durable intent publisher is the Home transport boundary.
    harness.publishIntent.mockResolvedValueOnce({ accepted: true, updatedAt: 7 });
    if (scenario === 'superseded') harness.publishIntent.mockResolvedValueOnce({ accepted: false, updatedAt: 8 });
    else harness.publishIntent.mockRejectedValueOnce(new Error('Home unavailable'));
    harness.applyRuntime.mockResolvedValueOnce({ status: 'failed', reason: 'acp_model_not_available' });
    const result = await harness.coordinator.submit(next, { source: 'prompt', runWithActiveSelection: async transfer => {
      await transfer({ abortSignal: new AbortController().signal, dispatch: async () => { harness.events.push('refused-send'); } });
    } });
    expect(result).toMatchObject({ ok: false, status: 'apply_failed',
      reason: scenario === 'superseded' ? 'acp_model_not_available' : 'intent_publication_failed' });
    expect(harness.coordinator.readArmedSelection()).toEqual(next);
    await vi.waitFor(async () => expect((await harness.coordinator.runWithStableActiveTarget(async () => undefined)).status).toBe('completed'));
    expect(harness.publishIntent).toHaveBeenLastCalledWith(native('old'), { selection: next, updatedAt: 7 });
    expect(harness.events).not.toContain('refused-send');
    await harness.coordinator.dispose();
  });
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
      initialActiveTargetConfirmed: true,
      readModelSelectionIntent: () => null,
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
      expect(await coordinator.readAppliedTarget()).toEqual({ status: 'unavailable', reason: 'prompt_admission_fenced' });
      applicationRelease.resolve();
      await expect(transition).resolves.toMatchObject({ ok: true, activeSelection: native('Y') });
      expect(await coordinator.readAppliedTarget()).toMatchObject({ status: 'applied', target: { selection: native('Y') } });
      current = false;
      expect(await coordinator.readAppliedTarget()).toEqual({ status: 'unavailable', reason: 'run_not_current' });
    } finally {
      publicationRelease.resolve(); applicationRelease.resolve(); await coordinator.dispose();
    }
  });
  it('captures and restores configured default intent after actual runtime proof resolves the startup selector', async () => {
    let intent = { modelSelectionIntentV1: { v: 1 as const, updatedAt: 1, selection: native('default') } };
    let order = 10;
    const authorizer = createSessionModelTransitionAuthorizer({ sessionId: 'session-1', machineId: 'machine-1',
      agentId: 'claude', agentTargetKey: native('default').agentTargetKey, nativeModelApplyPolicy: 'live',
      readActiveTarget: () => harness.coordinator.readActiveTarget() });
    const harness = createHarness({ initial: native('default'), initialActiveTargetConfirmed: false,
      authorize: authorizer, ownerScope: modelMutationScope, readRuntimeModelId: () => 'actual-model',
      subscribeRuntimeModelChanges: handler => { handler('actual-model'); return () => undefined; },
      publishIntent: async (selection, expected, requiredBefore) => {
        if ('source' in selection) throw new Error('This V1 reversal fixture expects a V1 tuple');
        const candidate = createModelIntentMetadataCasCandidate({ selection, nowMs: () => ++order, ownerScope: modelMutationScope,
          ...(requiredBefore ? { captureBefore: true, requiredBefore } : {}),
          ...(expected ? { expected: { owner: 'inactive', scope: modelMutationScope, ...expected } } : {}) });
        intent = candidate.update(intent);
        const state = candidate.readState();
        return { accepted: state.accepted, updatedAt: state.updatedAt ?? 0 };
      } });
    await vi.waitFor(async () => expect(await harness.coordinator.readAppliedTarget()).toMatchObject({ status: 'applied',
      target: { selection: native('actual-model') } }));
    const changed = await harness.coordinator.submit(native('new'), { source: 'command', captureBefore: true });
    expect(changed).toMatchObject({ ok: true, reversal: { before: native('default'), applied: native('new'), updatedAt: 11 } });
    expect(await harness.coordinator.submit(native('default'), { source: 'command',
      expected: { owner: 'active', scope: modelMutationScope, runId: 'run-1', selection: native('new'), updatedAt: 11 } }))
      .toMatchObject({ ok: true });
    expect(intent.modelSelectionIntentV1.selection).toEqual(native('default'));
    await harness.coordinator.dispose();
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
        if ('source' in selection) throw new Error('This V1 reversal fixture expects a V1 tuple');
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
      failureCause: { phase: 'turn_start', failureReason: 'unclassified_provider_error' },
    });
    expect(
      mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult({
        status: 'applied',
      }),
    ).toEqual({ status: 'applied' });
    for (const timing of ['before_next_prompt', 'scheduled_for_next_prompt', 'queued_until_safe_window', 'next_idle'] as const) {
      expect(mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult({ status: 'applied', timing }))
        .toEqual({ status: 'deferred' });
    }
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
      failureCause: { phase: 'turn_start', failureReason: 'unclassified_provider_error' },
    });
    expect(
      mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult({
        status: 'failed',
      }),
    ).toEqual({
      status: 'failed',
      reason: 'runtime_model_transition_not_applied',
      failureCause: { phase: 'turn_start', failureReason: 'unclassified_provider_error' },
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

    expect(harness.publishActive).toHaveBeenCalledWith(successor, null);
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

  it.each([
    { initial: provider('pc_work', 'old'), next: provider('pc_work', 'next') },
    { initial: native(' old/opaque '), next: native(' next/opaque ') },
  ])('keeps the actual runtime model on publication failure without silently reverting ($initial.modelId)', async ({ initial, next }) => {
    const harness = createHarness({ initial, authoritativeRuntimeReadback: true });
    harness.publishActive.mockRejectedValueOnce(new Error('metadata unavailable'));

    await expect(
      harness.coordinator.submit(next, { source: 'command' }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: next,
      reason: 'metadata unavailable',
    });

    expect(harness.applyRuntime.mock.calls.map(([target]) => target.selection.modelId))
      .toEqual([next.modelId]);
    expect(harness.readCurrent()).toEqual(next);
    expect(harness.coordinator.readActiveTarget().selection).toEqual(next);
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

  it('keeps input and later transitions fenced without changing the actual model when publication fails', async () => {
    const harness = createHarness();
    harness.publishActive.mockRejectedValueOnce(new Error('metadata unavailable'));

    await expect(
      harness.coordinator.submit(provider('pc_work', 'next'), { source: 'command' }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: provider('pc_work', 'next'),
    });
    await expect(
      harness.coordinator.submit(provider('pc_work', 'later'), { source: 'command' }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: provider('pc_work', 'next'),
    });

    expect(harness.unfence).not.toHaveBeenCalled();
    expect(harness.applyRuntime).toHaveBeenCalledTimes(1);
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

  it.each([
    { initial: provider('pc_work', 'old'), next: provider('pc_work', 'next') },
    { initial: native('old'), next: native(' model/opaque ') },
  ])('publishes and unfences only after exact live-runtime model readback proves an unproven apply ($next.modelId)', async ({ initial, next }) => {
    const harness = createHarness({
      initial,
      readRuntimeModelId: () => next.modelId,
    });
    harness.applyRuntime.mockResolvedValueOnce({
      status: 'unproven',
      reason: 'runtime_model_transition_outcome_unproven',
      readbackAfterCompletion: true,
    });

    await expect(
      harness.coordinator.submit(
        next,
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: 'applied',
      activeSelection: next,
    });

    expect(harness.publishActive.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual([next.modelId]);
    expect(harness.unfence).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.readActiveTarget().selection)
      .toEqual(next);
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

  it('keeps runtime-origin drift visible and fenced without silently restoring the previous model', async () => {
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
      expect(harness.revokeActiveSelectionProof).toHaveBeenCalledWith(provider('pc_work', 'old'));
    });
    expect(runtimeModelId).toBe('runtime-observed');
    expect(harness.publishActive).not.toHaveBeenCalled();
    expect(harness.unfence).not.toHaveBeenCalled();

    await expect(
      harness.coordinator.submit(
        provider('pc_work', 'old'),
        { source: 'command' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
    });
    expect(harness.applyRuntime).not.toHaveBeenCalled();
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

    await vi.waitFor(() => expect(harness.revokeActiveSelectionProof).toHaveBeenCalled());
    expect(runtimeModelId).toBe('unexpected-runtime-model');
    expect(harness.publishActive).not.toHaveBeenCalled();
    expect(harness.unfence).not.toHaveBeenCalled();
    expect(harness.applyRuntime).toHaveBeenCalledTimes(1);
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
      expect(harness.unfence).toHaveBeenCalledTimes(1);
    });
    expect(runtimeModelId).toBe('unexpected-runtime-model');
    expect(harness.applyRuntime).toHaveBeenCalledTimes(1);
  });

  it('never retries a model switch from repeated runtime drift observations', async () => {
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
      expect(harness.revokeActiveSelectionProof).toHaveBeenCalled();
    });
    notifyRuntimeModelChange('unexpected-runtime-model');
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.applyRuntime).not.toHaveBeenCalled();

    expect(harness.revokeActiveSelectionProof).toHaveBeenCalled();
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

  it('keeps the real model and failure when authorization changes after apply but before active publication', async () => {
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
      status: 'reconciliation_required',
      activeSelection: provider('pc_work', 'next'),
      reason: 'provider_authorization_changed_before_publication',
    });

    expect(revalidateBeforeEffect).toHaveBeenCalledTimes(2);
    expect(harness.applyRuntime.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['next']);
    expect(harness.publishActive).not.toHaveBeenCalled();
    expect(harness.unfence).not.toHaveBeenCalled();
    expect(harness.coordinator.readActiveTarget().selection)
      .toEqual(provider('pc_work', 'next'));
  });

  it('keeps the real model and failure when authorization changes during active publication', async () => {
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
      status: 'reconciliation_required',
      activeSelection: provider('pc_work', 'next'),
      reason: 'provider_authorization_changed_during_publication',
    });
    expect(revalidateBeforeEffect).toHaveBeenCalledTimes(3);
    expect(harness.applyRuntime.mock.calls.map(
      ([target]) => target.selection.modelId,
    )).toEqual(['next']);
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
    harness.publishActive.mockRejectedValueOnce(new Error('target publication failed'));

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
      // The same admitted selection needs restart only because its binding changed.
      reason: 'provider_binding_changed',
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

  it('un-arms a pending route through the same intent owner without applying a runtime change', async () => {
    const active = native('old');
    const initialTarget = authorized(active);
    let readActiveTarget = () => initialTarget;
    const authorize = createSessionModelTransitionAuthorizer({ sessionId: 'session', machineId: 'machine',
      agentId: 'claude', agentTargetKey: active.agentTargetKey, nativeModelApplyPolicy: 'live',
      readActiveTarget: () => readActiveTarget() });
    const harness = createHarness({ initialTarget, authorize });
    readActiveTarget = () => harness.coordinator.readActiveTarget();
    await expect(harness.coordinator.submit(provider('pc_other', 'new'), { source: 'command' }))
      .resolves.toMatchObject({ status: 'restart_required' });
    await expect(harness.coordinator.unarm()).resolves.toMatchObject({ ok: true, status: 'already_active', activeSelection: active });
    expect(harness.publishIntent.mock.calls.at(-1)?.[0]).toEqual(active);
    expect(harness.applyRuntime).not.toHaveBeenCalled();
    await harness.coordinator.dispose();
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
