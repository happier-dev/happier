import { SystemTaskExecutionError } from '../runSystemTask.js';
import { type InteractiveSystemTaskKind } from '../interactiveTaskKinds.js';

export type DaemonServiceTaskParams = Readonly<{
  target: Readonly<{
    kind: 'local';
  }>;
  surface?: string;
  mode?: 'user';
}>;

export type DaemonServiceStatusSnapshot = Readonly<{
  serviceInstalled: boolean;
  daemonRunning: boolean;
  needsAuth: boolean;
  machineId: string | null;
  daemonServerUrl: string | null;
  daemonComparableKey: string | null;
  daemonAccountId: string | null;
  daemonMachineRegistered: boolean | null;
}>;

export type DaemonServiceTaskResult = DaemonServiceStatusSnapshot;

export type DaemonServiceKindDeps = Readonly<{
  readStatus: (params: DaemonServiceTaskParams) => Promise<DaemonServiceStatusSnapshot>;
  startService: (params: DaemonServiceTaskParams) => Promise<void>;
  stopService: (params: DaemonServiceTaskParams) => Promise<void>;
  restartService: (params: DaemonServiceTaskParams) => Promise<void>;
}>;

function assertDaemonReady(status: DaemonServiceStatusSnapshot): void {
  if (!status.serviceInstalled) {
    throw new SystemTaskExecutionError(
      'daemon_service_not_installed',
      'Daemon service is not installed on this computer yet.',
    );
  }
  if (status.needsAuth) {
    throw new SystemTaskExecutionError(
      'not_authenticated',
      'Authenticate this computer with the selected Relay before continuing.',
    );
  }
}

function assertDaemonInstalled(status: DaemonServiceStatusSnapshot): void {
  if (!status.serviceInstalled) {
    throw new SystemTaskExecutionError(
      'daemon_service_not_installed',
      'Daemon service is not installed on this computer yet.',
    );
  }
}

const DEFAULT_DAEMON_READY_TIMEOUT_MS = 15_000;
const DEFAULT_DAEMON_READY_POLL_MS = 500;

function readPositiveIntEnv(
  envVarName: string,
  fallback: number,
  bounds: Readonly<{ min: number; max: number }>,
): number {
  const rawValue = process.env[envVarName];
  const parsed = typeof rawValue === 'string' ? Number.parseInt(rawValue.trim(), 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < bounds.min) {
    return fallback;
  }
  return Math.min(parsed, bounds.max);
}

async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) {
    throw new SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new SystemTaskExecutionError('cancelled', 'System task execution was cancelled.'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForReadyDaemon(params: Readonly<{
  readStatus: () => Promise<DaemonServiceStatusSnapshot>;
  signal?: AbortSignal;
}>): Promise<DaemonServiceStatusSnapshot> {
  const timeoutMs = readPositiveIntEnv(
    'HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_TIMEOUT_MS',
    DEFAULT_DAEMON_READY_TIMEOUT_MS,
    { min: 100, max: 120_000 },
  );
  const pollMs = readPositiveIntEnv(
    'HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_POLL_MS',
    DEFAULT_DAEMON_READY_POLL_MS,
    { min: 50, max: 5_000 },
  );

  const deadline = Date.now() + timeoutMs;
  let latest = await params.readStatus();
  while ((!latest.serviceInstalled || !latest.daemonRunning || latest.needsAuth) && Date.now() < deadline) {
    await delay(pollMs, params.signal);
    latest = await params.readStatus();
  }
  return latest;
}

export function createDaemonServiceStatusTaskKind(deps: DaemonServiceKindDeps): InteractiveSystemTaskKind<DaemonServiceTaskResult> {
  return {
    async run(ctx) {
      const parsed = parseDaemonServiceTaskParams(ctx.params);
      return await deps.readStatus(parsed);
    },
  };
}

export function createDaemonServiceStartTaskKind(deps: DaemonServiceKindDeps): InteractiveSystemTaskKind<DaemonServiceTaskResult> {
  return {
    async run(ctx) {
      const parsed = parseDaemonServiceTaskParams(ctx.params);

      ctx.emit({
        type: 'progress',
        stepId: 'task.step.prepare',
        message: 'Inspect daemon service',
      });

      const currentStatus = await deps.readStatus(parsed);
      assertDaemonReady(currentStatus);

      ctx.emit({
        type: 'progress',
        stepId: 'task.step.installRuntime',
        message: 'Start daemon service',
      });

      await deps.startService(parsed);

      const readyStatus = await waitForReadyDaemon({
        readStatus: async () => await deps.readStatus(parsed),
        signal: ctx.signal,
      });
      if (!readyStatus.serviceInstalled || !readyStatus.daemonRunning || readyStatus.needsAuth) {
        throw new SystemTaskExecutionError(
          'daemon_service_not_ready',
          'Daemon service did not reach a ready state.',
        );
      }

      ctx.emit({
        type: 'progress',
        stepId: 'task.step.finish',
        message: 'Daemon service started',
      });

      return readyStatus;
    },
  };
}

export function createDaemonServiceStopTaskKind(deps: DaemonServiceKindDeps): InteractiveSystemTaskKind<DaemonServiceTaskResult> {
  return {
    async run(ctx) {
      const parsed = parseDaemonServiceTaskParams(ctx.params);

      ctx.emit({
        type: 'progress',
        stepId: 'task.step.prepare',
        message: 'Inspect daemon service',
      });

      const currentStatus = await deps.readStatus(parsed);
      assertDaemonInstalled(currentStatus);

      ctx.emit({
        type: 'progress',
        stepId: 'task.step.stop',
        message: 'Stop daemon service',
      });

      await deps.stopService(parsed);

      const stoppedStatus = await deps.readStatus(parsed);
      if (stoppedStatus.daemonRunning) {
        throw new SystemTaskExecutionError(
          'daemon_service_not_stopped',
          'Daemon service did not stop cleanly.',
        );
      }

      ctx.emit({
        type: 'progress',
        stepId: 'task.step.finish',
        message: 'Daemon service stopped',
      });

      return stoppedStatus;
    },
  };
}

export function createDaemonServiceRestartTaskKind(deps: DaemonServiceKindDeps): InteractiveSystemTaskKind<DaemonServiceTaskResult> {
  return {
    async run(ctx) {
      const parsed = parseDaemonServiceTaskParams(ctx.params);

      ctx.emit({
        type: 'progress',
        stepId: 'task.step.prepare',
        message: 'Inspect daemon service',
      });

      const currentStatus = await deps.readStatus(parsed);
      assertDaemonInstalled(currentStatus);

      ctx.emit({
        type: 'progress',
        stepId: 'task.step.restart',
        message: 'Restart daemon service',
      });

      await deps.restartService(parsed);

      const readyStatus = await waitForReadyDaemon({
        readStatus: async () => await deps.readStatus(parsed),
        signal: ctx.signal,
      });
      if (!readyStatus.serviceInstalled || !readyStatus.daemonRunning || readyStatus.needsAuth) {
        throw new SystemTaskExecutionError(
          'daemon_service_not_ready',
          'Daemon service did not reach a ready state.',
        );
      }

      ctx.emit({
        type: 'progress',
        stepId: 'task.step.finish',
        message: 'Daemon service restarted',
      });

      return readyStatus;
    },
  };
}

export function parseDaemonServiceTaskParams(params: unknown): DaemonServiceTaskParams {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new SystemTaskExecutionError('invalid_params', 'Daemon service params must be an object.');
  }
  const record = params as Record<string, unknown>;
  const target = record.target;
  const mode = record.mode;

  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new SystemTaskExecutionError('invalid_params', 'target is required.');
  }
  const targetRecord = target as Record<string, unknown>;
  const kind = typeof targetRecord.kind === 'string' ? targetRecord.kind.trim() : '';
  if (kind !== 'local') {
    throw new SystemTaskExecutionError('invalid_params', 'Only local daemon targets are supported.');
  }

  const normalizedMode = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
  if (normalizedMode && normalizedMode !== 'user') {
    throw new SystemTaskExecutionError('invalid_params', 'mode must be \"user\" when provided.');
  }

  const surface = record.surface;
  if (surface !== undefined && (typeof surface !== 'string' || surface.trim().length === 0)) {
    throw new SystemTaskExecutionError('invalid_params', 'surface must be a non-empty string when provided.');
  }

  return {
    target: {
      kind: 'local',
    },
    ...(surface === undefined ? {} : { surface: surface.trim() }),
    ...(normalizedMode === 'user' ? { mode: 'user' as const } : {}),
  };
}
