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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    latest = await runner.poll(params);
    if (latest.result) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
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

  it('reports background-service naming when the local service is missing', async () => {
    const kind = createDaemonServiceStartTaskKind({
      readStatus: async () => ({
        serviceInstalled: false,
        daemonRunning: false,
        needsAuth: false,
        machineId: null,
        daemonServerUrl: null,
        daemonComparableKey: null,
        daemonAccountId: null,
        daemonMachineRegistered: null,
      }),
      startService: async () => {
        throw new Error('startService should not be called');
      },
      stopService: async () => {
        throw new Error('stopService should not be called');
      },
      restartService: async () => {
        throw new Error('restartService should not be called');
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'daemon.service.start.v1': kind,
      },
    });

    await runner.start({
      taskId: 'daemon-start',
      kind: 'daemon.service.start.v1',
      params: {
        target: { kind: 'local' },
        surface: 'test',
        mode: 'user',
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'daemon-start', cursor: 0 });
    expect(finalPoll.result).toMatchObject({
      ok: false,
      error: {
        code: 'daemon_service_not_installed',
        message: 'Background service is not installed on this computer yet.',
      },
    });
  });

  it('reports selected-server guidance when the local service still needs authentication', async () => {
    const kind = createDaemonServiceStartTaskKind({
      readStatus: async () => ({
        serviceInstalled: true,
        daemonRunning: false,
        needsAuth: true,
        machineId: null,
        daemonServerUrl: 'https://relay.example.test',
        daemonComparableKey: 'https://relay.example.test',
        daemonAccountId: null,
        daemonMachineRegistered: false,
      }),
      startService: async () => {
        throw new Error('startService should not be called');
      },
      stopService: async () => {
        throw new Error('stopService should not be called');
      },
      restartService: async () => {
        throw new Error('restartService should not be called');
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'daemon.service.start.v1': kind,
      },
    });

    await runner.start({
      taskId: 'daemon-auth',
      kind: 'daemon.service.start.v1',
      params: {
        target: { kind: 'local' },
        surface: 'test',
        mode: 'user',
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'daemon-auth', cursor: 0 });
    expect(finalPoll.result).toMatchObject({
      ok: false,
      error: {
        code: 'not_authenticated',
        message: 'Authenticate this computer with the selected Relay before continuing.',
      },
    });
  });

  it('reports background-service naming when start does not reach ready state', async () => {
    let statusReads = 0;
    const kind = createDaemonServiceStartTaskKind({
      readStatus: async () => {
        statusReads += 1;
        return {
          serviceInstalled: true,
          daemonRunning: false,
          needsAuth: false,
          machineId: 'machine-1',
          daemonServerUrl: 'https://relay.example.test',
          daemonComparableKey: 'https://relay.example.test',
          daemonAccountId: 'acct_123',
          daemonMachineRegistered: true,
        };
      },
      startService: async () => undefined,
      stopService: async () => {
        throw new Error('stopService should not be called');
      },
      restartService: async () => {
        throw new Error('restartService should not be called');
      },
    });

    const previousTimeout = process.env.HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_TIMEOUT_MS;
    const previousPoll = process.env.HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_POLL_MS;
    process.env.HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_TIMEOUT_MS = '100';
    process.env.HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_POLL_MS = '50';

    try {
      const runner = createSystemTasksRunner({
        kinds: {
          'daemon.service.start.v1': kind,
        },
      });

      await runner.start({
        taskId: 'daemon-not-ready',
        kind: 'daemon.service.start.v1',
        params: {
          target: { kind: 'local' },
          surface: 'test',
          mode: 'user',
        },
      });

      const finalPoll = await waitForResult(runner, { taskId: 'daemon-not-ready', cursor: 0 });
      expect(statusReads).toBeGreaterThan(1);
      expect(finalPoll.result).toMatchObject({
        ok: false,
        error: {
          code: 'daemon_service_not_ready',
          message: 'Background service did not reach a ready state.',
        },
      });
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_TIMEOUT_MS;
      } else {
        process.env.HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_TIMEOUT_MS = previousTimeout;
      }
      if (previousPoll === undefined) {
        delete process.env.HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_POLL_MS;
      } else {
        process.env.HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_POLL_MS = previousPoll;
      }
    }
  });

  it('reports background-service naming when stop does not complete cleanly', async () => {
    let statusReads = 0;
    const kind = createDaemonServiceStopTaskKind({
      readStatus: async () => {
        statusReads += 1;
        return {
          serviceInstalled: true,
          daemonRunning: true,
          needsAuth: false,
          machineId: 'machine-1',
          daemonServerUrl: 'https://relay.example.test',
          daemonComparableKey: 'https://relay.example.test',
          daemonAccountId: 'acct_123',
          daemonMachineRegistered: true,
        };
      },
      startService: async () => {
        throw new Error('startService should not be called');
      },
      stopService: async () => undefined,
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
      taskId: 'daemon-not-stopped',
      kind: 'daemon.service.stop.v1',
      params: {
        target: { kind: 'local' },
        surface: 'test',
        mode: 'user',
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'daemon-not-stopped', cursor: 0 });
    expect(statusReads).toBeGreaterThan(1);
    expect(finalPoll.result).toMatchObject({
      ok: false,
      error: {
        code: 'daemon_service_not_stopped',
        message: 'Background service did not stop cleanly.',
      },
    });
  });
});
