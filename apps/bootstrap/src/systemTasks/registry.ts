import { createHash, randomUUID } from 'node:crypto';

import { relayAccess, systemTasks } from '@happier-dev/cli-common';
import { TailscaleCommandError } from '@happier-dev/cli-common/tailscale';
import { resolveHappyHomeDirFromEnvironment } from '@happier-dev/cli-common/agents';
import type { RelayAccessExecutionContext } from '@happier-dev/cli-common/relayAccess';
import { runOpenSshRemoteCommand, safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { SystemTaskJsonValueSchema, type SystemTaskJsonObject, type SystemTaskJsonValue } from '@happier-dev/protocol';

import { buildScpCommand, redactSshText } from '../ssh/index.js';

import { createSecureAccessTailscaleHandler } from './kinds/secureAccessTailscale.js';
import { createTailscaleEnsureReadyHandler } from './kinds/tailscaleEnsureReady.js';
import {
  createDaemonServiceAutostartSetHandler,
  createDaemonServiceRestartHandler,
  createDaemonServiceRelayDisconnectHandler,
  createDaemonServiceStartHandler,
  createDaemonServiceStatusHandler,
  createDaemonServiceStopHandler,
} from './kinds/daemonService.js';
import { createCliUpdateHandler } from './kinds/cliUpdate.js';
import {
  createCliPathExposureEnsureHandler,
  createCliPathExposureRemoveHandler,
} from './kinds/cliPathExposure.js';
import { resolveRemoteSshHostTrustDefault } from './remoteSshBootstrapTasks.js';
import {
  createRemoteSshPersonalHomeRelocationDestinationDefault,
  installRemoteCliForManageHostDefault,
  runRemoteDaemonServiceCommandDefault,
  runRemotePersonalHomeCommandDefault,
  runRemoteRelayRuntimeCommandDefault,
  testRemoteSshConnectionDefault,
} from './remoteSshManageHostTasks.js';
import {
  checkRelayRuntimeHealthDefault,
  controlRelayRuntimeDefault,
  createBootstrapPersonalHomeSystemTaskOperations,
  createBootstrapPersonalHomeOperations,
  createBootstrapPersonalHomeRelocationDestinationOwner,
  installOrUpdateRelayRuntimeDefault,
  readRelayRuntimeStatusDefault,
} from './relayRuntimeTasks.js';
import { createRelayAccessConfigStore } from './relayAccessConfigStore.js';
import { runCommandCapture } from './taskRuntime.js';

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

function shellQuote(value: string): string {
  const raw = String(value ?? '');
  if (!raw) return "''";
  return `'${raw.replaceAll("'", `'\"'\"'`)}'`;
}

type SystemTaskRegistry = ReturnType<typeof systemTasks.createSystemTaskRegistry>;

type HsetupRegistryDeps = Readonly<{
  relayRuntime?: Partial<RelayRuntimeDeps>;
  personalHomeOperations?: systemTasks.PersonalHomeSystemTaskOperations;
  loadPersonalHomeRelocationDestination?: systemTasks.PersonalHomeTaskKindDeps['loadRelocationDestination'];
  remoteSshBootstrap?: Partial<RemoteSshBootstrapDeps>;
  remoteSshManageHost?: Partial<systemTasks.RemoteSshManageHostDeps>;
  relayAccess?: Partial<RelayAccessDeps>;
}>;

type RelayRuntimeDeps = Readonly<{
  readStatus: (params: systemTasks.RelayRuntimeTaskParams) => Promise<systemTasks.RelayRuntimeStatusSnapshot>;
  checkHealth: (params: Readonly<{ baseUrl: string }>) => Promise<boolean>;
  installOrUpdate: (params: systemTasks.RelayRuntimeTaskParams) => Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>>;
  control: (params: systemTasks.RelayRuntimeTaskParams & Readonly<{ action: 'start' | 'stop' | 'restart' | 'uninstall' }>) => Promise<void>;
}>;

type RemoteSshBootstrapDeps = systemTasks.RemoteSshBootstrapMachineDeps;

type RelayAccessDeps = Readonly<{
  readConfig: (params: Readonly<{ target: systemTasks.RelayAccessTaskTarget }>) => Promise<relayAccess.RelayAccessConfig | null>;
  writeConfig: (params: Readonly<{ target: systemTasks.RelayAccessTaskTarget; config: relayAccess.RelayAccessConfig | null }>) => Promise<void>;
  getProvider: (provider: relayAccess.RelayAccessConfig['provider']) => relayAccess.RelayAccessProvider;
  createExecutionContext: (params: Readonly<{ target: systemTasks.RelayAccessTaskTarget; upstreamUrl: string | null }>) => relayAccess.RelayAccessExecutionContext;
}>;

export function createHsetupSystemTaskRegistry(deps: HsetupRegistryDeps = {}): SystemTaskRegistry {
  const relayRuntimeDeps = createRelayRuntimeDeps(deps.relayRuntime);
  const relayAccessDeps = createRelayAccessDeps(deps.relayAccess);
  const personalHomeOperations = deps.personalHomeOperations
    ?? systemTasks.createDeferredPersonalHomeSystemTaskOperations(
      async (target) => await createBootstrapPersonalHomeSystemTaskOperations(target),
    );
  const relayRuntimeDepsWithRestoreContact = {
    ...relayRuntimeDeps,
    reconcilePersonalHomeRestore: systemTasks.createPersonalHomeRestoreContactReconciler({
      readStatus: relayRuntimeDeps.readStatus,
      operations: personalHomeOperations,
    }),
  };
  const relayRuntimeStatusHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayRuntimeStatusTaskKind(relayRuntimeDepsWithRestoreContact),
  );
  const relayRuntimeInstallHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayRuntimeInstallOrUpdateTaskKind(relayRuntimeDepsWithRestoreContact),
  );
  const relayRuntimeStartHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayRuntimeStartTaskKind(relayRuntimeDepsWithRestoreContact),
  );
  const relayRuntimeRestartHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayRuntimeRestartTaskKind(relayRuntimeDepsWithRestoreContact),
  );
  const relayRuntimeStopHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayRuntimeStopTaskKind(relayRuntimeDepsWithRestoreContact),
  );
  const relayRuntimeUninstallHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayRuntimeUninstallTaskKind(relayRuntimeDepsWithRestoreContact),
  );
  const personalHomeTaskDeps = {
    operations: personalHomeOperations,
    loadRelocationDestination: deps.loadPersonalHomeRelocationDestination
      ?? (async (target) => await createBootstrapPersonalHomeRelocationDestinationOwner(target)),
  };
  const personalHomeInspectHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createPersonalHomeInspectTaskKind(personalHomeTaskDeps),
  );
  const personalHomeBackupHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createPersonalHomeBackupTaskKind(personalHomeTaskDeps),
  );
  const personalHomeVerifyBackupHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createPersonalHomeVerifyBackupTaskKind(personalHomeTaskDeps),
  );
  const personalHomeRestoreHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createPersonalHomeRestoreTaskKind(personalHomeTaskDeps),
  );
  const personalHomeEraseHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createPersonalHomeEraseTaskKind(personalHomeTaskDeps),
  );
  const personalHomeRelocationDestinationStageHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createPersonalHomeRelocationDestinationStageTaskKind(personalHomeTaskDeps),
  );
  const personalHomeRelocationDestinationStatusHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createPersonalHomeRelocationDestinationStatusTaskKind(personalHomeTaskDeps),
  );
  const personalHomeRelocationDestinationCommitHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createPersonalHomeRelocationDestinationCommitTaskKind(personalHomeTaskDeps),
  );
  const personalHomeRelocationDestinationAbortHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createPersonalHomeRelocationDestinationAbortTaskKind(personalHomeTaskDeps),
  );
  // Decision A(a): only the desktop hosting the Home (hsetup) offers the in-app owner claim.
  const personalHomeClaimOwnerHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createPersonalHomeClaimOwnerTaskKind(personalHomeTaskDeps),
  );
  const relayAccessStatusHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayAccessStatusTaskKind({
      readConfig: relayAccessDeps.readConfig,
      getProvider: relayAccessDeps.getProvider,
      createExecutionContext: relayAccessDeps.createExecutionContext,
    }),
  );
  const relayAccessConfigureHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayAccessConfigureTaskKind({
      writeConfig: async (params) => {
        await relayAccessDeps.writeConfig({
          target: params.target,
          config: params.config,
        });
      },
      getProvider: relayAccessDeps.getProvider,
      createExecutionContext: relayAccessDeps.createExecutionContext,
    }),
  );
  const relayAccessDisableHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRelayAccessDisableTaskKind({
      readConfig: relayAccessDeps.readConfig,
      writeConfig: relayAccessDeps.writeConfig,
      getProvider: relayAccessDeps.getProvider,
      createExecutionContext: relayAccessDeps.createExecutionContext,
    }),
  );
  const remoteManageHostHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRemoteSshManageHostTaskKind(createRemoteSshManageHostDeps(deps.remoteSshBootstrap, deps.remoteSshManageHost)),
  );
  const daemonServiceStatusHandler = createDaemonServiceStatusHandler();
  const daemonServiceStartHandler = createDaemonServiceStartHandler();
  const daemonServiceStopHandler = createDaemonServiceStopHandler();
  const daemonServiceRestartHandler = createDaemonServiceRestartHandler();
  const daemonServiceRelayDisconnectHandler = createDaemonServiceRelayDisconnectHandler();

  return systemTasks.createSystemTaskRegistry([
    { kind: 'daemon.service.autostart.set.v1', handler: createDaemonServiceAutostartSetHandler() },
    {
      kind: 'daemon.service.status.v1',
      handler: daemonServiceStatusHandler,
    },
    {
      kind: 'daemon.service.start.v1',
      handler: daemonServiceStartHandler,
    },
    {
      kind: 'daemon.service.stop.v1',
      handler: daemonServiceStopHandler,
    },
    {
      kind: 'daemon.service.restart.v1',
      handler: daemonServiceRestartHandler,
    },
    {
      kind: 'daemon.service.relay.disconnect.v1',
      handler: daemonServiceRelayDisconnectHandler,
    },
    {
      kind: 'cli.update.v1',
      handler: createCliUpdateHandler(),
    },
    {
      kind: 'cli.pathExposure.ensure.v1',
      handler: createCliPathExposureEnsureHandler(),
    },
    {
      kind: 'cli.pathExposure.remove.v1',
      handler: createCliPathExposureRemoveHandler(),
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
      kind: 'relay.runtime.restart.v1',
      handler: relayRuntimeRestartHandler,
    },
    {
      kind: 'relay.runtime.stop.v1',
      handler: relayRuntimeStopHandler,
    },
    {
      kind: 'relay.runtime.uninstall.v1',
      handler: relayRuntimeUninstallHandler,
    },
    { kind: systemTasks.PERSONAL_HOME_SYSTEM_TASK_KINDS.inspect, handler: personalHomeInspectHandler },
    { kind: systemTasks.PERSONAL_HOME_SYSTEM_TASK_KINDS.backup, handler: personalHomeBackupHandler },
    { kind: systemTasks.PERSONAL_HOME_SYSTEM_TASK_KINDS.verifyBackup, handler: personalHomeVerifyBackupHandler },
    { kind: systemTasks.PERSONAL_HOME_SYSTEM_TASK_KINDS.restore, handler: personalHomeRestoreHandler },
    { kind: systemTasks.PERSONAL_HOME_SYSTEM_TASK_KINDS.erase, handler: personalHomeEraseHandler },
    { kind: systemTasks.PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationStage, handler: personalHomeRelocationDestinationStageHandler },
    { kind: systemTasks.PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationStatus, handler: personalHomeRelocationDestinationStatusHandler },
    { kind: systemTasks.PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationCommit, handler: personalHomeRelocationDestinationCommitHandler },
    { kind: systemTasks.PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationAbort, handler: personalHomeRelocationDestinationAbortHandler },
    { kind: systemTasks.PERSONAL_HOME_SYSTEM_TASK_KINDS.claimOwner, handler: personalHomeClaimOwnerHandler },
    {
      kind: 'relay.access.status.v1',
      handler: relayAccessStatusHandler,
    },
    {
      kind: 'relay.access.configure.v1',
      handler: relayAccessConfigureHandler,
    },
    {
      kind: 'relay.access.disable.v1',
      handler: relayAccessDisableHandler,
    },
    {
      kind: 'secureAccess.tailscale.v1',
      handler: createSecureAccessTailscaleHandler({
        relayAccess: relayAccessDeps,
      }),
    },
    {
      kind: 'tailscale.ensureReady.v1',
      handler: createTailscaleEnsureReadyHandler(),
    },
    {
      kind: 'remote.ssh.manageHost.v1',
      handler: remoteManageHostHandler,
    },
  ]);
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

function createRemoteSshManageHostDeps(
  bootstrapOverrides: HsetupRegistryDeps['remoteSshBootstrap'],
  overrides: HsetupRegistryDeps['remoteSshManageHost'],
): systemTasks.RemoteSshManageHostDeps {
  const runRelayRuntimeCommand = overrides?.runRelayRuntimeCommand ?? runRemoteRelayRuntimeCommandDefault;
  return {
    resolveHostTrust: overrides?.resolveHostTrust ?? bootstrapOverrides?.resolveHostTrust ?? resolveRemoteSshHostTrustDefault,
    testConnection: overrides?.testConnection ?? testRemoteSshConnectionDefault,
    installRemoteCli: overrides?.installRemoteCli ?? installRemoteCliForManageHostDefault,
    runDaemonServiceCommand: overrides?.runDaemonServiceCommand ?? runRemoteDaemonServiceCommandDefault,
    runRelayRuntimeCommand,
    runPersonalHomeCommand: overrides?.runPersonalHomeCommand ?? runRemotePersonalHomeCommandDefault,
    runPersonalHomeRelocation: overrides?.runPersonalHomeRelocation ?? (async (params) => {
      const source = await createBootstrapPersonalHomeOperations({
        channel: params.channel,
        mode: params.mode,
      });
      const destination = createRemoteSshPersonalHomeRelocationDestinationDefault({
        ssh: params.ssh,
        auth: params.auth,
        knownHostsMode: params.knownHostsMode,
        channel: params.channel,
        mode: params.mode,
        ensureRuntime: async (purpose, signal) => {
          await runRelayRuntimeCommand({
            ssh: params.ssh,
            auth: params.auth,
            knownHostsMode: params.knownHostsMode,
            action: 'installOrUpdate',
            channel: params.channel,
            mode: params.mode,
            purpose,
            ...(signal ? { signal } : {}),
          });
        },
      });
      const result = SystemTaskJsonValueSchema.parse(await source.relocate({
        operationId: params.operationId,
        sourceDescriptorRevision: params.sourceDescriptorRevision,
        ...(params.recoveryAction ? { recoveryAction: params.recoveryAction } : {}),
        destinationMachineId: params.destinationMachineId,
        destination,
        publishDestination: params.publishDestination,
        readPublishedDescriptor: params.readPublishedDescriptor,
        ...(params.signal ? { signal: params.signal } : {}),
        progress: params.progress,
      }));
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Personal Home relocation returned invalid result facts.');
      }
      return result as SystemTaskJsonObject;
    }),
  };
}

function createRelayAccessDeps(overrides?: Partial<RelayAccessDeps>): RelayAccessDeps {
  const store = createRelayAccessConfigStore({
    resolveHappyHomeDir: () => resolveHappyHomeDirFromEnvironment(process.env),
    ssh: {
      runRemoteText: async ({ ssh, remoteCommand }) => {
        return await runOpenSshRemoteCommand({
          target: ssh.target,
          port: ssh.port,
          sshConfigFile: ssh.sshConfigFile,
          auth: ssh.auth === 'keyfile'
            ? { mode: 'keyFile', privateKeyPath: String(ssh.identityFile ?? '') }
            : ssh.auth === 'password'
              ? { mode: 'password', password: String(ssh.password ?? '') }
              : { mode: 'agent' },
          knownHostsMode: ssh.knownHostsPath ? 'app' : 'system',
          knownHostsPath: ssh.knownHostsPath,
          remoteCommand: ['bash', '-lc', safeBashSingleQuote(remoteCommand)],
          rejectOnNonZero: false,
          errorPrefix: `Relay access SSH command failed for ${ssh.target}`,
        });
      },
      copyLocalFileToRemote: async ({ ssh, localPath, remotePath }) => {
        const invocation = buildScpCommand({
          target: ssh.target,
          port: ssh.port,
          auth: {
            kind: ssh.auth,
            identityFile: ssh.identityFile,
            ...(ssh.auth === 'password' ? { password: ssh.password } : {}),
          },
          knownHosts: ssh.knownHostsPath ? { mode: 'app', path: ssh.knownHostsPath } : { mode: 'system' },
          localPath,
          remotePath,
        });
        const result = await runCommandCapture({
          command: invocation.command,
          args: invocation.args,
          ...(invocation.env ? { env: invocation.env } : {}),
        });
        if (result.status !== 0) {
          throw new Error(redactSshText(result.stderr || result.stdout || `SCP command failed for ${ssh.target}.`));
        }
      },
    },
  });

  const readConfig = overrides?.readConfig ?? store.readConfig;
  const writeConfig = overrides?.writeConfig ?? store.writeConfig;

  const getProvider = overrides?.getProvider ?? ((providerId) => relayAccess.getRelayAccessProvider(providerId));
  const createExecutionContext = overrides?.createExecutionContext ?? ((params) => {
    type RunCommand = NonNullable<RelayAccessExecutionContext['runCommand']>;
    type RunCommandParams = Parameters<RunCommand>[0];
    type RunCommandResult = Awaited<ReturnType<RunCommand>>;

    const base = {
      env: process.env,
      upstreamUrl: params.upstreamUrl,
    };

    if (params.target.kind === 'ssh') {
      const ssh = params.target.ssh;
      return {
        ...base,
        resolveCommandOnPath: (command: string) => command,
        runCommand: async ({ command, args, env, timeoutMs }: RunCommandParams): Promise<RunCommandResult> => {
          const remoteCommand = [command, ...args].map(shellQuote).join(' ');
          const result = await runOpenSshRemoteCommand({
              target: ssh.target,
              port: ssh.port,
              sshConfigFile: ssh.sshConfigFile,
              auth: ssh.auth === 'keyfile'
                ? { mode: 'keyFile', privateKeyPath: String(ssh.identityFile ?? '') }
                : ssh.auth === 'password'
                  ? { mode: 'password', password: String(ssh.password ?? '') }
                  : { mode: 'agent' },
              knownHostsMode: ssh.knownHostsPath ? 'app' : 'system',
              knownHostsPath: ssh.knownHostsPath,
              remoteCommand: ['bash', '-lc', safeBashSingleQuote(remoteCommand)],
              timeoutMs,
              rejectOnNonZero: false,
              errorPrefix: `Relay access SSH command failed for ${ssh.target}`,
          });
          const structured = {
            command,
            args,
            exitCode: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
          };
          if (structured.exitCode !== 0) {
            throw new TailscaleCommandError(`Remote command failed: ${command}`, structured);
          }
          return structured;
        },
      };
    }

    return {
      ...base,
      runCommand: async ({ command, args, env, timeoutMs }: RunCommandParams): Promise<RunCommandResult> => {
        const result = await runCommandCapture({
          command,
          args,
          ...(env ? { env } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        });
        const structured = {
          command,
          args,
          exitCode: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
        };
        if (structured.exitCode !== 0) {
          throw new TailscaleCommandError(`Command failed: ${command}`, structured);
        }
        return structured;
      },
    };
  });

  return {
    readConfig,
    writeConfig,
    getProvider,
    createExecutionContext,
  };
}
