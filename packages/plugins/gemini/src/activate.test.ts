import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/acp';
import type { BackendEngineV1, PluginContextV1, PluginDisposable } from '@happier-dev/plugin-sdk';
import { createAcpBackendEngine, readAcpBackendSpec } from '@happier-dev/plugin-sdk/acp';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

type GeminiBackendRegistration = Readonly<{
  backendId: string;
  create: (ctx: GeminiPluginContextFixture) => BackendEngineV1 | Promise<BackendEngineV1>;
}>;

type GeminiPluginContextFixture = Readonly<{
  acp: Readonly<{
    defineAcpBackend: (spec: AcpBackendSpecV1) => BackendEngineV1;
  }>;
  env: Readonly<{
    list: () => Readonly<Record<string, string>>;
  }>;
  exec: Readonly<{
    run: ReturnType<typeof vi.fn>;
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

function readRegisteredBackend(registerBackendEngine: ReturnType<typeof vi.fn>): GeminiBackendRegistration {
  const registration = registerBackendEngine.mock.calls[0]?.[0];
  if (!registration || typeof registration !== 'object') {
    throw new Error('Expected Gemini activation to register a backend engine');
  }
  return registration as GeminiBackendRegistration;
}

async function disposePluginDisposable(disposable: PluginDisposable): Promise<void> {
  if (typeof disposable === 'function') {
    await disposable();
    return;
  }
  await disposable.dispose();
}

describe('activate', () => {
  it('registers the Gemini ACP backend through the plugin API with dynamic spec', async () => {
    const registerBackendEngine = vi.fn();

    activate({ registerBackendEngine });

    const registration = readRegisteredBackend(registerBackendEngine);
    expect(registration.backendId).toBe('gemini');

    const mockTempDir = {
      path: '/tmp/happier-gemini-mcp-home-test',
      cleanup: vi.fn(),
    };

    const ctx = {
      acp: {
        defineAcpBackend: createAcpBackendEngine,
      },
      env: {
        list: () => ({
          HAPPIER_GEMINI_ACP_AUTH_METHOD: 'gateway',
          HAPPIER_GEMINI_ACP_AUTH_META: JSON.stringify({ gateway: { baseUrl: 'https://test.gateway' } }),
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
    };

    const engine = await registration.create(ctx);
    const spec = readAcpBackendSpec(engine);

    // Verify dynamic auth resolution
    expect(spec.auth).toMatchObject({
      methodId: 'gateway',
    });
    expect(spec.auth?.buildAuthenticateMeta?.(ctx as unknown as PluginContextV1)).toEqual({
      gateway: {
        baseUrl: 'https://test.gateway',
      },
    });

    const argvBuilder = spec.callbacks?.argvBuilder;
    expect(argvBuilder).toBeDefined();
    if (!argvBuilder) {
      throw new Error('Expected Gemini activation to install an ACP argvBuilder callback');
    }
    const args = await argvBuilder({
      baseArgs: [],
      cwd: '/test/cwd',
      env: {},
    });
    expect(args).toEqual(['--acp']);
    expect(ctx.exec.run).toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.arrayContaining(['--help']) }),
      expect.anything(),
    );

    const envBuilder = spec.callbacks?.envBuilder;
    expect(envBuilder).toBeDefined();
    if (!envBuilder) {
      throw new Error('Expected Gemini activation to install an ACP envBuilder callback');
    }
    const env = await envBuilder({ cwd: '/test/cwd', env: {} });
    expect(env.GEMINI_CLI_HOME).toBe(mockTempDir.path);
    expect(env.HOME).toBe(mockTempDir.path);
    expect(ctx.fs.createTempDirectory).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'happier-gemini-mcp-home-' }));
  });

  it('cleans Gemini MCP temp homes when the plugin is disposed', async () => {
    const registerBackendEngine = vi.fn();
    const pluginDisposables: PluginDisposable[] = [];
    const api = {
      registerBackendEngine,
      onDispose: vi.fn((disposable: PluginDisposable): PluginDisposable => {
        pluginDisposables.push(disposable);
        return disposable;
      }),
    };

    activate(api);

    expect(pluginDisposables).toHaveLength(1);

    const registration = readRegisteredBackend(registerBackendEngine);
    const cleanups = [vi.fn(), vi.fn()];
    const tempDirs = [
      { path: '/tmp/happier-gemini-mcp-home-one', cleanup: cleanups[0] },
      { path: '/tmp/happier-gemini-mcp-home-two', cleanup: cleanups[1] },
    ];
    const ctx = {
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
    };

    const engine = await registration.create(ctx);
    const spec = readAcpBackendSpec(engine);
    const envBuilder = spec.callbacks?.envBuilder;
    if (!envBuilder) {
      throw new Error('Expected Gemini activation to install an ACP envBuilder callback');
    }

    await envBuilder({ cwd: '/test/cwd', env: {} });
    await envBuilder({ cwd: '/test/cwd', env: {} });

    expect(cleanups[0]).not.toHaveBeenCalled();
    expect(cleanups[1]).not.toHaveBeenCalled();

    await disposePluginDisposable(pluginDisposables[0]!);
    await disposePluginDisposable(pluginDisposables[0]!);

    expect(cleanups[0]).toHaveBeenCalledTimes(1);
    expect(cleanups[1]).toHaveBeenCalledTimes(1);
  });

  it('does not build Gemini ACP argv after the plugin is disposed', async () => {
    const registerBackendEngine = vi.fn();
    const pluginDisposables: PluginDisposable[] = [];
    activate({
      registerBackendEngine,
      onDispose: vi.fn((disposable: PluginDisposable): PluginDisposable => {
        pluginDisposables.push(disposable);
        return disposable;
      }),
    });

    const registration = readRegisteredBackend(registerBackendEngine);
    const ctx = {
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
    };

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
    expect(ctx.exec.run).not.toHaveBeenCalled();
  });

  it('preserves host-resolved launch argv while selecting the available ACP flag', async () => {
    const registerBackendEngine = vi.fn();

    activate({ registerBackendEngine });

    const registration = readRegisteredBackend(registerBackendEngine);
    const ctx = {
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
    };

    const engine = await registration.create(ctx);
    const spec = readAcpBackendSpec(engine);
    const argvBuilder = spec.callbacks?.argvBuilder;
    if (!argvBuilder) {
      throw new Error('Expected Gemini activation to install an ACP argvBuilder callback');
    }

    await expect(argvBuilder({
      baseArgs: ['/managed/gemini/bin/gemini.js', '--acp', '--approval-mode', 'plan'],
      cwd: '/test/cwd',
      env: {},
      permissionMode: 'plan',
    })).resolves.toEqual(['/managed/gemini/bin/gemini.js', '--experimental-acp', '--approval-mode', 'plan']);
  });

  it('selects API-key ACP auth when GEMINI_API_KEY is available', async () => {
    const registerBackendEngine = vi.fn();

    activate({ registerBackendEngine });

    const registration = readRegisteredBackend(registerBackendEngine);
    const ctx = {
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
    };

    const engine = await registration.create(ctx);
    const spec = readAcpBackendSpec(engine);

    expect(spec.auth).toMatchObject({
      methodId: 'gemini-api-key',
    });
  });

  it('keeps parent-only Gemini ACP auth controls out of the child launch env', async () => {
    const registerBackendEngine = vi.fn();

    activate({ registerBackendEngine });

    const registration = readRegisteredBackend(registerBackendEngine);
    const ctx = {
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
    };

    const engine = await registration.create(ctx);
    const spec = readAcpBackendSpec(engine);
    expect(spec.auth?.buildAuthenticateMeta?.(ctx as unknown as PluginContextV1)).toEqual({
      gateway: {
        baseUrl: 'https://gateway.example.test/v1',
        headers: {
          Authorization: 'Bearer parent-only-token',
        },
      },
    });

    const envBuilder = spec.callbacks?.envBuilder;
    if (!envBuilder) {
      throw new Error('Expected Gemini activation to install an ACP envBuilder callback');
    }

    const env = await envBuilder({
      cwd: '/test/cwd',
      env: {
        PATH: '/usr/bin',
        HAPPIER_GEMINI_ACP_AUTH_METHOD: 'gateway',
        HAPPIER_GEMINI_ACP_AUTH_META: JSON.stringify({ gateway: { headers: { Authorization: 'Bearer leaked-token' } } }),
      },
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.GEMINI_CLI_HOME).toBe('/tmp/happier-gemini-mcp-home-test');
    expect(env.HAPPIER_GEMINI_ACP_AUTH_METHOD).toBeUndefined();
    expect(env.HAPPIER_GEMINI_ACP_AUTH_META).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('leaked-token');
  });

  it('exposes Gemini API keys through the ACP auth env hook', async () => {
    const registerBackendEngine = vi.fn();

    activate({ registerBackendEngine });

    const registration = readRegisteredBackend(registerBackendEngine);
    const ctx = {
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
    };

    const engine = await registration.create(ctx);
    const spec = readAcpBackendSpec(engine);

    expect(spec.auth?.buildAuthEnv?.(ctx)).toEqual({
      GEMINI_API_KEY: 'AIzaPluginScopedKey',
      GOOGLE_API_KEY: 'AIzaPluginScopedKey',
    });
  });
});
