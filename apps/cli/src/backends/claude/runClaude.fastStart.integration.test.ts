import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Credentials } from '@/persistence';
import { configuration } from '@/configuration';
import type { registerRunnerTerminationHandlers as registerRunnerTerminationHandlersFn } from '@/agent/runtime/runnerTerminationHandlers';
import type { RunnerTerminationEvent, RunnerTerminationOutcome } from '@/agent/runtime/runnerTerminationOutcome';
import type { AgentModelDescriptor } from '@happier-dev/agents';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

const localPermissionBridgeMockState = vi.hoisted(() => ({ events: [] as string[] }));
const agentStateUpdateSnapshots = vi.hoisted(() => [] as Array<{
  reason: string;
  state: any;
}>);

vi.mock('@/backends/claude/localPermissions/localPermissionBridge', () => ({
  DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE: {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: { hookEventName: 'PermissionRequest' },
  },
  ClaudeLocalPermissionBridge: class ClaudeLocalPermissionBridge {
    activate() {}
    handleSessionHook() {}
    async handlePermissionHook() {
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: { hookEventName: 'PermissionRequest' },
      };
    }
    dispose() {
      localPermissionBridgeMockState.events.push('dispose');
    }
  },
}));

function createDeferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | null = null;
  let rejectFn: ((error: unknown) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: (value: T) => resolveFn?.(value),
    reject: (error: unknown) => rejectFn?.(error),
  };
}

function createLegacyCredentials(): Credentials {
  return {
    token: 'test',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(7),
    },
  };
}

async function waitFor<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

let loopStarted: Deferred<void> = createDeferred<void>();
let loopEntered: Deferred<void> = createDeferred<void>();
let loopExit: Deferred<number> = createDeferred<number>();
let lastLoopOpts: any = null;
let autoSessionReady = true;
let awaitAutoSessionReadyCallback = false;
let beforeLoopCapture: Promise<void> | null = null;
let lastTerminationHandlerParams: Parameters<typeof registerRunnerTerminationHandlersFn>[0] | null = null;
let readSettingsCalls = 0;
let initializeBackendApiContextCalls = 0;
const startHappyServerSpy = vi.fn(async (_client: any) => ({
  url: 'http://127.0.0.1:1234',
  toolNames: [],
  stop: vi.fn(),
}));
const persistTerminalAttachmentInfoIfNeededSpy = vi.fn<(info: { sessionId: string }) => Promise<void>>(async () => {});
const reportSessionToDaemonIfRunningSpy = vi.fn<
  typeof import('@/agent/runtime/startupSideEffects').reportSessionToDaemonIfRunning
>(async () => {});
const refreshRetainedClaudeHookPluginSpy = vi.fn(() => {});

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to reserve test port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

vi.mock('@/persistence', () => ({
  readSettings: vi.fn(async () => {
    readSettingsCalls += 1;
    return { machineId: 'machine_1' };
  }),
}));

vi.mock('@/backends/claude/loop', () => ({
  loop: vi.fn(async (opts: any) => {
    const invocationLoopEntered = loopEntered;
    const invocationLoopStarted = loopStarted;
    const invocationLoopExit = loopExit;
    const invocationAutoSessionReady = autoSessionReady;
    const invocationAwaitAutoSessionReadyCallback = awaitAutoSessionReadyCallback;
    const invocationBeforeLoopCapture = beforeLoopCapture;
    loopCalls += 1;
    lastLoopOpts = opts;
    invocationLoopEntered.resolve();
    if (invocationBeforeLoopCapture) await invocationBeforeLoopCapture;
    if (invocationAutoSessionReady) {
      const sessionReady = opts?.onSessionReady?.({
        cleanup: vi.fn(),
        drainCriticalMetadataWrites: vi.fn(async () => {}),
        ensureMetadataSnapshot: vi.fn(async () => ({})),
        updateMetadata: vi.fn(async () => {}),
        setPushSender: vi.fn(),
        client: {
          getMetadataSnapshot: vi.fn(() => ({})),
        },
        getOrCreatePermissionRpcRouter: () => ({ registerConsumer: vi.fn() }),
      });
      if (invocationAwaitAutoSessionReadyCallback) {
        await sessionReady;
      }
    }
    invocationLoopStarted.resolve();
    return await invocationLoopExit.promise;
  }),
}));

let initResolved = false;
let backendInitDelayMs = 200;
const getOrCreateSessionSpy = vi.fn(async () => ({ id: 'sess_1', metadataVersion: 1 }));
const sendSessionEventSpy = vi.fn();
let lastRuntimeSessionClient: {
  rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn>; invokeLocal: ReturnType<typeof vi.fn> };
  setSessionRuntimeControls: ReturnType<typeof vi.fn>;
  registerSessionRuntimeControls: ReturnType<typeof vi.fn>;
  keepAlive: ReturnType<typeof vi.fn>;
  sendSessionDeath: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} | null = null;
function getLastRuntimeSessionClient(): typeof lastRuntimeSessionClient {
  return lastRuntimeSessionClient;
}
let startHookServerCalls = 0;
let lastStartHookServerOptions: any = null;
let generateHookSettingsCalls = 0;
let resolveRunnerMcpServersCalls = 0;
let lastResolveRunnerMcpServersParams: any = null;
let resolveEffectiveCodingPromptCalls = 0;
let loopCalls = 0;
const sessionSyncClientSpy = vi.fn((resp: any) => {
  const client = {
    sessionId: resp?.id ?? 'sess_1',
    rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn() },
    setSessionRuntimeControls: vi.fn(),
    registerSessionRuntimeControls: vi.fn(() => vi.fn()),
    keepAlive: vi.fn(),
    ensureMetadataSnapshot: vi.fn(async () => ({})),
    getMetadataSnapshot: vi.fn(() => ({})),
    onUserMessage: vi.fn(),
    sendSessionEvent: sendSessionEventSpy,
    updateMetadata: vi.fn(),
    updateAgentState: vi.fn(),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  lastRuntimeSessionClient = client;
  return client;
});
vi.mock('@/agent/runtime/initializeBackendApiContext', () => ({
  initializeBackendApiContext: vi.fn(async () => {
    initializeBackendApiContextCalls += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, backendInitDelayMs));
    initResolved = true;
    return {
      api: {
        getOrCreateSession: getOrCreateSessionSpy,
        sessionSyncClient: sessionSyncClientSpy,
        push: vi.fn(() => ({ sendToAllDevices: vi.fn() })),
      },
      machineId: 'machine_1',
    };
  }),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    infoDeveloper: vi.fn(),
    warn: vi.fn(),
    getLogPath: vi.fn(() => '/tmp/happier.log'),
    logFilePath: '/tmp/happier.log',
  },
}));

vi.mock('@/ui/doctor', () => ({
  getEnvironmentInfo: vi.fn(() => ({})),
}));

vi.mock('@/mcp/startHappyServer', () => ({
  startHappyServer: startHappyServerSpy,
}));

vi.mock('@/backends/claude/utils/startHookServer', () => ({
  startHookServer: vi.fn(async (options: any) => {
    startHookServerCalls += 1;
    lastStartHookServerOptions = options;
    return { port: 12345, stop: vi.fn() };
  }),
}));

vi.mock('@/backends/claude/utils/generateHookSettings', () => ({
  generateHookSettingsFile: vi.fn(() => '/tmp/happier-hooks.json'),
  cleanupHookSettingsFile: vi.fn(),
  cleanupHookPluginDir: vi.fn(),
  refreshRetainedClaudeHookPlugin: refreshRetainedClaudeHookPluginSpy,
}));

vi.mock('@/backends/claude/utils/generateHookSettingsFileWithEnsuredRuntime', () => ({
  generateHookSettingsFileWithEnsuredRuntime: vi.fn(async () => {
    generateHookSettingsCalls += 1;
    return '/tmp/happier-hooks.json';
  }),
  generateHookPluginDirWithEnsuredRuntime: vi.fn(async () => null),
}));

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
  ensureJavaScriptRuntimeExecutable: vi.fn(async () => '/managed/js-runtime'),
}));

vi.mock('@/mcp/runtime/resolveRunnerMcpServers', () => ({
  resolveRunnerMcpServers: vi.fn(async (params: any) => {
    resolveRunnerMcpServersCalls += 1;
    lastResolveRunnerMcpServersParams = params;
    const happierMcpServer = await startHappyServerSpy(params.session as any);
    return {
      mcpServers: {
        happier: {
          command: '/managed/js-runtime',
          args: ['--mcp'],
          env: {},
        },
      },
      happierMcpServer,
    };
  }),
}));

vi.mock('@/agent/prompting/coding/resolveEffectiveCodingPrompt', () => ({
  resolveEffectiveCodingPromptText: vi.fn(async () => {
    resolveEffectiveCodingPromptCalls += 1;
    return '';
  }),
}));

vi.mock('@/features/featureDecisionService', () => ({
  resolveCliFeatureDecision: vi.fn(() => ({ state: 'disabled' })),
}));

vi.mock('@/integrations/caffeinate', () => ({
  startCaffeinate: vi.fn(() => false),
  stopCaffeinate: vi.fn(),
}));

vi.mock('@/rpc/handlers/killSession', () => ({
  registerKillSessionHandler: vi.fn(),
}));

vi.mock('@/agent/runtime/startupSideEffects', () => ({
  primeAgentStateForUi: vi.fn(),
  persistTerminalAttachmentInfoIfNeeded: persistTerminalAttachmentInfoIfNeededSpy,
  reportSessionToDaemonIfRunning: reportSessionToDaemonIfRunningSpy,
  sendTerminalFallbackMessageIfNeeded: vi.fn(),
}));

vi.mock('@/agent/runtime/startupMetadataUpdate', () => ({
  applyStartupMetadataUpdateToSession: vi.fn(),
  buildAcpSessionModeOverride: vi.fn(() => null),
  buildModelOverride: vi.fn(() => null),
  buildPermissionModeOverride: vi.fn(() => null),
}));

vi.mock('@/agent/runtime/permission/startupPermissionModeSeed', () => ({
  resolveStartupPermissionModeFromSession: vi.fn(async () => null),
}));

vi.mock('@/agent/runtime/runnerTerminationOutcome', () => ({
  computeRunnerTerminationOutcome: vi.fn(() => ({ kind: 'exit', code: 0 })),
}));

vi.mock('@/backends/claude/sdk/metadataExtractor', () => ({
  extractSDKMetadataAsync: vi.fn(),
}));

type OfflineReconnectionConfig<TSession> = {
  serverUrl: string;
  onReconnected: () => Promise<TSession>;
  onNotify: (message: string) => void;
  onCleanup?: () => void;
  healthCheck?: () => Promise<void>;
  initialDelayMs?: number;
  backoffDelayMs?: (failureCount: number) => number;
};

let lastOfflineReconnectionConfig: OfflineReconnectionConfig<any> | null = null;
const startOfflineReconnectionSpy = vi.fn((config: OfflineReconnectionConfig<any>) => {
  lastOfflineReconnectionConfig = config;
  return { cancel: vi.fn(), getSession: () => null, isReconnected: () => false };
});
vi.mock('@/api/offline/serverConnectionErrors', () => ({
  connectionState: { setBackend: vi.fn(), notifyOffline: vi.fn(), recover: vi.fn() },
  startOfflineReconnection: startOfflineReconnectionSpy,
}));

vi.mock('@/agent/runtime/runnerTerminationHandlers', () => ({
  registerRunnerTerminationHandlers: vi.fn((params: Parameters<typeof registerRunnerTerminationHandlersFn>[0]) => {
    lastTerminationHandlerParams = params;
    return {
      requestTermination: vi.fn(),
      whenTerminated: Promise.resolve(),
      dispose: vi.fn(),
    };
  }),
}));

vi.mock('@/api/session/sessionWritesBestEffort', () => ({
  updateAgentStateBestEffort: vi.fn((_session, updater, _logPrefix, reason) => {
    agentStateUpdateSnapshots.push({ reason, state: updater({}) });
  }),
  updateMetadataBestEffort: vi.fn(),
}));

describe('runClaude fast-start', () => {
  const loopStartWaitMs = 30_000;
  const prevTiming = process.env.HAPPIER_STARTUP_TIMING_ENABLED;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    void code;
    return undefined as never;
  }) as any);

  beforeAll(async () => {
    process.env.HAPPIER_STARTUP_TIMING_ENABLED = '1';
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  afterAll(async () => {
    if (prevTiming === undefined) delete process.env.HAPPIER_STARTUP_TIMING_ENABLED;
    else process.env.HAPPIER_STARTUP_TIMING_ENABLED = prevTiming;
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    exitSpy.mockRestore();
  });

  async function assertUnifiedHookIdentityRouting(branch: 'regular' | 'fast-start'): Promise<void> {
    vi.resetModules();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    lastStartHookServerOptions = null;
    autoSessionReady = false;
    initResolved = false;
    backendInitDelayMs = 0;
    getOrCreateSessionSpy.mockImplementation(async () => (
      branch === 'regular'
        ? { id: 'sess_hook_routing', metadataVersion: 1 }
        : null as any
    ));

    const { runClaude } = await import('./runClaude');
    const onSessionFound = vi.fn<(sessionId: string, data?: unknown) => void>();
    const onClaudeSessionHook = vi.fn();
    const sessionStub: any = {
      sessionId: null,
      cleanup: vi.fn(),
      drainCriticalMetadataWrites: vi.fn(async () => {}),
      setPushSender: vi.fn(),
      onSessionFound,
      onClaudeSessionHook,
      client: { getMetadataSnapshot: vi.fn(() => ({})) },
      getOrCreatePermissionRpcRouter: () => ({ registerConsumer: vi.fn() }),
    };

    let testError: unknown = null;
    const runPromise = runClaude(createLegacyCredentials(), {
      startedBy: 'terminal',
      startingMode: 'local',
      claudeRemoteMetaDefaults: { claudeUnifiedTerminalEnabled: true },
    }).catch((error) => {
      testError = error;
      loopStarted.resolve();
    });

    try {
      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();
      if (testError) throw testError;
      lastLoopOpts?.onSessionReady?.(sessionStub);

      const sessionId = '31313131-3131-4131-8131-313131313131';
      const transcriptPath = `/tmp/${sessionId}.jsonl`;
      const onSessionHook = lastStartHookServerOptions?.onSessionHook;
      expect(onSessionHook).toBeTypeOf('function');
      if (typeof onSessionHook !== 'function') throw new Error('Claude hook server callback was not registered');

      onSessionHook(sessionId, {
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: sessionId,
        transcript_path: transcriptPath,
      });

      onSessionHook('mismatched-user-prompt-session', {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'mismatched-user-prompt-session',
      });
      onSessionHook(sessionId, {
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
      });
      onSessionHook('mismatched-stop-session', {
        hook_event_name: 'Stop',
        session_id: 'mismatched-stop-session',
      });
      onSessionHook('sidechain-session', {
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: 'sidechain-session',
        transcript_path: '/tmp/sidechain-session.jsonl',
        agent_id: 'subagent-1',
      });
      // Unified identity belongs to the subscribed transcript/runtime owner, which can validate
      // explicit resume identity before persisting it. The global hook ingress only publishes.
      expect(onSessionFound).not.toHaveBeenCalled();
      expect(onClaudeSessionHook).toHaveBeenCalledTimes(5);
      expect(onClaudeSessionHook.mock.calls.map(([data]) => data.hook_event_name)).toEqual([
        'SessionStart',
        'UserPromptSubmit',
        'PostToolUse',
        'Stop',
        'SessionStart',
      ]);
    } finally {
      loopExit.resolve(0);
      await runPromise;
      autoSessionReady = true;
      getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));
    }

    if (testError) throw testError;
  }

  it('routes regular Unified hooks through the guarded bridge before changing Claude identity', async () => {
    await assertUnifiedHookIdentityRouting('regular');
  });

  it('routes fast-start Unified hooks through the guarded bridge before changing Claude identity', async () => {
    await assertUnifiedHookIdentityRouting('fast-start');
  });

  it('invokes vendor spawn without waiting for backend API initialization', async () => {
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    autoSessionReady = true;
    initResolved = false;
    backendInitDelayMs = 200;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));
    startOfflineReconnectionSpy.mockClear();
    lastOfflineReconnectionConfig = null;

    const { runClaude } = await import('./runClaude');

    const credentials = createLegacyCredentials();

    let testError: unknown = null;
    const runPromise = runClaude(credentials, { startedBy: 'terminal', startingMode: 'local' }).catch((e) => {
      testError = e;
      loopStarted.resolve();
    });

    try {
      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();
      if (testError) {
        throw testError;
      }
      expect(initResolved).toBe(false);
      expect(lastLoopOpts?.precomputedMcpBridge?.mcpServers).toBeTruthy();
      expect(Object.keys(lastLoopOpts?.precomputedMcpBridge?.mcpServers ?? {})).toContain('happier');
      expect(lastLoopOpts?.runtimeActivityContributions).toEqual({
        activateProviderTasks: expect.any(Function),
      });

		      const { startHappyServer } = await import('@/mcp/startHappyServer');
	      expect(startHappyServer).toHaveBeenCalled();
	    } catch (e) {
	      testError = new Error(
	        `${e instanceof Error ? e.message : String(e)} | calls: readSettings=${readSettingsCalls}, initializeBackendApiContext=${initializeBackendApiContextCalls}, startHookServer=${startHookServerCalls}, generateHookSettings=${generateHookSettingsCalls}, resolveRunnerMcpServers=${resolveRunnerMcpServersCalls}, resolveEffectiveCodingPrompt=${resolveEffectiveCodingPromptCalls}, loop=${loopCalls}, initResolved=${initResolved}`,
	      );
	    } finally {
      loopExit.resolve(0);
      await runPromise;
    }

    if (testError) {
      throw testError;
    }
  });

  it('does not complete true fast-start readiness before the selected model effort catalog settles', async () => {
    vi.resetModules();
    const catalogRequested = createDeferred<void>();
    const catalogResult = createDeferred<readonly AgentModelDescriptor[]>();
    vi.doMock('@/backends/claude/models/resolveClaudeModelCatalog', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/backends/claude/models/resolveClaudeModelCatalog')>();
      return {
        ...actual,
        resolveClaudeModelCatalog: vi.fn(() => {
          catalogRequested.resolve();
          return catalogResult.promise;
        }),
      };
    });
    vi.doMock('@/backends/claude/sessionControls/publishClaudeSessionModelsMetadataBestEffort', () => ({
      publishClaudeSessionModelsMetadataBestEffort: vi.fn(async () => {}),
    }));

    loopEntered = createDeferred<void>();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    autoSessionReady = true;
    awaitAutoSessionReadyCallback = true;
    initResolved = false;
    backendInitDelayMs = 200;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_effort_ready', metadataVersion: 1 }));
    reportSessionToDaemonIfRunningSpy.mockClear();

    const { runClaude } = await import('./runClaude');
    let testError: unknown = null;
    const runPromise = runClaude(createLegacyCredentials(), {
      startedBy: 'terminal',
      startingMode: 'local',
      model: 'claude-opus-9',
    }).catch((error) => {
      testError = error;
      loopStarted.resolve();
    });

    try {
      await waitFor(catalogRequested.promise, loopStartWaitMs);
      let readinessCompleted = false;
      void loopStarted.promise.then(() => { readinessCompleted = true; });
      await Promise.resolve();
      expect(readinessCompleted).toBe(false);
      expect(initResolved).toBe(false);

      catalogResult.resolve([{ id: 'claude-opus-9', displayName: 'Opus 9' }]);
      await waitFor(loopStarted.promise, loopStartWaitMs);
      if (testError) throw testError;
      expect(initResolved).toBe(false);
      expect(lastLoopOpts?.initialClaudeUnifiedTerminalMode).toMatchObject({
        model: 'claude-opus-9',
        modelEffortLevelsModelId: 'claude-opus-9',
      });
    } finally {
      catalogResult.resolve([]);
      loopExit.resolve(0);
      await runPromise;
      vi.doUnmock('@/backends/claude/models/resolveClaudeModelCatalog');
      vi.doUnmock('@/backends/claude/sessionControls/publishClaudeSessionModelsMetadataBestEffort');
      autoSessionReady = true;
      awaitAutoSessionReadyCallback = false;
      getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));
    }

    if (testError) throw testError;
  });

  it('uses a persisted model override for the initial fast-start mode and tier identity', async () => {
    vi.resetModules();
    const overrideSynced = createDeferred<void>();
    vi.doMock('@/agent/runtime/runtimeOverridesSynchronizer', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/agent/runtime/runtimeOverridesSynchronizer')>();
      return {
        ...actual,
        initializeRuntimeOverridesSynchronizer: async (
          params: Parameters<typeof actual.initializeRuntimeOverridesSynchronizer>[0],
        ) => {
          const synchronizer = await actual.initializeRuntimeOverridesSynchronizer(params);
          return {
            ...synchronizer,
            syncFromMetadata: () => {
              synchronizer.syncFromMetadata();
              overrideSynced.resolve();
            },
          };
        },
      };
    });
    vi.doMock('@/backends/claude/sessionControls/publishClaudeSessionModelsMetadataBestEffort', () => ({
      publishClaudeSessionModelsMetadataBestEffort: vi.fn(async () => {}),
    }));

    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    autoSessionReady = true;
    awaitAutoSessionReadyCallback = true;
    initResolved = false;
    backendInitDelayMs = 0;
    beforeLoopCapture = overrideSynced.promise;
    const previousGetOrCreateSessionImpl = getOrCreateSessionSpy.getMockImplementation();
    if (!previousGetOrCreateSessionImpl) throw new Error('expected the session creation test implementation');
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_model_override', metadataVersion: 1 }));

    const persistedMetadata = {
      modelOverrideV1: { v: 1 as const, updatedAt: 77, modelId: 'claude-fable-5' },
    };
    const previousSessionImpl = sessionSyncClientSpy.getMockImplementation();
    if (!previousSessionImpl) throw new Error('expected the session client test implementation');
    sessionSyncClientSpy.mockImplementation((response: unknown) => {
      const client = previousSessionImpl(response);
      return {
        ...client,
        ensureMetadataSnapshot: vi.fn(async () => persistedMetadata),
        getMetadataSnapshot: vi.fn(() => persistedMetadata),
      };
    });

    const { runClaude } = await import('./runClaude');
    let testError: unknown = null;
    const runPromise = runClaude(createLegacyCredentials(), {
      startedBy: 'terminal',
      startingMode: 'local',
      claudeArgs: ['--dangerously-skip-permissions'],
    }).catch((error) => {
      testError = error;
      loopStarted.resolve();
    });

    try {
      await waitFor(overrideSynced.promise, 10_000).catch((error) => {
        throw new Error(`persisted model override did not sync (initResolved=${String(initResolved)}): ${String(error)}`);
      });
      await waitFor(loopStarted.promise, loopStartWaitMs);
      if (testError) throw testError;
      expect(lastLoopOpts?.initialClaudeUnifiedTerminalMode).toMatchObject({
        model: 'claude-fable-5',
        modelEffortLevelsModelId: 'claude-fable-5',
      });
    } finally {
      overrideSynced.resolve();
      loopExit.resolve(0);
      await runPromise;
      sessionSyncClientSpy.mockImplementation(previousSessionImpl);
      vi.doUnmock('@/agent/runtime/runtimeOverridesSynchronizer');
      vi.doUnmock('@/backends/claude/sessionControls/publishClaudeSessionModelsMetadataBestEffort');
      autoSessionReady = true;
      awaitAutoSessionReadyCallback = false;
      beforeLoopCapture = null;
      getOrCreateSessionSpy.mockImplementation(previousGetOrCreateSessionImpl);
    }

    if (testError) throw testError;
  });

  it('installs unavailable group truth before a daemon-started remote Claude producer can dequeue', async () => {
    vi.resetModules();
    reportSessionToDaemonIfRunningSpy.mockClear();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    lastRuntimeSessionClient = null;
    autoSessionReady = false;
    initResolved = false;
    backendInitDelayMs = 0;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_daemon_remote', metadataVersion: 1 }));
    const notificationResults: unknown[] = [];
    reportSessionToDaemonIfRunningSpy.mockImplementation(async () => {
      const controls = getLastRuntimeSessionClient()?.registerSessionRuntimeControls.mock.calls.at(-1)?.[0];
      notificationResults.push(typeof controls?.applyConnectedServiceAuthGeneration === 'function'
        ? await controls.applyConnectedServiceAuthGeneration({
            serviceId: 'claude-subscription',
            reason: 'diagnostic',
            authGeneration: {
              kind: 'current_auth_group_unavailable',
              groupId: 'team',
              unavailableReason: 'group_missing',
            },
          })
        : { ok: false, errorCode: 'unsupported_session_runtime_method' });
    });

    const { runClaude } = await import('./runClaude');
    let testError: unknown = null;
    const runPromise = runClaude(createLegacyCredentials(), {
      startedBy: 'daemon',
      startingMode: 'remote',
    }).catch((error) => {
      testError = error;
      loopStarted.resolve();
    });

    try {
      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();
      if (testError) throw testError;
      expect(notificationResults).toEqual([]);

      const runtimeClient = getLastRuntimeSessionClient();
      if (!runtimeClient) throw new Error('runtime session client was not created');
      const { Session } = await import('./session');
      const { MessageQueue2 } = await import('@/agent/runtime/modeMessageQueue');
      const readySession = new Session({
        client: runtimeClient as any,
        path: '/tmp',
        logPath: '/tmp/happier.log',
        sessionId: null,
        messageQueue: new MessageQueue2(() => 'mode'),
        onModeChange: () => {},
        hookSettingsPath: '/tmp/hooks.json',
      });
      await lastLoopOpts?.onSessionReady?.(readySession);
      expect(notificationResults).toEqual([{ ok: true, appliedVia: 'current_truth_fence' }]);
      expect(reportSessionToDaemonIfRunningSpy).toHaveBeenCalledTimes(1);
      expect(reportSessionToDaemonIfRunningSpy).toHaveBeenLastCalledWith(expect.objectContaining({
        sessionId: 'sess_daemon_remote',
        requireDaemonAck: true,
      }));

      const fence = readySession.connectedServiceAuthGroupRequestFence;
      const abortController = new AbortController();
      let producerReleased = false;
      const producerAdmission = fence.waitUntilAvailable(abortController.signal).then(() => {
        producerReleased = true;
      });
      await Promise.resolve();
      expect(producerReleased).toBe(false);

      const controls = runtimeClient.registerSessionRuntimeControls.mock.calls.at(-1)?.[0];
      await expect(controls.applyConnectedServiceAuthGeneration({
        serviceId: 'claude-subscription',
        reason: 'diagnostic',
        authGeneration: {
          kind: 'current_auth_group_available',
          groupId: 'replacement-team',
          generation: 3,
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        },
      })).resolves.toEqual({ ok: true, appliedVia: 'current_truth_fence' });
      await producerAdmission;
      expect(producerReleased).toBe(true);
      readySession.cleanup();
    } finally {
      loopExit.resolve(0);
      await runPromise;
      reportSessionToDaemonIfRunningSpy.mockImplementation(async () => {});
      autoSessionReady = true;
    }

    if (testError) throw testError;
  });

  describe('terminal non-strict daemon reports', () => {
    const launchObservationWaitMs = 15_000;
    const cleanupWaitMs = 15_000;
    let runClaude: typeof import('./runClaude').runClaude;

    beforeAll(async () => {
      vi.resetModules();
      ({ runClaude } = await import('./runClaude'));
    });

    it.each([
      ['remote', undefined],
      ['unified', { claudeUnifiedTerminalEnabled: true }],
    ] as const)('does not delay a terminal-started %s launcher on non-strict daemon reports', async (
      _label,
      claudeRemoteMetaDefaults,
    ) => {
      loopEntered = createDeferred<void>();
      loopStarted = createDeferred<void>();
      loopExit = createDeferred<number>();
      lastLoopOpts = null;
      autoSessionReady = true;
      awaitAutoSessionReadyCallback = true;
      loopCalls = 0;
      getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_terminal_remote', metadataVersion: 1 }));
      const heldReport = createDeferred<void>();
      const pidPlaceholderReport = createDeferred<void>();
      const firstRealSessionReport = createDeferred<void>();
      let completedReportCount = 0;
      reportSessionToDaemonIfRunningSpy.mockImplementation(async ({ sessionId }) => {
        if (String(sessionId).startsWith('PID-')) {
          pidPlaceholderReport.resolve();
        } else {
          firstRealSessionReport.resolve();
        }
        await heldReport.promise;
        completedReportCount += 1;
      });

      const runOutcome = runClaude(createLegacyCredentials(), {
        startedBy: 'terminal',
        startingMode: 'remote',
        ...(claudeRemoteMetaDefaults ? { claudeRemoteMetaDefaults } : {}),
      }).then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      let failure: unknown = null;
      let finalOutcome: Awaited<typeof runOutcome> | null = null;

      try {
        const launchObserved = Promise.all([
          pidPlaceholderReport.promise,
          loopEntered.promise,
          firstRealSessionReport.promise,
        ]).then(() => undefined);
        const runEndedBeforeLaunchObservation = runOutcome.then((outcome) => {
          if (outcome.status === 'rejected') throw outcome.error;
          throw new Error('runClaude completed before the launcher and daemon reports were observed');
        });
        await waitFor(
          Promise.race([launchObserved, runEndedBeforeLaunchObservation]),
          launchObservationWaitMs,
        );
        expect(completedReportCount).toBe(0);
      } catch (error) {
        failure = error;
      } finally {
        heldReport.resolve();
        loopExit.resolve(0);
        try {
          finalOutcome = await waitFor(runOutcome, cleanupWaitMs);
        } catch (cleanupError) {
          failure ??= cleanupError;
        } finally {
          reportSessionToDaemonIfRunningSpy.mockImplementation(async () => {});
          awaitAutoSessionReadyCallback = false;
        }
      }

      if (finalOutcome?.status === 'rejected') {
        failure ??= finalOutcome.error;
      }
      if (failure) throw failure;
    });
  });

  it('keeps a daemon-started remote launcher blocked until strict readiness acknowledgement', async () => {
    vi.resetModules();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    autoSessionReady = true;
    awaitAutoSessionReadyCallback = true;
    loopCalls = 0;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_daemon_strict', metadataVersion: 1 }));
    const strictReport = createDeferred<void>();
    const strictReportStarted = createDeferred<void>();
    reportSessionToDaemonIfRunningSpy.mockImplementation(async (input) => {
      if (input.requireDaemonAck !== true) return;
      strictReportStarted.resolve();
      await strictReport.promise;
    });

    const { runClaude } = await import('./runClaude');
    let testError: unknown = null;
    const runPromise = runClaude(createLegacyCredentials(), {
      startedBy: 'daemon',
      startingMode: 'remote',
    }).catch((error) => {
      testError = error;
      loopStarted.resolve();
    });

    try {
      await waitFor(strictReportStarted.promise, loopStartWaitMs);
      let launcherStarted = false;
      void loopStarted.promise.then(() => { launcherStarted = true; });
      await Promise.resolve();
      expect(loopCalls).toBe(1);
      expect(launcherStarted).toBe(false);
      strictReport.resolve();
      await waitFor(loopStarted.promise, loopStartWaitMs);
      expect(launcherStarted).toBe(true);
    } finally {
      strictReport.resolve();
      loopExit.resolve(0);
      await runPromise;
      reportSessionToDaemonIfRunningSpy.mockImplementation(async () => {});
      awaitAutoSessionReadyCallback = false;
    }

    if (testError) throw testError;
  });

  it('fails before terminal host or prompt ownership when retained hook refresh cannot commit', async () => {
    vi.resetModules();
    loopCalls = 0;
    startHookServerCalls = 0;
    persistTerminalAttachmentInfoIfNeededSpy.mockClear();
    refreshRetainedClaudeHookPluginSpy.mockReset();
    refreshRetainedClaudeHookPluginSpy.mockImplementation(() => {
      throw new Error('injected retained hook refresh failure');
    });
    backendInitDelayMs = 0;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_refresh_failure', metadataVersion: 1 }));
    const root = await mkdtemp(join(tmpdir(), 'happier-fast-start-refresh-failure-'));
    const pluginDir = join(root, 'plugin');
    const hooksDir = join(pluginDir, 'hooks');
    const hookSettingsPath = join(root, 'session-hook.json');
    const hookSettingsOverlayPath = join(root, 'session-hook.overlay.json');
    const statuslineSecretFilePath = join(root, 'session-hook.statusline-secret');
    const hookServerPort = await findAvailablePort();
    const mcpPort = await findAvailablePort();
    const hooksJsonPath = join(hooksDir, 'hooks.json');
    await mkdir(hooksDir, { recursive: true });
    await writeFile(join(pluginDir, 'permission-hook-secret'), 'permission-secret', 'utf8');
    await writeFile(hookSettingsPath, '{}', 'utf8');
    await writeFile(hookSettingsOverlayPath, '{}', 'utf8');
    await writeFile(statuslineSecretFilePath, 'statusline-secret', 'utf8');
    const originalHooksJson = JSON.stringify({
      hooks: {
        UserPromptSubmit: [{
          matcher: '',
          hooks: [{
            type: 'command',
            command: `"node" "/deleted-snapshot/session_hook_forwarder.cjs" ${hookServerPort} "UserPromptSubmit"`,
          }],
        }],
      },
    });
    await writeFile(hooksJsonPath, originalHooksJson, 'utf8');
    const endpointEnvOriginal = process.env.HAPPIER_CLAUDE_ENDPOINT_STATE;
    process.env.HAPPIER_CLAUDE_ENDPOINT_STATE = JSON.stringify({
      v: 2,
      attachmentId: 'attachment-refresh-failure',
      hookServerPort,
      hookPluginDir: pluginDir,
      hookSettingsPath,
      hookSettingsOverlayPath,
      statuslineSecretFilePath,
      mcpUrl: `http://127.0.0.1:${mcpPort}`,
      mcpPort,
    });

    try {
      const { runClaude } = await import('./runClaude');
      await expect(runClaude(createLegacyCredentials(), {
        startedBy: 'terminal',
        startingMode: 'remote',
        claudeRemoteMetaDefaults: { claudeUnifiedTerminalEnabled: true },
      })).rejects.toMatchObject({ code: 'claude_endpoint_recovery_invalid' });
      await expect(readFile(hooksJsonPath, 'utf8')).resolves.toBe(originalHooksJson);
      expect(persistTerminalAttachmentInfoIfNeededSpy).not.toHaveBeenCalled();
      expect(startHookServerCalls).toBe(0);
      expect(loopCalls).toBe(0);
    } finally {
      if (endpointEnvOriginal === undefined) delete process.env.HAPPIER_CLAUDE_ENDPOINT_STATE;
      else process.env.HAPPIER_CLAUDE_ENDPOINT_STATE = endpointEnvOriginal;
      refreshRetainedClaudeHookPluginSpy.mockReset();
      refreshRetainedClaudeHookPluginSpy.mockImplementation(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains adopted endpoint artifacts when SIGTERM arrives before terminal host readiness', async () => {
    vi.resetModules();
    const {
      cleanupHookPluginDir,
      cleanupHookSettingsFile,
    } = await import('@/backends/claude/utils/generateHookSettings');
    vi.mocked(cleanupHookSettingsFile).mockClear();
    vi.mocked(cleanupHookPluginDir).mockClear();
    loopEntered = createDeferred<void>();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    lastTerminationHandlerParams = null;
    autoSessionReady = false;
    backendInitDelayMs = 0;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_adopted_endpoint_signal', metadataVersion: 1 }));

    const root = await mkdtemp(join(tmpdir(), 'happier-adopted-endpoint-signal-'));
    const pluginDir = join(root, 'plugin');
    const hooksDir = join(pluginDir, 'hooks');
    const hookSettingsPath = join(root, 'session-hook.json');
    const hookSettingsOverlayPath = join(root, 'session-hook.overlay.json');
    const statuslineSecretFilePath = join(root, 'session-hook.statusline-secret');
    const hookServerPort = await findAvailablePort();
    const mcpPort = await findAvailablePort();
    const hooksJsonPath = join(hooksDir, 'hooks.json');
    const permissionSecretPath = join(pluginDir, 'permission-hook-secret');
    await mkdir(hooksDir, { recursive: true });
    await writeFile(permissionSecretPath, 'permission-secret', 'utf8');
    await writeFile(hookSettingsPath, '{}', 'utf8');
    await writeFile(hookSettingsOverlayPath, '{}', 'utf8');
    await writeFile(statuslineSecretFilePath, 'statusline-secret', 'utf8');
    await writeFile(hooksJsonPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{
          matcher: '',
          hooks: [{
            type: 'command',
            command: `"node" "/retained/session_hook_forwarder.cjs" ${hookServerPort} "UserPromptSubmit"`,
          }],
        }],
      },
    }), 'utf8');

    const endpointEnvOriginal = process.env.HAPPIER_CLAUDE_ENDPOINT_STATE;
    process.env.HAPPIER_CLAUDE_ENDPOINT_STATE = JSON.stringify({
      v: 2,
      attachmentId: 'attachment-adopted-endpoint-signal',
      hookServerPort,
      hookPluginDir: pluginDir,
      hookSettingsPath,
      hookSettingsOverlayPath,
      statuslineSecretFilePath,
      mcpUrl: `http://127.0.0.1:${mcpPort}`,
      mcpPort,
    });

    vi.mocked(cleanupHookSettingsFile).mockImplementation((path) => {
      rmSync(path, { force: true });
      rmSync(path.replace(/\.json$/, '.overlay.json'), { force: true });
      rmSync(path.replace(/\.json$/, '.statusline-secret'), { force: true });
    });
    vi.mocked(cleanupHookPluginDir).mockImplementation((path) => {
      if (path) rmSync(path, { recursive: true, force: true });
    });

    let runError: unknown = null;
    try {
      const { runClaude } = await import('./runClaude');
      const runPromise = runClaude(createLegacyCredentials(), {
        startedBy: 'daemon',
        startingMode: 'remote',
        claudeRemoteMetaDefaults: { claudeUnifiedTerminalEnabled: true },
      }).catch((error) => {
        runError = error;
      });

      await waitFor(loopEntered.promise, loopStartWaitMs);
      expect(lastLoopOpts?.expectedExistingTerminalHostAttachmentId)
        .toBe('attachment-adopted-endpoint-signal');
      expect(lastLoopOpts?.onTerminalHostReady).toBeTypeOf('function');
      const terminationHandler = lastTerminationHandlerParams as Parameters<
        typeof registerRunnerTerminationHandlersFn
      >[0] | null;
      expect(terminationHandler?.onTerminate).toBeTypeOf('function');
      if (!terminationHandler) throw new Error('Runner termination handler was not registered');

      const terminationPromise = terminationHandler.onTerminate(
        { kind: 'signal', signal: 'SIGTERM' },
        { exitCode: 0, archive: true, archiveReason: 'Signal SIGTERM' } as RunnerTerminationOutcome,
      );
      loopExit.resolve(0);
      await terminationPromise;
      await runPromise;
      if (runError) throw runError;

      expect(cleanupHookSettingsFile).not.toHaveBeenCalled();
      expect(cleanupHookPluginDir).not.toHaveBeenCalled();
      await expect(readFile(hookSettingsPath, 'utf8')).resolves.toBe('{}');
      await expect(readFile(hookSettingsOverlayPath, 'utf8')).resolves.toBe('{}');
      await expect(readFile(statuslineSecretFilePath, 'utf8')).resolves.toBe('statusline-secret');
      await expect(readFile(permissionSecretPath, 'utf8')).resolves.toBe('permission-secret');
      await expect(readFile(hooksJsonPath, 'utf8')).resolves.toContain('UserPromptSubmit');
    } finally {
      loopExit.resolve(0);
      if (endpointEnvOriginal === undefined) delete process.env.HAPPIER_CLAUDE_ENDPOINT_STATE;
      else process.env.HAPPIER_CLAUDE_ENDPOINT_STATE = endpointEnvOriginal;
      vi.mocked(cleanupHookSettingsFile).mockReset();
      vi.mocked(cleanupHookPluginDir).mockReset();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exposes the current Claude permission mode to the Happier MCP bridge', async () => {
    vi.resetModules();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    lastResolveRunnerMcpServersParams = null;
    autoSessionReady = true;
    initResolved = false;
    backendInitDelayMs = 0;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));

    const { runClaude } = await import('./runClaude');
    const credentials = createLegacyCredentials();
    let testError: unknown = null;
    const runPromise = runClaude(credentials, {
      startedBy: 'terminal',
      startingMode: 'local',
      permissionMode: 'yolo',
      claudeRemoteMetaDefaults: { claudeUnifiedTerminalEnabled: true },
    }).catch((e) => {
      testError = e;
      loopStarted.resolve();
    });

    try {
      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();
      if (testError) throw testError;

      expect(lastResolveRunnerMcpServersParams?.session?.getPermissionMode?.()).toBe('yolo');
      expect(startHappyServerSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          getPermissionMode: expect.any(Function),
        }),
      );
    } finally {
      loopExit.resolve(0);
      await runPromise;
    }

    if (testError) {
      throw testError;
    }
  });

  it('publishes fast-start user-message readiness only after the runtime RPC handler is registered', async () => {
    vi.resetModules();
    agentStateUpdateSnapshots.length = 0;
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    lastRuntimeSessionClient = null;
    autoSessionReady = true;
    initResolved = false;
    backendInitDelayMs = 0;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));

    const { updateAgentStateBestEffort } = await import('@/api/session/sessionWritesBestEffort');
    vi.mocked(updateAgentStateBestEffort).mockClear();
    const { runClaude } = await import('./runClaude');
    const credentials = createLegacyCredentials();
    let testError: unknown = null;
    const runPromise = runClaude(credentials, {
      startedBy: 'terminal',
      startingMode: 'local',
    }).catch((e) => {
      testError = e;
      loopStarted.resolve();
    });

    try {
      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();
      if (testError) throw testError;

      await expect(
        waitFor(
          new Promise<void>((resolve, reject) => {
            const startedAt = Date.now();
            const tick = () => {
              const handlerRegistered =
                ((getLastRuntimeSessionClient() as any)?.rpcHandlerManager.registerHandler.mock.calls.length ?? 0) > 0;
              const initialStatePublished =
                agentStateUpdateSnapshots.some((snapshot) => snapshot.reason === 'initial_agent_state');
              if (handlerRegistered && initialStatePublished) return resolve();
              if (Date.now() - startedAt > 1000) {
                return reject(new Error('Timed out waiting for fast-start handler registration and state publish'));
              }
              setTimeout(tick, 0);
            };
            tick();
          }),
          1500,
        ),
      ).resolves.toBeUndefined();

      const updateMock = vi.mocked(updateAgentStateBestEffort);
      const initialUpdateIndex = updateMock.mock.calls.findIndex((call) => call[3] === 'initial_agent_state');
      expect(initialUpdateIndex).toBeGreaterThanOrEqual(0);
      const initialState = agentStateUpdateSnapshots.find((snapshot) => snapshot.reason === 'initial_agent_state')?.state;
      expect(initialState?.capabilities).toMatchObject({ userMessageHandlerReady: true });
      const runtimeSessionClient = getLastRuntimeSessionClient() as any;
      expect(runtimeSessionClient?.rpcHandlerManager.registerHandler.mock.invocationCallOrder[0]).toBeLessThan(
        updateMock.mock.invocationCallOrder[initialUpdateIndex]!,
      );
    } finally {
      loopExit.resolve(0);
      await runPromise;
    }

    if (testError) {
      throw testError;
    }
  });

  it('passes full unified-terminal initial mode through server-unreachable local fast-start', async () => {
    vi.resetModules();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    autoSessionReady = true;
    initResolved = false;
    backendInitDelayMs = 0;
    getOrCreateSessionSpy.mockImplementation(async () => null as any);

    const { runClaude } = await import('./runClaude');
    const credentials = createLegacyCredentials();
    let testError: unknown = null;
    const runPromise = runClaude(credentials, {
      startedBy: 'terminal',
      startingMode: 'local',
      permissionMode: 'safe-yolo',
      agentModeId: 'plan',
      agentModeUpdatedAt: 10,
      claudeRemoteMetaDefaults: {
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'tmux',
        claudeRemoteSettingSourcesV2: ['local', 'project'],
        claudeRemoteDisableTodos: true,
        claudeRemoteStrictMcpServerConfig: true,
        claudeRemoteAdvancedOptionsJson: '{"plugins":["audit-plugin"],"maxBudgetUsd":4}',
      },
    }).catch((e) => {
      testError = e;
      loopStarted.resolve();
    });

    try {
      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();
      if (testError) throw testError;

      const mode = lastLoopOpts?.initialClaudeUnifiedTerminalMode;
      expect(mode).toEqual(expect.objectContaining({
        permissionMode: 'safe-yolo',
        agentModeId: 'plan',
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'tmux',
        claudeRemoteSettingSourcesV2: ['project', 'local'],
        claudeRemoteDisableTodos: true,
        claudeRemoteStrictMcpServerConfig: true,
        claudeRemoteAdvancedOptionsJson: '{"plugins":["audit-plugin"],"maxBudgetUsd":4}',
      }));
      expect(mode).toHaveProperty('model');
      expect(mode).toHaveProperty('fallbackModel');
      expect(mode).toHaveProperty('customSystemPrompt');
      expect(mode).toHaveProperty('appendSystemPrompt');
      expect(mode).toHaveProperty('reasoningEffort');
    } finally {
      loopExit.resolve(0);
      await runPromise;
      getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));
    }

    if (testError) {
      throw testError;
    }
  });

  it('aborts and waits for the active loop before signal termination cleanup exits', async () => {
    vi.resetModules();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    lastTerminationHandlerParams = null;
    autoSessionReady = true;
    initResolved = false;
    backendInitDelayMs = 0;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));

    const { runClaude } = await import('./runClaude');
    const credentials = createLegacyCredentials();
    let testError: unknown = null;
    const runPromise = runClaude(credentials, {
      startedBy: 'terminal',
      startingMode: 'local',
      claudeRemoteMetaDefaults: { claudeUnifiedTerminalEnabled: true },
    }).catch((e) => {
      testError = e;
    });

    try {
      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();
      if (testError) throw testError;
      expect(lastTerminationHandlerParams).not.toBeNull();
      const event: RunnerTerminationEvent = { kind: 'signal', signal: 'SIGTERM' };
      const outcome: RunnerTerminationOutcome = { exitCode: 0, archive: false };
      let cleanupCompleted = false;
      const cleanupPromise = Promise.resolve(lastTerminationHandlerParams!.onTerminate(event, outcome))
        .then(() => {
          cleanupCompleted = true;
        });

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(lastLoopOpts?.signal?.aborted).toBe(true);
      expect(cleanupCompleted).toBe(false);

      loopExit.resolve(0);
      await cleanupPromise;
      expect(cleanupCompleted).toBe(true);
    } finally {
      loopExit.resolve(0);
      await runPromise;
    }

    if (testError) {
      throw testError;
    }
  });

  it('disposes the local permission bridge before closing the session', async () => {
    vi.resetModules();
    localPermissionBridgeMockState.events.length = 0;
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    autoSessionReady = true;
    initResolved = false;
    backendInitDelayMs = 0;

    const previousSessionImpl = sessionSyncClientSpy.getMockImplementation();
    sessionSyncClientSpy.mockImplementation((resp: any) => {
      const base = previousSessionImpl ? (previousSessionImpl as any)(resp) : {};
      return {
        ...base,
        close: vi.fn(async () => {
          localPermissionBridgeMockState.events.push('close');
        }),
      };
    });

    const { runClaude } = await import('./runClaude');
    const credentials = createLegacyCredentials();
    let testError: unknown = null;
    const runPromise = runClaude(credentials, {
      startedBy: 'terminal',
      startingMode: 'local',
      claudeRemoteMetaDefaults: { claudeLocalPermissionBridgeEnabled: true },
    }).catch((e) => {
      testError = e;
    });

    try {
      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();
      await waitFor(
        new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            if (initResolved) {
              clearInterval(timer);
              resolve();
            }
          }, 10);
          timer.unref?.();
        }),
        5_000,
      );
      lastLoopOpts?.onSessionReady?.({
        cleanup: vi.fn(),
        closeProviderInputAdmissionAndWaitForDispatches: vi.fn(async () => {}),
        drainCriticalMetadataWrites: vi.fn(async () => {}),
        setPushSender: vi.fn(),
        client: { getMetadataSnapshot: vi.fn(() => ({})) },
        getOrCreatePermissionRpcRouter: () => ({ registerConsumer: vi.fn() }),
      });
    } catch (e) {
      testError = e;
    } finally {
      loopExit.resolve(0);
      await runPromise;
      if (previousSessionImpl) {
        sessionSyncClientSpy.mockImplementation(previousSessionImpl);
      }
    }

    if (testError) {
      throw testError;
    }

    const disposeIndex = localPermissionBridgeMockState.events.indexOf('dispose');
    const closeIndex = localPermissionBridgeMockState.events.indexOf('close');
    expect(disposeIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(disposeIndex).toBeLessThan(closeIndex);
  });

  it('forwards permission hook blocked and completion facts to the active session hook bus', async () => {
    vi.resetModules();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    lastStartHookServerOptions = null;
    autoSessionReady = false;
    initResolved = false;
    backendInitDelayMs = 0;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));

    const { runClaude } = await import('./runClaude');
    const credentials = createLegacyCredentials();
    const observedHooks: unknown[] = [];
    let testError: unknown = null;
    const runPromise = runClaude(credentials, {
      startedBy: 'terminal',
      startingMode: 'local',
      claudeRemoteMetaDefaults: { claudeUnifiedTerminalEnabled: true },
    }).catch((e) => {
      testError = e;
      loopStarted.resolve();
    });

    try {
      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();
      if (testError) throw testError;
      lastLoopOpts?.onSessionReady?.({
        cleanup: vi.fn(),
        drainCriticalMetadataWrites: vi.fn(async () => {}),
        setPushSender: vi.fn(),
        onClaudeSessionHook: (data: unknown) => {
          observedHooks.push(data);
        },
        client: { getMetadataSnapshot: vi.fn(() => ({})) },
        getOrCreatePermissionRpcRouter: () => ({ registerConsumer: vi.fn() }),
      });

      await lastStartHookServerOptions?.onPermissionHook?.({
        hook_event_name: 'PermissionRequest',
        session_id: 'claude-session-id',
        tool_name: 'Bash',
        tool_use_id: 'toolu_1',
      });
    } finally {
      loopExit.resolve(0);
      await runPromise;
      autoSessionReady = true;
    }

    if (testError) {
      throw testError;
    }

    expect(observedHooks).toEqual([
      expect.objectContaining({
        hook_event_name: 'PermissionRequest',
        session_id: 'claude-session-id',
        tool_use_id: 'toolu_1',
      }),
      expect.objectContaining({
        hook_event_name: 'PermissionRequestCompleted',
        session_id: 'claude-session-id',
        tool_use_id: 'toolu_1',
      }),
    ]);
  });

  it('uses fast-start attach when permission intent is inferred from Claude CLI args', async () => {
    vi.resetModules();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    autoSessionReady = true;
    initResolved = false;
    backendInitDelayMs = 200;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_attach', metadataVersion: 1 }));

    const previousAttachFile = process.env.HAPPIER_SESSION_ATTACH_FILE;
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const homeDir = join(configuration.happyHomeDir, 'fast-start-home');
    const attachBaseDir = join(homeDir, '.happier-attach');
    await mkdir(attachBaseDir, { recursive: true });
    const attachPath = join(attachBaseDir, 'fast-start-attach.json');
    await writeFile(
      attachPath,
      JSON.stringify({
        v: 1,
        encryptionKeyBase64: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
        encryptionVariant: 'legacy',
      }),
      'utf8',
    );
    await chmod(attachPath, 0o600);
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.HAPPIER_SESSION_ATTACH_FILE = '~/.happier-attach/fast-start-attach.json';

    const { runClaude } = await import('./runClaude');
    const credentials = createLegacyCredentials();

    let testError: unknown = null;
    const runPromise = runClaude(credentials, {
      startedBy: 'terminal',
      startingMode: 'local',
      existingSessionId: 'sess_attach',
      claudeArgs: ['--dangerously-skip-permissions'],
    }).catch((e) => {
      testError = e;
    });

    try {
      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();
      expect(lastLoopOpts?.claudeArgs).toEqual(['--dangerously-skip-permissions']);
    } catch (e) {
      testError = new Error(
        `${e instanceof Error ? e.message : String(e)} | calls: startHookServer=${startHookServerCalls}, generateHookSettings=${generateHookSettingsCalls}, resolveRunnerMcpServers=${resolveRunnerMcpServersCalls}, resolveEffectiveCodingPrompt=${resolveEffectiveCodingPromptCalls}, loop=${loopCalls}`,
      );
    } finally {
      loopExit.resolve(0);
      await runPromise;
      if (previousAttachFile === undefined) delete process.env.HAPPIER_SESSION_ATTACH_FILE;
      else process.env.HAPPIER_SESSION_ATTACH_FILE = previousAttachFile;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }

    if (testError) {
      throw testError;
    }
  });

  it('starts offline reconnection when create-session fails, then attaches once reconnected', async () => {
    vi.resetModules();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    autoSessionReady = true;
    initResolved = false;
    backendInitDelayMs = 0;
    sendSessionEventSpy.mockClear();
    persistTerminalAttachmentInfoIfNeededSpy.mockClear();

    let createCalls = 0;
    getOrCreateSessionSpy.mockImplementation(async () => {
      createCalls += 1;
      if (createCalls === 1) return null as any;
      return { id: 'sess_2', metadataVersion: 1 } as any;
    });

    startOfflineReconnectionSpy.mockClear();
    lastOfflineReconnectionConfig = null;

    const { runClaude } = await import('./runClaude');
    const { persistTerminalAttachmentInfoIfNeeded } = await import('@/agent/runtime/startupSideEffects');
    const credentials = createLegacyCredentials();

    let testError: unknown = null;
    const runPromise = runClaude(credentials, { startedBy: 'terminal', startingMode: 'local', terminalRuntime: { mode: 'tmux' } }).catch((e) => {
      testError = e;
    });

    try {
      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();

      // Wait for offline reconnection to be scheduled.
      await expect(
        waitFor(
          new Promise<void>((resolve, reject) => {
            const startedAt = Date.now();
            const tick = () => {
              if (startOfflineReconnectionSpy.mock.calls.length > 0) return resolve();
              if (Date.now() - startedAt > 500) return reject(new Error('Timed out waiting for startOfflineReconnection'));
              setTimeout(tick, 0);
            };
            tick();
          }),
          1000,
        ),
      ).resolves.toBeUndefined();

      expect(lastOfflineReconnectionConfig).not.toBeNull();
      await lastOfflineReconnectionConfig!.onReconnected();

      // The shared offline utility publishes its session swap hook without awaiting it. Observe
      // the eventual deferred-session flush instead of assuming it completed with reconnection.
      await expect(
        waitFor(
          new Promise<void>((resolve, reject) => {
            const startedAt = Date.now();
            const tick = () => {
              if (sendSessionEventSpy.mock.calls.length > 0) return resolve();
              if (Date.now() - startedAt > 500) {
                return reject(new Error('Timed out waiting for reconnected-session event flush'));
              }
              setTimeout(tick, 0);
            };
            tick();
          }),
          1000,
        ),
      ).resolves.toBeUndefined();

      // The offline status message should flush to the real session on attach.
      expect(sendSessionEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'message',
          message: expect.stringContaining('Server unreachable'),
        }),
        undefined,
      );

      // The shared offline utility deliberately publishes the session swap without awaiting its
      // best-effort hook. Observe the eventual startup side effect instead of coupling this test to
      // the hook's current microtask ordering.
      await expect(
        waitFor(
          new Promise<void>((resolve, reject) => {
            const startedAt = Date.now();
            const tick = () => {
              if (persistTerminalAttachmentInfoIfNeededSpy.mock.calls.length > 0) return resolve();
              if (Date.now() - startedAt > 500) {
                return reject(new Error('Timed out waiting for reconnected-session startup side effects'));
              }
              setTimeout(tick, 0);
            };
            tick();
          }),
          1000,
        ),
      ).resolves.toBeUndefined();

      // Startup side effects should run once the real session is available (persist terminal attachment, etc).
      expect(persistTerminalAttachmentInfoIfNeeded).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess_2' }),
      );
    } catch (e) {
      testError = new Error(
        `${e instanceof Error ? e.message : String(e)} | calls: startHookServer=${startHookServerCalls}, generateHookSettings=${generateHookSettingsCalls}, resolveRunnerMcpServers=${resolveRunnerMcpServersCalls}, resolveEffectiveCodingPrompt=${resolveEffectiveCodingPromptCalls}, loop=${loopCalls}`,
      );
    } finally {
      loopExit.resolve(0);
      await runPromise;
    }

    if (testError) {
      throw testError;
    }
  });

  it('emits a startup timing summary line after session attach when enabled', async () => {
    vi.resetModules();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    autoSessionReady = true;
    initResolved = false;
    backendInitDelayMs = 0;
    sendSessionEventSpy.mockClear();
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));
    startOfflineReconnectionSpy.mockClear();
    lastOfflineReconnectionConfig = null;

    const { runClaude } = await import('./runClaude');
    const { logger } = await import('@/ui/logger');
    const credentials = createLegacyCredentials();

    let testError: unknown = null;
    const runPromise = runClaude(credentials, { startedBy: 'terminal', startingMode: 'local' }).catch((e) => {
      testError = e;
    });

    try {
      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();
      await expect(
        waitFor(
          new Promise<void>((resolve, reject) => {
            const startedAt = Date.now();
            const tick = () => {
              if (initResolved) return resolve();
              if (Date.now() - startedAt > 500) return reject(new Error('Timed out waiting for initializeBackendApiContext'));
              setTimeout(tick, 0);
            };
            tick();
          }),
          1000,
        ),
      ).resolves.toBeUndefined();

      const debugCalls = (logger.debug as any).mock?.calls?.map((c: any[]) => c[0]) ?? [];
      const timingLine = debugCalls.find(
        (line: unknown) =>
          typeof line === 'string' &&
          line.includes('[claude-startup]') &&
          line.includes('vendor_spawn_invoked=') &&
          line.includes('initialize_backend_api_context=') &&
          line.includes('initialize_backend_run_session='),
      );
      expect(Boolean(timingLine)).toBe(true);
    } catch (e) {
      testError = e;
    } finally {
      loopExit.resolve(0);
      await runPromise;
    }

    if (testError) {
      throw testError;
    }
  });

  it('sets push sender even when the loop session becomes ready after the server session is available', async () => {
    vi.resetModules();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    autoSessionReady = false;
    initResolved = false;
    backendInitDelayMs = 0;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));
    startOfflineReconnectionSpy.mockClear();
    lastOfflineReconnectionConfig = null;

    const { runClaude } = await import('./runClaude');
    const credentials = createLegacyCredentials();

    let testError: unknown = null;
    const runPromise = runClaude(credentials, { startedBy: 'terminal', startingMode: 'local' }).catch((e) => {
      testError = e;
    });

    const sessionReady = {
      cleanup: vi.fn(),
      drainCriticalMetadataWrites: vi.fn(async () => {}),
      setPushSender: vi.fn(),
      client: {
        getMetadataSnapshot: vi.fn(() => ({})),
      },
      getOrCreatePermissionRpcRouter: () => ({ registerConsumer: vi.fn() }),
    };

    try {
      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();

      await expect(
        waitFor(
          new Promise<void>((resolve, reject) => {
            const startedAt = Date.now();
            const tick = () => {
              if (initResolved) return resolve();
              if (Date.now() - startedAt > 500) return reject(new Error('Timed out waiting for initializeBackendApiContext'));
              setTimeout(tick, 0);
            };
            tick();
          }),
          1000,
        ),
      ).resolves.toBeUndefined();

      // Allow the background init task to resume after the await and publish its artifacts (pushSender, etc).
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(lastLoopOpts).not.toBeNull();
      await lastLoopOpts?.onSessionReady?.(sessionReady);
      expect(sessionReady.setPushSender).toHaveBeenCalled();
    } catch (e) {
      testError = e;
    } finally {
      loopExit.resolve(0);
      await runPromise;
    }

    if (testError) {
      throw testError;
    }
  });

  it('marks the server session dead when unified terminal startup throws after attach', async () => {
    vi.resetModules();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    autoSessionReady = true;
    initResolved = false;
    lastRuntimeSessionClient = null;
    backendInitDelayMs = 0;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));

    const { runClaude } = await import('./runClaude');
    const credentials = createLegacyCredentials();
    const hostError = Object.assign(new Error('Claude unified terminal host is not alive'), {
      code: 'claude_unified_terminal_host_dead',
    });
    const runPromise = runClaude(credentials, {
      startedBy: 'terminal',
      startingMode: 'local',
      claudeRemoteMetaDefaults: { claudeUnifiedTerminalEnabled: true },
    }).then(
      () => 'resolved',
      (error) => error,
    );

    await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();
    await expect(
      waitFor(
        new Promise<void>((resolve, reject) => {
          const startedAt = Date.now();
          const tick = () => {
            if (initResolved && lastRuntimeSessionClient) return resolve();
            if (Date.now() - startedAt > 500) return reject(new Error('Timed out waiting for attached session'));
            setTimeout(tick, 0);
          };
          tick();
        }),
        1000,
      ),
    ).resolves.toBeUndefined();

    loopExit.reject(hostError);

    await expect(runPromise).resolves.toBe(hostError);
    const runtimeSessionClient = getLastRuntimeSessionClient();
    expect(runtimeSessionClient).not.toBeNull();
    if (!runtimeSessionClient) throw new Error('missing attached runtime session client');
    expect(runtimeSessionClient.sendSessionDeath).toHaveBeenCalledTimes(1);
    expect(runtimeSessionClient.flush).toHaveBeenCalledTimes(1);
    expect(runtimeSessionClient.close).toHaveBeenCalledTimes(1);
  });

});
