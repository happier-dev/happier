import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/experimental/acp';
import type { AgentRuntimeV1, PluginContextV1, PluginDisposable } from '@happier-dev/plugin-sdk';
import { createAcpBackendEngine, readAcpBackendSpec } from '@happier-dev/plugin-sdk/experimental/acp';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

type GeminiBackendRegistration = Readonly<{
  agentId: string;
  create: (ctx: GeminiPluginContextFixture) => AgentRuntimeV1 | Promise<AgentRuntimeV1>;
}>;

type GeminiPluginContextFixture = Readonly<{
  agentRuntime: Readonly<{
    acp: Readonly<{
      defineAcpBackend: (spec: AcpBackendSpecV1) => AgentRuntimeV1;
    }>;
    exec: Readonly<{
      run: ReturnType<typeof vi.fn>;
    }>;
  }>;
  env: Readonly<{
    list: () => Readonly<Record<string, string>>;
  }>;
  fs: Readonly<{
    createTempDirectory: ReturnType<typeof vi.fn>;
  }>;
  abort: Readonly<{
    signal: Readonly<{
      addEventListener: ReturnType<typeof vi.fn>;
    }>;
  }>;
}>;

type GeminiPluginContextFixtureInput = Readonly<{
  acp: GeminiPluginContextFixture['agentRuntime']['acp'];
  exec: GeminiPluginContextFixture['agentRuntime']['exec'];
  env: GeminiPluginContextFixture['env'];
  fs: GeminiPluginContextFixture['fs'];
  abort: GeminiPluginContextFixture['abort'];
}>;

function createGeminiContextFixture(input: GeminiPluginContextFixtureInput): GeminiPluginContextFixture {
  const { acp, exec, ...core } = input;
  return {
    ...core,
    agentRuntime: {
      acp,
      exec,
    },
  };
}

type GeminiAcpAuthWithMethodResolver = NonNullable<AcpBackendSpecV1['auth']> & Readonly<{
  resolveMethodId?: (
    ctx: PluginContextV1,
    params: Readonly<{
      cwd: string;
      env: Readonly<Record<string, string>>;
    }>,
  ) => string | null | undefined;
}>;

function readRegisteredBackend(registerAgentRuntime: ReturnType<typeof vi.fn>): GeminiBackendRegistration {
  const registration = registerAgentRuntime.mock.calls[0]?.[0];
  if (!registration || typeof registration !== 'object') {
    throw new Error('Expected Gemini activation to register a backend engine');
  }
  return registration as GeminiBackendRegistration;
}

function createGeminiPluginApi(overrides: Readonly<{
  registerAgentRuntime?: ReturnType<typeof vi.fn>;
  registerHook?: ReturnType<typeof vi.fn>;
  onDispose?: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    registerAgentRuntime: vi.fn(),
    registerHook: vi.fn(),
    onDispose: vi.fn((disposable: PluginDisposable): PluginDisposable => disposable),
    ...overrides,
  };
}

async function disposePluginDisposable(disposable: PluginDisposable): Promise<void> {
  if (typeof disposable === 'function') {
    await disposable();
    return;
  }
  await disposable.dispose();
}

function applyRuntimeEnvOverlay(
  baseEnv: Readonly<Record<string, string>>,
  overlayEnv: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return {
    ...baseEnv,
    ...overlayEnv,
  };
}

describe('activate', () => {
  it('registers provider-owned daemon spawn prerequisite hook for Gemini auth preflight', () => {
    const registerAgentRuntime = vi.fn();
    const registerHook = vi.fn();

    activate(createGeminiPluginApi({ registerAgentRuntime, registerHook }));

    expect(registerHook).toHaveBeenCalledWith(expect.objectContaining({
      hookId: 'agent.resolvePrerequisites',
      category: 'decision',
      scope: 'agent',
      filters: { agentId: 'gemini' },
      executionKind: 'decide',
      handler: expect.any(Function),
    }));
  });

  it('registers the Gemini ACP backend through the plugin API with dynamic spec', async () => {
    const registerAgentRuntime = vi.fn();

    activate(createGeminiPluginApi({ registerAgentRuntime }));

    const registration = readRegisteredBackend(registerAgentRuntime);
    expect(registration.agentId).toBe('gemini');

    const mockTempDir = {
      path: '/tmp/happier-gemini-mcp-home-test',
      cleanup: vi.fn(),
    };

    const ctx = createGeminiContextFixture({
      acp: {
        defineAcpBackend: createAcpBackendEngine,
      },
      env: {
        list: () => ({
          GEMINI_API_KEY: 'AIzaPluginScopedKey',
        }),
      },
      exec: {
        run: vi.fn().mockResolvedValue({ stdout: '--acp', stderr: '', exitCode: 0 }),
      },
      fs: {
        createTempDirectory: vi.fn().mockResolvedValue(mockTempDir),
      },
      abort: {
        signal: {
          addEventListener: vi.fn(),
        },
      },
    });

    const engine = await registration.create(ctx);
    const spec = readAcpBackendSpec(engine);

    expect(spec.auth).toMatchObject({
      methodId: 'gemini-api-key',
    });
    expect(spec.auth?.buildAuthenticateMeta?.(ctx as unknown as PluginContextV1)).toBeUndefined();

    const argvBuilder = spec.callbacks?.argvBuilder;
    expect(argvBuilder).toBeDefined();
    if (!argvBuilder) {
      throw new Error('Expected Gemini activation to install an ACP argvBuilder callback');
    }
    const args = await argvBuilder({
      baseArgs: [],
      cwd: '/test/cwd',
      env: { GEMINI_API_KEY: 'AIzaPluginScopedKey' },
    });
    expect(args).toEqual(['--acp']);
    expect(ctx.agentRuntime.exec.run).toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.arrayContaining(['--help']) }),
      expect.anything(),
    );

    const envBuilder = spec.callbacks?.envBuilder;
    expect(envBuilder).toBeDefined();
    if (!envBuilder) {
      throw new Error('Expected Gemini activation to install an ACP envBuilder callback');
    }
    const env = await envBuilder({ cwd: '/test/cwd', env: { GEMINI_API_KEY: 'AIzaPluginScopedKey' } });
    expect(env.GEMINI_CLI_HOME).toBe(mockTempDir.path);
    expect(env.HOME).toBe(mockTempDir.path);
    expect(ctx.fs.createTempDirectory).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'happier-gemini-mcp-home-' }));
  });

  it('cleans Gemini MCP temp homes when the plugin is disposed', async () => {
    const registerAgentRuntime = vi.fn();
    const pluginDisposables: PluginDisposable[] = [];
    const api = {
      registerAgentRuntime,
      registerHook: vi.fn(),
      onDispose: vi.fn((disposable: PluginDisposable): PluginDisposable => {
        pluginDisposables.push(disposable);
        return disposable;
      }),
    };

    activate(api);

    expect(pluginDisposables).toHaveLength(1);

    const registration = readRegisteredBackend(registerAgentRuntime);
    const cleanups = [vi.fn(), vi.fn()];
    const tempDirs = [
      { path: '/tmp/happier-gemini-mcp-home-one', cleanup: cleanups[0] },
      { path: '/tmp/happier-gemini-mcp-home-two', cleanup: cleanups[1] },
    ];
    const ctx = createGeminiContextFixture({
      acp: {
        defineAcpBackend: createAcpBackendEngine,
      },
      env: {
        list: () => ({}),
      },
      exec: {
        run: vi.fn().mockResolvedValue({ stdout: '--acp', stderr: '', exitCode: 0 }),
      },
      fs: {
        createTempDirectory: vi.fn()
          .mockResolvedValueOnce(tempDirs[0])
          .mockResolvedValueOnce(tempDirs[1]),
      },
      abort: {
        signal: {
          addEventListener: vi.fn(),
        },
      },
    });

    const engine = await registration.create(ctx);
    const spec = readAcpBackendSpec(engine);
    const envBuilder = spec.callbacks?.envBuilder;
    if (!envBuilder) {
      throw new Error('Expected Gemini activation to install an ACP envBuilder callback');
    }

    await envBuilder({ cwd: '/test/cwd', env: { GEMINI_API_KEY: 'AIzaPluginScopedKey' } });
    await envBuilder({ cwd: '/test/cwd', env: { GEMINI_API_KEY: 'AIzaPluginScopedKey' } });

    expect(cleanups[0]).not.toHaveBeenCalled();
    expect(cleanups[1]).not.toHaveBeenCalled();

    await disposePluginDisposable(pluginDisposables[0]!);
    await disposePluginDisposable(pluginDisposables[0]!);

    expect(cleanups[0]).toHaveBeenCalledTimes(1);
    expect(cleanups[1]).toHaveBeenCalledTimes(1);
  });

  it('does not build Gemini ACP argv after the plugin is disposed', async () => {
    const registerAgentRuntime = vi.fn();
    const pluginDisposables: PluginDisposable[] = [];
    activate({
      registerAgentRuntime,
      registerHook: vi.fn(),
      onDispose: vi.fn((disposable: PluginDisposable): PluginDisposable => {
        pluginDisposables.push(disposable);
        return disposable;
      }),
    });

    const registration = readRegisteredBackend(registerAgentRuntime);
    const ctx = createGeminiContextFixture({
      acp: {
        defineAcpBackend: createAcpBackendEngine,
      },
      env: {
        list: () => ({}),
      },
      exec: {
        run: vi.fn().mockResolvedValue({ stdout: '--acp', stderr: '', exitCode: 0 }),
      },
      fs: {
        createTempDirectory: vi.fn().mockResolvedValue({
          path: '/tmp/happier-gemini-mcp-home-test',
          cleanup: vi.fn(),
        }),
      },
      abort: {
        signal: {
          aborted: false,
          addEventListener: vi.fn(),
        },
      },
    });

    const engine = await registration.create(ctx);
    const spec = readAcpBackendSpec(engine);
    const argvBuilder = spec.callbacks?.argvBuilder;
    if (!argvBuilder) {
      throw new Error('Expected Gemini activation to install an ACP argvBuilder callback');
    }

    await disposePluginDisposable(pluginDisposables[0]!);

    await expect(argvBuilder({
      baseArgs: [],
      cwd: '/test/cwd',
      env: {},
    })).rejects.toThrow('Gemini ACP argv builder is disposed.');
    expect(ctx.agentRuntime.exec.run).not.toHaveBeenCalled();
  });

  it('preserves host-resolved launch argv while selecting the available ACP flag', async () => {
    const registerAgentRuntime = vi.fn();

    activate(createGeminiPluginApi({ registerAgentRuntime }));

    const registration = readRegisteredBackend(registerAgentRuntime);
    const ctx = createGeminiContextFixture({
      acp: {
        defineAcpBackend: createAcpBackendEngine,
      },
      env: {
        list: () => ({}),
      },
      exec: {
        run: vi.fn().mockResolvedValue({
          stdout: 'Usage: gemini --experimental-acp',
          stderr: '',
          exitCode: 0,
        }),
      },
      fs: {
        createTempDirectory: vi.fn().mockResolvedValue({
          path: '/tmp/happier-gemini-mcp-home-test',
          cleanup: vi.fn(),
        }),
      },
      abort: {
        signal: {
          addEventListener: vi.fn(),
        },
      },
    });

    const engine = await registration.create(ctx);
    const spec = readAcpBackendSpec(engine);
    const argvBuilder = spec.callbacks?.argvBuilder;
    if (!argvBuilder) {
      throw new Error('Expected Gemini activation to install an ACP argvBuilder callback');
    }

    await expect(argvBuilder({
      baseArgs: ['/managed/gemini/bin/gemini.js', '--acp', '--approval-mode', 'plan'],
      cwd: '/test/cwd',
      env: { GEMINI_API_KEY: 'AIzaPluginScopedKey' },
      permissionMode: 'plan',
    })).resolves.toEqual(['/managed/gemini/bin/gemini.js', '--experimental-acp', '--approval-mode', 'plan']);
  });

  it('selects API-key ACP auth when GEMINI_API_KEY is available', async () => {
    const registerAgentRuntime = vi.fn();

    activate(createGeminiPluginApi({ registerAgentRuntime }));

    const registration = readRegisteredBackend(registerAgentRuntime);
    const ctx = createGeminiContextFixture({
      acp: {
        defineAcpBackend: createAcpBackendEngine,
      },
      env: {
        list: () => ({
          GEMINI_API_KEY: 'AIzaPluginScopedKey',
        }),
      },
      exec: {
        run: vi.fn().mockResolvedValue({ stdout: '--acp', stderr: '', exitCode: 0 }),
      },
      fs: {
        createTempDirectory: vi.fn().mockResolvedValue({
          path: '/tmp/happier-gemini-mcp-home-test',
          cleanup: vi.fn(),
        }),
      },
      abort: {
        signal: {
          addEventListener: vi.fn(),
        },
      },
    });

    const engine = await registration.create(ctx);
    const spec = readAcpBackendSpec(engine);

    expect(spec.auth).toMatchObject({
      methodId: 'gemini-api-key',
    });
  });

  it('fails closed before launch when no API-key or Vertex credential env is materialized', async () => {
    const registerAgentRuntime = vi.fn();

    activate(createGeminiPluginApi({ registerAgentRuntime }));

    const registration = readRegisteredBackend(registerAgentRuntime);
    const ctx = createGeminiContextFixture({
      acp: {
        defineAcpBackend: createAcpBackendEngine,
      },
      env: {
        list: () => ({}),
      },
      exec: {
        run: vi.fn().mockResolvedValue({ stdout: '--acp', stderr: '', exitCode: 0 }),
      },
      fs: {
        createTempDirectory: vi.fn().mockResolvedValue({
          path: '/tmp/happier-gemini-mcp-home-test',
          cleanup: vi.fn(),
        }),
      },
      abort: {
        signal: {
          addEventListener: vi.fn(),
        },
      },
    });

    const engine = await registration.create(ctx);
    const spec = readAcpBackendSpec(engine);
    expect(spec.auth?.methodId).toBe('gemini-api-key');

    const auth = spec.auth as GeminiAcpAuthWithMethodResolver | undefined;
    expect(() => auth?.resolveMethodId?.(ctx as unknown as PluginContextV1, {
      cwd: '/test/cwd',
      env: {},
    })).toThrow(/GEMINI_API_KEY|GOOGLE_API_KEY|Vertex/);

    const argvBuilder = spec.callbacks?.argvBuilder;
    if (!argvBuilder) {
      throw new Error('Expected Gemini activation to install an ACP argvBuilder callback');
    }
    await expect(argvBuilder({
      baseArgs: ['/managed/gemini/bin/gemini.js', '--acp'],
      cwd: '/test/cwd',
      env: {},
    })).rejects.toThrow(/GEMINI_API_KEY|GOOGLE_API_KEY|Vertex/);
    expect(ctx.agentRuntime.exec.run).not.toHaveBeenCalled();

    const envBuilder = spec.callbacks?.envBuilder;
    if (!envBuilder) {
      throw new Error('Expected Gemini activation to install an ACP envBuilder callback');
    }
    await expect(envBuilder({
      cwd: '/test/cwd',
      env: {
        PATH: '/usr/bin',
      },
    })).rejects.toThrow(/GEMINI_API_KEY|GOOGLE_API_KEY|Vertex/);
    expect(ctx.fs.createTempDirectory).not.toHaveBeenCalled();
  });

  it('keeps parent-only Gemini ACP auth controls out of the child launch env', async () => {
    const registerAgentRuntime = vi.fn();

    activate(createGeminiPluginApi({ registerAgentRuntime }));

    const registration = readRegisteredBackend(registerAgentRuntime);
    const ctx = createGeminiContextFixture({
      acp: {
        defineAcpBackend: createAcpBackendEngine,
      },
      env: {
        list: () => ({
          HAPPIER_GEMINI_ACP_AUTH_METHOD: 'gateway',
          HAPPIER_GEMINI_ACP_AUTH_META: JSON.stringify({
            gateway: {
              baseUrl: 'https://gateway.example.test/v1',
              headers: {
                Authorization: 'Bearer parent-only-token',
              },
            },
          }),
        }),
      },
      exec: {
        run: vi.fn().mockResolvedValue({ stdout: '--acp', stderr: '', exitCode: 0 }),
      },
      fs: {
        createTempDirectory: vi.fn().mockResolvedValue({
          path: '/tmp/happier-gemini-mcp-home-test',
          cleanup: vi.fn(),
        }),
      },
      abort: {
        signal: {
          addEventListener: vi.fn(),
        },
      },
    });

    const engine = await registration.create(ctx);
    const spec = readAcpBackendSpec(engine);
    expect(spec.auth?.methodId).toBe('gemini-api-key');
    expect(spec.auth?.buildAuthenticateMeta?.(ctx as unknown as PluginContextV1)).toBeUndefined();

    const envBuilder = spec.callbacks?.envBuilder;
    if (!envBuilder) {
      throw new Error('Expected Gemini activation to install an ACP envBuilder callback');
    }

    const inputEnv = {
      PATH: '/usr/bin',
      GEMINI_API_KEY: 'AIzaPluginScopedKey',
      HAPPIER_GEMINI_ACP_AUTH_METHOD: 'gateway',
      HAPPIER_GEMINI_ACP_AUTH_META: JSON.stringify({ gateway: { headers: { Authorization: 'Bearer leaked-token' } } }),
    };
    const env = applyRuntimeEnvOverlay(inputEnv, await envBuilder({
      cwd: '/test/cwd',
      env: inputEnv,
    }));

    expect(env.PATH).toBe('/usr/bin');
    expect(env.GEMINI_CLI_HOME).toBe('/tmp/happier-gemini-mcp-home-test');
    expect(env.HAPPIER_GEMINI_ACP_AUTH_METHOD).toBe('');
    expect(env.HAPPIER_GEMINI_ACP_AUTH_META).toBe('');
    expect(JSON.stringify(env)).not.toContain('leaked-token');
  });

  it('resolves Gemini API keys from the final scoped ACP launch environment', async () => {
    const registerAgentRuntime = vi.fn();

    activate(createGeminiPluginApi({ registerAgentRuntime }));

    const registration = readRegisteredBackend(registerAgentRuntime);
    const ctx = createGeminiContextFixture({
      acp: {
        defineAcpBackend: createAcpBackendEngine,
      },
      env: {
        list: () => ({
          GEMINI_API_KEY: 'AIzaPluginScopedKey',
        }),
      },
      exec: {
        run: vi.fn().mockResolvedValue({ stdout: '--acp', stderr: '', exitCode: 0 }),
      },
      fs: {
        createTempDirectory: vi.fn().mockResolvedValue({
          path: '/tmp/happier-gemini-mcp-home-test',
          cleanup: vi.fn(),
        }),
      },
      abort: {
        signal: {
          addEventListener: vi.fn(),
        },
      },
    });

    const engine = await registration.create(ctx);
    const spec = readAcpBackendSpec(engine);

    expect(spec.auth?.buildAuthEnv?.(ctx)).toBeUndefined();

    const auth = spec.auth as GeminiAcpAuthWithMethodResolver | undefined;
    expect(auth?.resolveMethodId?.(ctx as unknown as PluginContextV1, {
      cwd: '/test/cwd',
      env: {
        GEMINI_API_KEY: 'AIzaPluginScopedKey',
      },
    })).toBe('gemini-api-key');
  });

  it('selects Vertex ACP auth from final materialized launch env', async () => {
    const registerAgentRuntime = vi.fn();

    activate(createGeminiPluginApi({ registerAgentRuntime }));

    const registration = readRegisteredBackend(registerAgentRuntime);
    const ctx = createGeminiContextFixture({
      acp: {
        defineAcpBackend: createAcpBackendEngine,
      },
      env: {
        list: () => ({}),
      },
      exec: {
        run: vi.fn().mockResolvedValue({ stdout: '--acp', stderr: '', exitCode: 0 }),
      },
      fs: {
        createTempDirectory: vi.fn().mockResolvedValue({
          path: '/tmp/happier-gemini-mcp-home-test',
          cleanup: vi.fn(),
        }),
      },
      abort: {
        signal: {
          addEventListener: vi.fn(),
        },
      },
    });

    const engine = await registration.create(ctx);
    const spec = readAcpBackendSpec(engine);
    const auth = spec.auth as GeminiAcpAuthWithMethodResolver | undefined;

    expect(auth?.methodId).toBe('gemini-api-key');
    expect(auth?.resolveMethodId?.(ctx as unknown as PluginContextV1, {
      cwd: '/test/cwd',
      env: {
        GOOGLE_GENAI_USE_VERTEXAI: 'true',
        GOOGLE_CLOUD_PROJECT: 'happier-vertex-project',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
      },
    })).toBe('vertex-ai');
    expect(spec.auth?.buildAuthEnv?.(ctx)).toBeUndefined();
  });

  it('forces Vertex launch env when Vertex auth is selected over a contradictory parent env', async () => {
    const registerAgentRuntime = vi.fn();

    activate(createGeminiPluginApi({ registerAgentRuntime }));

    const registration = readRegisteredBackend(registerAgentRuntime);
    const ctx = createGeminiContextFixture({
      acp: {
        defineAcpBackend: createAcpBackendEngine,
      },
      env: {
        list: () => ({}),
      },
      exec: {
        run: vi.fn().mockResolvedValue({ stdout: '--acp', stderr: '', exitCode: 0 }),
      },
      fs: {
        createTempDirectory: vi.fn().mockResolvedValue({
          path: '/tmp/happier-gemini-mcp-home-test',
          cleanup: vi.fn(),
        }),
      },
      abort: {
        signal: {
          addEventListener: vi.fn(),
        },
      },
    });

    const engine = await registration.create(ctx);
    const spec = readAcpBackendSpec(engine);
    const envBuilder = spec.callbacks?.envBuilder;
    if (!envBuilder) {
      throw new Error('Expected Gemini activation to install an ACP envBuilder callback');
    }

    const inputEnv = {
      HAPPIER_GEMINI_ACP_AUTH_METHOD: 'vertex-ai',
      GOOGLE_GENAI_USE_VERTEXAI: 'false',
      GOOGLE_CLOUD_PROJECT: 'happier-vertex-project',
      GOOGLE_CLOUD_LOCATION: 'us-central1',
    };
    const env = applyRuntimeEnvOverlay(inputEnv, await envBuilder({
      cwd: '/test/cwd',
      env: inputEnv,
    }));

    expect(env.GOOGLE_GENAI_USE_VERTEXAI).toBe('1');
    expect(env.GOOGLE_CLOUD_PROJECT).toBe('happier-vertex-project');
    expect(env.GOOGLE_CLOUD_LOCATION).toBe('us-central1');
    expect(env.HAPPIER_GEMINI_ACP_AUTH_METHOD).toBe('');
    expect(ctx.fs.createTempDirectory).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'happier-gemini-mcp-home-' }));
  });
});
