import { describe, expect, it, vi } from 'vitest';

import type { PluginContextV1 } from '@happier-dev/plugin-sdk';

import { createOpenCodeBackendEngine } from './engine.js';

function isSessionCreateRequest(request: Readonly<{ url: string; method?: string }>): boolean {
  return request.method === 'POST' && new URL(request.url).pathname === '/session';
}

function createPluginContextFixture(): PluginContextV1 {
  const managedServerHandle = {
    snapshot: () => ({
      id: 'opencode-server',
      state: 'healthy',
      mode: 'managed-spawn',
      baseUrl: 'http://127.0.0.1:49197',
      port: 49197,
      credentialEnvKey: 'OPENCODE_SERVER_PASSWORD',
      pid: 123,
      startedAt: 100,
      lastHealthyAt: 101,
      lastErrorMessage: null,
      diagnostics: {},
    }),
    waitUntilHealthy: vi.fn(async () => ({
      id: 'opencode-server',
      state: 'healthy',
      mode: 'managed-spawn',
      baseUrl: 'http://127.0.0.1:49197',
      port: 49197,
      credentialEnvKey: 'OPENCODE_SERVER_PASSWORD',
      pid: 123,
      startedAt: 100,
      lastHealthyAt: 101,
      lastErrorMessage: null,
      diagnostics: {},
    })),
    dispose: vi.fn(async () => undefined),
  };
  return {
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
      supervise: vi.fn(async () => managedServerHandle),
    },
    agentRuntime: {
      transcripts: {
        append: vi.fn(async () => undefined),
        defineSource: vi.fn(async (definition: { id: string }) => ({
          id: definition.id,
          dispose: vi.fn(async () => undefined),
        })),
      },
    },
    mcp: {
      resolveForSession: vi.fn(async () => []),
      list: vi.fn(async () => []),
      startServer: vi.fn(),
      createClient: vi.fn(),
    },
    sessions: {
      current: {
        permissions: {
          requestDecision: vi.fn(async () => ({ decision: 'approved' })),
        },
      },
      writeStateField: vi.fn(async () => undefined),
    },
    events: {
      emit: vi.fn(async () => undefined),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    },
    fetch: vi.fn(async (request) => {
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
      return {
        ok: true,
        status: 200,
        headers: {},
        text: async () => JSON.stringify({}),
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }),
  } as unknown as PluginContextV1;
}

describe('createOpenCodeBackendEngine', () => {
  it('creates a public server session runtime through the default plugin-owned leaf', async () => {
    const ctx = createPluginContextFixture();
    const engine = createOpenCodeBackendEngine(ctx);

    const runtime = await engine.runtimeCore?.createSessionRuntime({ cwd: '/tmp/opencode' });

    expect(runtime).toMatchObject({
      identity: { read: expect.any(Function) },
      events: { subscribe: expect.any(Function) },
      send: expect.any(Function),
      cancel: expect.any(Function),
      dispose: expect.any(Function),
    });
    expect(runtime?.identity.read()).toEqual({ providerSessionId: null });
    expect(ctx.managedServer.supervise).not.toHaveBeenCalled();
    await expect(runtime?.send({ v: 1, text: 'hello' })).resolves.toMatchObject({
      status: 'accepted',
    });
    expect(runtime?.identity.read()).toEqual({ providerSessionId: 'oc-session-1' });
    expect(ctx.managedServer.supervise).toHaveBeenCalledWith(expect.objectContaining({
      mode: expect.objectContaining({
        kind: 'managed-spawn',
        portArg: '--port',
      }),
    }));
    await runtime?.dispose('session_closed');
  });

  it('creates an ACP backend through ctx.agentRuntime.acp.defineAcpBackend by default', async () => {
    const acpRuntime = { kind: 'acp-runtime' };
    const acpEngine = {
      runtimeCore: {
        createSessionRuntime: vi.fn(async () => acpRuntime),
        createExecutionRunBackend: vi.fn(),
      },
    };
    const base = createPluginContextFixture();
    const ctx = {
      ...base,
      agentRuntime: {
        ...base.agentRuntime,
        acp: {
          defineAcpBackend: vi.fn(() => acpEngine),
        },
      },
    } as unknown as PluginContextV1;
    const engine = createOpenCodeBackendEngine(ctx);

    await expect(
      engine.runtimeCore?.createSessionRuntime({
        isolation: { env: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' } },
      }),
    ).resolves.toBe(acpRuntime);

    expect(ctx.agentRuntime.acp.defineAcpBackend).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'opencode',
      mcp: { policy: 'pass_through' },
    }));
  });

  it('creates a server execution-run runtime through the default plugin-owned leaf', () => {
    const ctx = createPluginContextFixture();
    const engine = createOpenCodeBackendEngine(ctx);

    expect(engine.runtimeCore?.createExecutionRunBackend({
      cwd: '/tmp/opencode',
      backendId: 'opencode',
      permissionMode: 'read_only',
    })).toEqual(expect.objectContaining({
      readResumeSupport: expect.any(Function),
      provisionSession: expect.any(Function),
      sendPrompt: expect.any(Function),
      waitForTurnCompletion: expect.any(Function),
      probeTurnLiveness: expect.any(Function),
      dispose: expect.any(Function),
    }));
  });

  it('dispatches session runtime creation to the server leaf by default', async () => {
    const ctx = createPluginContextFixture();
    const serverRuntime = { kind: 'server-runtime' };
    const server = vi.fn(async () => serverRuntime);
    const acp = vi.fn(async () => ({ kind: 'acp-runtime' }));
    const executionRuns = vi.fn(() => ({ kind: 'execution-run-runtime' }));
    const engine = createOpenCodeBackendEngine(ctx, {
      sessionRuntimes: { server, acp },
      executionRuns,
    });

    await expect(
      engine.runtimeCore?.createSessionRuntime({ cwd: '/tmp/opencode' }),
    ).resolves.toBe(serverRuntime);

    expect(server).toHaveBeenCalledWith({
      ctx,
      sessionParams: { cwd: '/tmp/opencode' },
    });
    expect(acp).not.toHaveBeenCalled();
  });

  it('applies the host-materialized provider config root to every OpenCode session runtime mode', async () => {
    const ctx = createPluginContextFixture();
    const server = vi.fn(async () => ({ kind: 'server-runtime' }));
    const acp = vi.fn(async () => ({ kind: 'acp-runtime' }));
    const engine = createOpenCodeBackendEngine(ctx, { sessionRuntimes: { server, acp } });
    const providerBindingMaterialization = {
      v: 1 as const,
      kind: 'configFile' as const,
      rootPath: '/tmp/provider-binding',
      relativePaths: ['opencode/opencode.json'],
    };

    await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/opencode',
      env: { KEEP: 'yes' },
      providerBindingMaterialization,
    });

    expect(server).toHaveBeenCalledWith({
      ctx,
      sessionParams: expect.objectContaining({
        providerBindingMaterialization,
        env: { KEEP: 'yes', XDG_CONFIG_HOME: '/tmp/provider-binding' },
      }),
    });
  });

  it('refuses a provider materialization kind that OpenCode cannot consume', async () => {
    const ctx = createPluginContextFixture();
    const server = vi.fn(async () => ({ kind: 'server-runtime' }));
    const engine = createOpenCodeBackendEngine(ctx, { sessionRuntimes: { server } });

    await expect(engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/opencode',
      providerBindingMaterialization: { v: 1, kind: 'engineConfig', engineConfig: {} },
    })).rejects.toThrow('OpenCode requires config-file provider materialization');
    expect(server).not.toHaveBeenCalled();
  });

  it('lets explicit execution environment opt into ACP mode', async () => {
    const ctx = createPluginContextFixture();
    const acpRuntime = { kind: 'acp-runtime' };
    const server = vi.fn(async () => ({ kind: 'server-runtime' }));
    const acp = vi.fn(async () => acpRuntime);
    const executionRuns = vi.fn(() => ({ kind: 'execution-run-runtime' }));
    const engine = createOpenCodeBackendEngine(ctx, {
      sessionRuntimes: { server, acp },
      executionRuns,
    });

    await expect(
      engine.runtimeCore?.createSessionRuntime({
        cwd: '/tmp/opencode',
        isolation: {
          env: {
            HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
          },
        },
        accountSettings: {
          opencodeBackendMode: 'server',
        },
      }),
    ).resolves.toBe(acpRuntime);

    expect(acp).toHaveBeenCalledTimes(1);
    expect(server).not.toHaveBeenCalled();
  });

  it('routes execution-run backend creation through the plugin execution-run leaf', () => {
    const ctx = createPluginContextFixture();
    const executionRunRuntime = { kind: 'execution-run-runtime' };
    const server = vi.fn(async () => ({ kind: 'server-runtime' }));
    const acp = vi.fn(async () => ({ kind: 'acp-runtime' }));
    const executionRuns = vi.fn(() => executionRunRuntime);
    const engine = createOpenCodeBackendEngine(ctx, {
      sessionRuntimes: { server, acp },
      executionRuns,
    });
    const executionRunParams = {
      cwd: '/tmp/opencode',
      permissionMode: 'read_only',
      accountSettings: {
        opencodeBackendMode: 'acp',
      },
    };

    expect(engine.runtimeCore?.createExecutionRunBackend(executionRunParams)).toBe(executionRunRuntime);
    expect(executionRuns).toHaveBeenCalledWith({
      ctx,
      mode: 'acp',
      executionRunParams,
    });
  });
});
