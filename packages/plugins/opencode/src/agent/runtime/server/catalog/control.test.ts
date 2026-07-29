import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import {
  createOpenCodeServerCatalogControlAdapter,
  type OpenCodeSessionCatalogControlAdapterParams,
} from './control.js';
import { createOpenCodeServerRuntimeAssembly } from '../assembly.js';
import type { OpenCodeRuntimeContext } from '../runtimeContext.js';
import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '../managedServerState.js';
import {
  OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '../../../auth/services/requestAuth/env.js';

function createContextFixture(params: Readonly<{
  managedServerBaseUrl: string;
  managedServerWaitError?: Error;
  onManagedServerDispose?: () => void;
}>): OpenCodeRuntimeContext {
  const managedServerPort = Number(new URL(params.managedServerBaseUrl).port || 80);
  const abortController = new AbortController();
  const sessionStorage = new Map<string, unknown>();
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (
      new URL(String(url)).pathname === '/session'
      && init?.method === 'POST'
    ) {
      return new Response(JSON.stringify({ id: 'oc-session-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
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
    managedServer: {
      supervise: vi.fn(async (spec) => ({
        snapshot: () => ({
          id: 'opencode-server',
          instanceId: 'opencode-instance-1',
          state: 'healthy',
          mode: spec.mode.kind,
          baseUrl: params.managedServerBaseUrl,
          port: managedServerPort,
          credentialEnvKey: 'OPENCODE_SERVER_PASSWORD',
          pid: 123,
          startedAt: 100,
          lastHealthyAt: 101,
          lastErrorMessage: null,
          diagnostics: {},
        }),
        waitUntilHealthy: vi.fn(async () => {
          if (params.managedServerWaitError) {
            throw params.managedServerWaitError;
          }
          return {
            id: 'opencode-server',
            instanceId: 'opencode-instance-1',
            state: 'healthy',
            mode: spec.mode.kind,
            baseUrl: params.managedServerBaseUrl,
            port: managedServerPort,
            credentialEnvKey: 'OPENCODE_SERVER_PASSWORD',
            pid: 123,
            startedAt: 100,
            lastHealthyAt: 101,
            lastErrorMessage: null,
            diagnostics: {},
          };
        }),
        dispose: vi.fn(async () => {
          params.onManagedServerDispose?.();
        }),
      })),
    },
    ui: {
      askQuestions: vi.fn(async () => ({ status: 'cancelled' as const })),
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
      session: {
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

function createParams(
  overrides: Partial<OpenCodeSessionCatalogControlAdapterParams>,
): OpenCodeSessionCatalogControlAdapterParams {
  return {
    metadata: {},
    cwd: '/repo',
    ...overrides,
  };
}

describe('openCodeServerCatalogControlAdapter', () => {
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
      const superviseSpec = vi.mocked(ctx.managedServer.supervise).mock.calls[0]?.[0];
      expect(superviseSpec?.mode).not.toHaveProperty('baseUrlEnvKey');
      expect(superviseSpec?.launch.env).toEqual({
        HAPPIER_OPENCODE_PROVIDER_API_KEY: 'provider-secret',
        OPENCODE_AUTH_CONTENT: '{"openai":{"type":"api"}}',
        OPENCODE_CONFIG_CONTENT: '{}',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        XDG_CONFIG_HOME: '/private/opencode-connected-config',
        [OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/private/opencode-request-auth/capability.json',
        OPENCODE_PERMISSION: expect.any(String),
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

      const superviseSpec = vi.mocked(ctx.managedServer.supervise).mock.calls[0]?.[0];
      expect(superviseSpec?.launch.env).toMatchObject({
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
      expect(ctx.managedServer.supervise).not.toHaveBeenCalled();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'direct Connected Services authentication',
      env: {
        OPENCODE_AUTH_CONTENT: '{"anthropic":{"type":"api","key":"connected-key"}}',
        XDG_CONFIG_HOME: '/private/opencode-connected-direct',
        [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'selection:direct',
      },
    },
    {
      label: 'Connected Services request-auth',
      env: {
        OPENCODE_AUTH_CONTENT: '{"openai":{"type":"api","key":"happier-request-auth:openai:1"}}',
        XDG_CONFIG_HOME: '/private/opencode-connected-request-auth',
        [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'selection:request-auth',
        [OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/private/opencode-request-auth/capability.json',
      },
    },
  ])('fails closed when $label cannot be applied to an external server', async ({ env }) => {
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49201',
    });

    await expect(createOpenCodeServerRuntimeAssembly({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-connected-external',
      endpoint: {
        mode: 'external-attach',
        baseUrl: 'http://127.0.0.1:49201',
      },
      env,
      request: {
        kind: 'create',
        sessionId: 'happy-session-connected-external',
        cwd: '/repo',
      },
    })).rejects.toThrow('OpenCode isolated authentication requires a managed server');
    expect(ctx.managedServer.supervise).not.toHaveBeenCalled();
  });

  it('reuses the managed-server Basic credential when listing inactive-session skills', async () => {
    const managedServerBaseUrl = 'http://127.0.0.1:49197';
    const ctx = createContextFixture({ managedServerBaseUrl });
    const skillFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (
        requestUrl === `${managedServerBaseUrl}/session?directory=%2Frepo`
        && init?.method === 'POST'
      ) {
        return new Response(JSON.stringify({ id: 'oc-session-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl === `${managedServerBaseUrl}/skill?directory=%2Frepo`) {
        return new Response(JSON.stringify([
          {
            name: 'reviewer',
            description: 'Review code',
            location: '/repo/.agents/skills/reviewer/SKILL.md',
          },
        ]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 404, statusText: 'Not Found' });
    });
    vi.stubGlobal('fetch', skillFetch);

    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-1',
      endpoint: { mode: 'managed-spawn' },
      request: {
        kind: 'create',
        sessionId: 'happy-session-1',
        cwd: '/repo',
      },
    });

    const runtimeSessionRequest = skillFetch.mock.calls
      .find(([url]) => String(url) === `${managedServerBaseUrl}/session?directory=%2Frepo`);
    const runtimeAuthorization = new Headers(runtimeSessionRequest?.[1]?.headers).get('authorization');
    expect(runtimeAuthorization).toMatch(/^Basic /);

    try {
      const adapter = createOpenCodeServerCatalogControlAdapter();
      await expect(adapter.listSkills?.(createParams({
        cwd: '/repo',
        metadata: {
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'opencode',
            provider: {
              backendMode: 'server',
              serverBaseUrl: `${managedServerBaseUrl}/`,
              serverBaseUrlExplicit: true,
              providerSessionId: 'oc-session-1',
            },
          },
        },
      }))).resolves.toEqual({
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

      const skillRequest = skillFetch.mock.calls
        .find(([url]) => String(url) === `${managedServerBaseUrl}/skill?directory=%2Frepo`);
      expect(skillRequest?.[1]?.method).toBe('GET');
      expect(new Headers(skillRequest?.[1]?.headers).get('authorization')).toBe(runtimeAuthorization);
    } finally {
      await assembly.dispose();
    }
  });

  it('supervises an external loopback server through SVC09 without requiring the host fetch service', async () => {
    const externalBaseUrl = 'http://127.0.0.1:49202';
    const onManagedServerDispose = vi.fn();
    const ctx = createContextFixture({
      managedServerBaseUrl: externalBaseUrl,
      onManagedServerDispose,
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (
        requestUrl === `${externalBaseUrl}/session?directory=%2Frepo`
        && init?.method === 'POST'
      ) {
        return new Response(JSON.stringify({ id: 'oc-session-external' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl === `${externalBaseUrl}/skill?directory=%2Frepo`) {
        return new Response(JSON.stringify([{
          name: 'external-reviewer',
          description: 'Review from an attached server',
        }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 404, statusText: 'Not Found' });
    }));

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

    expect(ctx.managedServer.supervise).toHaveBeenCalledWith(expect.objectContaining({
      id: 'opencode-server',
      mode: {
        kind: 'external-attach',
        baseUrl: externalBaseUrl,
      },
      healthCheck: {
        kind: 'http',
        path: '/global/health',
        timeoutMs: 5_000,
      },
    }));
    const adapter = createOpenCodeServerCatalogControlAdapter();
    const externalCatalogParams = createParams({
      cwd: '/repo',
      metadata: {
        agentRuntimeDescriptorV1: {
          v: 1,
          agentId: 'opencode',
          provider: {
            backendMode: 'server',
            serverBaseUrl: externalBaseUrl,
            serverBaseUrlExplicit: true,
            providerSessionId: 'oc-session-external',
          },
        },
      },
    });
    await expect(adapter.listSkills?.(externalCatalogParams)).resolves.toEqual({
      supported: true,
      skills: [{
        name: 'external-reviewer',
        displayName: 'external-reviewer',
        description: 'Review from an attached server',
        origin: 'opencode_native',
        enabled: true,
      }],
    });
    const externalSkillRequest = vi.mocked(globalThis.fetch).mock.calls
      .find(([url]) => String(url) === `${externalBaseUrl}/skill?directory=%2Frepo`);
    expect(new Headers(externalSkillRequest?.[1]?.headers).has('authorization')).toBe(false);

    await assembly.dispose();
    expect(onManagedServerDispose).toHaveBeenCalledOnce();
    await expect(adapter.listSkills?.(externalCatalogParams)).resolves.toEqual({
      unsupported: true,
      skills: [],
      diagnostic: 'session_catalog_control_unavailable',
    });
  });

  it('routes inactive OpenCode skill listing through the stored server runtime handle', async () => {
    const client = {
      appSkills: vi.fn(async () => [
        {
          name: 'reviewer',
          description: 'Review code',
          location: '/repo/.agents/skills/reviewer/SKILL.md',
          content: 'private prompt text',
        },
      ]),
      dispose: vi.fn(async () => {}),
    };
    const createClient = vi.fn(async () => client);
    const adapter = createOpenCodeServerCatalogControlAdapter({ createClient });

    await expect(adapter.listSkills?.(createParams({
      cwd: '/repo',
      metadata: {
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'opencode',
            provider: {
            backendMode: 'server',
            serverBaseUrl: 'http://127.0.0.1:49196/',
            serverBaseUrlExplicit: true,
            providerSessionId: 'oc_1',
          },
        },
      },
    }))).resolves.toEqual({
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

    expect(createClient).toHaveBeenCalledWith({
      directory: '/repo',
      baseUrlOverride: 'http://127.0.0.1:49196/',
    });
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not start a shared managed OpenCode server for passive skill listing when no server URL is stored', async () => {
    const createClient = vi.fn(async () => ({
      appSkills: vi.fn(async () => []),
      dispose: vi.fn(async () => {}),
    }));
    const adapter = createOpenCodeServerCatalogControlAdapter({ createClient });

    await expect(adapter.listSkills?.(createParams({
      cwd: '/repo',
      metadata: {
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'opencode',
            provider: {
            backendMode: 'server',
            providerSessionId: 'oc_1',
          },
        },
      },
    }))).resolves.toEqual({
      unsupported: true,
      skills: [],
      diagnostic: 'session_catalog_control_unavailable',
    });

    expect(createClient).not.toHaveBeenCalled();
  });

  it('reports a missing active managed endpoint as unavailable for passive skill listing', async () => {
    const adapter = createOpenCodeServerCatalogControlAdapter();

    await expect(adapter.listSkills?.(createParams({
      cwd: '/repo',
      metadata: {
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'opencode',
            provider: {
            backendMode: 'server',
            serverBaseUrl: 'http://127.0.0.1:49196/',
            serverBaseUrlExplicit: true,
            providerSessionId: 'oc_1',
          },
        },
      },
    }))).resolves.toEqual({
      unsupported: true,
      skills: [],
      diagnostic: 'session_catalog_control_unavailable',
    });
  });

  it('does not downgrade managed-server 401 skill catalog failures to generic unavailable', async () => {
    const client = {
      appSkills: vi.fn(async () => {
        throw Object.assign(new Error('OpenCode skill catalog request failed: 401 Unauthorized'), {
          code: 'opencode_server_auth_failed',
          status: 401,
        });
      }),
      dispose: vi.fn(async () => {}),
    };
    const createClient = vi.fn(async () => client);
    const adapter = createOpenCodeServerCatalogControlAdapter({ createClient });

    await expect(adapter.listSkills?.(createParams({
      cwd: '/repo',
      metadata: {
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'opencode',
            provider: {
            backendMode: 'server',
            serverBaseUrl: 'http://127.0.0.1:49196/',
            serverBaseUrlExplicit: true,
            providerSessionId: 'oc_1',
          },
        },
      },
    }))).resolves.toEqual({
      unsupported: true,
      skills: [],
      diagnostic: 'session_catalog_control_auth_failed',
    });

    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it('reports vendor plugins unsupported for OpenCode server sessions', async () => {
    const adapter = createOpenCodeServerCatalogControlAdapter();

    await expect(adapter.listVendorPlugins?.(createParams({ cwd: '/repo' }))).resolves.toEqual({
      unsupported: true,
      vendorPlugins: [],
      diagnostic: 'session_catalog_control_unsupported',
    });
  });
});
