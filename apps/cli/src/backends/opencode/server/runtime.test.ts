import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  ProviderPromptSubmissionRejectedBeforeEffectError,
  type ProviderPromptWithMeta,
} from '@/agent/runtime/providerPromptSubmission';
import { buildChangeTitleInstruction } from '@/agent/runtime/changeTitleInstruction';
import { logger } from '@/ui/logger';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { resetConnectedServiceRuntimeAuthFailureReportDedupeForTests } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { configuration, reloadConfiguration } from '@/configuration';

import {
  createOpenCodeServerRuntime as createOpenCodeServerRuntimeProduction,
  OPENCODE_CONNECTED_AUTH_NOT_MATERIALIZED_CODE,
} from './runtime';
import { isTerminalOpenCodeToolPartStatus } from './runtime/createOpenCodeForegroundToolTracker';
import { OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE } from './runtime/createOpenCodeManagedServerTurnInterruptionSupervisor';
import {
  OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV,
  resolveOpenCodeManagedServerLaunchFingerprint,
} from './openCodeManagedServerEnv';
import {
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  OPEN_CODE_BROKER_STATE_PATH_ENV,
  OPEN_CODE_BROKER_LOAD_NONCE_ENV,
  ensureOpenCodeBrokerPluginAssets,
  serializeOpenCodeBrokerSelections,
} from '../brokerPlugin';
import type { OpenCodeManagedServerIdentity, OpenCodeManagedServerIdentityChange } from './openCodeManagedServerIdentity';
import {
  createOpenCodeServerRuntimeClient,
  type OpenCodeGlobalEventDelivery,
  type OpenCodeServerRuntimeClient,
} from './client';
import {
  resolveSharedManagedOpenCodeServerBaseUrl,
  type SharedManagedOpenCodeServerState,
} from './sharedManagedServer';
import type { OpenCodeGlobalEvent } from './types';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';

const mockNotifyDaemonConnectedServiceRuntimeAuthFailure = vi.hoisted(() => vi.fn(async () => ({})));
const mockQueryDaemonOpenCodeBrokerLoadHandshake = vi.hoisted(() => vi.fn());
vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceRuntimeAuthFailure: mockNotifyDaemonConnectedServiceRuntimeAuthFailure,
  queryDaemonOpenCodeBrokerLoadHandshake: mockQueryDaemonOpenCodeBrokerLoadHandshake,
}));

function createScheduledRuntimeAuthRecoveryReport(input: Readonly<{ includeTranscriptEvent?: boolean }> = {}) {
  const diagnostic = {
    code: 'recovery_retry_scheduled',
    failurePhase: 'runtime_auth_recovery',
    source: 'runtime_auth_recovery',
    serviceId: 'openai',
    profileId: 'primary',
    groupId: 'team-pool',
    retryable: true,
    suggestedActions: [],
    diagnostics: { runtimeFailureKind: 'usage_limit' },
  };
  const transcriptEvent = {
    type: 'connected-service-runtime-auth-recovery',
    status: 'retry_scheduled',
    serviceId: 'openai',
    profileId: 'primary',
    groupId: 'team-pool',
    nextRetryAtMs: 1_700_000_100_000,
    terminal: false,
    diagnostic,
  };
  return {
    ok: true,
    result: {
      status: 'recovery_retry_scheduled',
      recovery: {
        status: 'scheduled',
        retryable: true,
        nextRetryAtMs: 1_700_000_100_000,
      },
      uxDiagnostic: diagnostic,
      ...(input.includeTranscriptEvent === false ? {} : { transcriptEvent }),
    },
  };
}

function createFakePermissionHandler() {
  return {
    handleToolCall: vi.fn(async () => ({ decision: 'approved' as const })),
  } satisfies Pick<ProviderEnforcedPermissionHandler, 'handleToolCall'>;
}

function createOpenCodeServerRuntime(
  params: Omit<Parameters<typeof createOpenCodeServerRuntimeProduction>[0], 'happierMcpAdmission'>
    & Partial<Pick<Parameters<typeof createOpenCodeServerRuntimeProduction>[0], 'happierMcpAdmission'>>,
  deps?: Parameters<typeof createOpenCodeServerRuntimeProduction>[1],
): ReturnType<typeof createOpenCodeServerRuntimeProduction> {
  const happierMcpAdmission = params.happierMcpAdmission ?? { kind: 'required' as const };
  const mcpServers = params.happierMcpAdmission === undefined && Object.keys(params.mcpServers).length === 0
    ? createReadyMcpServers()
    : params.mcpServers;
  return createOpenCodeServerRuntimeProduction({
    ...params,
    mcpServers,
    happierMcpAdmission,
  }, deps);
}

type OpenCodeRuntimePromptHarness = Readonly<{
  sendPromptWithMeta(params: ProviderPromptWithMeta): Promise<void>;
}>;

function createReadyMcpServers() {
  return {
    happier: {
      command: process.execPath,
      args: ['--version'],
    },
  };
}

type OpenCodePromptAsyncCall = Parameters<OpenCodeServerRuntimeClient['sessionPromptAsync']>[0];

type FakeManagedServerIdentity = {
  baseUrl: string;
  pid: number;
  startedAtMs: number;
  generationKey: string;
};

function createFakeClient(opts: Readonly<{
  emitServerConnectedOnSubscribe?: boolean;
}> = {}) {
  let onEvent: ((evt: OpenCodeGlobalEvent, delivery: OpenCodeGlobalEventDelivery) => void) | null = null;
  let directoryOverride: string | null = null;
  let statusType: string = 'idle';
  let managedServerIdentity: FakeManagedServerIdentity | null = {
    baseUrl: 'http://127.0.0.1:7777',
    pid: 4242,
    startedAtMs: 1,
    generationKey: 'gen-initial',
  };
  const clientBase = {
    sessionList: vi.fn(async () => ([] as unknown[])),
    sessionCreate: vi.fn<OpenCodeServerRuntimeClient['sessionCreate']>(async () => ({ id: 'ses_1' })),
    sessionGet: vi.fn(async ({ sessionId }: { sessionId: string }) => ({ id: sessionId })),
    sessionUpdate: vi.fn(async ({ sessionId }: { sessionId: string }) => ({ id: sessionId })),
    sessionMessagesList: vi.fn(async (_params: { sessionId: string }) => ([] as unknown[])),
    sessionDiff: vi.fn(async () => ([] as unknown[])),
    sessionPromptAsync: vi.fn<OpenCodeServerRuntimeClient['sessionPromptAsync']>(async () => {}),
    sessionSummarize: vi.fn(async (_input?: unknown) => {}),
    sessionAbort: vi.fn(async (_input?: unknown) => {}),
    sessionFork: vi.fn(async () => ({ id: 'ses_fork' })),
    sessionTodo: vi.fn(async () => ([] as unknown[])),
    sessionStatusList: vi.fn(async () => ({ ses_1: { type: statusType } })),
    setDirectoryOverride: vi.fn((next: string) => {
      const changed = directoryOverride !== null && directoryOverride !== next;
      directoryOverride = next;
      return changed;
    }),
    globalConfigGet: vi.fn(async () => ({ model: 'openai/gpt-5.2' })),
    agentsList: vi.fn(async () => ([{ name: 'build', description: 'Build agent' }])),
    appSkills: vi.fn(async () => ([] as unknown[])),
    providersList: vi.fn(async () => ([
      {
        id: 'openai',
        env: ['OPENAI_API_KEY'],
        models: ({
          'gpt-5.2': {
            id: 'gpt-5.2',
            name: 'GPT-5.2',
            status: 'active',
            capabilities: { toolcall: true, reasoning: true, input: { text: true, contextWindow: 400000 } },
            variants: {
              low: { reasoningEffort: 'low' },
              medium: { reasoningEffort: 'medium' },
              high: { reasoningEffort: 'high' },
            },
          },
        }) as Record<string, unknown>,
      },
    ])),
    mcpAdd: vi.fn(async (_input?: unknown) => ({ status: 'connected' as const })),
    mcpDisconnect: vi.fn(async (_input?: unknown) => {}),
    questionReply: vi.fn(async () => true),
    questionReject: vi.fn(async () => true),
    questionList: vi.fn(async () => ([] as unknown[])),
    permissionReply: vi.fn(async () => true),
    permissionList: vi.fn(async () => ([] as unknown[])),
    subscribeGlobalEvents: vi.fn(async ({ onEvent: cb }: {
      signal: AbortSignal;
      onEvent: (evt: OpenCodeGlobalEvent, delivery: OpenCodeGlobalEventDelivery) => void;
    }) => {
      onEvent = cb;
      if (opts.emitServerConnectedOnSubscribe !== false) {
        cb({
          directory: '/tmp',
          payload: { type: 'server.connected', properties: {} },
        }, { provenance: 'connection-boundary', connectionGeneration: 1 });
      }
    }),
    getManagedServerIdentity: () => managedServerIdentity as any,
    dispose: vi.fn(async (_input?: unknown) => {}),
    // Real OpenCode SSE subscribers do not await the callback return value.
    __emit: async (evt: OpenCodeGlobalEvent) => {
      onEvent?.(evt, { provenance: 'accepted-live', connectionGeneration: 1 });
    },
    __emitUntrusted: async (evt: OpenCodeGlobalEvent) => {
      onEvent?.(evt, { provenance: 'untrusted-observation', connectionGeneration: 1 });
    },
    __setStatusType: (next: string) => {
      statusType = next;
    },
    __getDirectoryOverride: () => directoryOverride,
    __setManagedServerIdentity: (next: FakeManagedServerIdentity | null) => {
      managedServerIdentity = next;
    },
  };
  const client = Object.assign(clientBase, {
    sessionMessagesListRaw: vi.fn(async (params: { sessionId: string }) => await clientBase.sessionMessagesList(params)),
  }) satisfies OpenCodeServerRuntimeClient & {
    __emit: (evt: OpenCodeGlobalEvent) => Promise<void>;
    __emitUntrusted: (evt: OpenCodeGlobalEvent) => Promise<void>;
    __setStatusType: (next: string) => void;
    __getDirectoryOverride: () => string | null;
    __setManagedServerIdentity: (next: FakeManagedServerIdentity | null) => void;
  };

  return client;
}

function readOpenCodePromptAsyncCall(
  client: ReturnType<typeof createFakeClient>,
  index: number,
): OpenCodePromptAsyncCall {
  const call = client.sessionPromptAsync.mock.calls[index];
  if (!call) {
    throw new Error(`Expected sessionPromptAsync call ${index}`);
  }
  return call[0];
}

function useCompletedProviderErrorInventory(
  client: ReturnType<typeof createFakeClient>,
  error: unknown,
  messageId = 'msg_completed_provider_error',
): void {
  const promptMessageId = readOpenCodePromptAsyncCall(client, 0).messageId;
  if (!promptMessageId) throw new Error('Expected prompt_async to include the current user message id');
  client.sessionMessagesList = vi.fn(async () => [
    {
      info: { id: promptMessageId, role: 'user', sessionID: 'ses_1', time: { created: 10 } },
      parts: [{ id: `part_${promptMessageId}`, type: 'text', text: 'hello' }],
    },
    {
      info: {
        id: messageId,
        role: 'assistant',
        sessionID: 'ses_1',
        parentID: promptMessageId,
        time: { created: 11, completed: 12 },
        error,
      },
      parts: [],
    },
  ]);
}

function createFakeSession(sessionId = 'happy_sess_opencode') {
  const meta: Record<string, unknown> = {};
  let lastSeq = 0;
  return {
    sessionId,
    keepAlive: vi.fn(),
    sendAgentMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
    sessionTurnLifecycle: {
      beginTurn: vi.fn(async () => ({ turnId: 'session-turn-1' })),
      attachProviderTurnId: vi.fn(async (_input?: unknown) => {}),
      appendTranscriptAnchors: vi.fn(async (_input?: unknown) => {}),
      completeTurn: vi.fn(async (_input?: unknown) => {}),
      failTurn: vi.fn(async (_input?: unknown) => {}),
      cancelTurn: vi.fn(async (_input?: unknown) => {}),
      endSession: vi.fn(async (_input?: unknown) => {}),
      markRollbackEligible: vi.fn(async (_input?: unknown) => {}),
      markRolledBack: vi.fn(async (_input?: unknown) => {}),
    },
    sendUserTextMessageCommitted: vi.fn(async (_input?: unknown) => {}),
    sendAgentMessageCommitted: vi.fn(async (_input?: unknown) => {}),
    ensureMetadataSnapshot: vi.fn(async () => ({ ok: true })),
    getMetadataSnapshot: () => meta,
    updateMetadata: vi.fn(async (updater: (prev: any) => any) => {
      const next = updater(meta);
      Object.keys(meta).forEach((k) => delete meta[k]);
      Object.assign(meta, next);
    }),
    getLastObservedMessageSeq: () => lastSeq,
    __setLastObservedMessageSeq: (value: number) => {
      lastSeq = value;
    },
    __getMetadata: () => meta,
  } as any;
}

type CommittedTranscriptBody = Readonly<Record<string, unknown> & {
  type?: 'message' | 'thinking';
  message?: string;
  text?: string;
  sidechainId?: string | null;
}>;

type CommittedTranscriptMeta = Readonly<Record<string, unknown> & {
  happierStreamKey?: string;
  happierStreamSegmentV1?: Record<string, unknown>;
  importedFrom?: string;
  remoteSessionId?: string;
}>;

type CommittedTranscriptRow = Readonly<{
  provider: unknown;
  body: CommittedTranscriptBody;
  localId: string | undefined;
  meta: CommittedTranscriptMeta;
  callOrder: number | undefined;
}>;

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getCommittedTranscriptRows(
  session: ReturnType<typeof createFakeSession>,
  opts?: { type?: 'message' | 'thinking'; sidechainId?: string | null },
): CommittedTranscriptRow[] {
  const rows = (session.sendAgentMessageCommitted as any).mock.calls
    .map((call: any[], index: number) => ({
      provider: call?.[0],
      body: (call?.[1] ?? {}) as CommittedTranscriptBody,
      localId: readOptionalString(call?.[2]?.localId),
      meta: (call?.[2]?.meta ?? {}) as CommittedTranscriptMeta,
      callOrder: (session.sendAgentMessageCommitted as any).mock.invocationCallOrder?.[index],
    })) as CommittedTranscriptRow[];
  return rows
    .filter((row) => (opts?.type ? row.body.type === opts.type : true))
    .filter((row) => (opts?.sidechainId !== undefined ? (row.body.sidechainId ?? null) === opts.sidechainId : true));
}

async function flushTranscriptCommitMicrotasks(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

function withEnvForTest(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function observePromiseSettlement<T>(promise: Promise<T>) {
  const state: { status: 'pending' | 'resolved' | 'rejected'; error?: unknown } = { status: 'pending' };
  void promise.then(
    () => {
      state.status = 'resolved';
    },
    (error: unknown) => {
      state.status = 'rejected';
      state.error = error;
    },
  );
  return state;
}

async function advanceTimersAndFlush(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flushTranscriptCommitMicrotasks();
}

function sentAgentMessagesOfType(session: ReturnType<typeof createFakeSession>, type: string): unknown[] {
  return session.sendAgentMessage.mock.calls
    .filter((call: unknown[]) => call?.[0] === 'opencode' && (call?.[1] as { type?: unknown } | undefined)?.type === type)
    .map((call: unknown[]) => call[1]);
}

async function emitAssistantMessageUpdated(
  client: ReturnType<typeof createFakeClient>,
  opts: {
    sessionId?: string;
    messageId: string;
    finish?: string;
    completed?: number | null;
    role?: string;
    extraInfo?: Record<string, unknown>;
  },
): Promise<void> {
  const completed = opts.completed === undefined ? 1 : opts.completed;
  await client.__emit({
    directory: '/tmp',
    payload: {
      type: 'message.updated',
      properties: {
        info: {
          id: opts.messageId,
          role: opts.role ?? 'assistant',
          sessionID: opts.sessionId ?? 'ses_1',
          ...(opts.finish === undefined ? {} : { finish: opts.finish }),
          ...(completed === null ? {} : { time: { completed } }),
          ...(opts.extraInfo ?? {}),
        },
      },
    },
  });
}

async function emitTerminalAssistantAndIdle(
  client: ReturnType<typeof createFakeClient>,
  opts: {
    sessionId?: string;
    messageId: string;
    finish?: string;
    completed?: number | null;
  },
): Promise<void> {
  await emitAssistantMessageUpdated(client, {
    sessionId: opts.sessionId,
    messageId: opts.messageId,
    finish: opts.finish ?? 'stop',
    completed: opts.completed,
  });
  await flushTranscriptCommitMicrotasks();
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(1);
    await flushTranscriptCommitMicrotasks();
  } else {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await flushTranscriptCommitMicrotasks();
  }
  await client.__emit({
    directory: '/tmp',
    payload: { type: 'session.idle', properties: { sessionID: opts.sessionId ?? 'ses_1' } },
  });
  await flushTranscriptCommitMicrotasks();
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
    await flushTranscriptCommitMicrotasks();
  }
}

function mirrorLifecycleMarkersForTest(session: ReturnType<typeof createFakeSession>): ReturnType<typeof createFakeSession> {
  session.sendAgentMessage = vi.fn((provider: unknown, body: { type?: string; id?: string }) => {
    if (provider !== 'opencode') return;
    if (body.type === 'task_started') {
      void session.sessionTurnLifecycle.beginTurn({ provider: 'opencode', providerTurnId: body.id });
    }
    if (body.type === 'task_complete') {
      void session.sessionTurnLifecycle.completeTurn({ provider: 'opencode', providerTurnId: body.id });
    }
  });
  return session;
}

async function beginOpenCodePromptForTest(opts?: {
  client?: ReturnType<typeof createFakeClient>;
  session?: ReturnType<typeof createFakeSession>;
  permissionHandler?: Pick<ProviderEnforcedPermissionHandler, 'handleToolCall'>;
  localId?: string;
  env?: NodeJS.ProcessEnv;
  getPermissionMode?: () => 'default' | 'read-only' | 'plan' | 'yolo' | 'acceptEdits' | 'bypassPermissions';
}) {
  const client = opts?.client ?? createFakeClient();
  const session = opts?.session ?? createFakeSession();
  const onThinkingChange = vi.fn();
  const runtime = createOpenCodeServerRuntime({
    directory: '/tmp',
    env: opts?.env,
    session,
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    permissionHandler: (opts?.permissionHandler ?? createFakePermissionHandler()) as unknown as ProviderEnforcedPermissionHandler,
    onThinkingChange,
    getPermissionMode: opts?.getPermissionMode,
  }, {
    createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
  });

  await runtime.startOrLoad({});
  runtime.beginTurn();
  const promptPromise = (runtime as unknown as {
    sendPromptWithMeta: (params: { text: string; localId: string }) => Promise<void>;
  }).sendPromptWithMeta({ text: 'hello', localId: opts?.localId ?? 'local-red-runtime' });
  void promptPromise.catch(() => undefined);
  await flushTranscriptCommitMicrotasks();
  expect(client.sessionPromptAsync.mock.calls.length).toBe(1);
  return { client, session, runtime, promptPromise, onThinkingChange };
}

describe('createOpenCodeServerRuntime', () => {
  const OPENCODE_CHANGE_TITLE_INSTRUCTION = buildChangeTitleInstruction({ preferredToolName: 'happier_change_title' });

  afterEach(() => {
    // The shared daemon-report path dedupes on stable identity; tests reuse session ids and
    // classifications across cases, so the window must not leak between tests.
    resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
  });

  it('recognizes provider terminal tool statuses', () => {
    expect([
      'completed',
      'error',
      'failed',
      'cancelled',
      'canceled',
      'aborted',
    ].map((status) => [status, isTerminalOpenCodeToolPartStatus(status)])).toEqual([
      ['completed', true],
      ['error', true],
      ['failed', true],
      ['cancelled', true],
      ['canceled', true],
      ['aborted', true],
    ]);
    expect([
      'pending',
      'running',
      'in_progress',
      '',
    ].map((status) => [status, isTerminalOpenCodeToolPartStatus(status)])).toEqual([
      ['pending', false],
      ['running', false],
      ['in_progress', false],
      ['', false],
    ]);
  });

  it('starts a fresh provider session without an OpenCode runtime-activity producer', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await expect(runtime.startOrLoad({})).resolves.toBe('ses_1');
  });

  it('registers local MCP servers via the OpenCode /mcp API for the session directory', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {
        happier: {
          command: process.execPath,
          args: ['--version'],
          env: { HAPPIER_TEST_MCP: '1' },
        },
      },
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});

    expect(client.mcpAdd).toHaveBeenCalledWith({
      name: 'happier',
      config: {
        type: 'local',
        enabled: true,
        command: [process.execPath, '--version'],
        environment: { HAPPIER_TEST_MCP: '1' },
      },
    });
  });

  it('keeps startup non-blocking but waits for required Happier MCP readiness before the first prompt', async () => {
    const client = createFakeClient();
    let resolveSlowCustomMcp!: () => void;
    client.mcpAdd.mockImplementation(async (input?: unknown) => {
      const name = (input as { name?: unknown } | undefined)?.name;
      if (name === 'slow_custom') {
        await new Promise<void>((resolve) => {
          resolveSlowCustomMcp = resolve;
        });
      }
      return { status: 'connected' as const };
    });
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {
        slow_custom: {
          command: process.execPath,
          args: ['--version'],
        },
        happier: {
          command: process.execPath,
          args: ['--help'],
        },
      },
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    try {
      const startPromise = runtime.startOrLoad({});
      const startOutcome = observePromiseSettlement(startPromise);
      await flushTranscriptCommitMicrotasks();

      expect(startOutcome.status).toBe('resolved');
      expect(client.mcpAdd).toHaveBeenCalledTimes(1);

      runtime.beginTurn();
      const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
        text: 'first prompt requiring Happier tools',
        localId: 'local-required-happier-ready',
      });
      void promptPromise.catch(() => undefined);
      const promptOutcome = observePromiseSettlement(promptPromise);

      await flushTranscriptCommitMicrotasks();

      expect(promptOutcome.status).toBe('pending');
      expect(client.sessionPromptAsync).not.toHaveBeenCalled();

      resolveSlowCustomMcp();

      await expect.poll(() => client.mcpAdd.mock.calls.length).toBe(2);
      expect(client.mcpAdd).toHaveBeenNthCalledWith(2, {
        name: 'happier',
        config: {
          type: 'local',
          enabled: true,
          command: [process.execPath, '--help'],
        },
      });
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_required_happier_ready_done' });
      await expect(promptPromise).resolves.toBeUndefined();
      await expect(startPromise).resolves.toBe('ses_1');
    } finally {
      resolveSlowCustomMcp?.();
      await runtime.reset().catch(() => {});
    }
  });

  it('fails the turn before provider acceptance when required Happier MCP registration fails', async () => {
    const client = createFakeClient();
    client.mcpAdd.mockRejectedValueOnce(new Error('required bridge add failed'));
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {
        happier: {
          command: process.execPath,
          args: ['--version'],
        },
      },
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    try {
      await runtime.startOrLoad({});
      runtime.beginTurn();
      const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
        text: 'first prompt with unavailable Happier tools',
        localId: 'local-required-happier-failed',
      });
      void promptPromise.catch(() => undefined);

      await expect(promptPromise).rejects.toThrow(/required Happier MCP registration failed.*required bridge add failed/i);
      expect(client.sessionPromptAsync).not.toHaveBeenCalled();
      expect(session.sendAgentMessage).toHaveBeenCalledWith(
        'opencode',
        expect.objectContaining({
          type: 'turn_failed',
          code: 'opencode_prompt_not_dispatched',
        }),
      );
    } finally {
      await runtime.reset().catch(() => {});
    }
  });

  it('fails the turn before provider acceptance when Happier MCP returns a non-connected status', async () => {
    const client = createFakeClient();
    client.mcpAdd.mockResolvedValueOnce({
      status: 'failed',
      error: 'bridge tools unavailable',
    } as never);
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {
        happier: {
          command: process.execPath,
          args: ['--version'],
        },
      },
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    try {
      await runtime.startOrLoad({});
      runtime.beginTurn();
      const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
        text: 'first prompt after disconnected Happier MCP',
        localId: 'local-required-happier-status-failed',
      });
      void promptPromise.catch(() => undefined);

      await expect(promptPromise).rejects.toThrow(/required Happier MCP registration failed.*bridge tools unavailable/i);
      expect(client.sessionPromptAsync).not.toHaveBeenCalled();
      expect(session.sendAgentMessage).toHaveBeenCalledWith(
        'opencode',
        expect.objectContaining({
          type: 'turn_failed',
          code: 'opencode_prompt_not_dispatched',
        }),
      );
    } finally {
      await runtime.reset().catch(() => {});
    }
  });

  it('fails the turn before provider acceptance when required Happier MCP configuration is missing', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      happierMcpAdmission: { kind: 'required' },
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    try {
      await runtime.startOrLoad({});
      runtime.beginTurn();
      const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
        text: 'first prompt without Happier MCP configuration',
        localId: 'local-required-happier-config-missing',
      });
      void promptPromise.catch(() => undefined);

      await expect(promptPromise).rejects.toThrow(/required Happier MCP server configuration is missing/i);
      expect(client.mcpAdd).not.toHaveBeenCalled();
      expect(client.sessionPromptAsync).not.toHaveBeenCalled();
      expect(session.sendAgentMessage).toHaveBeenCalledWith(
        'opencode',
        expect.objectContaining({
          type: 'turn_failed',
          code: 'opencode_prompt_not_dispatched',
        }),
      );
    } finally {
      await runtime.reset().catch(() => {});
    }
  });

  it('allows the explicit execution-run admission mode to prompt without Happier MCP', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      happierMcpAdmission: { kind: 'not_available_for_execution_run' },
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    try {
      await runtime.startOrLoad({});
      runtime.beginTurn();
      const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
        text: 'execution run prompt without session MCP bridge',
        localId: 'local-execution-run-without-happier-mcp',
      });
      void promptPromise.catch(() => undefined);

      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_execution_run_done' });
      await expect(promptPromise).resolves.toBeUndefined();
    } finally {
      await runtime.reset().catch(() => {});
    }
  });

  it('waits for required Happier MCP registration to rerun in the resumed session directory', async () => {
    const client = createFakeClient();
    let resolveInitialDirectoryMcp!: () => void;
    client.mcpAdd
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          resolveInitialDirectoryMcp = resolve;
        });
        return { status: 'connected' as const };
      })
      .mockResolvedValueOnce({ status: 'connected' as const });
    client.sessionGet = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      id: sessionId,
      directory: '/tmp/resumed-opencode',
    }));
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {
        happier: {
          command: process.execPath,
          args: ['--version'],
        },
      },
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    try {
      await runtime.startOrLoad({ resumeId: 'ses_remote' });
      runtime.beginTurn();
      const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
        text: 'first prompt after resume',
        localId: 'local-required-happier-resume',
      });
      void promptPromise.catch(() => undefined);

      await flushTranscriptCommitMicrotasks();

      expect(client.setDirectoryOverride).toHaveBeenCalledWith('/tmp/resumed-opencode');
      expect(client.mcpAdd).toHaveBeenCalledTimes(1);
      expect(client.sessionPromptAsync).not.toHaveBeenCalled();

      resolveInitialDirectoryMcp();

      await expect.poll(() => client.mcpAdd.mock.calls.length).toBe(2);
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      await emitTerminalAssistantAndIdle(client, {
        sessionId: 'ses_remote',
        messageId: 'msg_required_happier_resume_done',
      });
      await expect(promptPromise).resolves.toBeUndefined();
    } finally {
      resolveInitialDirectoryMcp?.();
      await runtime.reset().catch(() => {});
    }
  });

  it('waits for the OpenCode server.connected startup event before dispatching the first prompt', async () => {
    const client = createFakeClient({ emitServerConnectedOnSubscribe: false });
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    try {
      await runtime.startOrLoad({});
      runtime.beginTurn();
      const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
        text: 'first prompt before startup readiness',
        localId: 'local-startup-ready',
      });
      void promptPromise.catch(() => undefined);
      const outcome = observePromiseSettlement(promptPromise);

      await flushTranscriptCommitMicrotasks();

      expect(client.sessionPromptAsync).not.toHaveBeenCalled();
      expect(outcome.status).toBe('pending');

      await client.__emit({
        directory: '/tmp',
        payload: { type: 'server.connected', properties: {} },
      });
      await flushTranscriptCommitMicrotasks();

      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_startup_ready_done' });
      await expect(promptPromise).resolves.toBeUndefined();
    } finally {
      await runtime.reset().catch(() => {});
    }
  });

  it('rejects when the turn resolves before the prompt is dispatched to OpenCode', async () => {
    const client = createFakeClient({ emitServerConnectedOnSubscribe: false });
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    try {
      await runtime.startOrLoad({});
      runtime.beginTurn();
      const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
        text: 'prompt that must not resolve before provider dispatch',
        localId: 'local-pre-dispatch-turn-resolution',
      });
      void promptPromise.catch(() => undefined);
      const outcome = observePromiseSettlement(promptPromise);

      await flushTranscriptCommitMicrotasks();

      expect(client.sessionPromptAsync).not.toHaveBeenCalled();
      expect(outcome.status).toBe('pending');

      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_external_before_prompt_dispatch' });

      await expect(promptPromise).rejects.toThrow(/before provider dispatch/i);
      expect(client.sessionPromptAsync).not.toHaveBeenCalled();
    } finally {
      await runtime.reset().catch(() => {});
    }
  });

  it('requires server.connected again after runtime reset before dispatching a prompt', async () => {
    const firstClient = createFakeClient();
    const secondClient = createFakeClient({ emitServerConnectedOnSubscribe: false });
    const clients = [firstClient, secondClient];
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => {
        const next = clients.shift();
        if (!next) throw new Error('No fake OpenCode client available');
        return next as unknown as OpenCodeServerRuntimeClient;
      },
    });

    try {
      await runtime.startOrLoad({});
      await runtime.reset();

      await runtime.startOrLoad({});
      runtime.beginTurn();
      const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
        text: 'first prompt after reset',
        localId: 'local-startup-ready-after-reset',
      });
      void promptPromise.catch(() => undefined);
      const outcome = observePromiseSettlement(promptPromise);

      await flushTranscriptCommitMicrotasks();

      expect(secondClient.sessionPromptAsync).not.toHaveBeenCalled();
      expect(outcome.status).toBe('pending');

      await secondClient.__emit({
        directory: '/tmp',
        payload: { type: 'server.connected', properties: {} },
      });
      await flushTranscriptCommitMicrotasks();

      await expect.poll(() => secondClient.sessionPromptAsync.mock.calls.length).toBe(1);

      await emitTerminalAssistantAndIdle(secondClient, { messageId: 'msg_startup_ready_after_reset_done' });
      await expect(promptPromise).resolves.toBeUndefined();
    } finally {
      await runtime.reset().catch(() => {});
    }
  });

  it('rejects a prompt waiting for server.connected when runtime reset replaces the session', async () => {
    const firstClient = createFakeClient({ emitServerConnectedOnSubscribe: false });
    const secondClient = createFakeClient({ emitServerConnectedOnSubscribe: false });
    secondClient.__setManagedServerIdentity({
      baseUrl: 'http://127.0.0.1:8888',
      pid: 5252,
      startedAtMs: 2,
      generationKey: 'gen-after-reset',
    });
    const clients = [firstClient, secondClient];
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => {
        const next = clients.shift();
        if (!next) throw new Error('No fake OpenCode client available');
        return next as unknown as OpenCodeServerRuntimeClient;
      },
    });

    try {
      await runtime.startOrLoad({});
      runtime.beginTurn();
      const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
        text: 'prompt that must not survive reset',
        localId: 'local-startup-ready-reset-abort',
      });
      void promptPromise.catch(() => undefined);
      const outcome = observePromiseSettlement(promptPromise);

      await flushTranscriptCommitMicrotasks();

      expect(firstClient.sessionPromptAsync).not.toHaveBeenCalled();
      expect(outcome.status).toBe('pending');

      await runtime.reset();
      await runtime.startOrLoad({});
      await secondClient.__emit({
        directory: '/tmp',
        payload: { type: 'server.connected', properties: {} },
      });
      await flushTranscriptCommitMicrotasks();

      await expect.poll(() => outcome.status).toBe('rejected');
      expect(firstClient.sessionPromptAsync).not.toHaveBeenCalled();
      expect(secondClient.sessionPromptAsync).not.toHaveBeenCalled();
    } finally {
      await runtime.reset().catch(() => {});
    }
  });

  it('creates the OpenCode session without waiting for slow MCP registration', async () => {
    const client = createFakeClient();
    let resolveMcpAdd!: () => void;
    client.mcpAdd.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        resolveMcpAdd = resolve;
      });
      return { status: 'connected' as const };
    });
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {
        slow_happier: {
          command: process.execPath,
          args: ['--version'],
        },
      },
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    const startPromise = runtime.startOrLoad({});
    const startState = observePromiseSettlement(startPromise);

    await flushTranscriptCommitMicrotasks();

    expect(client.mcpAdd).toHaveBeenCalledTimes(1);
    expect(client.sessionCreate).toHaveBeenCalledTimes(1);
    expect(startState.status).toBe('resolved');

    resolveMcpAdd();
    await startPromise;
  });

  it('retries MCP registration after OpenCode changes the session directory while registration is in flight', async () => {
    const client = createFakeClient();
    let resolveFirstMcpAdd!: () => void;
    client.mcpAdd
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          resolveFirstMcpAdd = resolve;
        });
        return { status: 'connected' as const };
      })
      .mockResolvedValueOnce({ status: 'connected' as const });
    client.sessionCreate.mockResolvedValueOnce({ id: 'ses_1', directory: '/tmp/opencode-session-dir' });
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {
        happier: {
          command: process.execPath,
          args: ['--version'],
        },
      },
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    expect(client.setDirectoryOverride).toHaveBeenCalledWith('/tmp/opencode-session-dir');
    expect(client.mcpAdd).toHaveBeenCalledTimes(1);

    resolveFirstMcpAdd();

    await expect.poll(() => client.mcpAdd.mock.calls.length).toBe(2);
    expect(client.mcpAdd).toHaveBeenNthCalledWith(2, {
      name: 'happier',
      config: {
        type: 'local',
        enabled: true,
        command: [process.execPath, '--version'],
      },
    });
  });

	  it('continues registering later MCP servers when one MCP returns a non-connected status', async () => {
	    const client = createFakeClient();
	    client.mcpAdd
	      .mockResolvedValueOnce({ status: 'disabled' as const })
	      .mockResolvedValueOnce({ status: 'connected' as const });
	    const session = createFakeSession();
	    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
	    const runtime = createOpenCodeServerRuntime({
	      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {
        broken_first: {
          command: process.execPath,
          args: ['--version'],
        },
        healthy_second: {
          command: process.execPath,
          args: ['--help'],
        },
      },
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});

    expect(client.mcpAdd).toHaveBeenCalledTimes(2);
    expect(client.mcpAdd).toHaveBeenNthCalledWith(1, {
      name: 'broken_first',
      config: {
        type: 'local',
        enabled: true,
        command: [process.execPath, '--version'],
      },
    });
    expect(client.mcpAdd).toHaveBeenNthCalledWith(2, {
      name: 'healthy_second',
      config: {
        type: 'local',
        enabled: true,
        command: [process.execPath, '--help'],
      },
    });
    expect(debugSpy).toHaveBeenCalledWith(
      '[OpenCodeServer] Failed to register MCP server (non-fatal)',
      expect.objectContaining({ serverName: 'broken_first', error: expect.any(Error) }),
    );
    debugSpy.mockRestore();
  });

  it('publishes session mode/model lists into metadata on start (best-effort)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});

    await expect.poll(() => session.updateMetadata.mock.calls.length).toBeGreaterThan(0);
    const metadata = session.__getMetadata();
    expect(metadata).toMatchObject({
      sessionModesV1: expect.objectContaining({
        v: 1,
        provider: 'opencode',
        currentModeId: 'build',
        availableModes: [expect.objectContaining({ id: 'build' })],
      }),
      acpSessionModesV1: expect.objectContaining({
        v: 1,
        provider: 'opencode',
        currentModeId: 'build',
        availableModes: [expect.objectContaining({ id: 'build' })],
      }),
      sessionModelsV1: expect.objectContaining({
        v: 1,
        provider: 'opencode',
        currentModelId: 'openai/gpt-5.2',
        availableModels: [
          expect.objectContaining({
            id: 'openai/gpt-5.2',
            contextWindowTokens: 400000,
            modelOptions: [expect.objectContaining({ id: 'reasoning_effort' })],
          }),
        ],
      }),
      acpSessionModelsV1: expect.objectContaining({
        v: 1,
        provider: 'opencode',
        currentModelId: 'openai/gpt-5.2',
        availableModels: [
          expect.objectContaining({
            id: 'openai/gpt-5.2',
            contextWindowTokens: 400000,
            modelOptions: [expect.objectContaining({ id: 'reasoning_effort' })],
          }),
        ],
      }),
    });
    expect(metadata.sessionModesV1).toEqual(metadata.acpSessionModesV1);
    expect(metadata.sessionModelsV1).toEqual(metadata.acpSessionModelsV1);
  });

  it('publishes native OpenCode todos into session work-state metadata on start', async () => {
    const client = createFakeClient();
    client.sessionTodo = vi.fn(async () => ([
      { id: 'todo_1', content: 'Implement send path', status: 'in_progress', priority: 'high' },
      { id: 'todo_2', content: 'Run validation', status: 'pending' },
    ]));
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});

    await expect.poll(() => session.__getMetadata().sessionWorkStateV1).toMatchObject({
      v: 1,
      backendId: 'opencode',
      agentId: 'opencode',
      primaryItemId: expect.stringContaining('todo:'),
      items: [
        expect.objectContaining({
          kind: 'todo',
          status: 'active',
          title: 'Implement send path',
          priority: 'high',
        }),
        expect.objectContaining({
          kind: 'todo',
          status: 'pending',
          title: 'Run validation',
        }),
      ],
    });
  });

  it('lists native OpenCode skills through runtime catalog controls', async () => {
    const client = createFakeClient();
    client.appSkills = vi.fn(async () => ([
      {
        name: 'reviewer',
        description: 'Review code',
        location: '/repo/.agents/skills/reviewer/SKILL.md',
        content: 'private instructions',
      },
    ]));
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/repo',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await expect((runtime as unknown as { listSkills: () => Promise<unknown> }).listSkills()).resolves.toEqual({
      supported: true,
      skills: [
        {
          name: 'reviewer',
          displayName: 'reviewer',
          description: 'Review code',
          path: '/repo/.agents/skills/reviewer/SKILL.md',
          origin: 'opencode_native',
          enabled: true,
        },
      ],
    });
    expect(client.appSkills).toHaveBeenCalledTimes(1);
  });

  it('uses one stable lifecycle id for OpenCode turn start and terminal markers', async () => {
    const started = await beginOpenCodePromptForTest({ localId: 'local-stable-turn-marker' });
    const { client, session, promptPromise } = started;

    await client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_stable_marker', partID: 'part_stable_marker', delta: 'ok' } },
    });
    await emitAssistantMessageUpdated(client, { messageId: 'msg_stable_marker', finish: 'stop' });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

    await expect(promptPromise).resolves.toBeUndefined();

    const startedMarkers = sentAgentMessagesOfType(session, 'task_started') as Array<{ id?: unknown }>;
    const completedMarkers = sentAgentMessagesOfType(session, 'task_complete') as Array<{ id?: unknown }>;
    expect(startedMarkers).toHaveLength(1);
    expect(completedMarkers).toHaveLength(1);
    expect(completedMarkers[0]?.id).toBe(startedMarkers[0]?.id);
  });

  it('applies the OpenCode session directory on resume (uses sessionGet.directory)', async () => {
    const client = createFakeClient();
    client.sessionGet = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ id: sessionId, directory: '/correct' }));

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/wrong',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote' });
    expect(client.setDirectoryOverride).toHaveBeenCalledWith('/correct');
    expect(client.__getDirectoryOverride()).toBe('/correct');
  });

  it('updates resumed OpenCode session permissions before continuing prompts', async () => {
    const client = createFakeClient();
    client.sessionGet = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ id: sessionId }));
    client.sessionUpdate = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ id: sessionId }));

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'read-only',
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote' });

    expect(runtime.shouldResumeAfterPermissionModeChange()).toBe(true);
    expect(client.sessionUpdate).toHaveBeenCalledWith({
      sessionId: 'ses_remote',
      permission: expect.arrayContaining([
        { permission: '*', pattern: '*', action: 'deny' },
        { permission: 'edit', pattern: '*', action: 'deny' },
        { permission: 'read', pattern: '*', action: 'allow' },
      ]),
    });

    runtime.beginTurn();
    const promptPromise = (runtime as unknown as { sendPromptWithMeta: (opts: { text: string; localId: string }) => Promise<void> })
      .sendPromptWithMeta({ text: 'continue with stricter permissions', localId: 'local-permission-update' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    const updateOrder = client.sessionUpdate.mock.invocationCallOrder[0];
    const promptOrder = client.sessionPromptAsync.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(promptOrder);

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_permission_resume', type: 'text', sessionID: 'ses_remote' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_remote', messageID: 'msg_permission_resume', partID: 'part_permission_resume', delta: 'ok' } },
    });
    await emitTerminalAssistantAndIdle(client, { sessionId: 'ses_remote', messageId: 'msg_asst_first' });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('forwards assistant usage telemetry as token_count context updates', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    await expect.poll(() => session.updateMetadata.mock.calls.length).toBeGreaterThan(0);

    await client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_assistant_usage_1',
            role: 'assistant',
            sessionID: 'ses_1',
            providerID: 'openai',
            modelID: 'gpt-5.2',
            cost: 0.25,
            tokens: {
              total: 19_070,
              input: 16_000,
              output: 900,
              reasoning: 120,
              cache: {
                read: 2_000,
                write: 50,
              },
            },
          },
        },
      },
    });

    const tokenCountCall = (session.sendAgentMessage as any).mock.calls.find(
      (call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'token_count',
    );

    expect(tokenCountCall?.[1]).toMatchObject({
      type: 'token_count',
      key: 'opencode-session:ses_1',
      model: 'openai/gpt-5.2',
      used: 19_070,
      size: 400_000,
      cost: { total: 0.25 },
    });
  });

  it('falls back to provider model limit.context when assistant usage telemetry omits size', async () => {
    const client = createFakeClient();
    client.globalConfigGet = vi.fn(async () => ({ model: 'openai/gpt-5.3-codex' }));
    client.providersList = vi.fn(async () => ([
      {
        id: 'openai',
        env: ['OPENAI_API_KEY'],
        models: ({
          'gpt-5.3-codex': {
            id: 'gpt-5.3-codex',
            name: 'GPT-5.3 Codex',
            status: 'active',
            capabilities: { toolcall: true, reasoning: true, input: { text: true } },
            limit: { context: 400000, input: 272000, output: 128000 },
            variants: {
              medium: { reasoningEffort: 'medium' },
            },
          },
        }) as Record<string, unknown>,
      },
    ]));

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    await expect.poll(() => session.updateMetadata.mock.calls.length).toBeGreaterThan(0);

    await client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_assistant_usage_limit_1',
            role: 'assistant',
            sessionID: 'ses_1',
            providerID: 'openai',
            modelID: 'gpt-5.3-codex',
            tokens: {
              input: 160,
            },
          },
        },
      },
    });

    expect(session.sendAgentMessage).toHaveBeenCalledWith('opencode', expect.objectContaining({
      type: 'token_count',
      key: 'opencode-session:ses_1',
      model: 'openai/gpt-5.3-codex',
      used: 160,
      size: 400_000,
    }));
  });

  it('keeps live provider model metadata when auth is CLI-managed and provider env vars are absent', async () => {
    const client = createFakeClient();
    client.globalConfigGet = vi.fn(async () => ({}));
    client.providersList = vi.fn(async () => ([
      {
        id: 'openai',
        env: ['OPENAI_API_KEY'],
        models: ({
          'gpt-5.3-codex': {
            id: 'gpt-5.3-codex',
            name: 'GPT-5.3 Codex',
            status: 'active',
            capabilities: { toolcall: true, reasoning: true, input: { text: true } },
            limit: { context: 400000, input: 272000, output: 128000 },
            variants: {
              medium: { reasoningEffort: 'medium' },
            },
          },
        }) as Record<string, unknown>,
      },
    ]));

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
      env: {},
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    await expect.poll(() => session.updateMetadata.mock.calls.length).toBeGreaterThan(0);

    expect(session.__getMetadata().sessionModelsV1).toMatchObject({
      currentModelId: 'openai/gpt-5.3-codex',
      availableModels: [
        expect.objectContaining({
          id: 'openai/gpt-5.3-codex',
          contextWindowTokens: 400000,
        }),
      ],
    });

    await client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_assistant_usage_cli_auth_1',
            role: 'assistant',
            sessionID: 'ses_1',
            providerID: 'openai',
            modelID: 'gpt-5.3-codex',
            tokens: {
              input: 160,
            },
          },
        },
      },
    });

    expect(session.sendAgentMessage).toHaveBeenCalledWith('opencode', expect.objectContaining({
      type: 'token_count',
      key: 'opencode-session:ses_1',
      model: 'openai/gpt-5.3-codex',
      used: 160,
      size: 400_000,
    }));
  });

  it('omits Anthropic retired models from OpenCode session model metadata even when OpenCode reports active', async () => {
    const client = createFakeClient();
    client.globalConfigGet = vi.fn(async () => ({ model: 'anthropic/claude-3-5-haiku-20241022' }));
    client.providersList = vi.fn(async () => ([
      {
        id: 'anthropic',
        env: ['ANTHROPIC_API_KEY'],
        models: ({
          'claude-3-5-haiku-20241022': {
            id: 'claude-3-5-haiku-20241022',
            name: 'Claude Haiku 3.5',
            status: 'active',
            capabilities: { toolcall: true, input: { text: true } },
          },
          'claude-haiku-4-5-20251001': {
            id: 'claude-haiku-4-5-20251001',
            name: 'Claude Haiku 4.5',
            status: 'active',
            capabilities: { toolcall: true, input: { text: true } },
          },
        }) as Record<string, unknown>,
      },
    ]));

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    await expect.poll(() => session.updateMetadata.mock.calls.length).toBeGreaterThan(0);

    expect(session.__getMetadata().sessionModelsV1).toMatchObject({
      currentModelId: 'anthropic/claude-haiku-4-5-20251001',
      availableModels: [
        expect.objectContaining({ id: 'anthropic/claude-haiku-4-5-20251001' }),
      ],
    });
    expect(session.__getMetadata().sessionModelsV1?.availableModels).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'anthropic/claude-3-5-haiku-20241022' })]),
    );
  });

  it('applies the OpenCode session directory after sessionCreate when available', async () => {
    const client = createFakeClient();
    client.sessionCreate = vi.fn(async () => ({ id: 'ses_1', directory: '/created' }));

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/fallback',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    expect(client.setDirectoryOverride).toHaveBeenCalledWith('/created');
    expect(client.__getDirectoryOverride()).toBe('/created');
  });

  it('creates a session with the safe-yolo ruleset when permission mode is safe-yolo', async () => {
    const client = createFakeClient();
    client.sessionCreate = vi.fn(async () => ({ id: 'ses_1' }));

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'safe-yolo',
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    expect(runtime.shouldResumeAfterPermissionModeChange()).toBe(true);
    expect(client.sessionCreate).toHaveBeenCalledTimes(1);
    const firstCall = (client.sessionCreate as any).mock.calls[0]?.[0] as any;
    expect(firstCall).toMatchObject({
      permission: expect.arrayContaining([
        { permission: '*', pattern: '*', action: 'ask' },
        { permission: 'edit', pattern: '*', action: 'allow' },
        { permission: 'bash', pattern: '*', action: 'ask' },
        { permission: 'external_directory', pattern: '*', action: 'ask' },
      ]),
    });
  });

  it('creates a session with the read-only ruleset when permission mode is read-only', async () => {
    const client = createFakeClient() as any;
    client.sessionCreate = vi.fn(async () => ({ id: 'ses_1' }));

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'read-only',
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    expect(client.sessionCreate).toHaveBeenCalledTimes(1);
    const firstCall = (client.sessionCreate as any).mock.calls[0]?.[0] as any;
    expect(firstCall).toMatchObject({
      permission: expect.arrayContaining([
        { permission: '*', pattern: '*', action: 'deny' },
        { permission: 'edit', pattern: '*', action: 'deny' },
        { permission: 'bash', pattern: '*', action: 'deny' },
        { permission: 'external_directory', pattern: '*', action: 'deny' },
        { permission: 'read', pattern: '*', action: 'allow' },
      ]),
    });
  });

  it('creates a session with the yolo ruleset when permission mode is yolo', async () => {
    const client = createFakeClient() as any;
    client.sessionCreate = vi.fn(async () => ({ id: 'ses_1' }));

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'yolo',
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    expect(client.sessionCreate).toHaveBeenCalledTimes(1);
    const firstCall = (client.sessionCreate as any).mock.calls[0]?.[0] as any;
    expect(firstCall).toMatchObject({
      permission: expect.arrayContaining([
        { permission: '*', pattern: '*', action: 'allow' },
        { permission: 'edit', pattern: '*', action: 'allow' },
        { permission: 'bash', pattern: '*', action: 'allow' },
        { permission: 'external_directory', pattern: '*', action: 'allow' },
      ]),
    });
  });

  it('dedupes thinking signals for repeated busy/idle events and does not flood keepAlive', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const onThinkingChange = vi.fn();

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange,
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    runtime.beginTurn();
    await client.__emit({ directory: '/tmp', payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } } });
    await client.__emit({ directory: '/tmp', payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } } });
    await client.__emit({ directory: '/tmp', payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
    await client.__emit({ directory: '/tmp', payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
    runtime.flushTurn();

    expect(onThinkingChange.mock.calls).toEqual([[true], [false]]);
    expect(session.keepAlive.mock.calls).toEqual([[true, 'remote'], [false, 'remote']]);
  });

  it('keeps the Happier session active while OpenCode remains busy', async () => {
    vi.useFakeTimers();
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const started = await beginOpenCodePromptForTest({
        localId: 'local-active-keepalive-heartbeat',
        env: {
          ...process.env,
          HAPPIER_OPENCODE_SERVER_ACTIVE_KEEPALIVE_INTERVAL_MS: '100',
        },
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const { client, session, onThinkingChange } = started;
      session.keepAlive.mockClear();
      onThinkingChange.mockClear();

      client.__setStatusType('busy');
      await client.__emit({ directory: '/tmp', payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } } });
      expect(session.keepAlive.mock.calls).not.toContainEqual([false, 'remote']);

      await advanceTimersAndFlush(100);
      await advanceTimersAndFlush(200);
      expect(session.keepAlive.mock.calls).toEqual([
        [true, 'remote'],
        [true, 'remote'],
        [true, 'remote'],
      ]);
      expect(onThinkingChange.mock.calls).not.toContainEqual([false]);

      await emitAssistantMessageUpdated(client, { messageId: 'msg_active_keepalive_done', finish: 'stop' });
      await client.__emit({ directory: '/tmp', payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
      await flushTranscriptCommitMicrotasks();
      expect(session.keepAlive.mock.calls).toEqual([
        [true, 'remote'],
        [true, 'remote'],
        [true, 'remote'],
        [false, 'remote'],
      ]);
      expect(onThinkingChange.mock.calls).toEqual([[false]]);

      await advanceTimersAndFlush(300);
      expect(session.keepAlive.mock.calls).toEqual([
        [true, 'remote'],
        [true, 'remote'],
        [true, 'remote'],
        [false, 'remote'],
      ]);
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      await runtime?.reset().catch(() => {});
      vi.useRealTimers();
    }
  });

  it('keeps the Happier session active when a live OpenCode tool part is running without an active Happier turn', async () => {
    vi.useFakeTimers();
    const client = createFakeClient();
    const session = createFakeSession();
    const onThinkingChange = vi.fn();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      env: {
        ...process.env,
        HAPPIER_OPENCODE_SERVER_ACTIVE_KEEPALIVE_INTERVAL_MS: '100',
      },
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange,
    }, {
      createClient: async () => client as any,
    });

    try {
      await runtime.startOrLoad({});

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_running_tool',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_running_tool',
              callID: 'call_running_tool',
              tool: 'bash',
              state: { status: 'running', input: {} },
            },
          },
        },
      });
      await flushTranscriptCommitMicrotasks();
      expect(session.keepAlive.mock.calls).toEqual([[true, 'remote']]);
      expect(onThinkingChange).not.toHaveBeenCalled();

      await advanceTimersAndFlush(200);
      expect(session.keepAlive.mock.calls).toEqual([
        [true, 'remote'],
        [true, 'remote'],
        [true, 'remote'],
      ]);

      await client.__emit({ directory: '/tmp', payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
      await flushTranscriptCommitMicrotasks();
      expect(session.keepAlive.mock.calls).toEqual([
        [true, 'remote'],
        [true, 'remote'],
        [true, 'remote'],
      ]);
      expect(onThinkingChange).not.toHaveBeenCalled();

      await advanceTimersAndFlush(200);
      expect(session.keepAlive.mock.calls).toEqual([
        [true, 'remote'],
        [true, 'remote'],
        [true, 'remote'],
        [true, 'remote'],
        [true, 'remote'],
      ]);

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_running_tool',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_running_tool',
              callID: 'call_running_tool',
              tool: 'bash',
              state: { status: 'completed', input: {}, output: 'ok' },
            },
          },
        },
      });
      await flushTranscriptCommitMicrotasks();
      expect(session.keepAlive.mock.calls).toEqual([
        [true, 'remote'],
        [true, 'remote'],
        [true, 'remote'],
        [true, 'remote'],
        [true, 'remote'],
        [false, 'remote'],
      ]);
    } finally {
      await runtime.reset().catch(() => {});
      vi.useRealTimers();
    }
  });

  it('maps OpenCode compaction lifecycle events to structured transcript events', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    (session.sendAgentMessage as any).mockClear();

    await client.__emit({
      directory: '/tmp',
      payload: {
        type: 'session.next.compaction.started',
        properties: { sessionID: 'ses_1', id: 'compact_1', reason: 'threshold' },
      },
    });
    await client.__emit({
      directory: '/tmp',
      payload: {
        type: 'session.next.compaction.delta',
        properties: { sessionID: 'ses_1', id: 'compact_1', summary: 'private summary text' },
      },
    });
    await client.__emit({
      directory: '/tmp',
      payload: {
        type: 'session.next.compaction.ended',
        properties: { sessionID: 'ses_1', id: 'compact_1', reason: 'threshold' },
      },
    });

    const compactionEvents = session.sendAgentMessage.mock.calls
      .map((call: unknown[]) => call[1])
      .filter((body: any) => body?.type === 'context-compaction');

    expect(compactionEvents).toEqual([
      expect.objectContaining({
        type: 'context-compaction',
        phase: 'started',
        provider: 'opencode',
        source: 'provider-event',
        trigger: 'threshold',
        lifecycleId: 'opencode:context-compaction:ses_1:compact_1',
        providerEventId: 'compact_1',
        providerSessionId: 'ses_1',
      }),
      expect.objectContaining({
        type: 'context-compaction',
        phase: 'completed',
        provider: 'opencode',
        source: 'provider-event',
        trigger: 'threshold',
        lifecycleId: 'opencode:context-compaction:ses_1:compact_1',
        providerEventId: 'compact_1',
        providerSessionId: 'ses_1',
      }),
    ]);
    expect(JSON.stringify(compactionEvents)).not.toContain('private summary text');
  });

  it('maps an OpenCode compaction delta to progress when the start event was missed', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    (session.sendAgentMessage as any).mockClear();

    await client.__emit({
      directory: '/tmp',
      payload: {
        type: 'session.next.compaction.delta',
        properties: { sessionID: 'ses_1', id: 'compact_1', summary: 'private summary text' },
      },
    });

    expect(session.sendAgentMessage).toHaveBeenCalledWith('opencode', expect.objectContaining({
      type: 'context-compaction',
      phase: 'progress',
      provider: 'opencode',
      source: 'provider-event',
      lifecycleId: 'opencode:context-compaction:ses_1:compact_1',
      providerEventId: 'compact_1',
      providerSessionId: 'ses_1',
    }));
    expect(JSON.stringify(session.sendAgentMessage.mock.calls)).not.toContain('private summary text');
  });

  it('maps OpenCode session.compacted events to structured transcript events', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    (session.sendAgentMessage as any).mockClear();

    await client.__emit({
      directory: '/tmp',
      payload: {
        type: 'session.compacted',
        properties: { sessionID: 'ses_1' },
      },
    });

    expect(session.sendAgentMessage).toHaveBeenCalledWith('opencode', expect.objectContaining({
      type: 'context-compaction',
      phase: 'completed',
      provider: 'opencode',
      source: 'provider-event',
      lifecycleId: 'opencode:context-compaction:ses_1',
      providerSessionId: 'ses_1',
    }));
  });

  it('triggers manual compaction through the OpenCode summarize endpoint and emits fallback lifecycle events', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    (session.sendAgentMessage as any).mockClear();
    await runtime.compactContext('/compact');

    expect(client.sessionSummarize).toHaveBeenCalledWith({
      sessionId: 'ses_1',
      model: { providerID: 'openai', modelID: 'gpt-5.2' },
      auto: false,
    });
    expect(client.sessionPromptAsync).not.toHaveBeenCalled();
    const compactionEvents = session.sendAgentMessage.mock.calls
      .map((call: unknown[]) => call[1])
      .filter((body: any) => body?.type === 'context-compaction');
    expect(compactionEvents).toEqual([
      expect.objectContaining({
        type: 'context-compaction',
        phase: 'started',
        source: 'user-command',
        trigger: 'manual',
        lifecycleId: 'opencode:context-compaction:ses_1:manual:1',
        providerSessionId: 'ses_1',
      }),
      expect.objectContaining({
        type: 'context-compaction',
        phase: 'completed',
        source: 'runtime',
        trigger: 'manual',
        lifecycleId: 'opencode:context-compaction:ses_1:manual:1',
        providerSessionId: 'ses_1',
      }),
    ]);
  });

  it('links OpenCode session.compacted terminal events to the active manual compaction lifecycle', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    client.sessionSummarize.mockImplementationOnce(async () => {
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.compacted',
          properties: { sessionID: 'ses_1' },
        },
      });
    });
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    (session.sendAgentMessage as any).mockClear();
    await runtime.compactContext('/compact');

    const compactionEvents = session.sendAgentMessage.mock.calls
      .map((call: unknown[]) => call[1])
      .filter((body: any) => body?.type === 'context-compaction');
    expect(compactionEvents).toEqual([
      expect.objectContaining({
        type: 'context-compaction',
        phase: 'started',
        source: 'user-command',
        trigger: 'manual',
        lifecycleId: 'opencode:context-compaction:ses_1:manual:1',
        providerSessionId: 'ses_1',
      }),
      expect.objectContaining({
        type: 'context-compaction',
        phase: 'completed',
        source: 'provider-event',
        trigger: 'manual',
        lifecycleId: 'opencode:context-compaction:ses_1:manual:1',
        providerSessionId: 'ses_1',
      }),
    ]);
  });

  it('publishes keepAlive when a turn starts and ends without status events', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const onThinkingChange = vi.fn();

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange,
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    runtime.beginTurn();
    runtime.flushTurn();

    expect(onThinkingChange.mock.calls).toEqual([[true], [false]]);
    expect(session.keepAlive.mock.calls).toEqual([[true, 'remote'], [false, 'remote']]);
  });

  it('sends prompt_async with a stable OpenCode-style messageID when localId is provided and waits for session.idle', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    await runtime.setSessionMode('build');
    await runtime.setSessionModel('openai/gpt-5.2');
    await runtime.setSessionConfigOption('telemetry', true);
    await runtime.setSessionConfigOption('reasoning_effort', 'high');
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: ' local-1\n' });

    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = (client.sessionPromptAsync as any).mock.calls[0]?.[0] as any;
    expect(firstCall).toMatchObject({
      sessionId: 'ses_1',
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5.2' },
      variant: 'high',
      config: { telemetry: true },
      parts: [{ type: 'text', text: 'hello' }],
    });
    expect(firstCall.config).not.toMatchObject({ variant: expect.anything() });
    expect(firstCall.messageId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(session.__getMetadata()?.opencodeUserMessageIdMapV1?.byLocalId?.[' local-1\n']).toBe(firstCall.messageId);
    expect(session.__getMetadata()?.opencodeUserMessageIdMapV1?.byLocalId?.['local-1']).toBeUndefined();

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('notifies provider prompt acceptance after prompt_async resolves before session idle', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const onProviderPromptAccepted = vi.fn();
    const promptPromise = (runtime as any).sendPromptWithMeta({
      text: 'hello',
      localId: 'local-provider-accepted',
      onProviderPromptAccepted,
    });
    const settlement = observePromiseSettlement(promptPromise);

    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    await flushTranscriptCommitMicrotasks();

    expect(onProviderPromptAccepted).toHaveBeenCalledTimes(1);
    expect(settlement.status).toBe('pending');

    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_accepted' });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('awaits provider prompt submission handoff after prompt_async resolves before session idle', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const onProviderPromptSubmitted = vi.fn(async () => undefined);
    const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
      text: 'hello',
      localId: 'local-provider-submitted',
      onProviderPromptSubmitted,
    });
    const settlement = observePromiseSettlement(promptPromise);

    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    await flushTranscriptCommitMicrotasks();

    expect(onProviderPromptSubmitted).toHaveBeenCalledTimes(1);
    expect(settlement.status).toBe('pending');

    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_submitted' });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('rejects attempt submission when the turn resolves before prompt_async acknowledgement', async () => {
    const client = createFakeClient();
    let resolvePromptAsync!: () => void;
    const pendingPromptAsync = new Promise<void>((resolve) => {
      resolvePromptAsync = resolve;
    });
    client.sessionPromptAsync = vi.fn(async () => await pendingPromptAsync);
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    try {
      await runtime.startOrLoad({});
      runtime.beginTurn();

      const onProviderPromptSubmitted = vi.fn(async () => undefined);
      const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
        text: 'hello',
        localId: 'local-provider-unconfirmed',
        onProviderPromptSubmitted,
      });
      void promptPromise.catch(() => undefined);

      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_unconfirmed' });

      await expect(promptPromise).rejects.toThrow(/submission.*unconfirmed/i);
      expect(client.sessionPromptAsync).toHaveBeenCalledTimes(1);
      expect(onProviderPromptSubmitted).not.toHaveBeenCalled();
    } finally {
      resolvePromptAsync();
      await runtime.reset().catch(() => undefined);
    }
  });

  it('does not pass an explicit Anthropic retired model override to OpenCode prompt_async', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    await runtime.setSessionModel('anthropic/claude-3-5-haiku-20241022');
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello' });

    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = (client.sessionPromptAsync as any).mock.calls[0]?.[0] as any;
    expect(firstCall).toMatchObject({
      sessionId: 'ses_1',
      parts: [{ type: 'text', text: 'hello' }],
    });
    expect(firstCall.model).toBeUndefined();

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'ok' } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('rejects a qualified model absent from an authoritative provider inventory before prompt_async', async () => {
    const client = createFakeClient();
    client.providersList = vi.fn(async () => ([
      {
        id: 'openai',
        env: ['OPENAI_API_KEY'],
        models: ({
          'gpt-5.6-luna': {
            id: 'gpt-5.6-luna',
            name: 'GPT-5.6 Luna',
            status: 'active',
            capabilities: { input: { text: true } },
          },
        }) as Record<string, unknown>,
      },
    ]));
    client.sessionPromptAsync = vi.fn(async () => {
      throw new Error('prompt_async must not be called for an unavailable qualified model');
    });
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    await runtime.setSessionModel('openai-codex/gpt-5.6-luna');
    runtime.beginTurn();

    const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
      text: 'hello',
      localId: 'local-invalid-qualified-model',
    });

    await expect(promptPromise).rejects.toMatchObject({
      name: 'ProviderPromptSubmissionRejectedBeforeEffectError',
      reason: 'provider_rejected_before_acceptance',
    });
    expect(client.sessionPromptAsync).not.toHaveBeenCalled();
    await expect.poll(() => session.sessionTurnLifecycle.failTurn.mock.calls.length).toBe(1);
    expect(session.sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode',
      issue: expect.objectContaining({
        source: 'provider_session_error',
        providerTurnId: expect.any(String),
      }),
      providerTurnId: expect.any(String),
    }));
    expect(sentAgentMessagesOfType(session, 'turn_failed')).toHaveLength(0);

    await runtime.reset();
  });

  it('dispatches an inventory-backed qualified model with its low variant', async () => {
    const client = createFakeClient();
    client.providersList = vi.fn(async () => ([
      {
        id: 'openai',
        env: ['OPENAI_API_KEY'],
        models: ({
          'gpt-5.6-luna': {
            id: 'gpt-5.6-luna',
            name: 'GPT-5.6 Luna',
            status: 'active',
            capabilities: { input: { text: true } },
            variants: { low: { reasoningEffort: 'low' } },
          },
        }) as Record<string, unknown>,
      },
    ]));
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    await runtime.setSessionModel('openai/gpt-5.6-luna');
    await runtime.setSessionConfigOption('reasoning_effort', 'low');
    runtime.beginTurn();

    const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
      text: 'hello',
      localId: 'local-valid-qualified-model',
    });

    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    expect(readOpenCodePromptAsyncCall(client, 0)).toMatchObject({
      sessionId: 'ses_1',
      model: { providerID: 'openai', modelID: 'gpt-5.6-luna' },
      variant: 'low',
      parts: [{ type: 'text', text: 'hello' }],
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_luna', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_luna', partID: 'part_luna', delta: 'ok' } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_luna' });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('preserves qualified custom-model dispatch when provider inventory is unavailable', async () => {
    const client = createFakeClient();
    client.providersList = vi.fn(async () => {
      throw new Error('provider inventory unavailable');
    });
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    await runtime.setSessionModel('custom-provider/custom-model');
    runtime.beginTurn();

    const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
      text: 'hello',
      localId: 'local-custom-model-inventory-unavailable',
    });

    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    expect(readOpenCodePromptAsyncCall(client, 0)).toMatchObject({
      sessionId: 'ses_1',
      model: { providerID: 'custom-provider', modelID: 'custom-model' },
      parts: [{ type: 'text', text: 'hello' }],
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_custom', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_custom', partID: 'part_custom', delta: 'ok' } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_custom' });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('resolves bare OpenCode model overrides against the active default provider before prompt_async', async () => {
    const client = createFakeClient();
    client.globalConfigGet = vi.fn(async () => ({ model: 'openai/gpt-5.5-pro' }));
    client.providersList = vi.fn(async () => ([
      {
        id: 'openai',
        env: ['OPENAI_API_KEY'],
        models: ({
          'gpt-5.5-pro': { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro', status: 'active', capabilities: { input: { text: true } } },
          'gpt-5.4-mini': { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', status: 'active', capabilities: { input: { text: true } } },
        }) as Record<string, unknown>,
      },
    ]));
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    await runtime.setSessionModel('gpt-5.4-mini');
    runtime.beginTurn();

    const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({ text: 'hello' });

    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = readOpenCodePromptAsyncCall(client, 0);
    expect(firstCall).toMatchObject({
      sessionId: 'ses_1',
      model: { providerID: 'openai', modelID: 'gpt-5.4-mini' },
      parts: [{ type: 'text', text: 'hello' }],
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'ok' } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('uses per-message model overrides from prompt metadata without replacing the selected model', async () => {
    const client = createFakeClient();
    client.globalConfigGet = vi.fn(async () => ({ model: 'openai/gpt-5.5-pro' }));
    client.providersList = vi.fn(async () => ([
      {
        id: 'openai',
        env: ['OPENAI_API_KEY'],
        models: ({
          'gpt-5.2': { id: 'gpt-5.2', name: 'GPT-5.2', status: 'active', capabilities: { input: { text: true } } },
          'gpt-5.4-mini': { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', status: 'active', capabilities: { input: { text: true } } },
        }) as Record<string, unknown>,
      },
    ]));
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    await runtime.setSessionModel('openai/gpt-5.2');
    runtime.beginTurn();

    const firstPrompt = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
      text: 'hello',
      localId: 'local-message-model',
      meta: { model: 'gpt-5.4-mini' },
    });

    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    expect(readOpenCodePromptAsyncCall(client, 0)).toMatchObject({
      sessionId: 'ses_1',
      model: { providerID: 'openai', modelID: 'gpt-5.4-mini' },
      parts: [{ type: 'text', text: 'hello' }],
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'ok' } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });
    await expect(firstPrompt).resolves.toBeUndefined();

    runtime.beginTurn();
    const secondPrompt = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
      text: 'again',
      localId: 'local-selected-model',
    });

    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(2);
    expect(readOpenCodePromptAsyncCall(client, 1)).toMatchObject({
      sessionId: 'ses_1',
      model: { providerID: 'openai', modelID: 'gpt-5.2' },
      parts: [{ type: 'text', text: 'again' }],
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_2', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_2', partID: 'part_2', delta: 'ok' } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_2' });
    await expect(secondPrompt).resolves.toBeUndefined();
  });

  it('does not override the selected model even when MCP servers are configured and the OpenCode default model lacks tool-call support', async () => {
    const client = createFakeClient();
    const session = createFakeSession();

    client.globalConfigGet = vi.fn(async () => ({ model: 'openai/gpt-legacy' }));
    client.providersList = vi.fn(async () => ([
      {
        id: 'openai',
        env: ['OPENAI_API_KEY'],
        models: ({
          'gpt-legacy': { id: 'gpt-legacy', name: 'Legacy', status: 'active', capabilities: { toolcall: false, input: { text: true } } },
          'gpt-5.2': { id: 'gpt-5.2', name: 'GPT-5.2', status: 'active', capabilities: { toolcall: true, input: { text: true } } },
        }) as Record<string, unknown>,
      },
    ]));

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {
        happier: { command: 'node', args: ['-e', 'process.exit(0)'] },
      },
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});

    await expect.poll(() => session.updateMetadata.mock.calls.length).toBeGreaterThan(0);
    const metadata = session.__getMetadata();
    expect(metadata.sessionModelsV1?.currentModelId).toBe('openai/gpt-legacy');
    expect(metadata.sessionModelsV1?.availableModels).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'openai/gpt-legacy' })]),
    );

    runtime.beginTurn();
    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello' });

    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = (client.sessionPromptAsync as any).mock.calls[0]?.[0] as any;
    expect(firstCall).toMatchObject({
      sessionId: 'ses_1',
      parts: [{ type: 'text', text: 'hello' }],
    });
    expect(firstCall.model).toBeUndefined();

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'ok' } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });
    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('does not append hidden change-title instructions to OpenCode prompts', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    runtime.beginTurn();
    const firstPromptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = (client.sessionPromptAsync as any).mock.calls[0]?.[0] as any;
    expect(firstCall).toMatchObject({
      sessionId: 'ses_1',
      parts: [{ type: 'text', text: 'hello' }],
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'ok' } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });
    await expect(firstPromptPromise).resolves.toBeUndefined();

    runtime.beginTurn();
    const secondPromptPromise = (runtime as any).sendPromptWithMeta({ text: 'again' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(2);
    const secondCall = (client.sessionPromptAsync as any).mock.calls[1]?.[0] as any;
    expect(secondCall).toMatchObject({
      sessionId: 'ses_1',
      parts: [{ type: 'text', text: 'again' }],
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_2', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_2', partID: 'part_2', delta: 'ok' } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_2' });
    await expect(secondPromptPromise).resolves.toBeUndefined();
  });

  it('leaves prompts mentioning change-title tools unchanged', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {
        happier: { command: 'node', args: ['-e', 'process.exit(0)'] },
      },
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    runtime.beginTurn();
    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello (mcp__happier__change_title)' });

    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = (client.sessionPromptAsync as any).mock.calls[0]?.[0] as any;
    expect(firstCall).toMatchObject({
      sessionId: 'ses_1',
      parts: [{ type: 'text', text: 'hello (mcp__happier__change_title)' }],
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'ok' } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_sendprompt_non_resume_1' });
    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('does not transcribe change_title tool parts as tool-call/tool-result messages', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    (session.sendAgentMessage as any).mockClear();

    await client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_title_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_1',
            callID: 'call_title_1',
            tool: 'happier_change_title',
            state: {
              status: 'completed',
              input: { title: 'My Title' },
              output: 'ok',
            },
          },
        },
      },
    });

    expect(session.sendAgentMessage).not.toHaveBeenCalled();
  });

  it('canonicalizes custom MCP tool aliases from configured OpenCode servers before sending transcript tool events', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {
        qa_marker_stdio_20260306: {
          type: 'local',
          command: 'node',
          args: ['server.js'],
        } as any,
      },
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    (session.sendAgentMessage as any).mockClear();

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_custom_mcp_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_custom_1',
            callID: 'call_custom_mcp_1',
            tool: 'qa_marker_stdio_20260306_get_marker',
            state: {
              status: 'completed',
              input: {},
              output: 'marker-ok',
            },
          },
        },
      },
    });
    await flushTranscriptCommitMicrotasks();

    expect(session.sendAgentMessage).toHaveBeenCalledWith(
      'opencode',
      expect.objectContaining({
        type: 'tool-call',
        callId: 'call_custom_mcp_1',
        name: 'mcp__qa_marker_stdio_20260306__get_marker',
      }),
      expect.any(Object),
    );
  });

  it('does not trigger unhandledRejection when an async event handler path throws during tool processing', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    (session.sendAgentMessage as any).mockImplementation(() => {
      throw new Error('tool send failed');
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});

      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_tool_unhandled_1',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_tool_unhandled_1',
              callID: 'call_unhandled_1',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: 'echo hi' },
                output: 'ok',
              },
            },
          },
        },
      });

      await flushTranscriptCommitMicrotasks();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it('omits custom messageID for resumed prompts so OpenCode can keep assigning vendor user ids after resume', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote' });

    runtime.beginTurn();
    const firstPromptPromise = (runtime as any).sendPromptWithMeta({ text: 'first after resume', localId: 'resume-local-1' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = (client.sessionPromptAsync as any).mock.calls[0]?.[0] as any;
    expect(firstCall).toMatchObject({
      sessionId: 'ses_remote',
      parts: [{ type: 'text', text: 'first after resume' }],
    });
    expect(firstCall.messageId).toBeUndefined();

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_first', type: 'text', sessionID: 'ses_remote' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_remote', messageID: 'msg_asst_first', partID: 'part_first', delta: 'ok' } },
    });
    await emitTerminalAssistantAndIdle(client, { sessionId: 'ses_remote', messageId: 'msg_asst_first' });
    await expect(firstPromptPromise).resolves.toBeUndefined();

    runtime.beginTurn();
    const secondPromptPromise = (runtime as any).sendPromptWithMeta({ text: 'second after resume', localId: 'resume-local-2' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(2);
    const secondCall = (client.sessionPromptAsync as any).mock.calls[1]?.[0] as any;
    expect(secondCall).toMatchObject({
      sessionId: 'ses_remote',
      parts: [{ type: 'text', text: 'second after resume' }],
    });
    expect(secondCall.messageId).toBeUndefined();

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_second', type: 'text', sessionID: 'ses_remote' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_remote', messageID: 'msg_asst_second', partID: 'part_second', delta: 'ok' } },
    });
    await emitTerminalAssistantAndIdle(client, { sessionId: 'ses_remote', messageId: 'msg_asst_second' });
    await expect(secondPromptPromise).resolves.toBeUndefined();
  });

  it('does not block the first prompt after resume behind a stale busy status snapshot', async () => {
    const prevPollInterval = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
    const prevStatusPoll = process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = '25';
    process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = '1';
    try {
      const resumedSessionId = 'ses_1';
      const client = createFakeClient();
      client.sessionGet = vi.fn(async () => ({ id: resumedSessionId }));
      client.sessionStatusList = vi.fn(async () => ({ ses_1: { type: 'busy' } }));

      const session = createFakeSession();
      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({ resumeId: 'ses_remote' });

      runtime.beginTurn();
      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'first after resume', localId: 'resume-local-stale-busy' });

      await expect.poll(() => client.sessionPromptAsync.mock.calls.length, { timeout: 200 }).toBe(1);

      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.updated', properties: { part: { id: 'part_resume_stale_busy', type: 'text', sessionID: resumedSessionId } } },
      });
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: resumedSessionId,
            messageID: 'msg_asst_resume_stale_busy',
            partID: 'part_resume_stale_busy',
            delta: 'ok',
          },
        },
      });
      await emitTerminalAssistantAndIdle(client, {
        sessionId: resumedSessionId,
        messageId: 'msg_asst_resume_stale_busy',
      });

      await expect(promptPromise).resolves.toBeUndefined();
    } finally {
      if (prevPollInterval === undefined) delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      else process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = prevPollInterval;
      if (prevStatusPoll === undefined) delete process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
      else process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = prevStatusPoll;
    }
  });

  it('backfills vendor-assigned user messageID for the first prompt after resume', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    session.__getMetadata().opencodeSessionId = 'ses_remote';

    let promptSent = false;
    client.sessionPromptAsync = vi.fn(async () => {
      promptSent = true;
    });
    client.sessionMessagesList = vi.fn(async () => {
      if (!promptSent) {
        return [
          {
            info: { id: 'msg_existing_1', role: 'assistant', time: { created: 1 } },
            parts: [{ type: 'text', text: 'existing' }],
          },
        ];
      }
      return [
        {
          info: { id: 'msg_existing_1', role: 'assistant', time: { created: 1 } },
          parts: [{ type: 'text', text: 'existing' }],
        },
        {
          info: { id: 'msg_vendor_user_1', role: 'user', time: { created: 2 } },
          parts: [{ type: 'text', text: 'first after resume' }],
        },
      ];
    });

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote' });

    runtime.beginTurn();
    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'first after resume', localId: 'resume-local-1' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = (client.sessionPromptAsync as any).mock.calls[0]?.[0] as any;
    expect(firstCall.messageId).toBeUndefined();

    await expect.poll(
      () => session.__getMetadata()?.opencodeUserMessageIdMapV1?.byLocalId?.['resume-local-1'],
    ).toBe('msg_vendor_user_1');

    await client.__emitUntrusted({
      directory: '/tmp',
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_asst_first',
            role: 'assistant',
            sessionID: 'ses_remote',
            parentID: 'msg_vendor_user_1',
            time: { created: 3 },
          },
        },
      },
    });
    await client.__emitUntrusted({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_first',
            type: 'text',
            sessionID: 'ses_remote',
            messageID: 'msg_asst_first',
            text: 'resumed turn is visible live',
          },
        },
      },
    });
    await flushTranscriptCommitMicrotasks();
    expect(
      getCommittedTranscriptRows(session, { type: 'message', sidechainId: null })
        .map((row) => row.body.message),
    ).toEqual(['resumed turn is visible live']);

    await emitTerminalAssistantAndIdle(client, { sessionId: 'ses_remote', messageId: 'msg_asst_first' });
    await expect(promptPromise).resolves.toBeUndefined();

    expect(session.__getMetadata()?.opencodeUserMessageIdMapV1?.byLocalId?.['resume-local-1']).toBe('msg_vendor_user_1');
  });

  it('backfills the first resumed sendPrompt call so native diff collection can resolve the resumed user message id', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    session.__getMetadata().opencodeSessionId = 'ses_remote';

    let promptSent = false;
    client.sessionPromptAsync = vi.fn(async () => {
      promptSent = true;
    });
    client.sessionMessagesList = vi.fn(async () => {
      if (!promptSent) {
        return [
          {
            info: { id: 'msg_existing_1', role: 'assistant', time: { created: 1 } },
            parts: [{ type: 'text', text: 'existing' }],
          },
        ];
      }
      return [
        {
          info: { id: 'msg_existing_1', role: 'assistant', time: { created: 1 } },
          parts: [{ type: 'text', text: 'existing' }],
        },
        {
          info: { id: 'msg_vendor_user_1', role: 'user', time: { created: 2 } },
          parts: [{ type: 'text', text: 'first after resume' }],
        },
      ];
    });
    client.sessionDiff.mockResolvedValue([
      {
        path: 'src/resumed.ts',
        diff: 'diff --git a/src/resumed.ts b/src/resumed.ts\n--- a/src/resumed.ts\n+++ b/src/resumed.ts\n@@ -1 +1 @@\n-old\n+new\n',
      },
    ]);

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote' });
    runtime.beginTurn();

    const promptPromise = runtime.sendPrompt('first after resume');
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = (client.sessionPromptAsync as any).mock.calls[0]?.[0] as any;
    expect(firstCall.messageId).toBeUndefined();

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_resume_1', type: 'text', sessionID: 'ses_remote' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_remote', messageID: 'msg_asst_resume_1', partID: 'part_resume_1', delta: 'hi' } },
    });
    await emitTerminalAssistantAndIdle(client, { sessionId: 'ses_remote', messageId: 'msg_asst_resume_1' });

    await expect(promptPromise).resolves.toBeUndefined();

    expect(client.sessionDiff).toHaveBeenCalledTimes(1);
    expect(client.sessionDiff).toHaveBeenCalledWith({
      sessionId: 'ses_remote',
      messageId: 'msg_vendor_user_1',
    });
    expect(session.sendAgentMessage.mock.calls).toEqual(
      expect.arrayContaining([
        [
          'opencode',
          expect.objectContaining({
            type: 'tool-call',
            name: 'Diff',
            input: expect.objectContaining({
              files: [
                expect.objectContaining({
                  file_path: 'src/resumed.ts',
                  unified_diff: expect.stringContaining('src/resumed.ts'),
                }),
              ],
            }),
          }),
        ],
      ]),
    );
    const persistedLocalIds = Object.keys(session.__getMetadata()?.opencodeUserMessageIdMapV1?.byLocalId ?? {});
    expect(persistedLocalIds).toHaveLength(1);
    expect(session.__getMetadata()?.opencodeUserMessageIdMapV1?.byLocalId?.[persistedLocalIds[0] ?? '']).toBe('msg_vendor_user_1');
  });

  it('keeps non-resume sendPrompt calls without synthetic local identity', async () => {
    const client = createFakeClient() as any;
    const session = createFakeSession();

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = runtime.sendPrompt('hello');
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = (client.sessionPromptAsync as any).mock.calls[0]?.[0] as any;
    expect(firstCall.messageId).toBeUndefined();

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_sendprompt_non_resume_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_sendprompt_non_resume_1', partID: 'part_sendprompt_non_resume_1', delta: 'ok' } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_sendprompt_non_resume_1' });

    await expect(promptPromise).resolves.toBeUndefined();

    expect(session.__getMetadata()?.opencodeUserMessageIdMapV1).toBeUndefined();
  });

  it('does not import externally-originated OpenCode TUI text through owned runtime live sync', async () => {
    const client = createFakeClient() as any;
    const session = createFakeSession();
    let stage: 'initial' | 'busy' | 'idle' = 'initial';

    client.sessionMessagesList = vi.fn(async () => {
      if (stage === 'initial') return [];
      if (stage === 'busy') {
        return [
          {
            info: { id: 'msg_live_user_1', role: 'user', time: { created: 1 } },
            parts: [{ type: 'text', text: 'hello from the TUI' }],
          },
        ];
      }
      return [
        {
          info: { id: 'msg_live_user_1', role: 'user', time: { created: 1 } },
          parts: [{ type: 'text', text: 'hello from the TUI' }],
        },
        {
          info: { id: 'msg_live_assistant_1', role: 'assistant', time: { created: 2 } },
          parts: [{ type: 'text', text: 'reply from the TUI turn' }],
        },
      ];
    });

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});

    stage = 'busy';
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
    });
    await flushTranscriptCommitMicrotasks();

    expect(client.sessionMessagesList).not.toHaveBeenCalled();
    expect(session.sendUserTextMessageCommitted).not.toHaveBeenCalled();
    expect(session.keepAlive).toHaveBeenCalledWith(true, 'remote');

    stage = 'idle';
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });
    await flushTranscriptCommitMicrotasks();

    expect(client.sessionMessagesList).not.toHaveBeenCalled();
    expect(session.sendUserTextMessageCommitted).not.toHaveBeenCalled();
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(session.keepAlive).toHaveBeenCalledWith(false, 'remote');
  });

  it('does not import remote assistant text for externally-originated turns in owned runtime mode', async () => {
    const client = createFakeClient() as any;
    const session = createFakeSession();
    let stage: 'initial' | 'busy' | 'idle' = 'initial';

    client.sessionMessagesList = vi.fn(async () => {
      if (stage === 'initial') return [];
      if (stage === 'busy') {
        return [
          {
            info: { id: 'msg_live_user_2', role: 'user', time: { created: 1 } },
            parts: [{ type: 'text', text: 'question from the TUI' }],
          },
          {
            info: { id: 'msg_live_assistant_2', role: 'assistant', time: { created: 2 } },
            parts: [{ type: 'text', text: 'partial assistant reply' }],
          },
        ];
      }
      return [
        {
          info: { id: 'msg_live_user_2', role: 'user', time: { created: 1 } },
          parts: [{ type: 'text', text: 'question from the TUI' }],
        },
        {
          info: { id: 'msg_live_assistant_2', role: 'assistant', time: { created: 2 } },
          parts: [{ type: 'text', text: 'final assistant reply from idle' }],
        },
      ];
    });

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});

    stage = 'busy';
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
    });
    await flushTranscriptCommitMicrotasks();

    expect(client.sessionMessagesList).not.toHaveBeenCalled();
    expect(session.sendUserTextMessageCommitted).not.toHaveBeenCalled();
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();

    stage = 'idle';
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });
    await flushTranscriptCommitMicrotasks();

    expect(client.sessionMessagesList).not.toHaveBeenCalled();
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
  });

  it('does not resolve a turn on a stale idle event that arrived before prompt_async', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    // Stale idle seen before prompt_async should not cause immediate resolution once we start the turn.
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-stale-idle' });

    const early = await Promise.race([
      promptPromise.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => {
        const timer = setTimeout(() => resolve('pending'), 1);
        timer.unref?.();
      }),
    ]);
    expect(early).toBe('pending');

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('does not crash if session.error rejects the turn during prompt_async', async () => {
    const client = createFakeClient() as any;
    client.sessionPromptAsync = vi.fn(async () => {
      client.__emit({
        directory: '/tmp',
        payload: { type: 'session.error', properties: { sessionID: 'ses_1', error: { message: 'Model not found' } } },
      });
    });

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    await expect((runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-error' })).rejects.toBeTruthy();
  });

  it('responds to approved_for_session permissions with once (vendor should not persist approvals)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = { handleToolCall: vi.fn(async () => ({ decision: 'approved_for_session' })) } as any;

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'default',
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'perm_1',
          sessionID: 'ses_1',
          permission: 'edit',
          patterns: ['../outside.txt'],
          always: ['../*'],
          metadata: {},
          tool: { messageID: 'msg_tool_1', callID: 'call_1' },
        },
      },
    });

    await expect.poll(() => client.permissionReply.mock.calls.length).toBe(1);
    expect(client.permissionReply).toHaveBeenCalledWith({ requestId: 'perm_1', reply: 'once' });
  });

  it('auto-rejects permission.asked requests in read-only mode (no UI prompt)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any;

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'read-only',
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'perm_ro',
          sessionID: 'ses_1',
          permission: 'edit',
          patterns: ['AGENTS.md'],
          always: ['*'],
          metadata: {},
        },
      },
    });

    await expect.poll(() => client.permissionReply.mock.calls.length).toBe(1);
    expect(client.permissionReply).toHaveBeenCalledWith({ requestId: 'perm_ro', reply: 'reject' });
    expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
  });

  it('does not abort the session when a stale sibling permission reply fails after session-wide rejection', async () => {
    vi.useFakeTimers();
    try {
      const client = createFakeClient();
      client.permissionReply
        .mockResolvedValueOnce(true)
        .mockRejectedValue(new Error('stale sibling permission request'));
      const session = createFakeSession();
      const permissionHandler = { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any;
      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler,
        onThinkingChange: vi.fn(),
        getPermissionMode: () => 'read-only',
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const buildPermissionEvent = (id: string) => ({
        directory: '/tmp',
        payload: {
          type: 'permission.asked',
          properties: {
            id,
            sessionID: 'ses_1',
            permission: 'edit',
            patterns: ['AGENTS.md'],
            always: ['*'],
            metadata: {},
          },
        },
      });

      await client.__emit(buildPermissionEvent('perm_reject_target'));
      await client.__emit(buildPermissionEvent('perm_reject_stale_sibling'));
      await flushTranscriptCommitMicrotasks();
      await advanceTimersAndFlush(10_000);

      expect(client.permissionReply).toHaveBeenCalledTimes(2);
      expect(client.sessionAbort).not.toHaveBeenCalled();
      expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bridges permission.asked requests onto the blocked tool call id with blocked tool input', async () => {
    const client = createFakeClient();
    client.sessionMessagesList.mockResolvedValue([
      {
        info: {
          id: 'msg_tool_1',
          role: 'assistant',
          sessionID: 'ses_1',
          time: { created: 1000 },
        },
        parts: [{
          type: 'tool',
          sessionID: 'ses_1',
          messageID: 'msg_tool_1',
          callID: 'call_1',
          tool: 'read',
          state: {
            status: 'error',
            input: {
              filePath: '/tmp/outside.txt',
            },
          },
        }],
      },
    ]);
    const session = createFakeSession();
    const permissionHandler = { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any;

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'default',
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'perm_1',
          sessionID: 'ses_1',
          permission: 'external_directory',
          patterns: ['/tmp/*'],
          always: ['/tmp/*'],
          metadata: {
            filepath: '/tmp/outside.txt',
            parentDir: '/tmp',
          },
          tool: { messageID: 'msg_tool_1', callID: 'call_1' },
        },
      },
    });

    await expect.poll(() => permissionHandler.handleToolCall.mock.calls.length).toBe(1);
    expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
      'call_1',
      'read',
      expect.objectContaining({
        permissionId: 'call_1',
        providerPermissionId: 'perm_1',
        sessionId: 'ses_1',
        toolCallId: 'call_1',
        toolName: 'read',
        filePath: '/tmp/outside.txt',
        permission: expect.objectContaining({
          id: 'perm_1',
          kind: 'external_directory',
          toolName: 'read',
        }),
        toolCall: expect.objectContaining({
          toolCallId: 'call_1',
          status: 'pending',
          rawInput: expect.objectContaining({
            filePath: '/tmp/outside.txt',
          }),
        }),
      }),
    );
    expect(client.permissionReply).toHaveBeenCalledWith({ requestId: 'perm_1', reply: 'once' });
  });

  it('auto-approves permission.asked requests in yolo mode (no UI prompt)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = { handleToolCall: vi.fn(async () => ({ decision: 'denied' })) } as any;

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'yolo',
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'perm_yolo',
          sessionID: 'ses_1',
          permission: 'edit',
          patterns: ['AGENTS.md'],
          always: ['*'],
          metadata: {},
        },
      },
    });

    await expect.poll(() => client.permissionReply.mock.calls.length).toBe(1);
    expect(client.permissionReply).toHaveBeenCalledWith({ requestId: 'perm_yolo', reply: 'once' });
    expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
  });

  it('fails closed (reject) when permission handler throws during permission.asked', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = { handleToolCall: vi.fn(async () => { throw new Error('permission ui crashed'); }) } as any;

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'default',
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'perm_throw',
          sessionID: 'ses_1',
          permission: 'edit',
          patterns: ['AGENTS.md'],
          always: ['*'],
          metadata: {},
        },
      },
    });

    await expect.poll(() => client.permissionReply.mock.calls.length).toBe(1);
    expect(client.permissionReply).toHaveBeenCalledWith({ requestId: 'perm_throw', reply: 'reject' });
    expect(permissionHandler.handleToolCall).toHaveBeenCalledTimes(1);
  });

  it('fails closed (reject) when permission.asked payload is malformed (no UI prompt)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any;

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'default',
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'perm_malformed',
          sessionID: 'ses_1',
          // permission omitted (protocol drift / malformed payload)
          patterns: ['AGENTS.md'],
          always: ['*'],
          metadata: {},
        },
      },
    });

    await expect.poll(() => client.permissionReply.mock.calls.length).toBe(1);
    expect(client.permissionReply).toHaveBeenCalledWith({ requestId: 'perm_malformed', reply: 'reject' });
    expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
    expect((session.sendAgentMessage as any).mock.calls.some((call: any[]) =>
      call?.[0] === 'opencode' && call?.[1]?.type === 'message'
    )).toBe(true);
  });

  it('does not resolve a turn on session.idle before assistant activity and fails through the stuck-idle fallback', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_IDLE_WITHOUT_TERMINAL_ASSISTANT_TIMEOUT_MS: '50',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });
    try {
      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-idle-before-activity' });
      void promptPromise.catch(() => undefined);
      const outcome = observePromiseSettlement(promptPromise);
      await flushTranscriptCommitMicrotasks();
      expect(client.sessionPromptAsync).toHaveBeenCalledTimes(1);

      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });
      await advanceTimersAndFlush(49);
      expect(outcome.status).toBe('pending');
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(0);

      await advanceTimersAndFlush(1);
      expect(outcome.status).toBe('rejected');
      expect(sentAgentMessagesOfType(session, 'turn_failed')).toEqual([
        expect.objectContaining({ code: 'opencode_idle_without_terminal_assistant' }),
      ]);
    } finally {
      await runtime.cancel().catch(() => {});
      vi.useRealTimers();
      restoreEnv();
    }
  });

  it('does not treat session.status busy as sufficient activity to resolve a turn on idle', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-busy-only' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
    });

    const early = await Promise.race([
      promptPromise.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => {
        const timer = setTimeout(() => resolve('pending'), 25);
        timer.unref?.();
      }),
    ]);
    expect(early).toBe('pending');

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('ignores message.part updates for messages that existed before the turn (prevents stale event replays from resolving turns)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    client.sessionMessagesList.mockResolvedValueOnce([
      { info: { id: 'msg_old_user', role: 'user', sessionID: 'ses_1', time: { created: 1 } }, parts: [{ type: 'text', text: 'old' }] },
      { info: { id: 'msg_old_asst', role: 'assistant', sessionID: 'ses_1', time: { created: 2 } }, parts: [{ type: 'text', text: 'old' }] },
    ]);

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-stale-replay' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    // Simulate an event replay for an older assistant message arriving during the new turn.
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_old', type: 'text', sessionID: 'ses_1' } } },
    });
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_old_asst', partID: 'part_old', delta: 'OLD' } },
    });
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    const early = await Promise.race([
      promptPromise.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => {
        const timer = setTimeout(() => resolve('pending'), 25);
        timer.unref?.();
      }),
    ]);
    expect(early).toBe('pending');

    // Now emit a new assistant delta for a message created during this turn.
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_new', type: 'text', sessionID: 'ses_1' } } },
    });
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_new_asst', partID: 'part_new', delta: 'NEW' } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_new_asst' });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('maps question.asked into AskUserQuestion and replies via question.reply', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved', answers: { q1: ['a', 'b'] } })),
    };

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: permissionHandler as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'question.asked',
        properties: {
          id: 'que_1',
          sessionID: 'ses_1',
          questions: [
            {
              question: 'q1',
              header: 'Q1',
              options: [
                { label: 'a', description: 'A' },
                { label: 'b', description: 'B' },
              ],
              multiple: true,
            },
          ],
        },
      },
    });

    await expect.poll(() => client.questionReply.mock.calls.length).toBe(1);

    expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
      'que_1',
      'AskUserQuestion',
      expect.objectContaining({
        questions: [
          expect.objectContaining({ question: 'q1', header: 'Q1', multiSelect: true }),
        ],
      }),
    );

    expect(client.questionReply).toHaveBeenCalledWith({ requestId: 'que_1', answers: [['a', 'b']] });
    expect(session.sendAgentMessage).toHaveBeenCalledWith(
      'opencode',
      expect.objectContaining({ type: 'tool-result', callId: 'que_1' }),
    );
  });

  it('retries fail-closed question rejection after delivery fails and handles only after settlement', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    let rejectFirstDelivery: (error: Error) => void = () => {
      throw new Error('first question rejection delivery did not start');
    };
    client.questionReject.mockImplementationOnce(async () => await new Promise<never>((_resolve, reject) => {
      rejectFirstDelivery = reject;
    })).mockResolvedValueOnce(true);
    const permissionHandler = {
      handleToolCall: vi.fn(async () => {
        throw new Error('invalid structured question');
      }),
    };

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: permissionHandler as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    const event = {
      directory: '/tmp',
      payload: {
        type: 'question.asked',
        properties: {
          id: 'que_invalid_1',
          sessionID: 'ses_1',
          questions: [{ question: 'q1', header: 'Q1', options: [], multiple: false }],
        },
      },
    } as const;

    await client.__emit(event);
    await expect.poll(() => client.questionReject.mock.calls.length).toBe(1);
    await client.__emit(event);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(permissionHandler.handleToolCall).toHaveBeenCalledTimes(1);
    expect(client.questionReject).toHaveBeenCalledTimes(1);
    rejectFirstDelivery(new Error('transient question rejection delivery failure'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await client.__emit(event);
    await expect.poll(() => client.questionReject.mock.calls.length).toBe(2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await client.__emit(event);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(permissionHandler.handleToolCall).toHaveBeenCalledTimes(1);
    expect(client.questionReject).toHaveBeenCalledTimes(2);
    expect(client.questionReject).toHaveBeenNthCalledWith(1, { requestId: 'que_invalid_1' });
    expect(client.questionReject).toHaveBeenNthCalledWith(2, { requestId: 'que_invalid_1' });
    expect(session.sendAgentMessage).toHaveBeenCalledWith('opencode', expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('rejected'),
    }));
    expect(sentAgentMessagesOfType(session, 'task_started')).toHaveLength(1);
    const rejectionNotices = session.sendAgentMessage.mock.calls.filter((call: unknown[]) => {
      const message = call[1];
      return message !== null
        && typeof message === 'object'
        && !Array.isArray(message)
        && (message as Record<string, unknown>).type === 'message'
        && String((message as Record<string, unknown>).message).includes('request was rejected');
    });
    expect(rejectionNotices).toHaveLength(1);
  });

  it('clears unsettled fail-closed question rejection intent on runtime reset', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    client.questionReject
      .mockRejectedValueOnce(new Error('transient question rejection delivery failure'))
      .mockResolvedValueOnce(true);
    const permissionHandler = {
      handleToolCall: vi.fn(async () => {
        throw new Error('invalid structured question');
      }),
    };
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: permissionHandler as any,
      onThinkingChange: vi.fn(),
    }, { createClient: async () => client as any });
    const event = {
      directory: '/tmp',
      payload: {
        type: 'question.asked',
        properties: {
          id: 'que_invalid_reset',
          sessionID: 'ses_1',
          questions: [{ question: 'q1', header: 'Q1', options: [], multiple: false }],
        },
      },
    } as const;

    await runtime.startOrLoad({});
    await client.__emit(event);
    await expect.poll(() => client.questionReject.mock.calls.length).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));

    await runtime.reset();
    await runtime.startOrLoad({});
    await client.__emit(event);
    await expect.poll(() => client.questionReject.mock.calls.length).toBe(2);

    expect(permissionHandler.handleToolCall).toHaveBeenCalledTimes(2);
  });

  it.each(['resolve', 'reject'] as const)(
    'fences stale fail-closed rejection %s from a new runtime lifecycle with the same request key',
    async (retiredOutcome) => {
      const client = createFakeClient();
      const session = createFakeSession();
      let resolveRetiredDelivery: (value: boolean) => void = () => {
        throw new Error('retired question rejection delivery did not start');
      };
      let rejectRetiredDelivery: (error: Error) => void = () => {
        throw new Error('retired question rejection delivery did not start');
      };
      let rejectNewDelivery: (error: Error) => void = () => {
        throw new Error('new question rejection delivery did not start');
      };
      client.questionReject
        .mockImplementationOnce(async () => await new Promise<boolean>((resolve, reject) => {
          resolveRetiredDelivery = resolve;
          rejectRetiredDelivery = reject;
        }))
        .mockImplementationOnce(async () => await new Promise<never>((_resolve, reject) => {
          rejectNewDelivery = reject;
        }))
        .mockResolvedValueOnce(true);
      const permissionHandler = {
        handleToolCall: vi.fn(async () => {
          throw new Error('invalid structured question');
        }),
      };
      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: permissionHandler as any,
        onThinkingChange: vi.fn(),
      }, { createClient: async () => client as any });
      const event = {
        directory: '/tmp',
        payload: {
          type: 'question.asked',
          properties: {
            id: 'que_invalid_reset_race',
            sessionID: 'ses_1',
            questions: [{ question: 'q1', header: 'Q1', options: [], multiple: false }],
          },
        },
      } as const;

      await runtime.startOrLoad({});
      await client.__emit(event);
      await expect.poll(() => client.questionReject.mock.calls.length).toBe(1);

      await runtime.reset();
      await runtime.startOrLoad({});
      await client.__emit(event);
      await expect.poll(() => client.questionReject.mock.calls.length).toBe(2);

      if (retiredOutcome === 'resolve') {
        resolveRetiredDelivery(true);
      } else {
        rejectRetiredDelivery(new Error('retired lifecycle rejection delivery failure'));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      await client.__emit(event);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(permissionHandler.handleToolCall).toHaveBeenCalledTimes(2);
      expect(client.questionReject).toHaveBeenCalledTimes(2);

      rejectNewDelivery(new Error('new lifecycle rejection delivery failure'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await client.__emit(event);
      await expect.poll(() => client.questionReject.mock.calls.length).toBe(3);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await client.__emit(event);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(permissionHandler.handleToolCall).toHaveBeenCalledTimes(2);
      expect(client.questionReject).toHaveBeenCalledTimes(3);
    },
  );

  it('auto-acknowledges internal OpenCode title update questions without surfacing AskUserQuestion', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved', answers: { q1: ['should-not-be-used'] } })),
    };

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: permissionHandler as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'question.asked',
        properties: {
          id: 'que_title_1',
          sessionID: 'ses_1',
          questions: [
            {
              question: '(Internal) Ignore',
              header: 'Title update',
              options: [{ label: 'OK', description: 'Acknowledge' }],
              multiple: false,
            },
          ],
        },
      },
    });

    await expect.poll(() => client.questionReply.mock.calls.length).toBe(1);

    expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
    expect(client.questionReply).toHaveBeenCalledWith({ requestId: 'que_title_1', answers: [['OK']] });

    const sentToolResult = session.sendAgentMessage.mock.calls.some((call: unknown[]) => {
      const message = call[1];
      if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
      const rec = message as Record<string, unknown>;
      return rec.type === 'tool-result' && rec.callId === 'que_title_1';
    });
    expect(sentToolResult).toBe(false);
  });

  it('handles question.asked for Task child sessions (prevents sub-agent stalls)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved', answers: { q1: ['answer'] } })),
    };

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: permissionHandler as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    // Register a child session via a Task tool part emitted from the parent session.
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_task_child_reg',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_task_reg',
            callID: 'call_task_reg',
            tool: 'task',
            state: { status: 'running', input: { description: 'Run child' }, metadata: { sessionId: 'ses_child_1' } },
          },
        },
      },
    });

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'question.asked',
        properties: {
          id: 'que_child_1',
          sessionID: 'ses_child_1',
          questions: [{ question: 'q1', header: 'Q1', options: [], multiple: false }],
        },
      },
    });

    await expect.poll(() => client.questionReply.mock.calls.length).toBe(1);
    expect(permissionHandler.handleToolCall).toHaveBeenCalledTimes(1);
    expect(client.questionReply).toHaveBeenCalledWith({ requestId: 'que_child_1', answers: [['answer']] });
  });

  it('treats location-based OpenCode questions as freeform (options are a UI hint, not a real choice)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved', answers: { 'Which file should I inspect?': ['README.md'] } })),
    };

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: permissionHandler as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'question.asked',
        properties: {
          id: 'que_freeform',
          sessionID: 'ses_1',
          questions: [
            {
              question: 'Which file should I inspect?',
              header: 'File to inspect',
              locations: [],
              options: [
                { label: 'Type path now', description: 'Provide the repo-relative file path you want me to inspect.' },
              ],
              multiple: false,
            },
          ],
        },
      },
    });

    await expect.poll(() => client.questionReply.mock.calls.length).toBe(1);

    expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
      'que_freeform',
      'AskUserQuestion',
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            question: 'Which file should I inspect?',
            header: 'File to inspect',
            options: [],
            freeform: expect.objectContaining({
              placeholder: 'Type path now',
              description: 'Provide the repo-relative file path you want me to inspect.',
            }),
          }),
        ],
      }),
    );

    expect(client.questionReply).toHaveBeenCalledWith({ requestId: 'que_freeform', answers: [['README.md']] });
  });

  it('treats single-option "type/enter" OpenCode questions as freeform even when locations are omitted', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved', answers: { 'Which file should I inspect?': ['README.md'] } })),
    };

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: permissionHandler as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'question.asked',
        properties: {
          id: 'que_freeform_2',
          sessionID: 'ses_1',
          questions: [
            {
              question: 'Which file should I inspect?',
              header: 'File to inspect',
              options: [
                { label: 'Type your own answer', description: 'Enter the file path you want me to inspect.' },
              ],
              multiple: false,
            },
          ],
        },
      },
    });

    await expect.poll(() => client.questionReply.mock.calls.length).toBe(1);

    expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
      'que_freeform_2',
      'AskUserQuestion',
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            options: [],
            freeform: expect.objectContaining({ placeholder: 'Type your own answer' }),
          }),
        ],
      }),
    );
  });

  it('supports OpenCode questions with suggestions plus a typed "other" answer (freeform + options) and does not split commas', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved', answers: { q1: ['Custom goal, with commas'] } })),
    };

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: permissionHandler as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'question.asked',
        properties: {
          id: 'que_other_combo',
          sessionID: 'ses_1',
          questions: [
            {
              question: 'q1',
              header: 'Q1',
              options: [
                { label: 'Option A', description: 'A' },
                { label: 'Other (type below)', description: 'Type a different goal.' },
              ],
              multiple: false,
            },
          ],
        },
      },
    });

    await expect.poll(() => client.questionReply.mock.calls.length).toBe(1);

    expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
      'que_other_combo',
      'AskUserQuestion',
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            question: 'q1',
            header: 'Q1',
            options: [{ label: 'Option A', description: 'A' }],
            freeform: expect.objectContaining({ placeholder: 'Other (type below)', description: 'Type a different goal.' }),
          }),
        ],
      }),
    );

    expect(client.questionReply).toHaveBeenCalledWith({ requestId: 'que_other_combo', answers: [['Custom goal, with commas']] });
  });

  it('uses SSE as the sole permission/question owner while status polling remains a bounded completion fallback', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS: '2000',
      HAPPIER_OPENCODE_SERVER_ACTIVE_CONTROL_POLL_INTERVAL_MS: '250',
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '1',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const client = createFakeClient();
      client.sessionStatusList.mockResolvedValue({ ses_1: { type: 'busy' } });
      const permissionHandler = {
        handleToolCall: vi.fn(async (_id: string, toolName: string) => (
          toolName === 'AskUserQuestion'
            ? { decision: 'approved' as const, answers: { q1: ['yes'] } }
            : { decision: 'approved' as const }
        )),
      };
      const started = await beginOpenCodePromptForTest({
        client,
        permissionHandler,
        localId: 'local-sse-control-owner',
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;

      const permissionEvent: OpenCodeGlobalEvent = {
        directory: '/tmp',
        payload: {
          type: 'permission.asked',
          properties: {
            id: 'perm_sse_owner',
            sessionID: 'ses_1',
            permission: 'edit',
            patterns: ['AGENTS.md'],
            always: ['*'],
            metadata: {},
            tool: { messageID: 'msg_tool_sse_owner', callID: 'call_sse_owner' },
          },
        },
      };
      const questionEvent: OpenCodeGlobalEvent = {
        directory: '/tmp',
        payload: {
          type: 'question.asked',
          properties: {
            id: 'question_sse_owner',
            sessionID: 'ses_1',
            questions: [{
              question: 'Continue?',
              header: 'Continue',
              options: [{ label: 'yes', description: 'Continue' }],
              multiple: false,
            }],
          },
        },
      };

      await client.__emit(permissionEvent);
      await client.__emit(permissionEvent);
      await client.__emit(questionEvent);
      await client.__emit(questionEvent);
      await flushTranscriptCommitMicrotasks();
      await advanceTimersAndFlush(1_000);

      expect(client.permissionList).not.toHaveBeenCalled();
      expect(client.questionList).not.toHaveBeenCalled();
      expect(client.sessionStatusList.mock.calls.length).toBeGreaterThan(0);
      expect(client.sessionStatusList.mock.calls.length).toBeLessThanOrEqual(5);
      expect(permissionHandler.handleToolCall).toHaveBeenCalledTimes(2);
      expect(client.permissionReply).toHaveBeenCalledTimes(1);
      expect(client.questionReply).toHaveBeenCalledTimes(1);

      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_sse_control_owner_done' });
      await expect(promptPromise).resolves.toBeUndefined();
      expect(client.permissionList).not.toHaveBeenCalled();
      expect(client.questionList).not.toHaveBeenCalled();
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('uses replayable permission and question events only to read authoritative active-request inventories', async () => {
    const client = createFakeClient();
    client.sessionStatusList.mockResolvedValue({ ses_1: { type: 'busy' } });
    client.permissionList.mockResolvedValue([{
      id: 'perm_authoritative',
      sessionID: 'ses_1',
      permission: 'edit',
      patterns: ['src/current.ts'],
      always: [],
      metadata: {},
    }]);
    client.questionList.mockResolvedValue([{
      id: 'question_authoritative',
      sessionID: 'ses_1',
      questions: [{
        question: 'Use the current provider request?',
        header: 'Provider request',
        options: [{ label: 'yes', description: 'Continue' }],
        multiple: false,
      }],
    }]);
    const permissionHandler = {
      handleToolCall: vi.fn(async (_id: string, toolName: string) => (
        toolName === 'AskUserQuestion'
          ? { decision: 'approved' as const, answers: { 'Use the current provider request?': ['yes'] } }
          : { decision: 'approved' as const }
      )),
    };
    const started = await beginOpenCodePromptForTest({
      client,
      permissionHandler,
      localId: 'local-authoritative-request-inventory',
    });

    try {
      await client.__emitUntrusted({
        directory: '/tmp',
        payload: {
          type: 'permission.asked',
          properties: {
            id: 'perm_replayed_payload_must_not_run',
            sessionID: 'ses_1',
            permission: 'bash',
            patterns: ['rm -rf /'],
            always: ['*'],
            metadata: {},
          },
        },
      });
      await client.__emitUntrusted({
        directory: '/tmp',
        payload: {
          type: 'question.asked',
          properties: {
            id: 'question_replayed_payload_must_not_run',
            sessionID: 'ses_1',
            questions: [{
              question: 'Trust replayed content?',
              header: 'Replay',
              options: [{ label: 'yes', description: 'Unsafe replay' }],
              multiple: false,
            }],
          },
        },
      });

      await expect.poll(() => client.permissionReply.mock.calls.length).toBe(1);
      await expect.poll(() => client.questionReply.mock.calls.length).toBe(1);
      expect(client.permissionReply).toHaveBeenCalledWith({
        requestId: 'perm_authoritative',
        reply: 'once',
      });
      expect(client.questionReply).toHaveBeenCalledWith({
        requestId: 'question_authoritative',
        answers: [['yes']],
      });
      expect(client.permissionReply).not.toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'perm_replayed_payload_must_not_run' }),
      );
      expect(client.questionReply).not.toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'question_replayed_payload_must_not_run' }),
      );
    } finally {
      await started.runtime.cancel().catch(() => {});
      await started.promptPromise.catch(() => undefined);
      await started.runtime.reset().catch(() => {});
    }
  });

  it('dedupes cumulative text deltas and streams transcript-vNext updates with a stable happierStreamKey per OpenCode message', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MS', '1000000');
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MIN_CHARS', '1000000');
    try {
      const client = createFakeClient();
      const session = createFakeSession();
      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-dedupe' });
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      let queuedEvent = client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } },
        },
      });
      await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_1', completed: null });

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.delta',
          properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'Hello' },
        },
      });
      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.delta',
          properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'Hello.' },
        },
      });
      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.delta',
          properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'Hello.' },
        },
      });

      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });
      await vi.runAllTimersAsync();

      await expect(promptPromise).resolves.toBeUndefined();
      await flushTranscriptCommitMicrotasks();
      await flushTranscriptCommitMicrotasks();
      await flushTranscriptCommitMicrotasks();

      const committedCalls = getCommittedTranscriptRows(session, { type: 'message' });
      expect(committedCalls.map((c) => c.body?.message)).toEqual(['Hello', 'Hello.']);
      expect(committedCalls[0]?.localId).toBeTruthy();
      expect(committedCalls[1]?.localId).toBe(committedCalls[0]?.localId);
      expect(committedCalls[0]?.meta?.happierStreamKey).toBeTruthy();
      expect(committedCalls[1]?.meta?.happierStreamKey).toBe(committedCalls[0]?.meta?.happierStreamKey);
      expect(committedCalls[1]?.meta?.happierStreamSegmentV1).toMatchObject({
        segmentKind: 'assistant',
        segmentLocalId: committedCalls[0]?.localId,
        segmentState: 'complete',
      });
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('buffers tiny text deltas into fewer transcript messages by default (prevents per-token transcript spam)', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MS', '1000000');
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MIN_CHARS', '1000000');
    try {
      const client = createFakeClient();
      const session = createFakeSession();
      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-buffer-default' });
      // Avoid expect.poll under fake timers; let the async prompt setup drain.
      await flushTranscriptCommitMicrotasks();
      expect(client.sessionPromptAsync).toHaveBeenCalledTimes(1);

      let queuedEvent = client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } },
        },
      });
      await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_1', completed: null });

      for (const ch of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
        queuedEvent = client.__emit({
          directory: '/tmp',
          payload: {
            type: 'message.part.delta',
            properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: ch },
          },
        });
      }

      await queuedEvent;
      const commitsAfterDeltas = getCommittedTranscriptRows(session, { type: 'message' });
      expect(commitsAfterDeltas).toHaveLength(1);
      expect(commitsAfterDeltas[0]?.body?.message).toBe('a');

      await vi.advanceTimersByTimeAsync(60);
      await flushTranscriptCommitMicrotasks();
      const commitsAfterTimerAdvance = getCommittedTranscriptRows(session, { type: 'message' });
      expect(commitsAfterTimerAdvance.length).toBeGreaterThanOrEqual(1);
      expect(commitsAfterTimerAdvance.length).toBeLessThanOrEqual(2);

      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

      await expect(promptPromise).resolves.toBeUndefined();

      const committedCalls = getCommittedTranscriptRows(session, { type: 'message' });
      expect(committedCalls.map((c) => c.body?.message)).toEqual(['a', 'abcdefghij']);
      expect(committedCalls[1]?.localId).toBe(committedCalls[0]?.localId);
      expect(committedCalls[committedCalls.length - 1]?.body?.message).toBe('abcdefghij');
      expect(committedCalls[committedCalls.length - 1]?.meta?.happierStreamSegmentV1).toMatchObject({
        segmentState: 'complete',
      });
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('flushes buffered text chunks repeatedly while a turn is streaming (does not stall after the first flush)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MS', '50');
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MIN_CHARS', '1');
    try {
      const client = createFakeClient();
      const session = createFakeSession();
      const runtime = createOpenCodeServerRuntime(
        {
          directory: '/tmp',
          session,
          messageBuffer: new MessageBuffer(),
          mcpServers: {},
          permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
          onThinkingChange: vi.fn(),
        },
        {
          createClient: async () => client as any,
        },
      );

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-buffer-multi-flush' });
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } },
        },
      });
      await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_1', completed: null });

      for (const ch of ['a', 'b', 'c', 'd', 'e']) {
        client.__emit({
          directory: '/tmp',
          payload: {
            type: 'message.part.delta',
            properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: ch },
          },
        });
      }

      await flushTranscriptCommitMicrotasks();
      const commitsAfterFirstBatch = getCommittedTranscriptRows(session, { type: 'message' }).map((call) => call.body?.message);
      expect(commitsAfterFirstBatch).toEqual(['a']);

      await vi.advanceTimersByTimeAsync(60);
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.delta',
          properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'f' },
        },
      });
      await flushTranscriptCommitMicrotasks();
      await vi.advanceTimersByTimeAsync(60);
      await flushTranscriptCommitMicrotasks();
      expect(getCommittedTranscriptRows(session, { type: 'message' }).map((call) => call.body?.message)).toContain('abcdef');

      await vi.advanceTimersByTimeAsync(60);
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.delta',
          properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'g' },
        },
      });
      await flushTranscriptCommitMicrotasks();
      const commitsAfterSecondFlush = getCommittedTranscriptRows(session, { type: 'message' });
      expect(commitsAfterSecondFlush.length).toBeGreaterThanOrEqual(3);
      expect(commitsAfterSecondFlush[commitsAfterSecondFlush.length - 1]?.body?.message).toBe('abcdefg');

      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

      await expect(promptPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('does not mix transcript-vNext localIds across different OpenCode messageIDs in the same turn', async () => {
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MS', '1000000');
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MIN_CHARS', '1000000');
    try {
      const client = createFakeClient();
      const session = createFakeSession();
      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-multi-msg' });
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } },
        },
      });

      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.delta',
          properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'A' },
        },
      });
      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.delta',
          properties: { sessionID: 'ses_1', messageID: 'msg_asst_2', partID: 'part_1', delta: 'B' },
        },
      });

      await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_1', finish: 'stop' });
      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_2' });

      await expect(promptPromise).resolves.toBeUndefined();

      const committedCalls = getCommittedTranscriptRows(session, { type: 'message' })
        .filter((c) => c.body?.message === 'A' || c.body?.message === 'B');
      expect(committedCalls).toHaveLength(4);
      const uniqueLocalIds = new Set(committedCalls.map((row) => row.localId).filter((id): id is string => typeof id === 'string' && id.length > 0));
      expect(uniqueLocalIds.size).toBe(2);

      const uniqueStreamKeys = new Set(
        committedCalls
          .map((row) => row.meta?.happierStreamKey)
          .filter((key): key is string => typeof key === 'string' && key.length > 0),
      );
      expect(uniqueStreamKeys.size).toBe(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('dedupes repeated cumulative text deltas across partIDs for the same OpenCode messageID', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-dedupe-partids' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } },
      },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.delta',
        properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'OK' },
      },
    });

    // Some OpenCode builds can emit the same cumulative text again under a different partID.
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: { part: { id: 'part_2', type: 'text', sessionID: 'ses_1' } },
      },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.delta',
        properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_2', delta: 'OK' },
      },
    });

    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

    await expect(promptPromise).resolves.toBeUndefined();
    const committedCalls = getCommittedTranscriptRows(session, { type: 'message' });
    expect(committedCalls.map((row) => row.body?.message)).toEqual(['OK', 'OK']);
    expect(committedCalls[1]?.localId).toBe(committedCalls[0]?.localId);
    expect(committedCalls[committedCalls.length - 1]?.body?.message).toBe('OK');
  });

  it('streams reasoning deltas through transcript-vNext with a stable happierStreamKey', async () => {
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MS', '1000000');
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MIN_CHARS', '1000000');
    try {
      const client = createFakeClient();
      const session = createFakeSession();
      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-thinking-stream' });
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: { part: { id: 'reason_1', type: 'reasoning', sessionID: 'ses_1' } },
        },
      });
      await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_1', completed: null });

      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.delta',
          properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'reason_1', delta: 'A' },
        },
      });
      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.delta',
          properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'reason_1', delta: 'AB' },
        },
      });

      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

      await expect(promptPromise).resolves.toBeUndefined();

      const committedCalls = getCommittedTranscriptRows(session, { type: 'thinking' });
      expect(committedCalls.map((c) => c.body?.text)).toEqual(['A', 'AB']);
      expect(committedCalls[0]?.localId).toBeTruthy();
      expect(committedCalls[1]?.localId).toBe(committedCalls[0]?.localId);
      expect(committedCalls[0]?.meta?.happierStreamKey).toBeTruthy();
      expect(committedCalls[1]?.meta?.happierStreamKey).toBe(committedCalls[0]?.meta?.happierStreamKey);
      expect(committedCalls[1]?.meta?.happierStreamSegmentV1).toMatchObject({
        segmentLocalId: committedCalls[0]?.localId,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('flushes streamed assistant text before emitting an OpenCode tool-call boundary', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MS', '1000000');
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MIN_CHARS', '1000000');
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    try {
      const client = createFakeClient();
      const session = createFakeSession();
      runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-tool-boundary-stream' });
      void promptPromise.catch(() => {});
      await flushTranscriptCommitMicrotasks();
      expect(client.sessionPromptAsync).toHaveBeenCalledTimes(1);

      await client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.updated', properties: { part: { id: 'part_text_1', type: 'text', sessionID: 'ses_1' } } },
      });
      await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_tool_boundary_1', completed: null });
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_tool_boundary_1', partID: 'part_text_1', delta: 'HELLO' } },
      });
      const commitsBeforeToolCall = getCommittedTranscriptRows(session, { type: 'message' }).filter(
        (row) => String(row.meta?.happierStreamKey ?? '').includes('msg_asst_tool_boundary_1'),
      );
      expect(commitsBeforeToolCall.map((row) => row.body?.message)).toEqual(['HELLO']);

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.created',
          properties: {
            part: {
              id: 'part_tool_1',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_tool_1',
              callID: 'call_tool_1',
              tool: 'bash',
              state: { status: 'running', input: { command: 'echo hi' } },
            },
          },
        },
      });
      await flushTranscriptCommitMicrotasks();

      const committedCalls = getCommittedTranscriptRows(session, { type: 'message' }).filter(
        (row) => String(row.meta?.happierStreamKey ?? '').includes('msg_asst_tool_boundary_1'),
      );
      expect(committedCalls.map((row) => row.body?.message)).toEqual(['HELLO', 'HELLO']);
      expect(committedCalls[1]?.meta?.happierStreamSegmentV1).toMatchObject({
        segmentState: 'complete',
      });

      const toolCalls = (session.sendAgentMessage as any).mock.calls.filter(
        (call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'tool-call' && call?.[1]?.callId === 'call_tool_1',
      );
      expect(toolCalls).toHaveLength(1);
      const toolCallOrder = (session.sendAgentMessage as any).mock.invocationCallOrder.find(
        (_: unknown, index: number) => toolCalls.includes((session.sendAgentMessage as any).mock.calls[index]),
      );
      expect(toolCallOrder).toBeGreaterThan(committedCalls[1]?.callOrder ?? 0);

      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_final_tool_boundary' });
    } finally {
      await runtime?.cancel().catch(() => {});
      await runtime?.reset().catch(() => {});
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('resolves turns when OpenCode emits session.status idle without a session.idle event', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-2' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
    });
    await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_1', finish: 'stop' });
    await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_1', finish: 'stop' });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
    });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('fails an idle turn without terminal assistant evidence through the stuck-idle fallback', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_ACTIVE_CONTROL_POLL_INTERVAL_MS: '10',
      HAPPIER_OPENCODE_SERVER_IDLE_WITHOUT_TERMINAL_ASSISTANT_TIMEOUT_MS: '50',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const started = await beginOpenCodePromptForTest({ localId: 'local-stuck-idle-no-terminal' });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const { client, session } = started;
      const outcome = observePromiseSettlement(promptPromise);

      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });
      await advanceTimersAndFlush(49);

      expect(outcome.status).toBe('pending');
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(0);
      expect(session.sessionTurnLifecycle.failTurn).not.toHaveBeenCalled();
      expect(client.sessionAbort).not.toHaveBeenCalled();

      await advanceTimersAndFlush(1);

      expect(outcome.status).toBe('rejected');
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(0);
      expect(sentAgentMessagesOfType(session, 'turn_failed')).toEqual([
        expect.objectContaining({
          code: 'opencode_idle_without_terminal_assistant',
          reason: 'opencode_idle_without_terminal_assistant',
        }),
      ]);
      expect(client.sessionAbort).not.toHaveBeenCalled();
      expect(session.sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'opencode',
        issue: expect.objectContaining({
          code: 'opencode_idle_without_terminal_assistant',
        }),
      }));
      expect(session.keepAlive).toHaveBeenLastCalledWith(false, 'remote');
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('does not complete a tool-call continuation until a later final assistant terminal update arrives', async () => {
    const { client, session, runtime, promptPromise } = await beginOpenCodePromptForTest({
      localId: 'local-tool-call-continuation-gate',
    });
    const outcome = observePromiseSettlement(promptPromise);
    try {
      await emitAssistantMessageUpdated(client, {
        messageId: 'msg_tool_call_step',
        finish: 'tool-calls',
        completed: 10,
      });
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });
      await flushTranscriptCommitMicrotasks();

      expect(outcome.status).toBe('pending');
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(0);

      await emitAssistantMessageUpdated(client, {
        messageId: 'msg_tool_call_final',
        finish: 'stop',
        completed: 20,
      });
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });

      await expect(promptPromise).resolves.toBeUndefined();
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(1);
    } finally {
      await runtime.cancel().catch(() => {});
      await promptPromise.catch(() => undefined);
      await runtime.reset().catch(() => {});
    }
  });

  it('fails an idle turn after a tool-call continuation without a final assistant terminal update', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_IDLE_WITHOUT_TERMINAL_ASSISTANT_TIMEOUT_MS: '50',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const started = await beginOpenCodePromptForTest({
        localId: 'local-stuck-idle-after-tool-continuation',
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const { client, session } = started;
      const outcome = observePromiseSettlement(promptPromise);

      await emitAssistantMessageUpdated(client, {
        messageId: 'msg_tool_call_step_without_final',
        finish: 'tool-calls',
        completed: 10,
      });
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });
      await advanceTimersAndFlush(49);

      expect(outcome.status).toBe('pending');
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(0);
      expect(session.sessionTurnLifecycle.failTurn).not.toHaveBeenCalled();

      await advanceTimersAndFlush(1);

      expect(outcome.status).toBe('rejected');
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(0);
      expect(sentAgentMessagesOfType(session, 'turn_failed')).toEqual([
        expect.objectContaining({
          code: 'opencode_idle_without_terminal_assistant',
          reason: 'opencode_idle_without_terminal_assistant',
        }),
      ]);
      expect(client.sessionAbort).not.toHaveBeenCalled();
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('allows a later completed update for the same assistant message to unlock idle completion', async () => {
    const { client, session, runtime, promptPromise } = await beginOpenCodePromptForTest({
      localId: 'local-same-message-terminal-supersedes',
    });
    const outcome = observePromiseSettlement(promptPromise);
    try {
      await emitAssistantMessageUpdated(client, {
        messageId: 'msg_same_assistant_completion',
        finish: 'stop',
        completed: null,
      });
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });
      await flushTranscriptCommitMicrotasks();

      expect(outcome.status).toBe('pending');
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(0);

      await emitAssistantMessageUpdated(client, {
        messageId: 'msg_same_assistant_completion',
        finish: 'stop',
        completed: 20,
      });
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });

      await expect(promptPromise).resolves.toBeUndefined();
      expect(outcome.status).toBe('resolved');
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(1);
    } finally {
      await runtime.cancel().catch(() => {});
      await promptPromise.catch(() => undefined);
      await runtime.reset().catch(() => {});
    }
  });

  it('cancels the stuck-idle fallback when final assistant terminal evidence arrives before timeout', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_IDLE_WITHOUT_TERMINAL_ASSISTANT_TIMEOUT_MS: '50',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const started = await beginOpenCodePromptForTest({
        localId: 'local-stuck-idle-cancelled-by-terminal',
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const { client, session } = started;
      const outcome = observePromiseSettlement(promptPromise);

      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });
      await advanceTimersAndFlush(25);

      expect(outcome.status).toBe('pending');

      await emitAssistantMessageUpdated(client, {
        messageId: 'msg_terminal_before_fallback_timeout',
        finish: 'stop',
        completed: 10,
      });
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });
      await advanceTimersAndFlush(100);

      await expect(promptPromise).resolves.toBeUndefined();
      expect(outcome.status).toBe('resolved');
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(1);
      expect(sentAgentMessagesOfType(session, 'turn_failed')).toHaveLength(0);
      expect(session.sessionTurnLifecycle.failTurn).not.toHaveBeenCalled();
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('reconciles one exact-parent terminal assistant from authoritative inventory when real SSE frames are observation-only', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const client = createFakeClient();
      let promptUserMessageId = '';
      let promptSubmitted = false;
      let statusReadCount = 0;
      client.sessionPromptAsync = vi.fn(async (input) => {
        promptUserMessageId = input.messageId ?? '';
        promptSubmitted = true;
      });
      client.sessionMessagesList = vi.fn(async () => {
        if (!promptSubmitted) return [];
        const terminalAssistant = {
          info: {
            id: 'msg_exact_parent_terminal',
            role: 'assistant',
            sessionID: 'ses_1',
            parentID: promptUserMessageId,
            time: { created: 1_010, completed: 1_020 },
            finish: 'stop',
          },
          parts: [{ id: 'part_exact_parent_terminal', type: 'text', text: 'EXACT_PARENT_FINAL' }],
        };
        return [
          {
            info: { id: promptUserMessageId, role: 'user', sessionID: 'ses_1', time: { created: 1_005 } },
            parts: [{ id: 'part_current_user', type: 'text', text: 'hello' }],
          },
          terminalAssistant,
          // A duplicated provider inventory row must not duplicate transcript or terminal outcome.
          terminalAssistant,
        ];
      });
      client.sessionStatusList = vi.fn(async () => {
        if (!promptSubmitted) return {};
        statusReadCount += 1;
        return statusReadCount === 1 ? { ses_1: { type: 'busy' } } : {};
      });

      const started = await beginOpenCodePromptForTest({
        client,
        session: mirrorLifecycleMarkersForTest(createFakeSession()),
        localId: 'local-exact-parent-inventory-reconciliation',
        env: {
          ...process.env,
          HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS: '25',
          HAPPIER_OPENCODE_SERVER_ACTIVE_CONTROL_POLL_INTERVAL_MS: '25',
          HAPPIER_OPENCODE_SERVER_IDLE_WITHOUT_TERMINAL_ASSISTANT_TIMEOUT_MS: '1000',
          HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
        },
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const outcome = observePromiseSettlement(promptPromise);
      expect(promptUserMessageId).not.toBe('');

      // Production OpenCode clients classify every post-server.connected frame this way because
      // arrival order cannot distinguish replay. These frames therefore remain observation-only.
      await started.client.__emitUntrusted({
        directory: '/tmp',
        payload: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg_exact_parent_terminal',
              role: 'assistant',
              sessionID: 'ses_1',
              parentID: promptUserMessageId,
              time: { completed: 1_020 },
              finish: 'stop',
            },
          },
        },
      });
      await started.client.__emitUntrusted({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });
      expect(outcome.status).toBe('pending');
      expect(getCommittedTranscriptRows(started.session, { type: 'message', sidechainId: null })).toHaveLength(0);

      await advanceTimersAndFlush(25);

      expect(outcome.status).toBe('resolved');
      await expect(promptPromise).resolves.toBeUndefined();
      const committedRows = getCommittedTranscriptRows(started.session, { type: 'message', sidechainId: null });
      expect(committedRows.length).toBeGreaterThan(0);
      expect(committedRows.every((row) => (
        row.body.message === 'EXACT_PARENT_FINAL'
        && row.meta.opencodeMessageId === 'msg_exact_parent_terminal'
      ))).toBe(true);
      expect(new Set(committedRows.map((row) => row.localId)).size).toBe(1);
      expect(committedRows.at(-1)?.meta.happierStreamSegmentV1).toEqual(expect.objectContaining({
        segmentState: 'complete',
      }));
      expect(sentAgentMessagesOfType(started.session, 'task_complete')).toHaveLength(1);
      expect(sentAgentMessagesOfType(started.session, 'turn_failed')).toHaveLength(0);
      expect(started.session.sessionTurnLifecycle.failTurn).not.toHaveBeenCalled();
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      await runtime?.reset().catch(() => {});
      vi.useRealTimers();
    }
  });

  it('projects only the exact current turn from replayable OpenCode observations before terminal inventory reconciliation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const client = createFakeClient();
      let promptUserMessageId = '';
      client.sessionMessagesList.mockResolvedValue([
        {
          info: {
            id: 'msg_historical_assistant',
            role: 'assistant',
            sessionID: 'ses_1',
            parentID: 'msg_historical_user',
            time: { created: 900, completed: 950 },
            finish: 'stop',
          },
          parts: [{
            id: 'part_historical_text',
            type: 'text',
            sessionID: 'ses_1',
            messageID: 'msg_historical_assistant',
            text: 'REPLAYED_HISTORY_MUST_NOT_PROJECT',
          }],
        },
      ]);
      client.sessionPromptAsync = vi.fn(async (input) => {
        promptUserMessageId = input.messageId ?? '';
      });
      client.sessionStatusList.mockResolvedValue({ ses_1: { type: 'busy' } });

      const started = await beginOpenCodePromptForTest({
        client,
        localId: 'local-replay-safe-live-projection',
        env: {
          ...process.env,
          HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS: '25',
          HAPPIER_OPENCODE_SERVER_ACTIVE_CONTROL_POLL_INTERVAL_MS: '25',
          HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
        },
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      expect(promptUserMessageId).not.toBe('');

      await client.__emitUntrusted({
        directory: '/tmp',
        payload: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg_historical_assistant',
              role: 'assistant',
              sessionID: 'ses_1',
              parentID: 'msg_historical_user',
              time: { created: 900, completed: 950 },
              finish: 'stop',
            },
          },
        },
      });
      await client.__emitUntrusted({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_historical_text',
              type: 'text',
              sessionID: 'ses_1',
              messageID: 'msg_historical_assistant',
              text: 'REPLAYED_HISTORY_MUST_NOT_PROJECT',
            },
          },
        },
      });
      await client.__emitUntrusted({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_uncorrelated_new_tool',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_uncorrelated_new_assistant',
              callID: 'call_uncorrelated_new_tool',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: 'echo MUST_NOT_PROJECT' },
                output: 'MUST_NOT_PROJECT',
              },
            },
          },
        },
      });

      await client.__emitUntrusted({
        directory: '/tmp',
        payload: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg_current_assistant',
              role: 'assistant',
              sessionID: 'ses_1',
              parentID: promptUserMessageId,
              time: { created: 1_010 },
            },
          },
        },
      });
      await client.__emitUntrusted({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_current_text',
              type: 'text',
              sessionID: 'ses_1',
              messageID: 'msg_current_assistant',
              text: 'CURRENT_TURN_INTERMEDIATE',
            },
          },
        },
      });
      await flushTranscriptCommitMicrotasks();

      const committedRows = getCommittedTranscriptRows(started.session, { type: 'message', sidechainId: null });
      expect(committedRows.map((row) => row.body.message)).toEqual(['CURRENT_TURN_INTERMEDIATE']);
      expect(
        sentAgentMessagesOfType(started.session, 'tool-call')
          .filter((message) => (
            typeof message === 'object'
            && message !== null
            && 'callId' in message
            && message.callId === 'call_uncorrelated_new_tool'
          )),
      ).toHaveLength(0);
      expect(sentAgentMessagesOfType(started.session, 'task_complete')).toHaveLength(0);
      expect(sentAgentMessagesOfType(started.session, 'turn_failed')).toHaveLength(0);
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      await runtime?.reset().catch(() => {});
      vi.useRealTimers();
    }
  });

  it('fails an exact-parent completed assistant carrying a provider error from authoritative inventory', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const client = createFakeClient();
      let promptUserMessageId = '';
      let promptSubmitted = false;
      let statusReadCount = 0;
      client.sessionPromptAsync = vi.fn(async (input) => {
        promptUserMessageId = input.messageId ?? '';
        promptSubmitted = true;
      });
      client.sessionMessagesList = vi.fn(async () => {
        if (!promptSubmitted) return [];
        return [
          {
            info: {
              id: promptUserMessageId,
              role: 'user',
              sessionID: 'ses_1',
              time: { created: 1_005 },
            },
            parts: [{ id: 'part_current_user', type: 'text', text: 'hello' }],
          },
          {
            info: {
              id: 'msg_exact_parent_provider_error',
              role: 'assistant',
              sessionID: 'ses_1',
              parentID: promptUserMessageId,
              time: { created: 1_010, completed: 1_020 },
              error: {
                name: 'UnknownError',
                data: { message: 'happier_broker_bridge_status_401' },
              },
            },
            parts: [],
          },
        ];
      });
      client.sessionStatusList = vi.fn(async () => {
        if (!promptSubmitted) return {};
        statusReadCount += 1;
        return statusReadCount === 1 ? { ses_1: { type: 'busy' } } : {};
      });

      const started = await beginOpenCodePromptForTest({
        client,
        session: mirrorLifecycleMarkersForTest(createFakeSession()),
        localId: 'local-exact-parent-provider-error',
        env: {
          ...process.env,
          HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS: '25',
          HAPPIER_OPENCODE_SERVER_ACTIVE_CONTROL_POLL_INTERVAL_MS: '25',
          HAPPIER_OPENCODE_SERVER_IDLE_WITHOUT_TERMINAL_ASSISTANT_TIMEOUT_MS: '1000',
          HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
        },
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const outcome = observePromiseSettlement(promptPromise);

      await advanceTimersAndFlush(25);

      expect(outcome.status).toBe('rejected');
      await expect(promptPromise).rejects.toThrow('happier_broker_bridge_status_401');
      expect(sentAgentMessagesOfType(started.session, 'task_complete')).toHaveLength(0);
      expect(started.session.sessionTurnLifecycle.failTurn).toHaveBeenCalledTimes(1);
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      await runtime?.reset().catch(() => {});
      vi.useRealTimers();
    }
  });

  it('defers live session.error adjudication until idle confirms an exact-parent terminal provider error', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_IDLE_WITHOUT_TERMINAL_ASSISTANT_TIMEOUT_MS: '1000',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const client = createFakeClient();
      let promptUserMessageId = '';
      let terminalInventoryReady = false;
      client.sessionPromptAsync = vi.fn(async (input) => {
        promptUserMessageId = input.messageId ?? '';
      });
      client.sessionMessagesList = vi.fn(async () => terminalInventoryReady
        ? [
            {
              info: { id: promptUserMessageId, role: 'user', sessionID: 'ses_1', time: { created: 10 } },
              parts: [{ id: 'part_current_user', type: 'text', text: 'hello' }],
            },
            {
              info: {
                id: 'msg_current_provider_error',
                role: 'assistant',
                sessionID: 'ses_1',
                parentID: promptUserMessageId,
                time: { created: 11, completed: 12 },
                error: {
                  name: 'ProviderModelNotFoundError',
                  data: { message: 'Model not found: openai-codex/gpt-5.6-luna' },
                },
              },
              parts: [],
            },
          ]
        : []);

      const started = await beginOpenCodePromptForTest({
        client,
        session: mirrorLifecycleMarkersForTest(createFakeSession()),
        localId: 'local-live-provider-error',
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const outcome = observePromiseSettlement(promptPromise);

      const liveError = {
        directory: '/tmp',
        payload: {
          type: 'session.error',
          properties: {
            sessionID: 'ses_1',
            error: {
              name: 'ProviderModelNotFoundError',
              data: { message: 'Model not found: openai-codex/gpt-5.6-luna' },
            },
          },
        },
      } satisfies OpenCodeGlobalEvent;
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
      });
      await client.__emit(liveError);
      await client.__emit(liveError);
      await flushTranscriptCommitMicrotasks();

      expect(outcome.status).toBe('pending');
      expect(started.session.sessionTurnLifecycle.failTurn).not.toHaveBeenCalled();
      expect(sentAgentMessagesOfType(started.session, 'task_complete')).toHaveLength(0);

      terminalInventoryReady = true;
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
      });

      await expect(promptPromise).rejects.toThrow('Model not found: openai-codex/gpt-5.6-luna');
      await expect.poll(() => started.session.sessionTurnLifecycle.failTurn.mock.calls.length).toBe(1);
      expect(sentAgentMessagesOfType(started.session, 'task_complete')).toHaveLength(0);

      await emitAssistantMessageUpdated(client, {
        messageId: 'msg_late_success_after_error',
        finish: 'stop',
        completed: 20,
      });
      expect(sentAgentMessagesOfType(started.session, 'task_complete')).toHaveLength(0);
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('does not let an uncorrelated live session.error fail a valid current assistant completion', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const client = createFakeClient();
      let promptUserMessageId = '';
      client.sessionPromptAsync = vi.fn(async (input) => {
        promptUserMessageId = input.messageId ?? '';
      });
      client.sessionMessagesList = vi.fn(async () => [
        {
          info: { id: promptUserMessageId, role: 'user', sessionID: 'ses_1', time: { created: 10 } },
          parts: [{ id: 'part_current_user', type: 'text', text: 'hello' }],
        },
        {
          info: {
            id: 'msg_current_success',
            role: 'assistant',
            sessionID: 'ses_1',
            parentID: promptUserMessageId,
            time: { created: 11, completed: 12 },
            finish: 'stop',
          },
          parts: [{ id: 'part_current_success', type: 'text', text: 'ok' }],
        },
      ]);

      const started = await beginOpenCodePromptForTest({
        client,
        session: mirrorLifecycleMarkersForTest(createFakeSession()),
        localId: 'local-ignore-uncorrelated-live-error',
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const outcome = observePromiseSettlement(promptPromise);

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.error',
          properties: {
            sessionID: 'ses_1',
            error: { name: 'UnknownError', data: { message: 'failure from another author' } },
          },
        },
      });
      await flushTranscriptCommitMicrotasks();
      expect(outcome.status).toBe('pending');

      await emitAssistantMessageUpdated(client, {
        messageId: 'msg_current_success',
        finish: 'stop',
        completed: 12,
        extraInfo: { parentID: promptUserMessageId },
      });
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });

      await expect(promptPromise).resolves.toBeUndefined();
      expect(sentAgentMessagesOfType(started.session, 'task_complete')).toHaveLength(1);
      expect(started.session.sessionTurnLifecycle.failTurn).not.toHaveBeenCalled();
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('rejects stale and wrong-parent terminal inventory instead of satisfying idle completion', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_IDLE_WITHOUT_TERMINAL_ASSISTANT_TIMEOUT_MS: '50',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const client = createFakeClient();
      let promptUserMessageId = '';
      let promptSubmitted = false;
      client.sessionPromptAsync = vi.fn(async (input) => {
        promptUserMessageId = input.messageId ?? '';
        promptSubmitted = true;
      });
      client.sessionMessagesList = vi.fn(async () => {
        const staleAssistant = {
          info: {
            id: 'msg_stale_terminal',
            role: 'assistant',
            sessionID: 'ses_1',
            parentID: 'msg_old_user',
            time: { created: 1, completed: 2 },
            finish: 'stop',
          },
          parts: [{ type: 'text', text: 'STALE_SHOULD_NOT_STREAM' }],
        };
        if (!promptSubmitted) {
          return [
            { info: { id: 'msg_old_user', role: 'user', sessionID: 'ses_1', time: { created: 0 } }, parts: [] },
            staleAssistant,
          ];
        }
        return [
          { info: { id: 'msg_old_user', role: 'user', sessionID: 'ses_1', time: { created: 0 } }, parts: [] },
          staleAssistant,
          {
            info: { id: promptUserMessageId, role: 'user', sessionID: 'ses_1', time: { created: 3 } },
            parts: [{ type: 'text', text: 'hello' }],
          },
          {
            info: {
              id: 'msg_new_wrong_parent_terminal',
              role: 'assistant',
              sessionID: 'ses_1',
              parentID: 'msg_unrelated_user',
              time: { created: 4, completed: 5 },
              finish: 'stop',
            },
            parts: [{ type: 'text', text: 'WRONG_PARENT_SHOULD_NOT_STREAM' }],
          },
        ];
      });
      const started = await beginOpenCodePromptForTest({
        client,
        localId: 'local-no-history-backfill-completion',
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const outcome = observePromiseSettlement(promptPromise);

      await started.client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });
      await advanceTimersAndFlush(50);

      expect(outcome.status).toBe('rejected');
      expect(sentAgentMessagesOfType(started.session, 'task_complete')).toHaveLength(0);
      expect(JSON.stringify(started.session.sendAgentMessageCommitted.mock.calls)).not.toContain('STALE_SHOULD_NOT_STREAM');
      expect(JSON.stringify(started.session.sendAgentMessageCommitted.mock.calls)).not.toContain('WRONG_PARENT_SHOULD_NOT_STREAM');
      // The existing control loop may revisit idle resolution while the failure fallback is pending.
      // Authoritative inventory reconciliation is one boundary read, not a new history poll.
      expect(client.sessionMessagesListRaw).toHaveBeenCalledTimes(2);
      expect(started.session.sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
        issue: expect.objectContaining({ code: 'opencode_idle_without_terminal_assistant' }),
      }));
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('ignores broad history running tools when live completion evidence is satisfied', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS: '25',
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '1',
    });
    vi.useFakeTimers();
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const client = createFakeClient();
      client.sessionPromptAsync = vi.fn(async () => {
        client.__setStatusType('busy');
      });
      client.sessionStatusList = vi.fn(async () => ({}));
      client.sessionMessagesList
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          {
            info: { id: 'msg_unrelated_history_running', role: 'assistant', sessionID: 'ses_1' },
            parts: [{
              id: 'part_unrelated_history_running',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_unrelated_history_running',
              callID: 'call_unrelated_history_running',
              tool: 'grep',
              state: { status: 'running', input: { pattern: 'old', path: '/tmp/old.log' } },
            }],
          },
        ]);
      const started = await beginOpenCodePromptForTest({
        client,
        session: mirrorLifecycleMarkersForTest(createFakeSession()),
        localId: 'local-ignore-broad-history-running',
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const outcome = observePromiseSettlement(promptPromise);

      await emitAssistantMessageUpdated(started.client, {
        messageId: 'msg_live_terminal_ignores_history',
        finish: 'stop',
      });
      await advanceTimersAndFlush(50);

      expect(outcome.status).toBe('resolved');
      expect(sentAgentMessagesOfType(started.session, 'task_complete')).toHaveLength(1);
      expect(sentAgentMessagesOfType(started.session, 'tool-call')).toHaveLength(0);
      expect(sentAgentMessagesOfType(started.session, 'tool-result')).toHaveLength(0);
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('does not import acp-live-sync assistant history for an owned runtime session with no active turn', async () => {
    const client = createFakeClient();
    client.sessionMessagesList.mockResolvedValue([
      {
        info: { id: 'msg_idle_external_assistant', role: 'assistant', sessionID: 'ses_1', time: { completed: 1 }, finish: 'stop' },
        parts: [{ type: 'text', text: 'NO_ACTIVE_TURN_ASSISTANT_IMPORT_SHOULD_NOT_APPEAR' }],
      },
    ]);
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });
    await flushTranscriptCommitMicrotasks();

    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalledWith(
      'opencode',
      expect.objectContaining({ message: expect.stringContaining('NO_ACTIVE_TURN_ASSISTANT_IMPORT_SHOULD_NOT_APPEAR') }),
      expect.objectContaining({ meta: expect.objectContaining({ importedFrom: 'acp-live-sync' }) }),
    );

    await runtime.reset().catch(() => {});
  });

  it('routes context-overflow session errors to context compaction lifecycle without failing the active turn', async () => {
    const { client, session, runtime, promptPromise } = await beginOpenCodePromptForTest({
      localId: 'local-context-overflow-compaction',
      env: {
        HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
        HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
      },
    });
    const outcome = observePromiseSettlement(promptPromise);

    await client.__emit({
      directory: '/tmp',
      payload: {
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: { message: 'Context length exceeded. Please compact the session and try again.' },
        },
      },
    });
    await flushTranscriptCommitMicrotasks();

    expect(sentAgentMessagesOfType(session, 'context-compaction')).toHaveLength(1);
    expect(session.sessionTurnLifecycle.failTurn).not.toHaveBeenCalled();
    expect(sentAgentMessagesOfType(session, 'turn_failed')).toHaveLength(0);
    expect(outcome.status).toBe('pending');

    await runtime.cancel();
    await expect(promptPromise).rejects.toThrow('OpenCode session aborted');
  });

  it('clears overflow compaction suppression when normal terminal assistant output resumes', async () => {
    const { client, session, runtime, promptPromise } = await beginOpenCodePromptForTest({
      localId: 'local-context-overflow-normal-output-resumes',
      env: {
        HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
        HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
      },
    });

    try {
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.error',
          properties: {
            sessionID: 'ses_1',
            error: { message: 'Context length exceeded. Please compact the session and try again.' },
          },
        },
      });
      await flushTranscriptCommitMicrotasks();

      expect(sentAgentMessagesOfType(session, 'context-compaction')).toHaveLength(1);
      expect(sentAgentMessagesOfType(session, 'turn_failed')).toHaveLength(0);

      await emitAssistantMessageUpdated(client, {
        messageId: 'msg_recovered_after_overflow',
        finish: 'stop',
        completed: 20,
      });
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_recovered_after_overflow',
              type: 'text',
              sessionID: 'ses_1',
              messageID: 'msg_recovered_after_overflow',
              text: 'RECOVERED_AFTER_OVERFLOW',
            },
          },
        },
      });
      await flushTranscriptCommitMicrotasks();

      expect(getCommittedTranscriptRows(session, { type: 'message' }).map((row) => row.body.message)).toContain(
        'RECOVERED_AFTER_OVERFLOW',
      );

      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });

      await expect(promptPromise).resolves.toBeUndefined();
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(1);
      expect(sentAgentMessagesOfType(session, 'turn_failed')).toHaveLength(0);
    } finally {
      await runtime.cancel().catch(() => {});
      await promptPromise.catch(() => undefined);
      await runtime.reset().catch(() => {});
    }
  });

  it('does not complete the local turn while a live provider tool is still running', async () => {
    const { client, session, runtime, promptPromise } = await beginOpenCodePromptForTest({
      localId: 'local-live-tool-completion-gate',
    });
    const outcome = observePromiseSettlement(promptPromise);
    try {
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_live_tool', partID: 'part_text_live_tool', delta: 'working' } },
      });
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_live_tool',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_tool_live',
              callID: 'call_live_tool',
              tool: 'bash',
              state: { status: 'running', input: { command: 'sleep 30' } },
            },
          },
        },
      });
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });
      await flushTranscriptCommitMicrotasks();

      expect(outcome.status).toBe('pending');
      expect(session.keepAlive).not.toHaveBeenLastCalledWith(false, 'remote');
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(0);
      expect(session.sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();
      expect(sentAgentMessagesOfType(session, 'message')).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringMatching(/still waiting|waiting on OpenCode tool/i) }),
        ]),
      );

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_live_tool',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_tool_live',
              callID: 'call_live_tool',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: 'sleep 30' },
                output: 'done',
                metadata: {},
              },
            },
          },
        },
      });
      await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_live_tool_final', finish: 'stop' });

      await expect(promptPromise).resolves.toBeUndefined();
      expect(sentAgentMessagesOfType(session, 'tool-result')).toEqual([
        expect.objectContaining({ callId: 'call_live_tool' }),
      ]);
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(1);
    } finally {
      await runtime.cancel().catch(() => {});
      await promptPromise.catch(() => undefined);
      await runtime.reset().catch(() => {});
    }
  });

  it('does not stream synthetic or ignored live text parts', async () => {
    const { client, session, runtime, promptPromise } = await beginOpenCodePromptForTest({
      localId: 'local-filter-live-internal-parts',
    });
    try {
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_synthetic_text',
              type: 'text',
              sessionID: 'ses_1',
              messageID: 'msg_synthetic_text',
              text: 'SYNTHETIC_LIVE_TEXT_SHOULD_NOT_STREAM',
              synthetic: true,
            },
          },
        },
      });
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'ses_1',
            messageID: 'msg_synthetic_text',
            partID: 'part_synthetic_text',
            delta: 'SYNTHETIC_DELTA_SHOULD_NOT_STREAM',
          },
        },
      });
      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_synthetic_text', finish: 'stop' });

      await expect(promptPromise).resolves.toBeUndefined();
      expect(JSON.stringify(getCommittedTranscriptRows(session))).not.toContain('SYNTHETIC_');
    } finally {
      await runtime.cancel().catch(() => {});
      await promptPromise.catch(() => undefined);
      await runtime.reset().catch(() => {});
    }
  });

  it('does not stream compaction text parts while a provider compaction lifecycle is active', async () => {
    const { client, session, runtime, promptPromise } = await beginOpenCodePromptForTest({
      localId: 'local-filter-live-compaction-parts',
    });
    try {
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.next.compaction.started',
          properties: { sessionID: 'ses_1', compactionID: 'compact_1', reason: 'auto' },
        },
      });
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_compaction_summary',
              type: 'text',
              sessionID: 'ses_1',
              messageID: 'msg_compaction_summary_live',
              text: 'COMPACTION_SUMMARY_SHOULD_NOT_STREAM',
            },
          },
        },
      });
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'ses_1',
            messageID: 'msg_compaction_summary_live',
            partID: 'part_compaction_summary',
            delta: 'COMPACTION_DELTA_SHOULD_NOT_STREAM',
          },
        },
      });
      await emitAssistantMessageUpdated(client, {
        messageId: 'msg_compaction_summary_live',
        finish: 'stop',
        extraInfo: { summary: true, mode: 'compaction', agent: 'compaction' },
      });
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.next.compaction.ended',
          properties: { sessionID: 'ses_1', compactionID: 'compact_1' },
        },
      });
      await flushTranscriptCommitMicrotasks();

      expect(JSON.stringify(getCommittedTranscriptRows(session))).not.toContain('COMPACTION_');
      expect(sentAgentMessagesOfType(session, 'context-compaction')).toHaveLength(2);
    } finally {
      await runtime.cancel().catch(() => {});
      await promptPromise.catch(() => undefined);
      await runtime.reset().catch(() => {});
    }
  });

  it('drops compaction summary text that arrives after the provider compaction lifecycle completes', async () => {
    const { client, session, runtime, promptPromise } = await beginOpenCodePromptForTest({
      localId: 'local-filter-post-compaction-summary-parts',
    });
    try {
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.next.compaction.started',
          properties: { sessionID: 'ses_1', compactionID: 'compact_after_end', reason: 'auto' },
        },
      });
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.next.compaction.ended',
          properties: { sessionID: 'ses_1', compactionID: 'compact_after_end' },
        },
      });
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'ses_1',
            messageID: 'msg_post_compaction_summary',
            partID: 'part_post_compaction_summary',
            delta: 'COMPACTION_AFTER_END_SHOULD_NOT_PERSIST',
          },
        },
      });
      await emitAssistantMessageUpdated(client, {
        messageId: 'msg_post_compaction_summary',
        finish: 'stop',
        extraInfo: { summary: true, mode: 'compaction', agent: 'compaction' },
      });
      await flushTranscriptCommitMicrotasks();

      expect(JSON.stringify(getCommittedTranscriptRows(session))).not.toContain('COMPACTION_AFTER_END_');
      expect(sentAgentMessagesOfType(session, 'context-compaction')).toHaveLength(2);
    } finally {
      await runtime.cancel().catch(() => {});
      await promptPromise.catch(() => undefined);
      await runtime.reset().catch(() => {});
    }
  });

  it('does not complete from missing status while current-turn history has a missed running provider tool', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS: '25',
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '1',
    });
    vi.useFakeTimers();
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const client = createFakeClient();
      client.sessionPromptAsync = vi.fn(async () => {
        client.__setStatusType('busy');
      });
      client.sessionStatusList = vi.fn(async () => ({}));
      client.sessionMessagesList
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          {
            info: { id: 'msg_asst_cross_layer_running', role: 'assistant', sessionID: 'ses_1' },
            parts: [{
              id: 'part_cross_layer_running',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_asst_cross_layer_running',
              callID: 'call_cross_layer_running',
              tool: 'bash',
              state: { status: 'running', input: { command: 'sleep 30' } },
            }],
          },
        ]);
      const session = mirrorLifecycleMarkersForTest(createFakeSession());
      const started = await beginOpenCodePromptForTest({
        client,
        session,
        localId: 'local-cross-layer-history-running',
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const outcome = observePromiseSettlement(promptPromise);

      await started.client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_cross_layer_running', partID: 'part_text_cross_layer_running', delta: 'working' } },
      });
      await emitAssistantMessageUpdated(started.client, { messageId: 'msg_asst_cross_layer_running', finish: 'stop' });
      await advanceTimersAndFlush(50);

      expect(outcome.status).toBe('pending');
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(0);
      expect(session.sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('ingests no-active-turn provider tool events without creating lifecycle rows or poisoning the next turn', async () => {
    const client = createFakeClient();
    const session = mirrorLifecycleMarkersForTest(createFakeSession());
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });
    try {
      await runtime.startOrLoad({});

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_no_active_tool',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_no_active_tool',
              callID: 'call_no_active_tool',
              tool: 'bash',
              state: { status: 'running', input: { command: 'echo outside-turn' } },
            },
          },
        },
      });
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_no_active_tool',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_no_active_tool',
              callID: 'call_no_active_tool',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: 'echo outside-turn' },
                output: 'outside-turn',
                metadata: {},
              },
            },
          },
        },
      });
      await flushTranscriptCommitMicrotasks();

      expect(sentAgentMessagesOfType(session, 'tool-call')).toEqual([
        expect.objectContaining({ callId: 'call_no_active_tool' }),
      ]);
      expect(sentAgentMessagesOfType(session, 'tool-result')).toEqual([
        expect.objectContaining({ callId: 'call_no_active_tool' }),
      ]);
      expect(session.sessionTurnLifecycle.beginTurn).not.toHaveBeenCalled();
      expect(session.sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();

      runtime.beginTurn();
      const promptPromise = (runtime as unknown as {
        sendPromptWithMeta: (params: { text: string; localId: string }) => Promise<void>;
      }).sendPromptWithMeta({ text: 'hello', localId: 'local-after-no-active-tool' });
      void promptPromise.catch(() => undefined);
      await flushTranscriptCommitMicrotasks();
      expect(client.sessionPromptAsync).toHaveBeenCalledTimes(1);
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_after_no_active_tool', partID: 'part_text_after_no_active_tool', delta: 'ok' } },
      });
      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_after_no_active_tool' });

      await expect(promptPromise).resolves.toBeUndefined();
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(1);
      expect(session.sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.cancel().catch(() => {});
      await runtime.reset().catch(() => {});
    }
  });

  it('does not retain no-active-turn session.next tool events as foreground work', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const client = createFakeClient();
      const session = mirrorLifecycleMarkersForTest(createFakeSession());
      runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
      });
      await runtime.startOrLoad({});

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.next.tool.called',
          properties: {
            sessionID: 'ses_1',
            messageID: 'msg_no_active_next_tool',
            callID: 'call_no_active_next_tool',
            tool: 'bash',
            input: {},
          },
        },
      });
      await flushTranscriptCommitMicrotasks();
      expect(session.sessionTurnLifecycle.beginTurn).not.toHaveBeenCalled();
      expect(session.sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();

      runtime.beginTurn();
      promptPromise = (runtime as unknown as {
        sendPromptWithMeta: (params: { text: string; localId: string }) => Promise<void>;
      }).sendPromptWithMeta({ text: 'hello', localId: 'local-after-no-active-next-tool' });
      void promptPromise.catch(() => undefined);
      const outcome = observePromiseSettlement(promptPromise);
      await flushTranscriptCommitMicrotasks();

      await client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_after_no_active_next_tool', partID: 'part_text_after_no_active_next_tool', delta: 'ok' } },
      });
      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_after_no_active_next_tool' });
      await flushTranscriptCommitMicrotasks();

      expect(outcome.status).toBe('resolved');
      expect(client.sessionAbort).not.toHaveBeenCalled();
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(1);
      expect(session.sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('does not complete from missing status while refreshed current-turn history still contains a running provider tool', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS: '25',
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '1',
    });
    vi.useFakeTimers();
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const client = createFakeClient();
      client.sessionPromptAsync = vi.fn(async () => {
        client.__setStatusType('busy');
      });
      client.sessionStatusList = vi.fn(async () => ({}));
      client.sessionMessagesList
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          {
            info: { id: 'msg_asst_history_running', role: 'assistant', sessionID: 'ses_1' },
            parts: [{
              id: 'part_history_running',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_asst_history_running',
              callID: 'call_history_running',
              tool: 'grep',
              state: { status: 'running', input: { pattern: 'needle', path: '/tmp/server.log' } },
            }],
          },
        ]);
      const started = await beginOpenCodePromptForTest({
        client,
        localId: 'local-missing-status-history-running',
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const outcome = observePromiseSettlement(promptPromise);

      await started.client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_history_running', partID: 'part_text_history_running', delta: 'working' } },
      });
      await emitAssistantMessageUpdated(started.client, { messageId: 'msg_asst_history_running', finish: 'stop' });
      await advanceTimersAndFlush(100);

      expect(outcome.status).toBe('pending');
      expect(sentAgentMessagesOfType(started.session, 'task_complete')).toHaveLength(0);
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('ignores stale pre-prompt running tool history when resolving a later turn from missing status', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS: '25',
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '1',
    });
    vi.useFakeTimers();
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const client = createFakeClient();
      client.sessionPromptAsync = vi.fn(async () => {
        client.__setStatusType('busy');
      });
      client.sessionStatusList = vi.fn(async () => ({}));
      client.sessionMessagesList.mockResolvedValue([
        {
          info: { id: 'msg_stale_running_tool', role: 'assistant', sessionID: 'ses_1' },
          parts: [{
            id: 'part_stale_running_tool',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_stale_running_tool',
            callID: 'call_stale_running_tool',
            tool: 'grep',
            state: { status: 'running', input: { pattern: 'old', path: '/tmp/old-server.log' } },
          }],
        },
      ]);
      const started = await beginOpenCodePromptForTest({
        client,
        session: mirrorLifecycleMarkersForTest(createFakeSession()),
        localId: 'local-missing-status-stale-history-running',
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const outcome = observePromiseSettlement(promptPromise);

      await started.client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_current_text_after_stale_history', partID: 'part_current_text_after_stale_history', delta: 'done' } },
      });
      await emitAssistantMessageUpdated(started.client, { messageId: 'msg_current_text_after_stale_history', finish: 'stop' });
      await advanceTimersAndFlush(50);

      expect(outcome.status).toBe('resolved');
      expect(sentAgentMessagesOfType(started.session, 'task_complete')).toHaveLength(1);
      expect(started.session.sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
      expect(sentAgentMessagesOfType(started.session, 'tool-call')).toHaveLength(0);
      expect(sentAgentMessagesOfType(started.session, 'tool-result')).toHaveLength(0);
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('does not forward stale pre-prompt terminal tool history into a later turn', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS: '25',
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '1',
    });
    vi.useFakeTimers();
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const client = createFakeClient();
      client.sessionPromptAsync = vi.fn(async () => {
        client.__setStatusType('busy');
      });
      client.sessionStatusList = vi.fn(async () => ({}));
      client.sessionMessagesList.mockResolvedValue([
        {
          info: { id: 'msg_stale_terminal_tool', role: 'assistant', sessionID: 'ses_1' },
          parts: [{
            id: 'part_stale_terminal_tool',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_stale_terminal_tool',
            callID: 'call_stale_terminal_tool',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'echo old' },
              output: 'old output',
              metadata: {},
            },
          }],
        },
      ]);
      const started = await beginOpenCodePromptForTest({
        client,
        session: mirrorLifecycleMarkersForTest(createFakeSession()),
        localId: 'local-missing-status-stale-history-terminal',
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;

      await started.client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_current_text_after_stale_terminal_history', partID: 'part_current_text_after_stale_terminal_history', delta: 'done' } },
      });
      await emitAssistantMessageUpdated(started.client, { messageId: 'msg_current_text_after_stale_terminal_history', finish: 'stop' });
      await advanceTimersAndFlush(50);

      await expect(promptPromise).resolves.toBeUndefined();
      expect(sentAgentMessagesOfType(started.session, 'task_complete')).toHaveLength(1);
      expect(started.session.sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
      expect(sentAgentMessagesOfType(started.session, 'tool-call')).toHaveLength(0);
      expect(sentAgentMessagesOfType(started.session, 'tool-result')).toHaveLength(0);
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('clears foreground provider work after explicit cancel so a later prompt can complete', async () => {
    const client = createFakeClient();
    const session = mirrorLifecycleMarkersForTest(createFakeSession());
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();
    const firstPromptPromise = (runtime as unknown as {
      sendPromptWithMeta: (params: { text: string; localId: string }) => Promise<void>;
    }).sendPromptWithMeta({ text: 'first', localId: 'local-cancel-active-tool-first' });
    void firstPromptPromise.catch(() => undefined);
    await flushTranscriptCommitMicrotasks();

    await client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_cancelled_tool',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_cancelled_tool',
            callID: 'call_cancelled_tool',
            tool: 'bash',
            state: { status: 'running', input: { command: 'sleep 30' } },
          },
        },
      },
    });

    await runtime.cancel();
    await expect(firstPromptPromise).rejects.toThrow(/aborted/i);

    runtime.beginTurn();
    const secondPromptPromise = (runtime as unknown as {
      sendPromptWithMeta: (params: { text: string; localId: string }) => Promise<void>;
    }).sendPromptWithMeta({ text: 'second', localId: 'local-cancel-active-tool-second' });
    void secondPromptPromise.catch(() => undefined);
    await flushTranscriptCommitMicrotasks();

    await client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_after_cancel', partID: 'part_after_cancel', delta: 'ok' } },
    });
    await emitAssistantMessageUpdated(client, { messageId: 'msg_after_cancel', finish: 'stop' });
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    await expect(secondPromptPromise).resolves.toBeUndefined();
    expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(1);
    expect(session.sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);

    await runtime.reset().catch(() => {});
  });

  it('resolves turns when the control-plane /session/status reports idle and idle SSE signals are missing', async () => {
    const prevPollInterval = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
    const prevStatusPoll = process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = '10000';
    process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = '1';
    try {
      const client = createFakeClient();
      // OpenCode 1.2.17 omits idle sessions from /session/status (it only returns busy sessions),
      // so we need to treat "missing entry" as idle once turn activity has been observed.
      const baseStatusList = client.sessionStatusList;
      client.sessionStatusList = vi.fn(async () => {
        const statuses = await baseStatusList();
        const rec = statuses && typeof statuses === 'object' && !Array.isArray(statuses) ? (statuses as any).ses_1 : null;
        const statusType = rec && typeof rec === 'object' ? String((rec as any).type ?? '') : '';
        if (statusType === 'idle') return {};
        return statuses as any;
      });
      // Pre-prompt idle wait (if enabled) should not block the first prompt; we want to
      // simulate the session becoming busy only after prompt_async is accepted.
      client.sessionPromptAsync = vi.fn(async () => {
        client.__setStatusType('busy');
      });
      const session = createFakeSession();
      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });
      try {

        await runtime.startOrLoad({});
        runtime.beginTurn();

        const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-status-idle' });
        await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

        client.__emit({
          directory: '/tmp',
          payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
        });
        client.__emit({
          directory: '/tmp',
          payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
        });
        await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_1', finish: 'stop' });

        client.__setStatusType('idle');

        const outcome = await Promise.race([
          promptPromise.then(() => 'resolved' as const),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
        ]);
        expect(outcome).toBe('resolved');
        expect(client.sessionStatusList.mock.calls.length).toBeGreaterThan(0);
      } finally {
        await runtime.cancel().catch(() => {});
        await runtime.reset().catch(() => {});
      }
    } finally {
      if (prevPollInterval === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = prevPollInterval;
      }
      if (prevStatusPoll === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = prevStatusPoll;
      }
    }
  });

  it('resolves turns from control-plane idle when terminal assistant evidence arrived before idle polling', async () => {
    const prevPollInterval = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
    const prevStatusPoll = process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = '25';
    process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = '1';
    try {
      const client = createFakeClient();
      client.sessionPromptAsync = vi.fn(async () => {
        client.__setStatusType('busy');
      });
      const session = createFakeSession();
      const runtime = createOpenCodeServerRuntime(
        {
          directory: '/tmp',
          session,
          messageBuffer: new MessageBuffer(),
          mcpServers: {},
          permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
          onThinkingChange: vi.fn(),
        },
        {
          createClient: async () => client as any,
        },
      );
      try {
        await runtime.startOrLoad({});
        runtime.beginTurn();

        const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-status-idle-no-sse-activity' });
        await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
        await expect.poll(() => client.sessionStatusList.mock.calls.length).toBeGreaterThan(0);
        await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_status_poll_terminal', finish: 'stop' });

        client.__setStatusType('idle');

        await expect(promptPromise).resolves.toBeUndefined();
        const taskCompleteCalls = session.sendAgentMessage.mock.calls.filter(
          (call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'task_complete',
        );
        expect(taskCompleteCalls).toHaveLength(1);
      } finally {
        await runtime.cancel().catch(() => {});
        await runtime.reset().catch(() => {});
      }
    } finally {
      if (prevPollInterval === undefined) delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      else process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = prevPollInterval;
      if (prevStatusPoll === undefined) delete process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
      else process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = prevStatusPoll;
    }
  });

  it('does not backfill assistant text after the former backfill grace window when live terminal evidence resolves the turn', async () => {
    const prevPollInterval = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
    const prevStatusPoll = process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = '25';
    process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = '1';
    try {
      const client = createFakeClient() as any;
      const session = createFakeSession();

      let promptSent = false;
      let assistantReady = false;

      client.sessionPromptAsync = vi.fn(async () => {
        promptSent = true;
        client.__setStatusType('busy');
      });

      client.sessionMessagesList = vi.fn(async () => {
        if (!promptSent) return [];
        if (!assistantReady) return [];
        return [
          {
            info: { id: 'msg_asst_long_turn_1', role: 'assistant', time: { created: 2 } },
            parts: [{ type: 'text', text: 'LONG_TURN_ASSISTANT_OUTPUT_OK' }],
          },
        ];
      });

      const runtime = createOpenCodeServerRuntime(
        {
          directory: '/tmp',
          session,
          messageBuffer: new MessageBuffer(),
          mcpServers: {},
          permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
          onThinkingChange: vi.fn(),
        },
        {
          createClient: async () => client as any,
        },
      );
      try {

        await runtime.startOrLoad({});
        runtime.beginTurn();

        const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-backfill-after-grace' });
        await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

        // Ensure the turn has activity (so it can resolve on idle) even if assistant text deltas were missed.
        client.__emit({
          directory: '/tmp',
          payload: { type: 'message.part.updated', properties: { part: { id: 'part_reason_1', type: 'reasoning', sessionID: 'ses_1' } } },
        });
        client.__emit({
          directory: '/tmp',
          payload: {
            type: 'message.part.delta',
            properties: { sessionID: 'ses_1', messageID: 'msg_asst_long_turn_1', partID: 'part_reason_1', delta: 'thinking...' },
          },
        });

        // Wait beyond the former backfill window, then make history text available.
        // Live terminal evidence may complete the turn, but history text must not be injected.
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        assistantReady = true;
        await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_long_turn_1', finish: 'stop' });
        client.__setStatusType('idle');
        client.__emit({
          directory: '/tmp',
          payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
        });

        await expect(promptPromise).resolves.toBeUndefined();
        await flushTranscriptCommitMicrotasks();

        const committedCalls = getCommittedTranscriptRows(session, { type: 'message' }).filter(
          (row) => typeof row.meta.happierStreamKey === 'string' && row.meta.happierStreamKey.length > 0,
        );
        const matching = committedCalls.filter((row) => String(row.meta.happierStreamKey).includes('msg_asst_long_turn_1'));
        expect(matching).toHaveLength(0);
        expect(JSON.stringify(session.sendAgentMessageCommitted.mock.calls)).not.toContain('LONG_TURN_ASSISTANT_OUTPUT_OK');
      } finally {
        await runtime.cancel().catch(() => {});
        await runtime.reset().catch(() => {});
      }
    } finally {
      if (prevPollInterval === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = prevPollInterval;
      }
      if (prevStatusPoll === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = prevStatusPoll;
      }
    }
  });

  it('dispatches through prompt_async without using provider-wide session status as foreground admission authority', async () => {
    const prevPollInterval = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
    const prevStatusPoll = process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = '25';
    process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = '1';
    try {
      const client = createFakeClient() as any;
      const session = createFakeSession();

      let statusType: 'busy' | 'idle' = 'busy';
      let statusCalls = 0;
      const callSequence: string[] = [];
      client.sessionStatusList = vi.fn(async () => {
        statusCalls += 1;
        if (statusCalls >= 2) statusType = 'idle';
        callSequence.push(`status:${statusType}`);
        return { ses_1: { type: statusType } };
      });
      client.sessionPromptAsync = vi.fn(async () => {
        callSequence.push('prompt');
      });

      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-preprompt-idle' });
      await expect.poll(() => (client.sessionPromptAsync as any).mock.calls.length).toBe(1);
      expect(callSequence.at(0)).toBe('prompt');

      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
      });
      await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_1', finish: 'stop' });
      client.__emit({
        directory: '/tmp',
        payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
      });

      await expect(promptPromise).resolves.toBeUndefined();
      expect((client.sessionPromptAsync as any).mock.calls.length).toBe(1);
    } finally {
      if (prevPollInterval === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = prevPollInterval;
      }
      if (prevStatusPoll === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = prevStatusPoll;
      }
    }
  });

  it('does not backfill assistant text from control-plane history when live deltas were missed', async () => {
    const prevPollInterval = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
    const prevStatusPoll = process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = '25';
    process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = '1';
    try {
      const client = createFakeClient() as any;
      const session = createFakeSession();

      let promptSent = false;
      client.sessionPromptAsync = vi.fn(async () => {
        promptSent = true;
        client.__setStatusType('idle');
      });
      client.sessionMessagesList = vi.fn(async () => {
        if (!promptSent) return [];
        return [
          {
            info: { id: 'msg_asst_backfill_1', role: 'assistant', time: { created: 2 } },
            parts: [{ type: 'text', text: '| col_a | col_b |\\n| --- | --- |\\n| a | b |\\n\\nSTREAM_TABLE_E2E_OK' }],
          },
        ];
      });

      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'please stream a table', localId: 'local-backfill-1' });
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
      await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_backfill_1', finish: 'stop' });
      await expect(promptPromise).resolves.toBeUndefined();
      await flushTranscriptCommitMicrotasks();

      const committedCalls = getCommittedTranscriptRows(session, { type: 'message' }).filter(
        (row) => typeof row?.meta?.happierStreamKey === 'string' && row.meta.happierStreamKey.length > 0,
      );
      const matching = committedCalls.filter((row) => String(row.meta.happierStreamKey).includes('msg_asst_backfill_1'));
      expect(matching).toHaveLength(0);
      expect(JSON.stringify(session.sendAgentMessageCommitted.mock.calls)).not.toContain('STREAM_TABLE_E2E_OK');
    } finally {
      if (prevPollInterval === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = prevPollInterval;
      }
      if (prevStatusPoll === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = prevStatusPoll;
      }
    }
  });

  it('does not backfill assistant text from control-plane history when the turn only streamed thinking activity', async () => {
    const prevPollInterval = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
    const prevStatusPoll = process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = '25';
    process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = '1';
    try {
      const client = createFakeClient() as any;
      const session = createFakeSession();

      let promptSent = false;
      let releasePrompt!: () => void;
      const gate = new Promise<void>((resolve) => {
        releasePrompt = () => resolve();
      });

      client.sessionPromptAsync = vi.fn(async () => {
        await gate;
        promptSent = true;
        client.__setStatusType('idle');
      });

      client.sessionMessagesList = vi.fn(async () => {
        if (!promptSent) return [];
        return [
          {
            info: { id: 'msg_asst_backfill_2', role: 'assistant', time: { created: 2 } },
            parts: [{ type: 'text', text: '| col_a | col_b |\\n| --- | --- |\\n| a | b |\\n\\nSTREAM_TABLE_E2E_OK' }],
          },
        ];
      });

      const runtime = createOpenCodeServerRuntime(
        {
          directory: '/tmp',
          session,
          messageBuffer: new MessageBuffer(),
          mcpServers: {},
          permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
          onThinkingChange: vi.fn(),
        },
        {
          createClient: async () => client as any,
        },
      );

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'please stream a table', localId: 'local-backfill-2' });
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      // Simulate turn activity (reasoning deltas), but never stream assistant text deltas.
      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.updated', properties: { part: { id: 'part_reason_1', type: 'reasoning', sessionID: 'ses_1' } } },
      });
      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.delta',
          properties: { sessionID: 'ses_1', messageID: 'msg_asst_backfill_2', partID: 'part_reason_1', delta: 'thinking...' },
        },
      });

      releasePrompt();
      await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_backfill_2', finish: 'stop' });
      await expect(promptPromise).resolves.toBeUndefined();
      await flushTranscriptCommitMicrotasks();

      const committedCalls = getCommittedTranscriptRows(session, { type: 'message' }).filter(
        (row) => typeof row?.meta?.happierStreamKey === 'string' && row.meta.happierStreamKey.length > 0,
      );
      const matching = committedCalls.filter((row) => String(row.meta.happierStreamKey).includes('msg_asst_backfill_2'));
      expect(matching).toHaveLength(0);
      expect(JSON.stringify(session.sendAgentMessageCommitted.mock.calls)).not.toContain('STREAM_TABLE_E2E_OK');
    } finally {
      if (prevPollInterval === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = prevPollInterval;
      }
      if (prevStatusPoll === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = prevStatusPoll;
      }
    }
  });

  it('streams inline assistant text snapshots from message.part.updated when no assistant delta arrives', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'inline snapshot please', localId: 'local-inline-updated-1' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_inline_1',
            type: 'text',
            sessionID: 'ses_1',
            messageID: 'msg_asst_inline_1',
            text: 'INLINE_UPDATED_E2E_OK',
          },
        },
      },
    });
    await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_inline_1', finish: 'stop' });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

    const outcome = await Promise.race([
      promptPromise.then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 250);
        timer.unref?.();
      }),
    ]);

    expect(outcome).toBe('resolved');
    await flushTranscriptCommitMicrotasks();

    const matching = getCommittedTranscriptRows(session, { type: 'message' }).filter(
      (row) => String(row.meta?.happierStreamKey ?? '').includes('msg_asst_inline_1'),
    );
    expect(matching[matching.length - 1]?.body?.message).toContain('INLINE_UPDATED_E2E_OK');
  });

  it('does not stream vendor-assigned resumed user prompt snapshots as assistant output', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    session.__getMetadata().opencodeSessionId = 'ses_remote';

    let promptSent = false;
    client.sessionPromptAsync = vi.fn(async () => {
      promptSent = true;
    });
    client.sessionMessagesList = vi.fn(async () => {
      if (!promptSent) return [];
      return [
        {
          info: { id: 'msg_vendor_user_1', role: 'user', time: { created: 1 } },
          parts: [{ type: 'text', text: 'please continue' }],
        },
      ];
    });

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote' });
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'please continue', localId: 'resume-local-user-snapshot-1' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = (client.sessionPromptAsync as any).mock.calls[0]?.[0] as any;
    const effectivePrompt = firstCall.parts[0]?.text;
    expect(effectivePrompt).toBe('please continue');
    expect(firstCall.messageId).toBeUndefined();

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_vendor_user_1',
            role: 'user',
            sessionID: 'ses_remote',
          },
        },
      },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_user_prompt_1',
            type: 'text',
            sessionID: 'ses_remote',
            messageID: 'msg_vendor_user_1',
            text: effectivePrompt,
          },
        },
      },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_asst_resume_1',
            role: 'assistant',
            sessionID: 'ses_remote',
          },
        },
      },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_asst_resume_1',
            type: 'text',
            sessionID: 'ses_remote',
            messageID: 'msg_asst_resume_1',
            text: 'assistant resumed OK',
          },
        },
      },
    });
    await emitTerminalAssistantAndIdle(client, { sessionId: 'ses_remote', messageId: 'msg_asst_resume_1' });

    await expect(promptPromise).resolves.toBeUndefined();
    await flushTranscriptCommitMicrotasks();

    const committedMessages = getCommittedTranscriptRows(session, { type: 'message' });
    expect(committedMessages).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({
            message: expect.stringContaining(OPENCODE_CHANGE_TITLE_INSTRUCTION),
          }),
        }),
      ]),
    );
    expect(committedMessages).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          meta: expect.objectContaining({
            happierStreamKey: expect.stringContaining('msg_vendor_user_1'),
          }),
        }),
      ]),
    );
    expect(committedMessages[committedMessages.length - 1]?.body?.message).toContain('assistant resumed OK');
  });

  it('streams inline reasoning snapshots from message.part.updated when no reasoning delta arrives', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'inline reasoning please', localId: 'local-inline-reasoning-1' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_inline_reasoning_1',
            type: 'reasoning',
            sessionID: 'ses_1',
            messageID: 'msg_asst_inline_reasoning_1',
            text: 'INLINE_REASONING_UPDATED_OK',
          },
        },
      },
    });
    await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_inline_reasoning_1', finish: 'stop' });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

    await expect(promptPromise).resolves.toBeUndefined();
    await flushTranscriptCommitMicrotasks();

    const matching = getCommittedTranscriptRows(session, { type: 'thinking' }).filter(
      (row) => String(row.meta?.happierStreamKey ?? '').includes('msg_asst_inline_reasoning_1'),
    );
    expect(matching[matching.length - 1]?.body?.text).toContain('INLINE_REASONING_UPDATED_OK');
  });

  it.each([
    {
      name: 'after the assistant role update',
      expectedOutcome: 'resolved' as const,
      expectedMessage: 'INLINE_REUSED_ID_E2E_OK',
      emitSequence: async (client: ReturnType<typeof createFakeClient>, messageId: string) => {
        client.__emit({
          directory: '/tmp',
          payload: {
            type: 'message.updated',
            properties: {
              info: {
                id: messageId,
                role: 'assistant',
                sessionID: 'ses_1',
                finish: 'stop',
                time: { completed: 1 },
              },
            },
          },
        });
        client.__emit({
          directory: '/tmp',
          payload: {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'part_inline_reused_1',
                type: 'text',
                sessionID: 'ses_1',
                messageID: messageId,
                text: 'INLINE_REUSED_ID_E2E_OK',
              },
            },
          },
        });
      },
    },
    {
      name: 'before the assistant role update',
      expectedOutcome: 'resolved' as const,
      expectedMessage: 'INLINE_REUSED_ID_E2E_OK',
      emitSequence: async (client: ReturnType<typeof createFakeClient>, messageId: string) => {
        client.__emit({
          directory: '/tmp',
          payload: {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'part_inline_reused_1',
                type: 'text',
                sessionID: 'ses_1',
                messageID: messageId,
                text: 'INLINE_REUSED_ID_E2E_OK',
              },
            },
          },
        });
        client.__emit({
          directory: '/tmp',
          payload: {
            type: 'message.updated',
            properties: {
              info: {
                id: messageId,
                role: 'assistant',
                sessionID: 'ses_1',
                finish: 'stop',
                time: { completed: 1 },
              },
            },
          },
        });
      },
    },
    {
      name: 'without any assistant role update',
      expectedOutcome: 'timeout' as const,
      expectedMessage: null,
      emitSequence: async (client: ReturnType<typeof createFakeClient>, messageId: string) => {
        client.__emit({
          directory: '/tmp',
          payload: {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'part_inline_reused_1',
                type: 'text',
                sessionID: 'ses_1',
                messageID: messageId,
                text: 'INLINE_REUSED_ID_E2E_OK',
              },
            },
          },
        });
      },
    },
  ])('handles inline assistant text snapshots when OpenCode reuses the prompt message id $name', async ({ emitSequence, expectedOutcome, expectedMessage }) => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'inline reused id please', localId: 'local-inline-updated-reused-1' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = client.sessionPromptAsync.mock.calls.at(0)?.at(0) as any;

    await emitSequence(client, firstCall.messageId);
    if (expectedOutcome === 'resolved') {
      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });
    } else {
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });
      await flushTranscriptCommitMicrotasks();
    }

    const outcome = await Promise.race([
      promptPromise.then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 250);
        timer.unref?.();
      }),
    ]);

    expect(outcome).toBe(expectedOutcome);
    await flushTranscriptCommitMicrotasks();

    const matching = getCommittedTranscriptRows(session, { type: 'message' }).filter(
      (row) => String(row.meta?.happierStreamKey ?? '').includes(firstCall.messageId),
    );
    if (expectedMessage === null) {
      expect(matching).toHaveLength(0);
      return;
    }
    expect(matching[matching.length - 1]?.body?.message).toContain(expectedMessage);
  });

  it('marks turns failed when control-plane status polling repeatedly fails (prevents wedged thinking)', async () => {
    const prevPollInterval = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
    const prevStatusPoll = process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
    const prevMaxFailures = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_MAX_CONSECUTIVE_FAILURES;
    const prevGraceMs = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_FAILURE_GRACE_MS;

    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = '25';
    process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = '1';
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_MAX_CONSECUTIVE_FAILURES = '2';
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_FAILURE_GRACE_MS = '1000';
    try {
      const client = createFakeClient() as any;
      client.sessionStatusList = vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1234');
      });

      const session = createFakeSession();
      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-control-plane-fail' });
      // Avoid unhandled rejections in the RED phase (turn may be canceled in finally).
      void promptPromise.catch(() => {});
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      try {
        await expect.poll(() => session.sessionTurnLifecycle.failTurn.mock.calls.length).toBeGreaterThan(0);
        expect(session.sendAgentMessage.mock.calls.some(
          (call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'turn_aborted',
        )).toBe(false);
        expect(JSON.stringify(session.sessionTurnLifecycle.failTurn.mock.calls)).not.toContain('ECONNREFUSED');
      } finally {
        await runtime.cancel().catch(() => {});
        await runtime.reset().catch(() => {});
      }

      await expect(promptPromise).rejects.toBeTruthy();
    } finally {
      if (prevPollInterval === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = prevPollInterval;
      }
      if (prevStatusPoll === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = prevStatusPoll;
      }
      if (prevMaxFailures === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_MAX_CONSECUTIVE_FAILURES;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_MAX_CONSECUTIVE_FAILURES = prevMaxFailures;
      }
      if (prevGraceMs === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_FAILURE_GRACE_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_FAILURE_GRACE_MS = prevGraceMs;
      }
    }
  });

  it('surfaces session.error as sanitized primary-session failure', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-error' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    const providerError = {
      name: 'UnknownError',
      data: { message: 'Model not found: openai/does_not_exist.' },
    };
    useCompletedProviderErrorInventory(client, providerError);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: providerError,
        },
      },
    });
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
    });

    await expect(promptPromise).rejects.toThrow('Model not found');

    const errorMessages = session.sendAgentMessage.mock.calls.filter(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'message',
    );
    expect(errorMessages).toHaveLength(0);
    expect(session.sendAgentMessage.mock.calls.some(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'turn_failed',
    )).toBe(false);
    expect(session.sendAgentMessage.mock.calls.some(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'turn_aborted',
    )).toBe(false);
    expect(session.sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode',
      issue: expect.objectContaining({
        source: 'provider_session_error',
        sanitizedPreview: 'Model not found: openai/does_not_exist',
        providerTurnId: expect.any(String),
      }),
      providerTurnId: expect.any(String),
    }));
    expect(JSON.stringify(session.sessionTurnLifecycle.failTurn.mock.calls)).toContain('Model not found: openai/does_not_exist');
  });

  it('maps structured OpenCode usage-limit session errors into runtime issue details', async () => {
    const client = createFakeClient();
    const session = createFakeSession('happy_sess_opencode_usage_error');
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      env: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai',
          groupId: 'team-pool',
          activeProfileId: 'primary',
          fallbackProfileId: 'backup',
          generation: 3,
        }]),
      },
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-limit' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    const providerError = {
      name: 'GoUsageLimitError',
      message: 'OpenCode account rate limit',
      headers: { 'retry-after': '5' },
      metadata: { workspace: 'team-a', limitName: 'daily_tokens' },
      action: { url: 'https://opencode.ai/billing' },
    };
    useCompletedProviderErrorInventory(client, providerError);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: providerError,
        },
      },
    });
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
    });

    await expect(promptPromise).rejects.toThrow('OpenCode account rate limit');
    await expect.poll(
      () => mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mock.calls.length,
      { timeout: 5_000 },
    ).toBe(1);

    expect(session.sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode',
      issue: expect.objectContaining({
        source: 'usage_limit',
        providerTurnId: expect.any(String),
        usageLimit: expect.objectContaining({
          retryAfterMs: 5_000,
          resetAtMs: null,
          providerLimitId: 'daily_tokens',
          action: {
            kind: 'open_url',
            url: 'https://opencode.ai/billing',
          },
          connectedService: expect.objectContaining({
            serviceId: 'openai',
            profileId: 'primary',
            groupId: 'team-pool',
          }),
        }),
      }),
      providerTurnId: expect.any(String),
    }));
    expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
      reportId: expect.stringMatching(/^runtime-auth-report:/),
      sessionId: 'happy_sess_opencode_usage_error',
      switchesThisTurn: 0,
      classification: expect.objectContaining({
        kind: 'rate_limit',
        serviceId: 'openai',
        profileId: 'primary',
        groupId: 'team-pool',
        resetsAtMs: null,
        retryAfterMs: 5_000,
        providerLimitId: 'daily_tokens',
        quotaScope: 'workspace',
        action: {
          kind: 'open_url',
          url: 'https://opencode.ai/billing',
        },
        rateLimits: expect.objectContaining({
          providerLimitId: 'daily_tokens',
          retryAfterMs: 5_000,
        }),
      }),
    }, {
      timeoutMs: 120_000,
    });
  });

  it('fails active turns when OpenCode reports a usage-limit retry over session.status SSE', async () => {
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockClear();
    const client = createFakeClient();
    const session = createFakeSession('happy_sess_opencode_status_retry');
    const retryNextAtMs = Date.now() + 60_000;
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      env: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai',
          groupId: 'team-pool',
          activeProfileId: 'primary',
          fallbackProfileId: 'backup',
          generation: 3,
        }]),
      },
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-status-retry-sse' });
    const outcomePromise = Promise.race([
      promptPromise.then(
        () => ({ type: 'resolved' as const }),
        (error: unknown) => ({ type: 'rejected' as const, message: error instanceof Error ? error.message : String(error) }),
      ),
      new Promise<{ type: 'timeout' }>((resolve) => setTimeout(() => resolve({ type: 'timeout' }), 250)),
    ]);
    try {
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.status',
          properties: {
            sessionID: 'ses_1',
            status: {
              type: 'retry',
              attempt: 10,
              message: 'The usage limit has been reached',
              next: retryNextAtMs,
            },
          },
        },
      });

      const outcome = await outcomePromise;
      expect(outcome).toEqual({ type: 'rejected', message: 'The usage limit has been reached' });
      await expect.poll(
        () => mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mock.calls.length,
        { timeout: 5_000 },
      ).toBe(1);

      expect(session.sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'opencode',
        issue: expect.objectContaining({
          source: 'usage_limit',
          providerTurnId: expect.any(String),
          usageLimit: expect.objectContaining({
            resetAtMs: null,
            retryAfterMs: expect.any(Number),
            providerLimitId: 'free_tier_limit',
            connectedService: expect.objectContaining({
              serviceId: 'openai',
              profileId: 'primary',
              groupId: 'team-pool',
            }),
          }),
        }),
        providerTurnId: expect.any(String),
      }));
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
        reportId: expect.stringMatching(/^runtime-auth-report:/),
        sessionId: 'happy_sess_opencode_status_retry',
        switchesThisTurn: 0,
        classification: expect.objectContaining({
          kind: 'usage_limit',
          serviceId: 'openai',
          profileId: 'primary',
          groupId: 'team-pool',
          resetsAtMs: null,
          retryAfterMs: expect.any(Number),
          providerLimitId: 'free_tier_limit',
        }),
      }, {
        timeoutMs: 120_000,
      });
      expect(client.sessionAbort).toHaveBeenCalledWith({ sessionId: 'ses_1' });
    } finally {
      await runtime.cancel().catch(() => {});
      await runtime.reset().catch(() => {});
      await promptPromise.catch(() => undefined);
    }
  });

  it('does not re-emit daemon typed runtime-auth recovery projection for OpenCode session.status usage-limit reports', async () => {
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockReset();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      env: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai',
          groupId: 'team-pool',
          activeProfileId: 'primary',
          fallbackProfileId: 'backup',
          generation: 3,
        }]),
      },
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-status-projection-sse' });
    const promptOutcomePromise = promptPromise.catch(() => undefined);
    try {
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.status',
          properties: {
            sessionID: 'ses_1',
            status: {
              type: 'retry',
              attempt: 10,
              message: 'The usage limit has been reached',
              next: Date.now() + 60_000,
            },
          },
        },
      });

      await expect.poll(() => mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mock.calls.length).toBe(1);
      expect(session.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
        type: 'connected-service-runtime-auth-recovery',
      }));
    } finally {
      await runtime.cancel().catch(() => {});
      await runtime.reset().catch(() => {});
      await promptOutcomePromise;
    }
  });

  it('emits a generic recovery message when OpenCode receives a typed diagnostic without a transcript event', async () => {
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockReset();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(
      createScheduledRuntimeAuthRecoveryReport({ includeTranscriptEvent: false }),
    );
    const client = createFakeClient();
    const session = createFakeSession('happy_sess_opencode_projection_fallback');
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      env: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai',
          groupId: 'team-pool',
          activeProfileId: 'primary',
          fallbackProfileId: 'backup',
          generation: 3,
        }]),
      },
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-status-projection-fallback' });
    const promptOutcomePromise = promptPromise.catch(() => undefined);
    try {
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.status',
          properties: {
            sessionID: 'ses_1',
            status: {
              type: 'retry',
              attempt: 10,
              message: 'The usage limit has been reached',
              next: Date.now() + 60_000,
            },
          },
        },
      });

      await expect.poll(
        () => mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mock.calls.length,
        { timeout: 5_000 },
      ).toBe(1);
      await expect.poll(() => session.sendSessionEvent.mock.calls.length).toBe(1);
      expect(session.sendSessionEvent).toHaveBeenCalledWith({
        type: 'message',
        message: expect.stringContaining('retry scheduled'),
      });
    } finally {
      await runtime.cancel().catch(() => {});
      await runtime.reset().catch(() => {});
      await promptOutcomePromise;
    }
  });

  it('fails active turns when OpenCode control-plane status polling reports a usage-limit retry', async () => {
    const prevPollInterval = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
    const prevStatusPoll = process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = '25';
    process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = '1';
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockClear();
    try {
      const client = createFakeClient();
      const session = createFakeSession();
      const retryNextAtMs = Date.now() + 60_000;
      client.sessionStatusList = vi.fn(async () => ({
        ses_1: {
          type: 'retry',
          attempt: 10,
          message: 'The usage limit has been reached',
          next: retryNextAtMs,
        },
      }));
      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        env: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'profile',
            serviceId: 'openai',
            profileId: 'primary',
          }]),
        },
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-status-retry-poll' });
      const outcomePromise = Promise.race([
        promptPromise.then(
          () => ({ type: 'resolved' as const }),
          (error: unknown) => ({ type: 'rejected' as const, message: error instanceof Error ? error.message : String(error) }),
        ),
        new Promise<{ type: 'timeout' }>((resolve) => setTimeout(() => resolve({ type: 'timeout' }), 500)),
      ]);
      try {
        await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

        const outcome = await outcomePromise;
        expect(outcome).toEqual({ type: 'rejected', message: 'The usage limit has been reached' });

        expect(session.sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
          provider: 'opencode',
          issue: expect.objectContaining({
            source: 'usage_limit',
            providerTurnId: expect.any(String),
            usageLimit: expect.objectContaining({
              resetAtMs: null,
              retryAfterMs: expect.any(Number),
              providerLimitId: 'free_tier_limit',
              connectedService: expect.objectContaining({
                serviceId: 'openai',
                profileId: 'primary',
              }),
            }),
          }),
          providerTurnId: expect.any(String),
        }));
        expect(client.sessionAbort).toHaveBeenCalledWith({ sessionId: 'ses_1' });
      } finally {
        await runtime.cancel().catch(() => {});
        await runtime.reset().catch(() => {});
        await promptPromise.catch(() => undefined);
      }
    } finally {
      if (prevPollInterval === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = prevPollInterval;
      }
      if (prevStatusPoll === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = prevStatusPoll;
      }
    }
  });

  it('keeps generic OpenCode retry statuses pending without failing the turn immediately', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-generic-retry' });
    const settlement = observePromiseSettlement(promptPromise);
    try {
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.status',
          properties: {
            sessionID: 'ses_1',
            status: {
              type: 'retry',
              attempt: 1,
              message: 'Temporary provider transport failure',
              next: Date.now() + 60_000,
            },
          },
        },
      });
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.status',
          properties: {
            sessionID: 'ses_1',
            status: {
              type: 'retry',
              attempt: 2,
              message: 'Temporary provider transport failure',
              next: Date.now() + 120_000,
            },
          },
        },
      });

      await flushTranscriptCommitMicrotasks();

      expect(settlement.status).toBe('pending');
      expect(client.sessionAbort).not.toHaveBeenCalled();
      expect(session.sendAgentMessage.mock.calls.filter(
        (call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'message',
      )).toHaveLength(1);
    } finally {
      await runtime.cancel().catch(() => {});
      await runtime.reset().catch(() => {});
      await promptPromise.catch(() => undefined);
    }
  });

  it('fails a silent active OpenCode turn through the deadlock guard', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    try {
      const client = createFakeClient();
      const session = createFakeSession();
      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-deadlock-guard' });
      const settlement = observePromiseSettlement(promptPromise);
      await flushTranscriptCommitMicrotasks();
      expect(client.sessionPromptAsync).toHaveBeenCalledTimes(1);

      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
      });
      await advanceTimersAndFlush(10_500);

      expect(settlement.status).toBe('rejected');
      expect(client.sessionAbort).toHaveBeenCalledWith({ sessionId: 'ses_1' });
      expect(session.sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'opencode',
        issue: expect.objectContaining({
          source: 'stream_error',
          providerTurnId: expect.any(String),
        }),
        providerTurnId: expect.any(String),
      }));

      await promptPromise.catch(() => undefined);
      await runtime.reset().catch(() => {});
    } finally {
      restoreEnv();
      vi.useRealTimers();
    }
  });

  it('fails the caller promise when prompt_async hangs before OpenCode emits events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    try {
      const client = createFakeClient();
      client.sessionPromptAsync = vi.fn(() => new Promise<void>(() => {}));
      const session = createFakeSession();
      runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-hung-prompt-async' });
      const settlement = observePromiseSettlement(promptPromise);
      void promptPromise.catch(() => undefined);
      await flushTranscriptCommitMicrotasks();
      expect(client.sessionPromptAsync).toHaveBeenCalledTimes(1);

      await advanceTimersAndFlush(10_500);

      expect(settlement.status).toBe('rejected');
      expect(client.sessionAbort).toHaveBeenCalledWith({ sessionId: 'ses_1' });
      expect(session.sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'opencode',
        issue: expect.objectContaining({
          source: 'stream_error',
          providerTurnId: expect.any(String),
        }),
        providerTurnId: expect.any(String),
      }));
    } finally {
      restoreEnv();
      await runtime?.reset().catch(() => {});
      vi.useRealTimers();
    }
  });

  it('surfaces prompt_async failures as sanitized primary-session failure', async () => {
    const client = createFakeClient() as any;
    client.sessionPromptAsync = vi.fn(async () => {
      throw new Error('Model not found: openai/does_not_exist.');
    });

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    await expect((runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-prompt-error' })).rejects.toThrow('Model not found');

    const errorMessages = session.sendAgentMessage.mock.calls.filter(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'message',
    );
    expect(errorMessages).toHaveLength(0);
    expect(session.sendAgentMessage.mock.calls.some(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'turn_failed',
    )).toBe(false);
    expect(session.sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode',
      issue: expect.objectContaining({
        source: 'stream_error',
        sanitizedPreview: 'Model not found: openai/does_not_exist',
        providerTurnId: expect.any(String),
      }),
      providerTurnId: expect.any(String),
    }));
    expect(JSON.stringify(session.sessionTurnLifecycle.failTurn.mock.calls)).not.toContain('Model not found: openai/does_not_exist.');
  });

  it('does not surface abort-like prompt_async errors as agent messages', async () => {
    const client = createFakeClient() as any;
    client.sessionPromptAsync = vi.fn(async () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    });

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    await expect((runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-abort-prompt-async' })).rejects.toBeTruthy();

    const errorMessages = session.sendAgentMessage.mock.calls.filter(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'message',
    );
    expect(errorMessages).toHaveLength(0);
    expect(session.sendAgentMessage.mock.calls.some(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'turn_aborted',
    )).toBe(true);
  });

  it('does not surface abort-like session.error details as agent messages', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-session-abort' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    const providerError = {
      name: 'AbortError',
      message: 'The operation was aborted.',
    };
    useCompletedProviderErrorInventory(client, providerError);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: providerError,
        },
      },
    });
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
    });

    await expect(promptPromise).rejects.toBeTruthy();

    const errorMessages = session.sendAgentMessage.mock.calls.filter(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'message',
    );
    expect(errorMessages).toHaveLength(0);
    expect(session.sendAgentMessage.mock.calls.some(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'turn_aborted',
    )).toBe(true);
  });

  it('emits tool-result errors with { status: \"failed\" } and omits empty metadata (matches ACP dialect baselines)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-tool-error' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool_part_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_asst_1',
            callID: 'call_1',
            tool: 'Read',
            state: {
              status: 'error',
              error: 'Error: File not found: /tmp/missing.txt',
              metadata: {},
            },
          },
        },
      },
    });

    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

    await expect(promptPromise).resolves.toBeUndefined();

    const toolResultCalls = session.sendAgentMessage.mock.calls.filter(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'tool-result',
    );

    expect(toolResultCalls).toHaveLength(1);
    expect(toolResultCalls[0]?.[1]).toMatchObject({
      callId: 'call_1',
      isError: true,
      output: {
        status: 'failed',
        error: 'Error: File not found: /tmp/missing.txt',
      },
    });
    expect(toolResultCalls[0]?.[1]?.output?.metadata).toBeUndefined();
  });

  it.each(['failed', 'cancelled', 'aborted'] as const)(
    'emits tool-result errors for terminal %s tool parts',
    async (status) => {
      const client = createFakeClient();
      const session = createFakeSession();
      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: `local-tool-${status}` });
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: `tool_part_${status}`,
              type: 'tool',
              sessionID: 'ses_1',
              messageID: `msg_asst_${status}`,
              callID: `call_${status}`,
              tool: 'bash',
              state: {
                status,
                input: { command: 'echo terminal' },
                error: `${status} by provider`,
                metadata: {},
              },
            },
          },
        },
      });

      await emitTerminalAssistantAndIdle(client, { messageId: `msg_asst_${status}` });

      await expect(promptPromise).resolves.toBeUndefined();
      expect(sentAgentMessagesOfType(session, 'tool-result')).toEqual([
        expect.objectContaining({
          callId: `call_${status}`,
          isError: true,
          output: expect.objectContaining({
            status: 'failed',
            error: `${status} by provider`,
          }),
        }),
      ]);

      await runtime.reset().catch(() => {});
    },
  );

  it('does not emit duplicate task_complete when both session.status idle and session.idle arrive for a turn', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-3' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
    });
    await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_1', finish: 'stop' });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

    await expect(promptPromise).resolves.toBeUndefined();

    const taskCompleteCalls = session.sendAgentMessage.mock.calls.filter(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'task_complete',
    );
    expect(taskCompleteCalls.length).toBe(1);
  });

  it('emits a canonical Diff tool from native session diff data when a turn completes', async () => {
    const client = createFakeClient();
    client.sessionDiff.mockResolvedValue([
      {
        path: 'src/native.ts',
        diff: 'diff --git a/src/native.ts b/src/native.ts\n--- a/src/native.ts\n+++ b/src/native.ts\n@@ -1 +1 @@\n-old\n+new\n',
      },
    ]);
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-diff-1' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

    await expect(promptPromise).resolves.toBeUndefined();

    expect(client.sessionDiff).toHaveBeenCalledTimes(1);
    expect(client.sessionDiff).toHaveBeenCalledWith({
      sessionId: 'ses_1',
      messageId: expect.any(String),
    });

    expect(session.sendAgentMessage.mock.calls).toEqual(
      expect.arrayContaining([
        [
          'opencode',
          expect.objectContaining({
            type: 'tool-call',
            name: 'Diff',
            input: expect.objectContaining({
              files: [
                expect.objectContaining({
                  file_path: 'src/native.ts',
                  unified_diff: expect.stringContaining('src/native.ts'),
                }),
              ],
              _happier: expect.objectContaining({
                provider: 'opencode',
                rawToolName: 'OpenCodeDiff',
                workspaceMutationSignal: 'turn-change-set',
                sessionChangeScope: 'turn',
              }),
            }),
          }),
        ],
      ]),
    );
  });

  it('does not hang turn completion when native session diff never resolves', async () => {
    const prior = process.env.HAPPIER_OPENCODE_SERVER_SESSION_DIFF_TIMEOUT_MS;
    process.env.HAPPIER_OPENCODE_SERVER_SESSION_DIFF_TIMEOUT_MS = '25';
    try {
      const client = createFakeClient() as any;
      client.sessionDiff = vi.fn(async () => await new Promise<unknown[]>(() => {}));

      const session = createFakeSession();
      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-diff-timeout-1' });
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.updated', properties: { part: { id: 'part_timeout_1', type: 'text', sessionID: 'ses_1' } } },
      });
      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_timeout_1', partID: 'part_timeout_1', delta: 'hi' } },
      });
      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_timeout_1' });

      const outcome = await Promise.race([
        promptPromise.then(() => 'resolved' as const),
        new Promise<'timeout'>((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), 250);
          timer.unref?.();
        }),
      ]);

      expect(outcome).toBe('resolved');
      expect(client.sessionDiff).toHaveBeenCalledTimes(1);
      expect(session.sendAgentMessage.mock.calls.some(
        (call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'task_complete',
      )).toBe(true);
      expect(session.sendAgentMessage.mock.calls.some(
        (call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'tool-call' && call?.[1]?.name === 'Diff',
      )).toBe(false);
    } finally {
      if (typeof prior === 'string') {
        process.env.HAPPIER_OPENCODE_SERVER_SESSION_DIFF_TIMEOUT_MS = prior;
      } else {
        delete process.env.HAPPIER_OPENCODE_SERVER_SESSION_DIFF_TIMEOUT_MS;
      }
    }
  });

  it('emits a canonical Diff tool for the first prompt after resume using the vendor-assigned user message id', async () => {
    const client = createFakeClient() as any;
    const session = createFakeSession();
    session.__getMetadata().opencodeSessionId = 'ses_remote';

    let promptSent = false;
    client.sessionPromptAsync = vi.fn(async () => {
      promptSent = true;
    });
    client.sessionMessagesList = vi.fn(async () => {
      if (!promptSent) {
        return [
          {
            info: { id: 'msg_existing_1', role: 'assistant', time: { created: 1 } },
            parts: [{ type: 'text', text: 'existing' }],
          },
        ];
      }
      return [
        {
          info: { id: 'msg_existing_1', role: 'assistant', time: { created: 1 } },
          parts: [{ type: 'text', text: 'existing' }],
        },
        {
          info: { id: 'msg_vendor_user_1', role: 'user', time: { created: 2 } },
          parts: [{ type: 'text', text: 'first after resume' }],
        },
      ];
    });
    client.sessionDiff.mockResolvedValue([
      {
        path: 'src/resumed.ts',
        diff: 'diff --git a/src/resumed.ts b/src/resumed.ts\n--- a/src/resumed.ts\n+++ b/src/resumed.ts\n@@ -1 +1 @@\n-old\n+new\n',
      },
    ]);

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote' });
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'first after resume', localId: 'resume-local-diff-1' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = client.sessionPromptAsync.mock.calls[0]?.[0] as any;
    expect(firstCall.messageId).toBeUndefined();

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_resume_1', type: 'text', sessionID: 'ses_remote' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_remote', messageID: 'msg_asst_resume_1', partID: 'part_resume_1', delta: 'hi' } },
    });
    await emitTerminalAssistantAndIdle(client, { sessionId: 'ses_remote', messageId: 'msg_asst_resume_1' });

    await expect(promptPromise).resolves.toBeUndefined();

    expect(client.sessionDiff).toHaveBeenCalledTimes(1);
    expect(client.sessionDiff).toHaveBeenCalledWith({
      sessionId: 'ses_remote',
      messageId: 'msg_vendor_user_1',
    });

    expect(session.sendAgentMessage.mock.calls).toEqual(
      expect.arrayContaining([
        [
          'opencode',
          expect.objectContaining({
            type: 'tool-call',
            name: 'Diff',
            input: expect.objectContaining({
              files: [
                expect.objectContaining({
                  file_path: 'src/resumed.ts',
                  unified_diff: expect.stringContaining('src/resumed.ts'),
                }),
              ],
            }),
          }),
        ],
      ]),
    );
  });

	  it('emits a single tool-call when tool updates gain additional input fields (e.g. command)', async () => {
	    const client = createFakeClient();
	    const session = createFakeSession();
	    const runtime = createOpenCodeServerRuntime({
	      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-tool-update' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    const emitToolUpdate = (input: unknown, status = 'running') => {
      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_tool_1',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_tool_1',
              callID: 'call_1',
              tool: 'bash',
              state: { status, input, ...(status === 'completed' ? { output: 'ok', metadata: {} } : {}) },
            },
          },
        },
      });
    };

	    emitToolUpdate({});
	    emitToolUpdate({ command: 'echo hi' });
	    emitToolUpdate({ command: 'echo hi' }, 'completed');

	    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_final_tool_update' });
	    await expect(promptPromise).resolves.toBeUndefined();

	    const calls = session.sendAgentMessage.mock.calls
	      .filter((c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'tool-call' && c?.[1]?.callId === 'call_1');
	    expect(calls.length).toBe(1);
	    expect((calls[0]?.[1] as any)?.input?.command).toBe('echo hi');
	  });

  it('emits tool-call for tool parts on message.part.created (reduces perceived batching)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-tool-created' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.created',
        properties: {
          part: {
            id: 'part_tool_created_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_1',
            callID: 'call_created_1',
            tool: 'bash',
            state: { status: 'running', input: { command: 'echo hi' } },
          },
        },
      },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_child_tool_1',
            type: 'tool',
            sessionID: 'ses_child_1',
            messageID: 'msg_child_tool_1',
            callID: 'call_child_tool_1',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'echo child' }, output: 'child', metadata: {} },
          },
        },
      },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_task_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_task_1',
            callID: 'call_task_1',
            tool: 'task',
            state: {
              status: 'completed',
              input: { description: 'Run child' },
              output: '<task_metadata>\nsession_id: ses_child_1\n</task_metadata>\n\n<task_result>\nCHILD_OK\n</task_result>',
              metadata: { sessionId: 'ses_child_1' },
            },
          },
        },
      },
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_created_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_1',
            callID: 'call_created_1',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'echo hi' }, output: 'ok', metadata: {} },
          },
        },
      },
    });
    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

    await expect(promptPromise).resolves.toBeUndefined();

    const toolCalls = session.sendAgentMessage.mock.calls.filter(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'tool-call' && c?.[1]?.callId === 'call_created_1',
    );
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]?.[1]?.name).toBe('bash');
  });

  it('aliases OpenCode grep tool to search (normalizes downstream to CodeSearch)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-grep-alias' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_grep_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_grep_1',
            callID: 'call_grep_1',
            tool: 'grep',
            state: { status: 'completed', input: { pattern: 'TOKEN', path: '/tmp' }, output: 'TOKEN', metadata: {} },
          },
        },
      },
    });

    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_final_grep_alias' });
    await expect(promptPromise).resolves.toBeUndefined();

    const toolCalls = session.sendAgentMessage.mock.calls.filter(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'tool-call' && c?.[1]?.callId === 'call_grep_1',
    );
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]?.[1]?.name).toBe('search');
  });

  it('imports remote transcript history into a fresh session on resume (meta.importedFrom="acp-history")', async () => {
    const client = createFakeClient() as any;
    client.sessionMessagesList = vi.fn(async () => ([
      {
        info: { role: 'user', id: 'msg_u1', time: { created: 1 }, sessionID: 'ses_remote' },
        parts: [{ type: 'text', text: 'phase1 user' }],
      },
      {
        info: { role: 'assistant', id: 'msg_a1', time: { created: 2 }, sessionID: 'ses_remote' },
        parts: [{ type: 'text', text: 'IMPORT_PHASE1_TEXT_OK' }],
      },
    ]));

    const session = createFakeSession();
    session.__setLastObservedMessageSeq(0);

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote' });

    await expect.poll(() => session.sendAgentMessageCommitted.mock.calls.length).toBeGreaterThan(0);
    const importedAssistant = session.sendAgentMessageCommitted.mock.calls.find(
      (c: any[]) =>
        c?.[0] === 'opencode' &&
        c?.[1]?.type === 'message' &&
        typeof c?.[1]?.message === 'string' &&
        c[1].message.includes('IMPORT_PHASE1_TEXT_OK') &&
        c?.[2]?.meta?.importedFrom === 'acp-history',
    );
    expect(importedAssistant).toBeTruthy();
  });

  it('does not import remote history when resuming into an existing Happier session', async () => {
    const client = createFakeClient() as any;
    client.sessionMessagesList = vi.fn(async () => ([
      {
        info: { role: 'assistant', id: 'msg_a1', time: { created: 2 }, sessionID: 'ses_remote' },
        parts: [{ type: 'text', text: 'SHOULD_NOT_IMPORT' }],
      },
    ]));

    const session = createFakeSession();
    session.__getMetadata().opencodeSessionId = 'ses_remote';

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote' });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(client.sessionMessagesList).toHaveBeenCalledTimes(1);
    expect(client.sessionMessagesList).toHaveBeenCalledWith({ sessionId: 'ses_remote' });
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(session.sendUserTextMessageCommitted).not.toHaveBeenCalled();
  });

  it('drains accepted pending queue rows through the input consumer after resuming a server session', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const drainPending = vi.fn(async () => ({ materialized: 2, stoppedReason: 'no_pending' as const }));
    const popPendingMessage = vi.fn(async () => false);
    const pendingQueue = {
      drainAfterStartOrLoad: true,
      drainPending,
      popPendingMessage,
    };

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as any,
      onThinkingChange: vi.fn(),
      pendingQueue,
    }, {
      createClient: async () => client,
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote' });

    expect(runtime.getSessionId()).toBe('ses_remote');
    expect(drainPending).toHaveBeenCalledWith({
      logPrefix: '[OpenCodeServer]',
      reason: 'opencode_server_start_or_load',
    });
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('treats the canonical OpenCode runtime descriptor as the existing session identity during resume', async () => {
    const client = createFakeClient() as any;
    client.sessionMessagesList = vi.fn(async () => ([
      {
        info: { role: 'assistant', id: 'msg_a1', time: { created: 2 }, sessionID: 'ses_remote' },
        parts: [{ type: 'text', text: 'SHOULD_NOT_IMPORT' }],
      },
    ]));

    const session = createFakeSession();
    session.__getMetadata().opencodeSessionId = 'legacy_remote';
    session.__getMetadata().agentRuntimeDescriptorV1 = {
      v: 1,
      providerId: 'opencode',
      provider: {
        backendMode: 'server',
        vendorSessionId: 'ses_remote',
      },
    };

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote' });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(client.sessionMessagesList).toHaveBeenCalledTimes(1);
    expect(client.sessionMessagesList).toHaveBeenCalledWith({ sessionId: 'ses_remote' });
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(session.sendUserTextMessageCommitted).not.toHaveBeenCalled();
  });

  it('streams Task child session deltas and tool calls into a sidechain (during the turn)', async () => {
    const client = createFakeClient() as any;
    client.sessionMessagesList = vi.fn(async () => ([] as unknown[]));

    const session = createFakeSession();

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-task-sidechain-stream' });
    void promptPromise.catch(() => undefined);
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    // Parent Task tool part references a child session early via metadata.
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_task_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_task_1',
            callID: 'call_task_1',
            tool: 'task',
            state: {
              status: 'running',
              input: { description: 'Run child' },
              metadata: { sessionId: 'ses_child_1' },
            },
          },
        },
      },
    });

    // Child session streams text.
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_child_text_1', type: 'text', sessionID: 'ses_child_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_child_1', messageID: 'msg_child_asst_1', partID: 'part_child_text_1', delta: 'CH' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_child_1', messageID: 'msg_child_asst_1', partID: 'part_child_text_1', delta: 'CHILD_OK' } },
    });

    // Child session streams tools.
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.created',
        properties: {
          part: {
            id: 'part_child_tool_1',
            type: 'tool',
            sessionID: 'ses_child_1',
            messageID: 'msg_child_tool_1',
            callID: 'call_child_tool_1',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'echo child' }, output: 'child', metadata: {} },
          },
        },
      },
    });

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_task_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_task_1',
            callID: 'call_task_1',
            tool: 'task',
            state: {
              status: 'completed',
              input: { description: 'Run child' },
              output: 'Child finished',
              metadata: { sessionId: 'ses_child_1' },
            },
          },
        },
      },
    });

    // Parent assistant activity so the turn can resolve even if sidechain routing is broken.
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_parent_text_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_parent_asst_1', partID: 'part_parent_text_1', delta: 'PARENT_OK' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    await expect.poll(() =>
      getCommittedTranscriptRows(session, { type: 'message', sidechainId: 'call_task_1' }).some((row) => row.body?.message === 'CHILD_OK'),
    ).toBe(true);
    const sidechainText = getCommittedTranscriptRows(session, { type: 'message', sidechainId: 'call_task_1' }).find((row) => row.body?.message === 'CHILD_OK');
    expect(sidechainText).toBeTruthy();
    expect(sidechainText?.meta).toMatchObject({
      importedFrom: 'acp-sidechain',
      remoteSessionId: 'ses_child_1',
      sidechainId: 'call_task_1',
    });
    expect(typeof sidechainText?.meta?.happierStreamKey).toBe('string');
    expect(sidechainText?.meta?.happierSidechainStreamKey).toBe(sidechainText?.meta?.happierStreamKey);

    const sidechainToolCall = session.sendAgentMessage.mock.calls.find(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'tool-call' && c?.[1]?.sidechainId === 'call_task_1' && c?.[1]?.callId === 'call_child_tool_1',
    );
    expect(sidechainToolCall).toBeTruthy();
    expect(sidechainToolCall?.[2]?.meta).toMatchObject({
      importedFrom: 'acp-sidechain',
      remoteSessionId: 'ses_child_1',
      sidechainId: 'call_task_1',
    });
    await runtime.cancel().catch(() => {});
    await promptPromise.catch(() => undefined);
  });

  it('streams sidechain text as incremental deltas (avoids duplicate prefixes when OpenCode emits cumulative deltas)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MS', '0');
    vi.stubEnv('HAPPIER_STREAM_CHECKPOINT_MIN_CHARS', '1');
    try {
      const client = createFakeClient() as any;
      client.sessionMessagesList = vi.fn(async () => ([] as unknown[]));

      const session = createFakeSession();

      const runtime = createOpenCodeServerRuntime(
        {
          directory: '/tmp',
          session,
          messageBuffer: new MessageBuffer(),
          mcpServers: {},
          permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
          onThinkingChange: vi.fn(),
        },
        {
          createClient: async () => client as any,
        },
      );

      await runtime.startOrLoad({});
      runtime.beginTurn();

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-sidechain-incremental' });
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_tool_task_1',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_tool_task_1',
              callID: 'call_task_1',
              tool: 'task',
              state: { status: 'running', input: { description: 'Run child' }, metadata: { sessionId: 'ses_child_1' } },
            },
          },
        },
      });

      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.updated', properties: { part: { id: 'part_child_text_1', type: 'text', sessionID: 'ses_child_1' } } },
      });

      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_child_1', messageID: 'msg_child_asst_1', partID: 'part_child_text_1', delta: 'H' } },
      });
      await vi.advanceTimersByTimeAsync(60);
      await flushTranscriptCommitMicrotasks();

      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_child_1', messageID: 'msg_child_asst_1', partID: 'part_child_text_1', delta: 'HE' } },
      });
      await vi.advanceTimersByTimeAsync(60);
      await flushTranscriptCommitMicrotasks();

      const sidechainCommitted = getCommittedTranscriptRows(session, { type: 'message', sidechainId: 'call_task_1' })
        .map((row) => row.body?.message ?? '');
      expect(sidechainCommitted).toContain('H');
      expect(sidechainCommitted).toContain('HE');

      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.updated', properties: { part: { id: 'part_parent_text_1', type: 'text', sessionID: 'ses_1' } } },
      });
      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_parent_asst_1', partID: 'part_parent_text_1', delta: 'PARENT_OK' } },
      });
      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_tool_task_1',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_tool_task_1',
              callID: 'call_task_1',
              tool: 'task',
              state: {
                status: 'completed',
                input: { description: 'Run child' },
                output: '<task_metadata>\nsession_id: ses_child_1\n</task_metadata>\n\n<task_result>\nHE\n</task_result>',
                metadata: { sessionId: 'ses_child_1' },
              },
            },
          },
        },
      });
      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_parent_asst_1' });

      await expect(promptPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

	  it('imports Task child session messages as a sidechain (meta.importedFrom="acp-sidechain")', async () => {
	    const client = createFakeClient() as any;
    let resolveChildMessages!: (value: any[]) => void;
    const childMessagesPromise = new Promise<any[]>((resolve) => {
      resolveChildMessages = (value) => resolve(value);
    });
    client.sessionMessagesList = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId !== 'ses_child') return [];
      return await childMessagesPromise;
    });

    const session = createFakeSession();

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-task-sidechain' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_task_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_task_1',
            callID: 'call_task_1',
            tool: 'task',
            state: {
              status: 'completed',
              output:
                'task_id: ses_child (for resuming to continue this task if needed)\\n\\n<task_result>\\nSUBTASK_OK\\n</task_result>',
              title: 'Run subtask',
              metadata: { sessionId: 'ses_child' },
            },
          },
        },
      },
    });

    await emitTerminalAssistantAndIdle(client, { messageId: 'msg_parent_sidechain_import_complete' });

    let didResolve = false;
    void promptPromise.then(() => {
      didResolve = true;
    });

    // Give the runtime a chance to observe the idle signal and start sidechain import.
    // The turn must not resolve while the Task sidechain import is still pending.
    await expect.poll(() => (client.sessionMessagesList as any).mock.calls.some((c: any[]) => c?.[0]?.sessionId === 'ses_child')).toBe(true);
    expect(didResolve).toBe(false);

    resolveChildMessages([
      {
        info: { role: 'assistant', id: 'msg_child_a1', time: { created: 10 }, sessionID: 'ses_child' },
        parts: [{ type: 'text', text: 'SUBTASK_OK' }],
      },
    ]);

    await expect(promptPromise).resolves.toBeUndefined();

    await expect.poll(() => session.sendAgentMessageCommitted.mock.calls.length).toBeGreaterThan(0);
    const sidechainCall = session.sendAgentMessageCommitted.mock.calls.find(
      (c: any[]) =>
        c?.[0] === 'opencode' &&
        c?.[1]?.type === 'message' &&
        c?.[1]?.sidechainId === 'call_task_1' &&
        c?.[2]?.meta?.importedFrom === 'acp-sidechain',
    );
    expect(sidechainCall).toBeTruthy();
  });

  it('does not resolve the turn before a late Task sidechain import starts when idle arrives early', async () => {
    const client = createFakeClient() as any;
    client.sessionMessagesList = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'ses_child') {
        return [
          {
            info: { role: 'assistant', id: 'msg_child_a1', time: { created: 10 }, sessionID: 'ses_child' },
            parts: [{ type: 'text', text: 'SUBTASK_OK' }],
          },
        ];
      }
      return [];
    });

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-task-sidechain-idle-early' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_task_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_task_1',
            callID: 'call_task_1',
            tool: 'task',
            state: {
              status: 'running',
              input: { prompt: 'Respond with EXACTLY: SUBTASK_OK' },
            },
          },
        },
      },
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    let didResolve = false;
    void promptPromise.then(() => {
      didResolve = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(didResolve).toBe(false);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_task_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_task_1',
            callID: 'call_task_1',
            tool: 'task',
            state: {
              status: 'completed',
              output:
                '<task_metadata>\\nsession_id: ses_child\\n</task_metadata>\\n\\n<task_result>\\nSUBTASK_OK\\n</task_result>',
              title: 'Run subtask',
              metadata: { sessionId: 'ses_child' },
            },
          },
        },
      },
    });
    await emitAssistantMessageUpdated(client, { messageId: 'msg_parent_late_sidechain_complete', finish: 'stop' });

    await expect(promptPromise).resolves.toBeUndefined();
    const sidechainCall = session.sendAgentMessageCommitted.mock.calls.find(
      (c: any[]) =>
        c?.[0] === 'opencode' &&
        c?.[1]?.type === 'message' &&
        c?.[1]?.sidechainId === 'call_task_1' &&
        c?.[2]?.meta?.importedFrom === 'acp-sidechain',
    );
    expect(sidechainCall).toBeTruthy();
  });

  it('does not let idle overtake a task tool event that is still flushing stream state', async () => {
    const client = createFakeClient() as any;
    let resolveChildMessages!: (value: any[]) => void;
    const childMessagesPromise = new Promise<any[]>((resolve) => {
      resolveChildMessages = resolve;
    });
    client.sessionMessagesList = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId !== 'ses_child') return [];
      return await childMessagesPromise;
    });

    let releaseCommittedFlush!: () => void;
    const committedFlushPromise = new Promise<void>((resolve) => {
      releaseCommittedFlush = resolve;
    });

    const session = createFakeSession();
    let shouldBlockCommittedFlush = true;
    session.sendAgentMessageCommitted = vi.fn(async () => {
      if (!shouldBlockCommittedFlush) return;
      shouldBlockCommittedFlush = false;
      await committedFlushPromise;
    });

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-task-sidechain-serialized-idle' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_text_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_text_1', delta: 'HELLO' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_task_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_task_1',
            callID: 'call_task_1',
            tool: 'task',
            state: {
              status: 'completed',
              output:
                '<task_metadata>\nsession_id: ses_child\n</task_metadata>\n\n<task_result>\nSUBTASK_OK\n</task_result>',
              title: 'Run subtask',
              metadata: { sessionId: 'ses_child' },
            },
          },
        },
      },
    });
    await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_1', finish: 'stop' });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    let didResolve = false;
    void promptPromise.then(() => {
      didResolve = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(didResolve).toBe(false);

    releaseCommittedFlush();
    await expect.poll(() => (client.sessionMessagesList as any).mock.calls.some((call: any[]) => call?.[0]?.sessionId === 'ses_child')).toBe(true);
    expect(didResolve).toBe(false);

    resolveChildMessages([
      {
        info: { role: 'assistant', id: 'msg_child_a1', time: { created: 10 }, sessionID: 'ses_child' },
        parts: [{ type: 'text', text: 'SUBTASK_OK' }],
      },
    ]);

    await expect(promptPromise).resolves.toBeUndefined();
    const sidechainCall = session.sendAgentMessageCommitted.mock.calls.find(
      (c: any[]) =>
        c?.[0] === 'opencode' &&
        c?.[1]?.type === 'message' &&
        c?.[1]?.sidechainId === 'call_task_1' &&
        c?.[2]?.meta?.importedFrom === 'acp-sidechain',
    );
    expect(sidechainCall).toBeTruthy();
  });

  it('drains queued Task child deltas before resolving idle so live sidechain streaming is not dropped', async () => {
    const client = createFakeClient() as any;
    client.sessionMessagesList = vi.fn(async () => ([] as unknown[]));

    let releaseCommittedFlush!: () => void;
    const committedFlushPromise = new Promise<void>((resolve) => {
      releaseCommittedFlush = resolve;
    });

    const session = createFakeSession();
    let shouldBlockCommittedFlush = true;
    session.sendAgentMessageCommitted = vi.fn(async (...args: any[]) => {
      if (args?.[1]?.sidechainId === 'call_task_live_stream') return;
      if (!shouldBlockCommittedFlush) return;
      shouldBlockCommittedFlush = false;
      await committedFlushPromise;
    });

    const runtime = createOpenCodeServerRuntime(
      {
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      },
      {
        createClient: async () => client as any,
      },
    );

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-task-sidechain-drain-before-idle' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_parent_text_queued', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_parent_text_queued', partID: 'part_parent_text_queued', delta: 'PARENT' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_task_live_stream',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_task_live_stream',
            callID: 'call_task_live_stream',
            tool: 'task',
            state: {
              status: 'completed',
              input: { description: 'Run child' },
              output: '<task_metadata>\nsession_id: ses_child_live_stream\n</task_metadata>\n\n<task_result>\nSUBTASK_OK\n</task_result>',
              title: 'Run child',
              metadata: { sessionId: 'ses_child_live_stream' },
            },
          },
        },
      },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_child_text_live_stream', type: 'text', sessionID: 'ses_child_live_stream' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_child_live_stream', messageID: 'msg_child_live_stream', partID: 'part_child_text_live_stream', delta: 'CH' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_child_live_stream', messageID: 'msg_child_live_stream', partID: 'part_child_text_live_stream', delta: 'CHILD_OK' } },
    });
    await emitAssistantMessageUpdated(client, { messageId: 'msg_parent_text_queued', finish: 'stop' });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
    });

    let didResolve = false;
    void promptPromise.then(() => {
      didResolve = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(didResolve).toBe(false);

    releaseCommittedFlush();
    await expect(promptPromise).resolves.toBeUndefined();
    await flushTranscriptCommitMicrotasks();

    const sidechainCommits = getCommittedTranscriptRows(session, { type: 'message', sidechainId: 'call_task_live_stream' });
    expect(sidechainCommits.length).toBeGreaterThan(0);
    expect(sidechainCommits[sidechainCommits.length - 1]?.body?.message).toBe('CHILD_OK');
  });

  it('waits to emit task_complete until in-flight tool forwarding finishes after idle', async () => {
    const client = createFakeClient() as any;
    const session = createFakeSession();

    let releaseCommittedFlush!: () => void;
    const committedFlushPromise = new Promise<void>((resolve) => {
      releaseCommittedFlush = resolve;
    });

    let shouldBlockCommittedFlush = true;
    session.sendAgentMessageCommitted = vi.fn(async () => {
      if (!shouldBlockCommittedFlush) return;
      shouldBlockCommittedFlush = false;
      await committedFlushPromise;
    });

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-tool-forwarding-order' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_text_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_text_1', delta: 'HELLO' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_1',
            callID: 'call_1',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'echo hi' },
              output: 'ok',
              title: 'Run bash',
              metadata: {},
            },
          },
        },
      },
    });
    await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_1', finish: 'stop' });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    let didResolve = false;
    void promptPromise.then(() => {
      didResolve = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(didResolve).toBe(false);
    expect(session.sendAgentMessage.mock.calls.some(
      (call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'task_complete',
    )).toBe(false);

    releaseCommittedFlush();

    await expect(promptPromise).resolves.toBeUndefined();

    const toolCallIndex = session.sendAgentMessage.mock.calls.findIndex(
      (call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'tool-call' && call?.[1]?.callId === 'call_1',
    );
    const toolResultIndex = session.sendAgentMessage.mock.calls.findIndex(
      (call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'tool-result' && call?.[1]?.callId === 'call_1',
    );
    const taskCompleteIndex = session.sendAgentMessage.mock.calls.findIndex(
      (call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'task_complete',
    );

    expect(toolCallIndex).toBeGreaterThanOrEqual(0);
    expect(toolResultIndex).toBeGreaterThan(toolCallIndex);
    expect(taskCompleteIndex).toBeGreaterThan(toolResultIndex);
  });

  it('does not carry timed-out tool forwarding work into the next turn after idle completion', async () => {
    const prior = process.env.HAPPIER_OPENCODE_SERVER_IDLE_PENDING_TOOL_FORWARDING_TIMEOUT_MS;
    const priorPollInterval = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
    process.env.HAPPIER_OPENCODE_SERVER_IDLE_PENDING_TOOL_FORWARDING_TIMEOUT_MS = '100';
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = '25';

    try {
      const client = createFakeClient() as any;
      const session = createFakeSession();
      const permissionHandler = { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) };

      let releaseCommittedFlush!: () => void;
      const committedFlushPromise = new Promise<void>((resolve) => {
        releaseCommittedFlush = resolve;
      });

      session.sendAgentMessageCommitted = vi.fn(async () => {
        await committedFlushPromise;
      });

      const runtime = createOpenCodeServerRuntime({
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: permissionHandler as any,
        onThinkingChange: vi.fn(),
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});

      runtime.beginTurn();
      const firstPromptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-turn-1' });
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_tool_1',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_tool_1',
              callID: 'call_1',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: 'echo hi' },
                output: 'ok',
                title: 'Run bash',
                metadata: {},
              },
            },
          },
        },
      });
      await flushTranscriptCommitMicrotasks();
      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_asst_1' });

      const firstTurnOutcome = await Promise.race([
        firstPromptPromise.then(() => 'resolved' as const),
        new Promise<'timeout'>((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), 1_000);
          timer.unref?.();
        }),
      ]);
      expect(firstTurnOutcome).toBe('resolved');

      let secondTurnIdleAllowed = false;
      let secondTurnStatusReads = 0;
      client.sessionStatusList.mockImplementation(async () => {
        secondTurnStatusReads += 1;
        return {
          ses_1: {
            type: secondTurnStatusReads <= 1 || secondTurnIdleAllowed ? 'idle' : 'busy',
          },
        };
      });

      runtime.beginTurn();
      const secondPromptPromise = (runtime as any).sendPromptWithMeta({ text: 'second turn', localId: 'local-turn-2' });
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(2);

      let secondTurnResolved = false;
      void secondPromptPromise.then(() => {
        secondTurnResolved = true;
      });

      releaseCommittedFlush();

      await vi.waitFor(() => {
        expect(session.sendAgentMessage.mock.calls.some(
          (call: any[]) => call?.[0] === 'opencode'
            && call?.[1]?.type === 'tool-result'
            && call?.[1]?.callId === 'call_1',
        )).toBe(true);
      });

      expect(secondTurnResolved).toBe(false);

      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.updated', properties: { part: { id: 'part_text_2', type: 'text', sessionID: 'ses_1' } } },
      });
      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_2', partID: 'part_text_2', delta: 'SECOND' } },
      });
      secondTurnIdleAllowed = true;
      await emitAssistantMessageUpdated(client, { messageId: 'msg_asst_2', finish: 'stop' });
      client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });

      await expect(secondPromptPromise).resolves.toBeUndefined();

      expect(session.sendAgentMessage.mock.calls.some(
        (call: any[]) => call?.[0] === 'opencode'
          && call?.[1]?.type === 'tool-call'
          && call?.[1]?.name === 'Diff',
      )).toBe(false);
    } finally {
      if (typeof prior === 'string') {
        process.env.HAPPIER_OPENCODE_SERVER_IDLE_PENDING_TOOL_FORWARDING_TIMEOUT_MS = prior;
      } else {
        delete process.env.HAPPIER_OPENCODE_SERVER_IDLE_PENDING_TOOL_FORWARDING_TIMEOUT_MS;
      }
      if (typeof priorPollInterval === 'string') {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = priorPollInterval;
      } else {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      }
    }
  });

  it('cancel resolves even if the OpenCode abort endpoint hangs (does not wedge runner abort handling)', async () => {
    const prior = process.env.HAPPIER_OPENCODE_SERVER_ABORT_TIMEOUT_MS;
    process.env.HAPPIER_OPENCODE_SERVER_ABORT_TIMEOUT_MS = '25';
    try {
      const client = createFakeClient() as any;
      client.sessionAbort = vi.fn(async () => await new Promise<void>(() => {}));

      const session = createFakeSession();
      const runtime = createOpenCodeServerRuntime(
        {
          directory: '/tmp',
          session,
          messageBuffer: new MessageBuffer(),
          mcpServers: {},
          permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
          onThinkingChange: vi.fn(),
        },
        {
          createClient: async () => client as any,
        },
      );

      await runtime.startOrLoad({});

      const outcome = await Promise.race([
        runtime.cancel().then(() => 'cancelled' as const),
        new Promise<'timeout'>((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), 250);
          timer.unref?.();
        }),
      ]);

      expect(outcome).toBe('cancelled');
    } finally {
      if (typeof prior === 'string') {
        process.env.HAPPIER_OPENCODE_SERVER_ABORT_TIMEOUT_MS = prior;
      } else {
        delete process.env.HAPPIER_OPENCODE_SERVER_ABORT_TIMEOUT_MS;
      }
    }
  });

  it('cancel rejects an in-flight turn so sendPromptWithMeta does not hang forever', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime(
      {
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      },
      {
        createClient: async () => client as any,
      },
    );

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-cancel' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    await runtime.cancel();

    const outcome = await Promise.race([
      promptPromise.then(() => 'resolved' as const).catch(() => 'rejected' as const),
      new Promise<'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 250);
        timer.unref?.();
      }),
    ]);

    expect(outcome).toBe('rejected');
  });

  it('persists explicit cancel as a cancelled session turn without completing the turn', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime(
      {
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
        onThinkingChange: vi.fn(),
      },
      {
        createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
      },
    );

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as unknown as {
      sendPromptWithMeta: (params: { text: string; localId: string }) => Promise<void>;
    }).sendPromptWithMeta({ text: 'hello', localId: 'local-explicit-cancel' });
    void promptPromise.catch(() => undefined);
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const startedMarker = sentAgentMessagesOfType(session, 'task_started')[0] as { id?: unknown } | undefined;

    await runtime.cancel();

    await expect(promptPromise).rejects.toThrow(/aborted/i);
    expect(session.sessionTurnLifecycle.cancelTurn).toHaveBeenCalledWith({
      provider: 'opencode',
      providerTurnId: startedMarker?.id,
    });
    expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(0);
    expect(session.sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();
    expect(session.sessionTurnLifecycle.failTurn).not.toHaveBeenCalled();

    await runtime.reset().catch(() => {});
  });

  it('does not emit an extra turn_aborted when explicit cancel produces a session.error event', async () => {
    const client = createFakeClient();
    client.sessionAbort = vi.fn(async () => {
      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.error',
          properties: {
            sessionID: 'ses_1',
            error: {
              name: 'AbortError',
              message: 'The operation was aborted.',
            },
          },
        },
      });
    });

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime(
      {
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      },
      {
        createClient: async () => client as any,
      },
    );

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-cancel-session-error' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    await runtime.cancel();

    await expect(promptPromise).rejects.toBeTruthy();

    const turnAbortedMessages = session.sendAgentMessage.mock.calls.filter(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'turn_aborted',
    );
    expect(turnAbortedMessages).toHaveLength(0);
  });

  it('does not suppress later unrelated session.error after explicit cancel completes', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime(
      {
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      },
      {
        createClient: async () => client as any,
      },
    );

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-cancel-then-error' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    await runtime.cancel();
    await expect(promptPromise).rejects.toBeTruthy();
    const cancelledSessionId = 'ses_1';
    expect(client.sessionAbort).toHaveBeenCalledWith({ sessionId: cancelledSessionId });

    await client.__emit({
      directory: '/tmp',
      payload: {
        type: 'session.status',
        properties: {
          sessionID: cancelledSessionId,
          status: { type: 'idle' },
        },
      },
    });
    await flushTranscriptCommitMicrotasks();
    expect(client.sessionMessagesList).toHaveBeenCalled();

    await client.__emit({
      directory: '/tmp',
      payload: {
        type: 'session.error',
        properties: {
          sessionID: cancelledSessionId,
          error: {
            name: 'UnknownError',
            message: 'model provider failed later',
          },
        },
      },
    });

    await expect.poll(() => session.sessionTurnLifecycle.failTurn.mock.calls.length).toBe(1);
    expect(session.sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode',
      issue: expect.objectContaining({
        source: 'provider_session_error',
        sanitizedPreview: 'Provider session failed',
      }),
    }));

    await runtime.reset().catch(() => {});
  });

  it('keeps status polling alive when one status lookup throws', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS: '25',
      HAPPIER_OPENCODE_SERVER_ACTIVE_CONTROL_POLL_INTERVAL_MS: '25',
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '1',
    });
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const client = createFakeClient();
      let statusReadCount = 0;
      client.sessionStatusList = vi.fn(async () => {
        statusReadCount += 1;
        if (statusReadCount === 1) {
          const statuses: Record<string, unknown> = {};
          Object.defineProperty(statuses, 'ses_1', {
            get() {
              throw new Error('status lookup exploded');
            },
          });
          return statuses;
        }
        return { ses_1: { type: 'busy' } };
      });

      const started = await beginOpenCodePromptForTest({ client, localId: 'local-status-lookup-throw' });
      runtime = started.runtime;
      promptPromise = started.promptPromise;

      await expect.poll(() => client.sessionStatusList.mock.calls.length, { timeout: 500, interval: 25 }).toBeGreaterThan(1);
    } finally {
      await runtime?.cancel().catch(() => {});
      await runtime?.reset().catch(() => {});
      await promptPromise?.catch(() => undefined);
      restoreEnv();
    }
  });

  it('honors generic retry backoff before retry timeout', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
      HAPPIER_OPENCODE_SERVER_RETRY_MAX_WAIT_MS: '60000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const started = await beginOpenCodePromptForTest({ localId: 'local-generic-retry-timeout' });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const { client, session } = started;
      const outcome = observePromiseSettlement(promptPromise);

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.status',
          properties: {
            sessionID: 'ses_1',
            status: {
              type: 'retry',
              attempt: 1,
              message: 'provider temporarily unavailable',
              next: Date.now() + 30_000,
            },
          },
        },
      });

      await advanceTimersAndFlush(12_000);
      expect(outcome.status).toBe('pending');
      expect(client.sessionAbort).not.toHaveBeenCalled();

      await advanceTimersAndFlush(29_000);
      expect(outcome.status).toBe('rejected');
      expect(client.sessionAbort).toHaveBeenCalledWith({ sessionId: 'ses_1' });
      expect(session.sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'opencode',
        issue: expect.objectContaining({
          source: expect.stringMatching(/retry|status|stream/),
        }),
      }));
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('does not abort a long-running silent tool before it emits meaningful input', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const started = await beginOpenCodePromptForTest({ localId: 'local-silent-tool' });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const { client, session } = started;
      const outcome = observePromiseSettlement(promptPromise);

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_silent_tool',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_tool_silent',
              callID: 'call_silent_tool',
              tool: 'bash',
              state: { status: 'running', input: {} },
            },
          },
        },
      });

      await advanceTimersAndFlush(30_000);
      expect(outcome.status).toBe('pending');
      expect(client.sessionAbort).not.toHaveBeenCalled();
      expect(sentAgentMessagesOfType(session, 'tool-call')).toHaveLength(0);
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('dispatches exactly once without live SSE provenance while ambiguous replay stays observation-only', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });

    try {
      await runtime.startOrLoad({});
      runtime.beginTurn();
      const onProviderPromptSubmitted = vi.fn(async () => {});
      const promptPromise = (runtime as unknown as OpenCodeRuntimePromptHarness).sendPromptWithMeta({
        text: 'reach OpenCode through the authenticated prompt endpoint',
        localId: 'local-live-provenance-unavailable',
        onProviderPromptSubmitted,
      });
      await flushTranscriptCommitMicrotasks();

      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
      expect(onProviderPromptSubmitted).toHaveBeenCalledTimes(1);

      await client.__emitUntrusted({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });
      const replayOutcome = await Promise.race([
        promptPromise.then(() => 'resolved' as const),
        new Promise<'pending'>((resolve) => {
          const timer = setTimeout(() => resolve('pending'), 25);
          timer.unref?.();
        }),
      ]);

      expect(replayOutcome).toBe('pending');
      expect(client.sessionPromptAsync).toHaveBeenCalledTimes(1);
      expect(sentAgentMessagesOfType(session, 'tool-call')).toHaveLength(0);
      expect(sentAgentMessagesOfType(session, 'tool-result')).toHaveLength(0);
      expect(client.sessionAbort).not.toHaveBeenCalled();
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(0);

      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_live_after_untrusted_replay' });
      await expect(promptPromise).resolves.toBeUndefined();
      expect(client.sessionPromptAsync).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.reset().catch(() => {});
    }
  });

  it('ignores unrelated control-plane history rows when refreshing live-known reconnect state', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const started = await beginOpenCodePromptForTest({
        localId: 'local-reconnect-history-unrelated-ignored',
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const { client, session } = started;
      const outcome = observePromiseSettlement(promptPromise);

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_reconnect_live_known',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_reconnect_live_known',
              callID: 'call_reconnect_live_known',
              tool: 'bash',
              state: { status: 'running', input: { command: 'sleep 30' } },
            },
          },
        },
      });

      client.sessionMessagesList.mockResolvedValue([
        {
          info: {
            id: 'msg_unrelated_terminal_assistant_from_history',
            role: 'assistant',
            sessionID: 'ses_1',
            time: { completed: 100 },
            finish: 'stop',
          },
          parts: [{ type: 'text', text: 'UNRELATED_RECONNECT_HISTORY_TEXT' }],
        },
        {
          info: {
            id: 'msg_unrelated_terminal_tool_from_history',
            role: 'assistant',
            sessionID: 'ses_1',
            time: { completed: 101 },
          },
          parts: [{
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_unrelated_terminal_tool_from_history',
            callID: 'call_unrelated_reconnect_tool',
            tool: 'grep',
            state: {
              status: 'completed',
              input: { pattern: 'unrelated' },
              output: 'UNRELATED_RECONNECT_TOOL_RESULT',
              metadata: {},
            },
          }],
        },
      ]);

      await client.__emit({
        directory: '/tmp',
        payload: { type: 'server.connected', properties: {} },
      });
      await flushTranscriptCommitMicrotasks();

      expect(outcome.status).toBe('pending');
      expect(sentAgentMessagesOfType(session, 'tool-result')).toHaveLength(0);
      expect(JSON.stringify(session.sendAgentMessageCommitted.mock.calls)).not.toContain('UNRELATED_RECONNECT_HISTORY_TEXT');
      expect(JSON.stringify(session.sendAgentMessageCommitted.mock.calls)).not.toContain('UNRELATED_RECONNECT_TOOL_RESULT');
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(0);
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it.each(['failed', 'cancelled', 'aborted'] as const)(
    'reconciles a missed terminal %s tool from control-plane history without forwarding provider input',
    async (status) => {
      const restoreEnv = withEnvForTest({
        HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
        HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
      });
      vi.useFakeTimers();
      vi.setSystemTime(new Date(0));
      let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
      let promptPromise: Promise<void> | null = null;
      try {
        const started = await beginOpenCodePromptForTest({ localId: `local-reconnect-tool-${status}` });
        runtime = started.runtime;
        promptPromise = started.promptPromise;
        const { client, session } = started;

        await client.__emit({
          directory: '/tmp',
          payload: {
            type: 'message.part.updated',
            properties: {
              part: {
                id: `part_reconnect_tool_${status}`,
                type: 'tool',
                sessionID: 'ses_1',
                messageID: `msg_tool_reconnect_${status}`,
                callID: `call_reconnect_tool_${status}`,
                tool: 'bash',
                state: { status: 'running', input: { command: 'echo terminal' } },
              },
            },
          },
        });
        await advanceTimersAndFlush(30_000);

        client.sessionMessagesList.mockResolvedValue([
          {
            info: {
              id: `msg_tool_reconnect_${status}`,
              role: 'assistant',
              sessionID: 'ses_1',
              time: { created: 1000 },
            },
            parts: [{
              type: 'tool',
              sessionID: 'ses_1',
              messageID: `msg_tool_reconnect_${status}`,
              callID: `call_reconnect_tool_${status}`,
              tool: 'bash',
              state: {
                status,
                input: { command: 'echo terminal' },
                error: `${status} from history`,
                metadata: {},
              },
            }],
          },
        ]);

        await client.__emit({
          directory: '/tmp',
          payload: { type: 'server.connected', properties: {} },
        });
        await flushTranscriptCommitMicrotasks();
        await emitAssistantMessageUpdated(client, { messageId: `msg_final_reconnect_${status}`, finish: 'stop' });
        await client.__emit({
          directory: '/tmp',
          payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
        });

        await expect(promptPromise).resolves.toBeUndefined();
        expect(sentAgentMessagesOfType(session, 'tool-result')).toHaveLength(0);
      } finally {
        await runtime?.cancel().catch(() => {});
        await promptPromise?.catch(() => undefined);
        vi.useRealTimers();
        await runtime?.reset().catch(() => {});
        restoreEnv();
      }
    },
  );

  it('forwards a tool result after a long silent running period', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const started = await beginOpenCodePromptForTest({ localId: 'local-delayed-tool-completion' });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const { client, session } = started;

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_delayed_tool',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_tool_delayed',
              callID: 'call_delayed_tool',
              tool: 'bash',
              state: { status: 'running', input: {} },
            },
          },
        },
      });
      await advanceTimersAndFlush(30_000);

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_delayed_tool',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_tool_delayed',
              callID: 'call_delayed_tool',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: 'sleep 30 && echo done' },
                output: 'done',
                title: 'Run bash',
                metadata: {},
              },
            },
          },
        },
      });
      await emitTerminalAssistantAndIdle(client, { messageId: 'msg_tool_delayed_final' });

      await expect(promptPromise).resolves.toBeUndefined();
      expect(sentAgentMessagesOfType(session, 'tool-call')).toEqual([
        expect.objectContaining({ callId: 'call_delayed_tool', name: 'bash' }),
      ]);
      expect(sentAgentMessagesOfType(session, 'tool-result')).toEqual([
        expect.objectContaining({ callId: 'call_delayed_tool' }),
      ]);
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('uses a final status liveness probe before deadlock aborting a busy OpenCode session', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const client = createFakeClient();
      let finalProbeStatus: 'busy' | 'idle' = 'busy';
      client.sessionStatusList = vi.fn(async () => ({ ses_1: { type: finalProbeStatus } }));
      const started = await beginOpenCodePromptForTest({ client, localId: 'local-final-status-probe-busy' });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const outcome = observePromiseSettlement(promptPromise);

      await advanceTimersAndFlush(12_000);
      expect(outcome.status).toBe('pending');
      expect(client.sessionStatusList).toHaveBeenCalled();
      expect(client.sessionAbort).not.toHaveBeenCalled();

      finalProbeStatus = 'idle';
      await advanceTimersAndFlush(12_000);
      expect(outcome.status).toBe('rejected');
      expect(client.sessionAbort).toHaveBeenCalledWith({ sessionId: 'ses_1' });
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('adds final liveness probe diagnostics to deadlock guard failures', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const client = createFakeClient();
      client.sessionStatusList = vi.fn(async () => ({ ses_1: { type: 'idle' } }));
      const started = await beginOpenCodePromptForTest({ client, localId: 'local-final-status-probe-diagnostics' });
      runtime = started.runtime;
      promptPromise = started.promptPromise;

      await advanceTimersAndFlush(12_000);

      await expect(promptPromise).rejects.toThrow(/final liveness probe/u);
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it.each(['permission', 'question'] as const)('does not fire deadlock guard while %s waits for the user', async (kind) => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    let releaseUserWait!: () => void;
    const userWait = new Promise<void>((resolve) => {
      releaseUserWait = resolve;
    });
    try {
      const permissionHandler = {
        handleToolCall: vi.fn(async () => {
          await userWait;
          if (kind === 'question') return { decision: 'approved' as const, answers: { q1: ['yes'] } };
          return { decision: 'approved' as const };
        }),
      };
      const started = await beginOpenCodePromptForTest({
        permissionHandler,
        localId: `local-${kind}-wait-guard`,
      });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const { client } = started;
      const outcome = observePromiseSettlement(promptPromise);

      if (kind === 'permission') {
        await client.__emit({
          directory: '/tmp',
          payload: {
            type: 'permission.asked',
            properties: {
              id: 'perm_wait',
              sessionID: 'ses_1',
              permission: 'edit',
              patterns: ['AGENTS.md'],
              always: ['*'],
              metadata: {},
              tool: { messageID: 'msg_tool_wait', callID: 'call_wait' },
            },
          },
        });
      } else {
        await client.__emit({
          directory: '/tmp',
          payload: {
            type: 'question.asked',
            properties: {
              id: 'question_wait',
              sessionID: 'ses_1',
              questions: [{ question: 'Continue?', header: 'Continue', options: [], multiple: false }],
            },
          },
        });
      }
      await flushTranscriptCommitMicrotasks();
      expect(permissionHandler.handleToolCall).toHaveBeenCalledTimes(1);

      await advanceTimersAndFlush(30_000);
      expect(outcome.status).toBe('pending');
      expect(client.sessionAbort).not.toHaveBeenCalled();

      releaseUserWait();
      await flushTranscriptCommitMicrotasks();
      if (kind === 'permission') {
        await expect.poll(() => client.permissionReply.mock.calls.length, { timeout: 500, interval: 25 }).toBe(1);
      } else {
        await expect.poll(() => client.questionReply.mock.calls.length, { timeout: 500, interval: 25 }).toBe(1);
      }
      await advanceTimersAndFlush(12_000);
      expect(outcome.status).toBe('rejected');
      expect(client.sessionAbort).toHaveBeenCalledWith({ sessionId: 'ses_1' });
    } finally {
      releaseUserWait?.();
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('resets compaction guard state across turns', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let firstPromptPromise: Promise<void> | null = null;
    let secondPromptPromise: Promise<void> | null = null;
    try {
      const started = await beginOpenCodePromptForTest({ localId: 'local-compaction-turn-1' });
      runtime = started.runtime;
      firstPromptPromise = started.promptPromise;
      const { client } = started;
      const firstOutcome = observePromiseSettlement(firstPromptPromise);

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.next.compaction.started',
          properties: { sessionID: 'ses_1', id: 'compact_guard_1', reason: 'threshold' },
        },
      });
      await advanceTimersAndFlush(30_000);
      expect(firstOutcome.status).toBe('pending');
      expect(client.sessionAbort).not.toHaveBeenCalled();

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.error',
          properties: {
            sessionID: 'ses_1',
            error: { name: 'UnknownError', message: 'first turn failed' },
          },
        },
      });
      useCompletedProviderErrorInventory(client, {
        name: 'UnknownError',
        message: 'first turn failed',
      }, 'msg_first_turn_failed');
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
      });
      await expect(firstPromptPromise).rejects.toThrow('first turn failed');

      runtime.beginTurn();
      secondPromptPromise = (runtime as unknown as {
        sendPromptWithMeta: (params: { text: string; localId: string }) => Promise<void>;
      }).sendPromptWithMeta({ text: 'second', localId: 'local-compaction-turn-2' });
      void secondPromptPromise.catch(() => undefined);
      await flushTranscriptCommitMicrotasks();
      expect(client.sessionPromptAsync.mock.calls.length).toBe(2);
      const secondOutcome = observePromiseSettlement(secondPromptPromise);

      await advanceTimersAndFlush(12_000);
      expect(secondOutcome.status).toBe('rejected');
      expect(client.sessionAbort).toHaveBeenCalledWith({ sessionId: 'ses_1' });
    } finally {
      await runtime?.cancel().catch(() => {});
      await firstPromptPromise?.catch(() => undefined);
      await secondPromptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('treats session.next text reasoning and step events as guard activity', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const started = await beginOpenCodePromptForTest({ localId: 'local-session-next-activity' });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const { client } = started;
      const outcome = observePromiseSettlement(promptPromise);

      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.next.text.delta', properties: { sessionID: 'ses_1', messageID: 'msg_next_1', delta: 'A' } },
      });
      await advanceTimersAndFlush(9_000);
      expect(outcome.status).toBe('pending');

      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.next.reasoning.delta', properties: { sessionID: 'ses_1', messageID: 'msg_next_1', delta: 'thinking' } },
      });
      await advanceTimersAndFlush(9_000);
      expect(outcome.status).toBe('pending');

      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.next.step.started', properties: { sessionID: 'ses_1', id: 'step_1' } },
      });
      await advanceTimersAndFlush(9_000);
      expect(outcome.status).toBe('pending');

      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.next.step.ended', properties: { sessionID: 'ses_1', id: 'step_1' } },
      });
      await advanceTimersAndFlush(12_000);
      expect(outcome.status).toBe('rejected');
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('treats session.next tool events as guard tool lifecycle', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const started = await beginOpenCodePromptForTest({ localId: 'local-session-next-tool' });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const { client } = started;
      const outcome = observePromiseSettlement(promptPromise);

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.next.tool.called',
          properties: {
            sessionID: 'ses_1',
            messageID: 'msg_next_tool',
            callID: 'call_next_tool',
            tool: 'bash',
            input: {},
          },
        },
      });
      await advanceTimersAndFlush(30_000);
      expect(outcome.status).toBe('pending');
      expect(client.sessionAbort).not.toHaveBeenCalled();

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.next.tool.success',
          properties: {
            sessionID: 'ses_1',
            messageID: 'msg_next_tool',
            callID: 'call_next_tool',
            tool: 'bash',
            output: 'done',
          },
        },
      });
      await advanceTimersAndFlush(12_000);
      expect(outcome.status).toBe('rejected');
      expect(client.sessionAbort).toHaveBeenCalledWith({ sessionId: 'ses_1' });
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('routes session.next retried through generic retry handling', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
      HAPPIER_OPENCODE_SERVER_RETRY_MAX_WAIT_MS: '60000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const started = await beginOpenCodePromptForTest({ localId: 'local-session-next-retried' });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const { client, session } = started;
      const outcome = observePromiseSettlement(promptPromise);

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.next.retried',
          properties: {
            sessionID: 'ses_1',
            attempt: 1,
            message: 'provider temporarily unavailable',
            next: Date.now() + 30_000,
          },
        },
      });
      await flushTranscriptCommitMicrotasks();

      expect(outcome.status).toBe('pending');
      expect(sentAgentMessagesOfType(session, 'message').filter((message) => /retry/i.test(String((message as { message?: unknown }).message ?? '')))).toHaveLength(1);

      await advanceTimersAndFlush(61_000);
      expect(outcome.status).toBe('rejected');
      expect(client.sessionAbort).toHaveBeenCalledWith({ sessionId: 'ses_1' });
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });

  it('routes nested session.next retried usage-limit errors through fail-fast handling', async () => {
    const restoreEnv = withEnvForTest({
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    let promptPromise: Promise<void> | null = null;
    try {
      const started = await beginOpenCodePromptForTest({ localId: 'local-session-next-retried-usage' });
      runtime = started.runtime;
      promptPromise = started.promptPromise;
      const { client, session } = started;

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'session.next.retried',
          properties: {
            sessionID: 'ses_1',
            attempt: 1,
            error: { message: 'The usage limit has been reached' },
            next: Date.now() + 30_000,
          },
        },
      });

      await expect(promptPromise).rejects.toThrow(/usage limit/i);
      expect(client.sessionAbort).toHaveBeenCalledWith({ sessionId: 'ses_1' });
      expect(session.sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'opencode',
        issue: expect.objectContaining({
          source: 'usage_limit',
          usageLimit: expect.objectContaining({
            resetAtMs: null,
            retryAfterMs: expect.any(Number),
          }),
        }),
      }));
    } finally {
      await runtime?.cancel().catch(() => {});
      await promptPromise?.catch(() => undefined);
      vi.useRealTimers();
      await runtime?.reset().catch(() => {});
      restoreEnv();
    }
  });
});

describe('createOpenCodeServerRuntime managed-server generation recovery (Lane E)', () => {
  const buildIdentity = (generationKey: string): OpenCodeManagedServerIdentity => ({
    baseUrl: 'http://127.0.0.1:7777',
    pid: 4242,
    startedAtMs: 1,
    generationKey,
  });

  const toolHistoryMessage = (status: string, opts?: { messageId?: string; callId?: string; sessionId?: string; tool?: string }) => {
    const messageId = opts?.messageId ?? 'msg_tool';
    const callId = opts?.callId ?? 'call_x';
    const sessionId = opts?.sessionId ?? 'ses_1';
    const tool = opts?.tool ?? 'read';
    return {
      info: { id: messageId, role: 'assistant', sessionID: sessionId },
      parts: [{
        id: `part_${callId}`,
        type: 'tool',
        sessionID: sessionId,
        messageID: messageId,
        callID: callId,
        tool,
        state: { status, ...(status === 'completed' ? { output: 'done', input: {} } : { input: {} }) },
      }],
    };
  };

  const emitRunningTool = async (
    client: ReturnType<typeof createFakeClient>,
    opts?: { messageId?: string; callId?: string; sessionId?: string; tool?: string },
  ) => {
    const messageId = opts?.messageId ?? 'msg_tool';
    const callId = opts?.callId ?? 'call_x';
    const sessionId = opts?.sessionId ?? 'ses_1';
    const tool = opts?.tool ?? 'read';
    await client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: `part_${callId}`,
            type: 'tool',
            sessionID: sessionId,
            messageID: messageId,
            callID: callId,
            tool,
            state: { status: 'running', input: {} },
          },
        },
      },
    });
    await flushTranscriptCommitMicrotasks();
  };

  async function startGenerationRecoveryTurn() {
    const client = createFakeClient();
    const session = createFakeSession();
    const onThinkingChange = vi.fn();
    let capturedOnChange: ((change: OpenCodeManagedServerIdentityChange) => void) | null = null;
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange,
    }, {
      createClient: async (clientParams) => {
        capturedOnChange = clientParams.onManagedServerIdentityChanged ?? null;
        return client as unknown as OpenCodeServerRuntimeClient;
      },
    });
    await runtime.startOrLoad({});
    runtime.beginTurn();
    const promptPromise = (runtime as unknown as {
      sendPromptWithMeta: (params: { text: string; localId: string }) => Promise<void>;
    }).sendPromptWithMeta({ text: 'hello', localId: 'local-gen' });
    void promptPromise.catch(() => undefined);
    await flushTranscriptCommitMicrotasks();
    return { client, session, runtime, promptPromise, getOnChange: () => capturedOnChange };
  }

  it('fails the active turn once with opencode_server_restarted_during_turn when a live-known tool stays non-terminal after a generation change', async () => {
    const { client, session, runtime, promptPromise, getOnChange } = await startGenerationRecoveryTurn();
    try {
      await emitRunningTool(client);
      // Replacement server reattaches durable history, but the tool is still `running` (orphaned).
      (client.sessionMessagesList as any).mockResolvedValue([toolHistoryMessage('running')]);
      client.__setManagedServerIdentity(buildIdentity('gen-B'));

      const onChange = getOnChange();
      expect(onChange).toBeTruthy();
      onChange?.({ previous: buildIdentity('gen-initial'), current: buildIdentity('gen-B'), reason: 'http_retry_ensure' });
      await flushTranscriptCommitMicrotasks();
      await flushTranscriptCommitMicrotasks();

      const restartTurnFailedCount = () =>
        (sentAgentMessagesOfType(session, 'turn_failed') as Array<{ code?: string }>)
          .filter((m) => m.code === OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE).length;
      const restartFailTurnCount = () =>
        ((session.sessionTurnLifecycle.failTurn as any).mock.calls as Array<[{ issue?: { code?: string } }]>)
          .filter((call) => call[0]?.issue?.code === OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE).length;
      // Fires EXACTLY once: a single user-visible turn_failed and a single failTurn persist, not
      // merely "at least once".
      expect(restartTurnFailedCount()).toBe(1);
      expect(restartFailTurnCount()).toBe(1);
      const failArg = (session.sessionTurnLifecycle.failTurn as any).mock.calls.at(-1)?.[0];
      expect(failArg?.issue?.code).toBe(OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE);
      expect(failArg?.issue?.source).toBe('stream_error');
      // No task_complete, no sessionAbort, no prompt replay.
      expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(0);
      expect(client.sessionAbort).not.toHaveBeenCalled();
      expect((client.sessionPromptAsync as any).mock.calls.length).toBe(1);
      await expect(promptPromise).rejects.toMatchObject({ code: OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE });

      // A SECOND generation change AFTER the turn already failed must NOT double-fail: the turn is
      // settled, so the supervisor sees no active turn and only clears orphaned work.
      client.__setManagedServerIdentity(buildIdentity('gen-C'));
      getOnChange()?.({ previous: buildIdentity('gen-B'), current: buildIdentity('gen-C'), reason: 'http_retry_ensure' });
      await flushTranscriptCommitMicrotasks();
      await flushTranscriptCommitMicrotasks();
      expect(restartTurnFailedCount()).toBe(1);
      expect(restartFailTurnCount()).toBe(1);
    } finally {
      await runtime.reset().catch(() => {});
    }
  });

  it('does not fail with the restart issue when the live-known tool reconciles terminal on the replacement server', async () => {
    const { client, session, runtime, getOnChange } = await startGenerationRecoveryTurn();
    try {
      await emitRunningTool(client);
      // Replacement server's durable history shows the tool completed: forward + continue.
      (client.sessionMessagesList as any).mockResolvedValue([toolHistoryMessage('completed')]);
      client.__setManagedServerIdentity(buildIdentity('gen-B'));

      getOnChange()?.({ previous: buildIdentity('gen-initial'), current: buildIdentity('gen-B'), reason: 'http_retry_ensure' });
      await flushTranscriptCommitMicrotasks();
      await flushTranscriptCommitMicrotasks();

      const turnFailed = sentAgentMessagesOfType(session, 'turn_failed') as Array<{ code?: string }>;
      expect(turnFailed.some((m) => m.code === OPENCODE_SERVER_RESTARTED_DURING_TURN_ISSUE_CODE)).toBe(false);
      expect(client.sessionAbort).not.toHaveBeenCalled();
    } finally {
      await runtime.reset().catch(() => {});
    }
  });

  it('clears orphaned work without a user-visible failure when the generation changes with no active turn', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    let capturedOnChange: ((change: OpenCodeManagedServerIdentityChange) => void) | null = null;
    const getOnChange = () => capturedOnChange;
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async (clientParams) => {
        capturedOnChange = clientParams.onManagedServerIdentityChanged ?? null;
        return client as unknown as OpenCodeServerRuntimeClient;
      },
    });
    try {
      await runtime.startOrLoad({});
      client.__setManagedServerIdentity(buildIdentity('gen-B'));
      const onChange = getOnChange();
      expect(onChange).toBeTruthy();
      onChange?.({ previous: buildIdentity('gen-initial'), current: buildIdentity('gen-B'), reason: 'sse_reconnect_state_refresh' });
      await flushTranscriptCommitMicrotasks();

      expect(sentAgentMessagesOfType(session, 'turn_failed')).toHaveLength(0);
      expect(session.sessionTurnLifecycle.failTurn as any).not.toHaveBeenCalled();
    } finally {
      await runtime.reset().catch(() => {});
    }
  });

  it('does not count orphaned old-generation provider work as live when probing turn liveness (closes F4)', async () => {
    const { client, runtime, getOnChange } = await startGenerationRecoveryTurn();
    try {
      // session-next tool: tracked active but NOT live-known, so the supervisor will not fail the turn.
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.next.tool.started', properties: { sessionID: 'ses_1', callID: 'call_sn' } },
      });
      await flushTranscriptCommitMicrotasks();
      expect((await runtime.probeTurnLiveness()).active).toBe(true);

      // Generation advances; no live-known tools means no proactive failure — the turn stays active.
      (client.sessionMessagesList as any).mockResolvedValue([]);
      client.__setManagedServerIdentity(buildIdentity('gen-B'));
      getOnChange()?.({ previous: buildIdentity('gen-initial'), current: buildIdentity('gen-B'), reason: 'http_retry_ensure' });
      await flushTranscriptCommitMicrotasks();

      // The orphaned session-next work belongs to the replaced generation: not live for the new one.
      expect((await runtime.probeTurnLiveness()).active).toBe(false);
    } finally {
      await runtime.reset().catch(() => {});
    }
  });
});

describe('createOpenCodeServerRuntime origin-agnostic transcript projection (Lane H / S2)', () => {
  async function startSessionWithoutTurn() {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });
    await runtime.startOrLoad({});
    return { client, session, runtime };
  }

  const externalUserMessage = () => ({
    info: { id: 'msg_tui_user', role: 'user', sessionID: 'ses_1', time: { created: 10 } },
    parts: [{ id: 'p_u', type: 'text', text: 'hello from the TUI' }],
  });
  const externalAssistantMessage = () => ({
    info: { id: 'msg_tui_assistant', role: 'assistant', sessionID: 'ses_1', finish: 'stop', time: { created: 11, completed: 12 } },
    parts: [{ id: 'p_a', type: 'text', text: 'reply from OpenCode' }],
  });

  it('mirrors a TUI-originated user message and its assistant response exactly once and never re-enqueues it', async () => {
    const { client, session } = await startSessionWithoutTurn();
    (client.sessionMessagesList as any).mockResolvedValue([externalUserMessage(), externalAssistantMessage()]);

    // A TUI-authored assistant message materializes while no Happier turn is active.
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'message.updated', properties: { info: { id: 'msg_tui_assistant', role: 'assistant', sessionID: 'ses_1', finish: 'stop', time: { completed: 12 } } } },
    });
    await flushTranscriptCommitMicrotasks();
    await flushTranscriptCommitMicrotasks();

    const userCommits = (session.sendUserTextMessageCommitted as any).mock.calls;
    const assistantCommits = (session.sendAgentMessageCommitted as any).mock.calls;
    expect(userCommits).toHaveLength(1);
    expect(userCommits[0]?.[0]).toBe('hello from the TUI');
    expect(userCommits[0]?.[1]?.meta?.source).toBe('cli');
    expect(assistantCommits.some((c: any[]) => c?.[1]?.message === 'reply from OpenCode')).toBe(true);
    // Mirror-only: the imported user message is never sent back to OpenCode as a prompt.
    expect((client.sessionPromptAsync as any).mock.calls.length).toBe(0);

    // Re-emitting the same message must not duplicate (dedupe gate + deterministic import ids).
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'message.updated', properties: { info: { id: 'msg_tui_assistant', role: 'assistant', sessionID: 'ses_1', finish: 'stop', time: { completed: 12 } } } },
    });
    await flushTranscriptCommitMicrotasks();
    await flushTranscriptCommitMicrotasks();
    expect((session.sendUserTextMessageCommitted as any).mock.calls).toHaveLength(1);
  });

  it('keeps TUI-originated history message ids distinct by exact bytes', async () => {
    const { client, session } = await startSessionWithoutTurn();
    (client.sessionMessagesList as any).mockResolvedValue([
      externalUserMessage(),
      {
        info: { id: ' msg_tui_user\n', role: 'user', sessionID: 'ses_1', time: { created: 11 } },
        parts: [{ id: 'p_u_alias', type: 'text', text: 'hello from the exact alias' }],
      },
      externalAssistantMessage(),
    ]);

    await client.__emit({
      directory: '/tmp',
      payload: { type: 'message.updated', properties: { info: { id: 'msg_tui_assistant', role: 'assistant', sessionID: 'ses_1', finish: 'stop', time: { completed: 12 } } } },
    });
    await flushTranscriptCommitMicrotasks();
    await flushTranscriptCommitMicrotasks();

    expect((session.sendUserTextMessageCommitted as any).mock.calls.map((call: any[]) => call[0])).toEqual([
      'hello from the TUI',
      'hello from the exact alias',
    ]);

    await client.__emit({
      directory: '/tmp',
      payload: { type: 'message.updated', properties: { info: { id: 'msg_tui_assistant', role: 'assistant', sessionID: 'ses_1', finish: 'stop', time: { completed: 12 } } } },
    });
    await flushTranscriptCommitMicrotasks();
    await flushTranscriptCommitMicrotasks();

    expect((session.sendUserTextMessageCommitted as any).mock.calls.map((call: any[]) => call[0])).toEqual([
      'hello from the TUI',
      'hello from the exact alias',
    ]);
  });

  it('does not mirror an in-progress (non-terminal) assistant message', async () => {
    const { client, session } = await startSessionWithoutTurn();
    (client.sessionMessagesList as any).mockResolvedValue([
      externalUserMessage(),
      // Assistant has no completed time -> not settled.
      { info: { id: 'msg_partial', role: 'assistant', sessionID: 'ses_1' }, parts: [{ id: 'p', type: 'text', text: 'partial...' }] },
    ]);

    await client.__emit({
      directory: '/tmp',
      payload: { type: 'message.updated', properties: { info: { id: 'msg_tui_user', role: 'user', sessionID: 'ses_1' } } },
    });
    await flushTranscriptCommitMicrotasks();
    await flushTranscriptCommitMicrotasks();

    expect((session.sendUserTextMessageCommitted as any).mock.calls).toHaveLength(1);
    const assistantCommits = (session.sendAgentMessageCommitted as any).mock.calls;
    expect(assistantCommits.some((c: any[]) => typeof c?.[1]?.message === 'string' && String(c[1].message).includes('partial'))).toBe(false);
  });
});

describe('createOpenCodeServerRuntime — connected-service broker preflight (fail-closed)', () => {
  async function writeUsableDaemonState(path: string): Promise<void> {
    await writeFile(path, JSON.stringify({
      httpPort: 1234,
      connectedServiceBrokerRefreshToken: 'broker-refresh-token',
    }), 'utf8');
  }

  function buildConnectedEnv(overrides: Readonly<{
    brokered?: boolean;
    daemonStatePath?: string;
    brokerLoadNonce?: string;
  }>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|openai-codex:primary:',
    };
    // Always control the broker inputs explicitly so the verdict is deterministic regardless of
    // the ambient process env.
    delete env[OPEN_CODE_BROKER_SELECTIONS_ENV];
    delete env[OPEN_CODE_BROKER_STATE_PATH_ENV];
    delete env[OPEN_CODE_BROKER_LOAD_NONCE_ENV];
    if (overrides.brokered) {
      env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections({
        openai: { serviceId: 'openai-codex', profileId: 'primary', accountId: null, planType: null },
      });
    }
    if (typeof overrides.daemonStatePath === 'string') {
      env[OPEN_CODE_BROKER_STATE_PATH_ENV] = overrides.daemonStatePath;
    }
    if (typeof overrides.brokerLoadNonce === 'string') {
      env[OPEN_CODE_BROKER_LOAD_NONCE_ENV] = overrides.brokerLoadNonce;
    }
    return env;
  }

  function startConnectedRuntime(
    env: NodeJS.ProcessEnv,
    opts: Readonly<{ emitServerConnectedOnSubscribe?: boolean }> = {},
  ) {
    const client = createFakeClient(opts);
    const session = mirrorLifecycleMarkersForTest(createFakeSession());
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      env,
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as unknown as OpenCodeServerRuntimeClient,
    });
    return { client, session, runtime };
  }

  it('reuses the actual managed-server generation nonce for a second connected session preflight', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-opencode-runtime-broker-reuse-home-'));
    const daemonStatePath = join(home, 'daemon.state.json');
    const managedStatePath = join(home, 'opencode', 'managed-server-reuse-test.json');
    const brokerSelections = serializeOpenCodeBrokerSelections({
      openai: { serviceId: 'openai-codex', profileId: 'primary', accountId: null, planType: null },
    });
    const restoreHome = withEnvForTest({
      HAPPIER_HOME_DIR: home,
      HAPPIER_OPENCODE_SERVER_STATE_PATH: managedStatePath,
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|openai-codex:primary:',
      [OPEN_CODE_BROKER_SELECTIONS_ENV]: brokerSelections,
      [OPEN_CODE_BROKER_STATE_PATH_ENV]: daemonStatePath,
      [OPEN_CODE_BROKER_LOAD_NONCE_ENV]: undefined,
    });
    reloadConfiguration();
    await writeUsableDaemonState(daemonStatePath);
    await ensureOpenCodeBrokerPluginAssets({ providers: ['openai'], happyHomeDir: configuration.happyHomeDir });

    const actualSpawnNonce = 'managed-generation-nonce';
    let managedState: SharedManagedOpenCodeServerState | null = null;
    const startServer = vi.fn(async (params?: {
      onSpawned?: (started: Readonly<{
        baseUrl: string;
        pid: number;
        brokerLoadNonce?: string;
      }>) => void | Promise<void>;
    }) => {
      const started = {
        baseUrl: 'http://127.0.0.1:7777',
        pid: 4242,
        brokerLoadNonce: actualSpawnNonce,
      } as const;
      await params?.onSpawned?.(started);
      return started;
    });
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => managedState),
      writeState: vi.fn(async (state: SharedManagedOpenCodeServerState) => {
        managedState = state;
      }),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => true),
      startServer,
      currentLaunchFingerprint: 'connected-openai-primary',
      nowMs: () => 5,
    };

    try {
      const first = await resolveSharedManagedOpenCodeServerBaseUrl(deps);
      expect(first).toEqual({
        baseUrl: 'http://127.0.0.1:7777',
        didStart: true,
        brokerLoadNonce: actualSpawnNonce,
      });
      expect(managedState).toEqual(expect.objectContaining({ brokerLoadNonce: actualSpawnNonce }));

      const second = await resolveSharedManagedOpenCodeServerBaseUrl(deps);
      expect(second).toEqual({
        baseUrl: 'http://127.0.0.1:7777',
        didStart: false,
        brokerLoadNonce: actualSpawnNonce,
      });
      expect(startServer).toHaveBeenCalledTimes(1);

      const launchEnvFingerprint = resolveOpenCodeManagedServerLaunchFingerprint({
        baseEnv: process.env,
        xdgRootDir: null,
        isolateConfig: false,
      });
      const persistedManagedState = deps.writeState.mock.calls.at(-1)?.[0];
      if (!persistedManagedState) throw new Error('Expected the first managed OpenCode spawn to persist state');
      await writeFile(managedStatePath, JSON.stringify({
        ...persistedManagedState,
        pid: process.pid,
        startedAtMs: Date.now(),
        launchEnvFingerprint,
      }), 'utf8');
      const healthFetch = vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url === 'http://127.0.0.1:7777/global/health') {
          return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected OpenCode client request in broker reuse test: ${url}`);
      });
      vi.stubGlobal('fetch', healthFetch as unknown as typeof fetch);
      const env = buildConnectedEnv({ brokered: true, daemonStatePath });
      const productionClient = await createOpenCodeServerRuntimeClient({
        directory: '/tmp',
        env,
        messageBuffer: new MessageBuffer(),
      });
      await productionClient.dispose();
      expect(env[OPEN_CODE_BROKER_LOAD_NONCE_ENV]).toBe(actualSpawnNonce);

      mockQueryDaemonOpenCodeBrokerLoadHandshake.mockImplementation(
        async (_selectionIdentity: string, loadNonce: string) => loadNonce === actualSpawnNonce,
      );
      const { client, runtime } = startConnectedRuntime(env);

      await runtime.startOrLoad({});
      runtime.beginTurn();
      const promptPromise = (runtime as unknown as {
        sendPromptWithMeta: (params: { text: string; localId: string }) => Promise<void>;
      }).sendPromptWithMeta({ text: 'hello reused broker', localId: 'local-broker-reused-generation' });
      void promptPromise.catch(() => undefined);

      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
      expect(mockQueryDaemonOpenCodeBrokerLoadHandshake).toHaveBeenCalledWith(
        'opencode|connected|openai-codex:primary:',
        actualSpawnNonce,
        ['openai'],
        '1',
        'opencode_managed_server',
      );

      await runtime.cancel().catch(() => {});
      await promptPromise.catch(() => undefined);
      await runtime.reset().catch(() => {});
    } finally {
      mockQueryDaemonOpenCodeBrokerLoadHandshake.mockReset();
      vi.unstubAllGlobals();
      restoreHome();
      reloadConfiguration();
    }
  });

  it('waits for server.connected before evaluating connected broker readiness for the first prompt', async () => {
    const env = buildConnectedEnv({ brokered: true });
    const { client, session, runtime } = startConnectedRuntime(env, { emitServerConnectedOnSubscribe: false });

    await runtime.startOrLoad({});
    runtime.beginTurn();
    const promptPromise = (runtime as unknown as {
      sendPromptWithMeta: (params: { text: string; localId: string }) => Promise<void>;
    }).sendPromptWithMeta({ text: 'hello', localId: 'local-broker-preflight-after-connected' });
    void promptPromise.catch(() => undefined);
    const outcome = observePromiseSettlement(promptPromise);

    await flushTranscriptCommitMicrotasks();

    expect(client.sessionPromptAsync).not.toHaveBeenCalled();
    expect(outcome.status).toBe('pending');
    expect(session.sessionTurnLifecycle.failTurn).not.toHaveBeenCalled();
    expect(sentAgentMessagesOfType(session, 'turn_failed')).toHaveLength(0);

    await client.__emit({
      directory: '/tmp',
      payload: { type: 'server.connected', properties: {} },
    });

    await expect(promptPromise).rejects.toThrow();
    expect(client.sessionPromptAsync).not.toHaveBeenCalled();
    expect(session.sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode',
      issue: expect.objectContaining({
        code: OPENCODE_CONNECTED_AUTH_NOT_MATERIALIZED_CODE,
      }),
    }));
  });

  it('does not forward a prompt when the turn is cancelled while broker preflight is pending', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-opencode-runtime-broker-home-'));
    const restoreHome = withEnvForTest({ HAPPIER_HOME_DIR: home });
    reloadConfiguration();
    const daemonStatePath = join(home, 'daemon.state.json');
    await writeUsableDaemonState(daemonStatePath);
    await ensureOpenCodeBrokerPluginAssets({ providers: ['openai'], happyHomeDir: configuration.happyHomeDir });

    let resolveHandshake!: (ready: boolean) => void;
    mockQueryDaemonOpenCodeBrokerLoadHandshake.mockImplementation(
      () => new Promise<boolean>((resolve) => {
        resolveHandshake = resolve;
      }),
    );

    const env = buildConnectedEnv({
      brokered: true,
      daemonStatePath,
      brokerLoadNonce: 'managed-generation-nonce',
    });
    const { client, runtime } = startConnectedRuntime(env);

    try {
      await runtime.startOrLoad({});
      runtime.beginTurn();
      const promptPromise = (runtime as unknown as {
        sendPromptWithMeta: (params: { text: string; localId: string }) => Promise<void>;
      }).sendPromptWithMeta({ text: 'hello while broker readiness is pending', localId: 'local-broker-preflight-cancelled' });
      void promptPromise.catch(() => undefined);
      const outcome = observePromiseSettlement(promptPromise);

      await expect.poll(() => mockQueryDaemonOpenCodeBrokerLoadHandshake.mock.calls.length).toBe(1);
      expect(outcome.status).toBe('pending');
      expect(client.sessionPromptAsync).not.toHaveBeenCalled();

      await runtime.cancel();
      resolveHandshake(true);
      await flushTranscriptCommitMicrotasks();

      await expect.poll(() => outcome.status).toBe('rejected');
      expect(client.sessionPromptAsync).not.toHaveBeenCalled();
    } finally {
      mockQueryDaemonOpenCodeBrokerLoadHandshake.mockReset();
      await runtime.reset().catch(() => {});
      restoreHome();
      reloadConfiguration();
    }
  });

  it('fails the turn closed for a connected brokered session when the broker is not ready, never forwarding the prompt to OpenCode', async () => {
    // Brokered provider present but no daemon-state bridge path => preflight is not ready.
    const env = buildConnectedEnv({ brokered: true });
    const { client, session, runtime } = startConnectedRuntime(env);

    await runtime.startOrLoad({});
    runtime.beginTurn();
    const promptPromise = (runtime as unknown as {
      sendPromptWithMeta: (params: { text: string; localId: string }) => Promise<void>;
    }).sendPromptWithMeta({ text: 'hello', localId: 'local-broker-preflight-not-ready' });

    const promptError = await promptPromise.then(
      () => null,
      (error: unknown) => error,
    );
    expect(promptError).toBeInstanceOf(ProviderPromptSubmissionRejectedBeforeEffectError);
    expect(promptError).toMatchObject({
      reason: 'provider_unavailable_before_acceptance',
    });

    // Fail-closed: the prompt must NEVER be forwarded to OpenCode (no native/upstream fallback).
    expect(client.sessionPromptAsync).not.toHaveBeenCalled();

    // The turn is failed with the canonical auth-materialization issue code.
    expect(session.sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode',
      issue: expect.objectContaining({
        code: OPENCODE_CONNECTED_AUTH_NOT_MATERIALIZED_CODE,
        status: 'failed',
        scope: 'primary_session',
      }),
    }));
    const failedMarkers = sentAgentMessagesOfType(session, 'turn_failed');
    expect(failedMarkers.length).toBe(1);
    expect((failedMarkers[0] as { code?: string }).code).toBe(OPENCODE_CONNECTED_AUTH_NOT_MATERIALIZED_CODE);
    expect(sentAgentMessagesOfType(session, 'task_complete')).toHaveLength(0);

    await runtime.reset().catch(() => {});
  });

  it('does not run the broker preflight for a native session (proceeds to send the prompt)', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
    const { client, runtime } = startConnectedRuntime(env);

    await runtime.startOrLoad({});
    runtime.beginTurn();
    const promptPromise = (runtime as unknown as {
      sendPromptWithMeta: (params: { text: string; localId: string }) => Promise<void>;
    }).sendPromptWithMeta({ text: 'hello', localId: 'local-broker-preflight-native' });
    void promptPromise.catch(() => undefined);

    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    await runtime.cancel().catch(() => {});
    await promptPromise.catch(() => undefined);
    await runtime.reset().catch(() => {});
  });

  it('treats a connected direct-API-key session (no brokered provider) as ready and proceeds', async () => {
    const env = buildConnectedEnv({ brokered: false });
    const { client, runtime } = startConnectedRuntime(env);

    await runtime.startOrLoad({});
    runtime.beginTurn();
    const promptPromise = (runtime as unknown as {
      sendPromptWithMeta: (params: { text: string; localId: string }) => Promise<void>;
    }).sendPromptWithMeta({ text: 'hello', localId: 'local-broker-preflight-direct-key' });
    void promptPromise.catch(() => undefined);

    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    await runtime.cancel().catch(() => {});
    await promptPromise.catch(() => undefined);
    await runtime.reset().catch(() => {});
  });

  it('rechecks connected broker readiness after runtime reset instead of reusing a previous ready verdict', async () => {
    const env = buildConnectedEnv({ brokered: false });
    const firstClient = createFakeClient();
    const secondClient = createFakeClient();
    const clients = [firstClient, secondClient];
    const session = mirrorLifecycleMarkersForTest(createFakeSession());
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      env,
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createFakePermissionHandler() as unknown as ProviderEnforcedPermissionHandler,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => {
        const next = clients.shift();
        if (!next) throw new Error('No fake OpenCode client available');
        return next as unknown as OpenCodeServerRuntimeClient;
      },
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();
    const firstPrompt = (runtime as unknown as {
      sendPromptWithMeta: (params: { text: string; localId: string }) => Promise<void>;
    }).sendPromptWithMeta({ text: 'hello direct key', localId: 'local-direct-key-before-reset' });
    void firstPrompt.catch(() => undefined);

    await expect.poll(() => firstClient.sessionPromptAsync.mock.calls.length).toBe(1);
    await runtime.cancel().catch(() => {});
    await firstPrompt.catch(() => undefined);
    await runtime.reset().catch(() => {});

    env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections({
      openai: { serviceId: 'openai-codex', profileId: 'primary', accountId: null, planType: null },
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();
    const secondPrompt = (runtime as unknown as {
      sendPromptWithMeta: (params: { text: string; localId: string }) => Promise<void>;
    }).sendPromptWithMeta({ text: 'hello brokered', localId: 'local-brokered-after-reset' });

    await expect(secondPrompt).rejects.toThrow();
    expect(secondClient.sessionPromptAsync).not.toHaveBeenCalled();
    expect(session.sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode',
      issue: expect.objectContaining({
        code: OPENCODE_CONNECTED_AUTH_NOT_MATERIALIZED_CODE,
      }),
    }));

    await runtime.reset().catch(() => {});
  });
});
