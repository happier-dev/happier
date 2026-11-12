import { SystemTaskExecutionError } from '../runSystemTask.js';
import { type InteractiveSystemTaskContext, type InteractiveSystemTaskKind } from '../interactiveTaskKinds.js';
import type { LocalCliUpdateFact } from '../executors/cliUpdateFact.js';
import { waitForMachineOnline } from '../executors/enrollMachineFlowExecutor.js';

export type DaemonServiceTaskParams = Readonly<{
  target: Readonly<{
    kind: 'local';
  }>;
  surface?: string;
  mode?: 'user';
  channel?: 'stable' | 'preview' | 'dev' | 'publicdev';
  /**
   * The Home whose own daemon and service to address (R10 D3). Daemons are per-server; without it
   * the CLI's globally active server is read, which is the terminal's choice, not the desktop's.
   */
  relayUrl?: string;
  /** That Home's server identity, which tells apart CLI profiles sharing its URL (RV-11). */
  serverIdentityId?: string;
  autostart?: 'at-login' | 'on-demand';
  /** App-open aggregate start: only stopped desktop-managed on-demand targets. */
  onDemandOnly?: boolean;
}>;

export type DaemonServiceStatusSnapshot = Readonly<{
  serviceAutostart?: 'at-login' | 'on-demand' | null;
  /** Full managed inventory presence, before relay-row dedupe; null means absence is unproved. */
  managedServiceInstalled?: boolean | null;
  /** Full managed inventory, before relay-row dedupe; null means an unreadable managed target. */
  runningManagedServiceCount?: number | null;
  serviceTargetMode?: 'default-following' | 'pinned' | null;
  serviceManagedBy?: 'desktop' | null;
  serviceServerId?: string | null;
  serviceInstalled: boolean;
  daemonRunning: boolean;
  needsAuth: boolean;
  machineId: string | null;
  daemonServerUrl: string | null;
  daemonComparableKey: string | null;
  daemonAccountId: string | null;
  daemonMachineRegistered: boolean | null;
  /** Readable label of the account the relay validated (username, else display name), or `null`. */
  daemonAccountLabel: string | null;
  /** Cached update fact for this channel's CLI (R17); `null` when no CLI version is known. */
  cliUpdate: LocalCliUpdateFact | null;
  /**
   * This computer's one-CLI answer (plan R12) and the CLI that is not the managed one: the kept CLI,
   * or an old copy still on the search path. Local reads only; absent from other producers.
   */
  cliChoice?: DaemonServiceCliChoiceFacts | null;
}>;

export type DaemonServiceCliChoiceFacts = Readonly<{
  /** The recorded answer; `null` when nobody was asked. */
  mode: 'managed' | 'own' | null;
  otherCli: Readonly<{
    command: string;
    origin: 'npm' | 'brew' | 'unknown';
    /** Shown, never run. */
    removalCommand: string | null;
    updateCommand: string | null;
  }> | null;
}>;

export type DaemonServiceTaskResult = DaemonServiceStatusSnapshot;

export type DaemonServiceKindDeps = Readonly<{
  readStatus: (params: DaemonServiceTaskParams, context?: Pick<InteractiveSystemTaskContext, 'signal' | 'emit'>) => Promise<DaemonServiceStatusSnapshot>;
  startService: (params: DaemonServiceTaskParams, context?: Pick<InteractiveSystemTaskContext, 'signal'>) => Promise<void>;
  stopService: (params: DaemonServiceTaskParams, context?: Pick<InteractiveSystemTaskContext, 'signal'>) => Promise<void>;
  restartService: (params: DaemonServiceTaskParams, context?: Pick<InteractiveSystemTaskContext, 'signal'>) => Promise<void>;
}>;

/** One Start admission decision for executors and their action projection. */
export function readDaemonServiceStartBlocker(status: DaemonServiceStatusSnapshot): 'daemon_service_not_installed' | 'not_authenticated' | null {
  return !status.serviceInstalled ? 'daemon_service_not_installed' : status.needsAuth ? 'not_authenticated' : null;
}

function assertDaemonReady(status: DaemonServiceStatusSnapshot): void {
  const blocker = readDaemonServiceStartBlocker(status);
  if (blocker === 'daemon_service_not_installed') {
    throw new SystemTaskExecutionError(
      'daemon_service_not_installed',
      'Background service is not installed on this computer yet.',
    );
  }
  if (blocker === 'not_authenticated') {
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
      'Background service is not installed on this computer yet.',
    );
  }
}

export function createDaemonServiceStatusTaskKind(deps: DaemonServiceKindDeps): InteractiveSystemTaskKind<DaemonServiceTaskResult> {
  return {
    async run(ctx) {
      const parsed = parseDaemonServiceTaskParams(ctx.params);
      return await deps.readStatus(parsed, ctx);
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
        message: 'Inspect background service',
      });

      const currentStatus = await deps.readStatus(parsed, ctx);
      assertDaemonReady(currentStatus);

      ctx.emit({
        type: 'progress',
        stepId: 'task.step.installRuntime',
        message: 'Start background service',
      });

      await deps.startService(parsed, ctx);

      const readyStatus = await waitForMachineOnline({
        readStatus: async () => await deps.readStatus(parsed, ctx),
        signal: ctx.signal,
      });

      ctx.emit({
        type: 'progress',
        stepId: 'task.step.finish',
        message: 'Background service started',
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
        message: 'Inspect background service',
      });

      const currentStatus = await deps.readStatus(parsed, ctx);
      assertDaemonInstalled(currentStatus);

      ctx.emit({
        type: 'progress',
        stepId: 'task.step.stop',
        message: 'Stop background service',
      });

      await deps.stopService(parsed, ctx);

      const stoppedStatus = await deps.readStatus(parsed, ctx);
      if (stoppedStatus.daemonRunning) {
        throw new SystemTaskExecutionError(
          'daemon_service_not_stopped',
          'Background service did not stop cleanly.',
        );
      }

      ctx.emit({
        type: 'progress',
        stepId: 'task.step.finish',
        message: 'Background service stopped',
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
        message: 'Inspect background service',
      });

      const currentStatus = await deps.readStatus(parsed, ctx);
      assertDaemonInstalled(currentStatus);

      ctx.emit({
        type: 'progress',
        stepId: 'task.step.restart',
        message: 'Restart background service',
      });

      await deps.restartService(parsed, ctx);

      const readyStatus = await waitForMachineOnline({
        readStatus: async () => await deps.readStatus(parsed, ctx),
        signal: ctx.signal,
      });

      ctx.emit({
        type: 'progress',
        stepId: 'task.step.finish',
        message: 'Background service restarted',
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
  const autostart = record.autostart;
  if (autostart !== undefined && autostart !== 'at-login' && autostart !== 'on-demand') {
    throw new SystemTaskExecutionError('invalid_params', 'autostart must be at-login or on-demand.');
  }
  const target = record.target;
  const mode = record.mode;
  const channel = record.channel;
  const relayUrl = record.relayUrl;
  const onDemandOnly = record.onDemandOnly;
  if (onDemandOnly !== undefined && typeof onDemandOnly !== 'boolean') {
    throw new SystemTaskExecutionError('invalid_params', 'onDemandOnly must be a boolean.');
  }
  if (onDemandOnly === true && relayUrl !== undefined) {
    throw new SystemTaskExecutionError('invalid_params', 'App-open start must address all managed services.');
  }
  if (relayUrl !== undefined && (typeof relayUrl !== 'string' || relayUrl.trim().length === 0)) {
    throw new SystemTaskExecutionError('invalid_params', 'relayUrl must be a non-empty string when provided.');
  }
  const serverIdentityId = record.serverIdentityId;
  if (serverIdentityId !== undefined && (
    typeof serverIdentityId !== 'string' || serverIdentityId.trim().length === 0 || relayUrl === undefined
  )) {
    throw new SystemTaskExecutionError('invalid_params', 'serverIdentityId must be a non-empty string next to relayUrl when provided.');
  }

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
  const normalizedChannel = typeof channel === 'string' ? channel.trim().toLowerCase() : '';
  if (normalizedChannel && normalizedChannel !== 'stable' && normalizedChannel !== 'preview' && normalizedChannel !== 'dev' && normalizedChannel !== 'publicdev') {
    throw new SystemTaskExecutionError('invalid_params', 'channel must be stable, preview, dev, or publicdev when provided.');
  }

  return {
    target: {
      kind: 'local',
    },
    ...(surface === undefined ? {} : { surface: surface.trim() }),
    ...(normalizedMode === 'user' ? { mode: 'user' as const } : {}),
    ...(normalizedChannel ? { channel: normalizedChannel as DaemonServiceTaskParams['channel'] } : {}),
    ...(typeof relayUrl === 'string' ? { relayUrl: relayUrl.trim() } : {}),
    ...(typeof serverIdentityId === 'string' ? { serverIdentityId: serverIdentityId.trim() } : {}),
    ...(autostart === undefined ? {} : { autostart }),
    ...(onDemandOnly === undefined ? {} : { onDemandOnly }),
  };
}

/** Changes an installed service's actual trigger through its CLI owner and proves the new mode. */
export function createDaemonServiceAutostartTaskKind(deps: DaemonServiceKindDeps & Readonly<{
  setAutostart: (params: DaemonServiceTaskParams & Readonly<{ autostart: 'at-login' | 'on-demand' }>, context?: Pick<InteractiveSystemTaskContext, 'signal'>) => Promise<void>;
}>): InteractiveSystemTaskKind<DaemonServiceTaskResult> {
  return {
    async run(ctx) {
      const params = parseDaemonServiceTaskParams(ctx.params);
      if (!params.autostart) throw new SystemTaskExecutionError('invalid_params', 'An explicit autostart mode is required.');
      assertDaemonInstalled(await deps.readStatus(params, ctx));
      await deps.setAutostart({ ...params, autostart: params.autostart }, ctx);
      const status = await deps.readStatus(params, ctx);
      if (status.serviceAutostart !== params.autostart) throw new SystemTaskExecutionError('daemon_service_autostart_not_applied', 'The background service login trigger did not reach the selected mode.');
      return status;
    },
  };
}
