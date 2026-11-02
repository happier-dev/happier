import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { onTestFinished, vi } from 'vitest';
import { z } from 'zod/mini';
import * as firstPartyRuntime from '@happier-dev/cli-common/firstPartyRuntime';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ActionExecutorContext, MachineInstallationIdentityV1 } from '@happier-dev/protocol';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { configuration, reloadConfiguration } from '@/configuration';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { writeCredentialsTokenOnly, readStoredCredentialsForServerId, readDaemonState } from '@/persistence';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { writeDaemonSettingsFixture } from './fakeDaemonLifecycle.testkit';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { CLI_API_TOKEN_ENV, CLI_API_TOKEN_HANDOFF_ENV } from '@/auth/cliApiToken';
import { PROCESS_OWNER_ENV_KEY } from '@/processes/ownerTag';
import { daemonPost } from '@/daemon/controlHttp';
import { stopDaemonSession } from '@/daemon/controlClient';
import { createInstalledDaemonMountInventory } from './installedDaemonMounts.testkit';

type FullDaemonHome = Readonly<{
  accountId: string;
  token: string;
  installedToken: string | null;
  homeId: string;
  baseUrl: string;
  waitForMachineRpc(machineId: string, method: string, signal?: AbortSignal): Promise<void>;
  createMachineMember(accessLevel: 'view' | 'admin'): Promise<Readonly<{ accountId: string; token: string }>>;
  createForeignAccount(): Promise<Readonly<{ accountId: string; token: string }>>;
  readWorkflowSessionEffects(): Promise<Readonly<{
    sessions: readonly Readonly<{ id: string; metadata: string | null; pendingCount: number; pendingBlockedCount: number }>[];
    messages: readonly Readonly<{ id: string; sessionId: string; localId: string | null; seq: number; messageRole: string | null; content: unknown }>[];
    pending: readonly Readonly<{ sessionId: string; localId: string }>[];
    turns: readonly Readonly<{ sessionId: string; turnId: string; status: string; transcriptAnchorsJson: string | null }>[];
    runs: readonly Readonly<{ id: string; accountId: string; state: string }>[];
  }>>;
  close(): Promise<void>;
}>;

/** Full installed daemon composition. The canonical server testkit owns a
 * disposable database and real HTTP/socket admission; no daemon, Workflow,
 * requester, Pending, runner, or native-launch owner is substituted. */
export async function startInstalledDaemonFixture(input: Readonly<{
  plugins?: Parameters<typeof createAuthoredAdmittedPluginRuntimeFixture>[0]['plugins'];
  env?: Readonly<Record<string, string | undefined>>;
  registerCleanup?: (cleanup: () => Promise<void>) => void;
  onStartupPhase?: (phase: 'identity' | 'home' | 'homeStart' | 'credentials' | 'plugins' | 'daemonImport' | 'daemonStart' | 'machineRpc' | 'ready') => void;
  onShutdownPhase?: (phase: 'sessions' | 'listSessions' | 'retireSession' | 'signalDaemon' | 'awaitDaemon' | 'plugins' | 'home' | 'mounts' | 'restore' | 'stopped') => void;
}> = {}) {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'happier-installed-daemon-'));
  const directory = join(homeDirectory, 'workspace');
  await mkdir(directory);
  const environment = createEnvKeyScope([
    'HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_CARRIER_POLICY',
    'HAPPIER_CLI_SUBPROCESS_PREFER_TSX', 'HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK',
    'HAPPIER_CLI_SUBPROCESS_ENTRYPOINT', 'HAPPIER_VARIANT', 'HAPPIER_DAEMON_WAIT_FOR_AUTH',
    'HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED', 'HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED',
    'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE', CLI_API_TOKEN_ENV, CLI_API_TOKEN_HANDOFF_ENV,
    'HAPPIER_DAEMON_STARTUP_SOURCE', 'HAPPIER_DAEMON_RUNTIME_ID', 'HAPPIER_DAEMON_TAKEOVER',
    'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID', 'HAPPIER_DAEMON_SERVICE_LABEL', 'HAPPIER_DAEMON_PLUGIN_RECOVERY',
    'HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK', PROCESS_OWNER_ENV_KEY,
    firstPartyRuntime.FIRST_PARTY_INSTALL_HOME_ENV_KEY, 'MUTAGEN_DATA_DIRECTORY',
    'HAPPIER_DAEMON_SERVICE_PLATFORM', 'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR', 'HAPPIER_DAEMON_SERVICE_CHANNEL', 'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
    ...Object.keys(input.env ?? {}),
  ]);
  const startupEvents = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection', 'exit', 'beforeExit'] as const;
  const processEvents: EventEmitter = process;
  const listenersBefore = new Map(startupEvents.map(event => [event, processEvents.listeners(event)]));
  const lifetime = new AbortController();
  let home: FullDaemonHome | undefined;
  let plugin: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
  let mounts: Awaited<ReturnType<typeof createInstalledDaemonMountInventory>> | undefined;
  let startup: Promise<void> | undefined;
  let shutdownDaemon: (() => void) | undefined;
  let stopping: Promise<void> | undefined;
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  // Artifact acquisition is the network/install boundary. Keep installed
  // lookup, payload validation, Sync startup and unavailable projection real,
  // but this conversation fixture must never provision a native component.
  const acquisition = vi.spyOn(firstPartyRuntime, 'ensureInstalledFirstPartyComponent')
    .mockRejectedValue(Object.assign(new Error('Native component acquisition is unavailable in this fixture'),
      { code: 'fixture_native_acquisition_unavailable' }));
  const stop = () => stopping ??= (async () => {
    input.onShutdownPhase?.('sessions');
    lifetime.abort();
    try {
      if (startup) {
        try {
          // Ordinary daemon shutdown intentionally retains Session runners.
          // Retire only children listed by this fixture's authenticated owner
          // before disposing the isolated Home and its private credentials.
          if (configuration.happyHomeDir !== homeDirectory) throw new Error('Installed fixture lost its isolated Home scope');
          const target = await readDaemonState();
          if (target?.httpPort) {
            if (target.pid !== process.pid) throw new Error('Installed fixture does not own this daemon publication');
            input.onShutdownPhase?.('listSessions');
            const children = z.object({ children: z.array(z.object({ happySessionId: z.string(), pid: z.number() })) })
              .parse(await daemonPost('/list', {}, { target })).children;
            for (const child of children) {
              input.onShutdownPhase?.('retireSession');
              const retired = await stopDaemonSession(child.happySessionId, { target });
              if (retired.status !== 'stopped' && retired.status !== 'not_found') {
                throw new Error(`Installed fixture Session retirement did not settle: ${retired.status}`);
              }
            }
          }
        } finally {
          // Deliver the OS boundary only to the handler installed by this
          // startDaemon call, not other owners in the Vitest process.
          input.onShutdownPhase?.('signalDaemon');
          shutdownDaemon?.();
          input.onShutdownPhase?.('awaitDaemon');
          await startup;
        }
      }
    } finally {
      input.onShutdownPhase?.('plugins');
      try { await plugin?.dispose(); }
      finally {
        input.onShutdownPhase?.('home');
        try { await home?.close(); }
        finally {
          input.onShutdownPhase?.('mounts');
          try { await mounts?.dispose(); }
          finally {
            input.onShutdownPhase?.('restore');
            exit.mockRestore();
            acquisition.mockRestore();
            for (const event of startupEvents) for (const listener of processEvents.listeners(event)) {
              if (!listenersBefore.get(event)?.includes(listener)) processEvents.removeListener(event, listener as (...args: unknown[]) => void);
            }
            environment.restore(); reloadConfiguration();
            await rm(homeDirectory, { recursive: true, force: true });
            input.onShutdownPhase?.('stopped');
          }
        }
      }
    }
  })();
  (input.registerCleanup ?? onTestFinished)(stop);
  try {
    mounts = await createInstalledDaemonMountInventory(homeDirectory);
    environment.patch({ ...input.env, HAPPIER_HOME_DIR: homeDirectory, HAPPIER_ACTIVE_SERVER_ID: 'installed-daemon-fixture',
      HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined, [CLI_API_TOKEN_ENV]: undefined, [CLI_API_TOKEN_HANDOFF_ENV]: undefined,
      HAPPIER_DAEMON_STARTUP_SOURCE: 'manual', HAPPIER_DAEMON_RUNTIME_ID: undefined, HAPPIER_DAEMON_TAKEOVER: undefined,
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'installed-daemon-fixture', HAPPIER_DAEMON_SERVICE_LABEL: undefined,
      HAPPIER_DAEMON_PLUGIN_RECOVERY: undefined, HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '0',
      [firstPartyRuntime.FIRST_PARTY_INSTALL_HOME_ENV_KEY]: join(homeDirectory, 'native-components'), MUTAGEN_DATA_DIRECTORY: undefined,
      HAPPIER_DAEMON_SERVICE_PLATFORM: undefined, HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDirectory,
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: undefined, HAPPIER_DAEMON_SERVICE_CHANNEL: undefined,
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: undefined });
    reloadConfiguration();
    input.onStartupPhase?.('identity');
    const installation = await readOrCreateInstallationIdentity();
    const machineId = randomUUID();
    const serverPath = '../../../../server/sources/testkit/workflowApprovedOperationServer.testkit';
    input.onStartupPhase?.('home');
    const server: Readonly<{ startWorkflowApprovedOperationServer(input: Readonly<{
      installedMachine: Readonly<{ machineId: string; installation: MachineInstallationIdentityV1; happyHomeDir: string }>;
    }>): Promise<FullDaemonHome> }> = await import(serverPath);
    input.onStartupPhase?.('homeStart');
    home = await server.startWorkflowApprovedOperationServer({ installedMachine: { machineId, installation, happyHomeDir: homeDirectory } });
    if (!home.installedToken) throw new Error('Home did not mint the installed terminal credential');
    const serverId = 'installed-daemon-fixture';
    environment.patch({ HAPPIER_HOME_DIR: homeDirectory, HAPPIER_ACTIVE_SERVER_ID: serverId,
      HAPPIER_SERVER_URL: home.baseUrl, HAPPIER_PUBLIC_SERVER_URL: undefined,
      HAPPIER_LOCAL_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: home.baseUrl,
      HAPPIER_HOME_CARRIER_POLICY: 'standard_only', HAPPIER_VARIANT: 'dev',
      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '1', HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '1',
      HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: undefined, HAPPIER_DAEMON_WAIT_FOR_AUTH: '1',
      HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' });
    await writeDaemonSettingsFixture(homeDirectory, { activeServerId: serverId,
      servers: { [serverId]: { id: serverId, name: 'Installed daemon fixture', serverUrl: home.baseUrl,
        webappUrl: home.baseUrl, createdAt: 0, updatedAt: 0, lastUsedAt: 0 } },
      machineIdByServerIdByAccountId: { [serverId]: { [home.accountId]: machineId } },
      lastTokenSubByServerId: { [serverId]: home.accountId } });
    reloadConfiguration();
    input.onStartupPhase?.('credentials');
    await seedTestServerProfile({ id: serverId, homeId: home.homeId, serverUrl: home.baseUrl });
    await writeCredentialsTokenOnly({ token: home.installedToken });
    const installedCredentials = await readStoredCredentialsForServerId(serverId);
    if (!installedCredentials) throw new Error('Installed daemon credentials were not retained by their storage owner');
    if (input.plugins?.length) {
      input.onStartupPhase?.('plugins');
      plugin = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: homeDirectory,
        plugins: input.plugins });
    }
    input.onStartupPhase?.('daemonImport');
    const { startDaemon } = await import('@/daemon/startDaemon');
    lifetime.signal.throwIfAborted();
    const signalListenersBeforeStart = new Set(processEvents.listeners('SIGTERM'));
    input.onStartupPhase?.('daemonStart');
    startup = startDaemon();
    const signalListeners = processEvents.listeners('SIGTERM').filter(listener => !signalListenersBeforeStart.has(listener));
    shutdownDaemon = () => { for (const listener of signalListeners) listener.call(process); };
    void startup.catch(() => undefined);
    input.onStartupPhase?.('machineRpc');
    await Promise.race([Promise.all([
      home.waitForMachineRpc(machineId, RPC_METHODS.CAPABILITIES_DESCRIBE, lifetime.signal),
      home.waitForMachineRpc(machineId, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, lifetime.signal),
    ]),
      startup.then(() => { throw new Error('Full daemon ended before its actual Machine receiver registered'); })]);
    input.onStartupPhase?.('ready');
    const boundHome = home;
    const ownerCredentials = { token: home.token, encryption: null };
    return {
      home: boundHome, machineId, serverId, homeDirectory, directory, installation, installedCredentials, ownerCredentials,
      stop,
      invoke: async (method: string, params: unknown, caller: Readonly<{ token: string }> = ownerCredentials) =>
        await callExactMachineRpc({ credentials: { token: caller.token, encryption: null }, machineId,
          serverUrl: boundHome.baseUrl, method, request: params }),
      // Use the real public Account transport: Home mints the installation-
      // bound root and the canonical producer seals its requester custody.
      // A local executor with surface=rpc would skip that client ingress.
      createActionExecutor: (caller: Readonly<{ token: string }> = ownerCredentials) => ({
        execute: async (actionId: string, params: unknown, context: ActionExecutorContext = {}) =>
          await dispatchOriginalAccountAction({ actionId, input: params,
            requestId: context.actionRequestId ?? randomUUID(),
            target: context.externalActionTarget ?? { kind: 'machine', machineId },
            credentials: { token: caller.token, encryption: null }, serverHttpBaseUrl: boundHome.baseUrl,
            serverIdentityId: boundHome.homeId, authority: 'present_user',
            invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user',
              ...(context.presentUserConfirmation ? { presentUserConfirmation: context.presentUserConfirmation } : {}),
            },
            // This is the caller's affirmative confidentiality choice, not
            // execution admission: Home still refuses unsupported members.
            onRequesterSessionCredentialDisclosure: () => true,
            signal: lifetime.signal,
          }),
      }),
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
