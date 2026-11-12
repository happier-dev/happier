import { describe, expect, it, vi } from 'vitest';

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

const defaultDaemonServiceStatusDetails = {
  daemonAccountLabel: null,
  cliUpdate: null,
} satisfies Pick<DaemonServiceStatusSnapshot, 'daemonAccountLabel' | 'cliUpdate'>;

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
      ...defaultDaemonServiceStatusDetails,
    };

    const kind = createDaemonServiceStatusTaskKind({
      readStatus: async (_params, context) => {
        context?.emit({ type: 'cli.acquisition.progress', data: { phase: 'downloading', receivedBytes: 1024 } });
        return snapshot;
      },
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
    expect(finalPoll.events).toContainEqual(expect.objectContaining({
      type: 'cli.acquisition.progress', data: { phase: 'downloading', receivedBytes: 1024 },
    }));
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
        daemonAccountLabel: null,
        cliUpdate: null,
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
        ...defaultDaemonServiceStatusDetails,
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
        ...defaultDaemonServiceStatusDetails,
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
        ...defaultDaemonServiceStatusDetails,
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

  it('keeps service Start pending beyond the former phase cutoff and completes once', async () => {
    vi.useFakeTimers();
    let running = false;
    let reads = 0;
    const status = { serviceInstalled: true, daemonRunning: false, needsAuth: false,
      machineId: 'machine-1', daemonServerUrl: 'https://relay.example.test',
      daemonComparableKey: 'https://relay.example.test', daemonAccountId: 'acct_123',
      daemonMachineRegistered: true, ...defaultDaemonServiceStatusDetails };
    const kind = createDaemonServiceStartTaskKind({
      readStatus: async () => { reads += 1; return { ...status, daemonRunning: running }; },
      startService: async () => undefined, stopService: async () => undefined, restartService: async () => undefined,
    });
    const runner = createSystemTasksRunner({ kinds: { 'daemon.service.start.v1': kind } });
    try {
      await runner.start({ taskId: 'slow-start', kind: 'daemon.service.start.v1', params: { target: { kind: 'local' } } });
      await vi.advanceTimersByTimeAsync(90_000);
      expect((await runner.poll({ taskId: 'slow-start', cursor: 0 })).result).toBeNull();
      const readsBeforeReady = reads;
      running = true;
      await vi.advanceTimersByTimeAsync(500);
      expect((await runner.poll({ taskId: 'slow-start', cursor: 0 })).result).toMatchObject({ ok: true, data: { daemonRunning: true } });
      expect(reads).toBe(readsBeforeReady + 1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { running = true; await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); }
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
          ...defaultDaemonServiceStatusDetails,
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
