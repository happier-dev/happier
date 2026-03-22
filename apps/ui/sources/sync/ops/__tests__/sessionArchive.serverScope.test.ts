import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequest, mockResolveContext, mockRuntimeFetch, mockStorageState } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockResolveContext: vi.fn(),
  mockRuntimeFetch: vi.fn(),
  mockStorageState: {
    sessions: {},
    sessionListViewDataByServerId: {},
    applySessions: vi.fn(),
  } as {
    sessions: Record<string, unknown>;
    sessionListViewDataByServerId: Record<string, unknown>;
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
    mockRuntimeFetch.mockReset();
    mockStorageState.sessions = {};
    mockStorageState.sessionListViewDataByServerId = {};
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
    mockRequest.mockResolvedValue(makeResponse({ ok: true, json: { success: true, archivedAt: 10 } }));

    const res = await sessionArchiveWithServerScope('sid-1', { serverId: 'server-a' });
    expect(res).toEqual({ success: true, archivedAt: 10 });
    expect(mockRequest).toHaveBeenCalledWith('/v2/sessions/sid-1/archive', { method: 'POST' });
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
    mockRuntimeFetch.mockResolvedValue(makeResponse({ ok: true, json: { success: true, archivedAt: 11 } }));

    const res = await sessionArchiveWithServerScope('sid-2', { serverId: 'server-b' });
    expect(res).toEqual({ success: true, archivedAt: 11 });
    expect(mockRuntimeFetch).toHaveBeenCalledWith(
      'https://scoped.example/v2/sessions/sid-2/archive',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer tok_scoped',
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
});

describe('sessionUnarchiveWithServerScope', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockResolveContext.mockReset();
    mockRuntimeFetch.mockReset();
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
    expect(mockRuntimeFetch).not.toHaveBeenCalled();
  });
});
