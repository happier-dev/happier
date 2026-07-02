import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireCatalogEntryMock = vi.fn();
const loadBuiltInRuntimeOwnersMock = vi.fn();

vi.mock('@/backends/catalog', () => ({
  requireCatalogEntry: requireCatalogEntryMock,
}));

vi.mock('./catalog/builtIn/runtimeOwners', () => ({
  loadBuiltInRuntimeOwners: loadBuiltInRuntimeOwnersMock,
}));

vi.mock('@happier-dev/agents', () => {
  return {
    hasBuiltInAcpConfig: (agentId: string) => agentId === 'kiro',
    isAgentId: (agentId: unknown): agentId is string => typeof agentId === 'string',
  };
});

describe('createCatalogAcpBackend', () => {
  beforeEach(() => {
    vi.resetModules();
    requireCatalogEntryMock.mockReset();
    loadBuiltInRuntimeOwnersMock.mockReset();
  });

  it('resolves built-in generic ACP agents through the ACP runtime owner when the catalog entry has no ACP factory hook', async () => {
    const createRuntime = vi.fn(() => ({ kind: 'kiro-backend' }));
    requireCatalogEntryMock.mockReturnValue({
      id: 'kiro',
    });
    loadBuiltInRuntimeOwnersMock.mockResolvedValue({
      createRuntime,
    });

    const { createCatalogAcpBackend } = await import('./createCatalogAcpBackend');

    await expect(createCatalogAcpBackend('kiro', { cwd: '/tmp/workspace' })).resolves.toEqual({
      backend: { kind: 'kiro-backend' },
    });
    expect(loadBuiltInRuntimeOwnersMock).toHaveBeenCalledWith('kiro');
    expect(createRuntime).toHaveBeenCalledWith({ cwd: '/tmp/workspace' });
  });

  it('creates catalog ACP backends through projected runtime definition bridges before legacy factory hooks', async () => {
    const resolveSystemTool = vi.fn(async () => ({
      grantId: 'system-tool:codex-acp',
      toolId: 'codex-acp',
      displayName: 'Codex ACP',
      source: 'system' as const,
      executablePath: '/tools/codex-acp',
      launch: {
        kind: 'binary' as const,
        executablePath: '/tools/codex-acp',
        args: ['--from-grant'],
        env: { PATH: '' },
      },
    }));
    const legacyFactory = vi.fn(() => ({
      backend: {
        dispose: vi.fn(async () => undefined),
        legacy: true,
      },
    }));
    requireCatalogEntryMock.mockReturnValue({
      id: 'codex',
      getAcpRuntimeDefinitionBridge: async () => ({
        exec: {
          systemTools: {
            resolve: resolveSystemTool,
          },
        },
        createDefinition: () => ({
          backendId: 'codex',
          source: { kind: 'plugin_contributed' },
          identity: { backendId: 'codex' },
          engine: { kind: 'acp' },
          ux: { title: 'Codex' },
          transport: {
            kind: 'stdio',
            launch: {
              kind: 'system-tool',
              toolId: 'codex-acp',
              purpose: 'Run Codex ACP',
              preferredCommand: 'codex-acp',
            },
          },
          launchEnv: {},
          capabilities: {},
          mcp: { policy: 'pass_through' },
          callbacks: {},
        }),
      }),
      getAcpBackendFactory: async () => legacyFactory,
    });

    const { createCatalogAcpBackend } = await import('./createCatalogAcpBackend');
    const result = await createCatalogAcpBackend('codex', { cwd: '/tmp/workspace' });

    expect(result.backend).toEqual(expect.objectContaining({
      dispose: expect.any(Function),
    }));
    expect(resolveSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'codex-acp',
      cwd: '/tmp/workspace',
    }));
    expect(legacyFactory).not.toHaveBeenCalled();
  });

  it('retries catalog ACP factory loading after a transient bridge failure', async () => {
    const bridgeLoad = vi.fn()
      .mockRejectedValueOnce(new Error('temporary bridge failure'))
      .mockResolvedValueOnce({
        exec: {
          systemTools: {
            resolve: vi.fn(async () => ({
              grantId: 'system-tool:codex-acp',
              toolId: 'codex-acp',
              displayName: 'Codex ACP',
              source: 'system' as const,
              executablePath: '/tools/codex-acp',
              launch: {
                kind: 'binary' as const,
                executablePath: '/tools/codex-acp',
                args: [],
                env: {},
              },
            })),
          },
        },
        createDefinition: () => ({
          backendId: 'codex',
          source: { kind: 'plugin_contributed' },
          identity: { backendId: 'codex' },
          engine: { kind: 'acp' },
          transport: {
            kind: 'stdio',
            launch: {
              kind: 'system-tool',
              toolId: 'codex-acp',
              purpose: 'Run Codex ACP',
              preferredCommand: 'codex-acp',
            },
          },
          launchEnv: {},
          capabilities: {},
          mcp: { policy: 'pass_through' },
          callbacks: {},
        }),
      });
    requireCatalogEntryMock.mockReturnValue({
      id: 'codex',
      getAcpRuntimeDefinitionBridge: bridgeLoad,
    });

    const { createCatalogAcpBackend } = await import('./createCatalogAcpBackend');

    await expect(createCatalogAcpBackend('codex', { cwd: '/tmp/workspace' }))
      .rejects.toThrow('temporary bridge failure');
    await expect(createCatalogAcpBackend('codex', { cwd: '/tmp/workspace' }))
      .resolves.toEqual({
        backend: expect.objectContaining({
          dispose: expect.any(Function),
        }),
      });
    expect(bridgeLoad).toHaveBeenCalledTimes(2);
  });

  it('exposes typed load and fork session operations over catalog ACP backends', async () => {
    const dispose = vi.fn(async () => undefined);
    const loadSession = vi.fn(async (sessionId: string) => ({ sessionId }));
    const forkSession = vi.fn(async () => ({ sessionId: 'child-session' }));
    requireCatalogEntryMock.mockReturnValue({
      id: 'codex',
      getAcpBackendFactory: async () => () => ({
        backend: {
          loadSession,
          forkSession,
          dispose,
        },
      }),
    });

    const module = await import('./createCatalogAcpBackend');
    const createAcpSessionOperations = (module as Readonly<{
      createAcpSessionOperations?: unknown;
    }>).createAcpSessionOperations;

    expect(createAcpSessionOperations).toEqual(expect.any(Function));
    if (typeof createAcpSessionOperations !== 'function') return;

    const operations = createAcpSessionOperations();

    await expect(operations.loadSession({
      backendId: 'codex',
      directory: '/repo',
      providerSessionId: 'parent-session',
    })).resolves.toEqual({
      ok: true,
      value: { providerSessionId: 'parent-session' },
    });
    await expect(operations.forkSession({
      backendId: 'codex',
      directory: '/repo',
      sourceProviderSessionId: 'parent-session',
    })).resolves.toEqual({
      ok: true,
      value: { providerSessionId: 'child-session' },
    });

    expect(loadSession).toHaveBeenCalledWith('parent-session');
    expect(forkSession).toHaveBeenCalledWith({
      sessionId: 'parent-session',
      cwd: '/repo',
    });
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('returns typed unsupported when a catalog ACP backend has no fork operation', async () => {
    const dispose = vi.fn(async () => undefined);
    requireCatalogEntryMock.mockReturnValue({
      id: 'codex',
      getAcpBackendFactory: async () => () => ({
        backend: {
          loadSession: vi.fn(async (sessionId: string) => ({ sessionId })),
          dispose,
        },
      }),
    });

    const { createAcpSessionOperations } = await import('./createCatalogAcpBackend');
    await expect(createAcpSessionOperations().forkSession({
      backendId: 'codex',
      directory: '/repo',
      sourceProviderSessionId: 'parent-session',
    })).resolves.toEqual({
      ok: false,
      code: 'unsupported',
      retryable: false,
      message: 'ACP backend does not support session load/fork',
    });

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('returns typed unsupported when a catalog backend has no ACP factory', async () => {
    requireCatalogEntryMock.mockReturnValue({
      id: 'no-acp',
    });

    const { createAcpSessionOperations } = await import('./createCatalogAcpBackend');
    await expect(createAcpSessionOperations().loadSession({
      backendId: 'no-acp',
      directory: '/repo',
      providerSessionId: 'parent-session',
    })).resolves.toEqual({
      ok: false,
      code: 'unsupported',
      retryable: false,
      message: "Agent 'no-acp' does not support ACP backends",
    });
  });

  it('returns typed cancelled and disposes when ACP load aborts during operation', async () => {
    const dispose = vi.fn(async () => undefined);
    const abortError = new Error('operation aborted');
    abortError.name = 'AbortError';
    requireCatalogEntryMock.mockReturnValue({
      id: 'codex',
      getAcpBackendFactory: async () => () => ({
        backend: {
          loadSession: vi.fn(async () => {
            throw abortError;
          }),
          dispose,
        },
      }),
    });

    const { createAcpSessionOperations } = await import('./createCatalogAcpBackend');
    await expect(createAcpSessionOperations().loadSession({
      backendId: 'codex',
      directory: '/repo',
      providerSessionId: 'parent-session',
    })).resolves.toEqual({
      ok: false,
      code: 'cancelled',
      retryable: false,
      message: 'operation aborted',
    });

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('returns typed cancelled and disposes when the caller signal aborts an in-flight ACP load', async () => {
    let disposeResolved = false;
    const disposeSettlement: { resolve?: () => void } = {};
    const dispose = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        disposeSettlement.resolve = resolve;
      });
      disposeResolved = true;
    });
    const loadSettlement: { resolve?: (value: { sessionId: string }) => void } = {};
    const loadSession = vi.fn(async () => await new Promise<{ sessionId: string }>((resolve) => {
      loadSettlement.resolve = resolve;
    }));
    requireCatalogEntryMock.mockReturnValue({
      id: 'codex',
      getAcpBackendFactory: async () => () => ({
        backend: {
          loadSession,
          dispose,
        },
      }),
    });

    const { createAcpSessionOperations } = await import('./createCatalogAcpBackend');
    const abortController = new AbortController();
    const result = Promise.resolve(createAcpSessionOperations().loadSession({
      backendId: 'codex',
      directory: '/repo',
      providerSessionId: 'parent-session',
      signal: abortController.signal,
    }));
    await vi.waitFor(() => {
      expect(loadSession).toHaveBeenCalledWith('parent-session');
    });

    abortController.abort();
    await expect(Promise.race([
      result,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: 'timeout' }), 100)),
    ])).resolves.toEqual({
      ok: false,
      code: 'timeout',
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(disposeResolved).toBe(false);

    disposeSettlement.resolve?.();
    await expect(Promise.race([
      result,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: 'timeout' }), 100)),
    ])).resolves.toMatchObject({
      ok: false,
      code: 'cancelled',
      retryable: false,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(disposeResolved).toBe(true);

    loadSettlement.resolve?.({ sessionId: 'late-session' });
    await result.catch(() => undefined);
  });

  it('keeps cancellation authoritative when an ACP operation rejects after abort but before disposal finishes', async () => {
    let disposeResolved = false;
    const disposeSettlement: { resolve?: () => void } = {};
    const dispose = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        disposeSettlement.resolve = resolve;
      });
      disposeResolved = true;
    });
    const loadSettlement: { reject?: (error: Error) => void } = {};
    const loadSession = vi.fn(async () => await new Promise<{ sessionId: string }>((_resolve, reject) => {
      loadSettlement.reject = reject;
    }));
    requireCatalogEntryMock.mockReturnValue({
      id: 'codex',
      getAcpBackendFactory: async () => () => ({
        backend: {
          loadSession,
          dispose,
        },
      }),
    });

    const { createAcpSessionOperations } = await import('./createCatalogAcpBackend');
    const abortController = new AbortController();
    const result = Promise.resolve(createAcpSessionOperations().loadSession({
      backendId: 'codex',
      directory: '/repo',
      providerSessionId: 'parent-session',
      signal: abortController.signal,
    }));
    await vi.waitFor(() => {
      expect(loadSession).toHaveBeenCalledWith('parent-session');
    });

    abortController.abort();
    loadSettlement.reject?.(new Error('late provider failure'));

    await expect(Promise.race([
      result,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: 'timeout' }), 100)),
    ])).resolves.toEqual({
      ok: false,
      code: 'timeout',
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(disposeResolved).toBe(false);

    disposeSettlement.resolve?.();
    await expect(result).resolves.toMatchObject({
      ok: false,
      code: 'cancelled',
      retryable: false,
    });
    expect(disposeResolved).toBe(true);
  });
});
