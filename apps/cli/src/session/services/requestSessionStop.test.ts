import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const {
  fetchSessionByIdCompatMock,
  isPidSafeHappySessionProcessMock,
  listSessionMarkersMock,
  removeSessionMarkerMock,
  resolveSessionIdOrPrefixMock,
  stopDaemonSessionMock,
} = vi.hoisted(() => ({
  fetchSessionByIdCompatMock: vi.fn(),
  isPidSafeHappySessionProcessMock: vi.fn(),
  listSessionMarkersMock: vi.fn(),
  removeSessionMarkerMock: vi.fn(),
  resolveSessionIdOrPrefixMock: vi.fn(),
  stopDaemonSessionMock: vi.fn(),
}));

vi.mock('@/daemon/controlClient', () => ({
  stopDaemonSession: stopDaemonSessionMock,
}));

vi.mock('@/daemon/pidSafety', () => ({
  isPidSafeHappySessionProcess: isPidSafeHappySessionProcessMock,
}));

vi.mock('@/daemon/sessionRegistry', () => ({
  listSessionMarkers: listSessionMarkersMock,
  removeSessionMarker: removeSessionMarkerMock,
}));

vi.mock('@/session/query/resolveSessionId', () => ({
  resolveSessionIdOrPrefix: resolveSessionIdOrPrefixMock,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: fetchSessionByIdCompatMock,
}));

describe('requestSessionStop', () => {
  let happyHomeDir = '';
  const previousHappyHomeDir = process.env.HAPPIER_HOME_DIR;

  beforeEach(async () => {
    vi.resetModules();
    happyHomeDir = await createTempDir('happier-request-session-stop-');
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

    fetchSessionByIdCompatMock.mockReset();
    isPidSafeHappySessionProcessMock.mockReset();
    listSessionMarkersMock.mockReset();
    removeSessionMarkerMock.mockReset();
    resolveSessionIdOrPrefixMock.mockReset();
    stopDaemonSessionMock.mockReset();
  });

  afterEach(async () => {
    if (previousHappyHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHappyHomeDir;

    if (happyHomeDir) {
      await removeTempDir(happyHomeDir);
      happyHomeDir = '';
    }
    vi.restoreAllMocks();
  });

  it('keeps marker PID reuse diagnostics out of stdout when stopping from a JSON command path', async () => {
    const sessionId = 'sess_marker_pid_reuse';
    const markerPid = 12345;
    resolveSessionIdOrPrefixMock.mockResolvedValue({ ok: true, sessionId });
    stopDaemonSessionMock.mockResolvedValue(false);
    listSessionMarkersMock.mockResolvedValue([
      {
        pid: markerPid,
        happySessionId: sessionId,
        happyHomeDir,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedBy: 'terminal',
        processCommandHash: 'a'.repeat(64),
      },
    ]);
    isPidSafeHappySessionProcessMock.mockResolvedValue(false);
    fetchSessionByIdCompatMock.mockResolvedValue({ id: sessionId, active: false });

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { requestSessionStop } = await import('./requestSessionStop');

    const result = await requestSessionStop({
      credentials: { token: 'token_test', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      idOrPrefix: sessionId,
    });

    expect(result).toEqual({ ok: true, sessionId, stopped: true });
    expect(isPidSafeHappySessionProcessMock).toHaveBeenCalledWith({
      pid: markerPid,
      expectedProcessCommandHash: 'a'.repeat(64),
    });
    expect(consoleLogSpy).not.toHaveBeenCalled();
  }, 30_000);
});
