import { describe, expect, it, vi } from 'vitest';

const localDaemonCliMock = vi.hoisted(() => ({
  readDaemonStatus: vi.fn(),
  restartService: vi.fn(),
  startService: vi.fn(),
  stopService: vi.fn(),
  waitForReadyDaemon: vi.fn(),
}));

vi.mock('../localDaemonCli.js', () => localDaemonCliMock);

import {
  createDaemonServiceRestartHandler,
  createDaemonServiceStopHandler,
} from './daemonService.js';

async function collectResult(
  handler: (params: unknown, context: Readonly<{ signal: AbortSignal }>) => AsyncGenerator<unknown, unknown, void>,
  params: unknown,
) {
  const iterator = handler(params, { signal: new AbortController().signal });
  const events: unknown[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

describe('daemonService lifecycle handlers', () => {
  it('stops the local daemon service through the canonical CLI wrapper', async () => {
    localDaemonCliMock.readDaemonStatus
      .mockResolvedValueOnce({
        serviceInstalled: true,
        daemonRunning: true,
        needsAuth: false,
        machineId: 'machine-local-1',
      })
      .mockResolvedValueOnce({
        serviceInstalled: true,
        daemonRunning: false,
        needsAuth: false,
        machineId: 'machine-local-1',
      });

    const handler = createDaemonServiceStopHandler();
    const outcome = await collectResult(handler, {
      target: { kind: 'local' },
      surface: 'desktop.ui',
      mode: 'user',
    });

    expect(localDaemonCliMock.stopService).toHaveBeenCalledTimes(1);
    expect(localDaemonCliMock.restartService).not.toHaveBeenCalled();
    expect(outcome.result).toEqual({
      serviceInstalled: true,
      daemonRunning: false,
      needsAuth: false,
      machineId: 'machine-local-1',
    });
  });

  it('restarts the local daemon service through the canonical CLI wrapper', async () => {
    localDaemonCliMock.readDaemonStatus.mockResolvedValue({
      serviceInstalled: true,
      daemonRunning: true,
      needsAuth: false,
      machineId: 'machine-local-1',
    });
    localDaemonCliMock.waitForReadyDaemon.mockResolvedValue({
      serviceInstalled: true,
      daemonRunning: true,
      needsAuth: false,
      machineId: 'machine-local-1',
    });

    const handler = createDaemonServiceRestartHandler();
    const outcome = await collectResult(handler, {
      target: { kind: 'local' },
      surface: 'desktop.ui',
      mode: 'user',
    });

    expect(localDaemonCliMock.restartService).toHaveBeenCalledTimes(1);
    expect(localDaemonCliMock.startService).not.toHaveBeenCalled();
    expect(outcome.result).toEqual({
      serviceInstalled: true,
      daemonRunning: true,
      needsAuth: false,
      machineId: 'machine-local-1',
    });
  });
});
