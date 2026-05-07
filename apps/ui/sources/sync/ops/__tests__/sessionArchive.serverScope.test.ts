import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequest, mockResolveContext, mockRuntimeFetchWithServerReachability, mockStorageState } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockResolveContext: vi.fn(),
  mockRuntimeFetchWithServerReachability: vi.fn(),
  mockStorageState: {
    sessions: {},
    sessionListViewDataByServerId: {},
    applySessions: vi.fn(),
    applySessionListRenderablePatches: vi.fn(),
  } as {
    sessions: Record<string, unknown>;
    sessionListViewDataByServerId: Record<string, unknown>;
    applySessions: ReturnType<typeof vi.fn>;
    applySessionListRenderablePatches: ReturnType<typeof vi.fn>;
  },
}));

vi.mock('../../api/session/apiSocket', () => ({
  apiSocket: {
    request: mockRequest,
  },
}));

vi.mock('../../runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext', () => ({
  resolveServerScopedSessionContext: mockResolveContext,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
  runtimeFetchWithServerReachability: mockRuntimeFetchWithServerReachability,
}));

vi.mock('@/utils/system/runtimeFetch', () => ({
  runtimeFetch: vi.fn(async () => {
    throw new Error('Unexpected runtimeFetch call');
  }),
}));

vi.mock('../../domains/state/storage', () => ({
  storage: {
    getState: () => mockStorageState,
  },
}));

import { sessionArchiveWithServerScope, sessionUnarchiveWithServerScope } from '../../ops';

function makeResponse(opts: Readonly<{ ok: boolean; status?: number; json?: unknown; text?: string }>) {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? '',
    headers: new Map(),
  } as any;
}

describe('sessionArchiveWithServerScope', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockResolveContext.mockReset();
    mockRuntimeFetchWithServerReachability.mockReset();
    mockStorageState.sessions = {};
    mockStorageState.sessionListViewDataByServerId = {};
    mockStorageState.applySessions.mockReset();
    mockStorageState.applySessionListRenderablePatches.mockReset();
  });

  it('uses active apiSocket.request when scope is active', async () => {
    mockResolveContext.mockResolvedValue({
      scope: 'active',
      targetServerUrl: 'https://active.example',
      targetServerId: 'server-a',
      token: 'tok',
      timeoutMs: 1000,
      encryption: null,
    });
    mockRequest.mockResolvedValue(makeResponse({ ok: true, json: { success: true, archivedAt: 10 } }));

    const res = await sessionArchiveWithServerScope('sid-1', { serverId: 'server-a' });
    expect(res).toEqual({ success: true, archivedAt: 10 });
    expect(mockRequest).toHaveBeenCalledWith('/v2/sessions/sid-1/archive', { method: 'POST' });
    expect(mockRuntimeFetchWithServerReachability).not.toHaveBeenCalled();
  });

  it('uses runtimeFetchWithServerReachability with the scoped server URL and bearer token when scope is not active', async () => {
    mockResolveContext.mockResolvedValue({
      scope: 'scoped',
      targetServerUrl: 'https://scoped.example',
      targetServerId: 'server-b',
      token: 'tok_scoped',
      timeoutMs: 1000,
      encryption: null,
    });
    mockRuntimeFetchWithServerReachability.mockResolvedValue(makeResponse({ ok: true, json: { success: true, archivedAt: 11 } }));

    const res = await sessionArchiveWithServerScope('sid-2', { serverId: 'server-b' });
    expect(res).toEqual({ success: true, archivedAt: 11 });
    expect(mockRuntimeFetchWithServerReachability).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: 'https://scoped.example',
        token: 'tok_scoped',
        url: 'https://scoped.example/v2/sessions/sid-2/archive',
        timeoutMs: 1000,
        init: expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer tok_scoped',
          }),
        }),
      }),
    );
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('defaults a null serverId to the preferred owner server from local cache', async () => {
    mockStorageState.sessionListViewDataByServerId = {
      'server-owned': [
        {
          type: 'session',
          session: { id: 'sid-owned' },
        },
      ],
    };
    mockResolveContext.mockResolvedValue({
      scope: 'active',
      targetServerUrl: 'https://active.example',
      targetServerId: 'server-owned',
      token: 'tok',
      timeoutMs: 1000,
      encryption: null,
    });
    mockRequest.mockResolvedValue(makeResponse({ ok: true, json: { success: true, archivedAt: 12 } }));

    const res = await sessionArchiveWithServerScope('sid-owned', { serverId: null });

    expect(res).toEqual({ success: true, archivedAt: 12 });
    expect(mockResolveContext).toHaveBeenCalledWith({ serverId: 'server-owned' });
  });

  it('surfaces a stable session_active code for JSON archive conflicts', async () => {
    mockResolveContext.mockResolvedValue({
      scope: 'active',
      targetServerUrl: 'https://active.example',
      targetServerId: 'server-a',
      token: 'tok',
      timeoutMs: 1000,
      encryption: null,
    });
    mockRequest.mockResolvedValue(makeResponse({
      ok: false,
      status: 409,
      text: '{"error":"session-active"}',
    }));

    const res = await sessionArchiveWithServerScope('sid-conflict', { serverId: 'server-a' });

    expect(res).toEqual({
      success: false,
      message: 'Cannot archive an active session',
      code: 'session_active',
    });
  });

  it('patches cache-only list renderables after a successful archive', async () => {
    mockResolveContext.mockResolvedValue({
      scope: 'active',
      targetServerUrl: 'https://active.example',
      targetServerId: 'server-a',
      token: 'tok',
      timeoutMs: 1000,
      encryption: null,
    });
    mockRequest.mockResolvedValue(makeResponse({ ok: true, json: { success: true, archivedAt: 42 } }));

    const res = await sessionArchiveWithServerScope('sid-cache-only', { serverId: 'server-a' });

    expect(res).toEqual({ success: true, archivedAt: 42 });
    expect(mockStorageState.applySessions).not.toHaveBeenCalled();
    expect(mockStorageState.applySessionListRenderablePatches).toHaveBeenCalledWith([
      {
        sessionId: 'sid-cache-only',
        patch: expect.objectContaining({
          archivedAt: 42,
          updatedAt: expect.any(Number),
        }),
      },
    ]);
  });
});

describe('sessionUnarchiveWithServerScope', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockResolveContext.mockReset();
    mockRuntimeFetchWithServerReachability.mockReset();
    mockStorageState.sessions = {};
    mockStorageState.applySessions.mockReset();
    mockStorageState.applySessionListRenderablePatches.mockReset();
  });

  it('uses active apiSocket.request when scope is active', async () => {
    mockResolveContext.mockResolvedValue({
      scope: 'active',
      targetServerUrl: 'https://active.example',
      targetServerId: 'server-a',
      token: 'tok',
      timeoutMs: 1000,
      encryption: null,
    });
    mockRequest.mockResolvedValue(makeResponse({ ok: true, json: { success: true, archivedAt: null } }));

    const res = await sessionUnarchiveWithServerScope('sid-1', { serverId: 'server-a' });
    expect(res).toEqual({ success: true, archivedAt: null });
    expect(mockRequest).toHaveBeenCalledWith('/v2/sessions/sid-1/unarchive', { method: 'POST' });
    expect(mockRuntimeFetchWithServerReachability).not.toHaveBeenCalled();
  });

  it('patches cache-only list renderables after a successful unarchive', async () => {
    mockResolveContext.mockResolvedValue({
      scope: 'active',
      targetServerUrl: 'https://active.example',
      targetServerId: 'server-a',
      token: 'tok',
      timeoutMs: 1000,
      encryption: null,
    });
    mockRequest.mockResolvedValue(makeResponse({ ok: true, json: { success: true, archivedAt: null } }));

    const res = await sessionUnarchiveWithServerScope('sid-cache-only', { serverId: 'server-a' });

    expect(res).toEqual({ success: true, archivedAt: null });
    expect(mockStorageState.applySessions).not.toHaveBeenCalled();
    expect(mockStorageState.applySessionListRenderablePatches).toHaveBeenCalledWith([
      {
        sessionId: 'sid-cache-only',
        patch: expect.objectContaining({
          archivedAt: null,
          updatedAt: expect.any(Number),
        }),
      },
    ]);
  });
});
