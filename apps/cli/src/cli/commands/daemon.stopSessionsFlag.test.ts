import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonRunningInspection } from '@/daemon/controlClient';
import type { HappyProcessInfo } from '@/daemon/doctor';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const { findAllHappyProcessesMock, inspectDaemonMock, stopDaemonMock, stopAllDaemonsBestEffortMock } = vi.hoisted(() => ({
  findAllHappyProcessesMock: vi.fn<() => Promise<HappyProcessInfo[]>>(async () => []),
  inspectDaemonMock: vi.fn<() => Promise<DaemonRunningInspection>>(async () => ({ status: 'not-running' })),
  stopDaemonMock: vi.fn(),
  stopAllDaemonsBestEffortMock: vi.fn(),
}));

vi.mock('@/daemon/doctor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/doctor')>();
  return {
    ...actual,
    findAllHappyProcesses: findAllHappyProcessesMock,
  };
});

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
  const envScope = createEnvKeyScope(['HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK']);

  afterEach(() => {
    envScope.restore();
    findAllHappyProcessesMock.mockReset();
    findAllHappyProcessesMock.mockResolvedValue([]);
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

  it('stops every daemon without stopping sessions by default', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as any);

    await expect(
      handleDaemonCliCommand({
        args: ['daemon', 'stop', '--all'],
      } as any),
    ).rejects.toThrow(/exit:0/);

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(stopAllDaemonsBestEffortMock).toHaveBeenCalledWith({ stopSessions: false });
  }, 60_000);

  it('fails closed when the current relay owner source is unknown', async () => {
    envScope.patch({ HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '1' });
    inspectDaemonMock.mockResolvedValue({ status: 'not-running' });
    findAllHappyProcessesMock.mockResolvedValue([{
      pid: process.pid + 1_000,
      command: `${process.execPath} ${process.cwd()}/src/index.ts daemon start-sync`,
      type: 'dev-daemon',
    }]);

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
