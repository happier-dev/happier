import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  AgentSessionConversationRollbackRequest,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { CodexAppServerEvent } from './core.js';

const clientState = vi.hoisted(() => {
  const handlers = new Map<string, (params: unknown) => void | Promise<void>>();
  const exitHandlers = new Set<(result: Readonly<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }>) => void>();
  const requestHandlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  const requests: Array<{ method: string; params: unknown }> = [];
  let turnStartCount = 0;
  let failNextSteer = false;
  let rejectNextInterrupt: Error | null = null;
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
  let deferredRateLimitsRead: {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
  } | null = null;
  let deferNextRateLimitsRead = false;
  let accountReadResult: unknown = { account: null };
  let threadReadResult: unknown = { thread: { id: 'thread-1', turns: [] } };
  let rejectNextThreadResume: Error | null = null;
  let nextThreadResumeResult: unknown | null = null;
  let rejectNextThreadRead: Error | null = null;
  let deferNextLoginStart = false;
  let deferredLoginStart: {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
  } | null = null;

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
    exitHandlers,
    requestHandlers,
    requests,
    reset() {
      handlers.clear();
      exitHandlers.clear();
      requestHandlers.clear();
      requests.length = 0;
      turnStartCount = 0;
      failNextSteer = false;
      rejectNextInterrupt = null;
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
      deferredRateLimitsRead = null;
      deferNextRateLimitsRead = false;
      accountReadResult = { account: null };
      threadReadResult = { thread: { id: 'thread-1', turns: [] } };
      rejectNextThreadResume = null;
      nextThreadResumeResult = null;
      rejectNextThreadRead = null;
      deferNextLoginStart = false;
      deferredLoginStart = null;
    },
    failNextSteer() {
      failNextSteer = true;
    },
    rejectNextInterruptAsAlreadyCompleted() {
      rejectNextInterrupt = Object.assign(
        new Error('no active turn to interrupt'),
        { code: -32600, method: 'turn/interrupt' },
      );
    },
    rejectNextInterruptWith(error: Error) {
      rejectNextInterrupt = error;
    },
    rejectNextTurnStart(failure: string | Error) {
      rejectNextTurnStart = typeof failure === 'string'
        ? new Error(failure)
        : failure;
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
    deferNextRateLimitsRead() {
      deferNextRateLimitsRead = true;
    },
    resolveDeferredRateLimitsRead(value: unknown) {
      if (!deferredRateLimitsRead) throw new Error('No deferred account/rateLimits/read request is pending');
      deferredRateLimitsRead.resolve(value);
      deferredRateLimitsRead = null;
    },
    setAccountReadResult(value: unknown) {
      accountReadResult = value;
    },
    setThreadReadResult(value: unknown) {
      threadReadResult = value;
    },
    rejectNextThreadResume(error: Error) {
      rejectNextThreadResume = error;
    },
    setNextThreadResumeResult(result: unknown) {
      nextThreadResumeResult = result;
    },
    rejectNextThreadRead(error: Error) {
      rejectNextThreadRead = error;
    },
    deferNextLoginStart() {
      deferNextLoginStart = true;
    },
    resolveDeferredLoginStart() {
      if (!deferredLoginStart) throw new Error('No deferred account/login/start request is pending');
      deferredLoginStart.resolve({ ok: true });
      deferredLoginStart = null;
    },
    async request(method: string, params?: unknown): Promise<unknown> {
      requests.push({ method, params });
      if (method === 'account/rateLimits/read') {
        if (deferNextRateLimitsRead) {
          deferNextRateLimitsRead = false;
          deferredRateLimitsRead = createDeferred();
          return await deferredRateLimitsRead.promise;
        }
        return rateLimitsSnapshot;
      }
      if (method === 'account/read') {
        return accountReadResult;
      }
      if (method === 'account/login/start') {
        if (deferNextLoginStart) {
          deferNextLoginStart = false;
          deferredLoginStart = createDeferred();
          return await deferredLoginStart.promise;
        }
        return { ok: true };
      }
      if (method === 'thread/start') {
        return { threadId: 'thread-1' };
      }
      if (method === 'thread/resume') {
        if (rejectNextThreadResume) {
          const error = rejectNextThreadResume;
          rejectNextThreadResume = null;
          throw error;
        }
        if (nextThreadResumeResult !== null) {
          const result = nextThreadResumeResult;
          nextThreadResumeResult = null;
          return result;
        }
        const record = params && typeof params === 'object'
          ? params as Readonly<Record<string, unknown>>
          : {};
        return { threadId: record.threadId ?? 'thread-resumed' };
      }
      if (method === 'thread/name/set') {
        return {};
      }
      if (method === 'thread/read') {
        if (rejectNextThreadRead) {
          const error = rejectNextThreadRead;
          rejectNextThreadRead = null;
          throw error;
        }
        return threadReadResult;
      }
      if (method === 'thread/rollback') {
        return {};
      }
      if (method === 'experimentalFeature/list') {
        return {
          data: [{ name: 'realtime_conversation', enabled: true }],
          nextCursor: null,
        };
      }
      if (method === 'thread/realtime/start' || method === 'thread/realtime/stop') {
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
        if (rejectNextInterrupt) {
          const error = rejectNextInterrupt;
          rejectNextInterrupt = null;
          throw error;
        }
        return {};
      }
      throw new Error(`Unexpected Codex app-server request: ${method}`);
    },
    async notify(): Promise<void> {
      return undefined;
    },
    emitExit(result: Readonly<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }>) {
      for (const handler of [...exitHandlers]) handler(result);
    },
    onExit(handler: (result: Readonly<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }>) => void): () => void {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
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
    launchFeatures: {
      realtimeConversationAdvertised: true,
      codexCliVersion: '0.145.0',
      realtimeConversationVersionSupported: true,
    },
    request: clientState.request,
    notify: clientState.notify,
    registerRequestHandler: clientState.registerRequestHandler,
    registerNotificationHandler: clientState.registerNotificationHandler,
    onExit: clientState.onExit,
    dispose: vi.fn(async () => undefined),
  })),
  isCodexAppServerOversizedJsonFrameError: vi.fn(() => false),
  resolveCodexHome: (env: Readonly<Record<string, string | undefined>>) => env.CODEX_HOME ?? '/home/test/.codex',
}));

import {
  createCodexAppServerRuntime,
  startCodexAppServerRuntime,
  type CodexAppServerRuntimeHost,
  waitForCodexAppServerRuntimeTurnCompletion,
} from './runtime.js';
import { createCodexNativeAppServerSessionRuntime } from './native.js';
import {
  createCodexAppServerClient,
  isCodexAppServerOversizedJsonFrameError,
} from './client.js';
import { fetchCodexRateLimitResetCredits } from '../../auth/services/quota/rateLimitResetCreditsClient.js';
import { computeCodexAccessTokenFingerprint } from './connectedServiceRuntimeIdentity.js';

const providerBindingMaterialization = {
  v: 1,
  kind: 'engineConfig',
  engineConfig: {
    v: 1,
    modelProvider: 'happier_0123456789abcdef0123456789abcdef',
    config: {
      model_reasoning_effort: 'none',
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

type CodexTestAccountUsageService = NonNullable<CodexAppServerRuntimeHost['accountUsage']>;
type CodexTestLogger = Readonly<{
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}>;
type CodexTestRuntimeAuthRefresh = (request: unknown) => Promise<unknown> | unknown;
type CodexTestContextOverrides = Readonly<{
  logger?: CodexTestLogger;
  writeStateField?: (request: unknown) => Promise<void>;
  auth?: Readonly<{ services: Readonly<{ refreshRuntimeAuth: CodexTestRuntimeAuthRefresh }> }>;
  sessions?: Readonly<{
    current: Readonly<{
      auth: Readonly<{ services: Readonly<{ refreshRuntimeAuth: CodexTestRuntimeAuthRefresh }> }>;
    }>;
  }>;
}>;

function createCodexTestContextFixture(params: Readonly<{
  sessionId?: string;
  overrides?: CodexTestContextOverrides;
  accountUsage?: CodexTestAccountUsageService;
}> = {}) {
  const sessionStateFieldWrites: unknown[] = [];
  const defaultRefreshRuntimeAuth: CodexTestRuntimeAuthRefresh = async () => ({
    status: 'unavailable' as const,
    reason: 'runtime_auth_selection_unavailable',
  });
  const refreshRuntimeAuth = params.overrides?.auth?.services.refreshRuntimeAuth
    ?? params.overrides?.sessions?.current.auth.services.refreshRuntimeAuth
    ?? defaultRefreshRuntimeAuth;
  const logger = params.overrides?.logger ?? {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  // The app-server client is mocked in this test file; no process method is reached.
  const exec = Object.freeze({}) as unknown as ExecService;
  const runtimeFetch: HttpService = {
    request: vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      headers: {},
      body: new TextEncoder().encode('{}'),
    })),
  };
  return {
    context: {
      logger,
      env: { list: () => ({}) },
      exec,
      runtimeFetch,
      accountUsage: params.accountUsage ?? createAccountUsageService({}),
      refreshRuntimeAuth,
      writeStateField: params.overrides?.writeStateField ?? (async (request: unknown) => {
        sessionStateFieldWrites.push(request);
      }),
      sessionId: params.sessionId ?? 'session-1',
    },
    records: { sessionStateFieldWrites },
  };
}

function createRuntime(overrides: Readonly<{
  ctx?: CodexTestContextOverrides;
  accountUsage?: CodexTestAccountUsageService;
  happierSessionId?: string;
  processEnv?: Readonly<Record<string, string | undefined>>;
  initialModelId?: string;
  initialProviderBinding?: typeof providerBindingMaterialization.engineConfig;
  publishGeneratedMedia?: (candidate: import('./media/generatedMedia.js').CodexGeneratedMediaCandidate) => Promise<void>;
}> = {}) {
  const fixture = createCodexTestContextFixture({
    sessionId: overrides.happierSessionId ?? 'session-1',
    overrides: overrides.ctx,
    accountUsage: overrides.accountUsage,
  });
  const ctx = fixture.context;
  return createCodexAppServerRuntime({
    host: {
      baseProcessEnv: ctx.env.list(),
      logger: ctx.logger,
      createClient: async (request) => await createCodexAppServerClient({
        exec: ctx.exec,
        cwd: request.cwd,
        processEnv: request.processEnv,
        configOverrides: request.configOverrides,
        disableUserMcpServers: request.disableUserMcpServers,
      }),
      fetchRateLimitResetCredits: async ({ accessToken, accountId }) => await fetchCodexRateLimitResetCredits({
        accessToken,
        accountId,
        runtimeFetch: ctx.runtimeFetch,
      }),
      accountUsage: ctx.accountUsage,
      setTitle: async (title) => await ctx.writeStateField({
        fieldId: 'display.title',
        value: title,
        reason: 'provider_update',
      }),
      refreshRuntimeAuth: async (request) => await ctx.refreshRuntimeAuth(request),
      reportCapacityFailure: async (classification) => {
        await ctx.refreshRuntimeAuth({
          agentId: 'codex',
          serviceId: 'openai-codex',
          targetId: overrides.happierSessionId ?? 'session-1',
          classification,
          reason: 'provider_session_capacity_failure',
        });
      },
      ...(overrides.publishGeneratedMedia ? { publishGeneratedMedia: overrides.publishGeneratedMedia } : {}),
    },
    directory: '/workspace',
    happierSessionId: overrides.happierSessionId ?? 'session-1',
    processEnv: overrides.processEnv,
    initialModelId: overrides.initialModelId,
    initialProviderBinding: overrides.initialProviderBinding,
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

async function startActiveRealtimeAttachment(
  runtime: ReturnType<typeof createRuntime>,
) {
  const starting = runtime.realtimeConversation.start({
    transport: { kind: 'webrtc', offerSdp: 'offer' },
  });
  await waitForRequestCount('thread/realtime/start', 1);
  emitNotification('thread/realtime/started', {
    threadId: 'thread-1',
    realtimeSessionId: null,
    version: 'v3',
  });
  emitNotification('thread/realtime/sdp', {
    threadId: 'thread-1',
    sdp: 'answer',
  });
  const started = await starting;
  if (started.status !== 'started') {
    throw new Error(`Expected Codex realtime to start, received ${started.status}`);
  }
  return started.handle;
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
    runtimeAuth: Readonly<{
      apply(request: unknown): Promise<unknown>;
      readIdentity(request: unknown): Promise<unknown>;
    }>;
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

function failedCapacityTurn(
  turnId: string,
  message: string,
  additionalDetails?: string,
): unknown {
  return {
    threadId: 'thread-1',
    turnId,
    status: 'failed',
    turn: {
      id: turnId,
      status: 'failed',
      error: {
        message,
        ...(additionalDetails ? { additional_details: additionalDetails } : {}),
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

function failedUsageLimitTurn(
  turnId: string,
  errorOverrides: Readonly<Record<string, unknown>> = {},
): unknown {
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
        ...errorOverrides,
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
  overrides: Partial<CodexTestAccountUsageService>,
): CodexTestAccountUsageService {
  return {
    resolveSourceContext: async () => null,
    recordSnapshot: async () => ({ status: 'recorded' }),
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

  it('starts one thread lazily on the first prompt, publishes its identity, and admits once', async () => {
    const appServerRuntime = createRuntime();
    const runtime = createCodexNativeAppServerSessionRuntime(appServerRuntime, 'session-1');
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    expect(appServerRuntime.identity.read()).toEqual({ providerSessionId: null });
    expect(clientState.requests.filter(({ method }) => method === 'thread/start')).toEqual([]);

    await expect(runtime.send({
      inputIds: ['input-first'],
      input: { text: 'first prompt' },
      delivery: { kind: 'newTurn', turnId: 'turn-first' },
    })).resolves.toEqual({ status: 'admitted' });

    expect(clientState.requests.filter(({ method }) => method === 'thread/start')).toHaveLength(1);
    expect(clientState.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1);
    expect(appServerRuntime.identity.read()).toEqual({ providerSessionId: 'thread-1' });
    expect(events.filter((event) => event.kind === 'provider-session-id')).toEqual([
      expect.objectContaining({
        kind: 'provider-session-id',
        providerSessionId: 'thread-1',
      }),
    ]);
    expect(events.filter((event) => event.kind === 'input-accepted')).toEqual([
      expect.objectContaining({
        kind: 'input-accepted',
        inputIds: ['input-first'],
      }),
    ]);
  });

  it.each([
    ['thread/start', undefined],
    ['thread/resume', 'thread-existing'],
  ])('sends startup developer instructions on %s', async (method, resumeId) => {
    const runtime = createRuntime();

    await startCodexAppServerRuntime(runtime, {
      ...(resumeId ? { resumeId, preserveRequestedThreadId: true } : {}),
      developerInstructions: 'Global Voice developer instructions.',
    });

    expect(clientState.requests.find((request) => request.method === method))
      .toMatchObject({
        method,
        params: expect.objectContaining({
          developerInstructions: 'Global Voice developer instructions.',
        }),
      });
  });

  it('rejects a strict native resume that returns a different thread without publishing either id', async () => {
    const runtime = createRuntime();
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.events.subscribe((event) => events.push(event));
    clientState.setNextThreadResumeResult({ threadId: 'thread-other' });

    await expect(startCodexAppServerRuntime(runtime, {
      resumeId: 'thread-requested',
      strictNativeResumeIdentity: true,
    })).rejects.toMatchObject({
      name: 'CodexAppServerResumeIdentityMismatchError',
      happierNativeResumeIdentityMismatch: true,
    });

    expect(runtime.identity.read()).toEqual({ providerSessionId: null });
    expect(events.filter((event) => event.kind === 'session-id-publish')).toEqual([]);
  });

  it.each([
    {
      label: 'valid',
      errorName: 'CodexThreadReadFailure',
      errorCode: 'codex_thread_read_failed',
      expectedIdentity: {
        errorName: 'CodexThreadReadFailure',
        errorCode: 'codex_thread_read_failed',
      },
    },
    {
      label: 'provider-controlled',
      errorName: 'Error\nVOICE_PRIVATE_THREAD_READ_ERROR_NAME_SENTINEL',
      errorCode: 'provider code: VOICE_PRIVATE_THREAD_READ_ERROR_CODE_SENTINEL',
      expectedIdentity: {
        errorName: 'Error',
      },
    },
  ])('logs only bounded $label error identity when oversized resume fallback thread/read rejects', async ({
    errorName,
    errorCode,
    expectedIdentity,
  }) => {
    const threadReadSentinel = 'VOICE_PRIVATE_OVERSIZED_RESUME_THREAD_READ_SENTINEL';
    const oversizedResumeFailure = new Error('oversized resume response');
    const threadReadFailure = Object.assign(
      new Error(`Provider echoed ${threadReadSentinel}`),
      {
        name: errorName,
        code: errorCode,
      },
    );
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const runtime = createRuntime({ ctx: { logger } });
    clientState.rejectNextThreadResume(oversizedResumeFailure);
    clientState.rejectNextThreadRead(threadReadFailure);
    vi.mocked(isCodexAppServerOversizedJsonFrameError).mockReturnValueOnce(true);

    await expect(startCodexAppServerRuntime(runtime, {
      resumeId: 'thread-private',
      preserveRequestedThreadId: true,
    })).rejects.toBe(threadReadFailure);

    const failedReadLog = logger.debug.mock.calls.find(
      ([message]) => message === 'Failed lean Codex app-server thread metadata read after oversized resume response',
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Failed lean Codex app-server thread metadata read after oversized resume response',
      {
        threadId: 'thread-private',
        elapsedMs: expect.any(Number),
        ...expectedIdentity,
      },
    );
    expect(failedReadLog?.[1]).not.toHaveProperty('error');
    expect(String(
      (failedReadLog?.[1] as Readonly<{ error?: Error }> | undefined)?.error?.stack ?? '',
    )).not.toContain(threadReadSentinel);
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(threadReadSentinel);
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('VOICE_PRIVATE_THREAD_READ_ERROR_NAME_SENTINEL');
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('VOICE_PRIVATE_THREAD_READ_ERROR_CODE_SENTINEL');
  });

  it('publishes provider-generated media once through the runtime host and fences disposal', async () => {
    const publishGeneratedMedia = vi.fn(async () => undefined);
    const runtime = createRuntime({ publishGeneratedMedia });

    await runtime.send({ v: 1, text: 'generate an image' }, { turnId: 'codex-turn-media' });
    const notification = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'image-1',
        type: 'imageGeneration',
        status: 'completed',
        result: 'iVBORw0KGgo=',
        revisedPrompt: null,
        savedPath: '/tmp/codex/generated.png',
      },
    };
    emitNotification('item/completed', notification);
    emitNotification('item/completed', notification);
    await Promise.resolve();

    expect(publishGeneratedMedia).toHaveBeenCalledTimes(1);
    expect(publishGeneratedMedia).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'image-1',
      source: {
        kind: 'local-file',
        path: '/tmp/codex/generated.png',
        fileNameHint: 'generated.png',
        restrictedRoot: '/tmp/codex',
      },
    }));

    await runtime.dispose();
    emitNotification('item/completed', {
      ...notification,
      item: { ...notification.item, id: 'image-after-dispose' },
    });
    await Promise.resolve();
    expect(publishGeneratedMedia).toHaveBeenCalledTimes(1);
  });

  it('publishes app-server token usage through the canonical transcript seam', async () => {
    const runtime = createRuntime({ initialModelId: 'gpt-5.4' });
    const events: CodexAppServerEvent[] = [];
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

  it('keeps Provider-bound token usage but does not apply native Codex pricing', async () => {
    const runtime = createRuntime({
      initialModelId: 'gpt-5.4',
      initialProviderBinding: providerBindingMaterialization.engineConfig,
    });
    const events: CodexAppServerEvent[] = [];
    runtime.events.subscribe((event) => events.push(event));
    await runtime.send({ v: 1, text: 'provider usage prompt' }, { turnId: 'codex-turn-provider' });

    emitNotification('thread/tokenUsage/updated', {
      threadId: 'thread-provider',
      turnId: 'turn-provider',
      tokenUsage: {
        total: {
          totalTokens: 20_019,
          inputTokens: 20_001,
          cachedInputTokens: 4_480,
          outputTokens: 18,
          reasoningOutputTokens: 10,
        },
        last: {
          totalTokens: 319,
          inputTokens: 301,
          cachedInputTokens: 80,
          outputTokens: 18,
          reasoningOutputTokens: 10,
        },
        modelContextWindow: 258_400,
      },
    });

    const usage = events.find((event) => event.kind === 'usage-observed');
    expect(usage).toMatchObject({
      kind: 'usage-observed',
      observationId: expect.stringMatching(/^codex-usage:[a-f0-9]{64}$/u),
      turnId: 'turn-provider',
      source: 'codex-app-server-token-usage',
      scope: 'session_cumulative',
      modelId: 'gpt-5.4',
      tokens: {
        input: 20_001,
        output: 18,
        reasoning: 10,
        cacheRead: 4_480,
        cacheWrite: 0,
        total: 20_019,
      },
      context: expect.objectContaining({
        modelId: 'gpt-5.4',
        usedTokens: 319,
        windowTokens: 258_400,
      }),
    });
    expect(usage).not.toHaveProperty('cost');
  });

  it('publishes a typed failed-turn issue when an accepted provider turn fails before assistant text', async () => {
    const runtime = createRuntime();
    const events: CodexAppServerEvent[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    await runtime.send({ v: 1, text: 'provider failure prompt' }, { turnId: 'codex-turn-1' });
    emitNotification(
      'turn/completed',
      failedCapacityTurn('turn-1', 'Provider rejected the accepted turn before assistant text.'),
    );

    await expect(waitForCodexAppServerRuntimeTurnCompletion(runtime))
      .rejects.toThrow('Codex app-server turn failed.');

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-failed',
      sessionId: 'session-1',
      turnId: 'codex-turn-1',
      agentTurnId: 'turn-1',
      issue: expect.objectContaining({
        code: 'codex_app_server_turn_failed',
        agentId: 'codex',
        agentTurnId: 'turn-1',
        sanitizedPreview: 'Codex app-server turn failed.',
        source: 'agent_session_error',
      }),
    }));
  });

  it('does not project provider-echoed transcript or startup content into failed-turn diagnostics', async () => {
    const providerMessageSentinel = 'VOICE_PRIVATE_MESSAGE_SENTINEL: user transcript';
    const providerAdditionalDetailsSentinel = 'VOICE_PRIVATE_DETAILS_SENTINEL: startup instructions';
    const hostilePlanTypeSentinel = 'VOICE_PRIVATE_PLAN_TYPE_SENTINEL';
    const hostileRateLimitsSentinel = 'VOICE_PRIVATE_RATE_LIMITS_SENTINEL';
    const safeFailurePreview = 'Codex app-server turn failed.';
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const runtime = createRuntime({ ctx: { logger } });
    const events: CodexAppServerEvent[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    await runtime.send({ v: 1, text: 'provider failure prompt' }, { turnId: 'codex-turn-private' });
    emitNotification(
      'turn/completed',
      failedUsageLimitTurn('turn-1', {
        message: `Provider echoed ${providerMessageSentinel}`,
        additional_details: `Provider additional details echoed ${providerAdditionalDetailsSentinel}`,
        retry_after_ms: 1_250,
        plan_type: hostilePlanTypeSentinel,
        rate_limits: {
          primary: {
            used_percent: 100,
            resets_at: 1779019200000,
            provider_note: hostileRateLimitsSentinel,
          },
        },
      }),
    );

    let rejection: unknown;
    try {
      await waitForCodexAppServerRuntimeTurnCompletion(runtime);
    } catch (error) {
      rejection = error;
    }
    await Promise.resolve();

    expect(rejection).toBeInstanceOf(Error);
    const failure = rejection as Error & { runtimeAuthClassification?: unknown };
    expect(failure.name).toBe('CodexAppServerTurnFailure');
    expect(failure.message).toBe(safeFailurePreview);
    expect(failure.stack ?? '').not.toContain(providerMessageSentinel);
    expect(failure.stack ?? '').not.toContain(providerAdditionalDetailsSentinel);
    expect(failure.stack ?? '').not.toContain(hostilePlanTypeSentinel);
    expect(failure.runtimeAuthClassification).toMatchObject({
      kind: 'usage_limit',
      source: 'structured_provider_error',
      limitCategory: 'usage_limit',
      retryAfterMs: 1_250,
      resetsAtMs: 1779019200000,
    });
    expect(failure.runtimeAuthClassification).not.toHaveProperty('planType');
    expect(failure.runtimeAuthClassification).not.toHaveProperty('rateLimits');
    expect(events).toContainEqual({
      kind: 'turn-failed',
      sessionId: 'session-1',
      turnId: 'codex-turn-private',
      agentTurnId: 'turn-1',
      emittedAtMs: expect.any(Number),
      issue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'codex_app_server_turn_failed',
        source: 'usage_limit',
        occurredAt: expect.any(Number),
        agentId: 'codex',
        agentTurnId: 'turn-1',
        sanitizedPreview: safeFailurePreview,
      },
    });
    expect(events).toContainEqual({
      kind: 'backend-error',
      sessionId: 'session-1',
      emittedAtMs: expect.any(Number),
      error: {
        code: 'codex_app_server_turn_failed',
        message: safeFailurePreview,
      },
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Codex app-server background turn completion failed',
      {
        errorName: 'CodexAppServerTurnFailure',
        runtimeIssueSource: 'usage_limit',
        runtimeAuthKind: 'usage_limit',
        runtimeAuthSource: 'structured_provider_error',
        runtimeAuthLimitCategory: 'usage_limit',
        runtimeAuthRetryAfterMs: 1_250,
        runtimeAuthResetsAtMs: 1779019200000,
      },
    );
    expect(JSON.stringify(events)).not.toContain(providerMessageSentinel);
    expect(JSON.stringify(events)).not.toContain(providerAdditionalDetailsSentinel);
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(providerMessageSentinel);
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(providerAdditionalDetailsSentinel);
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(hostilePlanTypeSentinel);
    expect(JSON.stringify(failure.runtimeAuthClassification)).not.toContain(hostileRateLimitsSentinel);
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(hostileRateLimitsSentinel);
  });

  it('retires a failed provider turn id so late activity cannot re-adopt it', async () => {
    const runtime = createRuntime();
    const events: CodexAppServerEvent[] = [];
    runtime.events.subscribe((event) => events.push(event));

    await runtime.send({ v: 1, text: 'provider failure prompt' }, { turnId: 'codex-turn-1' });
    emitNotification('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'failed',
        error: { message: 'Provider failed this turn.' },
      },
    });
    await expect(waitForCodexAppServerRuntimeTurnCompletion(runtime))
      .rejects.toThrow('Codex app-server turn failed.');

    emitNotification('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'late-item', type: 'commandExecution' },
    });

    expect(events.filter((event) => event.kind === 'turn-start')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'turn-failed')).toHaveLength(1);
    expect(runtime.isTurnInFlight()).toBe(false);
  });

  it('ignores official error notifications correlated to another thread or turn', async () => {
    const runtime = createRuntime({
      processEnv: { HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS: '0' },
    });
    const events: CodexAppServerEvent[] = [];
    runtime.events.subscribe((event) => events.push(event));

    await runtime.send({ v: 1, text: 'owned turn' }, { turnId: 'codex-turn-1' });
    emitNotification('error', {
      threadId: 'thread-other',
      turnId: 'turn-other',
      willRetry: false,
      error: { message: 'Failure from another turn.' },
    });
    emitNotification('error', {
      willRetry: false,
      error: { message: 'Malformed uncorrelated failure.' },
    });

    expect(runtime.isTurnInFlight()).toBe(true);
    emitNotification('turn/completed', completedTurn('turn-1'));
    await waitForCodexAppServerRuntimeTurnCompletion(runtime);
    expect(events.filter((event) => event.kind === 'turn-failed')).toHaveLength(0);
    expect(events.filter((event) => event.kind === 'turn-complete')).toHaveLength(1);
  });

  it('keeps the native turn authoritative when a nonterminal error is followed by primary activity', async () => {
    const runtime = createRuntime();
    const events: CodexAppServerEvent[] = [];
    runtime.events.subscribe((event) => events.push(event));

    await runtime.send({ v: 1, text: 'owned turn' }, { turnId: 'codex-turn-1' });
    emitNotification('error', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
      error: {
        message: 'Usage limit reached',
        codexErrorInfo: 'UsageLimitExceeded',
      },
    });
    emitNotification('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'continued-after-error',
      delta: 'Continued after usage warning',
    });

    expect(runtime.isTurnInFlight()).toBe(true);
    expect(runtime.canSteerPrompt()).toBe(true);
    expect(events.filter((event) => event.kind === 'turn-failed')).toHaveLength(0);

    await runtime.send(
      { v: 1, text: 'steer existing turn' },
      { deliverAs: 'steer', turnId: 'codex-turn-1' },
    );
    expect(clientState.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    expect(clientState.requests).toContainEqual({
      method: 'turn/steer',
      params: expect.objectContaining({
        expectedTurnId: 'turn-1',
      }),
    });

    emitNotification('turn/completed', completedTurn('turn-1'));
    await waitForCodexAppServerRuntimeTurnCompletion(runtime);
  });

  it('propagates one sticky unexpected app-server exit and disposal cannot double-terminalize it', async () => {
    const runtime = createRuntime();
    const events: CodexAppServerEvent[] = [];
    runtime.events.subscribe((event) => events.push(event));

    await runtime.send({ v: 1, text: 'exit during turn' }, { turnId: 'codex-turn-exit' });
    clientState.emitExit({
      exitCode: 17,
      signal: null,
      stdout: '',
      stderr: 'app-server crashed',
    });

    expect(runtime.isTurnInFlight()).toBe(false);
    expect(events.filter((event) => event.kind === 'turn-failed')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'session-ended')).toHaveLength(1);

    await runtime.dispose();
    clientState.emitExit({ exitCode: 17, signal: null, stdout: '', stderr: 'late replay' });
    expect(events.filter((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ))).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'session-ended')).toHaveLength(1);
  });

  it('uses a fresh session turn id for each runtime instance when the host does not provide one', async () => {
    const firstRuntime = createRuntime({ happierSessionId: 'session-1' });
    const firstEvents: CodexAppServerEvent[] = [];
    firstRuntime.events.subscribe((event) => {
      firstEvents.push(event);
    });

    await firstRuntime.send({ v: 1, text: 'first quota failure prompt' });
    emitNotification('turn/completed', failedUsageLimitTurn('turn-1'));
    await expect(waitForCodexAppServerRuntimeTurnCompletion(firstRuntime))
      .rejects.toThrow('Codex app-server turn failed.');

    const secondRuntime = createRuntime({ happierSessionId: 'session-1' });
    const secondEvents: CodexAppServerEvent[] = [];
    secondRuntime.events.subscribe((event) => {
      secondEvents.push(event);
    });

    await secondRuntime.send({ v: 1, text: 'second quota failure prompt' });
    emitNotification('turn/completed', failedUsageLimitTurn('turn-2'));
    await expect(waitForCodexAppServerRuntimeTurnCompletion(secondRuntime))
      .rejects.toThrow('Codex app-server turn failed.');

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
    const events: CodexAppServerEvent[] = [];
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
      const events: CodexAppServerEvent[] = [];
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
    const events: CodexAppServerEvent[] = [];
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

  it('does not publish experimental raw response function calls into the typed tool transcript', async () => {
    const runtime = createRuntime();
    const events: CodexAppServerEvent[] = [];
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

    expect(events).not.toContainEqual(expect.objectContaining({
      kind: 'tool-call',
      turnId: 'codex-turn-1',
      toolCallId: 'call-1',
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      kind: 'tool-result',
      turnId: 'codex-turn-1',
      toolCallId: 'call-1',
    }));
  });

  it('does not publish an orphan raw function-call output without its matching raw call', async () => {
    const runtime = createRuntime();
    const events: CodexAppServerEvent[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    await runtime.send({ v: 1, text: 'inspect without leaking internal outputs' }, { turnId: 'codex-turn-1' });
    emitNotification('rawResponseItem/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'item-orphan-result-1',
        type: 'function_call_output',
        call_id: 'orphan-call-1',
        output: '{"status":"internal-only"}',
      },
    });

    expect(events).not.toContainEqual(expect.objectContaining({
      kind: 'tool-result',
      turnId: 'codex-turn-1',
      toolCallId: 'orphan-call-1',
    }));
  });

  it('does not expose experimental raw response tool wrappers carried in Codex metadata passthrough', async () => {
    const runtime = createRuntime();
    const events: CodexAppServerEvent[] = [];
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

    expect(events).not.toContainEqual(expect.objectContaining({
      kind: 'tool-call',
      turnId: 'codex-turn-1',
      toolCallId: 'call-1',
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      kind: 'tool-result',
      turnId: 'codex-turn-1',
      toolCallId: 'call-1',
    }));
  });

  it('publishes completed app-server function-call items as canonical runtime tool events', async () => {
    const runtime = createRuntime();
    const events: CodexAppServerEvent[] = [];
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
    const events: CodexAppServerEvent[] = [];
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
    const fixture = createCodexTestContextFixture({ sessionId: 'session-1' });
    const runtime = createRuntime({
      ctx: { writeStateField: fixture.context.writeStateField },
    });

    await startCodexAppServerRuntime(runtime);
    emitNotification('thread/name/updated', {
      threadId: 'thread-1',
      threadName: 'Inspect repository',
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

  it('does not let experimental raw response wrappers drive Happier title state', async () => {
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

    expect(clientState.requests.some((request) => request.method === 'thread/name/set')).toBe(false);
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
    const events: CodexAppServerEvent[] = [];
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
    const events: CodexAppServerEvent[] = [];
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

  it('publishes the provider turn checkpoint without requiring a host transcript sequence', async () => {
    const runtime = createRuntime({
      processEnv: { HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS: '0' },
    });
    const events: CodexAppServerEvent[] = [];
    runtime.events.subscribe((event) => {
      events.push(event);
    });

    await runtime.send(
      { v: 1, text: 'checkpoint this completed turn' },
      { turnId: 'host-turn-checkpoint' },
    );
    const completion = waitForCodexAppServerRuntimeTurnCompletion(runtime);
    emitNotification('turn/completed', completedTurn('turn-1'));
    await completion;

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-rollback-boundary-observed',
      turnId: 'host-turn-checkpoint',
      agentTurnId: 'turn-1',
      providerCheckpoint: 'turn-1',
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      kind: 'turn-rollback-boundary-observed',
      startUserMessageSeq: expect.any(Number),
    }));
  });

  it('reconciles native rollback against the live app-server thread rather than local turn state', async () => {
    const runtime = createRuntime({
      processEnv: { HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS: '0' },
    });
    await runtime.send({ v: 1, text: 'completed before uncertain rollback' }, {
      turnId: 'host-turn-1',
      userMessageSeq: 7,
    });
    const completion = waitForCodexAppServerRuntimeTurnCompletion(runtime);
    emitNotification('turn/completed', completedTurn('turn-1'));
    await completion;

    const request = {
      operationId: 'rollback-1',
      providerSessionId: 'thread-1',
      target: { kind: 'beforeTurn', turnId: 'host-turn-1' },
      affectedTurns: [{ turnId: 'host-turn-1', providerCheckpoint: 'turn-1' }],
      runtimeIncarnationId: 'runtime-1',
    } satisfies AgentSessionConversationRollbackRequest;

    clientState.setThreadReadResult({ thread: { id: 'thread-1', turns: [] } });
    await expect(runtime.reconcileNativeConversationRollback(request)).resolves.toEqual({
      status: 'applied',
    });

    clientState.setThreadReadResult({
      thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'completed' }] },
    });
    await expect(runtime.reconcileNativeConversationRollback(request)).resolves.toEqual({
      status: 'notApplied',
    });
    expect(clientState.requests.filter(({ method }) => method === 'thread/read')).toEqual([
      { method: 'thread/read', params: { threadId: 'thread-1', includeTurns: true } },
      { method: 'thread/read', params: { threadId: 'thread-1', includeTurns: true } },
    ]);
  });

  it('surfaces the original temporary failure when the host retry fails too', async () => {
    const refreshRuntimeAuth = vi.fn(async () => ({
      status: 'unavailable' as const,
      reason: 'runtime_auth_selection_unavailable',
    }));
    const runtime = createRuntime({
      ctx: {
        auth: {
          services: {
            refreshRuntimeAuth,
          },
        },
      },
    });
    const events: CodexAppServerEvent[] = [];
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
      failedUsageLimitTurn('turn-2'),
    );

    let rejection: unknown;
    try {
      await waitForCompletion;
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('Codex app-server turn failed.');
    expect((rejection as Error & { runtimeAuthClassification?: unknown }).runtimeAuthClassification)
      .toMatchObject({
        kind: 'capacity',
        limitCategory: 'capacity',
        quotaScope: 'provider',
      });
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

  it('retries an unaccepted recoverable failure internally', async () => {
    clientState.deferTurnStartForPrompt('recoverable before acceptance');
    const runtime = createRuntime();

    const send = runtime.send(
      { v: 1, text: 'recoverable before acceptance' },
      {
        localInputId: ' local-recoverable-before-acceptance ',
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
    expect(clientState.requests.filter((request) => request.method === 'turn/start').at(-1)).toMatchObject({
      params: expect.objectContaining({
        input: [{ type: 'text', text: expect.any(String) }],
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

  it('keeps a provider-bound non-reasoning model authoritative over later reasoning requests', async () => {
    const runtime = createRuntime({
      initialModelId: 'non-reasoning-model',
      initialProviderBinding: providerBindingMaterialization.engineConfig,
    });

    await runtime.updateConfig?.({
      configOption: {
        id: 'reasoning_effort',
        value: 'high',
      },
    });
    await runtime.send({ v: 1, text: 'safe prompt' });

    expect(clientState.requests.find((request) => request.method === 'thread/start')).toMatchObject({
      method: 'thread/start',
      params: expect.objectContaining({
        config: expect.objectContaining({
          model_reasoning_effort: 'none',
        }),
      }),
    });
    expect(clientState.requests.find((request) => request.method === 'turn/start')).toMatchObject({
      method: 'turn/start',
      params: expect.objectContaining({
        effort: 'none',
      }),
    });
  });

  it.each([
    {
      label: 'model',
      initialUpdate: null,
      updateWhileAttached: { modelId: 'gpt-5.4' },
      updateAfterStop: { modelId: 'gpt-5.5' },
    },
    {
      label: 'permission',
      initialUpdate: { permissionMode: 'read-only' },
      updateWhileAttached: { permissionMode: 'safe-yolo' },
      updateAfterStop: { permissionMode: 'yolo' },
    },
  ])('keeps the exact empty thread attached across $label config changes until realtime stops', async ({
    initialUpdate,
    updateWhileAttached,
    updateAfterStop,
  }) => {
    const runtime = createRuntime();
    if (initialUpdate) await runtime.updateConfig?.(initialUpdate);
    await startCodexAppServerRuntime(runtime);
    const realtimeHandle = await startActiveRealtimeAttachment(runtime);

    await runtime.updateConfig?.(updateWhileAttached);

    expect(runtime.identity.read()).toEqual({ providerSessionId: 'thread-1' });

    await expect(realtimeHandle.stop()).resolves.toEqual({ status: 'stopped' });
    await runtime.updateConfig?.(updateAfterStop);

    expect(runtime.identity.read()).toEqual({ providerSessionId: null });
    await runtime.dispose();
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
              return { status: 'recorded' };
            },
            adoptProvisionalRecord: async (input: unknown) => {
              adoptions.push(input);
              return { status: 'adopted' };
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

  it('records app-server rate-limit reads with one provider-owned applied group identity', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-usage-group-'));
    const records: unknown[] = [];
    const adoptions: unknown[] = [];
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({
          tokens: {
            id_token: buildJwt({ email: 'group@example.test', exp: 4_102_444_800 }),
            access_token: 'group-access-token',
            account_id: 'acct_plugin_group',
          },
        }),
      );

      const runtime = createRuntime({
        processEnv: {
          CODEX_HOME: codexHome,
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'primary-group',
            activeProfileId: 'backup',
            generation: 17,
          }]),
        },
        accountUsage: createAccountUsageService({
            resolveSourceContext: async () => ({
              serviceId: 'openai-codex',
              profileId: 'backup',
              bindingKind: 'group_member',
              groupId: 'primary-group',
            }),
            recordSnapshot: async (input: unknown) => {
              records.push(input);
              return { status: 'recorded' };
            },
            adoptProvisionalRecord: async (input: unknown) => {
              adoptions.push(input);
              return { status: 'adopted' };
            },
          }),
      });

      await startCodexAppServerRuntime(runtime);
      await waitForUsageRecordCount(records, 1);

      expect(records[0]).toMatchObject({
        source: {
          serviceId: 'openai-codex',
        },
        snapshot: {
          providerId: 'openai-codex',
          accountSubject: {
            kind: 'providerSubject',
            id: 'acct_plugin_group',
          },
        },
      });
      expect((records[0] as { source?: unknown }).source).toEqual({
        serviceId: 'openai-codex',
      });
      expect(records[0]).not.toHaveProperty('appliedIdentity');
      expect(adoptions[0]).toMatchObject({
        adoption: {
          proof: { kind: 'provider_account_id_match' },
        },
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('does not attribute delayed quota bytes to a connected-service identity applied after the provider read began', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-quota-epoch-'));
    const records: unknown[] = [];
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({
          tokens: {
            id_token: buildJwt({ email: 'old@example.test', exp: 4_102_444_800 }),
            access_token: 'old-access-token',
            account_id: 'acct_old',
          },
        }),
      );
      clientState.deferNextRateLimitsRead();
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: {
          CODEX_HOME: codexHome,
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'primary-group',
            activeProfileId: 'old-profile',
            generation: 17,
          }]),
        },
        accountUsage: createAccountUsageService({
          recordSnapshot: async (input: unknown) => {
            records.push(input);
            return { status: 'recorded' };
          },
        }),
      }));

      await startCodexAppServerRuntime(runtime);
      await waitForRequestCount('account/rateLimits/read', 1);
      await expect(runtime.runtimeAuth.apply({
        serviceId: 'openai-codex',
        reason: 'manual',
        requireDirectLiveHotApply: true,
        expected: {
          profileId: 'target',
          groupId: 'primary-group',
          generation: 18,
        },
        authGeneration: {
          credential: buildConnectedCodexCredential('target'),
          forcedWorkspaceId: 'acct_target',
          selection: {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'primary-group',
            activeProfileId: 'target',
            generation: 18,
          },
        },
      })).resolves.toMatchObject({ ok: true, activeAccountId: 'acct_target' });

      clientState.resolveDeferredRateLimitsRead({
        rateLimits: {
          primary: { used_percent: 73, resets_at: 1779019200000 },
        },
        plan_type: 'pro',
      });
      const delayedRecord = await waitForUsageRecordMatching(records, (record) => (
        (record as { snapshot?: { meters?: Array<{ utilizationPct?: unknown }> } }).snapshot?.meters?.[0]?.utilizationPct === 73
      ));

      expect(delayedRecord).not.toHaveProperty('source');
      expect(delayedRecord).not.toHaveProperty('appliedIdentity');
      expect(delayedRecord).toMatchObject({
        snapshot: {
          accountSubject: { kind: 'provisionalLocalSubject' },
        },
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('classifies a delayed turn failure with the credential identity that launched the provider turn', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-turn-credential-epoch-'));
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({
          tokens: {
            id_token: buildJwt({ email: 'same@example.test', exp: 4_102_444_800 }),
            access_token: 'old-access-token',
            account_id: 'acct_same',
          },
        }),
      );
      const runtime = createRuntime({
        processEnv: {
          CODEX_HOME: codexHome,
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'same-profile',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          }]),
        },
        ctx: {
          auth: {
            services: {
              refreshRuntimeAuth: async () => ({
                status: 'refreshed',
                result: {
                  accessToken: 'new-access-token',
                  chatgptAccountId: 'acct_same',
                  chatgptPlanType: 'plus',
                  credentialRevision: 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1',
                },
              }),
            },
          },
        },
      });

      await runtime.send({ v: 1, text: 'credential epoch prompt' }, { turnId: 'codex-turn-credential-epoch' });
      await clientState.invokeRequestHandler('account/chatgptAuthTokens/refresh', {
        chatgptPlanType: 'plus',
      });
      emitNotification('turn/completed', failedUsageLimitTurn('turn-1'));

      let failure: unknown;
      try {
        await waitForCodexAppServerRuntimeTurnCompletion(runtime);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error & { runtimeAuthClassification?: unknown }).runtimeAuthClassification).toMatchObject({
        sourceProviderAccountId: 'acct_same',
        failingAccessTokenFingerprint: computeCodexAccessTokenFingerprint('old-access-token'),
      });
      expect((failure as Error & { runtimeAuthClassification?: unknown }).runtimeAuthClassification).not.toMatchObject({
        failingAccessTokenFingerprint: computeCodexAccessTokenFingerprint('new-access-token'),
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('keeps provider-started turn failure identity provisional when no local request can correlate it', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-provider-started-epoch-'));
    try {
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'provider-started@example.test', exp: 4_102_444_800 }),
          access_token: 'provider-started-access',
          account_id: 'acct_provider_started',
        },
      }));
      const runtime = createRuntime({
        processEnv: {
          CODEX_HOME: codexHome,
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'provider-started-profile',
          }]),
        },
      });

      await startCodexAppServerRuntime(runtime);
      emitNotification('turn/started', { threadId: 'thread-1', turnId: 'provider-turn-1' });
      emitNotification('turn/completed', failedUsageLimitTurn('provider-turn-1'));

      let failure: unknown;
      try {
        await waitForCodexAppServerRuntimeTurnCompletion(runtime);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const classification = (failure as Error & { runtimeAuthClassification?: unknown }).runtimeAuthClassification;
      expect(classification).not.toHaveProperty('sourceProviderAccountId');
      expect(classification).not.toHaveProperty('failingAccessTokenFingerprint');
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('keeps usage-limit quota evidence provisional when live account and auth-store identity disagree', async () => {
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
          recordSnapshot: async (input: unknown) => {
            records.push(input);
            return { status: 'recorded' };
          },
        }),
      });

      await runtime.send({ v: 1, text: 'use the current account' });
      emitNotification('turn/completed', failedUsageLimitTurn('turn-1'));
      await expect(waitForCodexAppServerRuntimeTurnCompletion(runtime))
        .rejects.toThrow('Codex app-server turn failed.');
      const liveAccountRecord = await waitForUsageRecordMatching(records, (record) => (
        (record as { snapshot?: { accountSubject?: { kind?: unknown } } }).snapshot?.accountSubject?.kind
          === 'provisionalLocalSubject'
      ));

      expect(clientState.requests.some((request) => request.method === 'account/read')).toBe(true);
      expect(liveAccountRecord).toMatchObject({
        snapshot: {
          providerId: 'openai-codex',
          accountSubject: {
            kind: 'provisionalLocalSubject',
          },
          accountLabel: null,
          meters: [
            expect.objectContaining({
              utilizationPct: 100,
            }),
          ],
        },
      });
      expect(liveAccountRecord).not.toHaveProperty('source');
      expect(liveAccountRecord).not.toHaveProperty('appliedIdentity');
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
            return { status: 'recorded' };
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

  it('keeps uncorrelated rate-limit notifications provisional for connected-service sessions', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-notification-epoch-'));
    const records: unknown[] = [];
    try {
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
        tokens: {
          id_token: buildJwt({ email: 'notification@example.test', exp: 4_102_444_800 }),
          access_token: 'notification-access',
          account_id: 'acct_notification',
        },
      }));
      const runtime = createRuntime({
        happierSessionId: 'session-connected-notification',
        processEnv: {
          CODEX_HOME: codexHome,
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'notification-group',
            activeProfileId: 'notification-profile',
            generation: 9,
          }]),
        },
        accountUsage: createAccountUsageService({
          recordSnapshot: async (input: unknown) => {
            records.push(input);
            return { status: 'recorded' };
          },
        }),
      });

      await startCodexAppServerRuntime(runtime);
      await waitForUsageRecordCount(records, 1);
      emitNotification('account/rateLimits/updated', {
        rateLimits: {
          primary: { used_percent: 64, resets_at: 1779019200000 },
        },
      });
      const notificationRecord = await waitForUsageRecordMatching(records, (record) => (
        (record as { snapshot?: { meters?: Array<{ utilizationPct?: unknown }> } }).snapshot?.meters?.[0]?.utilizationPct === 64
      ));

      expect(notificationRecord).not.toHaveProperty('source');
      expect(notificationRecord).not.toHaveProperty('appliedIdentity');
      expect(notificationRecord).toMatchObject({
        snapshot: { accountSubject: { kind: 'provisionalLocalSubject' } },
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('does not join a mismatched live quota account to the frozen applied group identity', async () => {
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
              return { status: 'recorded' };
            },
          }),
      }));

      await runtime.send({ v: 1, text: 'quota failure prompt' }, { turnId: 'codex-turn-1' });
      emitNotification('turn/completed', failedUsageLimitTurn('turn-1'));
      await expect(waitForCodexAppServerRuntimeTurnCompletion(runtime))
        .rejects.toThrow('Codex app-server turn failed.');
      const mismatchRecord = await waitForUsageRecordMatching(records, (record) => (
        Boolean(record)
        && typeof record === 'object'
        && !Array.isArray(record)
        && (record as Readonly<{ snapshot?: { accountSubject?: { kind?: unknown } } }>).snapshot?.accountSubject?.kind
          === 'provisionalLocalSubject'
      ));
      expect(mismatchRecord).not.toHaveProperty('source');
      expect(mismatchRecord).not.toHaveProperty('appliedIdentity');
      expect(mismatchRecord).toHaveProperty('policyDisposition', 'evidence_only');

      await expect(runtime.runtimeAuth.readIdentity({
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
          providerAccountId: 'acct_seeded_stale',
          accountLabel: 'seeded@example.test',
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

  it('applies connected-service auth through the running app-server client and refreshes later with the new selection', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-live-auth-'));
    const refreshRequests: unknown[] = [];
    let returnPendingAttemptOnce = true;
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
                if (returnPendingAttemptOnce) {
                  returnPendingAttemptOnce = false;
                  return {
                    status: 'pending',
                    refreshAttemptId: (request as { refreshAttemptId: string }).refreshAttemptId,
                  };
                }
                return {
                  status: 'refreshed',
                  result: {
                    accessToken: 'fresh-target-access',
                    chatgptAccountId: 'acct_target',
                    chatgptPlanType: 'plus',
                    credentialRevision: 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1',
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

      const appliedAuth = await runtime.runtimeAuth.apply({
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
          credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          forcedWorkspaceId: 'acct_target',
          selection,
        },
      });
      expect(appliedAuth).toEqual({
        ok: true,
        appliedVia: 'direct_live_hot_auth',
        activeAccountId: 'acct_target',
        verification: {
          activeAccountId: 'acct_target',
          providerAccountId: 'acct_target',
          proofStrength: 'exact',
          source: 'applied_credential',
          generationApplication: {
            serviceId: 'openai-codex',
            groupId: 'team',
            profileId: 'target',
            generation: 12,
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            credentialFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{8}$/u),
          },
        },
        durability: {
          persisted: true,
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
      expect(refreshRequests).toEqual([
        expect.objectContaining({
          serviceId: 'openai-codex',
          refreshAttemptId: expect.any(String),
          expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        }),
        expect.objectContaining({
          serviceId: 'openai-codex',
          refreshAttemptId: expect.any(String),
          selection,
          planType: 'plus',
          failingAccessTokenFingerprint: 'sha256:203e5112',
          expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          reason: 'chatgpt_auth_tokens_refresh',
        }),
      ]);
      expect(refreshRequests.every((request) => !Object.prototype.hasOwnProperty.call(request, 'agentId')))
        .toBe(true);
      expect((refreshRequests[1] as { refreshAttemptId: string }).refreshAttemptId)
        .toBe((refreshRequests[0] as { refreshAttemptId: string }).refreshAttemptId);

      await expect(clientState.invokeRequestHandler('account/chatgptAuthTokens/refresh', {
        chatgptPlanType: 'plus',
      })).resolves.toEqual({
        accessToken: 'fresh-target-access',
        chatgptAccountId: 'acct_target',
        chatgptPlanType: 'plus',
      });
      expect(refreshRequests[2]).toEqual(expect.objectContaining({
        expectedCredentialRevision: 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1',
      }));
      expect((refreshRequests[2] as { refreshAttemptId: string }).refreshAttemptId)
        .not.toBe((refreshRequests[0] as { refreshAttemptId: string }).refreshAttemptId);
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
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
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
                    credentialRevision: 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1',
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
      expect(refreshRequests[0]).not.toHaveProperty('agentId');
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

      await runtime.runtimeAuth.apply({
        serviceId: 'openai-codex',
        authGeneration: {
          credential,
          credentialRevision: 'csr_abcdefghijklmnopqrstuv',
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

      await expect(runtime.runtimeAuth.readIdentity({
        serviceId: 'openai-codex',
        expected: {
          profileId: 'target',
          groupId: 'team',
          generation: 12,
          credentialRevision: 'csr_abcdefghijklmnopqrstuv',
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
          credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        },
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('reports connected-service auth switching unsafe while realtime retains thread authority', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-realtime-identity-'));
    try {
      await mkdir(codexHome, { recursive: true });
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: { CODEX_HOME: codexHome },
      }));

      await runtime.runtimeAuth.apply({
        serviceId: 'openai-codex',
        authGeneration: {
          credential: buildConnectedCodexCredential('target'),
          credentialRevision: 'csr_abcdefghijklmnopqrstuv',
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
      await startCodexAppServerRuntime(runtime);
      const realtimeHandle = await startActiveRealtimeAttachment(runtime);

      await expect(runtime.runtimeAuth.readIdentity({
        serviceId: 'openai-codex',
      })).resolves.toMatchObject({
        ok: true,
        runtime: {
          safeToProbe: true,
          safeToApply: false,
          inProviderTurn: false,
        },
      });

      await expect(realtimeHandle.stop()).resolves.toEqual({ status: 'stopped' });

      await expect(runtime.runtimeAuth.readIdentity({
        serviceId: 'openai-codex',
      })).resolves.toMatchObject({
        ok: true,
        runtime: {
          safeToProbe: true,
          safeToApply: false,
          inProviderTurn: false,
        },
      });
      await runtime.dispose();
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('blocks realtime identity changes without provider mutation and applies the exact binding once after runtime replacement', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-realtime-auth-fence-'));
    try {
      await mkdir(codexHome, { recursive: true });
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: { CODEX_HOME: codexHome },
      }));
      const initialRequest = {
        serviceId: 'openai-codex',
        authGeneration: {
          credential: buildConnectedCodexCredential('target'),
          credentialRevision: 'csr_abcdefghijklmnopqrstuv',
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
      };
      await expect(runtime.runtimeAuth.apply(initialRequest))
        .resolves.toMatchObject({ ok: true, activeAccountId: 'acct_target' });
      await startCodexAppServerRuntime(runtime);
      const realtimeHandle = await startActiveRealtimeAttachment(runtime);
      const authStoreBeforeIdentityChange = await readFile(join(codexHome, 'auth.json'), 'utf8');
      const loginCountBeforeIdentityChange = clientState.requests.filter(
        ({ method }) => method === 'account/login/start',
      ).length;
      const identityChangeRequest = {
        serviceId: 'openai-codex',
        authGeneration: {
          credential: buildConnectedCodexCredential('backup'),
          credentialRevision: 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1',
          forcedWorkspaceId: 'acct_target',
          selection: {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            activeProfileId: 'backup',
            fallbackProfileId: 'target',
            generation: 13,
          },
        },
      };

      await expect(runtime.runtimeAuth.apply(identityChangeRequest))
        .resolves.toMatchObject({
          ok: false,
          errorCode: 'auth_identity_change_restart_required',
          recovery: 'restart_resume',
        });
      expect(clientState.requests.filter(
        ({ method }) => method === 'account/login/start',
      )).toHaveLength(loginCountBeforeIdentityChange);
      await expect(readFile(join(codexHome, 'auth.json'), 'utf8'))
        .resolves.toBe(authStoreBeforeIdentityChange);

      await expect(realtimeHandle.stop()).resolves.toEqual({ status: 'stopped' });
      await expect(runtime.runtimeAuth.apply(identityChangeRequest))
        .resolves.toMatchObject({
          ok: false,
          errorCode: 'auth_identity_change_restart_required',
          recovery: 'restart_resume',
        });
      expect(clientState.requests.filter(
        ({ method }) => method === 'account/login/start',
      )).toHaveLength(loginCountBeforeIdentityChange);
      await runtime.dispose();

      const replacementRuntime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: { CODEX_HOME: codexHome },
      }));
      await expect(replacementRuntime.runtimeAuth.apply(identityChangeRequest))
        .resolves.toMatchObject({
          ok: true,
          activeAccountId: 'acct_target',
        });
      expect(clientState.requests.filter(
        ({ method }) => method === 'account/login/start',
      )).toHaveLength(loginCountBeforeIdentityChange + 1);
      await replacementRuntime.dispose();
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('keeps a same-binding credential refresh continuous during realtime', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-realtime-auth-refresh-'));
    try {
      await mkdir(codexHome, { recursive: true });
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: { CODEX_HOME: codexHome },
      }));
      const selection = {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'target',
      };
      await runtime.runtimeAuth.apply({
        serviceId: 'openai-codex',
        authGeneration: {
          credential: buildConnectedCodexCredential('target'),
          credentialRevision: 'csr_abcdefghijklmnopqrstuv',
          forcedWorkspaceId: 'acct_target',
          selection,
        },
      });
      await startCodexAppServerRuntime(runtime);
      const realtimeHandle = await startActiveRealtimeAttachment(runtime);
      const refreshedCredential = buildConnectedCodexCredential('target');
      const loginCountBeforeRefresh = clientState.requests.filter(
        ({ method }) => method === 'account/login/start',
      ).length;

      await expect(runtime.runtimeAuth.apply({
        serviceId: 'openai-codex',
        authGeneration: {
          credential: {
            ...refreshedCredential,
            oauth: {
              ...refreshedCredential.oauth,
              accessToken: 'refreshed-target-access',
              refreshToken: 'refreshed-target-refresh',
            },
          },
          credentialRevision: 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1',
          forcedWorkspaceId: 'acct_target',
          selection,
        },
      })).resolves.toMatchObject({
        ok: true,
        activeAccountId: 'acct_target',
      });
      expect(clientState.requests.filter(
        ({ method }) => method === 'account/login/start',
      )).toHaveLength(loginCountBeforeRefresh + 1);
      await expect(realtimeHandle.stop()).resolves.toEqual({ status: 'stopped' });
      await runtime.dispose();
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

      await runtime.runtimeAuth.apply({
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

      await expect(runtime.runtimeAuth.readIdentity({
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

  it('reports the exact current runtime fact when the expected connected-service group is stale', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-group-boundary-'));
    try {
      await mkdir(codexHome, { recursive: true });
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: { CODEX_HOME: codexHome },
      }));

      await runtime.runtimeAuth.apply({
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

      await expect(runtime.runtimeAuth.readIdentity({
        serviceId: 'openai-codex',
        expected: {
          profileId: 'target',
          groupId: 'other-team',
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

      await expect(runtime.runtimeAuth.readIdentity({
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

  it('does not synthesize exact runtime identity for cold siblings without a frozen applied identity', async () => {
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

      await expect(runtime.runtimeAuth.readIdentity({
        serviceId: 'openai-codex',
        expected: {
          profileId: 'stale-profile',
          groupId: 'team',
          generation: 1,
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

  it('does not synthesize exact runtime identity from daemon expected context when local applied identity is missing', async () => {
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

      await expect(runtime.runtimeAuth.readIdentity({
        serviceId: 'openai-codex',
        reason: 'same_provider_account_exhausted',
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

      await expect(runtime.runtimeAuth.readIdentity({
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

  it('blocks a connected-service identity change during an in-flight turn without interrupting that turn', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-live-auth-busy-'));
    try {
      await mkdir(codexHome, { recursive: true });
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: { CODEX_HOME: codexHome },
      }));
      await runtime.runtimeAuth.apply({
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
      });
      clientState.deferTurnStartForPrompt('busy prompt');
      const send = runtime.send({ v: 1, text: 'busy prompt' });
      await waitForRequestCount('turn/start', 1);
      const loginCountBeforeIdentityChange = clientState.requests.filter(
        ({ method }) => method === 'account/login/start',
      ).length;

      await expect(runtime.runtimeAuth.apply({
        serviceId: 'openai-codex',
        reason: 'same_provider_account_exhausted',
        requireDirectLiveHotApply: true,
        authGeneration: {
          credential: buildConnectedCodexCredential('backup'),
          forcedWorkspaceId: 'acct_target',
          selection: {
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'backup',
          },
        },
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'auth_identity_change_restart_required',
        recovery: 'restart_resume',
      });

      expect(clientState.requests.filter(
        ({ method }) => method === 'account/login/start',
      )).toHaveLength(loginCountBeforeIdentityChange);
      clientState.resolveDeferredTurnStart('turn-busy');
      await send;
      const completion = waitForCodexAppServerRuntimeTurnCompletion(runtime);
      emitNotification('turn/completed', completedTurn('turn-busy'));
      await completion;
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('keeps a new turn behind an idle auth apply while provider login is pending', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-live-auth-race-'));
    try {
      await mkdir(codexHome, { recursive: true });
      clientState.deferNextLoginStart();
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: { CODEX_HOME: codexHome },
      }));

      const apply = runtime.runtimeAuth.apply({
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
      });
      await waitForRequestCount('account/login/start', 1);

      const send = runtime.send({ v: 1, text: 'after auth apply' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(clientState.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(0);

      clientState.resolveDeferredLoginStart();
      await expect(apply).resolves.toMatchObject({
        ok: true,
        appliedVia: 'direct_live_hot_auth',
        activeAccountId: 'acct_target',
      });
      await send;
      const completion = waitForCodexAppServerRuntimeTurnCompletion(runtime);
      emitNotification('turn/completed', completedTurn('turn-1'));
      await completion;
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('does not persist through a replaced runtime after provider token injection completes', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-live-auth-replaced-'));
    try {
      await mkdir(codexHome, { recursive: true });
      clientState.deferNextLoginStart();
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: { CODEX_HOME: codexHome },
      }));

      const apply = runtime.runtimeAuth.apply({
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
      });
      await waitForRequestCount('account/login/start', 1);

      await runtime.dispose();
      clientState.resolveDeferredLoginStart();
      await expect(apply).resolves.toMatchObject({
        ok: false,
        errorCode: 'auth_store_persistence_failed_after_live_apply',
        appliedVia: 'direct_live_hot_auth',
        activeAccountId: 'acct_target',
        durability: {
          persisted: false,
          errorCode: 'auth_store_persistence_failed_after_live_apply',
        },
      });
      await expect(readFile(join(codexHome, 'auth.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('serializes duplicate generation applies before admitting the next turn', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-live-auth-duplicate-'));
    try {
      await mkdir(codexHome, { recursive: true });
      clientState.deferNextLoginStart();
      const runtime = asConnectedServiceAuthRuntime(createRuntime({
        processEnv: { CODEX_HOME: codexHome },
      }));
      const request = {
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
      };

      const firstApply = runtime.runtimeAuth.apply(request);
      await waitForRequestCount('account/login/start', 1);
      const duplicateApply = runtime.runtimeAuth.apply(request);
      const send = runtime.send({ v: 1, text: 'after duplicate auth apply' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(clientState.requests.filter(({ method }) => method === 'account/login/start')).toHaveLength(1);
      expect(clientState.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(0);

      clientState.resolveDeferredLoginStart();
      await expect(Promise.all([firstApply, duplicateApply])).resolves.toEqual([
        expect.objectContaining({ ok: true, activeAccountId: 'acct_target' }),
        expect.objectContaining({ ok: true, activeAccountId: 'acct_target' }),
      ]);
      expect(clientState.requests.filter(({ method }) => method === 'account/login/start')).toHaveLength(2);
      await send;
      const completion = waitForCodexAppServerRuntimeTurnCompletion(runtime);
      emitNotification('turn/completed', completedTurn('turn-1'));
      await completion;
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('delivers successful in-flight steers to the active provider turn', async () => {
    const runtime = createRuntime();
    await runtime.send({ v: 1, text: 'original prompt' });

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
  });

  it('accepts a correlated steer only at the provider user-message boundary', async () => {
    const runtime = createRuntime();
    await runtime.send({ v: 1, text: 'original prompt' }, { turnId: 'host-turn-287' });

    let settled = false;
    const steering = runtime.send(
      { v: 1, text: 'correlated steer' },
      {
        deliverAs: 'steer',
        localInputId: 'pending-steer-287',
        localInputIds: ['pending-steer-287'],
        userMessageSeq: 287,
        turnId: 'host-turn-287',
      },
    ).then((result) => {
      settled = true;
      return result;
    });

    await waitForRequestCount('turn/steer', 1);
    expect(clientState.requests.at(-1)).toMatchObject({
      method: 'turn/steer',
      params: expect.objectContaining({
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        clientUserMessageId: 'pending-steer-287',
      }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    emitNotification('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'provider-user-message-287',
        type: 'userMessage',
        clientId: 'pending-steer-287',
      },
    });

    await expect(steering).resolves.toEqual({ status: 'accepted' });
  });

  it('does not leave correlated steer custody pending after its provider turn ends without an echo', async () => {
    const runtime = createRuntime();
    await runtime.send({ v: 1, text: 'original prompt' }, { turnId: 'host-turn-288' });

    const steering = runtime.send(
      { v: 1, text: 'unconfirmed steer' },
      {
        deliverAs: 'steer',
        localInputId: 'pending-steer-unconfirmed',
        localInputIds: ['pending-steer-unconfirmed'],
        userMessageSeq: 288,
        turnId: 'host-turn-288',
      },
    );
    await waitForRequestCount('turn/steer', 1);

    emitNotification('turn/completed', completedTurn('turn-1'));

    await expect(steering).rejects.toThrow(
      'Codex provider turn ended before correlated user-message acceptance was observed',
    );
  });

  it('keeps the foreground turn active when an invoked turn/steer throws', async () => {
    const runtime = createRuntime();
    await runtime.send({ v: 1, text: 'original prompt' });
    clientState.failNextSteer();

    await expect(runtime.send(
      { v: 1, text: 'ambiguous exact steer' },
      {
        deliverAs: 'steer',
        localInputId: 'local-ambiguous-steer',
        localInputIds: ['local-ambiguous-steer'],
        userMessageSeq: 103,
      },
    )).rejects.toThrow('Codex app-server steer failed');

    expect(runtime.isTurnInFlight()).toBe(true);
  });

  it('does not let a delayed turn start response settle an overlapping steer prompt', async () => {
    clientState.deferTurnStartForPrompt('overlap start');
    const runtime = createRuntime();

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
    expect(clientState.requests.filter((request) => request.method === 'turn/steer')).toHaveLength(1);

    clientState.resolveDeferredSteer();
    await steerSend;
    expect(clientState.requests.filter((request) => request.method === 'turn/steer')).toHaveLength(1);
  });

  it('keeps an active turn steerable and waits for the provider turn id before steering', async () => {
    clientState.deferTurnStartForPrompt('provider id delayed');
    const runtime = createRuntime();

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
  });

  it('interrupts the coding turn without stopping an active realtime attachment', async () => {
    const runtime = createRuntime();
    await runtime.send({ v: 1, text: 'coding turn remains separate from realtime' });

    const starting = runtime.realtimeConversation.start({
      transport: { kind: 'webrtc', offerSdp: 'offer' },
    });
    await waitForRequestCount('thread/realtime/start', 1);
    emitNotification('thread/realtime/started', {
      threadId: 'thread-1',
      realtimeSessionId: null,
      version: 'v3',
    });
    emitNotification('thread/realtime/sdp', {
      threadId: 'thread-1',
      sdp: 'answer',
    });
    const started = await starting;
    expect(started.status).toBe('started');
    if (started.status !== 'started') throw new Error('Expected Codex realtime to start');
    const realtimeEvents: unknown[] = [];
    const watch = started.handle.watch((event) => realtimeEvents.push(event));

    const cancellation = runtime.cancel();
    await waitForRequestCount('turn/interrupt', 1);
    expect(clientState.requests.filter(
      ({ method }) => method === 'thread/realtime/stop',
    )).toHaveLength(0);
    expect(realtimeEvents).toEqual([]);

    emitNotification('turn/interrupted', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'interrupted' },
    });
    await expect(cancellation).resolves.toEqual({ status: 'cancelled' });
    expect(runtime.isTurnInFlight()).toBe(false);
    await expect(runtime.realtimeConversation.start({
      transport: { kind: 'webrtc', offerSdp: 'second-offer' },
    })).resolves.toEqual({ status: 'busy' });
    expect(clientState.requests.filter(
      ({ method }) => method === 'thread/realtime/stop',
    )).toHaveLength(0);
    expect(realtimeEvents).toEqual([]);

    await expect(started.handle.stop()).resolves.toEqual({ status: 'stopped' });
    expect(clientState.requests.filter(
      ({ method }) => method === 'thread/realtime/stop',
    )).toHaveLength(1);
    expect(realtimeEvents).toEqual([{ kind: 'terminal', reason: 'stopped' }]);
    watch.dispose();
    await runtime.dispose();
  });

  it('interrupts a late provider turn when cancellation wins before turn start returns', async () => {
    clientState.deferTurnStartForPrompt('cancel before provider id');
    const runtime = createRuntime();
    const events: CodexAppServerEvent[] = [];
    runtime.events.subscribe((event) => events.push(event));

    const send = runtime.send(
      { v: 1, text: 'cancel before provider id' },
      { userMessageSeq: 12 },
    );
    await waitForRequestCount('turn/start', 1);

    await expect(runtime.cancel()).resolves.toEqual({ status: 'cancelled' });

    emitNotification('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-cancelled-late', status: 'inProgress', items: [] },
    });
    expect(runtime.isTurnInFlight()).toBe(false);

    clientState.rejectNextInterruptAsAlreadyCompleted();
    clientState.resolveDeferredTurnStart('turn-cancelled-late');
    await send.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 75));

    emitNotification('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-cancelled-late',
      item: { id: 'late-item', type: 'commandExecution' },
    });

    expect(clientState.requests.filter((request) => (
      request.method === 'turn/interrupt'
      && JSON.stringify(request.params) === JSON.stringify({
        threadId: 'thread-1',
        turnId: 'turn-cancelled-late',
      })
    ))).toHaveLength(2);
    expect(clientState.requests).toContainEqual({
      method: 'turn/interrupt',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-cancelled-late',
      },
    });
    expect(runtime.canSteerPrompt()).toBe(false);
    expect(events.filter((event) => event.kind === 'turn-start')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'turn-cancelled')).toHaveLength(1);
    expect(events.filter((event) => (
      event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled'
    ))).toHaveLength(1);
  });

  it('reconciles cancellation with a provider completion already in the local settling window', async () => {
    const runtime = createRuntime({
      processEnv: { HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS: '1000' },
    });
    const events: CodexAppServerEvent[] = [];
    runtime.events.subscribe((event) => events.push(event));

    await runtime.send({ v: 1, text: 'provider completes before interrupt' });
    emitNotification('turn/completed', completedTurn('turn-1'));
    clientState.rejectNextInterruptAsAlreadyCompleted();

    await expect(runtime.cancel()).resolves.toEqual({ status: 'cancelled' });
    await waitForCodexAppServerRuntimeTurnCompletion(runtime);

    expect(events.filter((event) => event.kind === 'turn-complete')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'turn-cancelled')).toHaveLength(0);
  });

  it('waits for a provider completion delivered after the provider reports no active turn to interrupt', async () => {
    const runtime = createRuntime({
      processEnv: { HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS: '0' },
    });
    const events: CodexAppServerEvent[] = [];
    runtime.events.subscribe((event) => events.push(event));

    await runtime.send({ v: 1, text: 'provider completes before its terminal notification' });
    clientState.rejectNextInterruptAsAlreadyCompleted();

    const cancel = runtime.cancel();
    setTimeout(() => {
      emitNotification('turn/completed', completedTurn('turn-1'));
    }, 0);

    await expect(cancel).resolves.toEqual({ status: 'cancelled' });
    await waitForCodexAppServerRuntimeTurnCompletion(runtime);

    expect(events.filter((event) => event.kind === 'turn-complete')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'turn-cancelled')).toHaveLength(0);
  });

  it('accepts exact provider terminal proof when the interrupt response is lost', async () => {
    const runtime = createRuntime({
      processEnv: { HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS: '0' },
    });

    await runtime.send({ v: 1, text: 'interrupt acknowledgement is lost' });
    clientState.rejectNextInterruptWith(new Error('turn/interrupt response timed out'));

    const cancel = runtime.cancel();
    setTimeout(() => {
      emitNotification('turn/interrupted', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'interrupted' },
      });
    }, 100);

    await expect(cancel).resolves.toEqual({ status: 'cancelled' });
    expect(runtime.isTurnInFlight()).toBe(false);
  });

  it('retries interruption when the provider turn has started but is not yet interruptible', async () => {
    const runtime = createRuntime();
    const events: CodexAppServerEvent[] = [];
    runtime.events.subscribe((event) => events.push(event));

    await runtime.send({ v: 1, text: 'provider start registration races interruption' });
    clientState.rejectNextInterruptAsAlreadyCompleted();

    const cancel = runtime.cancel();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(clientState.requests.filter((request) => request.method === 'turn/interrupt')).toHaveLength(2);
    emitNotification('turn/interrupted', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'interrupted' },
    });

    await expect(cancel).resolves.toEqual({ status: 'cancelled' });
    expect(events.filter((event) => event.kind === 'turn-cancelled')).toHaveLength(1);
  });

  it('propagates a send failure before provider acceptance', async () => {
    const runtime = createRuntime();
    clientState.rejectNextTurnStart('Codex app-server send failed before acceptance');

    await expect(runtime.send(
      { v: 1, text: 'fails before acceptance' },
      { userMessageSeq: 88 },
    )).rejects.toThrow('Codex app-server send failed before acceptance');
  });

  it('logs only the bounded PluginError identity when send fails before provider acceptance', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const runtime = createRuntime({ ctx: { logger } });
    const privateMessage = 'PRIVATE_HOST_SERVICE_FAILURE_SENTINEL';
    clientState.rejectNextTurnStart(new PluginError({
      code: 'plugin_services_turn_authority_unavailable',
      message: privateMessage,
    }));

    await expect(runtime.send({
      v: 1,
      text: 'fails at the host service boundary',
    })).rejects.toMatchObject({
      name: 'PluginError',
      code: 'plugin_services_turn_authority_unavailable',
    });

    await vi.waitFor(() => {
      expect(logger.debug).toHaveBeenCalledWith(
        'Codex app-server background turn completion failed',
        {
          errorName: 'PluginError',
          errorCode: 'plugin_services_turn_authority_unavailable',
          runtimeIssueSource: 'agent_session_error',
        },
      );
    });
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(privateMessage);
  });

  it('propagates an in-flight steer failure', async () => {
    const runtime = createRuntime();
    await runtime.send({ v: 1, text: 'original prompt' });

    clientState.failNextSteer();

    await expect(runtime.send(
      { v: 1, text: 'steer into active turn' },
      { deliverAs: 'steer', userMessageSeq: 78 },
    )).rejects.toThrow('Codex app-server steer failed');
  });
});
