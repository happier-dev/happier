import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequest, mockResolveContext, mockRuntimeFetch } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockResolveContext: vi.fn(),
  mockRuntimeFetch: vi.fn(),
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

import { sessionDeleteWithServerScope } from '../../ops';

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
});

