import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  ExternalSessionAttachResponseSchema,
  ExternalSessionFollowPolicySetResponseSchema,
  ExternalSessionLinkEnsureResponseSchema,
  ExternalSessionStatusGetResponseSchema,
  ExternalSessionTakeoverPersistResponseSchema,
  ExternalSessionTakeoverResponseSchema,
  ExternalSessionsCandidatesListResponseSchema,
  ExternalSessionTranscriptPageResponseSchema,
  ExternalSessionTranscriptReadAfterResponseSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ExternalSessionProviderOps } from '@/session/external/providerOps';
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

import { registerMachineExternalSessionsRpcHandlers } from './rpcHandlers.externalSessions';

function createRpcHandlerManager(): { handlers: Map<string, (params: unknown) => Promise<unknown>>; registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => void } {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe('registerMachineExternalSessionsRpcHandlers execution-surface seam', () => {
  it('registers required external-session action rows through the generic ActionSpec RPC registrar', async () => {
    const source = await readFile(new URL('./rpcHandlers.externalSessions.ts', import.meta.url), 'utf8');

    expect(source).toContain('registerActionSpecRpcHandlers({');
    expect(source).not.toContain('registerExternalSessionActionBackedRpcHandler');
  });

  it.each(['claude', 'codex', 'opencode', 'ohMyPi'] as const)(
    'resolves direct-session candidates through the canonical execution-surface registry for %s',
    async (providerId) => {
    const externalSessions = {
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
    } satisfies ExternalSessionProviderOps;

    resolveBackendExecutionSurfacesMock.mockResolvedValue({
      terminalRuntime: null,
      externalSession: externalSessions,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    } satisfies BackendExecutionSurfaces);
    resolveExecutionSurfacesMock.mockResolvedValue({
      externalSession: externalSessions,
      terminalRuntime: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    });

    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpcHandlerManager as never });

    const handler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST);
    const legacyHandler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY);
    expect(handler).toBeDefined();
    expect(legacyHandler).toBe(handler);

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
    expect(externalSessions.validateSource).toHaveBeenCalledTimes(1);
    expect(externalSessions.listCandidates).toHaveBeenCalledTimes(1);
    },
  );

  it('returns a protocol-shaped candidates error when execution-surface resolution fails', async () => {
    resolveBackendExecutionSurfacesMock.mockRejectedValueOnce(
      Object.assign(new Error('Cannot find providerOps chunk'), { code: 'ERR_MODULE_NOT_FOUND' }),
    );
    resolveExecutionSurfacesMock.mockResolvedValue({
      externalSession: {
        validateSource: vi.fn(async ({ source }) => ({ ok: true as const, source })),
      },
      terminalRuntime: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    });

    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpcHandlerManager as never });

    const handler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST);
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
      error: 'external_sessions_candidates_list_failed',
    });
    expect(ExternalSessionsCandidatesListResponseSchema.safeParse(response).success).toBe(true);
  });

  it('returns a protocol-shaped link.ensure error when execution-surface validation throws', async () => {
    resolveExecutionSurfacesMock.mockRejectedValueOnce(
      Object.assign(new Error('Cannot find providerOps chunk'), { code: 'ERR_MODULE_NOT_FOUND' }),
    );

    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpcHandlerManager as never });

    const handler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE);
    expect(handler).toBeDefined();

    const response = await handler!({
      machineId: 'machine-1',
      providerId: 'codex',
      remoteSessionId: 'remote-session-1',
      source: {
        kind: 'codexHome',
        home: 'user',
      },
    });

    expect(response).toEqual({
      ok: false,
      errorCode: 'internal_error',
      error: 'external_session_link_ensure_failed',
    });
    expect(ExternalSessionLinkEnsureResponseSchema.safeParse(response).success).toBe(true);
  });

  it.each([
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH,
      {
        machineId: 'machine-1',
        sessionId: 'session-1',
        providerId: 'codex',
        remoteSessionId: 'remote-session-1',
        source: { kind: 'codexHome', home: 'user' },
        leaseId: 'lease-1',
      },
      'external_session_attach_failed',
      ExternalSessionAttachResponseSchema,
    ],
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_FOLLOW_POLICY_SET,
      {
        machineId: 'machine-1',
        sessionId: 'session-1',
        providerId: 'codex',
        remoteSessionId: 'remote-session-1',
        source: { kind: 'codexHome', home: 'user' },
        enabled: true,
      },
      'follow_policy_set_failed',
      ExternalSessionFollowPolicySetResponseSchema,
    ],
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET,
      {
        machineId: 'machine-1',
        sessionId: 'session-1',
        providerId: 'codex',
        remoteSessionId: 'remote-session-1',
        source: { kind: 'codexHome', home: 'user' },
      },
      'external_session_status_get_failed',
      ExternalSessionStatusGetResponseSchema,
    ],
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE,
      {
        machineId: 'machine-1',
        providerId: 'codex',
        remoteSessionId: 'remote-session-1',
        source: { kind: 'codexHome', home: 'user' },
        direction: 'older',
      },
      'external_session_transcript_page_failed',
      ExternalSessionTranscriptPageResponseSchema,
    ],
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
      {
        machineId: 'machine-1',
        providerId: 'codex',
        remoteSessionId: 'remote-session-1',
        source: { kind: 'codexHome', home: 'user' },
        cursor: 'cursor-1',
      },
      'external_session_transcript_read_after_failed',
      ExternalSessionTranscriptReadAfterResponseSchema,
    ],
  ] as const)(
    'returns a protocol-shaped %s error when source validation throws',
    async (method, input, expectedError, responseSchema) => {
      resolveExecutionSurfacesMock.mockRejectedValueOnce(
        Object.assign(new Error('Cannot find providerOps chunk'), { code: 'ERR_MODULE_NOT_FOUND' }),
      );

      const rpcHandlerManager = createRpcHandlerManager();
      registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpcHandlerManager as never });

      const handler = rpcHandlerManager.handlers.get(method);
      expect(handler).toBeDefined();

      const response = await handler!(input);

      expect(response).toEqual({
        ok: false,
        errorCode: 'internal_error',
        error: expectedError,
      });
      expect(responseSchema.safeParse(response).success).toBe(true);
    },
  );

  it('returns a protocol-shaped candidates error when the backend exposes no direct-session surfaces', async () => {
    resolveBackendExecutionSurfacesMock.mockResolvedValue({
      terminalRuntime: null,
      externalSession: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    } satisfies BackendExecutionSurfaces);
    resolveExecutionSurfacesMock.mockResolvedValue({
      externalSession: {
        validateSource: vi.fn(async ({ source }) => ({ ok: true as const, source })),
      },
      terminalRuntime: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    });

    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpcHandlerManager as never });

    const handler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST);
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
      error: 'external_sessions_candidates_list_failed',
    });
    expect(ExternalSessionsCandidatesListResponseSchema.safeParse(response).success).toBe(true);
  });

  it('routes canonical and legacy external-session RPCs through external-session actions before domain execution', async () => {
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
    const params: Parameters<typeof registerMachineExternalSessionsRpcHandlers>[0] & {
      actionExecutor: RpcActionExecutor;
    } = {
      rpcHandlerManager: rpcHandlerManager as never,
      actionExecutor,
    };
    registerMachineExternalSessionsRpcHandlers(params);

    const candidatesHandler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST);
    const legacyCandidatesHandler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY);
    expect(candidatesHandler).toBeDefined();
    expect(legacyCandidatesHandler).toBe(candidatesHandler);
    await expect(candidatesHandler!({
      machineId: 'machine-1',
      providerId: 'codex',
      source: { kind: 'codexHome', home: 'user' },
      limit: 10,
    })).resolves.toEqual({ ok: true, candidates: [], nextCursor: null });

    const takeoverHandler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY);
    const takeoverPersistHandler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY);
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

  it('maps generic external-session ActionExecuteResult failures to direct-session response envelopes', async () => {
    const actionExecutor: RpcActionExecutor = {
      execute: async () => ({
        ok: false,
        errorCode: 'unexpected_action_failure',
        error: 'unexpected_action_failure',
      }),
    };

    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      actionExecutor,
    } as Parameters<typeof registerMachineExternalSessionsRpcHandlers>[0] & {
      actionExecutor: RpcActionExecutor;
    });

    const handler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST);
    expect(handler).toBeDefined();

    const response = await handler!({
      machineId: 'machine-1',
      providerId: 'codex',
      source: { kind: 'codexHome', home: 'user' },
      limit: 10,
    });

    expect(response).toEqual({
      ok: false,
      errorCode: 'internal_error',
      error: 'unexpected_action_failure',
    });
    expect(ExternalSessionsCandidatesListResponseSchema.safeParse(response).success).toBe(true);
  });

  it.each([
    [
      RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY,
      ExternalSessionTakeoverResponseSchema,
    ],
    [
      RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY,
      ExternalSessionTakeoverPersistResponseSchema,
    ],
  ] as const)(
    'maps thrown %s action failures to legacy direct-session response envelopes',
    async (method, responseSchema) => {
      const actionExecutor: RpcActionExecutor = {
        execute: async () => {
          throw new Error('resolver exploded');
        },
      };

      const rpcHandlerManager = createRpcHandlerManager();
      registerMachineExternalSessionsRpcHandlers({
        rpcHandlerManager: rpcHandlerManager as never,
        actionExecutor,
      } as Parameters<typeof registerMachineExternalSessionsRpcHandlers>[0] & {
        actionExecutor: RpcActionExecutor;
      });

      const handler = rpcHandlerManager.handlers.get(method);
      expect(handler).toBeDefined();

      const response = await handler!({
        machineId: 'machine-1',
        sessionId: 'linked-session-1',
      });

      expect(response).toEqual({
        ok: false,
        errorCode: 'internal_error',
        error: 'external_session_takeover_failed',
      });
      expect(responseSchema.safeParse(response).success).toBe(true);
    },
  );

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
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      actionExecutor,
    } as Parameters<typeof registerMachineExternalSessionsRpcHandlers>[0] & {
      actionExecutor: RpcActionExecutor;
    });

    const takeoverHandler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY);
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
