import type { PluginContextV1, RuntimeEventV1 } from '@happier-dev/plugin-sdk';
import { createPluginContextV1Fixture } from '@happier-dev/plugin-sdk/experimental/testing/adapterHarness';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

const clientState = vi.hoisted(() => {
  const handlers = new Map<string, (params: unknown) => void | Promise<void>>();
  const requestHandlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  const requests: Array<{ method: string; params: unknown }> = [];
  let turnStartCount = 0;
  let failNextSteer = false;
  let rejectNextTurnStart: Error | null = null;
  let delayedTurnStartPrompt: string | null = null;
  let delayedTurnStart: {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
  } | null = null;
  let deferNextSteer = false;
  let delayedSteer: {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
  } | null = null;
  let rateLimitsSnapshot: unknown = {
    rateLimits: {
      primary: { used_percent: 31, resets_at: 1779019200000 },
    },
    plan_type: 'pro',
  };
  let accountReadResult: unknown = { account: null };

  const createDeferred = (): {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
  } => {
    let resolve!: (value: unknown) => void;
    const promise = new Promise<unknown>((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  };

  const readPromptText = (params: unknown): string | null => {
    const record = params && typeof params === 'object' && !Array.isArray(params)
      ? params as Readonly<Record<string, unknown>>
      : null;
    const input = Array.isArray(record?.input) ? record.input : [];
    for (const item of input) {
      const itemRecord = item && typeof item === 'object' && !Array.isArray(item)
        ? item as Readonly<Record<string, unknown>>
        : null;
      if (typeof itemRecord?.text === 'string') return itemRecord.text;
    }
    return null;
  };

  return {
    handlers,
    requestHandlers,
    requests,
    reset() {
      handlers.clear();
      requestHandlers.clear();
      requests.length = 0;
      turnStartCount = 0;
      failNextSteer = false;
      rejectNextTurnStart = null;
      delayedTurnStartPrompt = null;
      delayedTurnStart = null;
      deferNextSteer = false;
      delayedSteer = null;
      rateLimitsSnapshot = {
        rateLimits: {
          primary: { used_percent: 31, resets_at: 1779019200000 },
        },
        plan_type: 'pro',
      };
      accountReadResult = { account: null };
    },
    failNextSteer() {
      failNextSteer = true;
    },
    rejectNextTurnStart(message: string) {
      rejectNextTurnStart = new Error(message);
    },
    deferTurnStartForPrompt(prompt: string) {
      delayedTurnStartPrompt = prompt;
    },
    resolveDeferredTurnStart(turnId: string) {
      if (!delayedTurnStart) throw new Error('No deferred turn/start request is pending');
      delayedTurnStart.resolve({ turnId });
      delayedTurnStart = null;
      delayedTurnStartPrompt = null;
    },
    deferNextSteer() {
      deferNextSteer = true;
    },
    resolveDeferredSteer() {
      if (!delayedSteer) throw new Error('No deferred turn/steer request is pending');
      delayedSteer.resolve({});
      delayedSteer = null;
    },
    setRateLimitsSnapshot(value: unknown) {
      rateLimitsSnapshot = value;
    },
    setAccountReadResult(value: unknown) {
      accountReadResult = value;
    },
    async request(method: string, params?: unknown): Promise<unknown> {
      requests.push({ method, params });
      if (method === 'account/rateLimits/read') {
        return rateLimitsSnapshot;
      }
      if (method === 'account/read') {
        return accountReadResult;
      }
      if (method === 'account/login/start') {
        return { ok: true };
      }
      if (method === 'thread/start') {
        return { threadId: 'thread-1' };
      }
      if (method === 'thread/resume') {
        const record = params && typeof params === 'object'
          ? params as Readonly<Record<string, unknown>>
          : {};
        return { threadId: record.threadId ?? 'thread-resumed' };
      }
      if (method === 'thread/name/set') {
        return {};
      }
      if (method === 'thread/rollback') {
        return {};
      }
      if (method === 'turn/start') {
        if (rejectNextTurnStart) {
          const error = rejectNextTurnStart;
          rejectNextTurnStart = null;
          throw error;
        }
        turnStartCount += 1;
        if (readPromptText(params) === delayedTurnStartPrompt) {
          delayedTurnStart = createDeferred();
          return await delayedTurnStart.promise;
        }
        return { turnId: `turn-${turnStartCount}` };
      }
      if (method === 'turn/steer') {
        if (failNextSteer) {
          failNextSteer = false;
          throw new Error('Codex app-server steer failed');
        }
        if (deferNextSteer) {
          deferNextSteer = false;
          delayedSteer = createDeferred();
          return await delayedSteer.promise;
        }
        return {};
      }
      if (method === 'turn/interrupt') {
        return {};
      }
      throw new Error(`Unexpected Codex app-server request: ${method}`);
    },
    async notify(): Promise<void> {
      return undefined;
    },
    async invokeRequestHandler(method: string, params?: unknown): Promise<unknown> {
      const handler = requestHandlers.get(method);
      if (!handler) throw new Error(`Missing request handler for ${method}`);
      return await handler(params);
    },
    registerRequestHandler(method: string, handler: (params: unknown) => unknown | Promise<unknown>): () => void {
      requestHandlers.set(method, handler);
      return () => {
        requestHandlers.delete(method);
      };
    },
    registerNotificationHandler(method: string, handler: (params: unknown) => void | Promise<void>): () => void {
      handlers.set(method, handler);
      return () => {
        handlers.delete(method);
      };
    },
  };
});

vi.mock('./client.js', () => ({
  createCodexAppServerClient: vi.fn(async () => ({
    request: clientState.request,
    notify: clientState.notify,
    registerRequestHandler: clientState.registerRequestHandler,
    registerNotificationHandler: clientState.registerNotificationHandler,
    dispose: vi.fn(async () => undefined),
  })),
  isCodexAppServerOversizedJsonFrameError: vi.fn(() => false),
  resolveCodexHome: (env: Readonly<Record<string, string | undefined>>) => env.CODEX_HOME ?? '/home/test/.codex',
}));

import {
  createCodexAppServerRuntime,
  startCodexAppServerRuntime,
  waitForCodexAppServerRuntimeTurnCompletion,
} from './runtime.js';
import { createCodexAppServerSessionRuntime } from './session.js';

const providerBindingMaterialization = {
  v: 1,
  kind: 'engineConfig',
  engineConfig: {
    v: 1,
    modelProvider: 'happier_0123456789abcdef0123456789abcdef',
    config: {
      'model_providers.happier_0123456789abcdef0123456789abcdef': {
        name: 'Happier provider',
        base_url: 'https://provider.example/v1',
        wire_api: 'responses',
        env_key: 'HAPPIER_CODEX_PROVIDER_API_KEY',
        requires_openai_auth: false,
        supports_websockets: false,
      },
    },
  },
} as const;

function createRuntime(overrides: Readonly<{
  ctx?: Partial<PluginContextV1>;
  accountUsage?: PluginContextV1['agentRuntime']['accountUsage'];
  happierSessionId?: string;
  processEnv?: Readonly<Record<string, string | undefined>>;
  initialModelId?: string;
}> = {}) {
  const fixtureContext = createPluginContextV1Fixture({
    sessionId: overrides.happierSessionId ?? 'session-1',
  }).ctx;
  return createCodexAppServerRuntime({
    ctx: {
      ...fixtureContext,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      ...(overrides.ctx ?? {}),
      agentRuntime: {
        ...fixtureContext.agentRuntime,
        ...(overrides.ctx?.agentRuntime ?? {}),
        accountUsage: overrides.accountUsage
          ?? overrides.ctx?.agentRuntime?.accountUsage
          ?? fixtureContext.agentRuntime.accountUsage,
      },
    },
    directory: '/workspace',
    happierSessionId: overrides.happierSessionId ?? 'session-1',
    processEnv: overrides.processEnv,
    initialModelId: overrides.initialModelId,
  });
}

function buildJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

function emitNotification(method: string, params: unknown): void {
  const handler = clientState.handlers.get(method);
  if (!handler) throw new Error(`Missing notification handler for ${method}`);
  void handler(params);
}

function buildConnectedCodexCredential(profileId = 'target') {
  return buildConnectedServiceCredentialRecord({
    now: 1000,
    serviceId: 'openai-codex',
    profileId,
    kind: 'oauth',
    expiresAt: 2000,
    oauth: {
      accessToken: 'target-access',
      refreshToken: 'target-refresh',
      idToken: 'target-id',
      scope: null,
      tokenType: null,
      providerAccountId: 'acct_target',
      providerEmail: 'target@example.test',
    },
  });
}

function asConnectedServiceAuthRuntime(runtime: ReturnType<typeof createRuntime>) {
  return runtime as typeof runtime & Readonly<{
    applyConnectedServiceAuthGeneration(request: unknown): Promise<unknown>;
    readConnectedServiceRuntimeIdentity(request: unknown): Promise<unknown>;
  }>;
}

function asConversationRollbackRuntime(runtime: ReturnType<typeof createRuntime>) {
  return runtime as typeof runtime & Readonly<{
    rollbackConversation(request: Readonly<{
      v: 1;
      target?: Readonly<{ type: 'latest_turn' } | { type: 'before_user_message'; userMessageSeq: number }>;
    }>): Promise<unknown>;
  }>;
}

function failedCapacityTurn(turnId: string, message: string): unknown {
  return {
    threadId: 'thread-1',
    turnId,
    status: 'failed',
    turn: {
      id: turnId,
      status: 'failed',
      error: {
        message,
        codex_error_info: 'other',
      },
    },
  };
}

function completedTurn(turnId: string): unknown {
  return {
    threadId: 'thread-1',
    turnId,
    status: 'completed',
    turn: {
      id: turnId,
      status: 'completed',
    },
  };
}

function failedUsageLimitTurn(turnId: string): unknown {
  return {
    threadId: 'thread-1',
    turnId,
    status: 'failed',
    turn: {
      id: turnId,
      status: 'failed',
      error: {
        message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 8:41 PM.",
        codex_error_info: 'usage_limit_reached',
        resets_at: 1779019200000,
        rate_limits: {
          primary: { used_percent: 100, resets_at: 1779019200000 },
        },
      },
    },
  };
}

async function waitForTurnStartCount(expectedCount: number): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    const count = clientState.requests.filter((request) => request.method === 'turn/start').length;
    if (count >= expectedCount) return;
    await Promise.resolve();
  }
  throw new Error(`Expected ${expectedCount} turn/start requests`);
}

async function waitForRequestCount(method: string, expectedCount: number): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    const count = clientState.requests.filter((request) => request.method === method).length;
    if (count >= expectedCount) return;
    await Promise.resolve();
  }
  throw new Error(`Expected ${expectedCount} ${method} requests`);
}

async function waitForUsageRecordCount(records: unknown[], expectedCount: number): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (records.length >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${expectedCount} provider-account usage records`);
}

async function waitForUsageRecordMatching(
  records: unknown[],
  predicate: (record: unknown) => boolean,
): Promise<unknown> {
  for (let index = 0; index < 20; index += 1) {
    const record = records.find(predicate);
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected matching provider-account usage record');
}

function createAccountUsageService(
  overrides: Partial<PluginContextV1['agentRuntime']['accountUsage']>,
): PluginContextV1['agentRuntime']['accountUsage'] {
  return {
    resolveSourceContext: async () => null,
    recordSnapshot: async () => ({ status: 'recorded', recordId: 'paug_v1_test' }),
    adoptProvisionalRecord: async () => ({
      status: 'adopted',
      fromRecordId: 'paug_v1_from',
      toRecordId: 'paug_v1_to',
    }),
    ...overrides,
  };
}

describe('Codex app-server temporary recoverable turn failures', () => {
  beforeEach(() => {
    clientState.reset();
  });

  it('publishes app-server token usage through the canonical transcript seam', async () => {
    const fixture = createPluginContextV1Fixture({ sessionId: 'session-1' });
    const runtime = createRuntime({ ctx: fixture.ctx, initialModelId: 'gpt-5.4' });
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => events.push(event));
    await runtime.send({ v: 1, text: 'usage prompt' }, { turnId: 'codex-turn-1' });

    emitNotification('thread/tokenUsage/updated', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        total: { totalTokens: 20019, inputTokens: 20001, cachedInputTokens: 4480, outputTokens: 18, reasoningOutputTokens: 10 },
        last: { totalTokens: 319, inputTokens: 301, cachedInputTokens: 80, outputTokens: 18, reasoningOutputTokens: 10 },
        modelContextWindow: 258400,
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'transcript-agent-message-committed',
      localId: 'codex:thread-1:turn-1',
      body: expect.objectContaining({
        type: 'token_count',
        id: 'codex:thread-1:turn-1',
        modelId: 'gpt-5.4',
        scope: 'session_cumulative',
        totalTokens: 20019,
        context_used_tokens: 319,
        context_window_tokens: 258400,
      }),
    }));
  });

  it('publishes a typed failed-turn issue when an accepted provider turn fails before assistant text', async () => {
    const runtime = createRuntime();
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    await runtime.send({ v: 1, text: 'provider failure prompt' }, { turnId: 'codex-turn-1' });
    emitNotification(
      'turn/completed',
      failedCapacityTurn('turn-1', 'Provider rejected the accepted turn before assistant text.'),
    );

    await expect(waitForCodexAppServerRuntimeTurnCompletion(runtime)).rejects.toThrow('Provider rejected');

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-failed',
      sessionId: 'session-1',
      turnId: 'codex-turn-1',
      agentTurnId: 'turn-1',
      issue: expect.objectContaining({
        code: 'codex_app_server_turn_failed',
        agentId: 'codex',
        agentTurnId: 'turn-1',
        sanitizedPreview: expect.stringContaining('Provider rejected'),
        source: 'agent_session_error',
      }),
    }));
  });

  it('logs sanitized app-server completion failure diagnostics with usage-limit classification', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const runtime = createRuntime({ ctx: { logger } });

    await runtime.send({ v: 1, text: 'quota failure prompt' }, { turnId: 'codex-turn-1' });
    emitNotification('turn/completed', failedUsageLimitTurn('turn-1'));

    await expect(waitForCodexAppServerRuntimeTurnCompletion(runtime)).rejects.toThrow('usage limit');
    await Promise.resolve();

    expect(logger.debug).toHaveBeenCalledWith(
      'Codex app-server background turn completion failed',
      expect.objectContaining({
        errorName: 'CodexAppServerTurnFailure',
        errorMessage: expect.stringContaining("You've hit your usage limit"),
        runtimeIssueSource: 'usage_limit',
        runtimeAuthKind: 'usage_limit',
        runtimeAuthSource: 'structured_provider_error',
        runtimeAuthLimitCategory: 'usage_limit',
      }),
    );
  });

  it('uses a fresh session turn id for each runtime instance when the host does not provide one', async () => {
    const firstRuntime = createRuntime({ happierSessionId: 'session-1' });
    const firstEvents: RuntimeEventV1[] = [];
    firstRuntime.events.subscribe((event) => {
      firstEvents.push(event);
    });

    await firstRuntime.send({ v: 1, text: 'first quota failure prompt' });
    emitNotification('turn/completed', failedUsageLimitTurn('turn-1'));
    await expect(waitForCodexAppServerRuntimeTurnCompletion(firstRuntime)).rejects.toThrow('usage limit');

    const secondRuntime = createRuntime({ happierSessionId: 'session-1' });
    const secondEvents: RuntimeEventV1[] = [];
    secondRuntime.events.subscribe((event) => {
      secondEvents.push(event);
    });

    await secondRuntime.send({ v: 1, text: 'second quota failure prompt' });
    emitNotification('turn/completed', failedUsageLimitTurn('turn-2'));
    await expect(waitForCodexAppServerRuntimeTurnCompletion(secondRuntime)).rejects.toThrow('usage limit');

    const firstFailedTurn = firstEvents.find((event) => event.kind === 'turn-failed');
    const secondFailedTurn = secondEvents.find((event) => event.kind === 'turn-failed');
    expect(firstFailedTurn).toMatchObject({
      kind: 'turn-failed',
      sessionId: 'session-1',
      agentTurnId: 'turn-1',
    });
    expect(secondFailedTurn).toMatchObject({
      kind: 'turn-failed',
      sessionId: 'session-1',
      agentTurnId: 'turn-2',
    });
    expect(firstFailedTurn?.turnId).toMatch(/^codex-turn-/);
    expect(secondFailedTurn?.turnId).toMatch(/^codex-turn-/);
    expect(secondFailedTurn?.turnId).not.toBe(firstFailedTurn?.turnId);
  });

  it('commits a late final assistant item before completing the turn', async () => {
    const runtime = createRuntime({
      processEnv: { HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS: '10' },
    });
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    await runtime.send({ v: 1, text: 'late final prompt' });
    const completion = waitForCodexAppServerRuntimeTurnCompletion(runtime);
    emitNotification('turn/completed', completedTurn('turn-1'));
    emitNotification('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'item-late-final',
        type: 'message',
        role: 'assistant',
        text: 'Late final answer',
      },
    });

    await completion;

    const assistantCommitIndex = events.findIndex((event) => (
      event.kind === 'transcript-agent-message-committed'
      && event.agentId === 'codex'
      && event.body
      && typeof event.body === 'object'
      && !Array.isArray(event.body)
      && (event.body as Readonly<{ message?: unknown }>).message === 'Late final answer'
    ));
    const turnCompleteIndex = events.findIndex((event) => event.kind === 'turn-complete');
    expect(assistantCommitIndex).toBeGreaterThanOrEqual(0);
    expect(turnCompleteIndex).toBeGreaterThan(assistantCommitIndex);
  });

  it.each([
    ['turn-started first', false],
    ['assistant stream first', true],
  ])(
    'hands off a terminal-settling turn to an immediate provider-started successor (%s)',
    async (_notificationOrder, streamBeforeTurnStarted) => {
      const runtime = createRuntime({
        processEnv: { HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS: '25' },
      });
      const events: RuntimeEventV1[] = [];
      runtime.events.subscribe((event) => {
        events.push(event);
      });

      await runtime.send(
        { v: 1, text: 'initial goal turn' },
        { turnId: 'session-turn-initial' },
      );
      const initialCompletion = waitForCodexAppServerRuntimeTurnCompletion(runtime);
      emitNotification('turn/completed', completedTurn('turn-1'));

      const emitSuccessorAssistantDelta = () => {
        emitNotification('item/agentMessage/delta', {
          threadId: 'thread-1',
          turnId: 'turn-native-goal-successor',
          itemId: 'item-native-goal-successor',
          delta: 'Native goal continuation',
        });
      };
      if (streamBeforeTurnStarted) emitSuccessorAssistantDelta();
      emitNotification('turn/started', {
        threadId: 'thread-1',
        turnId: 'turn-native-goal-successor',
      });
      if (!streamBeforeTurnStarted) emitSuccessorAssistantDelta();
      emitNotification('turn/completed', completedTurn('turn-native-goal-successor'));

      await initialCompletion;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (events.filter((event) => event.kind === 'turn-complete').length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const turnStarts = events.filter((event) => event.kind === 'turn-start');
      const turnCompletions = events.filter((event) => event.kind === 'turn-complete');
      expect(turnStarts).toHaveLength(2);
      expect(turnStarts[0]).toMatchObject({
        kind: 'turn-start',
        turnId: 'session-turn-initial',
        startedBy: 'user',
      });
      expect(turnStarts[1]).toMatchObject({
        kind: 'turn-start',
        agentTurnId: 'turn-native-goal-successor',
        startedBy: 'provider',
      });
      expect(turnCompletions).toHaveLength(2);
      expect(turnCompletions[0]).toMatchObject({
        kind: 'turn-complete',
        turnId: 'session-turn-initial',
        agentTurnId: 'turn-1',
      });
      expect(turnCompletions[1]).toMatchObject({
        kind: 'turn-complete',
        turnId: turnStarts[1]?.turnId,
        agentTurnId: 'turn-native-goal-successor',
      });
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        body: { type: 'message', message: 'Native goal continuation' },
      }));
      expect(runtime.isTurnInFlight()).toBe(false);
    },
  );

  it('adopts same-thread stream activity when a native turn starts after the predecessor settled', async () => {
    const runtime = createRuntime({
      processEnv: { HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS: '0' },
    });
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    await runtime.send(
      { v: 1, text: 'turn before delayed native continuation' },
      { turnId: 'session-turn-initial' },
    );
    const initialCompletion = waitForCodexAppServerRuntimeTurnCompletion(runtime);
    emitNotification('turn/completed', completedTurn('turn-1'));
    await initialCompletion;
    expect(runtime.isTurnInFlight()).toBe(false);

    emitNotification('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-native-stream-first-after-settle',
      itemId: 'item-native-stream-first-after-settle',
      delta: 'Stream arrived before native turn start',
    });
    emitNotification('turn/started', {
      threadId: 'thread-1',
      turnId: 'turn-native-stream-first-after-settle',
    });
    emitNotification('turn/completed', completedTurn('turn-native-stream-first-after-settle'));

    expect(events.filter((event) => event.kind === 'turn-start')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'turn-start')[1]).toMatchObject({
      kind: 'turn-start',
      agentTurnId: 'turn-native-stream-first-after-settle',
      startedBy: 'provider',
    });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'transcript-agent-message-committed',
      body: { type: 'message', message: 'Stream arrived before native turn start' },
    }));
    expect(events.filter((event) => event.kind === 'turn-complete')).toHaveLength(2);
    expect(runtime.isTurnInFlight()).toBe(false);
  });

  it('publishes raw app-server function-call items as canonical runtime tool events', async () => {
    const runtime = createRuntime();
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    await runtime.send({ v: 1, text: 'inspect with tools' }, { turnId: 'codex-turn-1' });
    emitNotification('rawResponseItem/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'item-function-call-1',
        type: 'function_call',
        call_id: 'call-1',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}',
      },
    });
    emitNotification('rawResponseItem/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'item-function-result-1',
        type: 'function_call_output',
        call_id: 'call-1',
        output: '{"stdout":"/workspace\\n","exit_code":0}',
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'tool-call',
      sessionId: 'session-1',
      turnId: 'codex-turn-1',
      toolCallId: 'call-1',
      toolName: 'Bash',
      toolInput: expect.objectContaining({ cmd: 'pwd' }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'tool-result',
      sessionId: 'session-1',
      turnId: 'codex-turn-1',
      toolCallId: 'call-1',
      output: { stdout: '/workspace\n', exit_code: 0 },
    }));
  });

  it('publishes raw response items whose provider turn id is carried in Codex metadata passthrough', async () => {
    const runtime = createRuntime();
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    await runtime.send({ v: 1, text: 'inspect with rollout-shaped tools' }, { turnId: 'codex-turn-1' });
    emitNotification('rawResponseItem/completed', {
      item: {
        id: 'item-function-call-1',
        type: 'function_call',
        call_id: 'call-1',
        name: 'js',
        namespace: 'mcp__node_repl',
        arguments: '{"code":"nodeRepl.write(1)"}',
        internal_chat_message_metadata_passthrough: {
          turn_id: 'turn-1',
        },
      },
    });
    emitNotification('rawResponseItem/completed', {
      item: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'Wall time: 0.0127 seconds\nOutput:\n1',
        internal_chat_message_metadata_passthrough: {
          turn_id: 'turn-1',
        },
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'tool-call',
      sessionId: 'session-1',
      turnId: 'codex-turn-1',
      toolCallId: 'call-1',
      toolName: 'mcp__node_repl__js',
      toolInput: expect.objectContaining({ code: 'nodeRepl.write(1)' }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'tool-result',
      sessionId: 'session-1',
      turnId: 'codex-turn-1',
      toolCallId: 'call-1',
      output: 'Wall time: 0.0127 seconds\nOutput:\n1',
    }));
  });

  it('publishes completed app-server function-call items as canonical runtime tool events', async () => {
    const runtime = createRuntime();
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    await runtime.send({ v: 1, text: 'inspect with completed item tools' }, { turnId: 'codex-turn-1' });
    emitNotification('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'item-function-call-1',
        type: 'function_call',
        call_id: 'call-1',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}',
      },
    });
    emitNotification('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'item-function-result-1',
        type: 'function_call_output',
        call_id: 'call-1',
        output: '{"stdout":"/workspace\\n","exit_code":0}',
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'tool-call',
      sessionId: 'session-1',
      turnId: 'codex-turn-1',
      toolCallId: 'call-1',
      toolName: 'Bash',
      toolInput: expect.objectContaining({ cmd: 'pwd' }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'tool-result',
      sessionId: 'session-1',
      turnId: 'codex-turn-1',
      toolCallId: 'call-1',
      output: { stdout: '/workspace\n', exit_code: 0 },
    }));
  });

  it('flushes buffered assistant text before publishing app-server tool events', async () => {
    const runtime = createRuntime();
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    await runtime.send({ v: 1, text: 'inspect with narrated tools' }, { turnId: 'codex-turn-1' });
    emitNotification('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'assistant-item-1',
        type: 'message',
        role: 'assistant',
      },
      delta: 'I will inspect the repository first.',
    });
    emitNotification('rawResponseItem/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'item-function-call-1',
        type: 'function_call',
        call_id: 'call-1',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}',
      },
    });

    const assistantCommitIndex = events.findIndex((event) => (
      event.kind === 'transcript-agent-message-committed'
      && event.agentId === 'codex'
      && event.body
      && typeof event.body === 'object'
      && !Array.isArray(event.body)
      && (event.body as Readonly<{ message?: unknown }>).message === 'I will inspect the repository first.'
    ));
    const toolCallIndex = events.findIndex((event) => event.kind === 'tool-call');

    expect(assistantCommitIndex).toBeGreaterThanOrEqual(0);
    expect(toolCallIndex).toBeGreaterThan(assistantCommitIndex);
  });

  it('writes app-server thread name updates through the canonical display title field', async () => {
    const fixture = createPluginContextV1Fixture({ sessionId: 'session-1' });
    const runtime = createRuntime({ ctx: fixture.ctx });

    await startCodexAppServerRuntime(runtime);
    emitNotification('thread/name/updated', {
      threadId: 'thread-1',
      name: 'Inspect repository',
    });

    expect(fixture.records.sessionStateFieldWrites).toContainEqual({
      fieldId: 'display.title',
      value: 'Inspect repository',
      reason: 'provider_update',
    });
  });

  it('mirrors successful Happier title tool results back to the Codex native thread name', async () => {
    const runtime = createRuntime();

    await runtime.send({ v: 1, text: 'set a title' }, { turnId: 'codex-turn-1' });
    emitNotification('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'title_1',
        type: 'mcpToolCall',
        server: 'happier__happier',
        tool: 'change_title',
        arguments: { title: 'Inspect repository' },
      },
    });
    emitNotification('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'title_1',
        type: 'mcpToolCall',
        result: { Ok: { success: true, title: 'Inspect repository' } },
      },
    });

    expect(clientState.requests).toContainEqual({
      method: 'thread/name/set',
      params: { threadId: 'thread-1', name: 'Inspect repository' },
    });
  });

  it('mirrors rollout-shaped Happier title tool results back to the Codex native thread name', async () => {
    const runtime = createRuntime();

    await runtime.send({ v: 1, text: 'set a title from raw rollout events' }, { turnId: 'codex-turn-1' });
    emitNotification('rawResponseItem/completed', {
      item: {
        id: 'title_1',
        type: 'function_call',
        call_id: 'call-title-1',
        name: 'change_title',
        namespace: 'mcp__happier',
        arguments: '{"title":"Inspect repository"}',
        internal_chat_message_metadata_passthrough: {
          turn_id: 'turn-1',
        },
      },
    });
    emitNotification('rawResponseItem/completed', {
      item: {
        id: 'title_1_output',
        type: 'function_call_output',
        call_id: 'call-title-1',
        output: 'Wall time: 0.0043 seconds\nOutput:\n[{"type":"text","text":"{\\"success\\":true,\\"title\\":\\"Inspect repository\\"}"}]',
        internal_chat_message_metadata_passthrough: {
          turn_id: 'turn-1',
        },
      },
    });

    expect(clientState.requests).toContainEqual({
      method: 'thread/name/set',
      params: { threadId: 'thread-1', name: 'Inspect repository' },
    });
  });

  it('does not mirror failed Happier title tool results back to the Codex native thread name', async () => {
    const runtime = createRuntime();

    await runtime.send({ v: 1, text: 'try to set a title' }, { turnId: 'codex-turn-1' });
    emitNotification('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'title_1',
        type: 'mcpToolCall',
        server: 'happier__happier',
        tool: 'change_title',
        arguments: { title: 'Rejected title' },
      },
    });
    emitNotification('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'title_1',
        type: 'mcpToolCall',
        result: { Err: 'user rejected MCP tool call' },
      },
    });
    emitNotification('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'title_2',
        type: 'mcpToolCall',
        server: 'happier__happier',
        tool: 'change_title',
        arguments: { title: 'Failed title' },
      },
    });
    emitNotification('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'title_2',
        type: 'mcpToolCall',
        result: { Ok: { success: false, error: 'not updated' } },
      },
    });
    emitNotification('rawResponseItem/completed', {
      item: {
        id: 'title_3',
        type: 'function_call',
        call_id: 'call-title-3',
        name: 'change_title',
        namespace: 'mcp__happier',
        arguments: '{"title":"Raw rejected title"}',
        internal_chat_message_metadata_passthrough: {
          turn_id: 'turn-1',
        },
      },
    });
    emitNotification('rawResponseItem/completed', {
      item: {
        id: 'title_3_output',
        type: 'function_call_output',
        call_id: 'call-title-3',
        output: 'Wall time: 0.0043 seconds\nOutput:\n[{"type":"text","text":"user rejected MCP tool call"}]',
        internal_chat_message_metadata_passthrough: {
          turn_id: 'turn-1',
        },
      },
    });

    expect(clientState.requests.some((request) => request.method === 'thread/name/set')).toBe(false);
  });

  it('ignores completed notifications when no Codex turn is pending', async () => {
    const runtime = createRuntime({
      processEnv: { HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS: '100' },
    });

    await runtime.send({ v: 1, text: 'first prompt' });
    const firstCompletion = waitForCodexAppServerRuntimeTurnCompletion(runtime);
    emitNotification('turn/completed', completedTurn('turn-1'));
    await firstCompletion;

    emitNotification('turn/completed', completedTurn('stale-turn'));
    await runtime.send({ v: 1, text: 'second prompt' });

    expect(runtime.canSteerPrompt()).toBe(true);

    const secondCompletion = waitForCodexAppServerRuntimeTurnCompletion(runtime);
    emitNotification('turn/completed', completedTurn('turn-2'));
    await secondCompletion;
  });

  it('ignores an unknown mismatched terminal id until the owned provider turn completes', async () => {
    const runtime = createRuntime({
      processEnv: { HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS: '0' },
    });
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });
    await runtime.send(
      { v: 1, text: 'thread-less drift' },
      { turnId: 'session-turn-owned' },
    );
    const completion = waitForCodexAppServerRuntimeTurnCompletion(runtime);
    emitNotification('turn/completed', {
      turn: { id: 'turn-unknown', status: 'completed' },
      status: 'completed',
    });
    expect(runtime.isTurnInFlight()).toBe(true);
    emitNotification('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-owned-after-mismatch',
      delta: 'Still owned by the active turn',
    });
    emitNotification('turn/completed', completedTurn('turn-1'));

    await completion;
    expect(events.filter((event) => event.kind === 'turn-start')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'turn-complete')).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'transcript-agent-message-committed',
      body: { type: 'message', message: 'Still owned by the active turn' },
    }));
    expect(runtime.isTurnInFlight()).toBe(false);
  });

  it('does not let a terminal id claim a pending turn before turn start is acknowledged', async () => {
    const runtime = createRuntime({
      processEnv: { HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS: '0' },
    });
    clientState.deferTurnStartForPrompt('delayed provider turn');

    const send = runtime.send(
      { v: 1, text: 'delayed provider turn' },
      { turnId: 'session-turn-delayed' },
    );
    await waitForTurnStartCount(1);
    emitNotification('turn/completed', {
      threadId: 'thread-1',
      turnId: 'turn-unknown-before-start-response',
      status: 'completed',
      turn: {
        id: 'turn-unknown-before-start-response',
        status: 'completed',
      },
    });

    expect(runtime.isTurnInFlight()).toBe(true);

    clientState.resolveDeferredTurnStart('turn-delayed-owned');
    await send;
    emitNotification('turn/completed', completedTurn('turn-delayed-owned'));
    await waitForCodexAppServerRuntimeTurnCompletion(runtime);
    expect(runtime.isTurnInFlight()).toBe(false);
  });

  it('rolls back the latest completed app-server turn through the native thread rollback RPC', async () => {
    const runtime = createRuntime({
      processEnv: { HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS: '0' },
    });
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    await runtime.send({ v: 1, text: 'rollback this turn' }, {
      turnId: 'codex-turn-1',
      userMessageSeq: 7,
    });
    const completion = waitForCodexAppServerRuntimeTurnCompletion(runtime);
    emitNotification('turn/completed', completedTurn('turn-1'));
    await completion;

    await expect(asConversationRollbackRuntime(runtime).rollbackConversation({
      v: 1,
      target: { type: 'latest_turn' },
    })).resolves.toEqual({
      ok: true,
      target: { type: 'latest_turn' },
      threadId: 'thread-1',
    });

    expect(clientState.requests).toContainEqual({
      method: 'thread/rollback',
      params: {
        threadId: 'thread-1',
        numTurns: 1,
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-rollback-boundary-observed',
      turnId: 'codex-turn-1',
      agentTurnId: 'turn-1',
      startUserMessageSeq: 7,
      startSeqInclusive: 7,
      endSeqInclusive: 7,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-rollback-applied',
      turnId: 'codex-turn-1',
      agentTurnId: 'turn-1',
    }));
  });

  it('surfaces the original temporary failure when the host retry fails too', async () => {
    const fixture = createPluginContextV1Fixture({ sessionId: 'session-1' });
    const refreshRuntimeAuth = vi.fn(async () => ({
      status: 'unavailable' as const,
      reason: 'runtime_auth_selection_unavailable',
    }));
    const runtime = createRuntime({
      ctx: {
        ...fixture.ctx,
        sessions: {
          ...fixture.ctx.sessions,
          current: {
            ...fixture.ctx.sessions.current,
            auth: {
              services: {
                refreshRuntimeAuth,
              },
            },
          },
        },
      },
    });
    const events: RuntimeEventV1[] = [];
    runtime.events.subscribe((event) => events.push(event));

    await runtime.send({ v: 1, text: 'original prompt' });
    emitNotification(
      'turn/completed',
      failedCapacityTurn('turn-1', 'ORIGINAL_CAPACITY_FAILURE: Selected model is at capacity. Please try a different model.'),
    );

    const waitForCompletion = waitForCodexAppServerRuntimeTurnCompletion(runtime);
    await waitForTurnStartCount(2);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (events.some((event) => event.kind === 'turn-agent-id-observed' && event.agentTurnId === 'turn-2')) break;
      await Promise.resolve();
    }
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-agent-id-observed',
      agentTurnId: 'turn-2',
    }));
    emitNotification(
      'turn/completed',
      failedCapacityTurn('turn-2', 'RETRY_CAPACITY_FAILURE: Selected model is at capacity. Please try a different model.'),
    );

    await expect(waitForCompletion).rejects.toThrow('ORIGINAL_CAPACITY_FAILURE');
    expect(refreshRuntimeAuth).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      serviceId: 'openai-codex',
      targetId: 'session-1',
      reason: 'provider_session_capacity_failure',
      classification: expect.objectContaining({
        kind: 'capacity',
        limitCategory: 'capacity',
        quotaScope: 'provider',
      }),
    }));
  });

  it('does not emit an undeliverable prompt while an unaccepted recoverable failure retries internally', async () => {
    clientState.deferTurnStartForPrompt('recoverable before acceptance');
    const runtime = createRuntime();
    const accepted: Array<Readonly<{ localInputIds?: readonly string[]; userMessageSeq: number | null }>> = [];
    const undeliverable: Array<Readonly<{ text: string; userMessageSeq: number | null }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });
    runtime.setOnUndeliverablePrompts?.((prompts) => {
      undeliverable.push(...prompts);
    });

    const send = runtime.send(
      { v: 1, text: 'recoverable before acceptance' },
      {
        localInputId: 'local-recoverable-before-acceptance',
        userMessageSeq: 91,
      },
    );
    await waitForRequestCount('turn/start', 1);
    emitNotification(
      'turn/completed',
      failedCapacityTurn('turn-1', 'Selected model is at capacity. Please try a different model.'),
    );
    clientState.resolveDeferredTurnStart('turn-1');
    await send;

    const completion = waitForCodexAppServerRuntimeTurnCompletion(runtime);
    await waitForTurnStartCount(2);
    emitNotification('turn/completed', completedTurn('turn-2'));
    await completion;

    expect(clientState.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    expect(accepted).toEqual([{
      localInputIds: ['local-recoverable-before-acceptance'],
      userMessageSeq: 91,
      userMessageSeqs: [91],
    }]);
    expect(undeliverable).toEqual([]);
  });

  it('starts session runtimes with the current service permission mode', async () => {
    const fixture = createPluginContextV1Fixture({ sessionId: 'session-1' });
    const services = {
      ...fixture.ctx.sessions.current,
      permissions: {
        ...fixture.ctx.sessions.current.permissions,
        getMode: () => 'safe-yolo',
      },
    };

    await createCodexAppServerSessionRuntime({
      ctx: fixture.ctx,
      sessionParams: {
        sessionId: 'session-1',
        directory: '/workspace',
        services,
      },
    });

    expect(clientState.requests.find((request) => request.method === 'thread/start')).toMatchObject({
      method: 'thread/start',
      params: expect.objectContaining({
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      }),
    });
  });

  it('starts session runtimes with the canonical provider-bound model before creating the app-server thread', async () => {
    const fixture = createPluginContextV1Fixture({ sessionId: 'session-1' });

    await createCodexAppServerSessionRuntime({
      ctx: fixture.ctx,
      sessionParams: {
        sessionId: 'session-1',
        directory: '/workspace',
        providerBindingMaterialization,
        metadata: {
          modelSelectionIntentV1: {
            v: 1,
            updatedAt: 123,
            selection: {
              agentTargetKey: 'backend:codex',
              providerConnectionId: 'pc_work',
              modelId: 'gpt-5.4-mini',
            },
          },
        },
      },
    });

    expect(clientState.requests.find((request) => request.method === 'thread/start')).toMatchObject({
      method: 'thread/start',
      params: expect.objectContaining({
        model: 'gpt-5.4-mini',
        modelProvider: 'happier_0123456789abcdef0123456789abcdef',
        config: providerBindingMaterialization.engineConfig.config,
      }),
    });
  });

  it('fails closed when a provider-bound selection reaches Codex without materialization', async () => {
    const fixture = createPluginContextV1Fixture({ sessionId: 'session-1' });

    await expect(createCodexAppServerSessionRuntime({
      ctx: fixture.ctx,
      sessionParams: {
        sessionId: 'session-1',
        directory: '/workspace',
        metadata: {
          modelSelectionIntentV1: {
            v: 1,
            updatedAt: 123,
            selection: {
              agentTargetKey: 'backend:codex',
              providerConnectionId: 'pc_work',
              modelId: 'gpt-5.4-mini',
            },
          },
        },
      },
    })).rejects.toThrow(/provider binding materialization/i);
    expect(clientState.requests.some((request) => request.method === 'thread/start')).toBe(false);
  });

  it('reapplies the provider binding to cold resume before the first resumed turn', async () => {
    const fixture = createPluginContextV1Fixture({ sessionId: 'session-1' });

    await createCodexAppServerSessionRuntime({
      ctx: fixture.ctx,
      sessionParams: {
        sessionId: 'session-1',
        directory: '/workspace',
        initialRuntimeState: { providerSessionId: 'codex-thread-1' },
        providerBindingMaterialization,
        metadata: {
          modelSelectionIntentV1: {
            v: 1,
            updatedAt: 123,
            selection: {
              agentTargetKey: 'backend:codex',
              providerConnectionId: 'pc_work',
              modelId: 'gpt-5.4-mini',
            },
          },
        },
      },
    });

    expect(clientState.requests.find((request) => request.method === 'thread/resume')).toMatchObject({
      method: 'thread/resume',
      params: expect.objectContaining({
        threadId: 'codex-thread-1',
        model: 'gpt-5.4-mini',
        modelProvider: 'happier_0123456789abcdef0123456789abcdef',
        config: providerBindingMaterialization.engineConfig.config,
      }),
    });
  });

  it('rejects malformed canonical model selection instead of falling back to the bare model field', async () => {
    const fixture = createPluginContextV1Fixture({ sessionId: 'session-1' });

    await expect(createCodexAppServerSessionRuntime({
      ctx: fixture.ctx,
      sessionParams: {
        sessionId: 'session-1',
        directory: '/workspace',
        modelSelection: {
          v: 1,
          updatedAt: 123,
          ref: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_work',
            modelId: '',
          },
        } as never,
        modelId: 'legacy-native',
      },
    })).rejects.toThrow(/model selection/i);
  });

  it('restarts an empty app-server thread when the first queued prompt selects a model after startup', async () => {
    const fixture = createPluginContextV1Fixture({ sessionId: 'session-1' });
    const runtime = await createCodexAppServerSessionRuntime({
      ctx: fixture.ctx,
      sessionParams: {
        sessionId: 'session-1',
        directory: '/workspace',
      },
    });

    const initialThreadStart = clientState.requests.find((request) => request.method === 'thread/start');
    expect(initialThreadStart).toMatchObject({
      method: 'thread/start',
      params: expect.not.objectContaining({ model: expect.any(String) }),
    });

    await runtime.updateConfig?.({ modelId: 'gpt-5.4-mini' });
    await runtime.send({ v: 1, text: 'first modeled prompt' });

    const threadStarts = clientState.requests.filter((request) => request.method === 'thread/start');
    expect(threadStarts).toHaveLength(2);
    expect(threadStarts[1]).toMatchObject({
      method: 'thread/start',
      params: expect.objectContaining({
        model: 'gpt-5.4-mini',
      }),
    });
    expect(clientState.requests.find((request) => request.method === 'turn/start')).toMatchObject({
      method: 'turn/start',
      params: expect.objectContaining({
        model: 'gpt-5.4-mini',
      }),
    });
  });

  it('restarts an empty app-server thread when the first queued prompt selects public read_only permissions after startup', async () => {
    const fixture = createPluginContextV1Fixture({ sessionId: 'session-1' });
    const runtime = await createCodexAppServerSessionRuntime({
      ctx: fixture.ctx,
      sessionParams: {
        sessionId: 'session-1',
        directory: '/workspace',
      },
    });

    const initialThreadStart = clientState.requests.find((request) => request.method === 'thread/start');
    expect(initialThreadStart).toMatchObject({
      method: 'thread/start',
      params: expect.not.objectContaining({
        permissions: ':read-only',
      }),
    });

    await runtime.updateConfig?.({ permissionMode: 'read_only' });
    await runtime.send({ v: 1, text: 'first read-only prompt' });

    const threadStarts = clientState.requests.filter((request) => request.method === 'thread/start');
    expect(threadStarts).toHaveLength(2);
    expect(threadStarts[1]).toMatchObject({
      method: 'thread/start',
      params: expect.objectContaining({
        permissions: ':read-only',
      }),
    });
    expect(clientState.requests.find((request) => request.method === 'turn/start')).toMatchObject({
      method: 'turn/start',
      params: expect.objectContaining({
        permissions: ':read-only',
      }),
    });
  });

  it('routes app-server config options by id instead of treating speed as reasoning effort', async () => {
    const runtime = createRuntime();

    await runtime.updateConfig?.({
      configOption: {
        id: 'service_tier',
        value: 'fast',
      },
    });
    await runtime.send({ v: 1, text: 'fast prompt' });

    const fastTurnStart = clientState.requests.find((request) => request.method === 'turn/start');
    expect(fastTurnStart).toMatchObject({
      method: 'turn/start',
      params: expect.objectContaining({
        serviceTier: 'fast',
      }),
    });
    expect(fastTurnStart?.params).not.toEqual(expect.objectContaining({
      effort: expect.anything(),
    }));

    clientState.reset();
    const legacySpeedRuntime = createRuntime();
    await legacySpeedRuntime.updateConfig?.({
      configOption: {
        id: 'speed',
        value: 'fast',
      },
    });
    await legacySpeedRuntime.send({ v: 1, text: 'legacy fast prompt' });

    const legacySpeedTurnStart = clientState.requests.find((request) => request.method === 'turn/start');
    expect(legacySpeedTurnStart).toMatchObject({
      method: 'turn/start',
      params: expect.objectContaining({
        serviceTier: 'fast',
      }),
    });
    expect(legacySpeedTurnStart?.params).not.toEqual(expect.objectContaining({
      effort: 'fast',
    }));

    clientState.reset();
    const reasoningRuntime = createRuntime();
    await reasoningRuntime.updateConfig?.({
      configOption: {
        id: 'reasoning_effort',
        value: 'high',
      },
    });
    await reasoningRuntime.send({ v: 1, text: 'deep prompt' });

    expect(clientState.requests.find((request) => request.method === 'turn/start')).toMatchObject({
      method: 'turn/start',
      params: expect.objectContaining({
        effort: 'high',
      }),
    });
  });

  it('records plugin-native app-server rate-limit reads with stable Codex auth-store account identity', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-usage-'));
    const records: unknown[] = [];
    const adoptions: unknown[] = [];
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({ tokens: { id_token: { chatgpt_account_id: 'acct_plugin_native' } } }),
      );

      const runtime = createRuntime({
        processEnv: { CODEX_HOME: codexHome },
        accountUsage: createAccountUsageService({
            recordSnapshot: async (input: unknown) => {
              records.push(input);
              return { status: 'recorded', recordId: 'paug_v1_test' };
            },
            adoptProvisionalRecord: async (input: unknown) => {
              adoptions.push(input);
              return { status: 'adopted', fromRecordId: 'paug_v1_from', toRecordId: 'paug_v1_to' };
            },
          }),
      });

      await startCodexAppServerRuntime(runtime);
      await waitForUsageRecordCount(records, 1);

      expect(records[0]).toMatchObject({
        snapshot: {
          providerId: 'openai-codex',
          accountSubject: {
            kind: 'providerSubject',
            id: 'acct_plugin_native',
          },
          meters: [
            expect.objectContaining({
              utilizationPct: 31,
            }),
          ],
        },
      });
      expect(adoptions).toHaveLength(1);
      expect(adoptions[0]).toMatchObject({
        adoption: {
          providerId: 'openai-codex',
          proof: { kind: 'id_token_account_id', issuer: 'chatgpt' },
          stableRecordKey: {
            providerId: 'openai-codex',
            accountSubjectId: 'acct_plugin_native',
            subjectKind: 'account',
            quotaScope: 'account',
          },
        },
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('records app-server rate-limit reads with connected-service group source context', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-usage-group-'));
    const records: unknown[] = [];
    const adoptions: unknown[] = [];
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({ tokens: { id_token: { chatgpt_account_id: 'acct_plugin_group' } } }),
      );

      const runtime = createRuntime({
        processEnv: { CODEX_HOME: codexHome },
        accountUsage: createAccountUsageService({
            resolveSourceContext: async (input: unknown) => {
              expect(input).toMatchObject({
                serviceId: 'openai-codex',
                env: {
                  CODEX_HOME: codexHome,
                },
              });
              return {
                serviceId: 'openai-codex',
                profileId: 'backup',
                bindingKind: 'group_member',
                groupId: 'primary-group',
              };
            },
            recordSnapshot: async (input: unknown) => {
              records.push(input);
              return { status: 'recorded', recordId: 'paug_v1_test' };
            },
            adoptProvisionalRecord: async (input: unknown) => {
              adoptions.push(input);
              return { status: 'adopted', fromRecordId: 'paug_v1_from', toRecordId: 'paug_v1_to' };
            },
          }),
      });

      await startCodexAppServerRuntime(runtime);
      await waitForUsageRecordCount(records, 1);

      expect(records[0]).toMatchObject({
        source: {
          serviceId: 'openai-codex',
          profileId: 'backup',
          bindingKind: 'group_member',
          groupId: 'primary-group',
        },
        snapshot: {
          providerId: 'openai-codex',
          accountSubject: {
            kind: 'providerSubject',
            id: 'acct_plugin_group',
          },
        },
      });
      expect(adoptions[0]).toMatchObject({
        adoption: {
          providerId: 'openai-codex',
          proof: { kind: 'id_token_account_id', issuer: 'chatgpt' },
        },
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('records live connected-service group quota evidence when a turn hits usage limit', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-usage-limit-group-'));
    const records: unknown[] = [];
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({ tokens: { id_token: { chatgpt_account_id: 'acct_stale_auth_store' } } }),
      );
      clientState.setRateLimitsSnapshot({
        rateLimits: {
          primary: { used_percent: 100, resets_at: 1779019200000 },
        },
        plan_type: 'pro',
      });
      clientState.setAccountReadResult({
        account: {
          id: 'acct_live_exhausted',
          email: 'team@example.test',
        },
      });

      const runtime = createRuntime({
        processEnv: { CODEX_HOME: codexHome },
        accountUsage: createAccountUsageService({
            resolveSourceContext: async () => ({
              serviceId: 'openai-codex',
              profileId: 'team',
              bindingKind: 'group_member',
              groupId: 'happier',
            }),
            recordSnapshot: async (input: unknown) => {
              records.push(input);
              return { status: 'recorded', recordId: 'paug_v1_test' };
            },
          }),
      });

      await runtime.send({ v: 1, text: 'use the current account' });
      emitNotification('turn/completed', failedUsageLimitTurn('turn-1'));
      await expect(waitForCodexAppServerRuntimeTurnCompletion(runtime)).rejects.toThrow('usage limit');
      const liveAccountRecord = await waitForUsageRecordMatching(records, (record) => (
        (record as { snapshot?: { accountSubject?: { id?: unknown } } }).snapshot?.accountSubject?.id
          === 'acct_live_exhausted'
      ));

      expect(clientState.requests.some((request) => request.method === 'account/read')).toBe(true);
      expect(liveAccountRecord).toMatchObject({
        source: {
          serviceId: 'openai-codex',
          profileId: 'team',
          bindingKind: 'group_member',
          groupId: 'happier',
        },
        snapshot: {
          providerId: 'openai-codex',
          accountSubject: {
            kind: 'providerSubject',
            id: 'acct_live_exhausted',
          },
          accountLabel: 'team@example.test',
          meters: [
            expect.objectContaining({
              utilizationPct: 100,
            }),
          ],
        },
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('records plugin-native app-server rate-limit notifications as isolated provisional subjects when stable identity is missing', async () => {
    const records: unknown[] = [];
    const runtime = createRuntime({
      happierSessionId: 'session-provisional',
      processEnv: { CODEX_HOME: '/missing/codex-home' },
      accountUsage: createAccountUsageService({
          recordSnapshot: async (input: unknown) => {
            records.push(input);
            return { status: 'recorded', recordId: 'paug_v1_test' };
          },
        }),
    });

    await startCodexAppServerRuntime(runtime);
    emitNotification('account/rateLimits/updated', {
      rateLimits: {
        primary: { used_percent: 64, resets_at: 1779019200000 },
      },
      account: { email: 'label-only@example.test' },
    });
    await waitForUsageRecordCount(records, 2);

    expect(records.at(-1)).toMatchObject({
      snapshot: {
        providerId: 'openai-codex',
        accountSubject: {
          kind: 'provisionalLocalSubject',
        },
        accountLabel: 'label-only@example.test',
        meters: [
          expect.objectContaining({
            utilizationPct: 64,
          }),
        ],
      },
    });
  });

  it('promotes live account identity from quota-failure usage recording for later fanout probes', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-quota-live-identity-'));
    const records: unknown[] = [];
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({
          tokens: {
            id_token: buildJwt({ email: 'seeded@example.test', exp: 4_102_444_800 }),
            access_token: buildJwt({ exp: 4_102_444_800 }),
            account_id: 'acct_seeded_stale',
          },
        }),
        'utf8',
      );
      clientState.setAccountReadResult({
        account: {
          id: 'acct_live_codex',
          email: 'live@example.test',
        },
      });
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: {
          CODEX_HOME: codexHome,
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'target',
            fallbackProfileId: 'backup',
            generation: 12,
          }]),
        },
        accountUsage: createAccountUsageService({
            recordSnapshot: async (input: unknown) => {
              records.push(input);
              return { status: 'recorded', recordId: 'paug_v1_live' };
            },
          }),
      }));

      await runtime.send({ v: 1, text: 'quota failure prompt' }, { turnId: 'codex-turn-1' });
      emitNotification('turn/completed', failedUsageLimitTurn('turn-1'));
      await expect(waitForCodexAppServerRuntimeTurnCompletion(runtime)).rejects.toThrow('usage limit');
      await waitForUsageRecordMatching(records, (record) => (
        Boolean(record)
        && typeof record === 'object'
        && !Array.isArray(record)
        && (record as Readonly<{ snapshot?: { accountLabel?: string | null } }>).snapshot?.accountLabel === 'live@example.test'
      ));

      await expect(runtime.readConnectedServiceRuntimeIdentity({
        serviceId: 'openai-codex',
        expected: {
          profileId: 'target',
          groupId: 'team',
          generation: 12,
        },
      })).resolves.toEqual({
        ok: true,
        serviceId: 'openai-codex',
        identity: {
          strategy: 'provider_account_id',
          proofStrength: 'exact',
          providerAccountId: 'acct_live_codex',
          accountLabel: 'live@example.test',
          source: 'live_account_read',
        },
        runtime: {
          safeToProbe: true,
          safeToApply: true,
          inProviderTurn: false,
          profileId: 'target',
          groupId: 'team',
          generation: 12,
        },
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('applies connected-service auth through the running app-server client and refreshes later with the new selection', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-live-auth-'));
    const refreshRequests: unknown[] = [];
    try {
      await mkdir(codexHome, { recursive: true });
      clientState.setAccountReadResult({
        account: {
          id: 'acct_target',
          email: 'target@example.test',
        },
      });
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: { CODEX_HOME: codexHome },
        ctx: {
          auth: {
            services: {
              refreshRuntimeAuth: async (request: unknown) => {
                refreshRequests.push(request);
                return {
                  status: 'refreshed',
                  result: {
                    accessToken: 'fresh-target-access',
                    chatgptAccountId: 'acct_target',
                    chatgptPlanType: 'plus',
                  },
                };
              },
            },
          },
        },
      }));
      const credential = buildConnectedCodexCredential('target');
      const selection = {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'team',
        activeProfileId: 'target',
        fallbackProfileId: 'backup',
        generation: 12,
      };

      await expect(runtime.applyConnectedServiceAuthGeneration({
        serviceId: 'openai-codex',
        reason: 'usage_limit',
        requireDirectLiveHotApply: true,
        expected: {
          profileId: 'target',
          groupId: 'team',
          generation: 12,
        },
        authGeneration: {
          credential,
          forcedWorkspaceId: 'acct_target',
          selection,
        },
      })).resolves.toMatchObject({
        ok: true,
        appliedVia: 'direct_live_hot_auth',
        activeAccountId: 'acct_target',
        verification: {
          activeAccountId: 'acct_target',
          proofStrength: 'exact',
          source: 'applied_credential',
        },
      });

      expect(clientState.requests).toContainEqual({
        method: 'account/login/start',
        params: {
          type: 'chatgptAuthTokens',
          accessToken: 'target-access',
          chatgptAccountId: 'acct_target',
        },
      });
      expect(JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'))).toMatchObject({
        access_token: 'target-access',
        refresh_token: 'target-refresh',
        id_token: 'target-id',
        account_id: 'acct_target',
      });

      await expect(clientState.invokeRequestHandler('account/chatgptAuthTokens/refresh', {
        chatgptPlanType: 'plus',
      })).resolves.toEqual({
        accessToken: 'fresh-target-access',
        chatgptAccountId: 'acct_target',
        chatgptPlanType: 'plus',
      });
      expect(refreshRequests).toEqual([expect.objectContaining({
        agentId: 'codex',
        serviceId: 'openai-codex',
        selection,
        planType: 'plus',
      })]);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('refreshes ChatGPT auth tokens with the spawn-time connected-service selection before live apply', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-spawn-refresh-'));
    const refreshRequests: unknown[] = [];
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({
          tokens: {
            id_token: buildJwt({ email: 'target@example.test', exp: 4_102_444_800 }),
            access_token: buildJwt({ exp: 4_102_444_800 }),
            account_id: 'acct_target',
          },
        }),
        'utf8',
      );
      const runtime = createRuntime({
        processEnv: {
          CODEX_HOME: codexHome,
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'target',
            fallbackProfileId: 'backup',
            generation: 12,
          }]),
        },
        ctx: {
          auth: {
            services: {
              refreshRuntimeAuth: async (request: unknown) => {
                refreshRequests.push(request);
                return {
                  result: {
                    accessToken: 'fresh-target-access',
                    chatgptAccountId: 'acct_target',
                    chatgptPlanType: 'plus',
                  },
                };
              },
            },
          },
        },
      });

      await startCodexAppServerRuntime(runtime);

      await expect(clientState.invokeRequestHandler('account/chatgptAuthTokens/refresh', {
        chatgptPlanType: 'plus',
      })).resolves.toEqual({
        accessToken: 'fresh-target-access',
        chatgptAccountId: 'acct_target',
        chatgptPlanType: 'plus',
      });
      expect(refreshRequests).toEqual([expect.objectContaining({
        agentId: 'codex',
        serviceId: 'openai-codex',
        selection: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'target',
          fallbackProfileId: 'backup',
          generation: 12,
        },
        planType: 'plus',
      })]);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('reports exact connected-service runtime identity from the applied credential', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-live-identity-'));
    try {
      await mkdir(codexHome, { recursive: true });
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: { CODEX_HOME: codexHome },
      }));
      const credential = buildConnectedCodexCredential('target');

      await runtime.applyConnectedServiceAuthGeneration({
        serviceId: 'openai-codex',
        authGeneration: {
          credential,
          forcedWorkspaceId: 'acct_target',
          selection: {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'target',
            fallbackProfileId: 'backup',
            generation: 12,
          },
        },
      });

      await expect(runtime.readConnectedServiceRuntimeIdentity({
        serviceId: 'openai-codex',
        expected: {
          profileId: 'target',
          groupId: 'team',
          generation: 12,
        },
      })).resolves.toEqual({
        ok: true,
        serviceId: 'openai-codex',
        identity: {
          strategy: 'provider_account_id',
          proofStrength: 'exact',
          providerAccountId: 'acct_target',
          source: 'applied_credential',
        },
        runtime: {
          safeToProbe: true,
          safeToApply: true,
          inProviderTurn: false,
          profileId: 'target',
          groupId: 'team',
          generation: 12,
        },
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('keeps exact runtime identity available when expected profile and generation are stale', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-stale-identity-'));
    try {
      await mkdir(codexHome, { recursive: true });
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: { CODEX_HOME: codexHome },
      }));
      const credential = buildConnectedCodexCredential('target');

      await runtime.applyConnectedServiceAuthGeneration({
        serviceId: 'openai-codex',
        authGeneration: {
          credential,
          forcedWorkspaceId: 'acct_target',
          selection: {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'target',
            fallbackProfileId: 'backup',
            generation: 12,
          },
        },
      });

      await expect(runtime.readConnectedServiceRuntimeIdentity({
        serviceId: 'openai-codex',
        reason: 'same_provider_account_exhausted',
        requireExactProof: true,
        expected: {
          profileId: 'stale-profile',
          groupId: 'team',
          generation: 1,
        },
      })).resolves.toEqual({
        ok: true,
        serviceId: 'openai-codex',
        identity: {
          strategy: 'provider_account_id',
          proofStrength: 'exact',
          providerAccountId: 'acct_target',
          source: 'applied_credential',
        },
        runtime: {
          safeToProbe: true,
          safeToApply: true,
          inProviderTurn: false,
          profileId: 'target',
          groupId: 'team',
          generation: 12,
        },
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('rejects runtime identity probes for a different connected-service group boundary', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-group-boundary-'));
    try {
      await mkdir(codexHome, { recursive: true });
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: { CODEX_HOME: codexHome },
      }));

      await runtime.applyConnectedServiceAuthGeneration({
        serviceId: 'openai-codex',
        authGeneration: {
          credential: buildConnectedCodexCredential('target'),
          forcedWorkspaceId: 'acct_target',
          selection: {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'target',
            fallbackProfileId: 'backup',
            generation: 12,
          },
        },
      });

      await expect(runtime.readConnectedServiceRuntimeIdentity({
        serviceId: 'openai-codex',
        expected: {
          profileId: 'target',
          groupId: 'other-team',
          generation: 12,
        },
      })).resolves.toEqual({
        ok: false,
        errorCode: 'runtime_identity_probe_account_mismatch',
        error: 'runtime_identity_probe_account_mismatch',
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('reports exact connected-service runtime identity from the spawn-time auth selection before live apply', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-spawn-identity-'));
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({
          tokens: {
            id_token: buildJwt({ email: 'target@example.test', exp: 4_102_444_800 }),
            access_token: buildJwt({ exp: 4_102_444_800 }),
            account_id: 'acct_target',
          },
        }),
        'utf8',
      );
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: {
          CODEX_HOME: codexHome,
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'target',
            fallbackProfileId: 'backup',
            generation: 12,
          }]),
        },
      }));
      await startCodexAppServerRuntime(runtime);

      await expect(runtime.readConnectedServiceRuntimeIdentity({
        serviceId: 'openai-codex',
        expected: {
          profileId: 'target',
          groupId: 'team',
          generation: 12,
        },
      })).resolves.toEqual({
        ok: true,
        serviceId: 'openai-codex',
        identity: {
          strategy: 'provider_account_id',
          proofStrength: 'exact',
          providerAccountId: 'acct_target',
          accountLabel: 'target@example.test',
          source: 'spawn_selection',
        },
        runtime: {
          safeToProbe: true,
          safeToApply: true,
          inProviderTurn: false,
          profileId: 'target',
          groupId: 'team',
          generation: 12,
        },
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('live-probes exact runtime identity for cold same-account fanout siblings', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-cold-sibling-live-identity-'));
    try {
      await mkdir(codexHome, { recursive: true });
      clientState.setAccountReadResult({
        account: {
          id: 'acct_live_sibling',
          email: 'sibling@example.test',
        },
      });
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: {
          CODEX_HOME: codexHome,
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'target',
            fallbackProfileId: 'backup',
            generation: 12,
          }]),
        },
      }));

      await expect(runtime.readConnectedServiceRuntimeIdentity({
        serviceId: 'openai-codex',
        expected: {
          profileId: 'stale-profile',
          groupId: 'team',
          generation: 1,
        },
      })).resolves.toEqual({
        ok: true,
        serviceId: 'openai-codex',
        identity: {
          strategy: 'provider_account_id',
          proofStrength: 'exact',
          providerAccountId: 'acct_live_sibling',
          accountLabel: 'sibling@example.test',
          source: 'live_account_read',
        },
        runtime: {
          safeToProbe: true,
          safeToApply: true,
          inProviderTurn: false,
          profileId: 'target',
          groupId: 'team',
          generation: 12,
        },
      });
      expect(clientState.requests).toContainEqual({ method: 'account/read', params: undefined });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('uses daemon expected runtime context with live account proof when local selection is missing', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-expected-context-live-identity-'));
    try {
      await mkdir(codexHome, { recursive: true });
      clientState.setAccountReadResult({
        account: {
          id: 'acct_live_expected',
          email: 'expected@example.test',
        },
      });
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: { CODEX_HOME: codexHome },
      }));

      await expect(runtime.readConnectedServiceRuntimeIdentity({
        serviceId: 'openai-codex',
        reason: 'same_provider_account_exhausted',
        requireExactProof: true,
        expected: {
          profileId: 'daemon-profile',
          groupId: 'team',
          generation: 12,
        },
      })).resolves.toEqual({
        ok: true,
        serviceId: 'openai-codex',
        identity: {
          strategy: 'provider_account_id',
          proofStrength: 'exact',
          providerAccountId: 'acct_live_expected',
          accountLabel: 'expected@example.test',
          source: 'live_account_read',
        },
        runtime: {
          safeToProbe: true,
          safeToApply: true,
          inProviderTurn: false,
          profileId: 'daemon-profile',
          groupId: 'team',
          generation: 12,
        },
      });
      expect(clientState.requests).toContainEqual({ method: 'account/read', params: undefined });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('does not use daemon expected runtime context for diagnostic probes without local selection', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-diagnostic-expected-context-'));
    try {
      await mkdir(codexHome, { recursive: true });
      clientState.setAccountReadResult({
        account: {
          id: 'acct_live_expected',
          email: 'expected@example.test',
        },
      });
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: { CODEX_HOME: codexHome },
      }));

      await expect(runtime.readConnectedServiceRuntimeIdentity({
        serviceId: 'openai-codex',
        reason: 'diagnostic',
        requireExactProof: true,
        expected: {
          profileId: 'daemon-profile',
          groupId: 'team',
          generation: 12,
        },
      })).resolves.toEqual({
        ok: false,
        errorCode: 'runtime_identity_probe_unavailable',
        error: 'runtime_identity_probe_unavailable',
      });
      expect(clientState.requests).toContainEqual({ method: 'account/read', params: undefined });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('applies live auth while a turn is in flight', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-live-auth-busy-'));
    try {
      await mkdir(codexHome, { recursive: true });
      clientState.deferTurnStartForPrompt('busy prompt');
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: { CODEX_HOME: codexHome },
      }));
      const send = runtime.send({ v: 1, text: 'busy prompt' });
      await waitForRequestCount('turn/start', 1);

      await expect(runtime.applyConnectedServiceAuthGeneration({
        serviceId: 'openai-codex',
        authGeneration: {
          credential: buildConnectedCodexCredential('target'),
          forcedWorkspaceId: 'acct_target',
          selection: {
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'target',
          },
        },
      })).resolves.toMatchObject({
        ok: true,
        appliedVia: 'direct_live_hot_auth',
        activeAccountId: 'acct_target',
        verification: {
          activeAccountId: 'acct_target',
          proofStrength: 'exact',
          source: 'applied_credential',
        },
      });

      expect(clientState.requests).toContainEqual({
        method: 'account/login/start',
        params: {
          type: 'chatgptAuthTokens',
          accessToken: 'target-access',
          chatgptAccountId: 'acct_target',
        },
      });
      clientState.resolveDeferredTurnStart('turn-busy');
      await send;
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('confirms successful in-flight steers through the provider-acceptance callback with the user-message seq', async () => {
    const runtime = createRuntime();
    await runtime.send({ v: 1, text: 'original prompt' });

    const accepted: Array<Readonly<{ userMessageSeq: number | null }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });

    await runtime.send(
      { v: 1, text: 'steer into active turn' },
      { deliverAs: 'steer', userMessageSeq: 77 },
    );

    expect(clientState.requests.at(-1)).toMatchObject({
      method: 'turn/steer',
      params: expect.objectContaining({
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
      }),
    });
    expect(accepted).toEqual([{ userMessageSeq: 77, userMessageSeqs: [77] }]);
  });

  it('does not emit provider acceptance without a pending-delivery identity', async () => {
    const runtime = createRuntime();
    const accepted: Array<Readonly<{ userMessageSeq: number | null }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });

    await runtime.send({ v: 1, text: 'prompt without delivery identity' });

    expect(accepted).toEqual([]);
  });

  it('does not let a delayed turn start response confirm an overlapping steer prompt', async () => {
    clientState.deferTurnStartForPrompt('overlap start');
    const runtime = createRuntime();
    const accepted: Array<Readonly<{ userMessageSeq: number | null }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });

    const originalSend = runtime.send(
      { v: 1, text: 'overlap start' },
      { userMessageSeq: 10 },
    );
    await waitForRequestCount('turn/start', 1);
    emitNotification('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-overlap' },
    });
    expect(runtime.canSteerPrompt()).toBe(true);

    clientState.deferNextSteer();
    const steerSend = runtime.send(
      { v: 1, text: 'overlap steer' },
      { deliverAs: 'steer', userMessageSeq: 11 },
    );
    await waitForRequestCount('turn/steer', 1);

    clientState.resolveDeferredTurnStart('turn-overlap');
    await originalSend;
    expect(accepted).toEqual([{ userMessageSeq: 10, userMessageSeqs: [10] }]);

    clientState.resolveDeferredSteer();
    await steerSend;
    expect(accepted).toEqual([
      { userMessageSeq: 10, userMessageSeqs: [10] },
      { userMessageSeq: 11, userMessageSeqs: [11] },
    ]);
  });

  it('keeps an active turn steerable and waits for the provider turn id before steering', async () => {
    clientState.deferTurnStartForPrompt('provider id delayed');
    const runtime = createRuntime();
    const accepted: Array<Readonly<{ userMessageSeq: number | null }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });

    const originalSend = runtime.send(
      { v: 1, text: 'provider id delayed' },
      { userMessageSeq: 20 },
    );
    await waitForRequestCount('turn/start', 1);

    expect(runtime.isTurnInFlight()).toBe(true);
    expect(runtime.canSteerPrompt()).toBe(true);

    const steerSend = runtime.send(
      { v: 1, text: 'steer before provider id' },
      { deliverAs: 'steer', userMessageSeq: 21 },
    );
    await Promise.resolve();
    expect(clientState.requests.filter((request) => request.method === 'turn/steer')).toEqual([]);

    clientState.resolveDeferredTurnStart('turn-delayed-provider-id');
    await originalSend;
    await steerSend;

    expect(clientState.requests).toContainEqual({
      method: 'turn/steer',
      params: expect.objectContaining({
        threadId: 'thread-1',
        expectedTurnId: 'turn-delayed-provider-id',
        input: [{ type: 'text', text: 'steer before provider id' }],
      }),
    });
    expect(accepted).toEqual([
      { userMessageSeq: 20, userMessageSeqs: [20] },
      { userMessageSeq: 21, userMessageSeqs: [21] },
    ]);
  });

  it('interrupts and suppresses provider acceptance when cancellation wins before turn start returns', async () => {
    clientState.deferTurnStartForPrompt('cancel before provider id');
    const runtime = createRuntime();
    const accepted: Array<Readonly<{ userMessageSeq: number | null }>> = [];
    const undeliverable: Array<Readonly<{ text: string; userMessageSeq: number | null }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });
    runtime.setOnUndeliverablePrompts?.((prompts) => {
      undeliverable.push(...prompts);
    });

    const send = runtime.send(
      { v: 1, text: 'cancel before provider id' },
      { userMessageSeq: 12 },
    );
    await waitForRequestCount('turn/start', 1);

    await expect(runtime.cancel()).resolves.toEqual({ status: 'cancelled' });
    expect(accepted).toEqual([]);
    expect(undeliverable).toEqual([{
      text: 'cancel before provider id',
      userMessageSeq: 12,
      userMessageSeqs: [12],
    }]);

    clientState.resolveDeferredTurnStart('turn-cancelled-late');
    await send.catch(() => undefined);

    expect(clientState.requests).toContainEqual({
      method: 'turn/interrupt',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-cancelled-late',
      },
    });
    expect(accepted).toEqual([]);
    expect(runtime.canSteerPrompt()).toBe(false);
  });

  it('emits a turn start prompt as undeliverable when the send fails before provider acceptance', async () => {
    const runtime = createRuntime();
    const accepted: Array<Readonly<{ userMessageSeq: number | null }>> = [];
    const undeliverable: Array<Readonly<{ text: string; userMessageSeq: number | null }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });
    runtime.setOnUndeliverablePrompts?.((prompts) => {
      undeliverable.push(...prompts);
    });
    clientState.rejectNextTurnStart('Codex app-server send failed before acceptance');

    await expect(runtime.send(
      { v: 1, text: 'fails before acceptance' },
      { userMessageSeq: 88 },
    )).rejects.toThrow('Codex app-server send failed before acceptance');

    expect(accepted).toEqual([]);
    expect(undeliverable).toEqual([{
      text: 'fails before acceptance',
      userMessageSeq: 88,
      userMessageSeqs: [88],
    }]);
  });

  it('does not confirm provider acceptance when an in-flight steer fails', async () => {
    const runtime = createRuntime();
    await runtime.send({ v: 1, text: 'original prompt' });

    const accepted: Array<Readonly<{ userMessageSeq: number | null }>> = [];
    const undeliverable: Array<Readonly<{ text: string; userMessageSeq: number | null }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });
    runtime.setOnUndeliverablePrompts?.((prompts) => {
      undeliverable.push(...prompts);
    });
    clientState.failNextSteer();

    await expect(runtime.send(
      { v: 1, text: 'steer into active turn' },
      { deliverAs: 'steer', userMessageSeq: 78 },
    )).rejects.toThrow('Codex app-server steer failed');

    expect(accepted).toEqual([]);
    expect(undeliverable).toEqual([{
      text: 'steer into active turn',
      userMessageSeq: 78,
      userMessageSeqs: [78],
    }]);
  });
});
