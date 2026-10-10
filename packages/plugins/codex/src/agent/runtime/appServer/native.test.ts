import type {
  AgentSessionOpenRequest,
  AgentSessionRuntimeContext,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assertAgentSessionRealtimeRuntime as assertExperimentalAgentSessionRealtimeRuntime,
  type AgentSessionRealtimeConversation,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeModuleMocks = vi.hoisted(() => ({
  createCodexAppServerRuntime: vi.fn(),
  startCodexAppServerRuntime: vi.fn(async () => undefined),
}));

const clientModuleMocks = vi.hoisted(() => ({
  createCodexNativeAppServerClient: vi.fn(),
}));

const sharedServerModuleMocks = vi.hoisted(() => ({
  createCodexSharedAppServer: vi.fn(async () => null),
}));

vi.mock('./runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./runtime.js')>(),
  createCodexAppServerRuntime: runtimeModuleMocks.createCodexAppServerRuntime,
  startCodexAppServerRuntime: runtimeModuleMocks.startCodexAppServerRuntime,
}));

vi.mock('./client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./client.js')>(),
  createCodexNativeAppServerClient: clientModuleMocks.createCodexNativeAppServerClient,
}));

vi.mock('./sharedServer.js', () => ({
  createCodexSharedAppServer: sharedServerModuleMocks.createCodexSharedAppServer,
}));

import {
  createCodexNativeAppServerSessionRuntime,
  createCodexNativeAppServerRuntimeHost,
  openCodexNativeAppServerSession,
} from './native.js';
import type { CodexAppServerEvent, CodexAppServerSession } from './core.js';
import { handleTokenUsageNotification } from '../../usage/handleTokenUsageNotification.js';

function createAppServerSession(): Readonly<{
  runtime: Parameters<typeof createCodexNativeAppServerSessionRuntime>[0];
  updateConfig: NonNullable<CodexAppServerSession['updateConfig']>;
  rollbackNativeConversation: ReturnType<typeof vi.fn>;
  reconcileNativeConversationRollback: ReturnType<typeof vi.fn>;
  publish(event: CodexAppServerEvent): void;
}> {
  const listeners = new Set<(event: CodexAppServerEvent) => void>();
  const updateConfig = vi.fn(async () => undefined);
  const rollbackNativeConversation = vi.fn(async () => ({ status: 'applied' as const }));
  const reconcileNativeConversationRollback = vi.fn(async () => ({ status: 'notApplied' as const }));
  return {
    updateConfig,
    rollbackNativeConversation,
    reconcileNativeConversationRollback,
    publish(event) {
      for (const listener of listeners) listener(event);
    },
    runtime: {
      rollbackNativeConversation,
      reconcileNativeConversationRollback,
      identity: { read: () => ({ providerSessionId: 'thread-1' }) },
      events: {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      async send(_input, options) {
        for (const listener of listeners) {
          listener({
            kind: 'message-delta',
            sessionId: 'session-1',
            turnId: options?.turnId ?? 'turn-1',
            emittedAtMs: 2,
            delta: { text: 'hello from Codex' },
          });
        }
        return { status: 'accepted', turnId: options?.turnId };
      },
      async cancel() {
        return { status: 'cancelled' };
      },
      updateConfig,
      async dispose() {},
    },
  };
}

function createConnectedAccountsFixture(input?: Readonly<{
  bound?: boolean;
  apiKey?: string;
}>) {
  let listener: (() => void | Promise<void>) | null = null;
  return {
    getBinding: vi.fn(async () => input?.bound
      ? {
          purpose: 'realtime_upstream',
          service: { pluginId: 'happier.voice.openai', localId: 'openai' },
          target: { kind: 'account' as const, displayName: 'Realtime' },
        }
      : null),
    requestSelection: vi.fn(),
    materialize: vi.fn(async () => ({
      kind: 'environment' as const,
      env: { OPENAI_API_KEY: input?.apiKey ?? 'sk-realtime' },
    })),
    watch: vi.fn((_purpose: string, next: () => void | Promise<void>) => {
      listener = next;
      queueMicrotask(() => { void next(); });
      return { dispose() { listener = null; } };
    }),
    async emitResync() {
      await listener?.();
    },
  };
}

describe('createCodexNativeAppServerSessionRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sharedServerModuleMocks.createCodexSharedAppServer.mockResolvedValue(null);
    clientModuleMocks.createCodexNativeAppServerClient.mockResolvedValue({
      request: vi.fn(async () => ({ threadId: 'forked-thread' })),
      dispose: vi.fn(async () => undefined),
    });
  });

  it('reuses the native Codex daemon for an exact daemon-proxy resume', async () => {
    const appServer = createAppServerSession();
    runtimeModuleMocks.createCodexAppServerRuntime.mockReturnValueOnce(appServer.runtime);
    const context = {
      signal: new AbortController().signal,
      services: {
        logger: { debug: vi.fn() },
        sessions: { current: { media: { registerSourceRoot: vi.fn() } } },
        connectedAccounts: createConnectedAccountsFixture(),
      },
      session: { id: 'session-1', services: {} },
      ui: { title: { set: vi.fn(async () => undefined) } },
    } as unknown as AgentSessionRuntimeContext;

    const session = await openCodexNativeAppServerSession({
      kind: 'resume',
      sessionId: 'session-1',
      cwd: '/tmp/codex',
      providerSessionId: 'thread-381',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'thread-381',
          appServerTransport: 'daemonProxy',
        },
      },
    }, context);

    expect(sharedServerModuleMocks.createCodexSharedAppServer).not.toHaveBeenCalled();
    const runtimeParams = runtimeModuleMocks.createCodexAppServerRuntime.mock.calls.at(-1)?.[0];
    expect(runtimeParams).toMatchObject({
      appServerEndpoint: undefined,
      appServerTransport: 'daemonProxy',
    });
    await runtimeParams?.host.createClient({
      cwd: '/tmp/codex',
      processEnv: {},
      configOverrides: [],
      disableUserMcpServers: false,
    });
    expect(clientModuleMocks.createCodexNativeAppServerClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ transport: { kind: 'daemonProxy' } }),
    );
    expect(session.runtimeDescriptorV1).toMatchObject({
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'thread-381',
      },
    });
    expect(session.runtimeDescriptorV1?.agent).not.toHaveProperty('appServerTransport');
    expect(session.runtimeDescriptorV1).not.toMatchObject({
      agent: {
        agentExtra: {
          runtimeHandle: { appServerTransport: 'daemonProxy' },
        },
      },
    });
  });

  it('projects the app-server runtime auth facet onto the native session runtime', () => {
    const appServer = createAppServerSession();
    const runtimeAuth = {
      apply: vi.fn(),
      readIdentity: vi.fn(),
    } as NonNullable<CodexAppServerSession['runtimeAuth']>;

    const runtime = createCodexNativeAppServerSessionRuntime(
      { ...appServer.runtime, runtimeAuth },
      'session-1',
    );

    expect(runtime.runtimeAuth).toBe(runtimeAuth);
  });

  it('preserves the typed source of an app-server failed turn through the native adapter', () => {
    const appServer = createAppServerSession();
    const runtime = createCodexNativeAppServerSessionRuntime(appServer.runtime, 'session-1');
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    appServer.publish({
      kind: 'turn-failed',
      sessionId: 'session-1',
      turnId: 'turn-1',
      emittedAtMs: 1,
      issue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'codex_app_server_turn_failed',
        source: 'auth_error',
        occurredAt: 1,
        agentId: 'codex',
        sanitizedPreview: 'Codex authentication failed.',
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-failed',
      diagnostic: expect.objectContaining({
        details: { v: 1, source: 'auth_error' },
      }),
    }));
  });

  it.each([
    ['create', {
      kind: 'create' as const,
      sessionId: 'session-1',
      cwd: '/tmp/codex',
      startupInstructions: {
        v: 1 as const,
        id: 'happier.global_voice_agent',
        revision: 1,
        instructions: 'Global Voice developer instructions.',
      },
    }],
    ['resume', {
      kind: 'resume' as const,
      sessionId: 'session-1',
      cwd: '/tmp/codex',
      providerSessionId: 'thread-1',
      launchEnvironment: { values: {}, unset: ['CODEX_HOME', 'CODEX_SQLITE_HOME'] },
      startupInstructions: {
        v: 1 as const,
        id: 'happier.global_voice_agent',
        revision: 1,
        instructions: 'Global Voice developer instructions.',
      },
    }],
  ])('maps startup instructions to native developerInstructions on %s', async (_kind, request) => {
    const appServer = createAppServerSession();
    runtimeModuleMocks.createCodexAppServerRuntime.mockReturnValueOnce(appServer.runtime);
    const context = {
      signal: new AbortController().signal,
      services: {
        logger: { debug: vi.fn() },
        sessions: { current: { media: { registerSourceRoot: vi.fn() } } },
        connectedAccounts: createConnectedAccountsFixture(),
      },
      session: { id: 'session-1', services: {} },
      ui: { title: { set: vi.fn(async () => undefined) } },
    } as unknown as AgentSessionRuntimeContext;

    await openCodexNativeAppServerSession(request, context);

    expect(runtimeModuleMocks.startCodexAppServerRuntime).toHaveBeenCalledWith(
      appServer.runtime,
      expect.objectContaining({
        developerInstructions: 'Global Voice developer instructions.',
      }),
    );
  });

  it('passes matching native-return strictness to the app-server resume', async () => {
    const appServer = createAppServerSession();
    runtimeModuleMocks.createCodexAppServerRuntime.mockReturnValueOnce(appServer.runtime);
    const context = {
      signal: new AbortController().signal,
      services: {
        logger: { debug: vi.fn() },
        sessions: { current: { media: { registerSourceRoot: vi.fn() } } },
        connectedAccounts: createConnectedAccountsFixture(),
      },
      session: { id: 'session-1', services: {} },
      ui: { title: { set: vi.fn(async () => undefined) } },
    } as unknown as AgentSessionRuntimeContext;

    await openCodexNativeAppServerSession({
      kind: 'resume',
      sessionId: 'session-1',
      cwd: '/tmp/codex',
      providerSessionId: 'thread-1',
      launchEnvironment: { values: {}, unset: ['CODEX_HOME', 'CODEX_SQLITE_HOME'] },
      strictNativeResumeIdentity: true,
    }, context);

    expect(runtimeModuleMocks.startCodexAppServerRuntime).toHaveBeenCalledWith(
      appServer.runtime,
      expect.objectContaining({
        resumeId: 'thread-1',
        strictNativeResumeIdentity: true,
      }),
    );
  });

  it('reconciles the exact stale shared SQLite path before app-server resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-native-resume-'));
    try {
      const codexHome = join(root, 'materialized-home');
      const sqliteHome = join(root, 'shared-state');
      const providerSessionId = '019fea40-8040-7d00-9b7e-9b8f3b5cfca8';
      const rolloutDirectory = join(codexHome, 'sessions', '2026', '09', '07');
      const rolloutPath = join(
        rolloutDirectory,
        `rollout-2026-09-07T12-00-00-${providerSessionId}.jsonl`,
      );
      await mkdir(rolloutDirectory, { recursive: true });
      await mkdir(sqliteHome, { recursive: true });
      await writeFile(rolloutPath, '{}\n', 'utf8');
      const databasePath = join(sqliteHome, 'state_5.sqlite');
      const database = new DatabaseSync(databasePath);
      database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
      database
        .prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)')
        .run(providerSessionId, join(root, 'removed-generation', 'rollout.jsonl'));
      database.close();

      const appServer = createAppServerSession();
      runtimeModuleMocks.createCodexAppServerRuntime.mockReturnValueOnce(appServer.runtime);
      runtimeModuleMocks.startCodexAppServerRuntime.mockImplementationOnce(async () => {
        const verificationDatabase = new DatabaseSync(databasePath);
        try {
          const row = verificationDatabase
            .prepare('SELECT rollout_path FROM threads WHERE id = ?')
            .get(providerSessionId) as { rollout_path?: unknown } | undefined;
          expect(row?.rollout_path).toBe(rolloutPath);
        } finally {
          verificationDatabase.close();
        }
      });
      const context = {
        signal: new AbortController().signal,
        services: {
          logger: { debug: vi.fn() },
          sessions: { current: { media: { registerSourceRoot: vi.fn() } } },
          connectedAccounts: createConnectedAccountsFixture(),
        },
        session: { id: 'session-1', services: {} },
        ui: { title: { set: vi.fn(async () => undefined) } },
      } as unknown as AgentSessionRuntimeContext;

      await openCodexNativeAppServerSession({
        kind: 'resume',
        sessionId: 'session-1',
        cwd: root,
        providerSessionId,
        launchEnvironment: {
          values: { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: sqliteHome },
          unset: [],
        },
      }, context);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not eagerly start a fresh session before its first prompt', async () => {
    const appServer = createAppServerSession();
    runtimeModuleMocks.createCodexAppServerRuntime.mockReturnValueOnce(appServer.runtime);
    const context = {
      signal: new AbortController().signal,
      services: {
        logger: { debug: vi.fn() },
        sessions: { current: { media: { registerSourceRoot: vi.fn() } } },
        connectedAccounts: createConnectedAccountsFixture(),
      },
      session: { id: 'session-1', services: {} },
      ui: { title: { set: vi.fn(async () => undefined) } },
    } as unknown as AgentSessionRuntimeContext;

    await openCodexNativeAppServerSession({
      kind: 'create',
      sessionId: 'session-1',
      cwd: '/tmp/codex',
    }, context);

    expect(runtimeModuleMocks.startCodexAppServerRuntime).not.toHaveBeenCalled();
  });

  it('lets tracked native-fork initialization run until Codex settles or the operation is cancelled', async () => {
    const appServer = createAppServerSession();
    runtimeModuleMocks.createCodexAppServerRuntime.mockReturnValueOnce(appServer.runtime);
    const controller = new AbortController();
    const context = {
      signal: controller.signal,
      services: {
        exec: {},
        logger: { debug: vi.fn() },
        sessions: { current: { media: { registerSourceRoot: vi.fn() } } },
        connectedAccounts: createConnectedAccountsFixture(),
      },
      session: { id: 'session-1', services: {} },
      ui: { title: { set: vi.fn(async () => undefined) } },
    } as unknown as AgentSessionRuntimeContext;

    await openCodexNativeAppServerSession({
      kind: 'fork',
      sessionId: 'session-1',
      cwd: '/tmp/codex',
      launchEnvironment: { values: { PATH: process.env.PATH ?? '' }, unset: ['CODEX_HOME', 'CODEX_SQLITE_HOME'] },
      source: {
        sessionId: 'parent-session',
        providerSessionId: 'parent-thread',
      },
    }, context);

    expect(clientModuleMocks.createCodexNativeAppServerClient).toHaveBeenCalledWith(expect.objectContaining({
      exec: context.services.exec,
      cwd: '/tmp/codex',
      processEnv: expect.objectContaining({ PATH: process.env.PATH }),
      signal: controller.signal,
      initializeRequestOptions: {
        signal: controller.signal,
        timeoutMs: null,
      },
    }));
  });

  it.each([
    ['create', {
      kind: 'create' as const,
      sessionId: 'session-1',
      cwd: '/tmp/codex',
      startupInstructions: {
        v: 1 as const,
        id: 'happier.global_voice_agent',
        revision: 1,
        instructions: 'VOICE_PRIVATE_CREATE_STARTUP_SENTINEL',
      },
    }],
    ['resume', {
      kind: 'resume' as const,
      sessionId: 'session-1',
      cwd: '/tmp/codex',
      providerSessionId: 'thread-1',
      launchEnvironment: { values: {}, unset: ['CODEX_HOME', 'CODEX_SQLITE_HOME'] },
      startupInstructions: {
        v: 1 as const,
        id: 'happier.global_voice_agent',
        revision: 1,
        instructions: 'VOICE_PRIVATE_RESUME_STARTUP_SENTINEL',
      },
    }],
  ])('does not expose startup instructions when native %s startup rejects', async (_kind, request) => {
    const appServer = createAppServerSession();
    runtimeModuleMocks.createCodexAppServerRuntime.mockReturnValueOnce(appServer.runtime);
    const providerOwnPropertySentinel = `VOICE_PRIVATE_${_kind.toUpperCase()}_OWN_PROPERTY_SENTINEL`;
    const providerCauseSentinel = `VOICE_PRIVATE_${_kind.toUpperCase()}_CAUSE_SENTINEL`;
    runtimeModuleMocks.startCodexAppServerRuntime.mockRejectedValueOnce(
      Object.assign(
        new Error(
          `Provider echoed ${request.startupInstructions.instructions}`,
          { cause: new Error(providerCauseSentinel) },
        ),
        {
          providerPayload: providerOwnPropertySentinel,
          runtimeAuthClassification: {
            kind: 'usage_limit',
            source: 'structured_provider_error',
            limitCategory: 'usage_limit',
            planType: 'plus',
            retryAfterMs: 1_250,
            resetsAtMs: 1_779_019_200_000,
          },
        },
      ),
    );
    const context = {
      signal: new AbortController().signal,
      services: {
        logger: { debug: vi.fn() },
        sessions: { current: { media: { registerSourceRoot: vi.fn() } } },
        connectedAccounts: createConnectedAccountsFixture(),
      },
      session: { id: 'session-1', services: {} },
      ui: { title: { set: vi.fn(async () => undefined) } },
    } as unknown as AgentSessionRuntimeContext;

    let rejection: unknown;
    try {
      await openCodexNativeAppServerSession(request, context);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('Codex app-server startup failed.');
    expect((rejection as Error).stack ?? '').not.toContain(request.startupInstructions.instructions);
    expect((rejection as Error).stack ?? '').not.toContain(providerCauseSentinel);
    expect(rejection).not.toHaveProperty('cause');
    expect(rejection).not.toHaveProperty('providerPayload');
    expect((rejection as Error & { runtimeAuthClassification?: unknown }).runtimeAuthClassification)
      .toEqual({
        kind: 'usage_limit',
        source: 'structured_provider_error',
        limitCategory: 'usage_limit',
        planType: 'plus',
        retryAfterMs: 1_250,
        resetsAtMs: 1_779_019_200_000,
      });
    expect(JSON.stringify(rejection)).not.toContain(providerOwnPropertySentinel);
  });

  it('projects the explicitly supplied realtime conversation on the same native runtime object', () => {
    const appServer = createAppServerSession();
    const realtimeConversation: AgentSessionRealtimeConversation = {
      inspect: vi.fn(async () => ({
        status: 'unavailable' as const,
        reason: 'feature_unavailable' as const,
        diagnostic: { code: 'missing', severity: 'error' as const },
      })),
      start: vi.fn(async () => ({
        status: 'unavailable' as const,
        diagnostic: { code: 'missing', severity: 'error' as const },
      })),
    };

    const runtime = createCodexNativeAppServerSessionRuntime(
      appServer.runtime,
      'session-1',
      realtimeConversation,
    );

    expect(assertExperimentalAgentSessionRealtimeRuntime(runtime).realtimeConversation)
      .toBe(realtimeConversation);
  });

  it('publishes native custody before buffered provider output and preserves continuation identity', async () => {
    const appServer = createAppServerSession();
    const runtime = await (async () => createCodexNativeAppServerSessionRuntime(appServer.runtime, 'session-1'))();
    await Promise.resolve();
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    await expect(runtime.send({
      inputIds: ['input-1'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).resolves.toEqual({ status: 'admitted' });
    await Promise.resolve();

    expect(events.map((event) => event.kind)).toEqual([
      'provider-session-id',
      'input-accepted',
      'message-delta',
    ]);
    expect(events[2]).toMatchObject({
      kind: 'message-delta',
      sessionId: 'session-1',
      turnId: 'turn-1',
      channel: 'assistant',
      text: 'hello from Codex',
    });
  });

  it('delegates exact-turn cancellation eligibility to the app-server runtime owner', async () => {
    const appServer = createAppServerSession();
    let activeTurnId: string | null = 'turn-1';
    const appServerCancel = vi.fn(async (expectedTurnId: string | undefined) => {
      if (expectedTurnId !== activeTurnId) return { status: 'not_running' as const };
      appServer.publish({
        kind: 'turn-cancelled',
        sessionId: 'session-1',
        emittedAtMs: 30,
        turnId: expectedTurnId ?? 'turn-1',
        reason: 'user',
      });
      activeTurnId = null;
      return { status: 'cancelled' as const };
    });
    const runtime = createCodexNativeAppServerSessionRuntime(
      { ...appServer.runtime, cancel: appServerCancel },
      'session-1',
    );
    runtime.watch(() => undefined);

    await expect(runtime.send({
      inputIds: ['input-1'],
      input: { text: 'active turn' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).resolves.toEqual({ status: 'admitted' });

    await expect(runtime.cancel?.({ turnId: 'turn-stale', reason: 'user' })).resolves.toEqual({
      status: 'notRunning',
    });
    expect(appServerCancel).toHaveBeenNthCalledWith(1, 'turn-stale');

    await expect(runtime.cancel?.({ turnId: 'turn-1', reason: 'user' })).resolves.toEqual({
      status: 'requested',
      turnId: 'turn-1',
    });
    expect(appServerCancel).toHaveBeenCalledTimes(2);
    expect(appServerCancel).toHaveBeenNthCalledWith(2, 'turn-1');

    await expect(runtime.cancel?.({ turnId: 'turn-1', reason: 'user' })).resolves.toEqual({
      status: 'notRunning',
    });
    expect(appServerCancel).toHaveBeenCalledTimes(3);

    await runtime.dispose();
  });

  it('projects app-server usage as the canonical native usage observation', () => {
    const appServer = createAppServerSession();
    const runtime = createCodexNativeAppServerSessionRuntime(appServer.runtime, 'session-1');
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    appServer.publish({
      kind: 'usage-observed',
      sessionId: 'session-1',
      emittedAtMs: 1_752_089_600_000,
      observationId: 'codex:thread-1:turn-1',
      turnId: 'turn-1',
      source: 'codex-app-server-token-usage',
      scope: 'session_cumulative',
      modelId: 'gpt-5.4',
      accounting: { inputIncludesCache: true, outputIncludesReasoning: true },
      tokens: {
        input: 20_001,
        output: 18,
        reasoning: 10,
        cacheRead: 4_480,
        cacheWrite: 0,
        total: 20_019,
      },
      context: {
        v: 1,
        modelId: 'gpt-5.4',
        usedTokens: 319,
        windowTokens: 258_400,
        totalProcessedTokens: 20_019,
        baselineTokens: 12_000,
        isAutoCompactEnabled: null,
        categories: null,
        observedAtMs: 1_752_089_600_000,
        source: 'provider_turn',
      },
    } as unknown as CodexAppServerEvent);

    expect(events).toContainEqual({
      sequence: 2,
      sessionId: 'session-1',
      emittedAtMs: 1_752_089_600_000,
      kind: 'usage-observed',
      observationId: 'codex:thread-1:turn-1',
      turnId: 'turn-1',
      source: 'codex-app-server-token-usage',
      scope: 'session_cumulative',
      modelId: 'gpt-5.4',
      accounting: { inputIncludesCache: true, outputIncludesReasoning: true },
      tokens: {
        input: 20_001,
        output: 18,
        reasoning: 10,
        cacheRead: 4_480,
        cacheWrite: 0,
        total: 20_019,
      },
      context: {
        v: 1,
        modelId: 'gpt-5.4',
        usedTokens: 319,
        windowTokens: 258_400,
        totalProcessedTokens: 20_019,
        baselineTokens: 12_000,
        isAutoCompactEnabled: null,
        categories: null,
        observedAtMs: 1_752_089_600_000,
        source: 'provider_turn',
      },
    });
  });

  it('admits the real usage codec once without turning its display body into another host transcript', () => {
    const appServer = createAppServerSession();
    const runtime = createCodexNativeAppServerSessionRuntime(appServer.runtime, 'session-1');
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));
    handleTokenUsageNotification({
      sessionId: 'session-1',
      notificationParams: { threadId: 'native-thread', turnId: 'native-turn', tokenUsage: {
        total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5 },
      } },
      now: () => 42,
      emit(message, observation) {
        appServer.publish({ kind: 'transcript-agent-message-committed', sessionId: 'session-1',
          emittedAtMs: 42, agentId: 'codex', localId: message.id, body: message });
        if (observation) appServer.publish({ ...observation, sessionId: 'session-1', emittedAtMs: 42 });
      },
    });
    expect(events.filter((event) => event.kind === 'usage-observed')).toEqual([
      expect.objectContaining({
        tokens: { input: 100, output: 20, cacheRead: 40, cacheWrite: 0, reasoning: 5, total: 120 },
        accounting: { nativeSessionId: 'native-thread', inputIncludesCache: true, outputIncludesReasoning: true },
      }),
    ]);
    expect(events.some((event) => event.kind === 'transcript-message-committed')).toBe(false);
  });

  it('sanitizes pre-admission send rejection while retaining bounded runtime-auth classification', async () => {
    const transcriptSentinel = 'VOICE_PRIVATE_NATIVE_SEND_TRANSCRIPT_SENTINEL';
    const startupSentinel = 'VOICE_PRIVATE_NATIVE_SEND_STARTUP_SENTINEL';
    const hostilePlanTypeSentinel = 'VOICE_PRIVATE_NATIVE_SEND_PLAN_TYPE_SENTINEL';
    const failure = Object.assign(
      new Error(`Provider echoed ${transcriptSentinel} and ${startupSentinel}`),
      {
        runtimeAuthClassification: {
          kind: 'usage_limit',
          source: 'structured_provider_error',
          limitCategory: 'usage_limit',
          planType: hostilePlanTypeSentinel,
          retryAfterMs: 1_250,
          resetsAtMs: 1_779_019_200_000,
        },
      },
    );
    const appServer = createAppServerSession();
    vi.spyOn(appServer.runtime, 'send').mockRejectedValueOnce(failure);
    const runtime = createCodexNativeAppServerSessionRuntime(appServer.runtime, 'session-1');
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));
    const safeDiagnostic = {
      code: 'codex_send_outcome_unknown',
      severity: 'error',
      message: 'Codex send outcome is unknown.',
      details: {
        runtimeAuthClassification: {
          kind: 'usage_limit',
          source: 'structured_provider_error',
          limitCategory: 'usage_limit',
          retryAfterMs: 1_250,
          resetsAtMs: 1_779_019_200_000,
        },
      },
    } as const;

    const result = await runtime.send({
      inputIds: ['input-private'],
      input: { text: transcriptSentinel },
      delivery: { kind: 'newTurn', turnId: 'turn-private' },
    });

    expect(result).toEqual({
      status: 'unavailable',
      retryable: true,
      diagnostic: safeDiagnostic,
    });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'input-custody-unknown',
      inputIds: ['input-private'],
      issue: safeDiagnostic,
    }));
    expect(JSON.stringify({ result, events })).not.toContain(transcriptSentinel);
    expect(JSON.stringify({ result, events })).not.toContain(startupSentinel);
    expect(JSON.stringify({ result, events })).not.toContain(hostilePlanTypeSentinel);
  });

  it('preserves the exact provider rollback checkpoint on the native boundary', () => {
    const appServer = createAppServerSession();
    const runtime = createCodexNativeAppServerSessionRuntime(appServer.runtime, 'session-1');
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    appServer.publish({
      kind: 'turn-rollback-boundary-observed',
      sessionId: 'session-1',
      turnId: 'host-turn-1',
      agentTurnId: 'provider-turn-9',
      providerCheckpoint: 'provider-turn-9',
      agentRollbackOrdinal: 4,
      emittedAtMs: 7,
    });

    expect(events.at(-1)).toMatchObject({
      kind: 'turn-rollback-boundary',
      turnId: 'host-turn-1',
      agentTurnId: 'provider-turn-9',
      providerCheckpoint: 'provider-turn-9',
      agentRollbackOrdinal: 4,
    });
  });

  it('projects a newly published app-server thread identity onto the native boundary', () => {
    const appServer = createAppServerSession();
    const runtime = createCodexNativeAppServerSessionRuntime(appServer.runtime, 'session-1');
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    appServer.publish({
      kind: 'session-id-publish',
      sessionId: 'session-1',
      publishedSessionId: 'thread-2',
      source: 'codex-app-server',
      emittedAtMs: 8,
    });

    expect(events.at(-1)).toMatchObject({
      kind: 'provider-session-id',
      providerSessionId: 'thread-2',
    });
  });

  it('keeps rollback on the live app-server session and forwards provider checkpoints unchanged', async () => {
    const appServer = createAppServerSession();
    const runtime = createCodexNativeAppServerSessionRuntime(appServer.runtime, 'session-1');
    const request = {
      operationId: 'rollback-1',
      target: { kind: 'beforeTurn' as const, turnId: 'host-turn-1' },
      affectedTurns: [{ turnId: 'host-turn-1', providerCheckpoint: 'provider-turn-9' }] as const,
      providerSessionId: 'thread-1',
      runtimeIncarnationId: 'runtime-1',
    };

    await expect(runtime.conversationRollback?.rollback(request)).resolves.toEqual({ status: 'applied' });
    await expect(runtime.conversationRollback?.reconcile(request)).resolves.toEqual({ status: 'notApplied' });
    expect(appServer.rollbackNativeConversation).toHaveBeenCalledWith(request);
    expect(appServer.reconcileNativeConversationRollback).toHaveBeenCalledWith(request);
  });

  it('publishes local generated media through a bounded native session root', async () => {
    const publishGenerated = vi.fn(async () => ({ status: 'published' as const }));
    const dispose = vi.fn();
    const registerSourceRoot = vi.fn(async () => ({ publishGenerated, dispose }));
    const context = {
      signal: new AbortController().signal,
      services: {
        logger: { debug: vi.fn() },
        sessions: { current: { media: { registerSourceRoot } } },
        connectedAccounts: createConnectedAccountsFixture(),
      },
      session: { id: 'session-1', services: {} },
      ui: { title: { set: vi.fn(async () => undefined) } },
    } as unknown as AgentSessionRuntimeContext;
    const host = createCodexNativeAppServerRuntimeHost({
      request: { sessionId: 'session-1' } as AgentSessionOpenRequest,
      context,
      processEnv: {},
    });

    await host.publishGeneratedMedia?.({
      itemId: 'image-1',
      origin: {
        source: 'provider-generated',
        agentEventId: 'image-1',
        generationId: 'image-1',
      },
      source: {
        kind: 'local-file',
        path: '/tmp/codex/image.png',
        fileNameHint: 'image.png',
        restrictedRoot: '/tmp/codex',
      },
    });
    await host.dispose?.();

    expect(registerSourceRoot).toHaveBeenCalledWith({ rootPath: '/tmp/codex' });
    expect(publishGenerated).toHaveBeenCalledWith({
      localId: 'image-1',
      path: '/tmp/codex/image.png',
      description: 'Generated by Codex',
      toolCallId: 'image-1',
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('sets the durable title through the host-stamped current Session handle', async () => {
    const setDisplayTitle = vi.fn(async () => undefined);
    const controller = new AbortController();
    const context = {
      signal: controller.signal,
      services: {
        logger: { debug: vi.fn() },
        sessions: { current: { setDisplayTitle, media: { registerSourceRoot: vi.fn() } } },
        connectedAccounts: createConnectedAccountsFixture(),
      },
      session: { id: 'session-1', services: {} },
    } as unknown as AgentSessionRuntimeContext;
    const host = createCodexNativeAppServerRuntimeHost({
      request: { sessionId: 'session-1' } as AgentSessionOpenRequest,
      context,
      processEnv: {},
    });

    await host.setTitle?.('Review');

    expect(setDisplayTitle).toHaveBeenCalledWith('Review', { signal: controller.signal });
  });

  it('admits async question replies through the host-stamped current Session handle', async () => {
    const send = vi.fn(async () => ({ status: 'accepted' as const, localId: 'reply-1' }));
    const controller = new AbortController();
    const context = {
      signal: controller.signal,
      services: {
        logger: { debug: vi.fn() },
        sessions: { current: { send, media: { registerSourceRoot: vi.fn() } } },
        connectedAccounts: createConnectedAccountsFixture(),
      },
      session: { id: 'session-1', services: {} },
    } as unknown as AgentSessionRuntimeContext;
    const host = createCodexNativeAppServerRuntimeHost({
      request: { sessionId: 'session-1' } as AgentSessionOpenRequest,
      context,
      processEnv: {},
    });

    await host.sendUserMessage?.({
      idempotencyKey: 'codex-async-question:abc',
      text: '<send_user_message_question_reply>\n[]\n</send_user_message_question_reply>',
      toolCallId: 'question-1',
    });

    expect(send).toHaveBeenCalledWith({
      kind: 'userText',
      text: '<send_user_message_question_reply>\n[]\n</send_user_message_question_reply>',
      idempotencyKey: 'codex-async-question:abc',
      toolAnswerDelivery: { toolCallId: 'question-1' },
    }, { signal: controller.signal });
  });

  it('requests reset-credit inventory through the supported non-following HTTP policy', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      headers: {},
      body: new TextEncoder().encode('{"credits":[]}'),
    }));
    const controller = new AbortController();
    const context = {
      signal: controller.signal,
      services: {
        logger: { debug: vi.fn() },
        http: { request },
        sessions: { current: { media: { registerSourceRoot: vi.fn() } } },
        connectedAccounts: createConnectedAccountsFixture(),
      },
      session: { id: 'session-1', services: {} },
    } as unknown as AgentSessionRuntimeContext;
    const host = createCodexNativeAppServerRuntimeHost({
      request: { sessionId: 'session-1' } as AgentSessionOpenRequest,
      context,
      processEnv: {},
    });

    await expect(host.fetchRateLimitResetCredits?.({
      accessToken: 'access-token',
      accountId: 'account-1',
    })).resolves.toEqual({ credits: [] });

    expect(request).toHaveBeenCalledWith({
      url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      method: 'GET',
      headers: {
        Authorization: 'Bearer access-token',
        'ChatGPT-Account-Id': 'account-1',
        Accept: 'application/json',
      },
      redirect: 'error',
    }, { signal: controller.signal });
  });

  it('refreshes runtime auth through the common Session handle without forwarding Agent identity', async () => {
    // The common host settles authority and exact-home materialization, not a native token codec.
    const refreshRuntimeAuth = vi.fn(async () => ({ status: 'refreshed' as const,
      result: { credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' } }));
    const expected = { status: 'refreshed', result: {
      accessToken: 'synthetic-fresh', chatgptAccountId: 'account-1', chatgptPlanType: null,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    } };
    const controller = new AbortController();
    const context = {
      signal: controller.signal,
      services: {
        logger: { debug: vi.fn() },
        sessions: {
          current: {
            auth: { services: { refreshRuntimeAuth } },
            media: { registerSourceRoot: vi.fn() },
          },
        },
        connectedAccounts: createConnectedAccountsFixture(),
      },
      session: { id: 'session-1', services: { nativeHome: {
        root: '/fixture', readFiles: async () => ({ 'auth.json': new TextEncoder().encode(JSON.stringify({
          auth_mode: 'chatgptAuthTokens', tokens: { access_token: 'synthetic-fresh', account_id: 'account-1' },
        })) }),
      } } },
      ui: { title: { set: vi.fn(async () => undefined) } },
    } as unknown as AgentSessionRuntimeContext;
    const host = createCodexNativeAppServerRuntimeHost({
      request: { sessionId: 'session-1' } as AgentSessionOpenRequest,
      context,
      processEnv: {},
    });

    await expect(host.refreshRuntimeAuth?.({
      serviceId: 'openai-codex',
      reason: 'credential_expired',
    })).resolves.toEqual(expected);
    await expect(host.refreshRuntimeAuth?.({
      serviceId: 'openai-codex',
      targetId: 'session-1',
      classification: { kind: 'capacity_exhausted' },
      reason: 'provider_session_capacity_failure',
    })).resolves.toEqual(expected);

    expect(refreshRuntimeAuth).toHaveBeenNthCalledWith(1, {
      serviceId: 'openai-codex',
      reason: 'credential_expired',
    }, { signal: controller.signal });
    expect(refreshRuntimeAuth).toHaveBeenNthCalledWith(2, {
      serviceId: 'openai-codex',
      targetId: 'session-1',
      classification: { kind: 'capacity_exhausted' },
      reason: 'provider_session_capacity_failure',
    }, { signal: controller.signal });
  });

  it('binds app-server MCP elicitation to the common Session handle', () => {
    const mcp = { elicit: vi.fn() };
    const context = {
      signal: new AbortController().signal,
      services: {
        logger: { debug: vi.fn() },
        sessions: {
          current: {
            mcp,
            media: { registerSourceRoot: vi.fn() },
          },
        },
        connectedAccounts: createConnectedAccountsFixture(),
      },
      session: { id: 'session-1', services: {} },
      ui: { title: { set: vi.fn(async () => undefined) } },
    } as unknown as AgentSessionRuntimeContext;

    const host = createCodexNativeAppServerRuntimeHost({
      request: { sessionId: 'session-1' } as AgentSessionOpenRequest,
      context,
      processEnv: {},
    });

    expect(host.mcp).toBe(mcp);
  });

  it('preserves the canonical group-member account-usage source from the Session owner', async () => {
    const source = Object.freeze({
      serviceId: 'openai-codex',
      profileId: 'profile-1',
      bindingKind: 'group_member' as const,
      groupId: 'group-1',
    });
    const resolveSourceContext = vi.fn(async () => source);
    const context = {
      signal: new AbortController().signal,
      services: {
        logger: { debug: vi.fn() },
        sessions: { current: { media: { registerSourceRoot: vi.fn() } } },
        connectedAccounts: createConnectedAccountsFixture(),
      },
      session: {
        id: 'session-1',
        services: {
          accountUsage: {
            resolveSourceContext,
            recordSnapshot: vi.fn(),
            adoptProvisionalRecord: vi.fn(),
          },
        },
      },
      ui: { title: { set: vi.fn(async () => undefined) } },
    } as unknown as AgentSessionRuntimeContext;
    const host = createCodexNativeAppServerRuntimeHost({
      request: { sessionId: 'session-1' } as AgentSessionOpenRequest,
      context,
      processEnv: {},
    });

    await expect(host.accountUsage.resolveSourceContext({
      serviceId: 'openai-codex',
    })).resolves.toEqual(source);
  });

  it('passes the host-frozen raw MCP launch configuration to the native app-server runtime', async () => {
    const appServer = createAppServerSession();
    runtimeModuleMocks.createCodexAppServerRuntime.mockReturnValueOnce(appServer.runtime);
    const context = {
      signal: new AbortController().signal,
      services: {
        logger: { debug: vi.fn() },
        sessions: { current: { media: { registerSourceRoot: vi.fn() } } },
        connectedAccounts: createConnectedAccountsFixture(),
      },
      session: { id: 'session-1', services: {} },
      ui: { title: { set: vi.fn(async () => undefined) } },
    } as unknown as AgentSessionRuntimeContext;
    const mcpServers = Object.freeze({
      happier: Object.freeze({
        command: 'happier-mcp',
        args: Object.freeze(['serve']),
        env: Object.freeze({ HAPPIER_MCP_MODE: 'session' }),
      }),
    });

    await openCodexNativeAppServerSession({
      kind: 'create',
      sessionId: 'session-1',
      cwd: '/tmp/codex',
      mcpServers,
    }, context);

    expect(runtimeModuleMocks.createCodexAppServerRuntime).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers,
    }));
    expect(runtimeModuleMocks.createCodexAppServerRuntime.mock.calls[0]?.[0])
      .not.toHaveProperty('initialProviderBinding');
  });

  it('uses canonical session authentication without a realtime API-key purpose or watcher', async () => {
    const appServer = createAppServerSession();
    runtimeModuleMocks.createCodexAppServerRuntime.mockReturnValueOnce(appServer.runtime);
    const connectedAccounts = createConnectedAccountsFixture({
      bound: true,
      apiKey: 'sk-realtime',
    });
    const context = {
      signal: new AbortController().signal,
      services: {
        logger: { debug: vi.fn() },
        sessions: { current: { media: { registerSourceRoot: vi.fn() } } },
        connectedAccounts,
      },
      session: { id: 'session-1', services: {} },
      ui: { title: { set: vi.fn(async () => undefined) } },
    } as unknown as AgentSessionRuntimeContext;

    const sessionRuntime = await openCodexNativeAppServerSession({
      kind: 'create',
      sessionId: 'session-1',
      cwd: '/tmp/codex',
    }, context);

    expect(connectedAccounts.getBinding).not.toHaveBeenCalledWith(
      'realtime_upstream',
      expect.anything(),
    );
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    expect(connectedAccounts.watch).not.toHaveBeenCalledWith(
      'realtime_upstream',
      expect.anything(),
    );
    expect(runtimeModuleMocks.createCodexAppServerRuntime)
      .toHaveBeenCalledWith(expect.objectContaining({
        processEnv: expect.not.objectContaining({
          OPENAI_API_KEY: expect.anything(),
        }),
      }));
    await sessionRuntime.dispose();
  });

  it('passes exact validated Provider engine configuration to the native app-server runtime', async () => {
    const appServer = createAppServerSession();
    runtimeModuleMocks.createCodexAppServerRuntime.mockReturnValueOnce(appServer.runtime);
    const context = {
      signal: new AbortController().signal,
      services: {
        logger: { debug: vi.fn() },
        sessions: { current: { media: { registerSourceRoot: vi.fn() } } },
        connectedAccounts: createConnectedAccountsFixture(),
      },
      session: { id: 'session-1', services: {} },
      ui: { title: { set: vi.fn(async () => undefined) } },
    } as unknown as AgentSessionRuntimeContext;
    const engineConfig = Object.freeze({
      v: 1 as const,
      modelProvider: 'happier_0123456789abcdef0123456789abcdef',
      config: Object.freeze({
        'model_providers.happier_0123456789abcdef0123456789abcdef': Object.freeze({
          name: 'Happier provider' as const,
          base_url: 'https://gateway.example.test/v1',
          wire_api: 'responses' as const,
          env_key: 'HAPPIER_CODEX_PROVIDER_API_KEY' as const,
          requires_openai_auth: false as const,
          supports_websockets: false as const,
        }),
      }),
    });

    await openCodexNativeAppServerSession({
      kind: 'create',
      sessionId: 'session-1',
      cwd: '/tmp/codex',
      providerBinding: {
        connectionId: 'pc_work',
        model: { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
        upstream: {
          protocol: 'openai-responses',
          normalizedUrl: 'https://gateway.example.test/v1',
          credential: 'apiKey',
        },
        materialization: { v: 1, kind: 'engineConfig', engineConfig },
      },
    } as unknown as AgentSessionOpenRequest, context);

    expect(runtimeModuleMocks.createCodexAppServerRuntime).toHaveBeenCalledWith(expect.objectContaining({
      initialProviderBinding: engineConfig,
      initialModelId: 'gpt-5.6-luna',
    }));
  });

  it.each([
    ['missing materialization', { connectionId: 'pc_work' }],
    ['wrong materialization kind', {
      connectionId: 'pc_work',
      materialization: { v: 1, kind: 'spawnEnv' },
    }],
    ['invalid engine configuration', {
      connectionId: 'pc_work',
      materialization: {
        v: 1,
        kind: 'engineConfig',
        engineConfig: { v: 1, modelProvider: 'ambient-fallback', config: {} },
      },
    }],
  ])('refuses %s before app-server runtime or client work', async (_label, providerBinding) => {
    const context = {
      signal: new AbortController().signal,
      services: {
        logger: { debug: vi.fn() },
        sessions: { current: { media: { registerSourceRoot: vi.fn() } } },
        connectedAccounts: createConnectedAccountsFixture(),
      },
      session: { id: 'session-1', services: {} },
      ui: { title: { set: vi.fn(async () => undefined) } },
    } as unknown as AgentSessionRuntimeContext;

    await expect(openCodexNativeAppServerSession({
      kind: 'create',
      sessionId: 'session-1',
      cwd: '/tmp/codex',
      providerBinding,
    } as unknown as AgentSessionOpenRequest, context)).rejects.toThrow();

    expect(runtimeModuleMocks.createCodexAppServerRuntime).not.toHaveBeenCalled();
    expect(runtimeModuleMocks.startCodexAppServerRuntime).not.toHaveBeenCalled();
  });

  it('applies supported mode, model, permission, and Codex option configuration fields', async () => {
    const appServer = createAppServerSession();
    const runtime = createCodexNativeAppServerSessionRuntime(appServer.runtime, 'session-1');

    await expect(runtime.updateConfiguration?.({
      mode: { value: 'plan', updatedAtMs: 1 },
      model: { value: 'gpt-5.4', updatedAtMs: 2 },
      permissionIntent: { value: 'safe-yolo', updatedAtMs: 3 },
      options: {
        reasoning_effort: { value: 'high', updatedAtMs: 4 },
        service_tier: { value: 'fast', updatedAtMs: 5 },
      },
    })).resolves.toEqual({
      status: 'applied',
      changed: ['mode', 'permissionIntent', 'model', 'options.reasoning_effort', 'options.service_tier'],
    });
    expect(appServer.updateConfig).toHaveBeenNthCalledWith(1, {
      collaborationModeId: 'plan',
    });
    expect(appServer.updateConfig).toHaveBeenNthCalledWith(2, {
      permissionMode: 'safe-yolo',
      modelId: 'gpt-5.4',
    });
    expect(appServer.updateConfig).toHaveBeenNthCalledWith(3, {
      configOption: { id: 'reasoning_effort', value: 'high' },
    });
    expect(appServer.updateConfig).toHaveBeenNthCalledWith(4, {
      configOption: { id: 'service_tier', value: 'fast' },
    });
  });

  it('preserves committed reasoning as reasoning', () => {
    const appServer = createAppServerSession();
    const runtime = createCodexNativeAppServerSessionRuntime(appServer.runtime, 'session-1');
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    appServer.publish({
      kind: 'transcript-agent-message-committed',
      sessionId: 'session-1',
      emittedAtMs: 10,
      agentId: 'codex',
      localId: 'reasoning-1',
      body: { type: 'reasoning', message: 'Think carefully' },
    });

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'transcript-message-committed',
      role: 'reasoning',
      text: 'Think carefully',
    }));
  });

  it('reports failed app-server configuration updates without optimistic application', async () => {
    const appServer = createAppServerSession();
    vi.mocked(appServer.updateConfig).mockRejectedValueOnce(new Error('provider rejected update'));
    const runtime = createCodexNativeAppServerSessionRuntime(appServer.runtime, 'session-1');

    await expect(runtime.updateConfiguration?.({
      mode: { value: null, updatedAtMs: 1 },
      model: { value: 'gpt-5.4', updatedAtMs: 2 },
      permissionIntent: { value: null, updatedAtMs: 3 },
      options: {},
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'codex_configuration_update_failed' },
    });
  });
});
