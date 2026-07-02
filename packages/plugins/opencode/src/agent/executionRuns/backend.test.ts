import { describe, expect, it, vi } from 'vitest';

import type {
  FetchRuntimeRequestV1,
  FetchRuntimeResponseV1,
  FetchRuntimeServiceV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';

import { createOpenCodeExecutionRunBackend } from './backend.js';

type HostRuntime = Readonly<{
  readResumeSupport: (opts?: Readonly<{ captureReplay?: boolean }>) => Promise<boolean>;
  provisionSession: (opts?: Readonly<{ initialPrompt?: string; resumeSessionId?: string }>) => Promise<Readonly<{ sessionId: string }>>;
  sendPrompt: (sessionId: string, prompt: string) => Promise<void>;
  sendSteerPrompt?: (sessionId: string, prompt: string) => Promise<void>;
  cancel: (sessionId: string) => Promise<void>;
  subscribeMessages: (handler: (message: unknown) => void) => () => void;
  waitForTurnCompletion?: (timeoutMs?: number | null) => Promise<void>;
  probeTurnLiveness?: (sessionId: string) => Promise<Readonly<{
    active: boolean;
    reason?: string;
    lastActivityAtMs?: number | null;
    diagnostics?: Readonly<Record<string, unknown>>;
  }>>;
  dispose: () => Promise<void>;
}>;

function createJsonResponse(body: unknown): FetchRuntimeResponseV1 {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {},
    text: async () => JSON.stringify(body),
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function createPluginContextFixture(fetch: FetchRuntimeServiceV1): PluginContextV1 {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    config: { values: {} },
    fetch,
    transcripts: {
      append: vi.fn(async () => undefined),
      defineSource: vi.fn(async (definition: { id: string }) => ({
        id: definition.id,
        dispose: vi.fn(async () => undefined),
      })),
    },
    managedServer: {
      supervise: vi.fn(async () => ({
        snapshot: () => ({
          id: 'opencode-server',
          state: 'healthy',
          pid: 123,
          startedAt: 100,
          lastHealthyAt: 101,
          lastErrorMessage: null,
        }),
        waitUntilHealthy: vi.fn(async () => ({
          id: 'opencode-server',
          state: 'healthy',
          pid: 123,
          startedAt: 100,
          lastHealthyAt: 101,
          lastErrorMessage: null,
        })),
        dispose: vi.fn(async () => undefined),
      })),
    },
    mcp: {
      resolveForSession: vi.fn(async () => []),
      list: vi.fn(async () => []),
      startServer: vi.fn(),
      createClient: vi.fn(),
    },
    events: {
      emit: vi.fn(async () => undefined),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    },
    session: {
      permissions: {
        requestDecision: vi.fn(async () => ({ decision: 'approved' })),
        getMode: vi.fn(() => 'read-only'),
      },
    },
    sessions: {
      writeStateField: vi.fn(async () => undefined),
    },
    acp: {
      defineAcpBackend: vi.fn(),
      createRuntime: vi.fn(),
    },
    // Test fixture intentionally implements only the PluginContext fields exercised by this execution-run leaf.
  } as unknown as PluginContextV1;
}

function createHostRuntime(params: Readonly<{
  fetch: FetchRuntimeServiceV1;
  executionRunParams?: unknown;
}>): HostRuntime {
  return createOpenCodeExecutionRunBackend({
    ctx: createPluginContextFixture(params.fetch),
    executionRunParams: params.executionRunParams ?? {
      cwd: '/tmp/opencode-run',
      isolation: {
        env: {
          HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
        },
      },
    },
  }) as HostRuntime;
}

describe('createOpenCodeExecutionRunBackend', () => {
  it('assembles server execution runs through the shared server-session substrate path', async () => {
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      if (request.url.endsWith('/session') && request.method === 'POST') {
        return createJsonResponse({ id: 'session_server' });
      }
      if (request.url.endsWith('/message') && request.method === 'GET') {
        return createJsonResponse([]);
      }
      throw new Error(`Unexpected OpenCode request ${request.method} ${request.url}`);
    });
    const ctx = createPluginContextFixture(fetch);
    const runtime = createOpenCodeExecutionRunBackend({
      ctx,
      executionRunParams: {
        runId: 'run_123',
        cwd: '/tmp/opencode-run',
        isolation: {
          env: {
            HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
          },
        },
      },
    }) as HostRuntime;

    await expect(runtime.provisionSession()).resolves.toEqual({ sessionId: 'session_server' });

    const supervise = vi.mocked(ctx.managedServer.supervise);
    expect(supervise).toHaveBeenCalledWith(expect.objectContaining({
      id: 'opencode-server',
      launch: expect.objectContaining({
        kind: 'agent-cli',
        agentId: 'opencode',
        args: ['serve', '--hostname', '127.0.0.1'],
        cwd: '/tmp/opencode-run',
      }),
    }));
    const managedHandle = await supervise.mock.results[0]?.value;
    expect(managedHandle?.waitUntilHealthy).toHaveBeenCalledWith({ timeoutMs: 30_000 });
    expect(ctx.transcripts.defineSource).toHaveBeenCalledWith(expect.objectContaining({
      id: 'opencode:run_123:http-sse',
      page: expect.any(Function),
      readAfter: expect.any(Function),
      acquireFollowLease: expect.any(Function),
    }));
    expect(ctx.mcp.resolveForSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'run_123',
      directory: '/tmp/opencode-run',
    }));
    expect(ctx.sessions.writeStateField).toHaveBeenCalledWith(expect.objectContaining({
      fieldId: 'identity.providerSessionId',
      value: {
        metadataKey: 'opencodeSessionId',
        value: 'session_server',
      },
      reason: 'opencode_session_started',
    }));
    expect(ctx.session.permissions.getMode).toHaveBeenCalled();

    const transcriptSourceHandle = await vi.mocked(ctx.transcripts.defineSource).mock.results[0]?.value;
    await runtime.dispose();

    expect(transcriptSourceHandle?.dispose).toHaveBeenCalled();
    expect(managedHandle?.dispose).toHaveBeenCalled();
  });

  it('disposes a server execution-run assembly that resolves after host disposal', async () => {
    let resolveManagedServer!: (handle: Awaited<ReturnType<PluginContextV1['managedServer']['supervise']>>) => void;
    const managedServerReady = new Promise<Awaited<ReturnType<PluginContextV1['managedServer']['supervise']>>>((resolve) => {
      resolveManagedServer = resolve;
    });
    const managedDispose = vi.fn(async () => undefined);
    const transcriptDispose = vi.fn(async () => undefined);
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      if (request.url.endsWith('/session') && request.method === 'POST') {
        return createJsonResponse({ id: 'session_server' });
      }
      if (request.url.endsWith('/message') && request.method === 'GET') {
        return createJsonResponse([]);
      }
      throw new Error(`Unexpected OpenCode request ${request.method} ${request.url}`);
    });
    const ctx = createPluginContextFixture(fetch);
    vi.mocked(ctx.managedServer.supervise).mockImplementation(async () => managedServerReady);
    vi.mocked(ctx.transcripts.defineSource).mockImplementation(async (definition: { id: string }) => ({
      id: definition.id,
      dispose: transcriptDispose,
    }));
    const runtime = createOpenCodeExecutionRunBackend({
      ctx,
      executionRunParams: {
        runId: 'run_dispose',
        cwd: '/tmp/opencode-run',
        isolation: {
          env: {
            HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
          },
        },
      },
    }) as HostRuntime;

    const provision = runtime.provisionSession();
    const dispose = runtime.dispose();
    resolveManagedServer({
      snapshot: () => ({
        id: 'opencode-server',
        state: 'healthy',
        pid: 123,
        startedAt: 100,
        lastHealthyAt: 101,
        lastErrorMessage: null,
      }),
      waitUntilHealthy: vi.fn(async () => ({
        id: 'opencode-server',
        state: 'healthy',
        pid: 123,
        startedAt: 100,
        lastHealthyAt: 101,
        lastErrorMessage: null,
      })),
      dispose: managedDispose,
    });

    await expect(provision).rejects.toThrow(/disposed/u);
    await expect(dispose).resolves.toBeUndefined();
    expect(transcriptDispose).toHaveBeenCalled();
    expect(managedDispose).toHaveBeenCalled();
  });

  it('adapts the OpenCode server runtime to the execution-run host runtime contract', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      requests.push(request);
      if (request.url.endsWith('/session') && request.method === 'POST') {
        return createJsonResponse({ id: 'session_server' });
      }
      if (request.url.endsWith('/prompt_async') && request.method === 'POST') {
        return createJsonResponse({});
      }
      if (request.url.endsWith('/status') && request.method === 'GET') {
        return createJsonResponse({ type: 'idle' });
      }
      if (request.url.endsWith('/message') && request.method === 'GET') {
        return createJsonResponse([]);
      }
      if (request.url.endsWith('/abort') && request.method === 'POST') {
        return createJsonResponse({});
      }
      throw new Error(`Unexpected OpenCode request ${request.method} ${request.url}`);
    });
    const runtime = createHostRuntime({ fetch });
    const messages: unknown[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => messages.push(message));

    await expect(runtime.readResumeSupport()).resolves.toBe(true);
    await expect(runtime.provisionSession()).resolves.toEqual({ sessionId: 'session_server' });
    await runtime.sendPrompt('session_server', 'Inspect this repo');
    await expect(runtime.waitForTurnCompletion?.(1_000)).resolves.toBeUndefined();
    await runtime.cancel('session_server');
    unsubscribe();
    await runtime.dispose();

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST http://127.0.0.1:4096/session',
      'POST http://127.0.0.1:4096/session/session_server/prompt_async',
      'GET http://127.0.0.1:4096/session/session_server/status',
      'GET http://127.0.0.1:4096/session/session_server/message',
      'POST http://127.0.0.1:4096/session/session_server/abort',
    ]);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-start',
        sessionId: 'opencode-execution-run',
      }),
      expect.objectContaining({
        kind: 'transcript-user-text',
        sessionId: 'opencode-execution-run',
        text: 'Inspect this repo',
      }),
      expect.objectContaining({
        kind: 'turn-complete',
        sessionId: 'opencode-execution-run',
      }),
      expect.objectContaining({
        kind: 'turn-cancelled',
        sessionId: 'opencode-execution-run',
        reason: 'cancelled',
      }),
    ]));
  });

  it('does not advertise in-flight steering for OpenCode server execution runs', () => {
    const runtime = createHostRuntime({ fetch: vi.fn<FetchRuntimeServiceV1>() });

    expect(runtime.sendSteerPrompt).toBeUndefined();
  });

  it('does not complete the execution-run turn while OpenCode still reports active work', async () => {
    let resolveIdleStatus!: () => void;
    const idleStatusReady = new Promise<void>((resolve) => {
      resolveIdleStatus = resolve;
    });
    let statusCalls = 0;
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      if (request.url.endsWith('/session') && request.method === 'POST') {
        return createJsonResponse({ id: 'session_server' });
      }
      if (request.url.endsWith('/prompt_async') && request.method === 'POST') {
        return createJsonResponse({});
      }
      if (request.url.endsWith('/status') && request.method === 'GET') {
        statusCalls += 1;
        if (statusCalls === 1) return createJsonResponse({ type: 'busy' });
        await idleStatusReady;
        return createJsonResponse({ type: 'idle' });
      }
      throw new Error(`Unexpected OpenCode request ${request.method} ${request.url}`);
    });
    const runtime = createHostRuntime({ fetch });

    await runtime.provisionSession();
    await runtime.sendPrompt('session_server', 'Inspect this repo');

    const wait = runtime.waitForTurnCompletion?.(1_000).then(() => 'complete' as const);
    await expect(Promise.race([
      wait,
      new Promise<'pending'>((resolve) => {
        const timer = setTimeout(() => resolve('pending'), 25);
        timer.unref?.();
      }),
    ])).resolves.toBe('pending');
    resolveIdleStatus();
    await expect(wait).resolves.toBe('complete');
    await expect(runtime.probeTurnLiveness?.('session_server')).resolves.toMatchObject({
      active: false,
      diagnostics: {
        source: 'opencode-server-runtime',
      },
    });
  });

  it('rejects server execution-run wait when the bounded completion timeout expires', async () => {
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      if (request.url.endsWith('/session') && request.method === 'POST') {
        return createJsonResponse({ id: 'session_server' });
      }
      if (request.url.endsWith('/prompt_async') && request.method === 'POST') {
        return createJsonResponse({});
      }
      if (request.url.endsWith('/status') && request.method === 'GET') {
        return createJsonResponse({ type: 'busy' });
      }
      throw new Error(`Unexpected OpenCode request ${request.method} ${request.url}`);
    });
    const runtime = createHostRuntime({ fetch });

    await runtime.provisionSession();
    await runtime.sendPrompt('session_server', 'Inspect this repo');
    const wait = runtime.waitForTurnCompletion?.(25)
      .then(() => ({ type: 'resolved' as const }))
      .catch((error: unknown) => ({
        type: 'rejected' as const,
        message: error instanceof Error ? error.message : String(error),
      }));

    const outcome = await Promise.race([
      wait,
      new Promise<Readonly<{ type: 'pending' }>>((resolve) => {
        const timer = setTimeout(() => resolve({ type: 'pending' }), 80);
        timer.unref?.();
      }),
    ]);
    await runtime.dispose();

    expect(outcome).toEqual({
      type: 'rejected',
      message: 'Timed out after 25ms',
    });
  });

  it('completes a fresh turn for each sequential OpenCode server execution-run prompt', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const fetch = vi.fn<FetchRuntimeServiceV1>(async (request) => {
      requests.push(request);
      if (request.url.endsWith('/session') && request.method === 'POST') {
        return createJsonResponse({ id: 'session_server' });
      }
      if (request.url.endsWith('/prompt_async') && request.method === 'POST') {
        return createJsonResponse({});
      }
      if (request.url.endsWith('/status') && request.method === 'GET') {
        return createJsonResponse({ type: 'idle' });
      }
      if (request.url.endsWith('/abort') && request.method === 'POST') {
        return createJsonResponse({});
      }
      throw new Error(`Unexpected OpenCode request ${request.method} ${request.url}`);
    });
    const runtime = createHostRuntime({ fetch });

    await runtime.provisionSession();
    await runtime.sendPrompt('session_server', 'First prompt');
    await runtime.waitForTurnCompletion?.(1_000);

    const secondWait = runtime
      .sendPrompt('session_server', 'Second prompt')
      .then(() => runtime.waitForTurnCompletion?.(1_000))
      .then(() => 'complete' as const);
    try {
      await expect(Promise.race([
        secondWait,
        new Promise<'pending'>((resolve) => {
          const timer = setTimeout(() => resolve('pending'), 25);
          timer.unref?.();
        }),
      ])).resolves.toBe('complete');
    } finally {
      await runtime.cancel('session_server').catch(() => undefined);
      await runtime.dispose();
    }

    expect(requests.filter((request) => request.url.endsWith('/prompt_async'))).toHaveLength(2);
  });

  it('delegates ACP-mode execution runs to the normalized ACP runtimeCore', () => {
    const acpRuntime = { kind: 'acp-execution-run-runtime' };
    const createExecutionRunBackend = vi.fn(() => acpRuntime);
    const ctx = createPluginContextFixture(vi.fn<FetchRuntimeServiceV1>()) as PluginContextV1 & Readonly<{
      acp: PluginContextV1['acp'] & Readonly<{ defineAcpBackend: ReturnType<typeof vi.fn> }>;
    }>;
    ctx.acp.defineAcpBackend.mockReturnValue({
      runtimeCore: { createExecutionRunBackend },
    });

    expect(createOpenCodeExecutionRunBackend({
      ctx,
      executionRunParams: {
        cwd: '/tmp/opencode-run',
        isolation: { env: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' } },
      },
    })).toBe(acpRuntime);

    expect(createExecutionRunBackend).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/opencode-run',
      isolation: { env: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' } },
    }));
  });
});
