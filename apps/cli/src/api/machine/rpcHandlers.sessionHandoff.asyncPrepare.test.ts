import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { FeaturesResponseSchema, type ActionOperationSnapshotV1, type SessionHandoffPrepareTargetRequestV2 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { writeExecutableShim } from '@/testkit/fs/executableShim';

async function removeTestDirectory(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 25,
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('rpcHandlers (session handoff async prepare)', () => {
  it('reports missing local authentication before an existing-state handoff instead of an unsupported peer', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-auth-admission-'));
    let registration: Awaited<ReturnType<typeof import('./rpcHandlers')['registerMachineRpcHandlers']>> | undefined;
    try {
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return { ...actual, configuration: { ...actual.configuration, activeServerId: 'cloud', activeServerDir,
          privateKeyFile: join(activeServerDir, 'missing-access.key'), legacyPrivateKeyFile: join(activeServerDir, 'missing-legacy.key') } };
      });
      const { RpcHandlerManager } = await import('../rpc/RpcHandlerManager');
      const { registerMachineRpcHandlers } = await import('./rpcHandlers');
      const { readRpcErrorCode } = await import('@happier-dev/protocol/rpcErrors');
      const manager = new RpcHandlerManager({ scopePrefix: 'local', encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' });
      let processMutationCount = 0;
      registration = registerMachineRpcHandlers({ rpcHandlerManager: manager, handlers: {
        // Only runner process adapters are replaced; credential reads and admission stay real.
        spawnSession: async () => { processMutationCount += 1; return { type: 'success', sessionId: 'session-1' }; },
        spawnSessionForHandoff: async () => { processMutationCount += 1; return { type: 'success', sessionId: 'session-1', runnerAcceptance: 'newly_accepted' }; },
        stopSession: async () => { processMutationCount += 1; return true; },
        requestShutdown: () => { processMutationCount += 1; },
      } });
      const error = await manager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_START, {
        sessionId: 'session-1', sourceMachineId: 'source', targetMachineId: 'target',
        sessionStorageMode: 'persisted', stateTransfer: 'existing',
        preferredTransportStrategies: ['direct_peer'], negotiatedTransportStrategy: 'direct_peer',
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(readRpcErrorCode(error)).toBe('not_authenticated');
      expect(processMutationCount).toBe(0);
    } finally {
      await registration?.dispose();
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await removeTestDirectory(activeServerDir);
    }
  });

  it('prepares existing-state through the native store without transfer and retains the mode across restart', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-existing-prepare-'));
    const claudeHome = join(activeServerDir, 'claude-home');
    const targetPath = join(activeServerDir, 'workspace');
    const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    const transcriptPath = join(claudeHome, 'projects', 'existing-project', 'native-1.jsonl');
    const transcript = '{"type":"user","message":{"role":"user","content":"preserved"}}\n';
    try {
      await mkdir(join(claudeHome, 'projects', 'existing-project'), { recursive: true });
      await mkdir(targetPath);
      await writeFile(transcriptPath, transcript);
      // Native state and launch admission stay real; only executable presence is supplied.
      const claudePath = await writeExecutableShim({
        dir: activeServerDir, fileName: 'claude', contents: `#!${process.execPath}\nprocess.exit(0);\n`,
      });
      const processEnv = { ...process.env, HAPPIER_CLAUDE_PATH: claudePath };
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return { ...actual, configuration: { ...actual.configuration, activeServerDir } };
      });
      const { RpcHandlerManager } = await import('../rpc/RpcHandlerManager');
      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');
      const { createSessionHandoffPrepareTargetJobStore } = await import('../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore');
      const metadata = { path: targetPath, flavor: 'claude', machineId: 'source', claudeSessionId: 'native-1' };
      let environmentReady: Promise<void> | undefined;
      let environmentRequested = false;
      let removeNativeStateBeforeLaunch = false;
      let runnerLaunches = 0;
      let launchFailure: unknown;
      const { resolveSpawnChildEnvironment } = await import('../../daemon/spawn/resolveSpawnChildEnvironment');
      const createHandlers = () => {
        const manager = new RpcHandlerManager({ scopePrefix: 'test', encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey', encryptionMode: 'plain' });
        registerMachineSessionHandoffRpcHandlers({
          rpcHandlerManager: manager,
          loadSessionMetadata: async () => metadata,
          probeHandoffCapability: async () => ({ protocolVersion: 2, existingState: true, atomicTargetResume: true, targetCleanup: true }),
          // Runner launch is the process boundary; durable resume/confirm/commit stay real.
          spawnSessionForHandoff: async (_options, hooks) => {
            if (removeNativeStateBeforeLaunch) {
              // Lose only the synthetic native transcript after real preparation has resolved it.
              expect(await readFile(transcriptPath, 'utf8')).toBe(transcript);
              await rm(transcriptPath);
            }
            const environment = await resolveSpawnChildEnvironment({
              options: _options, existingSessionMetadata: metadata,
              profileEnvironmentVariables: {}, daemonSpawnHooks: null, processEnv,
              logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
            });
            if (!environment.ok) {
              launchFailure = { type: 'error', errorCode: environment.errorCode, errorMessage: environment.errorMessage };
              return { type: 'error', errorCode: environment.errorCode, errorMessage: environment.errorMessage };
            }
            await hooks.onBeforeRunnerLaunchAccepted?.();
            runnerLaunches += 1;
            return { type: 'success', sessionId: 'session-1', runnerAcceptance: 'newly_accepted' };
          },
          stopSessionForHandoff: async () => 'already_inactive',
          resolveExistingStateEnvironment: async () => {
            environmentRequested = true;
            await environmentReady;
            return processEnv;
          },
        });
        return manager;
      };
      const manager = createHandlers();
      const request = {
        handoffId: 'existing-native', sessionId: 'session-1', sourceMachineId: 'source', targetMachineId: 'target',
        stateTransfer: 'existing', sourceSessionStorageMode: 'persisted', targetPath,
        negotiatedTransportStrategy: 'direct_peer', allowServerRoutedFallback: false, endpointCandidates: [],
      } satisfies SessionHandoffPrepareTargetRequestV2;
      await manager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2, request);
      let result: unknown;
      await vi.waitFor(async () => {
        result = await manager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2, { handoffId: request.handoffId, sessionId: request.sessionId });
        expect(result).toMatchObject({ remoteSessionId: 'native-1', status: { status: 'ready_for_cutover' } });
      }, { timeout: 10_000 });
      expect(result).toMatchObject({
        status: { status: 'ready_for_cutover', progress: { current: { phaseDetail: 'ready_for_cutover' } } },
      });
      expect(await readFile(transcriptPath, 'utf8')).toBe(transcript);
      const persisted = await createSessionHandoffPrepareTargetJobStore({ activeServerDir }).findByHandoffId(request.handoffId);
      expect(persisted).toMatchObject({ existingStateSessionId: 'session-1', prepareTargetRequest: { stateTransfer: 'existing' } });
      expect(await manager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2, {
        handoffId: request.handoffId, sessionId: 'different-session',
      })).toMatchObject({ ok: false, errorCode: 'invalid_persisted_job' });
      expect(await createHandlers().invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2, { handoffId: request.handoffId, sessionId: request.sessionId })).toEqual(result);
      const resumed = await manager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2, { handoffId: request.handoffId, sessionId: request.sessionId, attemptId: 'attempt-1' });
      expect(resumed).toMatchObject({ disposition: 'started_for_handoff' });
      await manager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_CONFIRM_V2, { handoffId: request.handoffId, sessionId: request.sessionId, attemptId: 'attempt-1' });
      expect(await manager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V2, { handoffId: request.handoffId, sessionId: request.sessionId, attemptId: 'attempt-1', mode: 'target' })).toMatchObject({ status: { status: 'completed' } });
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const { sessionId: _sessionId, ...restartRequest } = request;
      await store.write({
        jobId: 'prepare-existing-restart', handoffId: 'existing-restart', existingStateSessionId: request.sessionId,
        createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000,
        prepareTargetRequest: { ...restartRequest, handoffId: 'existing-restart' },
        status: { handoffId: 'existing-restart', status: 'pending', phase: 'staging_target', recoveryActions: [] },
      });
      const restarted = createHandlers();
      await restarted.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET, { handoffId: 'existing-restart' });
      await vi.waitFor(async () => {
        const job = await store.findByHandoffId('existing-restart');
        if (job?.lastErrorMessage) throw new Error(job.lastErrorMessage);
        expect(await restarted.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2, { handoffId: 'existing-restart', sessionId: request.sessionId })).toMatchObject({ remoteSessionId: 'native-1', status: { status: 'ready_for_cutover' } });
      }, { timeout: 10_000 });
      expect(await readFile(transcriptPath, 'utf8')).toBe(transcript);
      const cancelledEnvironment = createDeferred<void>();
      environmentReady = cancelledEnvironment.promise;
      environmentRequested = false;
      const cancelledManager = createHandlers();
      try {
        await cancelledManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2, { ...request, handoffId: 'existing-cancelled' });
        await vi.waitFor(() => expect(environmentRequested).toBe(true), { timeout: 10_000 });
        expect(await cancelledManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2, {
          handoffId: 'existing-cancelled', sessionId: 'different-session', reason: 'cancel',
        })).toMatchObject({ ok: false, errorCode: 'invalid_persisted_job' });
        expect(await cancelledManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2, {
          handoffId: 'existing-cancelled', sessionId: request.sessionId, reason: 'cancel',
        })).toMatchObject({ status: { status: 'aborted' } });
      } finally {
        cancelledEnvironment.resolve();
      }
      await vi.waitFor(async () => {
        const cancelled = await store.findByHandoffId('existing-cancelled');
        if (!cancelled) throw new Error('Cancelled prepare job is missing');
        // Observe writer completion, not just the abort handler's immediate projection.
        await expect(readFile(join(activeServerDir, 'session-handoff', 'prepare-target-jobs-staging',
          cancelled.jobId, 'lease', 'lease.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(cancelled).toMatchObject({ status: { status: 'aborted' } });
        expect(cancelled).not.toHaveProperty('prepareTargetResult');
      }, { timeout: 10_000 });
      environmentReady = undefined;
      await rm(transcriptPath);
      const deferredEnvironment = createDeferred<void>();
      environmentReady = deferredEnvironment.promise;
      const missingManager = createHandlers();
      const missing = await missingManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2, { ...request, handoffId: 'existing-missing' });
      expect(missing).not.toHaveProperty('resume');
      deferredEnvironment.resolve();
      await vi.waitFor(async () => {
        const failed = await createSessionHandoffPrepareTargetJobStore({ activeServerDir }).findByHandoffId('existing-missing');
        expect(failed).toMatchObject({ status: { status: 'awaiting_recovery' } });
        expect(failed).not.toHaveProperty('prepareTargetResult');
      }, { timeout: 10_000 });
      const missingResult = await missingManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2, { handoffId: 'existing-missing', sessionId: request.sessionId });
      expect(missingResult).toMatchObject({ ok: false, errorCode: 'existing_session_state_unavailable' });
      expect(await createHandlers().invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2, { handoffId: 'existing-missing', sessionId: request.sessionId })).toEqual(missingResult);
      environmentReady = undefined;
      expect(await missingManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2, { ...request, handoffId: 'existing-missing-immediate' })).toMatchObject({ ok: false, errorCode: 'existing_session_state_unavailable' });
      const { createSessionHandoffCoordinator } = await import('../../session/handoff/orchestration/sessionHandoffCoordinator');
      const { resolveExistingSessionHandoffEligibilityThroughCatalog } = await import('@/backends/catalog');
      const { createActionOperationRunner } = await import('../../daemon/actionOperations/actionOperationRunner');
      const { createActionOperationStore } = await import('../../daemon/actionOperations/actionOperationStore');
      const { createTrackedSessionHandoffStart } = await import('../../daemon/actionOperations/trackedSessionHandoffStart');
      const snapshots: ActionOperationSnapshotV1[] = [];
      const operationStore = createActionOperationStore({ onRevision: (snapshot) => snapshots.push(snapshot) });
      const trackedStart = createTrackedSessionHandoffStart({
        runner: createActionOperationRunner({ store: operationStore }),
        getScope: async () => ({ accountId: 'handoff-test-account', machineId: 'source' }),
        startUntracked: async (payload) => missingManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_START, payload),
        coordinate: async (input, context, startSource) => {
          const call = (method: string, payload: unknown) => missingManager.invokeLocal(method, payload);
          const coordinator = createSessionHandoffCoordinator({
            assertExistingStateSupported: async () => {
              const eligibility = resolveExistingSessionHandoffEligibilityThroughCatalog(metadata);
              if (!eligibility.eligible) throw new Error(eligibility.reasonCode);
            },
            probeSourceCapability: async () => call(RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET, {}),
            probeTargetCapability: async () => call(RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET, {}),
            startSource,
            prepareTarget: async (payload) => call(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2, payload),
            getTargetPrepareResult: async (payload) => call(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2, payload),
            getTargetStatus: async (payload) => call(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET, payload),
            resumeTarget: async (payload) => call(RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2, payload),
            confirmTarget: async (payload) => call(RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_CONFIRM_V2, payload),
            commitTarget: async (payload) => call(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V2, payload),
            cleanupSource: async (payload) => call(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT, payload),
            abortTarget: async (payload) => call(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2, payload),
            abortSource: async (payload) => call(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT, payload),
            bindTarget: async () => { throw new Error('A missing native session must not bind the target'); },
            wait: async () => new Promise((resolve) => setTimeout(resolve, 0)),
            readServerFeatures: async () => FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, handoff: { enabled: true } } }, capabilities: {} }),
            directPeerAvailable: false,
            preferredTransportStrategies: input.preferredTransportStrategies,
          });
          return (await coordinator.admit(input)).execute(context);
        },
      });
      await writeFile(transcriptPath, transcript);
      removeNativeStateBeforeLaunch = true;
      const launchesBeforeNativeLoss = runnerLaunches;
      const admission = await trackedStart({
        requestId: 'existing-launch-missing-composed', sessionId: request.sessionId,
        sourceMachineId: request.sourceMachineId, targetMachineId: request.targetMachineId,
        sessionStorageMode: 'persisted', stateTransfer: 'existing', preferredTransportStrategies: ['direct_peer'],
      });
      expect(admission).toHaveProperty('handoffId');
      await vi.waitFor(() => expect(snapshots.at(-1)).toMatchObject({
        state: 'failed', error: { errorCode: 'existing_session_state_unavailable', error: 'Claude existing native session is unreachable' },
      }), { timeout: 10_000 });
      expect(runnerLaunches).toBe(launchesBeforeNativeLoss);
      const outputPath = process.env.HAPPIER_HANDOFF_FAILURE_TEST_OUTPUT;
      if (outputPath) await writeFile(outputPath, JSON.stringify({ admission, terminal: snapshots.at(-1), prepareResult: missingResult, launchFailure }));
    } finally {
      if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await removeTestDirectory(activeServerDir);
    }
  });
  it('refuses an existing-state raw start before source stop when the peer lacks support', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-existing-admission-'));
    try {
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return { ...actual, configuration: { ...actual.configuration, activeServerDir } };
      });
      const { RpcHandlerManager } = await import('../rpc/RpcHandlerManager');
      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');
      const unmountedManager = new RpcHandlerManager({ scopePrefix: 'unmounted', encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey', encryptionMode: 'plain' });
      registerMachineSessionHandoffRpcHandlers({ rpcHandlerManager: unmountedManager });
      expect(await unmountedManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET, {}))
        .toMatchObject({ protocolVersion: 2, existingState: false });
      const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: 'test', encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey', encryptionMode: 'plain' });
      const stopSessionForHandoff = vi.fn(async () => 'stopped' as const);
      let existingStateSupported = false;
      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager,
        loadSessionMetadata: async () => ({ path: '/repo', flavor: 'claude', machineId: 'source', claudeSessionId: 'native-1' }),
        stopSessionForHandoff,
        spawnSessionForHandoff: async () => ({ type: 'success', sessionId: 'session-1', runnerAcceptance: 'newly_accepted' }),
        probeHandoffCapability: async () => ({ protocolVersion: 2, atomicTargetResume: true, targetCleanup: true, ...(existingStateSupported ? { existingState: true } : {}) }),
      });
      const result = await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_START, {
        sessionId: 'session-1', sourceMachineId: 'source', targetMachineId: 'target',
        sessionStorageMode: 'persisted', stateTransfer: 'existing',
        preferredTransportStrategies: ['direct_peer'], negotiatedTransportStrategy: 'direct_peer',
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'upgrade_required' });
      expect(stopSessionForHandoff).not.toHaveBeenCalled();
      expect(await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2, {
        handoffId: 'unadmitted-existing', sessionId: 'session-1', sourceMachineId: 'source', targetMachineId: 'target',
        targetPath: '/repo', sourceSessionStorageMode: 'persisted', stateTransfer: 'existing',
        negotiatedTransportStrategy: 'direct_peer', endpointCandidates: [],
      })).toMatchObject({ ok: false, errorCode: 'upgrade_required' });
      const { createSessionHandoffPrepareTargetJobStore } = await import('../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore');
      expect(await createSessionHandoffPrepareTargetJobStore({ activeServerDir }).findByHandoffId('unadmitted-existing')).toBeNull();
      existingStateSupported = true;
      const started = await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_START, {
        sessionId: 'session-1', sourceMachineId: 'source', targetMachineId: 'target',
        sessionStorageMode: 'persisted', stateTransfer: 'existing',
        preferredTransportStrategies: ['direct_peer'], negotiatedTransportStrategy: 'direct_peer',
      });
      expect(started).toMatchObject({ handoffId: expect.any(String), targetPath: '/repo', endpointCandidates: [] });
      if (!started || typeof started !== 'object' || !('handoffId' in started) || typeof started.handoffId !== 'string') throw new Error('Expected started handoff');
      const { createSessionHandoffSourceExportStore } = await import('../../session/handoff/state/sessionHandoffSourceExportStore');
      const record = await createSessionHandoffSourceExportStore({ activeServerDir }).load(started.handoffId);
      expect(record).toMatchObject({ stateTransfer: 'existing', sessionId: 'session-1' });
      expect(record).not.toHaveProperty('providerBundle');
      expect(record).not.toHaveProperty('workspaceManifest');
    } finally {
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await removeTestDirectory(activeServerDir);
    }
  });
  it('uses a durable lease so only one daemon instance restarts a persisted non-terminal prepare-target job (no double-import across processes)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-lease-liveness-'));
    const targetPath = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-lease-target-'));

    const continueImportSession = createDeferred<void>();

    try {
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return {
          ...actual,
          configuration: {
            ...(actual.configuration as any),
            activeServerDir,
          },
        };
      });

      const { createSessionHandoffPrepareTargetJobStore } = await import(
        '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
      );
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const nowMs = Date.now();
      const handoffId = 'handoff_lease_1';
      const jobId = 'prepare_lease_1';
      await prepareJobStore.write({
        jobId,
        handoffId,
        createdAtMs: nowMs - 10_000,
        updatedAtMs: nowMs - 5_000,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          transportStrategy: 'direct_peer',
          progress: {
            updatedAtMs: nowMs - 5_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
          recoveryActions: [],
        },
      });

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');

      const registeredA = new Map<string, (params: unknown) => Promise<any>>();
      const registeredB = new Map<string, (params: unknown) => Promise<any>>();

      const directPeerTransfer = {
        publishTransfer: () => [],
        requestPayloadFile: async (input: Readonly<{
          transferId: string;
          endpointCandidates: readonly unknown[];
          destinationPath: string;
        }>) => {
          await writeFile(input.destinationPath, JSON.stringify({
            providerId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          }));
          return { destinationPath: input.destinationPath };
        },
        clearPublishedTransfer: () => undefined,
      };

      const importSessionBundleA = vi.fn(async () => {
        await continueImportSession.promise;
        return {
          remoteSessionId: 'claude_session_target',
          directSource: {
            kind: 'claudeConfig' as const,
            configDir: null,
            projectId: null,
          },
          resume: {
            directory: targetPath,
            agent: 'claude' as const,
            resume: 'claude_session_target',
            transcriptStorage: 'persisted' as const,
            approvedNewDirectoryCreation: true as const,
          },
        };
      });
      const importSessionBundleB = vi.fn(async () => {
        await continueImportSession.promise;
        return {
          remoteSessionId: 'claude_session_target',
          directSource: {
            kind: 'claudeConfig' as const,
            configDir: null,
            projectId: null,
          },
          resume: {
            directory: targetPath,
            agent: 'claude' as const,
            resume: 'claude_session_target',
            transcriptStorage: 'persisted' as const,
            approvedNewDirectoryCreation: true as const,
          },
        };
      });

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registeredA.set(method, handler);
          },
        } as any,
        directPeerTransfer: directPeerTransfer as any,
        importSessionBundle: importSessionBundleA,
      });

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registeredB.set(method, handler);
          },
        } as any,
        directPeerTransfer: directPeerTransfer as any,
        importSessionBundle: importSessionBundleB,
      });

      const prepareA = registeredA.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const prepareB = registeredB.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const resultGetA = registeredA.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      expect(prepareA).toBeDefined();
      expect(prepareB).toBeDefined();
      expect(resultGetA).toBeDefined();

      const preparePayload = {
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        handoffMetadataV2: {
          providerBundleTransferPublication: {
            transferId: 'session-handoff:handoff_lease_1:provider-bundle',
            sizeBytes: 123,
            manifestHash: 'hash',
            endpointCandidates: [
              { kind: 'http', url: 'http://127.0.0.1:1111', expiresAt: Date.now() + 60_000, authorizationToken: 'tok' },
            ],
          },
        },
      } as const;

      const [ackA, ackB] = await Promise.all([
        prepareA!(preparePayload),
        prepareB!(preparePayload),
      ]);

      expect(ackA).toMatchObject({
        handoffId,
        status: { handoffId, jobId, status: 'pending' },
      });
      expect(ackB).toMatchObject({
        handoffId,
        status: { handoffId, jobId, status: 'pending' },
      });

      // Without a durable lease, both daemon instances can start the import concurrently.
      await vi.waitFor(() => {
        expect(importSessionBundleA.mock.calls.length + importSessionBundleB.mock.calls.length).toBe(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(importSessionBundleA.mock.calls.length + importSessionBundleB.mock.calls.length).toBe(1);

      continueImportSession.resolve();

      await vi.waitFor(async () => {
        await expect(resultGetA!({ handoffId })).resolves.toMatchObject({
          handoffId,
          status: { handoffId, status: 'ready_for_cutover' },
        });
      });
    } finally {
      vi.resetModules();
      await removeTestDirectory(activeServerDir);
      await removeTestDirectory(targetPath);
    }
  });

  it('restarts a persisted non-terminal prepare-target job when called again after daemon restart (no hanging pending job with missing runner)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-restart-liveness-'));
    const targetPath = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-restart-target-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return {
          ...actual,
          configuration: {
            ...(actual.configuration as any),
            activeServerDir,
          },
        };
      });

      const { createSessionHandoffPrepareTargetJobStore } = await import(
        '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
      );
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const nowMs = Date.now();
      const handoffId = 'handoff_restart_1';
      const jobId = 'prepare_restart_1';

      // Simulate a daemon crash leaving behind an unexpired lease record for the job runner.
      // Restart liveness must not wait for the TTL; the new daemon should deterministically steal it.
      const leasePath = join(
        activeServerDir,
        'session-handoff',
        'prepare-target-jobs-staging',
        jobId,
        'lease',
        'lease.json',
      );
      await mkdir(join(
        activeServerDir,
        'session-handoff',
        'prepare-target-jobs-staging',
        jobId,
        'lease',
      ), { recursive: true });
      await writeFile(leasePath, JSON.stringify({
        ownerId: 'cli-daemon:999999:stale',
        acquiredAtMs: nowMs - 1000,
        renewedAtMs: nowMs - 1000,
        expiresAtMs: nowMs + 60 * 60 * 1000,
      }));

      await prepareJobStore.write({
        jobId,
        handoffId,
        createdAtMs: nowMs - 10_000,
        updatedAtMs: nowMs - 5_000,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          transportStrategy: 'direct_peer',
          progress: {
            updatedAtMs: nowMs - 5_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
          recoveryActions: [],
        },
      });

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const continueImportSession = createDeferred<void>();

      const directPeerTransfer = {
        publishTransfer: () => [],
        requestPayloadFile: async (input: Readonly<{
          transferId: string;
          endpointCandidates: readonly unknown[];
          destinationPath: string;
        }>) => {
          // Provide a minimal provider bundle file for the prepare job.
          await writeFile(input.destinationPath, JSON.stringify({
            providerId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          }));
          return { destinationPath: input.destinationPath };
        },
        clearPublishedTransfer: () => undefined,
      };

      const importSessionBundle = vi.fn(async () => {
        await continueImportSession.promise;
        return {
          remoteSessionId: 'claude_session_target',
          directSource: {
            kind: 'claudeConfig' as const,
            configDir: null,
            projectId: null,
          },
          resume: {
            directory: targetPath,
            agent: 'claude' as const,
            resume: 'claude_session_target',
            transcriptStorage: 'persisted' as const,
            approvedNewDirectoryCreation: true as const,
          },
        };
      });

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
        directPeerTransfer: directPeerTransfer as any,
        importSessionBundle,
      });

      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      expect(prepare).toBeDefined();
      expect(statusGet).toBeDefined();
      expect(resultGet).toBeDefined();

      const preparePayload = {
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        handoffMetadataV2: {
          providerBundleTransferPublication: {
            transferId: 'session-handoff:handoff_restart_1:provider-bundle',
            sizeBytes: 123,
            manifestHash: 'hash',
            endpointCandidates: [
              { kind: 'http', url: 'http://127.0.0.1:1111', expiresAt: Date.now() + 60_000, authorizationToken: 'tok' },
            ],
          },
        },
      } as const;

      // Simulate duplicate PREPARE_TARGET calls after a daemon restart: only one runner should be started.
      const [prepareAck, prepareAck2] = await Promise.all([
        prepare!(preparePayload),
        prepare!(preparePayload),
      ]);

      expect(prepareAck).toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
        },
      });
      expect(prepareAck2).toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
        },
      });
      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
        },
      });

      await vi.waitFor(() => {
        expect(importSessionBundle).toHaveBeenCalledTimes(1);
      });

      const persisted = await prepareJobStore.read(jobId);
      expect(persisted?.status.status).toBe('pending');
      expect(persisted?.lastErrorMessage).toBeUndefined();

      continueImportSession.resolve();

      await vi.waitFor(async () => {
        await expect(resultGet!({ handoffId })).resolves.toMatchObject({
          handoffId,
          status: {
            handoffId,
            status: 'ready_for_cutover',
            phase: 'staging_target',
          },
          remoteSessionId: 'claude_session_target',
        });
      });
    } finally {
      vi.resetModules();
      await removeTestDirectory(activeServerDir);
      await removeTestDirectory(targetPath);
    }
  });

  it('restarts a persisted non-terminal prepare-target job when callers keep polling result-get after daemon restart (no hanging pending job requiring a second PREPARE_TARGET call)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-resume-from-result-get-'));
    const targetPath = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-resume-from-result-get-target-'));

    const continueImportSession = createDeferred<void>();

    try {
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return {
          ...actual,
          configuration: {
            ...(actual.configuration as any),
            activeServerDir,
          },
        };
      });

      const { createSessionHandoffPrepareTargetJobStore } = await import(
        '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
      );
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const nowMs = Date.now();
      const handoffId = 'handoff_result_get_restart_1';
      const jobId = 'prepare_result_get_restart_1';

      // Simulate a daemon crash: the prepare-target durable record exists, but there is no in-memory runner.
      await prepareJobStore.write({
        jobId,
        handoffId,
        createdAtMs: nowMs - 60_000,
        updatedAtMs: nowMs - 60_000,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          transportStrategy: 'direct_peer',
          progress: {
            updatedAtMs: nowMs - 60_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
          recoveryActions: [],
        },
        // Persist enough input to restart the job when only result-get/status polling continues.
        prepareTargetRequest: {
          handoffId,
          sourceMachineId: 'machine_source',
          targetMachineId: 'machine_target',
          negotiatedTransportStrategy: 'direct_peer',
          sourceSessionStorageMode: 'persisted',
          targetPath: '/repo',
          endpointCandidates: [],
          handoffMetadataV2: {
            providerBundleTransferPublication: {
              transferId: `session-handoff:${handoffId}:provider-bundle`,
              sizeBytes: 123,
              manifestHash: 'hash',
              endpointCandidates: [
                { kind: 'http', url: 'http://127.0.0.1:1111', expiresAt: Date.now() + 60_000, authorizationToken: 'tok' },
              ],
            },
          },
        },
      });

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');

      const registered = new Map<string, (params: unknown) => Promise<any>>();

      const directPeerTransfer = {
        publishTransfer: () => [],
        requestPayloadFile: async (input: Readonly<{
          transferId: string;
          endpointCandidates: readonly unknown[];
          destinationPath: string;
        }>) => {
          await writeFile(input.destinationPath, JSON.stringify({
            providerId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          }));
          return { destinationPath: input.destinationPath };
        },
        clearPublishedTransfer: () => undefined,
      };

      const importSessionBundle = vi.fn(async () => {
        await continueImportSession.promise;
        return {
          remoteSessionId: 'claude_session_target',
          directSource: {
            kind: 'claudeConfig' as const,
            configDir: null,
            projectId: null,
          },
          resume: {
            directory: targetPath,
            agent: 'claude' as const,
            resume: 'claude_session_target',
            transcriptStorage: 'persisted' as const,
            approvedNewDirectoryCreation: true as const,
          },
        };
      });

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
        directPeerTransfer: directPeerTransfer as any,
        importSessionBundle,
      });

      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      expect(resultGet).toBeDefined();
      expect(statusGet).toBeDefined();

      await expect(resultGet!({ handoffId })).resolves.toMatchObject({ ok: false, errorCode: 'not_found' });

      await vi.waitFor(() => {
        expect(importSessionBundle).toHaveBeenCalledTimes(1);
      });

      continueImportSession.resolve();

      await vi.waitFor(async () => {
        await expect(statusGet!({ handoffId })).resolves.toMatchObject({
          handoffId,
          status: { handoffId, status: 'ready_for_cutover' },
        });
      });
    } finally {
      vi.resetModules();
      await removeTestDirectory(activeServerDir);
      await removeTestDirectory(targetPath);
    }
  });

  it('returns awaiting_recovery instead of pending when a persisted prepare-target job has already been marked stranded after daemon restart', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-stranded-restart-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return {
          ...actual,
          configuration: {
            ...(actual.configuration as any),
            activeServerDir,
          },
        };
      });

      const { createSessionHandoffPrepareTargetJobStore } = await import(
        '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
      );
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const handoffId = 'handoff_stranded_restart_1';
      const jobId = 'prepare_stranded_restart_1';
      const nowMs = Date.now();
      await prepareJobStore.write({
        jobId,
        handoffId,
        createdAtMs: nowMs - 10_000,
        updatedAtMs: nowMs - 10_000,
        status: {
          handoffId,
          jobId,
          status: 'awaiting_recovery',
          phase: 'staging_target',
          transportStrategy: 'direct_peer',
          progress: {
            updatedAtMs: nowMs - 10_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'daemon_restart_missing_runner',
            },
            resumable: false,
          },
          recoveryActions: [],
        },
      });

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');
      const registered = new Map<string, (params: unknown) => Promise<any>>();
      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
      });

      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      expect(prepare).toBeDefined();

      await expect(prepare!({
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        handoffMetadataV2: {
          providerBundleTransferPublication: {
            transferId: 'session-handoff:handoff_stranded_restart_1:provider-bundle',
            sizeBytes: 123,
            manifestHash: 'hash',
            endpointCandidates: [
              { kind: 'http', url: 'http://127.0.0.1:1111', expiresAt: Date.now() + 60_000, authorizationToken: 'tok' },
            ],
          },
        },
      })).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'awaiting_recovery',
          phase: 'staging_target',
          progress: {
            current: {
              phaseDetail: 'daemon_restart_missing_runner',
            },
          },
        },
      });
    } finally {
      vi.resetModules();
      await removeTestDirectory(activeServerDir);
    }
  });

  it('restarts a persisted non-terminal prepare-target job when the current daemon lease is present but the runner marker is missing', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-missing-runner-'));
    const targetPath = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-missing-runner-target-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return {
          ...actual,
          configuration: {
            ...(actual.configuration as any),
            activeServerDir,
          },
        };
      });

      const { createSessionHandoffPrepareTargetJobStore } = await import(
        '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
      );
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const nowMs = Date.now();
      const handoffId = 'handoff_missing_runner_1';
      const jobId = 'prepare_missing_runner_1';
      const leasePath = join(
        activeServerDir,
        'session-handoff',
        'prepare-target-jobs-staging',
        jobId,
        'lease',
        'lease.json',
      );
      await mkdir(join(
        activeServerDir,
        'session-handoff',
        'prepare-target-jobs-staging',
        jobId,
        'lease',
      ), { recursive: true });
      await writeFile(leasePath, JSON.stringify({
        ownerId: `cli-daemon:${process.pid}:current`,
        acquiredAtMs: nowMs - 1000,
        renewedAtMs: nowMs - 1000,
        expiresAtMs: nowMs + 60 * 60 * 1000,
      }));

      await prepareJobStore.write({
        jobId,
        handoffId,
        createdAtMs: nowMs - 10_000,
        updatedAtMs: nowMs - 5_000,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          transportStrategy: 'direct_peer',
          progress: {
            updatedAtMs: nowMs - 5_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
          recoveryActions: [],
        },
      });

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const continueImportSession = createDeferred<void>();
      const importSessionBundle = vi.fn(async () => {
        await continueImportSession.promise;
        return {
          remoteSessionId: 'claude_session_target',
          directSource: {
            kind: 'claudeConfig' as const,
            configDir: null,
            projectId: null,
          },
          resume: {
            directory: targetPath,
            agent: 'claude' as const,
            resume: 'claude_session_target',
            transcriptStorage: 'persisted' as const,
            approvedNewDirectoryCreation: true as const,
          },
        };
      });

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
        directPeerTransfer: {
          publishTransfer: () => [],
          requestPayloadFile: async (input: Readonly<{
            transferId: string;
            endpointCandidates: readonly unknown[];
            destinationPath: string;
          }>) => {
            await writeFile(input.destinationPath, JSON.stringify({
              providerId: 'claude',
              remoteSessionId: 'claude_session_source',
              transcriptBase64: 'e30K',
            }));
            return { destinationPath: input.destinationPath };
          },
          clearPublishedTransfer: () => undefined,
        } as any,
        importSessionBundle,
      });

      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      expect(prepare).toBeDefined();
      expect(resultGet).toBeDefined();

      const preparePayload = {
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        handoffMetadataV2: {
          providerBundleTransferPublication: {
            transferId: 'session-handoff:handoff_missing_runner_1:provider-bundle',
            sizeBytes: 123,
            manifestHash: 'hash',
            endpointCandidates: [
              { kind: 'http', url: 'http://127.0.0.1:1111', expiresAt: Date.now() + 60_000, authorizationToken: 'tok' },
            ],
          },
        },
      } as const;

      await expect(prepare!(preparePayload)).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          progress: {
            current: {
              phaseDetail: 'resuming_after_restart',
            },
          },
        },
      });
      await vi.waitFor(() => {
        expect(importSessionBundle).toHaveBeenCalledTimes(1);
      });
      continueImportSession.resolve();

      await vi.waitFor(async () => {
        await expect(resultGet!({ handoffId })).resolves.toMatchObject({
          handoffId,
          status: {
            handoffId,
            status: 'ready_for_cutover',
            phase: 'staging_target',
          },
          remoteSessionId: 'claude_session_target',
        });
      });
    } finally {
      vi.resetModules();
      await removeTestDirectory(activeServerDir);
      await removeTestDirectory(targetPath);
    }
  });

  it('marks a stranded pending prepare-target job awaiting_recovery on status_get after daemon restart', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-status-recovery-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return {
          ...actual,
          configuration: {
            ...(actual.configuration as any),
            activeServerDir,
          },
        };
      });

      const { createSessionHandoffPrepareTargetJobStore } = await import(
        '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
      );
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const handoffId = 'handoff_status_recovery_1';
      const jobId = 'prepare_status_recovery_1';
      await prepareJobStore.write({
        jobId,
        handoffId,
        createdAtMs: Date.now() - 10_000,
        updatedAtMs: Date.now() - 5_000,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          transportStrategy: 'direct_peer',
          progress: {
            updatedAtMs: Date.now() - 5_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
          recoveryActions: [],
        },
      });

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');
      const registered = new Map<string, (params: unknown) => Promise<any>>();

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
      });

      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      expect(statusGet).toBeDefined();
      expect(resultGet).toBeDefined();

      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'awaiting_recovery',
          phase: 'staging_target',
          progress: {
            current: {
              phaseDetail: 'daemon_restart_missing_runner',
            },
          },
        },
      });
      await expect(resultGet!({ handoffId })).resolves.toMatchObject({
        ok: false,
        errorCode: 'awaiting_recovery',
      });
    } finally {
      vi.resetModules();
      await removeTestDirectory(activeServerDir);
    }
  });

  it('marks a stranded in_progress prepare-target job awaiting_recovery on status_get after daemon restart', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-status-recovery-in-progress-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return {
          ...actual,
          configuration: {
            ...(actual.configuration as any),
            activeServerDir,
          },
        };
      });

      const { createSessionHandoffPrepareTargetJobStore } = await import(
        '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore'
      );
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const handoffId = 'handoff_status_recovery_in_progress_1';
      const jobId = 'prepare_status_recovery_in_progress_1';
      const nowMs = Date.now();
      await prepareJobStore.write({
        jobId,
        handoffId,
        createdAtMs: nowMs - 15_000,
        updatedAtMs: nowMs - 10_000,
        status: {
          handoffId,
          jobId,
          status: 'in_progress',
          phase: 'staging_target',
          transportStrategy: 'direct_peer',
          progress: {
            updatedAtMs: nowMs - 10_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
          recoveryActions: [],
        },
      });

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');
      const registered = new Map<string, (params: unknown) => Promise<any>>();

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
      });

      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      expect(statusGet).toBeDefined();
      expect(resultGet).toBeDefined();

      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId,
          status: 'awaiting_recovery',
          phase: 'staging_target',
          progress: {
            current: {
              phaseDetail: 'daemon_restart_missing_runner',
            },
          },
        },
      });
      await expect(resultGet!({ handoffId })).resolves.toMatchObject({
        ok: false,
        errorCode: 'awaiting_recovery',
      });
    } finally {
      vi.resetModules();
      await removeTestDirectory(activeServerDir);
    }
  });

  it('returns a prepare ack with a durable job id and exposes the final result through result-get', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-job-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
        },
      }));

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const continueImportSession = createDeferred<void>();
      const importSessionBundle = vi.fn(async () => {
        await continueImportSession.promise;
        return {
        remoteSessionId: 'claude_session_target',
        directSource: {
          kind: 'claudeConfig' as const,
          configDir: null,
          projectId: null,
        },
        resume: {
          directory: '/repo-copy',
          agent: 'claude' as const,
          resume: 'claude_session_target',
          transcriptStorage: 'persisted' as const,
          approvedNewDirectoryCreation: true as const,
        },
        };
      });

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: '/repo',
          flavor: 'claude',
          claudeSessionId: 'claude_session_source',
        }),
        exportSessionBundle: async () => ({
          providerBundle: {
            providerId: 'claude' as const,
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: '/repo',
        }),
        importSessionBundle,
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);

      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(statusGet).toBeDefined();
      expect(resultGet).toBeDefined();

      const started = await start!({
        sessionId: 'sess_async_prepare',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
      });

      const handoffId = started.handoffId;
      const prepareAck = await prepare!({
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'server_routed_stream',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
      });

      expect(prepareAck).toMatchObject({
        handoffId,
        status: {
          handoffId,
          status: 'pending',
          phase: 'staging_target',
          jobId: expect.any(String),
        },
      });
      expect(prepareAck.remoteSessionId).toBeUndefined();
      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          status: 'pending',
          phase: 'staging_target',
          jobId: prepareAck.status.jobId,
        },
      });
      await expect(resultGet!({ handoffId })).resolves.toMatchObject({ ok: false, errorCode: 'not_found' });

      continueImportSession.resolve();

      await vi.waitFor(async () => {
        await expect(resultGet!({ handoffId })).resolves.toMatchObject({
          handoffId,
          status: {
            handoffId,
            status: 'ready_for_cutover',
            phase: 'staging_target',
            jobId: prepareAck.status.jobId,
            transportStrategy: 'server_routed_stream',
          },
          remoteSessionId: 'claude_session_target',
          resume: {
            directory: '/repo-copy',
            agent: 'claude',
            resume: 'claude_session_target',
          },
        });
      });
      expect(importSessionBundle).toHaveBeenCalledTimes(1);
    } finally {
      vi.resetModules();
      await removeTestDirectory(activeServerDir);
    }
  });

  it('aborts a pending prepare job before session import when cancellation is requested mid-flight', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-abort-'));
    const targetRoot = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-abort-target-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
        },
      }));

      const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const continueImportSession = createDeferred<void>();
      const importSessionBundle = vi.fn(async () => {
        await continueImportSession.promise;
        return {
        remoteSessionId: 'claude_session_target',
        directSource: {
          kind: 'claudeConfig' as const,
          configDir: null,
          projectId: null,
        },
        resume: {
          directory: '/repo-copy',
          agent: 'claude' as const,
          resume: 'claude_session_target',
          transcriptStorage: 'persisted' as const,
          approvedNewDirectoryCreation: true as const,
        },
        };
      });

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: '/repo',
          flavor: 'claude',
          claudeSessionId: 'claude_session_source',
        }),
        exportSessionBundle: async () => ({
          providerBundle: {
            providerId: 'claude' as const,
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: '/repo',
        }),
        importSessionBundle,
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const abort = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);

      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(abort).toBeDefined();
      expect(statusGet).toBeDefined();
      expect(resultGet).toBeDefined();

      const started = await start!({
        sessionId: 'sess_async_prepare_abort',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
      });

      const handoffId = started.handoffId;
      const prepareAck = await prepare!({
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'server_routed_stream',
        sourceSessionStorageMode: 'persisted',
        targetPath: targetRoot,
      });

      expect(prepareAck).toMatchObject({
        handoffId,
        status: {
          handoffId,
          status: 'pending',
          phase: 'staging_target',
          jobId: expect.any(String),
        },
      });

      await expect(abort!({
        handoffId,
        reason: 'user_cancelled',
      })).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          status: 'aborted',
          jobId: prepareAck.status.jobId,
        },
      });

      continueImportSession.resolve();

      await vi.waitFor(async () => {
        await expect(statusGet!({ handoffId })).resolves.toMatchObject({
          handoffId,
          status: {
            handoffId,
            status: 'aborted',
            jobId: prepareAck.status.jobId,
          },
        });
      });
      await expect(resultGet!({ handoffId })).resolves.toMatchObject({ ok: false, errorCode: 'aborted' });
    } finally {
      vi.resetModules();
      await removeTestDirectory(activeServerDir).catch(() => undefined);
      await removeTestDirectory(targetRoot).catch(() => undefined);
    }
  });
});
