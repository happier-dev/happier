import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Credentials } from '@/persistence';
import { resolveSessionAttachBaseDir } from '@/agent/runtime/sessionAttachPaths';
import { configuration } from '@/configuration';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

const localPermissionBridgeMockState = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('@/backends/claude/runtime/terminal/permissions/localPermissionBridge', () => ({
  DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE: {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: { hookEventName: 'PermissionRequest' },
  },
  ClaudeLocalPermissionBridge: class ClaudeLocalPermissionBridge {
    activate() {}
    dispose() {
      localPermissionBridgeMockState.events.push('dispose');
    }
  },
}));

function createDeferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: (value: T) => resolveFn?.(value) };
}

function createBlockingMetadataWaiter() {
  const waiters: Array<(ok: boolean) => void> = [];

  return {
    waitForMetadataUpdate: async (abortSignal?: AbortSignal) => {
      if (abortSignal?.aborted) return false;
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          abortSignal?.removeEventListener('abort', onAbort);
          resolve(ok);
        };
        const onAbort = () => finish(false);

        abortSignal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(finish);

        if (abortSignal?.aborted) {
          finish(false);
        }
      });
    },
    resolveAll: (ok: boolean) => {
      const pending = waiters.splice(0);
      for (const resolve of pending) {
        resolve(ok);
      }
    },
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

async function waitForLoopStartOrFailure(params: {
  loopStarted: Promise<void>;
  timeoutMs: number;
  getFailure: () => unknown;
}): Promise<void> {
  let interval: NodeJS.Timeout | null = null;
  const failurePromise = new Promise<never>((_resolve, reject) => {
    interval = setInterval(() => {
      const failure = params.getFailure();
      if (!failure) return;
      clearInterval(interval!);
      reject(failure instanceof Error ? failure : new Error(String(failure)));
    }, 10);
    interval.unref?.();
  });

  try {
    await Promise.race([waitFor(params.loopStarted, params.timeoutMs), failurePromise]);
  } finally {
    if (interval) {
      clearInterval(interval);
    }
  }
}

async function waitForRegisteredRpcHandler(method: string, timeoutMs: number): Promise<(...args: any[]) => unknown> {
  return await waitFor(
    new Promise<(...args: any[]) => unknown>((resolve) => {
      const poll = () => {
        const handler = registeredRpcHandlers.get(method);
        if (handler) {
          resolve(handler);
          return;
        }
        const timer = setTimeout(poll, 10);
        timer.unref?.();
      };
      poll();
    }),
    timeoutMs,
  );
}

async function finishClaudeRun(
  runPromise: Promise<void>,
  opts: { waitForCompletion?: boolean } = {},
): Promise<void> {
  loopExit.resolve(0);
  metadataWaiterController.resolveAll(false);
  let killHandler: ((...args: any[]) => unknown) | undefined = registeredRpcHandlers.get('killSession');
  if (!killHandler) {
    try {
      killHandler = await waitForRegisteredRpcHandler('killSession', 1_500);
    } catch {
      killHandler = undefined;
    }
  }
  if (killHandler) {
    await Promise.resolve(killHandler());
  }
  if (opts.waitForCompletion === true) {
    await waitFor(runPromise, 5_000);
  }
}

let loopStarted: Deferred<void> = createDeferred<void>();
let loopExit: Deferred<number> = createDeferred<number>();
let lastLoopOpts: any = null;
let capturedUserMessageHandler: ((message: any) => void) | null = null;
let metadataSnapshot: Record<string, unknown> | null = null;
let autoSessionReady = true;
let readSettingsCalls = 0;
let initializeBackendApiContextCalls = 0;
let initializedMachineId = 'machine_1';
const startHappyServerSpy = vi.fn(async (_client: any) => ({
  url: 'http://127.0.0.1:1234',
  toolNames: [],
  stop: vi.fn(),
}));
const persistTerminalAttachmentInfoIfNeededSpy = vi.fn<(info: { sessionId: string }) => Promise<void>>(async () => {});
const reportSessionToDaemonIfRunningSpy = vi.fn(async () => {});

vi.mock('@/persistence', () => ({
  readSettings: vi.fn(async () => {
    readSettingsCalls += 1;
    return { machineId: 'machine_1' };
  }),
}));

vi.mock('@/backends/claude/runtime/createTurnOperations', () => ({
  createClaudeRuntimeTurnOperations: vi.fn((params: any) => {
    const bindSession = (session: any) => {
      params.currentSessionRef.current = session;
      params.localPermissionBridgeManager.setSession(session);
      const pushSender = params.deferredPushSenderRef.current;
      if (pushSender) {
        session.setPushSender?.(pushSender);
      }
    };
    lastLoopOpts = {
      ...params.opts,
      claudeArgs: params.opts.claudeArgs,
      precomputedMcpBridge: {
        mcpServers: params.mcpServers,
        stop: () => undefined,
      },
      onSessionReady: bindSession,
    };
    const createDefaultLoopSession = () => ({
      cleanup: vi.fn(),
      drainCriticalMetadataWrites: vi.fn(async () => {}),
      setPushSender: vi.fn(),
      onThinkingChange: vi.fn(),
      client: {
        getMetadataSnapshot: vi.fn(() => ({})),
      },
      getOrCreatePermissionRpcRouter: () => ({ registerConsumer: vi.fn() }),
      abortCurrentTurn: vi.fn(async () => undefined),
      noteUserAbortRequested: vi.fn(),
    });
    const startLoop = async (): Promise<number> => {
      loopCalls += 1;
      loopStarted.resolve();
      if (autoSessionReady) {
        bindSession(currentLoopSessionOverride ?? createDefaultLoopSession());
      }
      return await loopExit.promise;
    };
    return {
      beginTurnLifecycle: vi.fn(),
      startOrLoadSession: vi.fn(async () => undefined),
      sendTurnPrompt: vi.fn(async () => undefined),
      steerInFlightTurn: vi.fn(async () => undefined),
      waitForTurnCompletion: vi.fn(async () => undefined),
      subscribeRuntimeMessages: vi.fn(() => () => undefined),
      respondToPermission: vi.fn(async () => undefined),
      cancelTurn: vi.fn(async () => {
        params.currentSessionRef.current?.noteUserAbortRequested?.();
        await params.currentSessionRef.current?.abortCurrentTurn?.();
      }),
      readSessionIdentity: vi.fn(() => ({ sessionId: params.currentSessionRef.current?.sessionId ?? null })),
      updateSessionRuntimeConfig: vi.fn(async () => undefined),
      resetOrDisposeRuntime: vi.fn(async () => {
        const session = params.currentSessionRef.current;
        params.localPermissionBridgeManager.setSession(null);
        params.localPermissionBridgeManager.dispose();
        session?.cleanup?.();
      }),
      resolveTerminalRemoteSessionModeLoop: () => ({
        startingMode: params.opts.startingMode,
        remoteExitCode: 0,
        runTerminal: async () => ({ type: 'exit', code: await startLoop() } as const),
        runRemote: async () => {
          await startLoop();
          return 'exit' as const;
        },
        onModeChange: vi.fn(),
      }),
    };
  }),
}));

let initResolved = false;
let backendInitDelayMs = 200;
const getOrCreateSessionSpy = vi.fn(async () => ({ id: 'sess_1', metadataVersion: 1 }));
const sendSessionEventSpy = vi.fn();
const sendAgentMessageSpy = vi.fn();
let startHookServerCalls = 0;
let generateHookSettingsCalls = 0;
let resolveRunnerMcpServersCalls = 0;
let lastResolveRunnerMcpServersParams: any = null;
let resolveEffectiveCodingPromptCalls = 0;
let loopCalls = 0;
let currentLoopSessionOverride: Record<string, unknown> | null = null;
let metadataWaiterController = createBlockingMetadataWaiter();
const registeredRpcHandlers = new Map<string, (...args: any[]) => unknown>();
let loggerMock: typeof import('@/ui/logger').logger;
let createClaudeSessionRuntimeFn: typeof import('./session').createClaudeSessionRuntime;
let runHostSessionRuntimeFn: typeof import('@/agent/runtime/session/loop/runHostSessionRuntime').runHostSessionRuntime;
const sessionSyncClientSpy = vi.fn((resp: any) => ({
  sessionId: resp?.id ?? 'sess_1',
  rpcHandlerManager: {
    registerHandler: vi.fn((method: string, handler: (...args: any[]) => unknown) => {
      registeredRpcHandlers.set(method, handler);
    }),
    invokeLocal: vi.fn(),
  },
  ensureMetadataSnapshot: vi.fn(async () => metadataSnapshot ?? {}),
  getMetadataSnapshot: vi.fn(() => metadataSnapshot ?? {}),
  fetchLatestUserPermissionIntentFromTranscript: vi.fn(async () => null),
  onUserMessage: vi.fn((handler: (message: any) => void) => {
    capturedUserMessageHandler = handler;
  }),
  sendSessionEvent: sendSessionEventSpy,
  sendClaudeSessionMessage: vi.fn(),
  sendAgentMessage: sendAgentMessageSpy,
  sendCodexMessage: vi.fn(),
  sendUserTextMessage: vi.fn(),
  updateMetadata: vi.fn(),
  updateAgentState: vi.fn(),
  keepAlive: vi.fn(),
  waitForMetadataUpdate: vi.fn((abortSignal?: AbortSignal) => metadataWaiterController.waitForMetadataUpdate(abortSignal)),
  popPendingMessage: vi.fn(async () => false),
  peekPendingMessageQueueV2Count: vi.fn(async () => 0),
  discardPendingMessageQueueV2All: vi.fn(async () => 0),
  discardCommittedMessageLocalIds: vi.fn(async () => 0),
  sendSessionDeath: vi.fn(),
  flush: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
}));
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
      machineId: initializedMachineId,
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
  startHookServer: vi.fn(async () => {
    startHookServerCalls += 1;
    return { port: 12345, stop: vi.fn() };
  }),
}));

vi.mock('@/backends/claude/utils/generateHookSettings', () => ({
  generateHookSettingsFile: vi.fn(() => '/tmp/happier-hooks.json'),
  cleanupHookSettingsFile: vi.fn(),
  cleanupHookPluginDir: vi.fn(),
}));

vi.mock('@/backends/claude/utils/generateHookSettingsFileWithEnsuredRuntime', () => ({
  generateHookSettingsFileWithEnsuredRuntime: vi.fn(async () => {
    generateHookSettingsCalls += 1;
    return '/tmp/happier-hooks.json';
  }),
  generateHookPluginDirWithEnsuredRuntime: vi.fn(async () => '/tmp/happier-hook-plugin'),
}));

vi.mock('@/packagedRuntime/js/ensureJavaScriptRuntimeExecutable', () => ({
  ensureJavaScriptRuntimeExecutable: vi.fn(async () => '/managed/js-runtime'),
}));

vi.mock('@/mcp/runtime/resolveRunnerMcpServers', () => ({
  resolveRunnerMcpServers: vi.fn(async (params: any) => {
    resolveRunnerMcpServersCalls += 1;
    lastResolveRunnerMcpServersParams = params;
    const happierMcpServer = await startHappyServerSpy({
      sessionId: 'sess_1',
      rpcHandlerManager: { registerHandler: vi.fn() } as any,
      sendClaudeSessionMessage: vi.fn(),
    } as any);
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
  registerKillSessionHandler: vi.fn((rpcHandlerManager: { registerHandler: (method: string, handler: (...args: any[]) => unknown) => void }, handler: (...args: any[]) => unknown) => {
    rpcHandlerManager.registerHandler('killSession', handler);
  }),
}));

vi.mock('@/agent/runtime/startupSideEffects', () => ({
  primeAgentStateForUi: vi.fn(),
  persistTerminalAttachmentInfoIfNeeded: persistTerminalAttachmentInfoIfNeededSpy,
  reportSessionToDaemonIfRunning: reportSessionToDaemonIfRunningSpy,
  sendTerminalFallbackMessageIfNeeded: vi.fn(),
}));

vi.mock('@/agent/runtime/startupMetadataUpdate', () => ({
  applyStartupMetadataUpdateToSession: vi.fn(),
  buildSessionModeOverride: vi.fn(() => null),
  buildModelOverride: vi.fn(() => null),
  buildPermissionModeOverride: vi.fn(() => null),
}));

vi.mock('@/agent/runtime/permissions/startupSeed', () => ({
  resolveStartupPermissionModeFromSession: vi.fn(async () => null),
}));

vi.mock('@/agent/runtime/lifecycle/runnerTerminationOutcome', () => ({
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

vi.mock('@/agent/runtime/lifecycle/runnerTerminationHandlers', () => ({
  registerRunnerTerminationHandlers: vi.fn((params: { onTerminate: (event: unknown, outcome: { kind: 'exit'; code: number }) => Promise<void> | void }) => {
    let whenTerminated = Promise.resolve();
    return {
      requestTermination: vi.fn((event: unknown) => {
        whenTerminated = Promise.resolve(params.onTerminate(event, { kind: 'exit', code: 0 }));
      }),
      get whenTerminated() {
        return whenTerminated;
      },
      dispose: vi.fn(),
    };
  }),
}));

vi.mock('@/api/session/sessionWritesBestEffort', () => ({
  updateAgentStateBestEffort: vi.fn(),
  updateMetadataBestEffort: vi.fn(),
}));

describe('Claude session binding fast-start', () => {
  const loopStartWaitMs = 5_000;
  const prevTiming = process.env.HAPPIER_STARTUP_TIMING_ENABLED;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    void code;
    return undefined as never;
  }) as any);

  beforeAll(async () => {
    ({ logger: loggerMock } = await import('@/ui/logger'));
    ({ createClaudeSessionRuntime: createClaudeSessionRuntimeFn } = await import('./session'));
    ({ runHostSessionRuntime: runHostSessionRuntimeFn } = await import('@/agent/runtime/session/loop/runHostSessionRuntime'));
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

afterEach(() => {
  metadataWaiterController.resolveAll(false);
  metadataWaiterController = createBlockingMetadataWaiter();
  registeredRpcHandlers.clear();
  initializedMachineId = 'machine_1';
  currentLoopSessionOverride = null;
  sendAgentMessageSpy.mockClear();
  vi.mocked(loggerMock.debug).mockClear();
  // Provider runners must not hard-exit the process. Host owns termination policy.
  expect(exitSpy).not.toHaveBeenCalled();
  exitSpy.mockClear();
});

  async function runClaudeViaLiveHostPath(
    credentials: Credentials,
    options: Record<string, unknown>,
  ): Promise<void> {
    const plan = await createClaudeSessionRuntimeFn({
      credentials,
      ...options,
    });

    await runHostSessionRuntimeFn(plan.opts, plan.config);
  }

  it('keeps abort RPC ownership in the shared host loop while delegating cancel to the active Claude session callback', async () => {
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    lastResolveRunnerMcpServersParams = null;
    capturedUserMessageHandler = null;
    metadataSnapshot = null;
    autoSessionReady = true;
    initResolved = false;
    backendInitDelayMs = 200;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));
    startOfflineReconnectionSpy.mockClear();
    lastOfflineReconnectionConfig = null;

    const abortCurrentTurn = vi.fn(async () => undefined);
    const noteUserAbortRequested = vi.fn();
    currentLoopSessionOverride = {
      cleanup: vi.fn(),
      drainCriticalMetadataWrites: vi.fn(async () => {}),
      setPushSender: vi.fn(),
      onThinkingChange: vi.fn(),
      client: {
        getMetadataSnapshot: vi.fn(() => ({})),
      },
      getOrCreatePermissionRpcRouter: () => ({ registerConsumer: vi.fn() }),
      abortCurrentTurn,
      noteUserAbortRequested,
    };

    const credentials = createLegacyCredentials();

    let testError: unknown = null;
    const runPromise = runClaudeViaLiveHostPath(credentials, { startedBy: 'terminal', startingMode: 'local' }).catch((e) => {
      testError = e;
    });

    try {
      await expect(
        waitForLoopStartOrFailure({
          loopStarted: loopStarted.promise,
          timeoutMs: loopStartWaitMs,
          getFailure: () => testError,
        }),
      ).resolves.toBeUndefined();

      const abortHandler = await waitForRegisteredRpcHandler('abort', 1_500);
      await abortHandler();

      expect(abortCurrentTurn).toHaveBeenCalledTimes(1);
      expect(noteUserAbortRequested).toHaveBeenCalledTimes(1);
      expect(
        sendAgentMessageSpy.mock.calls.some(
          ([provider, body]) => provider === 'claude' && body && typeof body === 'object' && (body as { type?: unknown }).type === 'turn_aborted',
        ),
      ).toBe(true);
      await waitFor(
        new Promise<void>((resolve) => {
          const poll = () => {
            if (initResolved) {
              resolve();
              return;
            }
            const timer = setTimeout(poll, 10);
            timer.unref?.();
          };
          poll();
        }),
        5_000,
      );
    } finally {
      await finishClaudeRun(runPromise, { waitForCompletion: true });
    }

    if (testError) {
      throw testError;
    }
  });

  it('invokes vendor spawn without waiting for backend API initialization', async () => {
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    lastResolveRunnerMcpServersParams = null;
    capturedUserMessageHandler = null;
    metadataSnapshot = null;
    autoSessionReady = true;
    initResolved = false;
    backendInitDelayMs = 200;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));
    startOfflineReconnectionSpy.mockClear();
    lastOfflineReconnectionConfig = null;

    const credentials = createLegacyCredentials();

    let testError: unknown = null;
    let didLoopStart = false;
    const runPromise = runClaudeViaLiveHostPath(credentials, { startedBy: 'terminal', startingMode: 'local' }).catch((e) => {
      testError = e;
    });

	  try {
	      await expect(
          waitForLoopStartOrFailure({
            loopStarted: loopStarted.promise,
            timeoutMs: loopStartWaitMs,
            getFailure: () => testError,
          }),
        ).resolves.toBeUndefined();
        didLoopStart = true;
	      expect(initResolved).toBe(false);
	      expect(lastResolveRunnerMcpServersParams?.machineId).toBe('machine_1');
	      expect(lastLoopOpts?.precomputedMcpBridge?.mcpServers).toBeTruthy();
	      expect(Object.keys(lastLoopOpts?.precomputedMcpBridge?.mcpServers ?? {})).toContain('happier');

	      const { startHappyServer } = await import('@/mcp/startHappyServer');
	      expect(startHappyServer).toHaveBeenCalled();
	    } catch (e) {
	      testError = new Error(
	        `${e instanceof Error ? e.message : String(e)} | calls: readSettings=${readSettingsCalls}, initializeBackendApiContext=${initializeBackendApiContextCalls}, startHookServer=${startHookServerCalls}, generateHookSettings=${generateHookSettingsCalls}, resolveRunnerMcpServers=${resolveRunnerMcpServersCalls}, resolveEffectiveCodingPrompt=${resolveEffectiveCodingPromptCalls}, loop=${loopCalls}, initResolved=${initResolved}`,
	      );
	    } finally {
      try {
        await finishClaudeRun(runPromise);
      } catch (e) {
        testError ??= new Error(
          `${e instanceof Error ? e.message : String(e)} | phase=cleanup, didLoopStart=${String(didLoopStart)}, readSettings=${readSettingsCalls}, initializeBackendApiContext=${initializeBackendApiContextCalls}, startHookServer=${startHookServerCalls}, generateHookSettings=${generateHookSettingsCalls}, resolveRunnerMcpServers=${resolveRunnerMcpServersCalls}, resolveEffectiveCodingPrompt=${resolveEffectiveCodingPromptCalls}, loop=${loopCalls}, initResolved=${initResolved}`,
        );
      }
    }

    if (testError) {
      throw testError;
    }
  });

  it('uses the current settings machine id for deferred-startup MCP resolution before background API initialization finishes', async () => {
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    lastResolveRunnerMcpServersParams = null;
    capturedUserMessageHandler = null;
    metadataSnapshot = null;
    autoSessionReady = true;
    initResolved = false;
    initializedMachineId = 'machine_rotated';
    backendInitDelayMs = 50;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));
    startOfflineReconnectionSpy.mockClear();
    lastOfflineReconnectionConfig = null;

    const credentials = createLegacyCredentials();

    let testError: unknown = null;
    const runPromise = runClaudeViaLiveHostPath(credentials, { startedBy: 'terminal', startingMode: 'local' }).catch((e) => {
      testError = e;
    });

    try {
      await expect(waitForLoopStartOrFailure({
        loopStarted: loopStarted.promise,
        timeoutMs: loopStartWaitMs,
        getFailure: () => testError,
      })).resolves.toBeUndefined();
      expect(lastResolveRunnerMcpServersParams?.machineId).toBe('machine_1');
    } catch (e) {
      testError = e;
    } finally {
      await finishClaudeRun(runPromise);
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

    const credentials = createLegacyCredentials();
    const orderedEvents: string[] = [];
    const originalDispose = localPermissionBridgeMockState.events.push.bind(localPermissionBridgeMockState.events);
    localPermissionBridgeMockState.events.push = ((...items: string[]) => {
      orderedEvents.push(...items);
      return originalDispose(...items);
    }) as typeof localPermissionBridgeMockState.events.push;
    currentLoopSessionOverride = {
      cleanup: vi.fn(() => {
        orderedEvents.push('session_cleanup');
      }),
      drainCriticalMetadataWrites: vi.fn(async () => {}),
      setPushSender: vi.fn(),
      onThinkingChange: vi.fn(),
      client: {
        getMetadataSnapshot: vi.fn(() => ({})),
      },
      getOrCreatePermissionRpcRouter: () => ({ registerConsumer: vi.fn() }),
      abortCurrentTurn: vi.fn(async () => undefined),
      noteUserAbortRequested: vi.fn(),
    };
    let testError: unknown = null;
    const runPromise = runClaudeViaLiveHostPath(credentials, { startedBy: 'terminal', startingMode: 'local' }).catch((e) => {
      testError = e;
    });

    try {
      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();
    } catch (e) {
      testError = e;
    } finally {
      await finishClaudeRun(runPromise, { waitForCompletion: true });
      localPermissionBridgeMockState.events.push = originalDispose;
    }

    if (testError) {
      throw testError;
    }

    expect(localPermissionBridgeMockState.events).toContain('dispose');
    expect(orderedEvents).toContain('session_cleanup');
    expect(orderedEvents.indexOf('dispose')).toBeLessThan(orderedEvents.indexOf('session_cleanup'));
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
    const attachBaseDir = resolveSessionAttachBaseDir(configuration.happyHomeDir, configuration.publicReleaseRing);
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
    process.env.HAPPIER_SESSION_ATTACH_FILE = attachPath;

    const credentials = createLegacyCredentials();

    let testError: unknown = null;
    const runPromise = runClaudeViaLiveHostPath(credentials, {
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
      await finishClaudeRun(runPromise);
      if (previousAttachFile === undefined) delete process.env.HAPPIER_SESSION_ATTACH_FILE;
      else process.env.HAPPIER_SESSION_ATTACH_FILE = previousAttachFile;
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

    let createCalls = 0;
    getOrCreateSessionSpy.mockImplementation(async () => {
      createCalls += 1;
      if (createCalls === 1) return null as any;
      return { id: 'sess_2', metadataVersion: 1 } as any;
    });

    startOfflineReconnectionSpy.mockClear();
    lastOfflineReconnectionConfig = null;

    const { persistTerminalAttachmentInfoIfNeeded } = await import('@/agent/runtime/startupSideEffects');
    const credentials = createLegacyCredentials();

    let testError: unknown = null;
    const runPromise = runClaudeViaLiveHostPath(credentials, { startedBy: 'terminal', startingMode: 'local', terminalRuntime: { mode: 'tmux' } }).catch((e) => {
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

      // The offline status message should flush to the real session on attach.
      expect(sendSessionEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'message',
          message: expect.stringContaining('Server unreachable'),
        }),
        undefined,
      );

      // Startup side effects should run once the real session is available (persist terminal attachment, etc).
      expect(persistTerminalAttachmentInfoIfNeeded).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess_2' }),
      );
    } catch (e) {
      testError = new Error(
        `${e instanceof Error ? e.message : String(e)} | calls: startHookServer=${startHookServerCalls}, generateHookSettings=${generateHookSettingsCalls}, resolveRunnerMcpServers=${resolveRunnerMcpServersCalls}, resolveEffectiveCodingPrompt=${resolveEffectiveCodingPromptCalls}, loop=${loopCalls}`,
      );
    } finally {
      await finishClaudeRun(runPromise);
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

    const prevTiming = process.env.HAPPIER_STARTUP_TIMING_ENABLED;
    process.env.HAPPIER_STARTUP_TIMING_ENABLED = '1';
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const credentials = createLegacyCredentials();

    let testError: unknown = null;
    const runPromise = runClaudeViaLiveHostPath(credentials, { startedBy: 'terminal', startingMode: 'local' }).catch((e) => {
      testError = e;
    });

    let timingLine: string | null = null;
    try {
      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();
      timingLine = await waitFor(
        new Promise<string>((resolve, reject) => {
          const startedAt = Date.now();
          const tick = () => {
            const debugCalls = (loggerMock.debug as any).mock?.calls?.map((c: any[]) => c[0]) ?? [];
            const matchedLine = debugCalls.find(
              (line: unknown) =>
                typeof line === 'string' &&
                line.includes('[claude-startup]') &&
                line.includes('initialize_backend_api_context=') &&
                line.includes('initialize_backend_run_session=') &&
                line.includes('resolve_startup_permission_mode='),
            );
            if (typeof matchedLine === 'string') {
              resolve(matchedLine);
              return;
            }
            if (Date.now() - startedAt > 8_000) {
              reject(new Error('Timed out waiting for Claude startup timing summary'));
              return;
            }
            setTimeout(tick, 10);
          };
          tick();
        }),
        9_000,
      );
    } catch (e) {
      testError = e;
    } finally {
      await finishClaudeRun(runPromise, { waitForCompletion: true });
      if (prevTiming === undefined) delete process.env.HAPPIER_STARTUP_TIMING_ENABLED;
      else process.env.HAPPIER_STARTUP_TIMING_ENABLED = prevTiming;
      reloadConfiguration();
    }

    if (testError) {
      throw testError;
    }

    expect(Boolean(timingLine)).toBe(true);
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

    const credentials = createLegacyCredentials();

    let testError: unknown = null;
    const runPromise = runClaudeViaLiveHostPath(credentials, { startedBy: 'terminal', startingMode: 'local' }).catch((e) => {
      testError = e;
    });

    const sessionReady = {
      cleanup: vi.fn(),
      setPushSender: vi.fn(),
      onThinkingChange: vi.fn(),
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
      lastLoopOpts?.onSessionReady?.(sessionReady);
      expect(sessionReady.setPushSender).toHaveBeenCalled();
    } catch (e) {
      testError = e;
    } finally {
      await finishClaudeRun(runPromise);
    }

    if (testError) {
      throw testError;
    }
  });

  it('keeps local fast-start queueing stable when the legacy reasoning_effort message-meta alias is present', async () => {
    vi.resetModules();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    capturedUserMessageHandler = null;
    metadataSnapshot = {
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 10,
        overrides: {
          reasoning_effort: {
            updatedAt: 10,
            value: 'high',
          },
        },
      },
    };
    autoSessionReady = true;
    initResolved = false;
    backendInitDelayMs = 0;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));
    startOfflineReconnectionSpy.mockClear();
    lastOfflineReconnectionConfig = null;

    const credentials = createLegacyCredentials();

    let testError: unknown = null;
    const runPromise = runClaudeViaLiveHostPath(credentials, { startedBy: 'terminal', startingMode: 'local' }).catch((e) => {
      testError = e;
    });

    try {
      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();
      await expect(
        waitFor(
          new Promise<void>((resolve, reject) => {
            const startedAt = Date.now();
            const tick = () => {
              if (capturedUserMessageHandler) return resolve();
              if (Date.now() - startedAt > 500) return reject(new Error('Timed out waiting for onUserMessage registration'));
              setTimeout(tick, 0);
            };
            tick();
          }),
          1000,
        ),
      ).resolves.toBeUndefined();

      expect(capturedUserMessageHandler).not.toBeNull();
      expect(() =>
        capturedUserMessageHandler!({
          content: { text: 'keep it light' },
          meta: { reasoning_effort: 'low' },
          createdAt: 20,
        }),
      ).not.toThrow();
    } catch (e) {
      testError = e;
    } finally {
      await finishClaudeRun(runPromise);
    }

    if (testError) {
      throw testError;
    }
  });

});
