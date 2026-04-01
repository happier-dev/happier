import { describe, expect, it } from 'vitest';

import { createSystemTasksRunner } from '../interactiveTaskKinds.js';
import {
  createDaemonServiceRestartTaskKind,
  createDaemonServiceStartTaskKind,
  createDaemonServiceStatusTaskKind,
  createDaemonServiceStopTaskKind,
  parseDaemonServiceTaskParams,
  type DaemonServiceStatusSnapshot,
} from './daemonServiceKinds.js';

async function waitForResult(
  runner: ReturnType<typeof createSystemTasksRunner>,
  params: Readonly<{ taskId: string; cursor: number }>,
) {
  let latest = await runner.poll(params);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    latest = await runner.poll(params);
    if (latest.result) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected final result for ${params.taskId}: ${JSON.stringify(latest)}`);
}

describe('daemonServiceKinds', () => {
  it('rejects invalid daemon service params', () => {
    try {
      parseDaemonServiceTaskParams(null);
      throw new Error('Expected parseDaemonServiceTaskParams to throw');
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_params' });
    }
  });

  it('runs daemon.service.status.v1 and returns the daemon service status snapshot', async () => {
    const snapshot: DaemonServiceStatusSnapshot = {
      serviceInstalled: true,
      daemonRunning: true,
      needsAuth: false,
      machineId: 'machine-1',
      daemonServerUrl: 'https://relay.example.test',
      daemonComparableKey: 'https://relay.example.test',
      daemonAccountId: 'acct_123',
      daemonMachineRegistered: true,
    };

    const kind = createDaemonServiceStatusTaskKind({
      readStatus: async () => snapshot,
      startService: async () => undefined,
      stopService: async () => undefined,
      restartService: async () => undefined,
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'daemon.service.status.v1': kind,
      },
    });

    await runner.start({
      taskId: 'daemon-status',
      kind: 'daemon.service.status.v1',
      params: {
        target: { kind: 'local' },
        surface: 'test',
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'daemon-status', cursor: 0 });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'daemon-status',
      ok: true,
      data: {
        serviceInstalled: true,
        daemonRunning: true,
        needsAuth: false,
        machineId: 'machine-1',
        daemonServerUrl: 'https://relay.example.test',
        daemonComparableKey: 'https://relay.example.test',
        daemonAccountId: 'acct_123',
        daemonMachineRegistered: true,
      },
    });
  });

  it('runs daemon.service.stop.v1 and calls stopService', async () => {
    const invocations: string[] = [];
    const kind = createDaemonServiceStopTaskKind({
      readStatus: async () => ({
        serviceInstalled: true,
        daemonRunning: false,
        needsAuth: false,
        machineId: 'machine-1',
        daemonServerUrl: null,
        daemonComparableKey: null,
        daemonAccountId: null,
        daemonMachineRegistered: null,
      }),
      startService: async () => {
        throw new Error('startService should not be called');
      },
      stopService: async () => {
        invocations.push('stopService');
      },
      restartService: async () => {
        throw new Error('restartService should not be called');
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'daemon.service.stop.v1': kind,
      },
    });

    await runner.start({
      taskId: 'daemon-stop',
      kind: 'daemon.service.stop.v1',
      params: {
        target: { kind: 'local' },
        surface: 'test',
        mode: 'user',
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'daemon-stop', cursor: 0 });
    expect(invocations).toEqual(['stopService']);
    expect(finalPoll.result?.ok).toBe(true);
  });

  it('exports start/restart kinds', () => {
    expect(typeof createDaemonServiceStartTaskKind).toBe('function');
    expect(typeof createDaemonServiceRestartTaskKind).toBe('function');
  });
});
