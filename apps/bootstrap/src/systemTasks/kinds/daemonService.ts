import { systemTasks } from '@happier-dev/cli-common';

import {
  type DaemonStatusSnapshot,
  readDaemonStatus,
  startService,
  waitForReadyDaemon,
} from '../localDaemonCli.js';

export type DaemonServiceTaskParams = Readonly<{
  target: Readonly<{
    kind: 'local';
  }>;
  surface?: string;
  mode?: 'user';
}>;

type DaemonServiceTaskResult = Readonly<{
  serviceInstalled: boolean;
  daemonRunning: boolean;
  needsAuth: boolean;
  machineId: string | null;
}>;

function toDaemonServiceResult(status: DaemonStatusSnapshot): DaemonServiceTaskResult {
  return {
    serviceInstalled: status.serviceInstalled,
    daemonRunning: status.daemonRunning,
    needsAuth: status.needsAuth,
    machineId: status.machineId,
  };
}

function assertDaemonReady(status: DaemonStatusSnapshot): void {
  if (!status.serviceInstalled) {
    throw new systemTasks.SystemTaskExecutionError(
      'daemon_service_not_installed',
      'Daemon service is not installed on this computer yet.',
    );
  }
  if (status.needsAuth) {
    throw new systemTasks.SystemTaskExecutionError(
      'not_authenticated',
      'Authenticate this computer with the selected Relay before continuing.',
    );
  }
}

export function createDaemonServiceStatusHandler() {
  return async function* (
    params: unknown,
    _context: Readonly<{ signal: AbortSignal }>,
  ): AsyncGenerator<never, DaemonServiceTaskResult, void> {
    parseDaemonServiceParams(params);
    const status = await readDaemonStatus();
    return toDaemonServiceResult(status);
  };
}

export function createDaemonServiceStartHandler() {
  return async function* (
    params: unknown,
    context: Readonly<{ signal: AbortSignal }>,
  ): AsyncGenerator<Readonly<{ type: 'progress'; stepId: string; message?: string }>, DaemonServiceTaskResult, void> {
    parseDaemonServiceParams(params);
    yield {
      type: 'progress',
      stepId: 'task.step.prepare',
      message: 'Inspect daemon service',
    };

    const currentStatus = await readDaemonStatus();
    assertDaemonReady(currentStatus);

    yield {
      type: 'progress',
      stepId: 'task.step.installRuntime',
      message: 'Start daemon service',
    };

    await startService();

    const readyStatus = await waitForReadyDaemon({
      readDaemonStatus,
      signal: context.signal,
    });
    if (!readyStatus.serviceInstalled || !readyStatus.daemonRunning || readyStatus.needsAuth) {
      throw new systemTasks.SystemTaskExecutionError(
        'daemon_service_not_ready',
        'Daemon service did not reach a ready state.',
      );
    }

    yield {
      type: 'progress',
      stepId: 'task.step.finish',
      message: 'Daemon service started',
    };

    return toDaemonServiceResult(readyStatus);
  };
}

export function parseDaemonServiceParams(params: unknown): DaemonServiceTaskParams {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Daemon service params must be an object.');
  }
  const record = params as Record<string, unknown>;
  const target = record.target;
  const mode = record.mode;

  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'target is required.');
  }
  const targetRecord = target as Record<string, unknown>;
  const kind = typeof targetRecord.kind === 'string' ? targetRecord.kind.trim() : '';
  if (kind !== 'local') {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Only local daemon targets are supported.');
  }

  const normalizedMode = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
  if (normalizedMode && normalizedMode !== 'user') {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'mode must be "user" when provided.');
  }

  const surface = record.surface;
  if (surface !== undefined && (typeof surface !== 'string' || surface.trim().length === 0)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'surface must be a non-empty string when provided.');
  }

  return {
    target: {
      kind: 'local',
    },
    ...(surface === undefined ? {} : { surface: surface.trim() }),
    ...(normalizedMode === 'user' ? { mode: 'user' as const } : {}),
  };
}
