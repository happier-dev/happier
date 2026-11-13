import '@/testkit/async/mockNodeTimers';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ApiMachineClient } from '@/api/apiMachine';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';
import type { DaemonState, Machine } from '@/api/types';
import { createServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import { createActionExecutor, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1, type WorkflowDefinitionV1 } from '@happier-dev/protocol';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { createApiMachineTransportFixture } from '@/testkit/apiMachineTransport';
import { createDeferred } from '@/testkit/async/deferred';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { bootstrapMachineSyncRuntime, retireMachineSyncRuntimeAttempt } from './bootstrapMachineSyncRuntime';

import { UsageLimitRecoveryScheduler, type UsageLimitRecoveryIntent } from '../connectedServices/usageLimitRecovery/UsageLimitRecoveryScheduler';
import { isWorkflowRuntimeEnabled } from '../automation/workflowFeatureGate';
import { createWorkflowRunRecoveryReader } from '../workflows/recovery';
import { createWorkflowInvocationRecoveryObserver } from '../workflows/daemonRuntime';
import { createWorkflowRunStorageTestkit } from '../workflows/workflowRunStorage.testkit';

describe('bootstrapMachineSyncRuntime passive startup', () => {
  it.each([500, 2_000])('re-arms persisted usage-limit deadline %s without synchronous recovery', async deadline => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let stored: UsageLimitRecoveryIntent = { v: 1, status: 'waiting', issueFingerprint: 'original-failure', armedAtMs: 100,
      resetAtMs: deadline, nextCheckAtMs: deadline, attemptCount: 0, maxAttempts: 3, lastProbeError: null,
      resumePromptMode: 'standard', selectedAuth: { kind: 'native' } };
    const recover = vi.fn(async () => ({ status: 'superseded' as const }));
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: Date.now, recover,
      store: { read: () => stored, readAll: () => [['session', stored]], write: (_key, value) => { stored = value; } } });
    try {
      scheduler.hydratePassive();
      expect(vi.getTimerCount()).toBe(0);
      scheduler.hydrate();
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(Math.max(0, deadline - 1_000));
      expect(recover).toHaveBeenCalledOnce();
    } finally { scheduler.dispose(); vi.useRealTimers(); }
  });

  it('keeps the speech-transcription peer media consumer wired into the relay terminator', async () => {
    const source = await readFile(new URL('./bootstrapMachineSyncRuntime.ts', import.meta.url), 'utf8');
    expect(source).toContain('voiceBinaryAppendConsumer');
  });
});

it('waits for the existing online feature refresh before the one-shot Workflow recovery pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-recovery-feature-order-'));
  const featureStarted = createDeferred<void>();
  const featureRead = createDeferred<void>();
  const ready = { status: 'ready' as const, provenance: 'authenticated' as const,
    features: { features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {} } };
  const featureStore = createServerFeaturesSnapshotStore({ fetchSnapshot: async () => {
    featureStarted.resolve();
    await featureRead.promise;
    return ready;
  } });
  const accountId = 'account-1';
  const machineId = 'workflow-feature-machine';
  const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
  const rootId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
  const childId = '33333333-3333-4333-8333-333333333333';
  const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
    binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint: { kind: 'happier.workflow-checkpoint.v1',
      rootRecordId: rootId, nextSequence: '2', frontier: { nextBlockOrdinal: 1, paused: false } } }));
  const seal = (root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
    binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: root ? rootId : childId,
      sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
    progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'step',
      invocationPath: { blockId: root ? '$root' : 'background', scope: [] }, attempt: '0', logicalInvocationRecordId: root ? rootId : childId,
      ...(root ? {} : { reason: { code: 'execution_run_input_not_observed' }, execution: { kind: 'detached_run' as const,
        runId: 'historical-native-run', localInputId: 'historical-input', runtimeSelection: {} } }) } }));
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
    { kind: 'step', id: 'background', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
  ] };
  const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
    binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
      startedBy: 'user', definition, authoredDefinition: definition, workDepth: 0, metadata: null, frozenChildren: {}, materializedLeaves: [],
      source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'detached_run' },
      workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' }, originalCommittedRevision: 'a'.repeat(40) },
      origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
    } }));
  const storage = createWorkflowRunStorageTestkit({ accountId, runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
  await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope,
    rootInvocation: { id: rootId, contentEnvelope: seal(true) } });
  await storage.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope,
    invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0',
      lifecycle: 'cancel_requested', contentEnvelope: seal(false) }] });
  storage.requestControl('cancelled');
  const recover = createWorkflowRunRecoveryReader({ accountId, machineId,
    storage: { execute: async (operation, options) => operation.operation === 'recovery.list'
      ? { candidates: storage.run().workflowCustodyState === 'pending' ? [{ run: storage.run(), parentAttempt: 0 }] : [] }
      : await storage.execute(operation, options) },
    resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    reconcileInvocation: createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId,
      actionExecutor: createActionExecutor(createUnavailableActionTransportDeps()),
      nativeActionRuns: {
        get: async () => ({ run: { runId: 'historical-native-run', callId: 'call', sidechainId: 'side', intent: 'agent',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'default', retentionPolicy: 'resumable',
          runClass: 'long_lived', ioMode: 'request_response', status: 'cancelled', startedAtMs: 1, finishedAtMs: 2,
          inputTurns: { occurrenceId: 'historical-occurrence',
            last: { turnId: 'historical-turn', inputIds: ['historical-input'], state: 'cancelled' } } } }),
        stop: async () => { throw new Error('Terminal Run must not be stopped again'); },
        wait: async () => { throw new Error('Terminal Run must not be waited again'); },
      },
    }),
  });
  let onlineListener: ((state: ManagedConnectionState) => void) | undefined;
  const connect = vi.fn<ApiMachineClient['connect']>(() => {});
  const apiMachine = { ...createApiMachineTransportFixture(),
    onConnectionStateChange: (listener: (state: ManagedConnectionState) => void) => {
      onlineListener = listener;
      return () => { onlineListener = undefined; };
    },
    setRPCHandlers: () => ({}), registerLiveStreamRelayRoutes: () => {}, connect,
    updateDaemonState: async () => {}, updateMachineMetadata: async () => {},
    emitExternalSessionTranscriptUpdate: () => {}, sendMachineTransferEnvelope: () => {},
    sendTransferRelayV2Envelope: () => {}, sendMachineLiveStreamRelayEnvelope: () => {},
    getPeerMediationMachineRpcHandlerManager: () => ({ invokeLocal: async () => ({ ok: true }) }),
  } as unknown as ApiMachineClient;
  const machine: Machine = { id: machineId, encryptionMode: 'plain', metadata: null,
    metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
  let bootstrap: Awaited<ReturnType<typeof bootstrapMachineSyncRuntime>> | undefined;
  let connected: Promise<void> | undefined;
  try {
    bootstrap = await bootstrapMachineSyncRuntime({
      cliVersion: 'test', machineId: machine.id, machine, preferredHost: 'host.local',
      happyHomeDir: root, happyLibDir: root, filesystemAccessPolicy: { kind: 'osUser' },
      takeoverRequested: false, isShuttingDown: () => false,
      createConnectedApiMachine: () => apiMachine, attachTransferRuntimeStatePublisher: async () => {},
      startAutomationWorkerForMachine: () => null, startMemoryWorkerForMachine: async () => null,
      startVoiceInferenceWorkerForMachine: async () => null,
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      spawnSessionForInternalResume: async () => ({ type: 'success', sessionId: 'unused' }),
      stopSession: async () => ({ status: 'stopped' }), isSessionAlreadyRunning: async () => false,
      loadLocalSessionMetadataForHandoff: async () => null, beforeShutdown: async () => {}, requestShutdown: () => {},
      directPeerServerLifecycle: null, directTransferRegistryHost: createCliRegistryHostV1(),
      connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null,
      daemonServerWorkScheduler: {} as never,
      onMachineConnectionOnline: async () => { await featureStore.refresh(); },
      recoverWorkflowRuns: async trigger => {
        if (isWorkflowRuntimeEnabled({}, featureStore.getSnapshot())) await recover(trigger);
      },
    });
    const onConnect = connect.mock.calls[0]?.[0]?.onConnect;
    if (!onlineListener || !onConnect) throw new Error('Machine connection hooks unavailable');
    onlineListener({ phase: 'online', reason: null, attempt: 1, nextRetryAt: null,
      lastConnectedAt: 1_000, lastDisconnectedAt: null, lastErrorMessage: null });
    connected = Promise.resolve(onConnect());
    await featureStarted.promise;
    expect(storage.run().workflowCustodyState).toBe('pending');
    featureRead.resolve();
    await connected;
    expect(storage.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'settled' });
    expect(storage.rowById(childId)?.index.lifecycle).toBe('cancelled');
  } finally {
    featureRead.resolve();
    await connected;
    if (bootstrap) await retireMachineSyncRuntimeAttempt(bootstrap);
    await rm(root, { recursive: true, force: true });
  }
});


it('applies Agent Account settings after startup and reconnect, and retires its watches with the Machine attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bootstrap-account-settings-'));
  const native = join(root, 'native');
  let policy = { mode: 'days' as const, days: 365 };
  let revision = 1;
  const hints = new Set<() => void>();
  const settingsRead = createDeferred<void>();
  const runtime = await createAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.claude'], accountSettingsRecordAdapter: {
      bindOperation: async () => ({
        readRecord: async () => {
          await settingsRead.promise;
          return { status: 'present', revision, values: { claudeSessionRetentionV1: policy } };
        },
        writeRecord: async () => { throw new Error('Daemon application must preserve Account intent'); },
      }),
      watchRecord: (_model, listener) => {
        const hint = () => listener({ revision });
        hints.add(hint);
        return () => { hints.delete(hint); };
      },
    } },
  });
  let state: DaemonState = { status: 'running', startedAt: 100 };
  const connect = vi.fn<ApiMachineClient['connect']>(() => {});
  // The Machine transport and Account persistence are boundaries. Registry
  // activation, settings service, native editor and lifecycle remain real.
  const apiMachine = {
    ...createApiMachineTransportFixture(),
    setRPCHandlers: () => ({}),
    registerLiveStreamRelayRoutes: () => {},
    connect,
    updateDaemonState: async (handler: Parameters<ApiMachineClient['updateDaemonState']>[0]) => { state = handler(state); },
    updateMachineMetadata: async () => {},
    emitExternalSessionTranscriptUpdate: () => {},
    sendMachineTransferEnvelope: () => {},
    sendTransferRelayV2Envelope: () => {},
    sendMachineLiveStreamRelayEnvelope: () => {},
    getPeerMediationMachineRpcHandlerManager: () => ({ invokeLocal: async () => ({ ok: true }) }),
  } as unknown as ApiMachineClient;
  const machine: Machine = { id: 'retention-bootstrap-machine', encryptionMode: 'plain', metadata: null,
    metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
  let bootstrap: Awaited<ReturnType<typeof bootstrapMachineSyncRuntime>> | undefined;
  let bootstrapPromise: ReturnType<typeof bootstrapMachineSyncRuntime> | undefined;
  try {
    await mkdir(native);
    await writeFile(join(native, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 7, theme: 'dark' }));
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'retention-bootstrap-account',
      settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    const params = {
      cliVersion: 'test', machineId: machine.id, machine,
      preferredHost: 'host.local', happyHomeDir: root, happyLibDir: root,
      filesystemAccessPolicy: { kind: 'osUser' as const }, takeoverRequested: false,
      isShuttingDown: () => false, createConnectedApiMachine: () => apiMachine,
      attachTransferRuntimeStatePublisher: async () => {},
      startAutomationWorkerForMachine: () => null, startMemoryWorkerForMachine: async () => null,
      startVoiceInferenceWorkerForMachine: async () => null,
      spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }),
      spawnSessionForInternalResume: async () => ({ type: 'success' as const, sessionId: 'unused' }),
      stopSession: async () => ({ status: 'stopped' as const }), isSessionAlreadyRunning: async () => false,
      loadLocalSessionMetadataForHandoff: async () => null, beforeShutdown: async () => {}, requestShutdown: () => {},
      directPeerServerLifecycle: null, directTransferRegistryHost: createCliRegistryHostV1(),
      connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null,
      daemonServerWorkScheduler: {} as never,
      providerAccountSettings: { scopeKey: 'retention-bootstrap-account', processEnv: { CLAUDE_CONFIG_DIR: native },
        materializationBaseDir: join(root, 'materialized'), activeServerDir: join(root, 'server') },
    };
    bootstrapPromise = bootstrapMachineSyncRuntime(params);
    // Optional plugin settings must not hold the ordinary Machine connection.
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    settingsRead.resolve();
    bootstrap = await bootstrapPromise;
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(native, 'settings.json'), 'utf8')))
      .toEqual({ cleanupPeriodDays: 365, theme: 'dark' }));
    expect(state.providerSettingsSourceV1?.pid).toBe(process.pid);
    expect(state.providerSettingsSourceV1?.startedAt).toBe(100);
    expect(state.providerSettingsV1?.claude?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'native', status: 'applied', currentDays: 365 }),
    ]));

    // A missed Account push is reconciled by the existing reconnect edge.
    policy = { mode: 'days', days: 36500 };
    revision++;
    const onConnect = connect.mock.calls[0]?.[0]?.onConnect;
    if (!onConnect) throw new Error('Machine reconnect callback unavailable');
    await onConnect();
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(native, 'settings.json'), 'utf8')).cleanupPeriodDays).toBe(36500));
    expect(hints.size).toBeGreaterThan(0);
    await retireMachineSyncRuntimeAttempt(bootstrap);
    bootstrap = undefined;
    bootstrapPromise = undefined;
    expect(hints.size).toBe(0);
  } finally {
    settingsRead.resolve();
    if (!bootstrap && bootstrapPromise) bootstrap = await bootstrapPromise;
    if (bootstrap) await retireMachineSyncRuntimeAttempt(bootstrap);
    resetActiveAccountSettingsSnapshotForTests();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
