import { describe, expect, it, vi } from 'vitest';
import type {
  ManagedServiceHandle,
  ManagedServiceResponse,
  ManagedServiceSnapshot,
  ManagedServiceSpec,
} from '@happier-dev/plugin-sdk/managed-services';

import { createOpenCodeServerRuntimeAssembly } from './assembly.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';

const healthySnapshot: ManagedServiceSnapshot = {
  id: 'opencode-server',
  state: 'healthy',
  mode: 'spawn',
  baseUrl: 'http://127.0.0.1:49196',
  startedAtMs: 1,
  lastHealthyAtMs: 2,
  diagnostics: [],
  diagnosticsTruncated: false,
};

function createContext() {
  const dispose = vi.fn(async () => undefined);
  const observe = vi.fn((listener: (snapshot: ManagedServiceSnapshot) => void) => {
    listener(healthySnapshot);
    return { dispose: vi.fn() };
  });
  const request = vi.fn(async (input: Readonly<{ pathAndQuery: string; method?: string }>) => {
    const responseBody = input.pathAndQuery === '/session?directory=%2Frepo'
      ? JSON.stringify({ id: 'oc-session-public-handle' })
      : '{}';
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: new Response(responseBody).body,
    } satisfies ManagedServiceResponse;
  });
  const handle = {
    snapshot: () => healthySnapshot,
    observe,
    waitUntilHealthy: vi.fn(async () => healthySnapshot),
    stop: vi.fn(async () => ({ status: 'stopped' as const })),
    dispose,
    request,
  } satisfies ManagedServiceHandle;
  const supervise = vi.fn(async (_spec: ManagedServiceSpec) => handle);
  const abort = new AbortController();
  const sessionStorage = new Map<string, unknown>();
  const context = {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    abort: {
      signal: abort.signal,
      compose: (signals: readonly AbortSignal[]) => AbortSignal.any(signals),
    },
    config: { values: {} },
    env: { list: () => ({}) },
    managedServices: {
      dependencies: {},
      supervise,
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
    experimental: { telemetry: { emit: vi.fn() } },
  } as unknown as OpenCodeRuntimeContext;
  return { context, handle, request, observe, supervise, dispose };
}

describe('OpenCode public ManagedServiceHandle migration', () => {
  it('supervises one public spec, consumes its immediate snapshot, and disposes the exact handle once', async () => {
    const fixture = createContext();
    const globalFetch = vi.fn(async () => {
      throw new Error('OpenCode bypassed its exact managed-service handle');
    });
    vi.stubGlobal('fetch', globalFetch);

    try {
      const assembly = await createOpenCodeServerRuntimeAssembly({
        ctx: fixture.context,
        directory: '/repo',
        happierSessionId: 'session-public-handle',
        endpoint: { mode: 'managed-spawn' },
        request: {
          kind: 'create',
          sessionId: 'session-public-handle',
          cwd: '/repo',
        },
      });

      expect(fixture.supervise).toHaveBeenCalledTimes(1);
      expect(fixture.supervise.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        id: 'opencode-server',
        mode: expect.objectContaining({
          kind: 'spawn',
          launch: expect.objectContaining({
            executable: { kind: 'systemTool', id: 'opencode-cli' },
          }),
          endpoint: expect.objectContaining({ kind: 'assignAndInject' }),
        }),
        healthCheck: expect.objectContaining({
          kind: 'http',
          target: { kind: 'servicePath', path: '/global/health' },
        }),
        clientAccess: {
          kind: 'hostBasic',
          username: 'opencode',
          injectPasswordEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
        },
      }));
      const spec = fixture.supervise.mock.calls[0]?.[0];
      expect(spec?.healthCheck).not.toHaveProperty('headers');
      expect(spec?.mode.kind === 'spawn' ? spec.mode.launch.env : null)
        .not.toHaveProperty('OPENCODE_SERVER_PASSWORD');
      expect(fixture.observe).toHaveBeenCalledTimes(1);
      expect(fixture.request).toHaveBeenCalledWith(expect.objectContaining({
        pathAndQuery: '/session?directory=%2Frepo',
        method: 'POST',
        body: expect.any(Uint8Array),
        signal: expect.any(AbortSignal),
      }));
      expect(globalFetch).not.toHaveBeenCalled();

      await assembly.dispose();
      await assembly.dispose();
      expect(fixture.dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('declares the user-secret credential for strict external attach and detaches through the handle', async () => {
    const fixture = createContext();
    const globalFetch = vi.fn(async () => {
      throw new Error('external attach bypassed its exact managed-service handle');
    });
    vi.stubGlobal('fetch', globalFetch);

    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx: fixture.context,
      directory: '/repo',
      happierSessionId: 'session-public-attach',
      endpoint: {
        mode: 'external-attach',
        baseUrl: 'http://127.0.0.1:49196',
        credential: null,
      },
      request: {
        kind: 'create',
        sessionId: 'session-public-attach',
        cwd: '/repo',
      },
    });

    expect(fixture.supervise.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      mode: {
        kind: 'attach',
        baseUrl: 'http://127.0.0.1:49196',
      },
      clientAccess: {
        kind: 'declaredSecretBasic',
        username: 'opencode',
        passwordSecretId: 'opencodeServerPassword',
      },
    }));
    expect(fixture.request).toHaveBeenCalledWith(expect.objectContaining({
      pathAndQuery: '/session?directory=%2Frepo',
    }));
    expect(globalFetch).not.toHaveBeenCalled();

    await assembly.dispose();
    expect(fixture.dispose).toHaveBeenCalledTimes(1);
  });
});
