import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { relayAccess, systemTasks } from '@happier-dev/cli-common';
import { parseSetupRepairThisComputerParams } from '@happier-dev/cli-common/systemTasks';
import { TailscaleCommandError } from '@happier-dev/cli-common/tailscale';
import { resolveHappyHomeDirFromEnvironment } from '@happier-dev/cli-common/agents';
import type { RelayAccessExecutionContext } from '@happier-dev/cli-common/relayAccess';
import type { SystemTaskJsonObject, SystemTaskJsonValue } from '@happier-dev/protocol';

import { buildScpCommand, buildSshCommand, redactSshText } from '../ssh/index.js';

import { runLocalHappierJsonCommand } from './happierCli.js';
import { createSecureAccessTailscaleHandler } from './kinds/secureAccessTailscale.js';
import { createTailscaleEnsureReadyHandler } from './kinds/tailscaleEnsureReady.js';
import {
  createDaemonServiceRestartHandler,
  createDaemonServiceStartHandler,
  createDaemonServiceStatusHandler,
  createDaemonServiceStopHandler,
} from './kinds/daemonService.js';
import {
  createSetupThisComputerInteractiveTaskKind,
  type SetupThisComputerInteractiveDeps,
} from './kinds/setupThisComputerInteractiveKind.js';
import {
  type AuthStatusSnapshot,
  configureRelay,
  installService,
  pairLocalMachineIfNeeded,
  readActiveRelayProfile,
  readAuthStatus,
  readDaemonStatus,
  requestAuthPairing,
  startService,
  waitForAuthPairing,
  waitForReadyDaemon,
} from './localDaemonCli.js';
import { approveLocalRemoteAuthRequestDefault, installRemoteCliDefault, resolveRemoteSshHostTrustDefault, runRemoteBootstrapCommandDefault } from './remoteSshBootstrapTasks.js';
import { installRemoteCliForManageHostDefault, runRemoteDaemonServiceCommandDefault, runRemoteRelayRuntimeCommandDefault, testRemoteSshConnectionDefault } from './remoteSshManageHostTasks.js';
import { checkRelayRuntimeHealthDefault, controlRelayRuntimeDefault, installOrUpdateRelayRuntimeDefault, readRelayRuntimeStatusDefault } from './relayRuntimeTasks.js';
import { createRelayAccessConfigStore } from './relayAccessConfigStore.js';
import { normalizeBootstrapChannel, runCommandCapture } from './taskRuntime.js';

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
  remoteSshBootstrap?: Partial<RemoteSshBootstrapDeps>;
  relayDriftRepair?: Partial<RelayDriftRepairDeps>;
  relayAccess?: Partial<RelayAccessDeps>;
  setupThisComputer?: Partial<SetupThisComputerInteractiveDeps>;
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
    channel?: 'stable' | 'preview' | 'dev' | 'publicdev';
    surface?: string;
  }>, context: Readonly<{
    signal: AbortSignal;
    emitProgress: (stepId: string, message?: string) => void;
  }>) => Promise<SystemTaskJsonObject>;
}>;

type RelayAccessDeps = Readonly<{
  readConfig: (params: Readonly<{ target: systemTasks.RelayAccessTaskTarget }>) => Promise<relayAccess.RelayAccessConfig | null>;
  writeConfig: (params: Readonly<{ target: systemTasks.RelayAccessTaskTarget; config: relayAccess.RelayAccessConfig | null }>) => Promise<void>;
  getProvider: (providerId: relayAccess.RelayAccessProviderId) => relayAccess.RelayAccessProvider;
  createExecutionContext: (params: Readonly<{ target: systemTasks.RelayAccessTaskTarget; upstreamUrl: string | null }>) => relayAccess.RelayAccessExecutionContext;
}>;

export function createHsetupSystemTaskRegistry(deps: HsetupRegistryDeps = {}): SystemTaskRegistry {
  const relayRuntimeDeps = createRelayRuntimeDeps(deps.relayRuntime);
  const remoteBootstrapDeps = createRemoteSshBootstrapDeps(deps.remoteSshBootstrap);
  const relayDriftRepairDeps = createRelayDriftRepairDeps(deps.relayDriftRepair);
  const relayAccessDeps = createRelayAccessDeps(deps.relayAccess);
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
  const remoteBootstrapHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRemoteSshBootstrapMachineTaskKind(remoteBootstrapDeps),
  );
  const remoteManageHostHandler = systemTasks.createExecutionRunnerFromKind(
    systemTasks.createRemoteSshManageHostTaskKind(createRemoteSshManageHostDeps(deps.remoteSshBootstrap)),
  );
  const setupThisComputerHandler = systemTasks.createExecutionRunnerFromKind(
    createSetupThisComputerInteractiveTaskKind(deps.setupThisComputer),
  );
  const daemonServiceStatusHandler = createDaemonServiceStatusHandler();
  const daemonServiceStartHandler = createDaemonServiceStartHandler();
  const daemonServiceStopHandler = createDaemonServiceStopHandler();
  const daemonServiceRestartHandler = createDaemonServiceRestartHandler();
  const setupRepairThisComputerHandler = createSetupRepairThisComputerHandler();

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
      kind: 'daemon.service.stop.v1',
      handler: daemonServiceStopHandler,
    },
    {
      kind: 'daemon.service.restart.v1',
      handler: daemonServiceRestartHandler,
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
      handler: setupThisComputerHandler,
    },
    {
      kind: 'setup.repairThisComputer.v1',
      handler: setupRepairThisComputerHandler,
    },
    {
      kind: 'relay.connectBackgroundService.v1',
      handler: async function* (params, context) {
        const parsed = parseRelayConnectBackgroundServiceParams(params);

        yield {
          type: 'progress',
          stepId: 'relay.drift.repair.start',
          message: 'Connecting background service to the selected Relay',
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
      kind: 'remote.ssh.bootstrapMachine.v1',
      handler: remoteBootstrapHandler,
    },
    {
      kind: 'remote.ssh.manageHost.v1',
      handler: remoteManageHostHandler,
    },
  ]);
}

function createSetupRepairThisComputerHandler(): systemTasks.SystemTaskExecutionRunner {
  return async function* (params, context) {
    const parsed = parseSetupRepairThisComputerParams(params);
    const releaseRing = parsed.channel ? normalizeBootstrapChannel(parsed.channel).releaseChannel : undefined;
    const deps = createSetupRepairThisComputerDeps(context.signal, releaseRing);
    const runner = systemTasks.createExecutionRunnerFromKind(
      systemTasks.createSetupRepairThisComputerTaskKind(deps),
    );
    return yield* runner(params, context);
  };
}

function createSetupRepairThisComputerDeps(
  signal: AbortSignal,
  releaseRing?: 'stable' | 'preview' | 'publicdev',
): systemTasks.SetupRepairThisComputerDeps {
  let cachedRelayProfile: Awaited<ReturnType<typeof readActiveRelayProfile>> | null = null;
  let cachedAuthStatus: AuthStatusSnapshot | null = null;

  return {
    async readActiveRelayProfile() {
      if (cachedRelayProfile) return cachedRelayProfileToRepairProfile(cachedRelayProfile);
      cachedRelayProfile = await readActiveRelayProfile({ releaseRing });
      return cachedRelayProfileToRepairProfile(cachedRelayProfile);
    },
    async readAuthStatus() {
      const status = await readCachedAuthStatus();
      if (!status.authenticated) {
        return { authenticated: false };
      }
      return { authenticated: true, machineId: status.machineId };
    },
    async configureRelay(params) {
      const profile = cachedRelayProfile ?? await readActiveRelayProfile({ releaseRing });
      cachedRelayProfile = profile;
      await configureRelay({
        serverUrl: params.relayUrl,
        webappUrl: params.webappUrl,
        localServerUrl: params.activeLocalRelayUrl,
      }, { releaseRing });
    },
    async requestAuthPairing() {
      return await requestAuthPairing({ releaseRing });
    },
    async waitForAuthPairing(publicKey) {
      const result = await waitForAuthPairing(publicKey, { releaseRing });
      const machineId = String(result.machineId ?? '').trim();
      if (!machineId) {
        throw new systemTasks.SystemTaskExecutionError(
          'system_task_failed',
          'Auth pairing did not return a machine id.',
        );
      }
      return { machineId };
    },
    async pairLocalMachineIfNeeded() {
      const status = await readCachedAuthStatus();
      const machineId = await pairLocalMachineIfNeeded(status, { releaseRing });
      return machineId ?? '';
    },
    async installDaemonService() {
      await installService({ releaseRing });
    },
    async startDaemonService() {
      await startService({ releaseRing });
    },
    async waitForReadyDaemon() {
      return await waitForReadyDaemon({
        readDaemonStatus: async () => await readDaemonStatus({ releaseRing }),
        signal,
      });
    },
  };

  async function readCachedAuthStatus(): Promise<AuthStatusSnapshot> {
    if (cachedAuthStatus) return cachedAuthStatus;
    cachedAuthStatus = await readAuthStatus({ releaseRing });
    return cachedAuthStatus;
  }

  function cachedRelayProfileToRepairProfile(
    profile: Awaited<ReturnType<typeof readActiveRelayProfile>>,
  ): systemTasks.SetupRepairThisComputerRelayProfile {
    return {
      serverUrl: profile.serverUrl,
      webappUrl: profile.webappUrl,
      activeLocalRelayUrl: profile.localServerUrl,
    };
  }
}
function createRelayDriftRepairDeps(override?: Partial<RelayDriftRepairDeps>): RelayDriftRepairDeps {
  return {
    async connectBackgroundService(params, context) {
      const releaseRing = params.channel ? normalizeBootstrapChannel(params.channel).releaseChannel : undefined;
      context.emitProgress('relay.connectBackgroundService.prepare');
      context.emitProgress('relay.connectBackgroundService.configureRelay');
      await configureRelay({
        serverUrl: params.activeRelayUrl,
        localServerUrl: params.activeLocalRelayUrl,
        webappUrl: params.activeWebappUrl,
      }, { releaseRing });

      const authStatus = await readAuthStatus({ releaseRing });
      if (!authStatus.authenticated) {
        throw new systemTasks.SystemTaskExecutionError(
          'not_authenticated',
          'Authenticate this computer with the selected Relay before continuing.',
        );
      }

      const machineId = await repairRelayDriftAuthIfNeeded(authStatus, context.emitProgress, releaseRing);

      context.emitProgress('relay.connectBackgroundService.finish');
      await installService({ releaseRing });
      await startService({ releaseRing });
      const daemonStatus = await waitForReadyDaemon({
        readDaemonStatus: async () => await readDaemonStatus({ releaseRing }),
        signal: context.signal,
      });
      if (!daemonStatus.serviceInstalled || !daemonStatus.daemonRunning || daemonStatus.needsAuth) {
        throw new systemTasks.SystemTaskExecutionError(
          'daemon_service_not_ready',
          'Background service did not reach a ready state for the selected Relay.',
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
  releaseRing?: 'stable' | 'preview' | 'publicdev',
): Promise<string | null> {
  if (authStatus.machineId) {
    return authStatus.machineId;
  }
  emitProgress('relay.connectBackgroundService.authenticate');
  return await pairLocalMachineIfNeeded(authStatus, { releaseRing });
}

function parseRelayConnectBackgroundServiceParams(params: unknown): Readonly<{
  activeRelayUrl: string;
  activeWebappUrl: string;
  activeLocalRelayUrl: string | null;
  channel?: 'stable' | 'preview' | 'dev' | 'publicdev';
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
  const channel = typeof record.channel === 'string' && record.channel.trim()
    ? record.channel.trim()
    : undefined;
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
    ...(channel ? { channel: channel as 'stable' | 'preview' | 'dev' | 'publicdev' } : {}),
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

function createRemoteSshManageHostDeps(overrides: HsetupRegistryDeps['remoteSshBootstrap']): systemTasks.RemoteSshManageHostDeps {
  return {
    resolveHostTrust: overrides?.resolveHostTrust ?? resolveRemoteSshHostTrustDefault,
    testConnection: testRemoteSshConnectionDefault,
    installRemoteCli: installRemoteCliForManageHostDefault,
    runDaemonServiceCommand: runRemoteDaemonServiceCommandDefault,
    runRelayRuntimeCommand: runRemoteRelayRuntimeCommandDefault,
  };
}

function createRelayAccessDeps(overrides?: Partial<RelayAccessDeps>): RelayAccessDeps {
  const store = createRelayAccessConfigStore({
    resolveHappyHomeDir: () => resolveHappyHomeDirFromEnvironment(process.env),
    ssh: {
      runRemoteText: async ({ ssh, remoteCommand }) => {
        const invocation = buildSshCommand({
          target: ssh.target,
          port: ssh.port,
          auth: {
            kind: ssh.auth,
            identityFile: ssh.identityFile,
            ...(ssh.auth === 'password' ? { password: ssh.password } : {}),
          },
          knownHosts: ssh.knownHostsPath ? { mode: 'app', path: ssh.knownHostsPath } : { mode: 'system' },
          remoteCommand,
        });
        const result = await runCommandCapture({
          command: invocation.command,
          args: invocation.args,
          ...(invocation.env ? { env: invocation.env } : {}),
        });
        return result;
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
            const invocation = buildSshCommand({
              target: ssh.target,
              port: ssh.port,
              auth: {
                kind: ssh.auth,
                identityFile: ssh.identityFile,
                ...(ssh.auth === 'password' ? { password: ssh.password } : {}),
              },
              knownHosts: ssh.knownHostsPath
                ? { mode: 'app', path: ssh.knownHostsPath }
                : { mode: 'system' },
            remoteCommand,
          });
          const result = await runCommandCapture({
            command: invocation.command,
            args: invocation.args,
            ...(invocation.env ? { env: invocation.env } : {}),
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
