import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Credentials } from '@/persistence';
import { resolveSessionAttachBaseDir } from '@/agent/runtime/sessionAttachPaths';
import { configuration } from '@/configuration';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function createDeferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: (value: T) => resolveFn?.(value) };
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
let loopExit: Deferred<number> = createDeferred<number>();
let lastLoopOpts: any = null;
let autoSessionReady = true;
let readSettingsCalls = 0;
let initializeBackendApiContextCalls = 0;
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

vi.mock('@/backends/claude/loop', () => ({
  loop: vi.fn(async (opts: any) => {
    loopCalls += 1;
    lastLoopOpts = opts;
    loopStarted.resolve();
    if (autoSessionReady) {
      opts?.onSessionReady?.({
        cleanup: vi.fn(),
        setPushSender: vi.fn(),
        client: {
          getMetadataSnapshot: vi.fn(() => ({})),
        },
        getOrCreatePermissionRpcRouter: () => ({ registerConsumer: vi.fn() }),
      });
    }
    return await loopExit.promise;
  }),
}));

let initResolved = false;
let backendInitDelayMs = 200;
const getOrCreateSessionSpy = vi.fn(async () => ({ id: 'sess_1', metadataVersion: 1 }));
const sendSessionEventSpy = vi.fn();
let startHookServerCalls = 0;
let generateHookSettingsCalls = 0;
let resolveRunnerMcpServersCalls = 0;
let resolveEffectiveCodingPromptCalls = 0;
let loopCalls = 0;
const sessionSyncClientSpy = vi.fn((resp: any) => ({
  sessionId: resp?.id ?? 'sess_1',
  rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn() },
  ensureMetadataSnapshot: vi.fn(async () => ({})),
  getMetadataSnapshot: vi.fn(() => ({})),
  onUserMessage: vi.fn(),
  sendSessionEvent: sendSessionEventSpy,
  updateMetadata: vi.fn(),
  updateAgentState: vi.fn(),
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
  startHookServer: vi.fn(async () => {
    startHookServerCalls += 1;
    return { port: 12345, stop: vi.fn() };
  }),
}));

vi.mock('@/backends/claude/utils/generateHookSettings', () => ({
  generateHookSettingsFile: vi.fn(() => '/tmp/happier-hooks.json'),
  cleanupHookSettingsFile: vi.fn(),
}));

vi.mock('@/backends/claude/utils/generateHookSettingsFileWithEnsuredRuntime', () => ({
  generateHookSettingsFileWithEnsuredRuntime: vi.fn(async () => {
    generateHookSettingsCalls += 1;
    return '/tmp/happier-hooks.json';
  }),
}));

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
  ensureJavaScriptRuntimeExecutable: vi.fn(async () => '/managed/js-runtime'),
}));

vi.mock('@/mcp/runtime/resolveRunnerMcpServers', () => ({
  resolveRunnerMcpServers: vi.fn(async () => {
    resolveRunnerMcpServersCalls += 1;
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
  registerRunnerTerminationHandlers: vi.fn(() => ({
    requestTermination: vi.fn(),
    whenTerminated: Promise.resolve(),
    dispose: vi.fn(),
  })),
}));

vi.mock('@/api/session/sessionWritesBestEffort', () => ({
  updateAgentStateBestEffort: vi.fn(),
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
    });

	  try {
	      await expect(waitFor(loopStarted.promise, loopStartWaitMs)).resolves.toBeUndefined();
	      expect(initResolved).toBe(false);
	      expect(lastLoopOpts?.precomputedMcpBridge?.mcpServers).toBeTruthy();
	      expect(Object.keys(lastLoopOpts?.precomputedMcpBridge?.mcpServers ?? {})).toContain('happier');

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
    const attachBaseDir = resolveSessionAttachBaseDir(configuration.happyHomeDir);
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
      lastLoopOpts?.onSessionReady?.(sessionReady);
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

});
