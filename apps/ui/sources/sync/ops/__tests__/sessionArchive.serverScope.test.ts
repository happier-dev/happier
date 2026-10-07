import { afterAll, beforeAll, describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequest, mockResolveContext, mockRuntimeFetchWithServerReachability, mockRelease, mockStorageState } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockResolveContext: vi.fn(),
  mockRuntimeFetchWithServerReachability: vi.fn(),
  mockRelease: vi.fn(async () => undefined),
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

vi.mock('../../runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext', () => ({
  resolveServerAccountRequestContext: mockResolveContext,
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
    mockRelease.mockClear();
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
      runtimeOrigin: 'http://127.0.0.1:49152',
      carrier: 'iroh',
      targetServerId: 'server-b',
      token: 'tok_scoped',
      timeoutMs: 1000,
      encryption: null,
      release: mockRelease,
    });
    mockRuntimeFetchWithServerReachability.mockResolvedValue(makeResponse({ ok: true, json: { success: true, archivedAt: 11 } }));

    const res = await sessionArchiveWithServerScope('sid-2', { serverId: 'server-b' });
    expect(res).toEqual({ success: true, archivedAt: 11 });
    expect(mockRuntimeFetchWithServerReachability).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: 'https://scoped.example',
        token: 'tok_scoped',
        url: 'http://127.0.0.1:49152/v2/sessions/sid-2/archive',
        runtimeOrigin: 'http://127.0.0.1:49152',
        timeoutMs: 1000,
        init: expect.objectContaining({
          method: 'POST',
        }),
      }),
    );
    expect(new Headers(mockRuntimeFetchWithServerReachability.mock.calls[0]?.[0]?.init?.headers).get('Authorization'))
      .toBe('Bearer tok_scoped');
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
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
});

describe('archive routing from canonical session-list rows', () => {
  let boundary: Awaited<ReturnType<typeof import('@/dev/testkit/harness/sessionOpsNetworkBoundary').installSessionOpsNetworkBoundary>>;

  beforeAll(async () => {
    vi.doUnmock('@/sync/api/session/apiSocket');
    vi.doUnmock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext');
    vi.doUnmock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch');
    vi.doUnmock('@/utils/system/runtimeFetch');
    vi.doUnmock('@/sync/domains/state/storage');
    vi.resetModules();
    boundary = await (await import('@/dev/testkit/harness/sessionOpsNetworkBoundary')).installSessionOpsNetworkBoundary();
  });

  afterAll(async () => {
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    await resetServerReachabilitySupervisors();
    boundary?.dispose();
  });

  it('defaults a null serverId to the preferred owner Home from its canonical local list', async () => {
    const owner = await boundary.addHome('https://archive-owner.example', 'archive-account');
    const { storage } = await import('@/sync/domains/state/storage');
    const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    storage.setState(storage.getInitialState(), true);
    storage.getState().applyServerScopedSessionListRows(owner.id, [
      createSessionListRenderableSessionFixture({ id: 'sid-owned' }),
    ], { source: 'ordinary', mode: 'replace' });
    boundary.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v2/sessions/sid-owned/archive'
      ? Response.json({ success: true, archivedAt: 12 }) : null);
    const { sessionArchiveWithServerScope: archive } = await import('../sessions');

    await expect(archive('sid-owned', { serverId: null })).resolves.toEqual({ success: true, archivedAt: 12 });
    expect(boundary.httpRequests.filter(({ url }) => url.includes('/archive'))).toEqual([
      { url: `${owner.serverUrl}/v2/sessions/sid-owned/archive`, token: `Bearer ${owner.token}` },
    ]);
  });
});

describe('sessionUnarchiveWithServerScope', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockResolveContext.mockReset();
    mockRuntimeFetchWithServerReachability.mockReset();
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
});
