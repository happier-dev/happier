import { describe, expect, it, vi } from 'vitest';

import { DirectSessionsCandidatesListResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { DirectSessionProviderOps } from '@/session/directSessions/providerOps';
import type { BackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';

const { resolveBackendExecutionSurfacesMock, resolveExecutionSurfacesMock } = vi.hoisted(() => {
  const resolveBackendExecutionSurfacesMock = vi.fn();
  const resolveExecutionSurfacesMock = vi.fn();
  return { resolveBackendExecutionSurfacesMock, resolveExecutionSurfacesMock };
});

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendExecutionSurfaces: resolveBackendExecutionSurfacesMock,
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    resolveExecutionSurfaces: resolveExecutionSurfacesMock,
  }),
}));

import { registerMachineDirectSessionsRpcHandlers } from './rpcHandlers.directSessions';

function createRpcHandlerManager(): { handlers: Map<string, (params: unknown) => Promise<unknown>>; registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => void } {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe('registerMachineDirectSessionsRpcHandlers execution-surface seam', () => {
  it.each(['claude', 'codex', 'opencode', 'ohMyPi'] as const)(
    'resolves direct-session candidates through the canonical execution-surface registry for %s',
    async (providerId) => {
    const directSessions = {
      validateSource: vi.fn(async ({ source }) => ({ ok: true as const, source })),
      listCandidates: vi.fn(async () => ({
        candidates: [],
        nextCursor: null,
      })),
      getActivity: vi.fn(async () => ({
        lastActivityAtMs: null,
        isRunning: false,
      })),
      pageTranscript: vi.fn(async () => ({
        items: [],
        nextCursor: null,
        tailCursor: null,
        hasMore: false,
        truncated: false,
      })),
      readAfterTranscript: vi.fn(async () => ({
        items: [],
        nextCursor: null,
        truncated: false,
      })),
      resolveTakeoverSpawnOptions: vi.fn(async () => null),
    } satisfies DirectSessionProviderOps;

    resolveBackendExecutionSurfacesMock.mockResolvedValue({
      terminalRuntime: null,
      directSessions,
      attach: null,
      sessionHandoff: null,
    } satisfies BackendExecutionSurfaces);
    resolveExecutionSurfacesMock.mockResolvedValue({
      directSessions,
      terminalRuntime: null,
      attach: null,
      sessionHandoff: null,
    });

    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager: rpcHandlerManager as never });

    const handler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST);
    expect(handler).toBeDefined();

    await expect(handler!({
      machineId: 'machine-1',
      providerId,
      source: {
        kind: 'codexHome',
        home: 'user',
      },
      limit: 10,
    })).resolves.toMatchObject({
      ok: true,
      candidates: [],
      nextCursor: null,
    });

    expect(resolveBackendExecutionSurfacesMock).toHaveBeenCalledWith(providerId);
    expect(directSessions.validateSource).toHaveBeenCalledTimes(1);
    expect(directSessions.listCandidates).toHaveBeenCalledTimes(1);
    },
  );

  it('returns a protocol-shaped candidates error when execution-surface resolution fails', async () => {
    resolveBackendExecutionSurfacesMock.mockRejectedValueOnce(
      Object.assign(new Error('Cannot find providerOps chunk'), { code: 'ERR_MODULE_NOT_FOUND' }),
    );
    resolveExecutionSurfacesMock.mockResolvedValue({
      directSessions: {
        validateSource: vi.fn(async ({ source }) => ({ ok: true as const, source })),
      },
      terminalRuntime: null,
      attach: null,
      sessionHandoff: null,
    });

    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager: rpcHandlerManager as never });

    const handler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST);
    expect(handler).toBeDefined();

    const response = await handler!({
      machineId: 'machine-1',
      providerId: 'codex',
      source: {
        kind: 'codexHome',
        home: 'user',
      },
      limit: 10,
    });

    expect(response).toEqual({
      ok: false,
      errorCode: 'internal_error',
      error: 'direct_sessions_candidates_list_failed',
    });
    expect(DirectSessionsCandidatesListResponseSchema.safeParse(response).success).toBe(true);
  });

  it('returns a protocol-shaped candidates error when the backend exposes no direct-session surfaces', async () => {
    resolveBackendExecutionSurfacesMock.mockResolvedValue({
      terminalRuntime: null,
      directSessions: null,
      attach: null,
      sessionHandoff: null,
    } satisfies BackendExecutionSurfaces);
    resolveExecutionSurfacesMock.mockResolvedValue({
      directSessions: {
        validateSource: vi.fn(async ({ source }) => ({ ok: true as const, source })),
      },
      terminalRuntime: null,
      attach: null,
      sessionHandoff: null,
    });

    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager: rpcHandlerManager as never });

    const handler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST);
    expect(handler).toBeDefined();

    const response = await handler!({
      machineId: 'machine-1',
      providerId: 'codex',
      source: {
        kind: 'codexHome',
        home: 'user',
      },
      limit: 10,
    });

    expect(response).toEqual({
      ok: false,
      errorCode: 'internal_error',
      error: 'direct_sessions_candidates_list_failed',
    });
    expect(DirectSessionsCandidatesListResponseSchema.safeParse(response).success).toBe(true);
  });

  it('routes legacy direct-session RPCs through external-session actions before domain execution', async () => {
    const calls: Array<Readonly<{ actionId: string; input: unknown }>> = [];
    const actionExecutor: RpcActionExecutor = {
      execute: async (actionId, input) => {
        calls.push({ actionId, input });
        return {
          ok: true,
          result: actionId === 'sessions.external.takeover'
            ? {
                ok: true,
                sessionId: (input as { linkedSessionId?: string }).linkedSessionId ?? 'linked-session',
                targetRuntimeMode: 'terminal',
                storageMode: (input as { storageMode?: string }).storageMode ?? 'external-linked',
                converted: (input as { storageMode?: string }).storageMode === 'persisted',
              }
            : { ok: true, candidates: [], nextCursor: null },
        };
      },
    };

    const rpcHandlerManager = createRpcHandlerManager();
    const params: Parameters<typeof registerMachineDirectSessionsRpcHandlers>[0] & {
      actionExecutor: RpcActionExecutor;
    } = {
      rpcHandlerManager: rpcHandlerManager as never,
      actionExecutor,
    };
    registerMachineDirectSessionsRpcHandlers(params);

    const candidatesHandler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST);
    expect(candidatesHandler).toBeDefined();
    await expect(candidatesHandler!({
      machineId: 'machine-1',
      providerId: 'codex',
      source: { kind: 'codexHome', home: 'user' },
      limit: 10,
    })).resolves.toEqual({ ok: true, candidates: [], nextCursor: null });

    const takeoverHandler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER);
    const takeoverPersistHandler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST);
    expect(takeoverHandler).toBeDefined();
    expect(takeoverPersistHandler).toBeDefined();

    await expect(takeoverHandler!({
      machineId: 'machine-1',
      sessionId: 'linked-session-1',
      forceStop: true,
    })).resolves.toEqual({ ok: true });
    await expect(takeoverPersistHandler!({
      machineId: 'machine-1',
      sessionId: 'linked-session-2',
    })).resolves.toEqual({ ok: true, converted: true });

    expect(calls).toEqual([
      {
        actionId: 'sessions.external.candidates.list',
        input: {
          machineId: 'machine-1',
          providerId: 'codex',
          source: { kind: 'codexHome', home: 'user' },
          limit: 10,
        },
      },
      {
        actionId: 'sessions.external.takeover',
        input: {
          linkedSessionId: 'linked-session-1',
          targetRuntimeMode: 'terminal',
          storageMode: 'external-linked',
          forceStop: true,
          machineId: 'machine-1',
        },
      },
      {
        actionId: 'sessions.external.takeover',
        input: {
          linkedSessionId: 'linked-session-2',
          targetRuntimeMode: 'terminal',
          storageMode: 'persisted',
          machineId: 'machine-1',
        },
      },
    ]);
  });

  it('maps unsupported external-session takeover actions to legacy provider unavailable errors', async () => {
    const actionExecutor: RpcActionExecutor = {
      execute: async () => ({
        ok: true,
        result: {
          ok: false,
          errorCode: 'capability_unsupported',
          error: 'takeover_not_supported',
        },
      }),
    };

    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineDirectSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      actionExecutor,
    } as Parameters<typeof registerMachineDirectSessionsRpcHandlers>[0] & {
      actionExecutor: RpcActionExecutor;
    });

    const takeoverHandler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER);
    expect(takeoverHandler).toBeDefined();

    await expect(takeoverHandler!({
      machineId: 'machine-1',
      sessionId: 'linked-session-1',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'provider_unavailable',
      error: 'takeover_not_supported',
    });
  });
});
