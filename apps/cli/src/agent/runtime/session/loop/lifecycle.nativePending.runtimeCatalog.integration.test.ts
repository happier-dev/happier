import axios from 'axios';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventV1Schema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';

import { ApiSessionClient } from '@/api/session/sessionClient';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/lifecycle/runnerTerminationHandlers';
import { createMockSession, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { bindSessionProviderInputOutcome, createSessionProviderInputOutcomeBinding } from '@/agent/runtime/session/input/providerInputOutcome';
import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { installEmptyProjectAccountRowsHttpBoundary } from '@/testkit/http/projectAccountRows';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { createLifecycleParams, createMetadata } from './lifecycle.testkit';
import { runSessionLoopLifecycle } from './lifecycle';
import { createInitialHostRuntimeActivityMutation } from '@/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import { createSessionProviderInputConsumerSessionAdapter } from '@/agent/runtime/waitForNextPermissionModeMessage';
import { createSessionModelTransitionCoordinator, type AuthorizedSessionModelTransitionTarget } from '@/providers/sessions/sessionModelTransitionCoordinator';
import { createSessionModelTransitionAuthorizer } from '@/providers/sessions/authorizeSessionModelTransitionTarget';
import { createClaudeStatuslineApplier } from '../../../../../../../packages/plugins/claude/src/agent/statusline/apply';
import { selectPendingProviderInvocation } from '../../../../../../../apps/server/sources/app/session/pending/selectPendingProviderInvocation';
import { registerPermissionModeMessageQueueBinding } from '@/agent/runtime/permissions/bindModeQueue';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['presentation', 'runtime', 'model-readback', 'send-now'] as const)('drains real Pending after a native turn started during %s', async startPhase => {
  const restoreHttp = installEmptyProjectAccountRowsHttpBoundary();
  const registry = await pluginReloadController.acquireRuntimeRegistry({
    resolveRuntimeRegistry: async () => resolveExecutablePluginRuntimeRegistry({ contributes: getResolvedContributionRegistry(), pluginIds: [] }),
  });
  const sessionId = 'native-pending-session';
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'pending-delivery-account' })).toString('base64url')}.signature`;
  const fields = buildSessionMetadataEnvelopeFields({ credentials: { token, encryption: null },
    accountEncryptionMode: 'plain', metadata: createMetadata(), agentState: null, storedContentMode: 'plain' });
  const text = 'First line\nSECOND-LINE';
  let pending = true;
  let materializations = 0;
  let nativeTurnActive = false;
  let interruptions = 0;
  let abortRequested: (() => void | Promise<void>) | null = null;
  const requestedAction = { v: 1, kind: startPhase === 'send-now' ? 'send_now' : 'enqueue' } as const;
  const receipts: unknown[] = [];
  const activity = createSessionRuntimeActivityHomeStub({ machineId: 'machine-1' });
  // Home and the external Agent are the boundaries; Pending custody, queue,
  // native event admission, lifecycle and prompt dispatch stay real.
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck(event, payload) {
    if (event === 'pending-delivery-accepted-v1') {
      receipts.push(payload);
      return { ok: true, didResolve: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2,
        message: { id: 'committed-input', seq: 1, localId: 'pending-input', messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text } } }, createdAt: 1, updatedAt: 2 } };
    }
    if (event === 'pending-materialize-next') {
      if (!pending) return { ok: true, didMaterialize: false, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 };
      const selected = selectPendingProviderInvocation({
        rows: [{ localId: 'pending-input', position: 1, requestedAction }],
        foregroundState: nativeTurnActive ? 'active_unsteerable' : 'ready',
        deliveryTiming: 'after_foreground_ready', readRuntimeActivity: () => 'idle',
      });
      if ('deferredReason' in selected) return { ok: true, didMaterialize: false,
        pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1, deferredReason: selected.deferredReason };
      materializations += 1;
      pending = false;
      return { ok: true, didMaterialize: true, didWrite: false, localId: 'pending-input',
        pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1,
        message: { id: null, seq: null, localId: 'pending-input', providerAction: selected.providerAction, messageRole: 'user',
          requestedAction,
          inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text } } },
          createdAt: 1, updatedAt: 1, deliveryState: { mode: 'provider', unresolved: true } } };
    }
    return activity.answer(event, payload) ?? resolveApiSessionSocketDefaultAck(event, payload);
  } });
  const features = FeaturesResponseSchema.parse({ features: { sharing: { pendingQueueV2: { enabled: true } } },
    capabilities: { session: { runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 3 }, publisherAuthority: { protocolVersion: 1 } } } });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(features)));
  const priorGet = axios.get;
  vi.spyOn(axios, 'get').mockImplementation(async (url, ...args) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === `/v2/sessions/${sessionId}`) return { status: 200, data: {
      session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, agentState: fields.agentState,
        share: null, pendingCount: pending ? 1 : 0, pendingBlockedCount: 0, pendingVersion: pending ? 1 : 2 }),
    } };
    if (pathname === `/v1/sessions/${sessionId}/messages`) return { status: 200, data: { messages: [] } };
    return await priorGet(url, ...args);
  });
  const session = new ApiSessionClient(token, createMockSession({ id: sessionId, encryptionMode: 'plain',
    metadata: createMetadata(), pendingCount: 1, pendingVersion: 1 }), {
    metadataAuthority: { kind: 'shared_editor' }, localMachineId: 'machine-1', durableMutationDeliveryInitiallyActive: false,
    initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({ sessionId,
      agentRuntimeApplicability: 'supported' })],
    transport: { serverId: 'pending-home', serverUrl: 'https://pending.example.test',
      createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
  });
  await vi.waitFor(() => expect(socket.getHandler('session')).toBeTypeOf('function'));
  await session.claimCurrentSessionPublisherAuthorityForStartup();
  await session.activateDurableMutationDelivery();
  const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
    mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
  let beforePendingMaterialize: (() => boolean | Promise<boolean>) | null | undefined;
  const consumer = createSessionProviderInputConsumer({ messageQueue: queue,
    session: createSessionProviderInputConsumerSessionAdapter(session),
    beforePendingMaterialize: () => beforePendingMaterialize?.() ?? false,
    reconcileWhenEmpty: 'skip', refreshBeforeQueuedBatch: false });
  const selection = { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-haiku-4-5' } as const;
  const target: AuthorizedSessionModelTransitionTarget = { selection, policy: 'live', providerBinding: null,
    sessionBindingMetadata: null, runtimeBindingBasis: null, revalidateBeforeEffect: async () => true };
  const authorize = createSessionModelTransitionAuthorizer({ sessionId, machineId: 'machine-1', agentId: 'claude',
    agentTargetKey: selection.agentTargetKey, nativeModelApplyPolicy: 'live', readActiveTarget: () => target });
  let currentModelId: string | null = null;
  const modelListeners = new Set<(modelId?: string | null) => void>();
  const modelEvidence = createClaudeStatuslineApplier({ logger: { debug() {}, warn() {} },
    readIdentity: () => ({ providerSessionId: null, transcriptPath: null }),
    onEffectiveModel: evidence => { currentModelId = evidence.modelId; for (const listener of modelListeners) listener(currentModelId); } });
  const admission = (epochId: string) => ({ kind: 'action_required', reason: 'generation_pending',
    serviceId: 'host-runtime', groupId: 'model-transition', epochId } as const);
  const startupProof = { initialActiveTargetConfirmed: true, readModelSelectionIntent: () => null };
  const coordinator = createSessionModelTransitionCoordinator({ runId: 'native-pending', agentTargetKey: selection.agentTargetKey,
    ...startupProof,
    initialActiveTarget: authorize.bindCurrentAuthorizationProof(target),
    isCurrentRun: () => true,
    checkCurrentPublisherAuthority: () => session.checkCurrentPublisherAuthority(), authorize,
    // These projection writes are outside this fixture's admission/drain contract.
    publishIntent: async () => ({ accepted: true, updatedAt: 1 }), publishActive: async () => {},
    revokeActiveSelectionProof: async () => {}, applyRuntime: async () => { throw Error('No model change requested'); },
    fencePromptAdmission: async epochId => { await consumer.enforceProviderInputAdmission(admission(epochId)); },
    clearPromptAdmission: async epochId => { await consumer.clearProviderInputAdmission(admission(epochId)); },
    transferPromptAdmission: (epochId, opts) => consumer.runProviderInputDispatchFromAdmission({ admission: admission(epochId), ...opts }),
    readRuntimeModelId: () => currentModelId,
    subscribeRuntimeModelChanges: listener => { modelListeners.add(listener); return () => { modelListeners.delete(listener); }; } });
  let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
  let sequence = 0;
  const emit = (event: Readonly<Record<string, unknown>>) => {
    if (event.kind === 'turn-start') nativeTurnActive = true;
    if (event.kind === 'turn-complete' || event.kind === 'turn-cancelled') nativeTurnActive = false;
    listener?.(AgentSessionRuntimeEventV1Schema.parse({ sessionId, sequence: ++sequence, emittedAtMs: Date.now(), ...event }));
  };
  const delivered: string[] = [];
  const provider: AgentSessionRuntime = {
    async send(request) {
      delivered.push(request.input.text);
      emit({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
      emit({ kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' });
      emit({ kind: 'turn-complete', turnId: request.delivery.turnId });
      return { status: 'admitted' };
    },
    watch(value) { listener = value; return { dispose() { listener = undefined; } }; },
    dispose() {},
  };
  const runtime = createNativeAgentSessionOperations(provider, sessionId, undefined, undefined, undefined, undefined, undefined, {
    // This Agent fixture uses no optional host service.
    context: {} as AgentSessionRuntimeContext, cwd: '/tmp/project', connectedAccounts: [],
    capabilities: { open: ['resume'], delivery: ['newTurn'], cancel: false },
    cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
  });
  const base = createLifecycleParams({ runPermissionModePromptLoopFn: options => {
    beforePendingMaterialize = options.beforePendingMaterialize;
    return runPermissionModePromptLoop({ ...options, inputConsumer: consumer });
  } });
  const outcomes = createSessionProviderInputOutcomeBinding({ getTarget: () => session });
  registerPermissionModeMessageQueueBinding({ session, queue,
    getCurrentPermissionMode: () => 'default', setCurrentPermissionMode: () => {},
    inFlightSteer: { isTurnInFlight: () => nativeTurnActive, supportsInFlightSteer: () => false,
      steerText: async () => { throw Error('No steer requested'); },
      registerProviderAcceptedEffect: outcomes.registerProviderAcceptedEffect,
      interruptActiveTurn: async () => {
        interruptions += 1;
        await abortRequested?.();
        emit({ kind: 'turn-cancelled', turnId: 'native-resume', cause: 'user' });
        return { status: 'interrupted' };
      } },
  });
  const unbindOutcomes = bindSessionProviderInputOutcome({ runtime,
    observe: outcomes.observeProviderInputOutcome, wakePendingMaterialization: () => session.wakePendingMaterialization() });
  let prepared = false;
  let termination: ReturnType<typeof registerRunnerTerminationHandlers> | undefined;
  const params = { ...base, session, runtime, hookRuntime: runtime,
    setAbortRequestedCallback: (callback: (() => void | Promise<void>) | null) => { abortRequested = callback; },
    registerProviderAcceptedEffect: outcomes.registerProviderAcceptedEffect,
    opts: { ...base.opts, credentials: { token, encryption: null } },
    async prepareStartupPresentation() {
      if (startPhase === 'presentation') {
        emit({ kind: 'turn-start', turnId: 'native-resume', startedBy: 'provider' });
        prepared = true;
      }
      return { terminalRemoteModeLoop: null, ownsCurrentTerminalDisplay: true };
    },
    config: { ...base.config, startRuntimeBeforeFirstPrompt: true,
      onAfterStart: async () => {
        if (startPhase !== 'presentation') {
          emit({ kind: 'turn-start', turnId: 'native-resume', startedBy: 'provider' });
          if (startPhase === 'model-readback' || startPhase === 'send-now') {
            await modelEvidence.apply({ model: { id: selection.modelId } });
            await vi.waitFor(async () => expect(await coordinator.readAppliedTarget()).toMatchObject({ status: 'applied' }));
            await modelEvidence.applyModelEvidence({ modelId: 'claude-haiku-4-5-20251001', source: 'assistant' });
          }
          prepared = true;
        }
      },
      lifecycleHooks: { createCheckpointLifecycle: () => ({}) } },
    permissionModeState: { ...base.permissionModeState, messageQueue: queue },
    deps: { ...base.deps, registerRunnerTerminationHandlersFn: (options: Parameters<typeof registerRunnerTerminationHandlers>[0]) => {
      termination = registerRunnerTerminationHandlers({ ...options, processLifecycleOwnership: 'caller', sessionExitReport: null, exit: () => undefined });
      return termination;
    } },
  };
  const running = runSessionLoopLifecycle(params);
  try {
    await vi.waitFor(() => expect(prepared).toBe(true));
    await setImmediate();
    if (startPhase !== 'send-now') {
      expect({ materializations, delivered }).toEqual({ materializations: 0, delivered: [] });
      emit({ kind: 'turn-complete', turnId: 'native-resume' });
    }
    await vi.waitFor(() => {
      expect(materializations).toBe(1);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatch(/First line\nSECOND-LINE$/);
      expect(receipts).toEqual([expect.objectContaining({ sessionId, localId: 'pending-input',
        acceptedTurn: expect.objectContaining({ kind: 'newTurn' }) })]);
      expect(session.hasPendingProviderInput('pending-input')).toBe(false);
      expect(session.getPendingQueueState()).toMatchObject({ pendingCount: 0 });
      expect(interruptions).toBe(startPhase === 'send-now' ? 1 : 0);
    });
  } finally {
    termination?.requestTermination({ kind: 'signal', signal: 'SIGTERM' });
    await running.catch(() => undefined);
    unbindOutcomes();
    await coordinator.dispose();
    await session.close();
    await registry.release();
    restoreHttp();
  }
});
