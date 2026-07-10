import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  FetchRuntimeResponseV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';
import { createPluginContextV1Fixture } from '@happier-dev/plugin-sdk/experimental/testing/adapterHarness';

import {
  createOpenCodeServerCatalogControlAdapter,
  type OpenCodeSessionCatalogControlAdapterParams,
} from './control.js';
import { createOpenCodeServerRuntimeAssembly } from '../assembly.js';

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

function isSessionCreateRequest(request: Readonly<{ url: string; method?: string }>): boolean {
  return request.method === 'POST' && new URL(request.url).pathname === '/session';
}

function createContextFixture(params: Readonly<{
  managedServerBaseUrl: string;
}>): PluginContextV1 {
  const managedServerPort = Number(new URL(params.managedServerBaseUrl).port || 80);
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
          baseUrl: params.managedServerBaseUrl,
          port: managedServerPort,
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
          baseUrl: params.managedServerBaseUrl,
          port: managedServerPort,
          credentialEnvKey: 'OPENCODE_SERVER_PASSWORD',
          pid: 123,
          startedAt: 100,
          lastHealthyAt: 101,
          lastErrorMessage: null,
          diagnostics: {},
        })),
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
  it('reuses the managed-server Basic credential when listing inactive-session skills', async () => {
    const managedServerBaseUrl = 'http://127.0.0.1:49197';
    const ctx = createContextFixture({ managedServerBaseUrl });
    const skillFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
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
    });

    const runtimeSessionRequest = vi.mocked(ctx.fetch).mock.calls
      .map(([request]) => request)
      .find((request) => request.url === `${managedServerBaseUrl}/session?directory=%2Frepo`);
    const runtimeAuthorization = runtimeSessionRequest?.headers?.authorization;
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
      expect(skillRequest?.[1]).toEqual(expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: runtimeAuthorization,
        }),
      }));
    } finally {
      await assembly.dispose();
    }
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

  it('reports missing managed-server credentials as an auth diagnostic for passive skill listing', async () => {
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
      diagnostic: 'session_catalog_control_auth_failed',
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
