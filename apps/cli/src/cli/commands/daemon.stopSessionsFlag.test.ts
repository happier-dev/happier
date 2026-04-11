import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonRunningInspection } from '@/daemon/controlClient';

const { inspectDaemonMock, stopDaemonMock, stopAllDaemonsBestEffortMock } = vi.hoisted(() => ({
  inspectDaemonMock: vi.fn<() => Promise<DaemonRunningInspection>>(async () => ({ status: 'not-running' })),
  stopDaemonMock: vi.fn(),
  stopAllDaemonsBestEffortMock: vi.fn(),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
  return {
    ...actual,
    inspectDaemonRunningStateAndCleanupStaleState: inspectDaemonMock,
    checkIfDaemonRunningAndCleanupStaleState: vi.fn(async () => false),
    listDaemonSessions: vi.fn(async () => []),
    stopDaemon: stopDaemonMock,
    stopDaemonSession: vi.fn(async () => false),
  };
});

vi.mock('@/daemon/multiDaemon', () => ({
  listDaemonStatusesForAllKnownServers: vi.fn(async () => []),
  stopAllDaemonsBestEffort: stopAllDaemonsBestEffortMock,
}));

import { handleDaemonCliCommand } from './daemon';

describe('handleDaemonCliCommand: daemon stop --kill-sessions', () => {
  afterEach(() => {
    inspectDaemonMock.mockReset();
    inspectDaemonMock.mockImplementation(async () => ({ status: 'not-running' as const }));
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

  it('fails closed when the current relay owner source is unknown', async () => {
    const runningInspection: DaemonRunningInspection = {
      status: 'running',
      state: {
        pid: process.pid,
        httpPort: 43110,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-other',
        startedWithPublicReleaseChannel: 'preview',
      },
    };
    inspectDaemonMock.mockResolvedValue(runningInspection);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as any);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      handleDaemonCliCommand({
        args: ['daemon', 'stop'],
      } as any),
    ).rejects.toThrow(/exit:1/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stopDaemonMock).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('could not be determined safely');
  }, 60_000);
});
