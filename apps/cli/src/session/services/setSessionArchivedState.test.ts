import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  resolveSessionIdOrPrefixMock,
  archiveSessionMock,
  unarchiveSessionMock,
  fetchSessionByIdCompatMock,
  requestSessionStopMock,
  delayMock,
} = vi.hoisted(() => ({
  resolveSessionIdOrPrefixMock: vi.fn(),
  archiveSessionMock: vi.fn(),
  unarchiveSessionMock: vi.fn(),
  fetchSessionByIdCompatMock: vi.fn(),
  requestSessionStopMock: vi.fn(),
  delayMock: vi.fn(),
}));

vi.mock('@/session/query/resolveSessionId', () => ({
  resolveSessionIdOrPrefix: (params: unknown) => resolveSessionIdOrPrefixMock(params),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  archiveSession: (params: unknown) => archiveSessionMock(params),
  unarchiveSession: (params: unknown) => unarchiveSessionMock(params),
  fetchSessionByIdCompat: (params: unknown) => fetchSessionByIdCompatMock(params),
}));

vi.mock('@/utils/time', () => ({
  delay: (ms: number) => delayMock(ms),
}));

vi.mock('./requestSessionStop', () => ({
  requestSessionStop: (params: unknown) => requestSessionStopMock(params),
}));

describe('setSessionArchivedState', () => {
  const credentials = {
    token: 'token-1',
    encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
  };

  beforeEach(() => {
    resolveSessionIdOrPrefixMock.mockReset();
    archiveSessionMock.mockReset();
    unarchiveSessionMock.mockReset();
    fetchSessionByIdCompatMock.mockReset();
    requestSessionStopMock.mockReset();
    delayMock.mockReset();
    delayMock.mockResolvedValue(undefined);

    resolveSessionIdOrPrefixMock.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
    });
  });

  it('archives an inactive session directly without issuing a stop request', async () => {
    archiveSessionMock.mockResolvedValue({ archivedAt: 123 });

    const { setSessionArchivedState } = await import('./setSessionArchivedState');
    await expect(setSessionArchivedState({
      credentials,
      idOrPrefix: 'sess-1',
      archived: true,
    })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-1',
      archivedAt: 123,
    });

    expect(archiveSessionMock).toHaveBeenCalledTimes(1);
    expect(requestSessionStopMock).not.toHaveBeenCalled();
  });

  it('stops an active session and retries the archive request', async () => {
    const activeArchiveError = Object.assign(new Error('Cannot archive an active session'), {
      code: 'session_active' as const,
    });
    archiveSessionMock
      .mockRejectedValueOnce(activeArchiveError)
      .mockResolvedValueOnce({ archivedAt: 456 });
    requestSessionStopMock.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      stopped: true,
    });

    const { setSessionArchivedState } = await import('./setSessionArchivedState');
    await expect(setSessionArchivedState({
      credentials,
      idOrPrefix: 'sess-1',
      archived: true,
    })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-1',
      archivedAt: 456,
    });

    expect(requestSessionStopMock).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'sess-1',
    });
    expect(archiveSessionMock).toHaveBeenCalledTimes(2);
  });

  it('retries archive after a best-effort stop timeout when the session becomes archivable immediately after', async () => {
    const activeArchiveError = Object.assign(new Error('Cannot archive an active session'), {
      code: 'session_active' as const,
    });
    archiveSessionMock
      .mockRejectedValueOnce(activeArchiveError)
      .mockResolvedValueOnce({ archivedAt: 789 });
    requestSessionStopMock.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      stopped: false,
    });

    const { setSessionArchivedState } = await import('./setSessionArchivedState');
    await expect(setSessionArchivedState({
      credentials,
      idOrPrefix: 'sess-1',
      archived: true,
    })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-1',
      archivedAt: 789,
    });

    expect(requestSessionStopMock).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'sess-1',
    });
    expect(archiveSessionMock).toHaveBeenCalledTimes(2);
  });

  it('keeps polling archive after stop until the session becomes inactive', async () => {
    const activeArchiveError = Object.assign(new Error('Cannot archive an active session'), {
      code: 'session_active' as const,
    });
    archiveSessionMock
      .mockRejectedValueOnce(activeArchiveError)
      .mockRejectedValueOnce(activeArchiveError)
      .mockResolvedValueOnce({ archivedAt: 999 });
    requestSessionStopMock.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      stopped: false,
    });
    fetchSessionByIdCompatMock.mockResolvedValueOnce({
      id: 'sess-1',
      active: true,
    });

    const { setSessionArchivedState } = await import('./setSessionArchivedState');
    await expect(setSessionArchivedState({
      credentials,
      idOrPrefix: 'sess-1',
      archived: true,
    })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-1',
      archivedAt: 999,
    });

    expect(requestSessionStopMock).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'sess-1',
    });
    expect(archiveSessionMock).toHaveBeenCalledTimes(3);
    expect(fetchSessionByIdCompatMock).toHaveBeenCalledTimes(1);
    expect(delayMock).toHaveBeenCalledWith(200);
  });
});
