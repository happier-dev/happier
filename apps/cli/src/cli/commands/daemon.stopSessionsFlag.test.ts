import { afterEach, describe, expect, it, vi } from 'vitest';

const { stopDaemonMock, stopAllDaemonsBestEffortMock } = vi.hoisted(() => ({
  stopDaemonMock: vi.fn(),
  stopAllDaemonsBestEffortMock: vi.fn(),
}));

vi.mock('@/daemon/controlClient', () => ({
  checkIfDaemonRunningAndCleanupStaleState: vi.fn(async () => false),
  listDaemonSessions: vi.fn(async () => []),
  stopDaemon: stopDaemonMock,
  stopDaemonSession: vi.fn(async () => false),
}));

vi.mock('@/daemon/multiDaemon', () => ({
  listDaemonStatusesForAllKnownServers: vi.fn(async () => []),
  stopAllDaemonsBestEffort: stopAllDaemonsBestEffortMock,
}));

import { handleDaemonCliCommand } from './daemon';

describe('handleDaemonCliCommand: daemon stop --kill-sessions', () => {
  afterEach(() => {
    stopDaemonMock.mockReset();
    stopAllDaemonsBestEffortMock.mockReset();
    vi.restoreAllMocks();
  });

  it('passes stopSessions to stopDaemon', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as any);

    await expect(
      handleDaemonCliCommand({
        args: ['daemon', 'stop', '--kill-sessions'],
      } as any),
    ).rejects.toThrow(/exit:0/);

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(stopDaemonMock).toHaveBeenCalledWith({ stopSessions: true });
  }, 60_000);

  it('passes stopSessions to stopAllDaemonsBestEffort when --all is present', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as any);

    await expect(
      handleDaemonCliCommand({
        args: ['daemon', 'stop', '--all', '--kill-sessions'],
      } as any),
    ).rejects.toThrow(/exit:0/);

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(stopAllDaemonsBestEffortMock).toHaveBeenCalledWith({ stopSessions: true });
  }, 60_000);
});
