import { createHash, randomUUID } from 'node:crypto';

import { systemTasks } from '@happier-dev/cli-common';
import type { SystemTaskJsonObject, SystemTaskJsonValue } from '@happier-dev/protocol';

import { runLocalHappierJsonCommand } from './happierCli.js';
import { createSecureAccessTailscaleHandler } from './kinds/secureAccessTailscale.js';
import { createDaemonServiceStartHandler, createDaemonServiceStatusHandler } from './kinds/daemonService.js';
import { createSetupThisComputerHandler } from './kinds/setupThisComputer.js';
import {
  type AuthStatusSnapshot,
  configureRelay,
  installService,
  pairLocalMachineIfNeeded,
  readAuthStatus,
  readDaemonStatus,
  startService,
  waitForReadyDaemon,
} from './localDaemonCli.js';
import { approveLocalRemoteAuthRequestDefault, installRemoteCliDefault, resolveRemoteSshHostTrustDefault, runRemoteBootstrapCommandDefault } from './remoteSshBootstrapTasks.js';
import { checkRelayRuntimeHealthDefault, controlRelayRuntimeDefault, installOrUpdateRelayRuntimeDefault, readRelayRuntimeStatusDefault } from './relayRuntimeTasks.js';

function stableStringify(value: SystemTaskJsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const objectValue = value as SystemTaskJsonObject;
  const keys = Object.keys(objectValue).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`).join(',')}}`;
}

function digestParams(params: SystemTaskJsonValue): string {
  return createHash('sha256').update(stableStringify(params)).digest('hex');
}

type SystemTaskRegistry = ReturnType<typeof systemTasks.createSystemTaskRegistry>;

type HsetupRegistryDeps = Readonly<{
  relayRuntime?: Partial<RelayRuntimeDeps>;
  remoteSshBootstrap?: Partial<RemoteSshBootstrapDeps>;
  relayDriftRepair?: Partial<RelayDriftRepairDeps>;
}>;

type RelayRuntimeDeps = Readonly<{
  readStatus: (params: systemTasks.RelayRuntimeTaskParams) => Promise<systemTasks.RelayRuntimeStatusSnapshot>;
  checkHealth: (params: Readonly<{ baseUrl: string }>) => Promise<boolean>;
  installOrUpdate: (params: systemTasks.RelayRuntimeTaskParams) => Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>>;
  control: (params: systemTasks.RelayRuntimeTaskParams & Readonly<{ action: 'start' | 'stop' | 'restart' }>) => Promise<void>;
}>;

type RemoteSshBootstrapDeps = systemTasks.RemoteSshBootstrapMachineDeps;

type RelayDriftRepairDeps = Readonly<{
  connectBackgroundService: (params: Readonly<{
    activeRelayUrl: string;
    activeWebappUrl: string;
    activeLocalRelayUrl: string | null;
    surface?: string;
  }>, context: Readonly<{
    signal: AbortSignal;
    emitProgress: (stepId: string, message?: string) => void;
  }>) => Promise<SystemTaskJsonObject>;
}>;

export function createHsetupSystemTaskRegistry(deps: HsetupRegistryDeps = {}): SystemTaskRegistry {
  const relayRuntimeDeps = createRelayRuntimeDeps(deps.relayRuntime);
  const remoteBootstrapDeps = createRemoteSshBootstrapDeps(deps.remoteSshBootstrap);
  const relayDriftRepairDeps = createRelayDriftRepairDeps(deps.relayDriftRepair);
  const relayRuntimeStatusHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayRuntimeStatusTaskKind(relayRuntimeDeps),
  );
  const relayRuntimeInstallHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayRuntimeInstallOrUpdateTaskKind(relayRuntimeDeps),
  );
  const relayRuntimeStartHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayRuntimeStartTaskKind(relayRuntimeDeps),
  );
  const relayRuntimeStopHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayRuntimeStopTaskKind(relayRuntimeDeps),
  );
  const remoteBootstrapHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRemoteSshBootstrapMachineTaskKind(remoteBootstrapDeps),
  );
  const daemonServiceStatusHandler = createDaemonServiceStatusHandler();
  const daemonServiceStartHandler = createDaemonServiceStartHandler();

  return systemTasks.createSystemTaskRegistry([
    {
      kind: 'daemon.service.status.v1',
      handler: daemonServiceStatusHandler,
    },
    {
      kind: 'daemon.service.start.v1',
      handler: daemonServiceStartHandler,
    },
    {
      kind: 'system.noop.v1',
      handler: async function* (params, context) {
        const parsed = parseNoopParams(params);

        yield {
          type: 'progress',
          stepId: 'noop',
          message: 'noop started',
        };

        await waitForDelay(parsed.delayMs ?? 0, context.signal);

        return {
          kind: 'system.noop.v1',
          status: 'completed',
        };
      },
    },
    {
      kind: 'system.ping.v1',
      handler: async function* (params) {
        const parsedParams = params as SystemTaskJsonValue;
        const paramDigest = digestParams(parsedParams);

        yield {
          type: 'progress',
          stepId: 'ping',
          message: 'ping acknowledged',
          data: {
            kind: 'system.ping.v1',
            paramDigest,
          },
        };

        return {
          acknowledged: true,
          kind: 'system.ping.v1',
          paramDigest,
        };
      },
    },
    {
      kind: 'setup.thisComputer.v1',
      handler: createSetupThisComputerHandler(),
    },
    {
      kind: 'relay.connectBackgroundService.v1',
      handler: async function* (params, context) {
        const parsed = parseRelayConnectBackgroundServiceParams(params);

        yield {
          type: 'progress',
          stepId: 'relay.drift.repair.start',
          message: 'Connecting background service to the selected relay',
        };

        const progressEvents: Array<Readonly<{ type: 'progress'; stepId: string; message?: string }>> = [];
        const result = await relayDriftRepairDeps.connectBackgroundService(parsed, {
          signal: context.signal,
          emitProgress(stepId, message) {
            progressEvents.push({ type: 'progress', stepId, ...(message ? { message } : {}) });
          },
        });

        for (const event of progressEvents) {
          yield event;
        }

        return result;
      },
    },
    {
      kind: 'relay.runtime.status.v1',
      handler: relayRuntimeStatusHandler,
    },
    {
      kind: 'relay.runtime.installOrUpdate.v1',
      handler: relayRuntimeInstallHandler,
    },
    {
      kind: 'relay.runtime.start.v1',
      handler: relayRuntimeStartHandler,
    },
    {
      kind: 'relay.runtime.stop.v1',
      handler: relayRuntimeStopHandler,
    },
    {
      kind: 'secureAccess.tailscale.v1',
      handler: createSecureAccessTailscaleHandler(),
    },
    {
      kind: 'remote.ssh.bootstrapMachine.v1',
      handler: remoteBootstrapHandler,
    },
  ]);
}
function createRelayDriftRepairDeps(override?: Partial<RelayDriftRepairDeps>): RelayDriftRepairDeps {
  return {
    async connectBackgroundService(params, context) {
      context.emitProgress('relay.connectBackgroundService.prepare');
      context.emitProgress('relay.connectBackgroundService.configureRelay');
      await configureRelay({
        serverUrl: params.activeRelayUrl,
        localServerUrl: params.activeLocalRelayUrl,
        webappUrl: params.activeWebappUrl,
      });

      const authStatus = await readAuthStatus();
      if (!authStatus.authenticated) {
        throw new systemTasks.SystemTaskExecutionError(
          'not_authenticated',
          'Authenticate this computer with the selected Relay before continuing.',
        );
      }

      const machineId = await repairRelayDriftAuthIfNeeded(authStatus, context.emitProgress);

      context.emitProgress('relay.connectBackgroundService.finish');
      await installService();
      await startService();
      const daemonStatus = await waitForReadyDaemon({
        readDaemonStatus,
        signal: context.signal,
      });
      if (!daemonStatus.serviceInstalled || !daemonStatus.daemonRunning || daemonStatus.needsAuth) {
        throw new systemTasks.SystemTaskExecutionError(
          'daemon_service_not_ready',
          'Daemon service did not reach a ready state for the selected Relay.',
        );
      }

      return {
        repaired: true,
        activeRelayUrl: params.activeRelayUrl,
        activeWebappUrl: params.activeWebappUrl,
        activeLocalRelayUrl: params.activeLocalRelayUrl,
        ...(machineId ?? daemonStatus.machineId ? { machineId: machineId ?? daemonStatus.machineId } : {}),
      };
    },
    ...override,
  };
}

async function repairRelayDriftAuthIfNeeded(
  authStatus: AuthStatusSnapshot,
  emitProgress: (stepId: string, message?: string) => void,
): Promise<string | null> {
  if (authStatus.machineId) {
    return authStatus.machineId;
  }
  emitProgress('relay.connectBackgroundService.authenticate');
  return await pairLocalMachineIfNeeded(authStatus);
}

function parseRelayConnectBackgroundServiceParams(params: unknown): Readonly<{
  activeRelayUrl: string;
  activeWebappUrl: string;
  activeLocalRelayUrl: string | null;
  surface?: string;
}> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_params',
      'Expected relay drift repair params to be an object.',
    );
  }
  const record = params as Record<string, unknown>;
  const activeRelayUrl = String(record.activeRelayUrl ?? '').trim();
  const activeWebappUrl = String(record.activeWebappUrl ?? '').trim();
  const activeLocalRelayUrlRaw = record.activeLocalRelayUrl;
  const surface = typeof record.surface === 'string' && record.surface.trim()
    ? record.surface.trim()
    : undefined;

  if (!activeRelayUrl) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'activeRelayUrl is required.');
  }
  if (!activeWebappUrl) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'activeWebappUrl is required.');
  }
  const activeLocalRelayUrl = activeLocalRelayUrlRaw === null || activeLocalRelayUrlRaw === undefined
    ? null
    : String(activeLocalRelayUrlRaw ?? '').trim() || null;

  return {
    activeRelayUrl,
    activeWebappUrl,
    activeLocalRelayUrl,
    surface,
  };
}

export function createSystemTaskId(): string {
  return `system_task_${randomUUID()}`;
}

async function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  if (signal.aborted) {
    throw new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const onAbort = () => {
      cleanup();
      reject(new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.'));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseNoopParams(params: unknown): Readonly<{
  delayMs?: number;
  source?: string;
}> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Noop params must be an object.');
  }

  const paramRecord = params as Record<string, unknown>;
  const delayMs = paramRecord.delayMs;
  const source = paramRecord.source;
  const allowedKeys = new Set(['delayMs', 'source']);
  for (const key of Object.keys(paramRecord)) {
    if (!allowedKeys.has(key)) {
      throw new systemTasks.SystemTaskExecutionError('invalid_params', `Unknown noop param: ${key}`);
    }
  }

  if (delayMs !== undefined) {
    if (typeof delayMs !== 'number' || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
      throw new systemTasks.SystemTaskExecutionError('invalid_params', 'delayMs must be an integer between 0 and 60000.');
    }
  }

  if (source !== undefined) {
    if (typeof source !== 'string' || source.trim().length === 0) {
      throw new systemTasks.SystemTaskExecutionError('invalid_params', 'source must be a non-empty string.');
    }
  }

  return {
    ...(typeof delayMs === 'number' ? { delayMs } : {}),
    ...(source === undefined ? {} : { source }),
  };
}

function createRelayRuntimeDeps(overrides: HsetupRegistryDeps['relayRuntime']): RelayRuntimeDeps {
  return {
    readStatus: overrides?.readStatus ?? readRelayRuntimeStatusDefault,
    checkHealth: overrides?.checkHealth ?? checkRelayRuntimeHealthDefault,
    installOrUpdate: overrides?.installOrUpdate ?? installOrUpdateRelayRuntimeDefault,
    control: overrides?.control ?? controlRelayRuntimeDefault,
  };
}

function createRemoteSshBootstrapDeps(overrides: HsetupRegistryDeps['remoteSshBootstrap']): RemoteSshBootstrapDeps {
  return {
    resolveHostTrust: overrides?.resolveHostTrust ?? resolveRemoteSshHostTrustDefault,
    installRemoteCli: overrides?.installRemoteCli ?? installRemoteCliDefault,
    approveLocalAuthRequest: overrides?.approveLocalAuthRequest ?? approveLocalRemoteAuthRequestDefault,
    runRemoteCommand: overrides?.runRemoteCommand ?? runRemoteBootstrapCommandDefault,
  };
}
