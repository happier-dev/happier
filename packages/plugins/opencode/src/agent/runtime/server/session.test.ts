import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import type {
  CreateSessionRuntimeParamsV1,
  FetchRuntimeRequestV1,
  FetchRuntimeResponseV1,
  PluginContextV1,
  SessionRuntimeV1,
  TranscriptSourceDefinitionV1,
} from '@happier-dev/plugin-sdk';
import { createPluginContextV1Fixture } from '@happier-dev/plugin-sdk/experimental/testing/adapterHarness';

import { formatOpenCodeServerPromptErrorMessage } from './formatOpenCodeServerPromptErrorMessage.js';
import { buildOpenCodePermissionEnv } from '../../permissions/policy.js';
import { createOpenCodeServerSessionRuntime } from './session.js';
import { createOpenCodeStartupDeferredSessionRuntime } from './startupDeferredSessionRuntime.js';

function createContextFixture(params: Readonly<{
  managedServerBaseUrl?: string;
  managedServerPort?: number;
  waitUntilHealthy?: () => Promise<unknown>;
}> = {}): PluginContextV1 {
  const managedServerBaseUrl = params.managedServerBaseUrl ?? 'http://127.0.0.1:49162';
  const managedServerPort = params.managedServerPort ?? Number(new URL(managedServerBaseUrl).port || 80);
  const waitUntilHealthy = params.waitUntilHealthy ?? vi.fn(async () => ({
    id: 'opencode-server',
    state: 'healthy',
    mode: 'managed-spawn',
    baseUrl: managedServerBaseUrl,
    port: managedServerPort,
    credentialEnvKey: 'OPENCODE_SERVER_PASSWORD',
    pid: 123,
    startedAt: 100,
    lastHealthyAt: 101,
    lastErrorMessage: null,
    diagnostics: {},
  }));
  const fixture = createPluginContextV1Fixture();
  const transcripts = {
    append: vi.fn(async () => undefined),
    defineSource: vi.fn(async (definition: { id: string }) => ({
      id: definition.id,
      dispose: vi.fn(async () => undefined),
    })),
    fileFollow: fixture.ctx.agentRuntime.transcripts.fileFollow,
  };
  return {
    ...fixture.ctx,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    env: {
      get: () => null,
      require: (name: string) => {
        throw new Error(`Missing required fixture env value "${name}"`);
      },
      list: () => ({}),
    },
    managedServer: {
      supervise: vi.fn(async () => ({
        snapshot: () => ({
          id: 'opencode-server',
          state: 'healthy',
          mode: 'managed-spawn',
          baseUrl: managedServerBaseUrl,
          port: managedServerPort,
          credentialEnvKey: 'OPENCODE_SERVER_PASSWORD',
          pid: 123,
          startedAt: 100,
          lastHealthyAt: 101,
          lastErrorMessage: null,
          diagnostics: {},
        }),
        waitUntilHealthy,
        dispose: vi.fn(async () => undefined),
      })),
    },
    transcripts,
    agentRuntime: {
      ...fixture.ctx.agentRuntime,
      transcripts,
    },
    mcp: {
      resolveForSession: vi.fn(async () => []),
      list: vi.fn(async () => []),
      startServer: vi.fn(),
      createClient: vi.fn(),
    },
    session: {
      permissions: {
        requestDecision: vi.fn(async () => ({ decision: 'approved' })),
      },
    },
    sessions: {
      writeStateField: vi.fn(async () => undefined),
    },
    events: {
      emit: vi.fn(async () => undefined),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    },
    experimental: {
      telemetry: {
        emit: vi.fn(),
      },
      artifacts: {
        write: vi.fn(async () => undefined),
      },
    },
    timeout: {
      withMs: vi.fn(async (_timeoutMs: number, operation: (signal: AbortSignal) => Promise<unknown>) =>
        await operation(new AbortController().signal)),
      withBudget: vi.fn(async (_budget: unknown, operation: (signal: AbortSignal) => Promise<unknown>) =>
        await operation(new AbortController().signal)),
    },
    fetch: vi.fn(async (request) => {
      if (isSessionCreateRequest(request)) {
        return createJsonResponse({ id: 'oc-session-1' });
      }
      return createJsonResponse({});
    }),
  } as unknown as PluginContextV1;
}

function createJsonResponse(body: unknown): FetchRuntimeResponseV1 {
  return {
    ok: true,
    status: 200,
    headers: {},
    text: async () => JSON.stringify(body),
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function isSessionCreateRequest(request: FetchRuntimeRequestV1): boolean {
  return request.method === 'POST' && new URL(request.url).pathname === '/session';
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function observePromiseSettlement<T>(promise: Promise<T>): { status: 'pending' | 'resolved' | 'rejected' } {
  const state: { status: 'pending' | 'resolved' | 'rejected' } = { status: 'pending' };
  void promise.then(
    () => {
      state.status = 'resolved';
    },
    () => {
      state.status = 'rejected';
    },
  );
  return state;
}

describe('createOpenCodeServerSessionRuntime', () => {
  it('formats prompt errors without exposing stack frames or sensitive values', async () => {
    const error = new Error('request failed with Authorization: Bearer sk-live-secret');
    error.stack = [
      'Error: request failed with Authorization: Bearer sk-live-secret',
      '    at sendPrompt (/Users/leeroy/Documents/Development/happier/dev/packages/plugins/opencode/src/agent/runtime/server/runtime.ts:12:34)',
    ].join('\n');

    const formatted = formatOpenCodeServerPromptErrorMessage(error);

    expect(formatted).toContain('Error: request failed');
    expect(formatted).not.toContain('/Users/leeroy');
    expect(formatted).not.toContain('runtime.ts');
    expect(formatted).not.toContain('sk-live-secret');

    const basicToken = Buffer.from('opencode:managed-server-secret', 'utf8').toString('base64');
    const basicFormatted = formatOpenCodeServerPromptErrorMessage(
      new Error(`request failed with Authorization: Basic ${basicToken}`),
    );
    expect(basicFormatted).toContain('authorization: basic [REDACTED]');
    expect(basicFormatted).not.toContain(basicToken);
    expect(basicFormatted).not.toContain('managed-server-secret');
  });

  it('advertises inline permissions for server-side OpenCode policy enforcement', async () => {
    const ctx = createContextFixture();

    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
        permissionMode: 'read_only',
      } as unknown as CreateSessionRuntimeParamsV1,
    });

    expect(runtime.permissions).toEqual({ capability: 'inline' });
  });

  it('returns a public session runtime that consumes plugin context substrates', async () => {
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49160',
      managedServerPort: 49160,
    });
    const sessionParams = {
      cwd: '/tmp/opencode-project',
      sessionId: 'happy-session-1',
      permissionMode: 'read_only',
      mcpServers: {
        happier: {
          command: 'node',
          args: ['server.js'],
          env: { HAPPIER_TEST_MCP: '1' },
        },
      },
    } as unknown as CreateSessionRuntimeParamsV1;
    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams,
    });
    await expect(runtime.send({ v: 1, text: 'hello' })).resolves.toMatchObject({
      status: 'accepted',
    });

    const supervise = vi.mocked(ctx.managedServer.supervise);
    expect(supervise).toHaveBeenCalledWith(expect.objectContaining({
      id: 'opencode-server',
      launch: expect.objectContaining({
        kind: 'agent-cli',
        agentId: 'opencode',
        args: [
          'serve',
          '--hostname',
          '127.0.0.1',
        ],
        cwd: '/tmp/opencode-project',
        env: {
          OPENCODE_PERMISSION: expect.any(String),
        },
      }),
      mode: expect.objectContaining({
        kind: 'managed-spawn',
        host: '127.0.0.1',
        portArg: '--port',
        credential: expect.objectContaining({
          envKey: 'OPENCODE_SERVER_PASSWORD',
        }),
      }),
      healthCheck: expect.objectContaining({
        kind: 'http',
        path: '/global/health',
      }),
      orphanReaper: expect.objectContaining({
        executablePath: expect.any(String),
        commandIncludes: ['serve', '--hostname', '127.0.0.1'],
        initialSignal: 'SIGTERM',
        forceSignal: 'SIGKILL',
      }),
      watchdog: {
        intervalMs: 10_000,
        missedIntervals: 3,
      },
      launchFingerprint: expect.any(String),
    }));
    const launchEnv = supervise.mock.calls[0]?.[0].launch?.kind === 'agent-cli'
      ? supervise.mock.calls[0]?.[0].launch.env
      : null;
    expect(JSON.parse(String(launchEnv?.OPENCODE_PERMISSION ?? '{}'))).toMatchObject({
      '*': 'deny',
      read: 'allow',
      write: 'deny',
    });
    expect(supervise.mock.calls[0]?.[0]).not.toHaveProperty('restart');
    const managedHandle = await supervise.mock.results[0]?.value;
    expect(managedHandle?.waitUntilHealthy).toHaveBeenCalledWith({
      timeoutMs: 30_000,
      signal: expect.any(AbortSignal),
    });
    expect(ctx.agentRuntime.transcripts.defineSource).toHaveBeenCalledWith(expect.objectContaining({
      id: 'opencode:happy-session-1:http-sse',
      page: expect.any(Function),
      readAfter: expect.any(Function),
      acquireFollowLease: expect.any(Function),
    }));
    expect(ctx.mcp.resolveForSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'happy-session-1',
      directory: '/tmp/opencode-project',
    }));
    expect(ctx.fetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: 'http://127.0.0.1:49160/mcp?directory=%2Ftmp%2Fopencode-project',
      body: JSON.stringify({
        name: 'happier',
        config: {
          type: 'local',
          enabled: true,
          command: ['node', 'server.js'],
          environment: { HAPPIER_TEST_MCP: '1' },
        },
      }),
    }));
    expect(runtime).toMatchObject({
      identity: { read: expect.any(Function) },
      events: { subscribe: expect.any(Function) },
      send: expect.any(Function),
      cancel: expect.any(Function),
      dispose: expect.any(Function),
    });
    expect(runtime.identity.read()).toEqual({ providerSessionId: 'oc-session-1' });
  });

  it('passes session bootstrap environment through to the managed OpenCode server launch', async () => {
    const ctx = createContextFixture();
    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
        env: {
          XDG_CONFIG_HOME: '/tmp/happier-opencode-config',
          OPENCODE_AUTH_CONTENT: '{"openai":{"type":"api_key","key":"happier-broker:openai:1"}}',
        },
      } as unknown as CreateSessionRuntimeParamsV1,
    });

    await expect(runtime.send({ v: 1, text: 'hello' })).resolves.toMatchObject({
      status: 'accepted',
    });

    const launchEnv = vi.mocked(ctx.managedServer.supervise).mock.calls[0]?.[0].launch.env;
    expect(launchEnv).toMatchObject({
      XDG_CONFIG_HOME: '/tmp/happier-opencode-config',
      OPENCODE_AUTH_CONTENT: '{"openai":{"type":"api_key","key":"happier-broker:openai:1"}}',
      OPENCODE_PERMISSION: expect.any(String),
    });
  });

  it('exposes turn liveness while an accepted OpenCode prompt is awaiting terminal history', async () => {
    const ctx = createContextFixture();
    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      } as unknown as CreateSessionRuntimeParamsV1,
    });
    const livenessRuntime = runtime as typeof runtime & Readonly<{
      isTurnInFlight?: () => boolean;
      waitForTurnCompletion?: () => Promise<void>;
    }>;

    try {
      expect(livenessRuntime.isTurnInFlight).toBeTypeOf('function');
      expect(livenessRuntime.waitForTurnCompletion).toBeTypeOf('function');
      expect(livenessRuntime.isTurnInFlight?.()).toBe(false);

      await expect(runtime.send({ v: 1, text: 'hello' })).resolves.toMatchObject({
        status: 'accepted',
      });

      expect(livenessRuntime.isTurnInFlight?.()).toBe(true);
      const completionState = observePromiseSettlement(livenessRuntime.waitForTurnCompletion?.() ?? Promise.resolve());
      await flushMicrotasks();
      expect(completionState.status).toBe('pending');
    } finally {
      await runtime.dispose?.();
    }
  });

  it('starts the OpenCode session without waiting for slow MCP setup', async () => {
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49161',
      managedServerPort: 49161,
    });
    let resolveMcpResolution!: (servers: []) => void;
    let resolveMcpRegistration: (() => void) | null = null;
    vi.mocked(ctx.mcp.resolveForSession).mockImplementationOnce(async () => {
      return await new Promise<[]>((resolve) => {
        resolveMcpResolution = resolve;
      });
    });
    vi.mocked(ctx.fetch).mockImplementation(async (request) => {
      if (request.url === 'http://127.0.0.1:49161/mcp?directory=%2Ftmp%2Fopencode-project') {
        return await new Promise<FetchRuntimeResponseV1>((resolve) => {
          resolveMcpRegistration = () => resolve(createJsonResponse({}));
        });
      }
      if (
        request.url === 'http://127.0.0.1:49161/session?directory=%2Ftmp%2Fopencode-project'
        && request.method === 'POST'
      ) {
        return createJsonResponse({ id: 'oc-session-1' });
      }
      return createJsonResponse({});
    });
    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
        mcpServers: {
          happier: {
            command: 'node',
            args: ['server.js'],
          },
        },
      } as unknown as CreateSessionRuntimeParamsV1,
    });

    const sendPromise = runtime.send({ v: 1, text: 'hello' });
    const sendState = observePromiseSettlement(sendPromise);
    void sendPromise.catch(() => undefined);

    try {
      await flushMicrotasks();

      await expect.poll(() => vi.mocked(ctx.fetch).mock.calls.some(([request]) =>
        request.method === 'POST'
          && request.url === 'http://127.0.0.1:49161/session?directory=%2Ftmp%2Fopencode-project',
      )).toBe(true);
      await expect.poll(() => vi.mocked(ctx.fetch).mock.calls.some(([request]) =>
        request.method === 'POST'
          && request.url === 'http://127.0.0.1:49161/session/oc-session-1/message?directory=%2Ftmp%2Fopencode-project',
      )).toBe(true);
      await flushMicrotasks();
      expect(sendState.status).toBe('resolved');
      await expect(sendPromise).resolves.toMatchObject({ status: 'accepted' });

      resolveMcpResolution([]);
      await expect.poll(() => vi.mocked(ctx.fetch).mock.calls.some(([request]) =>
        request.method === 'POST'
          && request.url === 'http://127.0.0.1:49161/mcp?directory=%2Ftmp%2Fopencode-project',
      )).toBe(true);
    } finally {
      resolveMcpResolution?.([]);
      try {
        await expect.poll(() => resolveMcpRegistration !== null, { timeout: 100 }).toBe(true);
      } catch {
        // The RED path can fail before the background MCP registration request starts.
      }
      resolveMcpRegistration?.();
      await runtime.dispose?.();
    }
  });

  it('surfaces managed-server startup failure as a canonical failed turn on first send', async () => {
    const startupError = new Error(
      "Managed server 'opencode-server' exited before becoming healthy\nexitCode=1 Authorization: Bearer sk-live-secret",
    );
    const ctx = createContextFixture({
      waitUntilHealthy: vi.fn(async () => {
        throw startupError;
      }),
    });

    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      } as unknown as CreateSessionRuntimeParamsV1,
    });
    const runtimeEvents: unknown[] = [];
    runtime.events.subscribe((event) => {
      runtimeEvents.push(event);
    });
    const rejected: Array<Readonly<{
      userMessageSeq: number | null;
      userMessageSeqs?: readonly number[];
    }>> = [];
    runtime.setOnPromptTerminallyRejectedBeforeProvider?.((info) => {
      rejected.push(info);
    });

    await expect(runtime.send({ v: 1, text: 'Please answer briefly.' }, { userMessageSeq: 17 })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: expect.stringContaining('exited before becoming healthy'),
    });

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_runtime_startup_failed',
          source: 'agent_session_error',
          sanitizedPreview: expect.stringContaining('exited before becoming healthy'),
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(JSON.stringify(runtimeEvents)).not.toContain('sk-live-secret');
    expect(rejected).toEqual([{ userMessageSeq: 17, userMessageSeqs: [17] }]);
  });

  it('cancels promptly and aborts a pending managed-server supervise startup', async () => {
    let superviseSignal: AbortSignal | null = null;
    const ctx = createContextFixture();
    vi.mocked(ctx.managedServer.supervise).mockImplementationOnce(async (spec) => {
      superviseSignal = (spec as { signal?: AbortSignal }).signal ?? null;
      return await new Promise<never>(() => undefined);
    });
    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      } as unknown as CreateSessionRuntimeParamsV1,
    });
    const send = runtime.send({ v: 1, text: 'hello' });
    void send.catch(() => undefined);

    await expect.poll(() => vi.mocked(ctx.managedServer.supervise).mock.calls.length).toBe(1);
    const cancel = runtime.cancel?.();
    const outcome = await Promise.race([
      cancel?.then((result) => result.status) ?? Promise.resolve('missing'),
      delay(25).then(() => 'blocked'),
    ]);

    expect(outcome).toBe('cancelled');
    expect(superviseSignal?.aborted).toBe(true);
  });

  it('disposes promptly and aborts a pending managed-server health check', async () => {
    let healthSignal: AbortSignal | null = null;
    const waitUntilHealthy = vi.fn(async (options?: { signal?: AbortSignal }) => {
      healthSignal = options?.signal ?? null;
      return await new Promise<never>(() => undefined);
    });
    const ctx = createContextFixture({ waitUntilHealthy });
    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      } as unknown as CreateSessionRuntimeParamsV1,
    });
    const send = runtime.send({ v: 1, text: 'hello' });
    void send.catch(() => undefined);

    await expect.poll(() => waitUntilHealthy.mock.calls.length).toBe(1);
    const dispose = runtime.dispose?.();
    const outcome = await Promise.race([
      dispose?.then(() => 'disposed') ?? Promise.resolve('missing'),
      delay(25).then(() => 'blocked'),
    ]);

    expect(outcome).toBe('disposed');
    expect(healthSignal?.aborted).toBe(true);
  });

  it('keeps a newer pending startup after an older aborted startup rejects late', async () => {
    const firstStartup = createDeferredPromise<{
      runtime: SessionRuntimeV1;
      dispose(): Promise<void>;
    }>();
    const secondStartup = createDeferredPromise<{
      runtime: SessionRuntimeV1;
      dispose(): Promise<void>;
    }>();
    const secondRuntime: SessionRuntimeV1 = {
      identity: { read: () => ({ providerSessionId: 'session-second' }) },
      events: { subscribe: () => () => undefined },
      send: vi.fn(async () => ({ status: 'accepted' })),
      permissions: { capability: 'inline' },
      dispose: vi.fn(async () => undefined),
    };
    const createAssembly = vi.fn((params: Readonly<{ signal?: AbortSignal }>) => {
      if (createAssembly.mock.calls.length === 1) {
        expect(params.signal).toBeInstanceOf(AbortSignal);
        return firstStartup.promise;
      }
      if (createAssembly.mock.calls.length === 2) {
        expect(params.signal).toBeInstanceOf(AbortSignal);
        return secondStartup.promise;
      }
      throw new Error('unexpected third startup');
    });
    const runtime = createOpenCodeStartupDeferredSessionRuntime({
      ctx: createContextFixture(),
      directory: '/tmp/opencode-project',
      happierSessionId: 'happy-session-1',
      endpoint: { mode: 'managed' },
      createAssembly,
    });

    const firstSend = runtime.send({ v: 1, text: 'first' });
    void firstSend.catch(() => undefined);
    await expect.poll(() => createAssembly.mock.calls.length).toBe(1);
    await expect(runtime.cancel?.()).resolves.toEqual({ status: 'cancelled' });

    const secondSend = runtime.send({ v: 1, text: 'second' });
    await expect.poll(() => createAssembly.mock.calls.length).toBe(2);

    firstStartup.reject(new Error('first startup aborted'));
    await flushMicrotasks();

    const thirdSend = runtime.send({ v: 1, text: 'third' });
    await flushMicrotasks();
    expect(createAssembly).toHaveBeenCalledTimes(2);

    secondStartup.resolve({
      runtime: secondRuntime,
      dispose: vi.fn(async () => undefined),
    });
    await expect(secondSend).resolves.toEqual({ status: 'accepted' });
    await expect(thirdSend).resolves.toEqual({ status: 'accepted' });
    expect(secondRuntime.send).toHaveBeenCalledTimes(2);
  });

  it('does not synthesize provider-acceptance callbacks through deferred startup after prompt submission', async () => {
    const ctx = createContextFixture();
    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      } as unknown as CreateSessionRuntimeParamsV1,
    });
    const accepted: Array<Readonly<{ userMessageSeq: number | null }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });

    await expect(runtime.send(
      { v: 1, text: 'Please answer briefly.' },
      { userMessageSeq: 42 },
    )).resolves.toMatchObject({ status: 'accepted' });

    expect(accepted).toEqual([]);
  });

  it('does not relabel post-start prompt submission failures as startup failures', async () => {
    const ctx = createContextFixture();
    vi.mocked(ctx.fetch).mockImplementation(async (request) => {
      if (isSessionCreateRequest(request)) {
        return createJsonResponse({ id: 'oc-session-1' });
      }
      if (request.url.includes('/message') && request.method === 'POST') {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          headers: {},
          text: async () => 'provider failed with Authorization: Bearer sk-live-secret',
          json: async () => ({ error: 'provider failed' }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      return createJsonResponse({});
    });
    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      } as unknown as CreateSessionRuntimeParamsV1,
    });
    const runtimeEvents: unknown[] = [];
    runtime.events.subscribe((event) => {
      runtimeEvents.push(event);
    });
    const rejected: Array<Readonly<{
      userMessageSeq: number | null;
      userMessageSeqs?: readonly number[];
    }>> = [];
    runtime.setOnPromptTerminallyRejectedBeforeProvider?.((info) => {
      rejected.push(info);
    });

    await expect(runtime.send(
      { v: 1, text: 'Please answer briefly.' },
      { userMessageSeq: 33 },
    )).resolves.toMatchObject({ status: 'accepted' });

    await vi.waitFor(() => {
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-failed',
          issue: expect.objectContaining({
            agentId: 'opencode',
            code: 'opencode_prompt_submission_failed',
          }),
        }),
      ]));
    });

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_prompt_submission_failed',
        }),
      }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          code: 'opencode_runtime_startup_failed',
        }),
      }),
    ]));
    expect(JSON.stringify(runtimeEvents)).not.toContain('sk-live-secret');
    expect(rejected).toEqual([{ userMessageSeq: 33, userMessageSeqs: [33] }]);
  });

  it('buffers config updates before startup and applies them to the first prompt', async () => {
    const ctx = createContextFixture();
    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      } as unknown as CreateSessionRuntimeParamsV1,
    });

    await runtime.updateConfig?.({
      configOption: {
        id: 'reasoningEffort',
        value: 'high',
      },
    });
    await runtime.updateConfig?.({
      configOption: {
        id: 'maxTokens',
        value: 2048,
      },
    });

    expect(ctx.managedServer.supervise).not.toHaveBeenCalled();
    await expect(runtime.send({ v: 1, text: 'Please use the selected config.' })).resolves.toMatchObject({
      status: 'accepted',
    });

    const promptRequest = vi.mocked(ctx.fetch).mock.calls
      .map(([request]) => request)
      .find((request) => request.url.includes('/message') && request.method === 'POST');
    expect(promptRequest).toBeDefined();
    expect(JSON.parse(String(promptRequest?.body ?? '{}'))).toEqual({
      variant: 'high',
      config: { maxTokens: 2048 },
      parts: [{ type: 'text', text: 'Please use the selected config.' }],
    });
  });

  it('buffers the startup model selection before deferred startup and applies it to the first prompt', async () => {
    const ctx = createContextFixture();
    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
        modelId: 'opencode/big-pickle',
      } as unknown as CreateSessionRuntimeParamsV1,
    });

    expect(ctx.managedServer.supervise).not.toHaveBeenCalled();
    await expect(runtime.send({ v: 1, text: 'Please use the startup-selected model.' })).resolves.toMatchObject({
      status: 'accepted',
    });

    const promptRequest = vi.mocked(ctx.fetch).mock.calls
      .map(([request]) => request)
      .find((request) => request.url.includes('/message') && request.method === 'POST');
    expect(promptRequest).toBeDefined();
    expect(JSON.parse(String(promptRequest?.body ?? '{}'))).toEqual({
      model: {
        providerID: 'opencode',
        modelID: 'big-pickle',
      },
      parts: [{ type: 'text', text: 'Please use the startup-selected model.' }],
    });
  });

  it('restarts after a permission-mode reset instead of permanently disposing the deferred runtime', async () => {
    const ctx = createContextFixture();
    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
        permissionMode: 'read-only',
      } as unknown as CreateSessionRuntimeParamsV1,
    });

    await expect(runtime.send({ v: 1, text: 'first prompt' })).resolves.toMatchObject({
      status: 'accepted',
    });
    const firstServer = await vi.mocked(ctx.managedServer.supervise).mock.results[0]?.value;

    const resettableRuntime = runtime as typeof runtime & Readonly<{
      resetOrDisposeRuntime?: () => Promise<void>;
    }>;
    expect(typeof resettableRuntime.resetOrDisposeRuntime).toBe('function');
    await resettableRuntime.resetOrDisposeRuntime?.();
    await runtime.updateConfig?.({ permissionMode: 'safe-yolo' });

    await expect(runtime.send({ v: 1, text: 'second prompt' })).resolves.toMatchObject({
      status: 'accepted',
    });

    expect(firstServer?.dispose).toHaveBeenCalledTimes(1);
    expect(ctx.managedServer.supervise).toHaveBeenCalledTimes(2);
    const launchEnvs = vi.mocked(ctx.managedServer.supervise).mock.calls.map(([input]) => input.launch.env);
    expect(launchEnvs).toEqual([
      buildOpenCodePermissionEnv('read-only'),
      buildOpenCodePermissionEnv('safe-yolo'),
    ]);
  });

  it('disposes before startup without supervising or creating an OpenCode session', async () => {
    const ctx = createContextFixture();
    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      } as unknown as CreateSessionRuntimeParamsV1,
    });

    await runtime.dispose('session_closed');

    expect(ctx.managedServer.supervise).not.toHaveBeenCalled();
    expect(ctx.fetch).not.toHaveBeenCalled();
    expect(runtime.identity.read()).toEqual({ providerSessionId: null });
  });

  it('lists native OpenCode skills through the authenticated managed server client', async () => {
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49160',
      managedServerPort: 49160,
    });
    vi.mocked(ctx.fetch).mockImplementation(async (request) => {
      if (isSessionCreateRequest(request)) {
        return createJsonResponse({ id: 'oc-session-1' });
      }
      if (request.url === 'http://127.0.0.1:49160/skill?directory=%2Ftmp%2Fopencode-project') {
        return createJsonResponse([
          {
            name: 'reviewer',
            description: 'Review code',
            location: '/tmp/opencode-project/.agents/skills/reviewer/SKILL.md',
          },
        ]);
      }
      return createJsonResponse({});
    });

    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      } as unknown as CreateSessionRuntimeParamsV1,
    });

    const skillControls = runtime as typeof runtime & Readonly<{
      listSkills?: (options?: Readonly<{ cwd?: string }>) => Promise<unknown>;
    }>;
    expect(skillControls.listSkills).toBeTypeOf('function');
    await expect(skillControls.listSkills?.({ cwd: '/tmp/opencode-project' })).resolves.toEqual({
      supported: true,
      skills: [
        {
          name: 'reviewer',
          displayName: 'reviewer',
          description: 'Review code',
          path: '/tmp/opencode-project/.agents/skills/reviewer/SKILL.md',
          origin: 'opencode_native',
          enabled: true,
        },
      ],
    });
    expect(ctx.fetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: 'http://127.0.0.1:49160/skill?directory=%2Ftmp%2Fopencode-project',
      headers: expect.objectContaining({
        authorization: expect.stringMatching(/^Basic /),
      }),
    }));
  });

  it('attaches to an explicit OpenCode server URL without spawning a managed server', async () => {
    const ctx = createContextFixture();
    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
        isolation: {
          env: {
            HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4999',
          },
        },
        mcpServers: {
          happier: {
            command: 'node',
            args: ['server.js'],
          },
        },
      } as unknown as CreateSessionRuntimeParamsV1,
    });
    await expect(runtime.send({ v: 1, text: 'hello' })).resolves.toMatchObject({
      status: 'accepted',
    });

    expect(ctx.managedServer.supervise).not.toHaveBeenCalled();
    expect(ctx.fetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: 'http://127.0.0.1:4999/global/health',
    }));
    expect(ctx.fetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: 'http://127.0.0.1:4999/mcp?directory=%2Ftmp%2Fopencode-project',
    }));
  });

  it('registers resolved remote MCP endpoints and leaves redacted local specs unsupported', async () => {
    const ctx = createContextFixture();
    vi.mocked(ctx.mcp.resolveForSession).mockResolvedValue(Object.freeze([
      {
        id: 'docs',
        name: 'docs',
        transport: { kind: 'http', url: 'https://mcp.example.test/http' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'local-http',
        name: 'local-http',
        transport: { kind: 'http', url: 'http://127.0.0.1:4133/mcp' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'stream',
        name: 'stream',
        transport: { kind: 'sse', url: 'https://mcp.example.test/sse' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'local-redacted',
        name: 'local-redacted',
        transport: { kind: 'stdio' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'managed',
        name: 'managed',
        transport: { kind: 'managed', url: 'http://127.0.0.1:4123/mcp' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'managed-without-url',
        name: 'managed-without-url',
        transport: { kind: 'managed' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'hosted',
        name: 'hosted',
        transport: { kind: 'hosted' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
    ]));
    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      },
    });
    await expect(runtime.send({ v: 1, text: 'hello' })).resolves.toMatchObject({
      status: 'accepted',
    });

    const mcpBodies = vi.mocked(ctx.fetch).mock.calls
      .filter(([request]) => request.method === 'POST' && request.url.includes('/mcp?directory='))
      .map(([request]) => JSON.parse(String(request.body ?? '{}')) as unknown);

    expect(mcpBodies).toHaveLength(4);
    expect(mcpBodies).toEqual(expect.arrayContaining([
      {
        name: 'docs',
        config: {
          type: 'remote',
          enabled: true,
          url: 'https://mcp.example.test/http',
        },
      },
      {
        name: 'local-http',
        config: {
          type: 'remote',
          enabled: true,
          url: 'http://127.0.0.1:4133/mcp',
        },
      },
      {
        name: 'managed',
        config: {
          type: 'remote',
          enabled: true,
          url: 'http://127.0.0.1:4123/mcp',
        },
      },
      {
        name: 'stream',
        config: {
          type: 'remote',
          enabled: true,
          url: 'https://mcp.example.test/sse',
        },
      },
    ]));
    expect(mcpBodies).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'local-redacted' }),
      expect.objectContaining({ name: 'managed-without-url' }),
      expect.objectContaining({ name: 'hosted' }),
    ]));
  });

  it('rejects unsafe resolved remote MCP endpoints before OpenCode registration', async () => {
    const ctx = createContextFixture();
    vi.mocked(ctx.mcp.resolveForSession).mockResolvedValue(Object.freeze([
      {
        id: 'ftp',
        name: 'ftp',
        transport: { kind: 'http', url: 'ftp://mcp.example.test/http' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'file',
        name: 'file',
        transport: { kind: 'sse', url: 'file:///tmp/mcp.sock' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'malformed',
        name: 'malformed',
        transport: { kind: 'http', url: 'not-a-url' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'credentials',
        name: 'credentials',
        transport: { kind: 'http', url: 'https://user:pass@mcp.example.test/http' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'empty',
        name: 'empty',
        transport: { kind: 'http', url: '   ' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'local-redacted',
        name: 'local-redacted',
        transport: { kind: 'stdio' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'hosted',
        name: 'hosted',
        transport: { kind: 'hosted' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'managed-without-url',
        name: 'managed-without-url',
        transport: { kind: 'managed' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'managed-ftp',
        name: 'managed-ftp',
        transport: { kind: 'managed', url: 'ftp://127.0.0.1:4123/mcp' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
      {
        id: 'managed-credentials',
        name: 'managed-credentials',
        transport: { kind: 'managed', url: 'http://token:secret@127.0.0.1:4123/mcp' },
        scope: { sessionId: 'happy-session-1', directory: '/tmp/opencode-project' },
      },
    ]));
    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      },
    });
    await expect(runtime.send({ v: 1, text: 'hello' })).resolves.toMatchObject({
      status: 'accepted',
    });

    const mcpBodies = vi.mocked(ctx.fetch).mock.calls
      .filter(([request]) => request.method === 'POST' && request.url.includes('/mcp?directory='))
      .map(([request]) => JSON.parse(String(request.body ?? '{}')) as unknown);

    expect(mcpBodies).toEqual([]);
  });

  it('registers transcript source readers backed by the active OpenCode provider session', async () => {
    const transcriptDefinitionCalls: TranscriptSourceDefinitionV1[] = [];
    const ctx = createContextFixture();
    vi.mocked(ctx.agentRuntime.transcripts.defineSource).mockImplementation(async (definition: TranscriptSourceDefinitionV1) => {
      transcriptDefinitionCalls.push(definition);
      return {
        id: definition.id,
        dispose: vi.fn(async () => undefined),
      };
    });
    vi.mocked(ctx.fetch).mockImplementation(async (request) => {
      if (isSessionCreateRequest(request)) {
        return {
          ok: true,
          status: 200,
          headers: {},
          text: async () => JSON.stringify({ id: 'oc-session-1' }),
          json: async () => ({ id: 'oc-session-1' }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      if (request.url.includes('/message') && request.method === 'POST') {
        return {
          ok: true,
          status: 200,
          headers: {},
          text: async () => JSON.stringify({}),
          json: async () => ({}),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      if (request.url.endsWith('/session/oc-session-1') && request.method === 'GET') {
        return {
          ok: true,
          status: 200,
          headers: {},
          text: async () => JSON.stringify({ type: 'idle' }),
          json: async () => ({ type: 'idle' }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      if (
        request.url === 'http://127.0.0.1:49162/session/oc-session-1/message?directory=%2Ftmp%2Fopencode-project'
        && request.method === 'GET'
      ) {
        return {
          ok: true,
          status: 200,
          headers: {},
          text: async () => JSON.stringify([
            {
              info: { id: 'msg-user', role: 'user', time: { created: 1 } },
              parts: [{ type: 'text', text: 'hello' }],
            },
            {
              info: { id: 'msg-internal', role: 'assistant', summary: true, time: { created: 2 } },
              parts: [{ type: 'text', text: 'hidden summary' }],
            },
            {
              info: { id: 'msg-agent', role: 'assistant', time: { created: 3 } },
              parts: [{ type: 'text', text: 'visible answer' }],
            },
          ]),
          json: async () => [
            {
              info: { id: 'msg-user', role: 'user', time: { created: 1 } },
              parts: [{ type: 'text', text: 'hello' }],
            },
            {
              info: { id: 'msg-internal', role: 'assistant', summary: true, time: { created: 2 } },
              parts: [{ type: 'text', text: 'hidden summary' }],
            },
            {
              info: { id: 'msg-agent', role: 'assistant', time: { created: 3 } },
              parts: [{ type: 'text', text: 'visible answer' }],
            },
          ],
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      throw new Error(`Unexpected request ${request.method} ${request.url}`);
    });
    const runtime = await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
      },
    });
    await expect(runtime.send({ v: 1, text: 'hello' })).resolves.toMatchObject({
      status: 'accepted',
    });
    const source = transcriptDefinitionCalls[0];
    const page = await source.page({ direction: 'older', maxBytes: 100_000, maxItems: 10 });
    const tail = await source.readAfter({ cursor: 'tail', maxBytes: 100_000, maxItems: 10 });
    const afterTail = await source.readAfter({
      cursor: tail.nextCursor ?? 'tail',
      maxBytes: 100_000,
      maxItems: 10,
    });

    expect(page.items.map((item) => (item as { id?: string }).id)).toEqual([
      'opencode:oc-session-1:msg-user',
      'opencode:oc-session-1:msg-agent',
    ]);
    expect(tail).toMatchObject({
      items: [],
      truncated: false,
    });
    expect(afterTail.items).toEqual([]);
    expect(ctx.fetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: 'http://127.0.0.1:49162/session/oc-session-1/message?directory=%2Ftmp%2Fopencode-project',
    }));
  });
});
