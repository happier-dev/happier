import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Credentials } from '@/persistence';
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

describe('runCodex app-server startup plan mode', () => {
  let envScope = createCodexAppServerTestEnvScope();
  const tempRoots = new Set<string>();

  beforeEach(() => {
    envScope.restore();
    envScope = createCodexAppServerTestEnvScope();
    initializeBackendRunSessionImpl = null;
    sessionInputConsumerWaitForNextInputImpl = null;
    createSessionProviderInputConsumerSpy.mockClear();
    resolveCodexMcpServerSpawnSpy.mockClear();
    CodexMcpClientSpy.mockClear();
    createCodexMcpClientImpl = null;
  });

  afterEach(async () => {
    envScope.restore();
    envScope = createCodexAppServerTestEnvScope();
    createCodexMcpClientImpl = null;
    await Promise.all([...tempRoots].map(async (root) => {
      await removeTempDir(root);
    }));
    tempRoots.clear();
  });

  it('threads startup plan, model, reasoning, and Fast overrides into the first app-server turn/start payload', async () => {
    const root = await createTempDir('happier-codex-run-plan-start-');
    tempRoots.add(root);
    await mkdir(root, { recursive: true });
    const requestLogPath = join(root, 'requests.log');

    const fakeAppServer = await writeFakeCodexAppServerScript({
      dir: root,
      importLines: [
        'import { appendFile } from "node:fs/promises";',
      ],
      setupLines: [
        `const requestLogPath = ${JSON.stringify(requestLogPath)};`,
      ],
      bodyLines: [
        'for await (const line of rl) {',
        '  if (!line.trim()) continue;',
        '  const msg = JSON.parse(line);',
        '  await appendFile(requestLogPath, JSON.stringify({ id: msg.id ?? null, method: msg.method, params: msg.params ?? null, result: msg.result ?? null, error: msg.error ?? null }) + "\\n");',
        '  if (msg.method === "initialize") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake-codex-app-server", version: "0.0.0" } } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "initialized") continue;',
        '  if (msg.method === "thread/start") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: "thread-started", model: "gpt-5.4", serviceTier: null } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "thread/resume") {',
        '    const adoptsOverrideThread = Object.prototype.hasOwnProperty.call(msg.params ?? {}, "model") || Object.prototype.hasOwnProperty.call(msg.params ?? {}, "serviceTier");',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: adoptsOverrideThread ? "thread-overrides" : (msg.params?.threadId ?? null), model: msg.params?.model ?? "gpt-5.4", serviceTier: Object.prototype.hasOwnProperty.call(msg.params ?? {}, "serviceTier") ? msg.params.serviceTier : null } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "collaborationMode/list") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: [{ id: "default", name: "Default", mode: "default" }, { id: "plan", name: "Plan", mode: "plan", reasoning_effort: "medium" }] }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "model/list") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: [{ id: "gpt-5.4", displayName: "GPT-5.4", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balances speed and reasoning depth for everyday tasks" }, { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" }], defaultReasoningEffort: "medium" }] }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "turn/start") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-1" }, threadId: msg.params?.threadId ?? null } }) + "\\n");',
        '    setTimeout(() => {',
        '      process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: "turn-1" } } }) + "\\n");',
        '    }, 5);',
        '    continue;',
        '  }',
        '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
        '}',
      ],
    });

    envScope.patch({
      HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
      HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '10000',
    });

    const { session } = createRunCodexFakeSession({
      path: root,
      host: 'localhost',
      flavor: 'codex',
      codexSessionId: 'thread-existing',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      modelOverrideV1: { v: 1, updatedAt: 3, modelId: 'gpt-5.4' },
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 4,
        overrides: {
          reasoning_effort: { updatedAt: 4, value: 'high' },
          service_tier: { updatedAt: 5, value: 'fast' },
        },
      },
      sessionModeOverrideV1: { v: 1, updatedAt: 2, modeId: 'plan' },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 2, modeId: 'plan' },
    });

    initializeBackendRunSessionImpl = async (_opts: any) => ({
      session,
      reconnectionHandle: null,
      reportedSessionId: 'sess_1',
      attachedToExistingSession: false,
    });

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async () => {
      waitCallCount += 1;
      if (waitCallCount === 1) {
        return {
          message: 'plan this change',
          mode: {
            permissionMode: 'default',
            permissionModeUpdatedAt: 1,
          },
          isolate: false,
          hash: 'hash-1',
        };
      }
      return null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      agentModeId: 'plan',
      agentModeUpdatedAt: 2,
      codexBackendMode: 'appServer',
      directory: root,
    }).then(() => ({ ok: true as const })).catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }

    const requestLog = (await readFile(requestLogPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(requestLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'thread/resume',
          params: expect.objectContaining({
            threadId: 'thread-existing',
            model: 'gpt-5.4',
            serviceTier: 'fast',
            config: {
              model_reasoning_effort: 'high',
            },
            persistExtendedHistory: true,
          }),
        }),
      ]),
    );

    const firstTurnStart = requestLog.find((entry) => entry.method === 'turn/start');
    expect(firstTurnStart).toMatchObject({
      params: expect.objectContaining({
        threadId: 'thread-overrides',
        model: 'gpt-5.4',
        effort: 'high',
        serviceTier: 'fast',
        collaborationMode: {
          mode: 'plan',
          settings: {
            model: 'gpt-5.4',
            reasoning_effort: 'high',
            developer_instructions: null,
          },
        },
      }),
    });
  });

  it('emits thinking before starting a legacy MCP turn', async () => {
    const root = await createTempDir('happier-codex-mcp-thinking-');
    tempRoots.add(root);
    await mkdir(root, { recursive: true });

    const { session } = createRunCodexFakeSession({
      path: root,
      host: 'localhost',
      flavor: 'codex',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    });

    let keepAliveCallsAtStart: unknown[][] = [];
    createCodexMcpClientImpl = () => ({
      connect: vi.fn(async () => undefined),
      startSession: vi.fn(async () => {
        keepAliveCallsAtStart = [...session.keepAlive.mock.calls];
        return {};
      }),
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
    });

    initializeBackendRunSessionImpl = async (_opts: any) => ({
      session,
      reconnectionHandle: null,
      reportedSessionId: 'sess_mcp',
      attachedToExistingSession: false,
    });

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async () => {
      waitCallCount += 1;
      if (waitCallCount === 1) {
        return {
          message: 'implement this',
          mode: {
            permissionMode: 'default',
            permissionModeUpdatedAt: 1,
          },
          isolate: false,
          hash: 'hash-mcp-1',
        };
      }
      return null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      codexBackendMode: 'mcp',
      directory: root,
    }).then(() => ({ ok: true as const })).catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }

    expect(keepAliveCallsAtStart.at(-1)).toEqual([true, 'remote']);
  });

  it('seeds fresh app-server thread/start with selected model and Fast overrides before the first turn', async () => {
    const root = await createTempDir('happier-codex-run-plan-fresh-start-');
    tempRoots.add(root);
    await mkdir(root, { recursive: true });
    const requestLogPath = join(root, 'requests.log');

    const fakeAppServer = await writeFakeCodexAppServerScript({
      dir: root,
      importLines: [
        'import { appendFile } from "node:fs/promises";',
      ],
      setupLines: [
        `const requestLogPath = ${JSON.stringify(requestLogPath)};`,
      ],
      bodyLines: [
        'for await (const line of rl) {',
        '  if (!line.trim()) continue;',
        '  const msg = JSON.parse(line);',
        '  await appendFile(requestLogPath, JSON.stringify({ id: msg.id ?? null, method: msg.method, params: msg.params ?? null, result: msg.result ?? null, error: msg.error ?? null }) + "\\n");',
        '  if (msg.method === "initialize") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake-codex-app-server", version: "0.0.0" } } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "initialized") continue;',
        '  if (msg.method === "thread/start") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: "thread-started", model: msg.params?.model ?? "gpt-5.4", serviceTier: Object.prototype.hasOwnProperty.call(msg.params ?? {}, "serviceTier") ? msg.params.serviceTier : null } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "thread/resume") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: msg.params?.threadId ?? null, model: msg.params?.model ?? "gpt-5.4", serviceTier: Object.prototype.hasOwnProperty.call(msg.params ?? {}, "serviceTier") ? msg.params.serviceTier : null } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "collaborationMode/list") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: [{ id: "default", name: "Default", mode: "default" }, { id: "plan", name: "Plan", mode: "plan", reasoning_effort: "medium" }] }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "model/list") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: [{ id: "gpt-5.4", displayName: "GPT-5.4", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balances speed and reasoning depth for everyday tasks" }, { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" }], defaultReasoningEffort: "medium" }] }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "turn/start") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-1" }, threadId: msg.params?.threadId ?? null } }) + "\\n");',
        '    setTimeout(() => {',
        '      process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: "turn-1" } } }) + "\\n");',
        '    }, 5);',
        '    continue;',
        '  }',
        '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
        '}',
      ],
    });

    envScope.patch({
      HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
      HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '10000',
    });

    const { session } = createRunCodexFakeSession({
      path: root,
      host: 'localhost',
      flavor: 'codex',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      modelOverrideV1: { v: 1, updatedAt: 3, modelId: 'gpt-5.4' },
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 4,
        overrides: {
          reasoning_effort: { updatedAt: 4, value: 'high' },
          service_tier: { updatedAt: 5, value: 'fast' },
        },
      },
      sessionModeOverrideV1: { v: 1, updatedAt: 2, modeId: 'plan' },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 2, modeId: 'plan' },
    });

    initializeBackendRunSessionImpl = async (_opts: any) => ({
      session,
      reconnectionHandle: null,
      reportedSessionId: 'sess_fresh',
      attachedToExistingSession: false,
    });

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async () => {
      waitCallCount += 1;
      if (waitCallCount === 1) {
        return {
          message: 'plan this fresh change',
          mode: {
            permissionMode: 'default',
            permissionModeUpdatedAt: 1,
          },
          isolate: false,
          hash: 'hash-fresh-1',
        };
      }
      return null;
    };

    const { runCodex } = await import('./runCodex');
    const { resolveEffectiveCodingPromptText } = await import('@/agent/prompting/coding/resolveEffectiveCodingPrompt');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      agentModeId: 'plan',
      agentModeUpdatedAt: 2,
      codexBackendMode: 'appServer',
      directory: root,
    }).then(() => ({ ok: true as const })).catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }

    expect(resolveEffectiveCodingPromptText).toHaveBeenCalledWith(
      expect.objectContaining({
        baseOverride: undefined,
      }),
    );

    const requestLog = (await readFile(requestLogPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(requestLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'thread/start',
          params: expect.objectContaining({
            cwd: root,
            model: 'gpt-5.4',
            serviceTier: 'fast',
            config: {
              model_reasoning_effort: 'high',
            },
            persistExtendedHistory: true,
          }),
        }),
      ]),
    );

    const firstTurnStart = requestLog.find((entry) => entry.method === 'turn/start');
    expect(firstTurnStart).toMatchObject({
      params: expect.objectContaining({
        threadId: 'thread-started',
        model: 'gpt-5.4',
        effort: 'high',
        serviceTier: 'fast',
        collaborationMode: {
          mode: 'plan',
          settings: {
            model: 'gpt-5.4',
            reasoning_effort: 'high',
            developer_instructions: null,
          },
        },
      }),
    });
  });
});
