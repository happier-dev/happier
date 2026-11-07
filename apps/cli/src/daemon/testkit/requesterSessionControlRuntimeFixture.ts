import { join } from 'node:path';

import { ApiClient } from '@/api/api';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { readOrCreateInstallationIdentity } from '../identity/store';
import type { StoredCredentials } from '@/persistence';
import type { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createDaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import type { RequesterSessionRuntimeContext } from '../sessionEncryption/requesterSessionCredentials';
import { startDaemonSessionControlRuntime } from '../startup/startDaemonSessionControlRuntime';
import type { TrackedSession } from '../types';

/** Real startup composition for tests consuming the Session/FSM-owned auth port. */
export async function createRequesterSessionControlRuntimeFixture(input: Readonly<{
  happyHomeDir: string;
  activeServerDir: string;
  serverId: string;
  serverHttpBaseUrl: string;
  machineId: string;
  custodianAccountId: string;
  credentials: StoredCredentials;
  connectedServicesMaterializationBaseDir: string;
  registry: ConnectedServiceRuntimeRegistry;
  trackedSessions: Map<number, TrackedSession>;
  getRequester(): RequesterSessionRuntimeContext | null;
  resolveRequesterSessionRuntimeContext?: Parameters<typeof startDaemonSessionControlRuntime>[0]['resolveRequesterSessionRuntimeContext'];
  releaseRequesterSessionRuntimeContext?: Parameters<typeof startDaemonSessionControlRuntime>[0]['releaseRequesterSessionRuntimeContext'];
  resolveQualifiedConnectedAccountV4Support: NonNullable<Parameters<typeof startDaemonSessionControlRuntime>[0]['resolveQualifiedConnectedAccountV4Support']>;
  getApiMachineForSessions?: Parameters<typeof startDaemonSessionControlRuntime>[0]['getApiMachineForSessions'];
  pidToAwaiter?: Parameters<typeof startDaemonSessionControlRuntime>[0]['pidToAwaiter'];
  beforeStartup?: () => Promise<void>;
  processEnv?: NodeJS.ProcessEnv;
  startup?: Pick<Parameters<typeof startDaemonSessionControlRuntime>[0],
    'resolveSessionSpawnDirectTargetTransport' | 'resolveCurrentMachineExecutionOriginContext'>
    & Partial<Pick<Parameters<typeof startDaemonSessionControlRuntime>[0],
      'deviceLocalSecretStorage' | 'onHappySessionWebhook' | 'createRequesterSessionRuntimeContext'
      | 'liveStreamCaptureRegistry' | 'onComputerRoutesReady' | 'onMachineAccessLossReceiverReady' | 'workflowAcceptedAuthorizationCurrentness'
      | 'runtimeActionExecute' | 'pluginRuntimeController' | 'projectProviderModelsForAccount' | 'readProviderForAccount' | 'resolveServerFeaturesSnapshot'>>;
}>) {
  const previousConfiguration = {
    happyHomeDir: configuration.happyHomeDir,
    activeServerDir: configuration.activeServerDir,
    activeServerId: configuration.activeServerId,
    apiServerUrl: configuration.apiServerUrl,
    settingsFile: configuration.settingsFile,
    serversDir: configuration.serversDir,
    privateKeyFile: configuration.privateKeyFile,
    daemonStateFile: configuration.daemonStateFile,
    installationIdentityFile: configuration.installationIdentityFile,
  };
  Object.assign(configuration, {
    happyHomeDir: input.happyHomeDir,
    activeServerDir: input.activeServerDir,
    activeServerId: input.serverId,
    apiServerUrl: input.serverHttpBaseUrl,
    settingsFile: join(input.happyHomeDir, 'settings.json'),
    serversDir: join(input.happyHomeDir, 'servers'),
    privateKeyFile: join(input.activeServerDir, 'access.key'),
    daemonStateFile: join(input.activeServerDir, 'daemon.state.json'),
    installationIdentityFile: join(input.happyHomeDir, 'installation-identity.json'),
  });
  const mutationCustody = createDaemonSessionMutationCustody({ credentials: input.credentials });
  let runtime: Awaited<ReturnType<typeof startDaemonSessionControlRuntime>> | null = null;
  const dispose = async () => {
    try {
      await runtime?.stopControlServer();
    } finally {
      try {
        await mutationCustody.close();
      } finally {
        Object.assign(configuration, previousConfiguration);
      }
    }
  };
  try {
    await input.beforeStartup?.();
    const installation = input.startup ? await readOrCreateInstallationIdentity() : null;
    const api = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => ApiClient.create(input.credentials));
    runtime = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => startDaemonSessionControlRuntime({
      ...input.startup,
      // Mirror startDaemon's real runtime producer so requester Actions reach
      // the same native runtime composition as the installed daemon.
      runtimeActionExecute: input.startup?.runtimeActionExecute ?? api.createBrowserRuntimeActionExecutor({
        observeExecution: request => {
          const machine = input.getApiMachineForSessions?.();
          return machine ? machine.observeActionExecution(request)
            : Promise.resolve({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });
        },
      }),
      machineId: input.machineId,
      credentials: input.credentials,
      api,
      externalActionAccountId: input.custodianAccountId,
      serverId: input.serverId,
      serverBaseUrl: input.serverHttpBaseUrl,
      daemonSessionMutationCustody: mutationCustody,
      connectedServicesMaterializationBaseDir: input.connectedServicesMaterializationBaseDir,
      connectedServiceRuntimeRegistry: input.registry,
      pidToTrackedSession: input.trackedSessions,
      pidToAwaiter: input.pidToAwaiter ?? new Map(),
      pidToSpawnResultResolver: new Map(),
      pidToSpawnWebhookTimeout: new Map(),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      connectedServicesRestartRequestedPids: new Set(),
      getApiMachineForSessions: input.getApiMachineForSessions ?? (() => null),
      getConnectedServiceRefreshCoordinator: () => input.getRequester()?.connectedServiceRefreshCoordinator ?? null,
      getConnectedServiceQuotasCoordinator: () => input.getRequester()?.connectedServiceQuotasCoordinator ?? null,
      resolveRequesterSessionRuntimeContext: input.resolveRequesterSessionRuntimeContext ?? (async sessionId => {
        const requester = input.getRequester();
        return requester?.bootstrap.getBoundSessionId() === sessionId ? requester : null;
      }),
      // getRequester lends the caller's context; its enclosing fixture owns teardown.
      releaseRequesterSessionRuntimeContext: input.releaseRequesterSessionRuntimeContext ?? (async () => {}),
      resolveQualifiedConnectedAccountV4Support: input.resolveQualifiedConnectedAccountV4Support,
      // Physical launch and whole-daemon shutdown are OS/lifetime boundaries.
      beforeShutdown: async () => {},
      onHappySessionWebhook: input.startup?.onHappySessionWebhook
        ?? (async () => { throw new Error('Unexpected physical Session launch'); }),
      requestShutdown: () => { throw new Error('Unexpected daemon shutdown request'); },
      processEnv: input.processEnv ?? {},
    }));
    return { runtime, installation, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
