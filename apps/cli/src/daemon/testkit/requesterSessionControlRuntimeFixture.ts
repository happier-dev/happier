import { join } from 'node:path';

import { ApiClient } from '@/api/api';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
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
  resolveQualifiedConnectedAccountV4Support: NonNullable<Parameters<typeof startDaemonSessionControlRuntime>[0]['resolveQualifiedConnectedAccountV4Support']>;
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
    installationIdentityFile: join(input.happyHomeDir, 'installation.json'),
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
    const api = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => ApiClient.create(input.credentials));
    runtime = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => startDaemonSessionControlRuntime({
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
      pidToAwaiter: new Map(),
      pidToSpawnResultResolver: new Map(),
      pidToSpawnWebhookTimeout: new Map(),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      connectedServicesRestartRequestedPids: new Set(),
      getApiMachineForSessions: () => null,
      getConnectedServiceRefreshCoordinator: () => input.getRequester()?.connectedServiceRefreshCoordinator ?? null,
      getConnectedServiceQuotasCoordinator: () => input.getRequester()?.connectedServiceQuotasCoordinator ?? null,
      resolveRequesterSessionRuntimeContext: async sessionId => {
        const requester = input.getRequester();
        return requester?.bootstrap.getBoundSessionId() === sessionId ? requester : null;
      },
      resolveQualifiedConnectedAccountV4Support: input.resolveQualifiedConnectedAccountV4Support,
      // Physical launch and whole-daemon shutdown are OS/lifetime boundaries.
      beforeShutdown: async () => {},
      onHappySessionWebhook: async () => { throw new Error('Unexpected physical Session launch'); },
      requestShutdown: () => { throw new Error('Unexpected daemon shutdown request'); },
      processEnv: {},
    }));
    return { runtime, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
