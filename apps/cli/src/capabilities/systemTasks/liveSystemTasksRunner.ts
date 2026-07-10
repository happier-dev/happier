import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  SSH_TUNNEL_SYSTEM_TASK_KINDS,
  SystemTaskSpecSchema,
} from '@happier-dev/protocol';
import {
  createDaemonServiceRestartTaskKind,
  createDaemonServiceStartTaskKind,
  createDaemonServiceStatusTaskKind,
  createDaemonServiceStopTaskKind,
  createRelayRuntimeInstallOrUpdateTaskKind,
  createRelayRuntimeStartTaskKind,
  createRelayRuntimeStatusTaskKind,
  createRelayRuntimeStopTaskKind,
  SystemTaskExecutionError,
  type DaemonServiceStatusSnapshot,
  type DaemonServiceTaskParams,
  type RelayRuntimeStatusSnapshot,
  type RelayRuntimeTaskParams,
} from '@happier-dev/cli-common/systemTasks';
import {
  installOrUpdateLiveRelayRuntime,
  readLiveRelayRuntimeStatus,
  startLiveRelayRuntime,
  stopLiveRelayRuntime,
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
import { createLiveRemoteSshBootstrapTaskKind } from './ssh/liveRemoteSshBootstrap';
import { createSystemTasksRunner } from './systemTasksRunner';
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

function requireLocalRelayRuntimeParams(params: RelayRuntimeTaskParams): Readonly<{
  mode?: 'user' | 'system';
  channel?: 'stable' | 'preview' | 'dev';
}> {
  if (params.target.kind !== 'local') {
    throw new Error('Live relay runtime tasks only support local targets');
  }
  return {
    mode: params.mode,
    channel: params.channel,
  };
}

function deriveBaseUrl(status: Awaited<ReturnType<typeof readLiveRelayRuntimeStatus>>): string {
  try {
    const url = new URL(status.health.url);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'http://127.0.0.1:3005';
  }
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
  const localParams = requireLocalRelayRuntimeParams(params);
  const status = await readLiveRelayRuntimeStatus(localParams);
  return {
    installed: status.installed,
    version: status.version,
    service: {
      active: status.service.active,
      enabled: status.service.enabled,
    },
    baseUrl: deriveBaseUrl(status),
    healthy: status.health.reachable,
  };
}

type SystemTasksRunnerAdapter = Readonly<{
  start: (params: Record<string, unknown>) => Promise<unknown>;
  poll: (params: Record<string, unknown>) => Promise<unknown>;
  respond: (params: Record<string, unknown>) => Promise<void>;
}>;

let liveRunnerAdapter: SystemTasksRunnerAdapter | null = null;

export function getLiveSystemTasksRunnerAdapter(): SystemTasksRunnerAdapter {
  if (liveRunnerAdapter) {
    return liveRunnerAdapter;
  }

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
      [DISCOVER_CONFIGURED_SSH_HOSTS_SYSTEM_TASK_KIND]: createDiscoverConfiguredSshHostsSystemTaskKind(),
      'remote.ssh.bootstrapMachine.v1': createLiveRemoteSshBootstrapTaskKind(),
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
        installOrUpdate: async (params) => {
          const localParams = requireLocalRelayRuntimeParams(params);
          await installOrUpdateLiveRelayRuntime(localParams);
          const status = await readLiveRelayRuntimeSnapshot(params);
          return {
            relayUrl: status.baseUrl,
            mode: params.mode === 'system' ? 'system' : 'user',
          };
        },
      }),
      'relay.runtime.start.v1': createRelayRuntimeStartTaskKind({
        control: async (params) => {
          const localParams = requireLocalRelayRuntimeParams(params);
          await startLiveRelayRuntime(localParams);
        },
        readStatus: readLiveRelayRuntimeSnapshot,
        checkHealth: async ({ baseUrl }) => {
          const snapshot = await readLiveRelayRuntimeSnapshot({
            target: { kind: 'local' },
            mode: 'user',
            channel: 'stable',
          });
          return snapshot.baseUrl === baseUrl && snapshot.healthy === true;
        },
      }),
      'relay.runtime.status.v1': createRelayRuntimeStatusTaskKind({
        readStatus: readLiveRelayRuntimeSnapshot,
        checkHealth: async ({ baseUrl }) => {
          const snapshot = await readLiveRelayRuntimeSnapshot({
            target: { kind: 'local' },
            mode: 'user',
            channel: 'stable',
          });
          return snapshot.baseUrl === baseUrl && snapshot.healthy === true;
        },
      }),
      'relay.runtime.stop.v1': createRelayRuntimeStopTaskKind({
        control: async (params) => {
          const localParams = requireLocalRelayRuntimeParams(params);
          await stopLiveRelayRuntime(localParams);
        },
      }),
    },
  });

  liveRunnerAdapter = {
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
  };

  return liveRunnerAdapter;
}
