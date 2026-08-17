import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import type {
  ManagedServiceHandle,
  ManagedServiceRequest,
  ManagedServiceResponse,
  ManagedServiceSnapshot,
} from '@happier-dev/plugin-sdk/managed-services';

import { createOpenCodeServerRuntimeAssembly } from './assembly.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';
import {
  OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '../../auth/services/requestAuth/env.js';

function managedServiceHandle(params: Readonly<{
  baseUrl: string;
  state?: () => ManagedServiceSnapshot['state'];
  waitError?: Error;
  onDispose?: () => void;
  request?: (input: ManagedServiceRequest) => Promise<ManagedServiceResponse>;
}>): ManagedServiceHandle {
  const readSnapshot = (): ManagedServiceSnapshot => ({
    id: 'opencode-server',
    state: params.state?.() ?? 'healthy',
    mode: 'spawn',
    baseUrl: params.baseUrl,
    startedAtMs: 100,
    lastHealthyAtMs: 101,
    diagnostics: [],
    diagnosticsTruncated: false,
  });
  return {
    snapshot: readSnapshot,
    observe: (listener) => {
      listener(readSnapshot());
      return { dispose() {} };
    },
    waitUntilHealthy: async () => {
      if (params.waitError) throw params.waitError;
      return readSnapshot();
    },
    stop: async () => ({ status: 'stopped' }),
    dispose: async () => {
      params.onDispose?.();
    },
    request: params.request ?? (async (input) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: new Response(
        input.pathAndQuery === '/session?directory=%2Frepo'
          ? JSON.stringify({ id: 'oc-session-1' })
          : '{}',
      ).body,
    })),
  };
}

function createContextFixture(params: Readonly<{
  managedServerBaseUrl: string;
  managedServerWaitError?: Error;
  onManagedServerDispose?: () => void;
}>): OpenCodeRuntimeContext {
  const abortController = new AbortController();
  const sessionStorage = new Map<string, unknown>();
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    env: {
      list: () => ({}),
    },
    abort: {
      signal: abortController.signal,
      compose: (signals) => AbortSignal.any(signals),
    },
    config: { values: {} },
    managedServices: {
      dependencies: {} as OpenCodeRuntimeContext['managedServices']['dependencies'],
      supervise: vi.fn(async () => managedServiceHandle({
        baseUrl: params.managedServerBaseUrl,
        waitError: params.managedServerWaitError,
        onDispose: params.onManagedServerDispose,
      })),
    },
    ui: {
      askQuestions: vi.fn(async () => ({
        requestId: 'question-cancelled',
        kind: 'questions' as const,
        status: 'userCancelled' as const,
      })),
    },
    sessions: {
      current: {
        permissions: {
          requestDecision: vi.fn(async () => ({
            status: 'approved' as const,
            persistence: 'once' as const,
          })),
        },
      },
      writeStateField: vi.fn(async () => undefined),
    },
    storage: {
      daemonSession: {
        get: vi.fn(async (key: string) => sessionStorage.get(key)),
        set: vi.fn(async (key: string, value: unknown) => {
          sessionStorage.set(key, value);
        }),
      },
    },
    experimental: {
      telemetry: {
        emit: vi.fn(),
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenCode server managed-service assembly', () => {
  it('releases an acquired managed server when startup health does not settle', async () => {
    const startupError = new Error('managed server startup did not settle');
    const onManagedServerDispose = vi.fn();
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49195',
      managedServerWaitError: startupError,
      onManagedServerDispose,
    });

    await expect(createOpenCodeServerRuntimeAssembly({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-startup-failed',
      endpoint: { mode: 'managed-spawn' },
      request: {
        kind: 'create',
        sessionId: 'happy-session-startup-failed',
        cwd: '/repo',
      },
    })).rejects.toBe(startupError);

    expect(onManagedServerDispose).toHaveBeenCalledOnce();
  });

  it('keeps managed launch environment inside the exact OpenCode-owned child scope', async () => {
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49198',
    });
    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-env',
      endpoint: { mode: 'managed-spawn' },
      env: {
        HAPPIER_OPENCODE_PROVIDER_API_KEY: 'provider-secret',
        OPENCODE_AUTH_CONTENT: '{"openai":{"type":"api"}}',
        OPENCODE_CONFIG_CONTENT: '{}',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        XDG_CONFIG_HOME: '/private/opencode-connected-config',
        [OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/private/opencode-request-auth/capability.json',
        OPENCODE_PERMISSION: 'ambient-permission-must-not-win',
        OPENCODE_SERVER_PASSWORD: 'ambient-password-must-not-win',
        HAPPIER_OPENCODE_SERVER_URL: 'http://attacker.invalid',
        HAPPIER_OPENCODE_PATH: '/tmp/ambient-opencode',
        FOREIGN_SECRET: 'must-not-reach-opencode',
      },
      permissionMode: 'plan',
      request: {
        kind: 'create',
        sessionId: 'happy-session-env',
        cwd: '/repo',
      },
    });

    try {
      const superviseSpec = vi.mocked(ctx.managedServices.supervise).mock.calls[0]?.[0];
      expect(superviseSpec?.mode).not.toHaveProperty('baseUrlEnvKey');
      expect(superviseSpec?.mode.kind === 'spawn' ? superviseSpec.mode.launch.env : null).toEqual({
        HAPPIER_OPENCODE_PROVIDER_API_KEY: 'provider-secret',
        OPENCODE_AUTH_CONTENT: '{"openai":{"type":"api"}}',
        OPENCODE_CONFIG_CONTENT: '{}',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        XDG_CONFIG_HOME: '/private/opencode-connected-config',
        [OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/private/opencode-request-auth/capability.json',
        OPENCODE_PERMISSION: expect.any(String),
      });
      expect(superviseSpec?.mode.kind === 'spawn' ? superviseSpec.mode.launch.env : null)
        .not.toHaveProperty('OPENCODE_SERVER_PASSWORD');
      expect(superviseSpec?.clientAccess).toEqual({
        kind: 'hostBasic',
        username: 'opencode',
        injectPasswordEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
      });
    } finally {
      await assembly.dispose();
    }
  });

  it('loads the host-materialized Provider config as OpenCode runtime config', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-opencode-provider-'));
    const relativePath = 'opencode/opencode.json';
    const configPath = join(rootPath, relativePath);
    const configContent = JSON.stringify({
      enabled_providers: ['happier_test'],
      model: 'happier_test/gateway-model',
      provider: {
        happier_test: {
          npm: '@ai-sdk/openai-compatible',
          models: { 'gateway-model': { name: 'Gateway model' } },
        },
      },
    });
    await mkdir(join(rootPath, 'opencode'));
    await writeFile(configPath, configContent, 'utf8');

    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49199',
    });
    let assembly: Awaited<ReturnType<typeof createOpenCodeServerRuntimeAssembly>> | null = null;
    try {
      assembly = await createOpenCodeServerRuntimeAssembly({
        ctx,
        directory: '/repo',
        happierSessionId: 'happy-session-provider',
        endpoint: { mode: 'managed-spawn' },
        env: {
          OPENCODE_CONFIG_CONTENT: '{"provider":{"ambient":{}}}',
        },
        request: {
          kind: 'create',
          sessionId: 'happy-session-provider',
          cwd: '/repo',
          providerBinding: {
            connectionId: ProviderConnectionIdSchema.parse('pc_openrouter_work'),
            model: { id: 'gateway-model', name: 'Gateway model' },
            materialization: {
              v: 1,
              kind: 'configFile',
              rootPath,
              relativePaths: [relativePath],
            },
          },
        },
      });

      const superviseSpec = vi.mocked(ctx.managedServices.supervise).mock.calls[0]?.[0];
      expect(superviseSpec?.mode.kind === 'spawn' ? superviseSpec.mode.launch.env : null).toMatchObject({
        OPENCODE_CONFIG_CONTENT: configContent,
      });
    } finally {
      await assembly?.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('fails closed when a Provider binding cannot be applied to an external server', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-opencode-provider-'));
    const relativePath = 'opencode/opencode.json';
    await mkdir(join(rootPath, 'opencode'));
    await writeFile(join(rootPath, relativePath), '{}', 'utf8');

    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49200',
    });
    try {
      await expect(createOpenCodeServerRuntimeAssembly({
        ctx,
        directory: '/repo',
        happierSessionId: 'happy-session-provider-external',
        endpoint: {
          mode: 'external-attach',
          baseUrl: 'http://127.0.0.1:49200',
        },
        request: {
          kind: 'create',
          sessionId: 'happy-session-provider-external',
          cwd: '/repo',
          providerBinding: {
            connectionId: ProviderConnectionIdSchema.parse('pc_openrouter_work'),
            model: { id: 'gateway-model', name: 'Gateway model' },
            materialization: {
              v: 1,
              kind: 'configFile',
              rootPath,
              relativePaths: [relativePath],
            },
          },
        },
      })).rejects.toThrow('OpenCode Provider binding requires a managed server');
      expect(ctx.managedServices.supervise).not.toHaveBeenCalled();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('supervises an external loopback server through SVC09 without requiring the host fetch service', async () => {
    const externalBaseUrl = 'http://127.0.0.1:49202';
    const onManagedServerDispose = vi.fn();
    const ctx = createContextFixture({
      managedServerBaseUrl: externalBaseUrl,
      onManagedServerDispose,
    });
    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-external',
      endpoint: {
        mode: 'external-attach',
        baseUrl: externalBaseUrl,
        credential: null,
      },
      request: {
        kind: 'create',
        sessionId: 'happy-session-external',
        cwd: '/repo',
      },
    });

    expect(ctx.managedServices.supervise).toHaveBeenCalledWith(expect.objectContaining({
      id: 'opencode-server',
      mode: {
        kind: 'attach',
        baseUrl: externalBaseUrl,
      },
      clientAccess: {
        kind: 'declaredSecretBasic',
        username: 'opencode',
        passwordSecretId: 'opencodeServerPassword',
      },
      healthCheck: {
        kind: 'http',
        target: { kind: 'servicePath', path: '/global/health' },
        timeoutMs: 5_000,
      },
    }), expect.any(Object));
    await assembly.dispose();
    expect(onManagedServerDispose).toHaveBeenCalledOnce();
  });
});
