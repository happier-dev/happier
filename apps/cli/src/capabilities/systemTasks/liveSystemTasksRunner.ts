import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { SSH_TUNNEL_SYSTEM_TASK_KINDS } from '@happier-dev/protocol/ssh/tunnels';
import type { SystemTaskJsonValue } from '@happier-dev/protocol';
import { SystemTaskSpecSchema } from '@happier-dev/protocol/system/tasks/spec';
import {
  createDaemonServiceRestartTaskKind,
  createDaemonServiceStartTaskKind,
  createDaemonServiceStatusTaskKind,
  createDaemonServiceStopTaskKind,
  createDeferredPersonalHomeSystemTaskOperations,
  createPersonalHomeBackupTaskKind,
  createPersonalHomeEraseTaskKind,
  createPersonalHomeInspectTaskKind,
  createPersonalHomeRelocationDestinationAbortTaskKind,
  createPersonalHomeRelocationDestinationCommitTaskKind,
  createPersonalHomeRelocationDestinationStageTaskKind,
  createPersonalHomeRelocationDestinationStatusTaskKind,
  createPersonalHomeRestoreTaskKind,
  createPersonalHomeVerifyBackupTaskKind,
  createPersonalHomeRestoreContactReconciler,
  PERSONAL_HOME_SYSTEM_TASK_KINDS,
  createRelayRuntimeInstallOrUpdateTaskKind,
  createRelayRuntimeRestartTaskKind,
  createRelayRuntimeStartTaskKind,
  createRelayRuntimeStatusTaskKind,
  createRelayRuntimeStopTaskKind,
  createRelayRuntimeUninstallTaskKind,
  SystemTaskExecutionError,
  type DaemonServiceStatusSnapshot,
  readLocalCliUpdateFact,
  type DaemonServiceTaskParams,
  type RelayRuntimeStatusSnapshot,
  type RelayRuntimeTaskParams,
  type PersonalHomeSystemTaskOperations,
  type PersonalHomeTaskKindDeps,
} from '@happier-dev/cli-common/systemTasks';
import {
  checkLiveRelayRuntimeHealth,
  createLivePersonalHomeSystemTaskOperations,
  createLivePersonalHomeRelocationDestinationOwner,
  installOrUpdateLiveRelayRuntime,
  readLiveRelayRuntimeStatus,
  restartLiveRelayRuntime,
  startLiveRelayRuntime,
  stopLiveRelayRuntime,
  uninstallLiveRelayRuntime,
} from './relayRuntime/liveRelayRuntime';
import {
  createDiscoverConfiguredSshHostsSystemTaskKind,
  DISCOVER_CONFIGURED_SSH_HOSTS_SYSTEM_TASK_KIND,
} from './ssh/discoverConfiguredSshHosts/task';
import {
  createDaemonSshTunnelEnsureTaskKind,
  createDaemonSshTunnelListTaskKind,
  createDaemonSshTunnelReleaseTaskKind,
  createDaemonSshTunnelStopTaskKind,
} from './ssh/daemonSshTunnelSystemTasks';
import { createLiveRemoteSshBootstrapTaskKind, createLiveRemoteSshManageHostTaskKind } from './ssh/liveRemoteSshBootstrap';
import { createSystemTasksRunner } from './systemTasksRunner';
import { CLI_UPDATE_SYSTEM_TASK_KIND, createCliUpdateRemoteTaskKind } from './kinds/cliUpdateRemote';
import { readCliUpdateFactsForThisCli } from '@/cli/runtime/update/cliUpdateFacts';
import { projectPath } from '@/projectPath';
import { configuration } from '@/configuration';
import { readDaemonStatusSnapshot } from '@/daemon/statusSnapshot';
import { commandExistsInPath } from '@/daemon/service/commandExistsInPath';
import { resolveDaemonServiceCliRuntimeFromEnv } from '@/daemon/service/cli';
import { planDaemonServiceLifecycle, type DaemonServiceLifecycleAction } from '@/daemon/service/plan';

function runCommandsBestEffort(commands: ReadonlyArray<Readonly<{ cmd: string; args: readonly string[] }>>): void {
  for (const command of commands) {
    if (!commandExistsInPath({ cmd: command.cmd, envPath: process.env.PATH, platform: process.platform, pathext: process.env.PATHEXT })) continue;
    try {
      spawnSync(command.cmd, [...command.args], { stdio: 'ignore', env: process.env });
    } catch {
      // ignore
    }
  }
}

async function readLiveDaemonServiceStatusSnapshot(_params: DaemonServiceTaskParams): Promise<DaemonServiceStatusSnapshot> {
  const status = await readDaemonStatusSnapshot();
  return {
    serviceInstalled: status.service.installed === true,
    daemonRunning: status.daemon.running === true,
    needsAuth: status.auth.needsAuth === true,
    machineId: status.auth.machineId ?? null,
    daemonServerUrl: status.server.serverUrl ?? null,
    daemonComparableKey: status.server.comparableKey ?? null,
    daemonAccountId: status.auth.accountId ?? null,
    daemonMachineRegistered: typeof status.auth.machineRegistered === 'boolean' ? status.auth.machineRegistered : null,
    daemonAccountLabel: status.auth.accountLabel ?? null,
    cliUpdate: readLocalCliUpdateFact({ releaseRing: configuration.publicReleaseRing }),
  };
}

async function runLiveDaemonServiceLifecycleAction(_params: DaemonServiceTaskParams, action: Exclude<DaemonServiceLifecycleAction, 'status'>): Promise<void> {
  const runtime = resolveDaemonServiceCliRuntimeFromEnv({ mode: 'user' });
  const plan = planDaemonServiceLifecycle({
    platform: runtime.platform,
    action,
    mode: 'user',
    channel: runtime.channel,
    instanceId: runtime.instanceId,
    userHomeDir: runtime.userHomeDir,
    happierHomeDir: runtime.happierHomeDir,
    uid: runtime.uid ?? undefined,
  });
  runCommandsBestEffort(plan.commands);
}

function requireLocalRelayRuntimeParams(params: RelayRuntimeTaskParams): RelayRuntimeTaskParams {
  if (params.target.kind !== 'local') {
    throw new Error('Live relay runtime tasks only support local targets');
  }
  return { ...params, target: { kind: 'local' as const } };
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (!value || typeof value !== 'object') return 'null';

  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function digestParams(params: unknown): string {
  return createHash('sha256').update(stableStringify(params)).digest('hex');
}

async function waitForDelay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (delayMs <= 0) return;
  if (signal?.aborted) {
    throw new SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const onAbort = () => {
      cleanup();
      reject(new SystemTaskExecutionError('cancelled', 'System task execution was cancelled.'));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseNoopParams(params: unknown): Readonly<{
  delayMs?: number;
  source?: string;
}> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new SystemTaskExecutionError('invalid_params', 'Noop params must be an object.');
  }

  const paramRecord = params as Record<string, unknown>;
  const delayMs = paramRecord.delayMs;
  const source = paramRecord.source;
  const allowedKeys = new Set(['delayMs', 'source']);
  for (const key of Object.keys(paramRecord)) {
    if (!allowedKeys.has(key)) {
      throw new SystemTaskExecutionError('invalid_params', `Unknown noop param: ${key}`);
    }
  }

  if (delayMs !== undefined) {
    if (typeof delayMs !== 'number' || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
      throw new SystemTaskExecutionError('invalid_params', 'delayMs must be an integer between 0 and 60000.');
    }
  }

  if (source !== undefined) {
    if (typeof source !== 'string' || source.trim().length === 0) {
      throw new SystemTaskExecutionError('invalid_params', 'source must be a non-empty string.');
    }
  }

  return {
    ...(typeof delayMs === 'number' ? { delayMs } : {}),
    ...(source === undefined ? {} : { source }),
  };
}

async function readLiveRelayRuntimeSnapshot(params: RelayRuntimeTaskParams): Promise<RelayRuntimeStatusSnapshot> {
  return await readLiveRelayRuntimeStatus(requireLocalRelayRuntimeParams(params));
}

type SystemTasksRunnerAdapter = Readonly<{
  start: (params: Record<string, unknown>) => Promise<unknown>;
  poll: (params: Record<string, unknown>) => Promise<unknown>;
  respond: (params: Record<string, unknown>) => Promise<void>;
  cancel: (params: Record<string, unknown>) => Promise<void>;
  startAdmitted: (kind: import('@happier-dev/cli-common/systemTasks').InteractiveSystemTaskKind) => Promise<Readonly<{ taskId: string }>>;
  wait: ReturnType<typeof createSystemTasksRunner>['wait'];
}>;

let liveRunnerAdapter: SystemTasksRunnerAdapter | null = null;

export function getLiveSystemTasksRunnerAdapter(params: Readonly<{
  personalHomeOperations?: PersonalHomeSystemTaskOperations;
  loadPersonalHomeRelocationDestination?: PersonalHomeTaskKindDeps['loadRelocationDestination'];
  personalHomeRuntime?: Readonly<{
    channel: 'stable' | 'preview' | 'dev';
    mode: 'user' | 'system';
  }>;
  setupThisComputer?: (params: Record<string, unknown>) => Promise<SystemTaskJsonValue>;
}> = {}): SystemTasksRunnerAdapter {
  const isExplicitInvocation = params.personalHomeOperations !== undefined
    || params.loadPersonalHomeRelocationDestination !== undefined
    || params.personalHomeRuntime !== undefined
    || params.setupThisComputer !== undefined;
  if (!isExplicitInvocation && liveRunnerAdapter) {
    return liveRunnerAdapter;
  }

  const adapter = createLiveSystemTasksRunnerAdapter(params);
  if (!isExplicitInvocation) liveRunnerAdapter = adapter;
  return adapter;
}

function createLiveSystemTasksRunnerAdapter(params: Readonly<{
  personalHomeOperations?: PersonalHomeSystemTaskOperations;
  loadPersonalHomeRelocationDestination?: PersonalHomeTaskKindDeps['loadRelocationDestination'];
  personalHomeRuntime?: Readonly<{
    channel: 'stable' | 'preview' | 'dev';
    mode: 'user' | 'system';
  }>;
  setupThisComputer?: (params: Record<string, unknown>) => Promise<SystemTaskJsonValue>;
}>): SystemTasksRunnerAdapter {
  const personalHomeRuntime = params.personalHomeRuntime ?? { channel: 'stable', mode: 'user' } as const;
  const personalHomeOperations = params.personalHomeOperations
    ?? createDeferredPersonalHomeSystemTaskOperations(
      async (target) => {
        if (params.personalHomeRuntime
          && (target.channel !== personalHomeRuntime.channel || target.mode !== personalHomeRuntime.mode)) {
          throw new Error('Personal Home task target does not match the configured runtime target.');
        }
        return await createLivePersonalHomeSystemTaskOperations(target);
      },
    );
  const personalHomeRelocationDestinationDeps = {
    loadRelocationDestination: params.loadPersonalHomeRelocationDestination
      ?? (async (target) => await createLivePersonalHomeRelocationDestinationOwner(target)),
  };
  const reconcilePersonalHomeRestore = createPersonalHomeRestoreContactReconciler({
    readStatus: readLiveRelayRuntimeSnapshot,
    operations: personalHomeOperations,
  });

  const runner = createSystemTasksRunner({
    kinds: {
      'system.ping.v1': {
        run: async (ctx) => {
          const paramDigest = digestParams(ctx.params);
          ctx.emit({
            type: 'progress',
            stepId: 'ping',
            message: 'ping acknowledged',
          });
          return {
            acknowledged: true,
            kind: 'system.ping.v1',
            paramDigest,
          };
        },
      },
      'system.noop.v1': {
        run: async (ctx) => {
          const parsed = parseNoopParams(ctx.params);
          ctx.emit({
            type: 'progress',
            stepId: 'noop',
            message: 'noop started',
          });
          await waitForDelay(parsed.delayMs ?? 0, ctx.signal);
          return {
            kind: 'system.noop.v1',
            status: 'completed',
          };
        },
      },
      'setup.thisComputer.v1': {
        run: async (ctx) => {
          const raw = ctx.params;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new SystemTaskExecutionError('invalid_setup_params', 'This-computer setup parameters are invalid.');
          }
          const setupParams = raw as Record<string, unknown>;
          ctx.emit({
            type: 'progress',
            stepId: 'setup.thisComputer.run',
            message: 'Setting up this computer',
          });
          if (params.setupThisComputer) return await params.setupThisComputer(setupParams);

          const activeRelayUrl = typeof setupParams.activeRelayUrl === 'string' ? setupParams.activeRelayUrl.trim() : '';
          const channel = typeof setupParams.channel === 'string' ? setupParams.channel.trim() : '';
          const setupArgs = [
            ...(activeRelayUrl ? ['--relay-url', activeRelayUrl] : []),
            ...(channel ? ['--channel', channel] : []),
            ...(setupParams.installService === false ? ['--skip-daemon'] : []),
            '--skip-providers',
          ];
          const { handleSetupCommand } = await import('@/cli/commands/setup');
          await handleSetupCommand(setupArgs);
          const status = await readLiveDaemonServiceStatusSnapshot({ target: { kind: 'local' } });
          if (!status.machineId) {
            throw new SystemTaskExecutionError('setup_machine_incomplete', 'This computer setup did not produce a registered machine.');
          }
          return { machineId: status.machineId };
        },
      },
      [DISCOVER_CONFIGURED_SSH_HOSTS_SYSTEM_TASK_KIND]: createDiscoverConfiguredSshHostsSystemTaskKind(),
      // Remote CLI update (plan R13 f): advertised by `tool.systemTasks` only when this machine can run it.
      [CLI_UPDATE_SYSTEM_TASK_KIND]: createCliUpdateRemoteTaskKind({
        readFacts: readCliUpdateFactsForThisCli,
        publicReleaseRing: configuration.publicReleaseRing,
        script: process.argv[1] ?? process.execPath,
        cwd: projectPath(),
        logsDir: configuration.logsDir,
      }),
      'remote.ssh.bootstrapMachine.v1': createLiveRemoteSshBootstrapTaskKind(),
      'remote.ssh.manageHost.v1': createLiveRemoteSshManageHostTaskKind(),
      'daemon.service.status.v1': createDaemonServiceStatusTaskKind({
        readStatus: readLiveDaemonServiceStatusSnapshot,
        startService: async (params) => await runLiveDaemonServiceLifecycleAction(params, 'start'),
        stopService: async (params) => await runLiveDaemonServiceLifecycleAction(params, 'stop'),
        restartService: async (params) => await runLiveDaemonServiceLifecycleAction(params, 'restart'),
      }),
      'daemon.service.start.v1': createDaemonServiceStartTaskKind({
        readStatus: readLiveDaemonServiceStatusSnapshot,
        startService: async (params) => await runLiveDaemonServiceLifecycleAction(params, 'start'),
        stopService: async (params) => await runLiveDaemonServiceLifecycleAction(params, 'stop'),
        restartService: async (params) => await runLiveDaemonServiceLifecycleAction(params, 'restart'),
      }),
      'daemon.service.stop.v1': createDaemonServiceStopTaskKind({
        readStatus: readLiveDaemonServiceStatusSnapshot,
        startService: async (params) => await runLiveDaemonServiceLifecycleAction(params, 'start'),
        stopService: async (params) => await runLiveDaemonServiceLifecycleAction(params, 'stop'),
        restartService: async (params) => await runLiveDaemonServiceLifecycleAction(params, 'restart'),
      }),
      'daemon.service.restart.v1': createDaemonServiceRestartTaskKind({
        readStatus: readLiveDaemonServiceStatusSnapshot,
        startService: async (params) => await runLiveDaemonServiceLifecycleAction(params, 'start'),
        stopService: async (params) => await runLiveDaemonServiceLifecycleAction(params, 'stop'),
        restartService: async (params) => await runLiveDaemonServiceLifecycleAction(params, 'restart'),
      }),
      [SSH_TUNNEL_SYSTEM_TASK_KINDS.ensure]: createDaemonSshTunnelEnsureTaskKind(),
      [SSH_TUNNEL_SYSTEM_TASK_KINDS.list]: createDaemonSshTunnelListTaskKind(),
      [SSH_TUNNEL_SYSTEM_TASK_KINDS.release]: createDaemonSshTunnelReleaseTaskKind(),
      [SSH_TUNNEL_SYSTEM_TASK_KINDS.stop]: createDaemonSshTunnelStopTaskKind(),
      'relay.runtime.installOrUpdate.v1': createRelayRuntimeInstallOrUpdateTaskKind({
        reconcilePersonalHomeRestore,
        installOrUpdate: async (params) => {
          return await installOrUpdateLiveRelayRuntime(requireLocalRelayRuntimeParams(params));
        },
      }),
      'relay.runtime.start.v1': createRelayRuntimeStartTaskKind({
        reconcilePersonalHomeRestore,
        control: async (params) => {
          const localParams = requireLocalRelayRuntimeParams(params);
          await startLiveRelayRuntime(localParams);
        },
        readStatus: readLiveRelayRuntimeSnapshot,
        checkHealth: checkLiveRelayRuntimeHealth,
      }),
      'relay.runtime.restart.v1': createRelayRuntimeRestartTaskKind({
        reconcilePersonalHomeRestore,
        control: async (params) => {
          await restartLiveRelayRuntime(requireLocalRelayRuntimeParams(params));
        },
        readStatus: readLiveRelayRuntimeSnapshot,
        checkHealth: checkLiveRelayRuntimeHealth,
      }),
      'relay.runtime.status.v1': createRelayRuntimeStatusTaskKind({
        reconcilePersonalHomeRestore,
        readStatus: readLiveRelayRuntimeSnapshot,
        checkHealth: checkLiveRelayRuntimeHealth,
      }),
      'relay.runtime.stop.v1': createRelayRuntimeStopTaskKind({
        reconcilePersonalHomeRestore,
        control: async (params) => {
          const localParams = requireLocalRelayRuntimeParams(params);
          await stopLiveRelayRuntime(localParams);
        },
      }),
      'relay.runtime.uninstall.v1': createRelayRuntimeUninstallTaskKind({
        reconcilePersonalHomeRestore,
        control: async (params) => {
          const localParams = requireLocalRelayRuntimeParams(params);
          await uninstallLiveRelayRuntime(localParams);
        },
      }),
      [PERSONAL_HOME_SYSTEM_TASK_KINDS.inspect]: createPersonalHomeInspectTaskKind({ operations: personalHomeOperations }),
      [PERSONAL_HOME_SYSTEM_TASK_KINDS.backup]: createPersonalHomeBackupTaskKind({ operations: personalHomeOperations }),
      [PERSONAL_HOME_SYSTEM_TASK_KINDS.verifyBackup]: createPersonalHomeVerifyBackupTaskKind({ operations: personalHomeOperations }),
      [PERSONAL_HOME_SYSTEM_TASK_KINDS.restore]: createPersonalHomeRestoreTaskKind({ operations: personalHomeOperations }),
      [PERSONAL_HOME_SYSTEM_TASK_KINDS.erase]: createPersonalHomeEraseTaskKind({ operations: personalHomeOperations }),
      [PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationStage]: createPersonalHomeRelocationDestinationStageTaskKind(personalHomeRelocationDestinationDeps),
      [PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationStatus]: createPersonalHomeRelocationDestinationStatusTaskKind(personalHomeRelocationDestinationDeps),
      [PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationCommit]: createPersonalHomeRelocationDestinationCommitTaskKind(personalHomeRelocationDestinationDeps),
      [PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationAbort]: createPersonalHomeRelocationDestinationAbortTaskKind(personalHomeRelocationDestinationDeps),
    },
  });

  return {
    startAdmitted: async (kind) => await runner.startAdmitted({ taskId: `system-task:${randomUUID()}`, kind: 'remote.ssh.bootstrapMachine.v1', params: {} }, kind),
    wait: runner.wait,
    start: async (params) => {
      const spec = SystemTaskSpecSchema.parse(params.spec ?? null);
      return await runner.start({
        taskId: `system-task:${randomUUID()}`,
        kind: spec.kind,
        params: spec.params,
      });
    },
    poll: async (params) => {
      return await runner.poll({
        taskId: String(params.taskId ?? '').trim(),
        cursor: typeof params.cursor === 'number' ? params.cursor : Number(params.cursor ?? 0),
      });
    },
    respond: async (params) => {
      await runner.respond({
        taskId: String(params.taskId ?? '').trim(),
        answer: params.answer,
      });
    },
    cancel: async (params) => {
      await runner.cancel({
        taskId: String(params.taskId ?? '').trim(),
      });
    },
  };

}
