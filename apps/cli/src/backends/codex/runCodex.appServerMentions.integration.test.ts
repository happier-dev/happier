import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Credentials } from '@/persistence';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import {
  createCodexAppServerTestEnvScope,
  writeFakeCodexAppServerScript,
} from './appServer/testkit/fakeCodexAppServer';

type FakeSession = {
  sessionId: string;
  rpcHandlerManager: {
    registerHandler: ReturnType<typeof vi.fn>;
    invokeLocal: ReturnType<typeof vi.fn>;
  };
  onUserMessage: ReturnType<typeof vi.fn>;
  sendSessionEvent: ReturnType<typeof vi.fn>;
  keepAlive: ReturnType<typeof vi.fn>;
  sendSessionDeath: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  updateAgentState: ReturnType<typeof vi.fn>;
  updateMetadata: ReturnType<typeof vi.fn>;
  getMetadataSnapshot: ReturnType<typeof vi.fn>;
  fetchLatestUserPermissionIntentFromTranscript: ReturnType<typeof vi.fn>;
  waitForMetadataUpdate: ReturnType<typeof vi.fn>;
  popPendingMessage: ReturnType<typeof vi.fn>;
  sendCodexMessage: ReturnType<typeof vi.fn>;
  sendAgentMessage: ReturnType<typeof vi.fn>;
  getLastObservedMessageSeq: ReturnType<typeof vi.fn>;
  getLastObservedUserMessageSeq: ReturnType<typeof vi.fn>;
  markObservedUserMessage: ReturnType<typeof vi.fn>;
  beginTurnAssistantTextSnapshot: ReturnType<typeof vi.fn>;
};

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

function createFakeSession(initialMetadata: Record<string, unknown>): {
  session: FakeSession;
  getMetadataSnapshot: () => Record<string, unknown>;
} {
  let metadata = { ...initialMetadata };
  let lastObservedMessageSeq = 0;
  let lastObservedUserMessageSeq = 0;

  const session = {
    sessionId: 'sess_1',
    rpcHandlerManager: {
      registerHandler: vi.fn(),
      invokeLocal: vi.fn(),
    },
    onUserMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
    keepAlive: vi.fn(),
    sendSessionDeath: vi.fn(),
    close: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    updateAgentState: vi.fn((updater: (state: Record<string, unknown>) => Record<string, unknown>) => updater({})),
    updateMetadata: vi.fn((updater: (current: Record<string, unknown>) => Record<string, unknown>) => {
      metadata = updater(metadata);
      return metadata;
    }),
    getMetadataSnapshot: vi.fn(() => metadata),
    fetchLatestUserPermissionIntentFromTranscript: vi.fn(async () => null),
    waitForMetadataUpdate: vi.fn(async () => false),
    popPendingMessage: vi.fn(async () => false),
    sendCodexMessage: vi.fn(() => {
      lastObservedMessageSeq += 1;
    }),
    sendAgentMessage: vi.fn(() => {
      lastObservedMessageSeq += 1;
    }),
    getLastObservedMessageSeq: vi.fn(() => lastObservedMessageSeq),
    getLastObservedUserMessageSeq: vi.fn(() => lastObservedUserMessageSeq),
    markObservedUserMessage: vi.fn(() => {
      lastObservedUserMessageSeq += 1;
      lastObservedMessageSeq = Math.max(lastObservedMessageSeq, lastObservedUserMessageSeq);
    }),
    beginTurnAssistantTextSnapshot: vi.fn(() => 'turn-token'),
  };

  return {
    session,
    getMetadataSnapshot: () => metadata,
  };
}

const SKILL_ITEM = {
  name: 'review',
  displayName: 'Review',
  description: 'Review a diff',
  path: '/w/.codex/skills/review/SKILL.md',
  enabled: true,
  origin: 'codex_native',
};

const VENDOR_ITEM = {
  id: 'plugin://linear@happier',
  name: 'linear',
  displayName: 'Linear',
  vendorPluginRef: 'plugin://linear@happier',
  installed: true,
  enabled: true,
  mentionable: true,
};

/**
 * The wiring gate for EU-5. The resolver being correct in isolation proves nothing if the
 * dispatch path never calls it — that exact gap shipped once in this corridor (L8 F-1), so
 * this test drives a real `runCodex` app-server session and asserts the provider items on the
 * wire, from an envelope carrying `mentions[]` ONLY and no legacy arrays (R-10).
 */
describe('runCodex app-server composer reference resolution', () => {
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

  it('sends resolved skill and vendor-plugin items for a turn whose envelope carries only mentions[]', async () => {
    const { MENTION_KIND_V1, buildMentionRefForKindV1 } = await import('@happier-dev/protocol');
    const root = await createTempDir('happier-codex-run-mentions-');
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
        `const skills = ${JSON.stringify([{ cwd: 'x', skills: [SKILL_ITEM] }])};`,
        `const plugins = ${JSON.stringify([VENDOR_ITEM])};`,
      ],
      bodyLines: [
        'for await (const line of rl) {',
        '  if (!line.trim()) continue;',
        '  const msg = JSON.parse(line);',
        '  await appendFile(requestLogPath, JSON.stringify({ id: msg.id ?? null, method: msg.method, params: msg.params ?? null }) + "\\n");',
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
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: msg.params?.threadId ?? null, model: "gpt-5.4", serviceTier: null } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "collaborationMode/list") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: [{ id: "default", name: "Default", mode: "default" }] }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "model/list") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: [{ id: "gpt-5.4", displayName: "GPT-5.4", isDefault: true }] }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "skills/list") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { data: skills } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "plugin/list") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { data: plugins } }) + "\\n");',
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

    const { session } = createFakeSession({
      path: root,
      host: 'localhost',
      flavor: 'codex',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
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
          message: 'run $review with @linear',
          mode: {
            permissionMode: 'default',
            permissionModeUpdatedAt: 1,
            promptMetadata: {
              happierStructuredInputV1: {
                v: 1,
                mentions: [
                  {
                    kind: MENTION_KIND_V1.skill,
                    ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'vendor:codex:review'),
                    token: '$review',
                    start: 4,
                    end: 11,
                  },
                  {
                    kind: MENTION_KIND_V1.vendorPlugin,
                    ref: buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, 'plugin://linear@happier'),
                    token: '@linear',
                    start: 17,
                    end: 24,
                  },
                ],
              },
            },
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

    expect(requestLog.map((entry) => entry.method).join(' | ')).toContain('turn/start');
    const turnStart = requestLog.find((entry) => entry.method === 'turn/start');
    expect(turnStart.params.input).toEqual([
      { type: 'text', text: 'run $review with @linear' },
      { type: 'mention', name: 'Linear', path: 'plugin://linear@happier' },
      { type: 'skill', name: 'review', path: '/w/.codex/skills/review/SKILL.md' },
    ]);
  }, 240_000);
});
