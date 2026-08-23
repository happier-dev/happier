import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequest, mockResolveContext, mockRuntimeFetch, mockStorageState } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockResolveContext: vi.fn(),
  mockRuntimeFetch: vi.fn(),
  mockStorageState: {
    sessions: {},
    concurrentSessionListCacheByServerId: {},
    applySessions: vi.fn(),
  } as {
    sessions: Record<string, unknown>;
    concurrentSessionListCacheByServerId: Record<string, unknown>;
    applySessions: ReturnType<typeof vi.fn>;
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

vi.mock('@/utils/system/runtimeFetch', () => ({
  runtimeFetch: mockRuntimeFetch,
}));

vi.mock('../../domains/state/storage', () => ({
  storage: {
    getState: () => mockStorageState,
  },
}));

import {
  sessionDelete,
  sessionDeleteWithServerAccountAuthority,
  sessionDeleteWithServerScope,
} from '../../ops';

function makeResponse(opts: Readonly<{ ok: boolean; status?: number; json?: unknown; text?: string }>) {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? '',
    headers: new Map(),
  } as any;
}

describe('sessionDeleteWithServerScope', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockResolveContext.mockReset();
    mockRuntimeFetch.mockReset();
    mockStorageState.sessions = {};
    mockStorageState.concurrentSessionListCacheByServerId = {};
    mockStorageState.applySessions.mockReset();
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
    mockRequest.mockResolvedValue(makeResponse({ ok: true }));

    const res = await sessionDeleteWithServerScope('sid-1', { serverId: 'server-a' });
    expect(res).toEqual({ success: true });
    expect(mockRequest).toHaveBeenCalledWith('/v1/sessions/sid-1', { method: 'DELETE' });
    expect(mockRuntimeFetch).not.toHaveBeenCalled();
  });

  it('uses runtimeFetch with the scoped server URL and bearer token when scope is not active', async () => {
    mockResolveContext.mockResolvedValue({
      scope: 'scoped',
      targetServerUrl: 'https://scoped.example',
      targetServerId: 'server-b',
      token: 'tok_scoped',
      timeoutMs: 1000,
      encryption: null,
    });
    mockRuntimeFetch.mockResolvedValue(makeResponse({ ok: true }));

    const res = await sessionDeleteWithServerScope('sid-2', { serverId: 'server-b' });
    expect(res).toEqual({ success: true });
    expect(mockRuntimeFetch).toHaveBeenCalledWith(
      'https://scoped.example/v1/sessions/sid-2',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer tok_scoped',
        }),
      }),
    );
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('separates a server-confirmed absent session from a retryable delete conflict on every transport', async () => {
    mockResolveContext.mockResolvedValue({
      scope: 'active',
      targetServerUrl: 'https://active.example',
      targetServerId: 'server-a',
      token: 'tok',
      timeoutMs: 1000,
      encryption: null,
    });
    mockRequest.mockResolvedValueOnce(makeResponse({
      ok: false,
      status: 404,
      text: 'Session not found or not owned by user',
    }));
    const absentOverSocket = await sessionDeleteWithServerScope('sid-1', { serverId: 'server-a' });
    mockRequest.mockResolvedValueOnce(makeResponse({
      ok: false,
      status: 409,
      text: 'Session delete condition was lost',
    }));
    const conflictOverSocket = await sessionDeleteWithServerScope('sid-1', { serverId: 'server-a' });

    mockResolveContext.mockResolvedValue({
      scope: 'scoped',
      targetServerUrl: 'https://scoped.example',
      targetServerId: 'server-b',
      token: 'tok_scoped',
      timeoutMs: 1000,
      encryption: null,
    });
    mockRuntimeFetch.mockResolvedValueOnce(makeResponse({
      ok: false,
      status: 404,
      text: 'Session not found or not owned by user',
    }));
    const absentOverFetch = await sessionDeleteWithServerScope('sid-2', { serverId: 'server-b' });
    mockRuntimeFetch.mockResolvedValueOnce(makeResponse({
      ok: false,
      status: 409,
      text: 'Session delete condition was lost',
    }));
    const conflictOverFetch = await sessionDeleteWithServerScope('sid-2', { serverId: 'server-b' });

    const authorityRequest = vi.fn()
      .mockResolvedValueOnce(makeResponse({
        ok: false,
        status: 404,
        text: 'Session not found or not owned by user',
      }))
      .mockResolvedValueOnce(makeResponse({
        ok: false,
        status: 409,
        text: 'Session delete condition was lost',
      }));
    const authority = { request: authorityRequest } as never;
    const absentOverAuthority = await sessionDeleteWithServerAccountAuthority('sid-3', authority);
    const conflictOverAuthority = await sessionDeleteWithServerAccountAuthority('sid-3', authority);

    for (const absent of [absentOverSocket, absentOverFetch, absentOverAuthority]) {
      expect(absent).toMatchObject({ success: false, code: 'session_absent' });
    }
    for (const conflict of [conflictOverSocket, conflictOverFetch, conflictOverAuthority]) {
      expect(conflict).toMatchObject({ success: false, code: 'session_delete_conflict' });
    }
  });

  it('leaves an unclassified delete failure without an outcome code', async () => {
    mockResolveContext.mockResolvedValue({
      scope: 'active',
      targetServerUrl: 'https://active.example',
      targetServerId: 'server-a',
      token: 'tok',
      timeoutMs: 1000,
      encryption: null,
    });
    mockRequest.mockResolvedValueOnce(makeResponse({
      ok: false,
      status: 500,
      text: 'boom',
    }));

    const res = await sessionDeleteWithServerScope('sid-1', { serverId: 'server-a' });

    expect(res).toEqual({ success: false, message: 'boom' });
  });

  it('sessionDelete defaults to the preferred owner server from local cache', async () => {
    mockStorageState.sessions = {
      'sid-owned': {
        serverId: 'server-owned',
      },
    };
    mockResolveContext.mockResolvedValue({
      scope: 'active',
      targetServerUrl: 'https://active.example',
      targetServerId: 'server-owned',
      token: 'tok',
      timeoutMs: 1000,
      encryption: null,
    });
    mockRequest.mockResolvedValue(makeResponse({ ok: true }));

    const res = await sessionDelete('sid-owned');

    expect(res).toEqual({ success: true });
    expect(mockResolveContext).toHaveBeenCalledWith({ serverId: 'server-owned' });
    expect(mockRequest).toHaveBeenCalledWith('/v1/sessions/sid-owned', { method: 'DELETE' });
  });
});
