import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

import type { Credentials } from '@/persistence';
import type { SessionTurnMutationV1 } from '@happier-dev/protocol';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import {
  createCodexAppServerTestEnvScope,
  writeFakeCodexAppServerScript,
} from './appServer/testkit/fakeCodexAppServer';
import { createRunCodexFakeSession } from './appServer/testkit/runCodexFakeSession';

let sessionInputConsumerWaitForNextInputImpl: ((opts: any) => Promise<any>) | null = null;

const createSessionProviderInputConsumerSpy = vi.fn((opts: any) => ({
  waitForNextInput: async (waitOpts: any) => {
    if (!sessionInputConsumerWaitForNextInputImpl) return null;
    return await sessionInputConsumerWaitForNextInputImpl({
      ...opts,
      ...waitOpts,
      popPendingMessage: opts.session?.popPendingMessage,
      materializeNextPendingMessageSafely: opts.session?.materializeNextPendingMessageSafely,
      shouldAttemptPendingMaterialization: opts.session?.shouldAttemptPendingMaterialization,
      reconcilePendingQueueState: opts.session?.reconcilePendingQueueState,
      waitForMetadataUpdate: opts.session?.waitForMetadataUpdate,
    });
  },
  runProviderInputDispatch: async ({ dispatch }: any) => ({ status: 'dispatched', value: await dispatch() }),
  closeProviderInputAdmissionAndWaitForDispatches: vi.fn(async () => undefined),
  drainPending: vi.fn(async () => ({ materialized: 0, stoppedReason: 'no_pending' })),
  // The real runtime starts the active-turn pending pump once Codex acknowledges the turn.
  pumpPendingWhileActive: vi.fn(async () => undefined),
}));
vi.mock('@/agent/runtime/sessionInput/SessionProviderInputConsumer', () => ({
  createSessionProviderInputConsumer: (opts: any) => createSessionProviderInputConsumerSpy(opts),
}));

const resolveCodexMcpServerSpawnSpy = vi.fn<() => Promise<{ mode: string; command: string }>>(async () => ({
  mode: 'remote',
  command: '/tmp/fake-codex-mcp',
}));
vi.mock('./mcp/resolveCodexMcpServerSpawn', () => ({
  resolveCodexMcpServerSpawn: () => resolveCodexMcpServerSpawnSpy(),
}));

let createCodexMcpClientImpl: (() => unknown) | null = null;
const CodexMcpClientSpy = vi.fn(function CodexMcpClient(this: unknown) {
  void this;
  if (createCodexMcpClientImpl) return createCodexMcpClientImpl();
  return {
    connect: vi.fn(async () => undefined),
    startSession: vi.fn(async () => ({})),
    continueSession: vi.fn(async () => ({})),
    disconnect: vi.fn(async () => undefined),
    forceCloseSession: vi.fn(async () => undefined),
    clearSession: vi.fn(),
    onMessage: vi.fn(),
    setRequestUserInputBridge: vi.fn(),
    setSessionMediaPersister: vi.fn(),
    setPermissionHandler: vi.fn(),
    setHandler: vi.fn(),
    getSessionId: vi.fn(() => null),
  };
});
vi.mock('./codexMcpClient', () => ({
  CodexMcpClient: CodexMcpClientSpy,
}));

vi.mock('@/agent/runtime/initializeBackendApiContext', () => ({
  initializeBackendApiContext: vi.fn(async () => ({
    api: {
      getOrCreateSession: vi.fn(async () => ({ id: 'sess_1', metadataVersion: 1 })),
      sessionSyncClient: vi.fn(),
      push: vi.fn(() => ({ sendToAllDevices: vi.fn() })),
    },
    machineId: 'machine_1',
  })),
}));

let initializeBackendRunSessionImpl: ((opts: any) => Promise<any>) | null = null;
vi.mock('@/agent/runtime/initializeBackendRunSession', () => ({
  initializeBackendRunSession: vi.fn(async (opts: any) => {
    if (initializeBackendRunSessionImpl) {
      return await initializeBackendRunSessionImpl(opts);
    }
    throw new Error('initializeBackendRunSessionImpl not configured');
  }),
}));

vi.mock('@/mcp/runtime/resolveRunnerMcpServers', () => ({
  resolveRunnerMcpServers: vi.fn(async () => ({
    happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
    mcpServers: {},
  })),
}));

vi.mock('@/agent/runtime/runtimeOverridesSynchronizer', () => ({
  initializeRuntimeOverridesSynchronizer: vi.fn(async () => ({
    syncFromMetadata: vi.fn(),
    seedFromSession: vi.fn(async () => {}),
    getSnapshot: vi.fn(() => ({
      permissionMode: { current: 'default', updatedAt: 1 },
      modelOverride: { current: null, updatedAt: 0 },
    })),
  })),
}));

vi.mock('@/agent/localControl/createLocalRemoteModeController', () => ({
  createLocalRemoteModeController: vi.fn(() => ({
    publishModeState: vi.fn(async () => {}),
    registerRemoteSwitchHandler: vi.fn(),
  })),
}));

vi.mock('./runtime/createCodexRemoteTerminalUi', () => ({
  createCodexRemoteTerminalUi: vi.fn(() => ({
    mount: vi.fn(),
    unmount: vi.fn(async () => {}),
    setAllowSwitchToLocal: vi.fn(),
  })),
}));

vi.mock('@/ui/tty/resolveHasTTY', () => ({
  resolveHasTTY: vi.fn(() => false),
}));

vi.mock('@/backends/codex/experiments', () => ({
  isExperimentalCodexAcpEnabled: vi.fn(() => false),
}));

vi.mock('./utils/resolveCodexStartingMode', () => ({
  resolveCodexStartingMode: vi.fn(() => 'remote'),
}));

vi.mock('@/backends/codex/utils/metadataOverridesWatcher', () => ({
  runMetadataOverridesWatcherLoop: vi.fn(),
}));

vi.mock('@/agent/runtime/startup/startupOverridesCache', () => ({
  readStartupOverridesCacheForBackend: vi.fn(() => null),
  writeStartupOverridesCacheForBackend: vi.fn(() => {}),
}));

vi.mock('@/agent/prompting/coding/resolveEffectiveCodingPrompt', () => ({
  resolveEffectiveCodingPromptText: vi.fn(async () => null),
}));

vi.mock('@/features/featureDecisionService', () => ({
  resolveCliFeatureDecision: vi.fn(() => ({ state: 'disabled' })),
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

vi.mock('@/daemon/startDaemon', () => ({
  initialMachineMetadata: {},
}));

vi.mock('@/ui/doctor', () => ({
  getEnvironmentInfo: vi.fn(() => ({})),
}));

vi.mock('@/api/offline/serverConnectionErrors', () => ({
  connectionState: { setBackend: vi.fn(), notifyOffline: vi.fn() },
}));

vi.mock('@/integrations/caffeinate', () => ({
  stopCaffeinate: vi.fn(),
}));

vi.mock('@/rpc/handlers/killSession', () => ({
  registerKillSessionHandler: vi.fn(),
}));

/**
 * Composes the real `runCodex` prompt loop with the real app-server runtime so the two failure
 * owners are proven together: the runtime records failures of turns it started, and the runner
 * records failures that happen before any provider turn exists. Each failure is one failed turn.
 */
describe('runCodex app-server turn failure ownership', () => {
  let envScope = createCodexAppServerTestEnvScope();
  const tempRoots = new Set<string>();

  beforeEach(() => {
    envScope.restore();
    envScope = createCodexAppServerTestEnvScope();
    initializeBackendRunSessionImpl = null;
    sessionInputConsumerWaitForNextInputImpl = null;
    createSessionProviderInputConsumerSpy.mockClear();
    createCodexMcpClientImpl = null;
  });

  afterEach(async () => {
    envScope.restore();
    envScope = createCodexAppServerTestEnvScope();
    await Promise.all([...tempRoots].map(async (root) => {
      await removeTempDir(root);
    }));
    tempRoots.clear();
  });

  async function runPrompts(
    root: string,
    prompts: readonly string[],
    launch: Readonly<{ startedBy?: 'terminal' | 'daemon'; resume?: string }> = {},
  ) {
    const { session } = createRunCodexFakeSession({
      path: root,
      host: 'localhost',
      flavor: 'codex',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    });
    const mutations: SessionTurnMutationV1[] = [];
    let nextTurnId = 0;
    const lifecycleSession = Object.assign(session, {
      sessionTurnLifecycle: createSessionTurnLifecycle({
        sessionId: session.sessionId,
        createId: () => `turn-${++nextTurnId}`,
        enqueueSessionTurn: async (mutation) => { mutations.push(mutation); },
      }),
    });
    initializeBackendRunSessionImpl = async () => ({
      session: lifecycleSession,
      reconnectionHandle: null,
      reportedSessionId: 'sess_fresh',
      attachedToExistingSession: false,
    });
    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async () => {
      const message = prompts[waitCallCount];
      waitCallCount += 1;
      if (message === undefined) return null;
      return {
        message,
        mode: { permissionMode: 'default', permissionModeUpdatedAt: 1 },
        isolate: false,
        hash: `hash-${waitCallCount}`,
      };
    };

    const { runCodex } = await import('./runCodex');
    const runError = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: launch.startedBy ?? 'terminal',
      startingMode: 'remote',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      codexBackendMode: 'appServer',
      directory: root,
      ...(launch.resume ? { resume: launch.resume } : {}),
    }).then(() => null, (error: unknown) => error);

    const sessionMessages = session.sendSessionEvent.mock.calls
      .map((call) => (call[0] as { message?: unknown } | undefined)?.message)
      .filter((message): message is string => typeof message === 'string');
    return {
      runError,
      failures: mutations.filter((mutation): mutation is Extract<SessionTurnMutationV1, { action: 'fail' }> => mutation.action === 'fail'),
      sessionMessages,
    };
  }

  it('records a missing Codex CLI as one classified failed turn per prompt', async () => {
    const root = await createTempDir('happier-codex-run-missing-cli-');
    tempRoots.add(root);
    envScope.patch({
      HAPPIER_CODEX_APP_SERVER_BIN: undefined,
      HAPPIER_CODEX_PATH: join(root, 'missing', 'codex'),
    });

    const { runError, failures, sessionMessages } = await runPrompts(root, ['first prompt', 'second prompt']);

    expect(runError).toBeNull();
    expect(failures).toHaveLength(2);
    expect(new Set(failures.map((failure) => failure.turnId)).size).toBe(2);
    for (const failure of failures) {
      expect(failure.issue).toEqual(expect.objectContaining({
        code: 'provider_cli_not_found',
        source: 'dependency_failure',
      }));
    }
    // The classified failed turn already carries the error for session clients.
    expect(sessionMessages.some((message) => message.startsWith('Codex process error:'))).toBe(false);
  }, 240_000);

  it('records a strict resume against a missing Codex CLI as one failed turn', async () => {
    const root = await createTempDir('happier-codex-run-missing-cli-resume-');
    tempRoots.add(root);
    envScope.patch({
      HAPPIER_CODEX_APP_SERVER_BIN: undefined,
      HAPPIER_CODEX_PATH: join(root, 'missing', 'codex'),
    });

    const { runError, failures } = await runPrompts(root, ['resume prompt'], {
      startedBy: 'daemon',
      resume: 'resume-missing-cli',
    });

    expect(runError).toMatchObject({ name: 'CodexAcpResumeError' });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.issue).toEqual(expect.objectContaining({
      code: 'provider_cli_not_found',
      source: 'dependency_failure',
    }));
  }, 240_000);

  it('records a provider-failed turn once, without a second runner failure', async () => {
    const root = await createTempDir('happier-codex-run-provider-failure-');
    tempRoots.add(root);
    const fakeAppServer = await writeFakeCodexAppServerScript({
      dir: root,
      bodyLines: [
        'for await (const line of rl) {',
        '  if (!line.trim()) continue;',
        '  const msg = JSON.parse(line);',
        '  if (msg.method === "initialize") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake-codex-app-server", version: "0.0.0" } } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "initialized") continue;',
        '  if (msg.method === "thread/start") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: "thread-started", model: "gpt-5.4", serviceTier: null } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "turn/start") {',
        '    const threadId = msg.params?.threadId ?? null;',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-failed" }, threadId } }) + "\\n");',
        '    setTimeout(() => {',
        '      process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: "turn-failed", status: "failed", error: { message: "upstream closed the stream", codexErrorInfo: "other", additionalDetails: null } } } }) + "\\n");',
        '    }, 5);',
        '    continue;',
        '  }',
        '  if (msg.id !== undefined) {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
        '  }',
        '}',
      ],
    });
    envScope.patch({
      HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
      HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '10000',
    });

    const { runError, failures, sessionMessages } = await runPrompts(root, ['fail this turn']);

    expect(runError).toBeNull();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual(expect.objectContaining({
      provider: 'codex',
      issue: expect.objectContaining({ provider: 'codex' }),
    }));
    // The runtime's failed turn already carries the error for session clients.
    expect(sessionMessages.some((message) => message.startsWith('Codex process error:'))).toBe(false);
  }, 240_000);
});
