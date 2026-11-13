import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ApiClient } from '../../../../../apps/cli/src/api/api';
import type { ApiMachineClient } from '../../../../../apps/cli/src/api/apiMachine';
import { RpcHandlerManager } from '../../../../../apps/cli/src/api/rpc/RpcHandlerManager';
import { runWithServerHttpBaseUrl } from '../../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { createRequesterSessionControlRuntimeFixture } from '../../../../../apps/cli/src/daemon/testkit/requesterSessionControlRuntimeFixture';
import { activateSessionsRoleForMachineClient } from '../../../../../apps/cli/src/daemon/testkit/sessionsRole.testkit';
import { readOrCreateInstallationIdentity } from '../../../../../apps/cli/src/daemon/identity/store';
import { osStore } from '../../../../../apps/cli/src/testkit/machines/nativeSoftwareInstall';
import { ConnectedServiceRuntimeRegistry } from '../../../../../apps/cli/src/daemon/connectedServices/runtimeRegistry/registry';
import { writeStoredCredentialsForServerId } from '../../../../../apps/cli/src/persistence';
import { fetchServerFeaturesSnapshot } from '../../../../../apps/cli/src/features/serverFeaturesClient';
import { resolveAuthenticatedExactHomeConnectionDescriptorObservation } from '../../../../../apps/cli/src/auth/terminalAuthEnrollmentClient';
import { adoptServerProfileHomeConnectionDescriptor } from '../../../../../apps/cli/src/server/serverProfiles';
import { resolveQualifiedConnectedAccountAtomicV4Negotiation } from '../../../../../apps/cli/src/api/client/qualifiedConnectedAccountApi';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createLocalManagedOutputCredentialAuthority } from './managedControllerOutputFixture';

/** Compose the existing daemon startup, Home proof and ApiMachine transport.
 * Native Session spawn, daemon shutdown and credential/key storage use the
 * aggregate's shared OS boundaries. */
export async function connectOutputReceiver(input: Readonly<{
  directory: string; serverId: string; machineId: string;
  home: Readonly<{ baseUrl: string; homeId: string; ownerAccountId: string; installedToken: string }>;
}>) {
  let machine: ApiMachineClient | undefined;
  let daemon: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | undefined;
  let sessionsRole: Awaited<ReturnType<typeof activateSessionsRoleForMachineClient>> | undefined;
  const previousStorage = { identity: osStore.identity, credentials: osStore.credentials };
  const close = async () => { try { await sessionsRole?.stop(); }
    finally { try { await machine?.shutdown(); } finally {
      try { await daemon?.dispose(); }
      finally { osStore.identity = previousStorage.identity; osStore.credentials = previousStorage.credentials; }
    } } };
  try {
    return await runWithServerHttpBaseUrl(input.home.baseUrl, async () => {
      const credentials = { token: input.home.installedToken, encryption: null };
      // Setup and this connected receiver share the canonical OS storage boundary.
      // Keep the real Home-issued token and the actual generated installation key.
      osStore.identity = await readOrCreateInstallationIdentity();
      osStore.credentials = credentials;
      const features = await fetchServerFeaturesSnapshot({ serverUrl: input.home.baseUrl, token: credentials.token });
      if (features.status !== 'ready') throw new Error('Actual Home feature discovery unavailable');
      daemon = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: input.directory,
        activeServerDir: join(input.directory, 'servers', input.serverId), serverId: input.serverId,
        serverHttpBaseUrl: input.home.baseUrl, machineId: input.machineId,
        custodianAccountId: input.home.ownerAccountId, credentials,
        connectedServicesMaterializationBaseDir: join(input.directory, 'connected-services'),
        registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: new Map(), getRequester: () => null,
        resolveQualifiedConnectedAccountV4Support: () => resolveQualifiedConnectedAccountAtomicV4Negotiation(features),
        getApiMachineForSessions: () => machine ?? null,
        beforeStartup: async () => {
          await writeStoredCredentialsForServerId(input.serverId, credentials);
          const observation = resolveAuthenticatedExactHomeConnectionDescriptorObservation({ snapshot: features,
            expectedHomeServerIdentityId: input.home.homeId });
          if (observation.kind !== 'available') throw new Error('Actual Home connection descriptor unavailable');
          await adoptServerProfileHomeConnectionDescriptor({ descriptor: observation.descriptor,
            expectedProfileId: input.serverId, createIfMissing: true, observation: 'exact', use: true });
        },
        startup: { managedProviderOperationAuthority: createLocalManagedOutputCredentialAuthority(),
          resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: input.home.homeId,
          machineId: input.machineId }) },
      });
      const api = await ApiClient.create(credentials);
      const snapshot = await api.getMachine(input.machineId);
      if (!snapshot) throw new Error('Actual Home omitted the fixture Machine');
      machine = await api.machineSyncClient(snapshot, { runtimeId: randomUUID(), startupSource: 'manual', serviceManaged: false },
        { resolveCurrentServerIdentityId: () => input.home.homeId });
      const ingress = daemon.runtime.externalActionIngressOwner;
      if (!ingress) throw new Error('Actual daemon external Action ingress unavailable');
      const registration = machine.setRPCHandlers({ spawnSession: async () => { throw new Error('Unexpected physical Session spawn'); },
        stopSession: async () => true, requestShutdown() {} }, { externalActionIngressOwner: ingress });
      sessionsRole = await activateSessionsRoleForMachineClient(machine, registration);
      const connected = machine;
      await new Promise<void>((resolve, reject) => connected.connect({ onConnect: resolve,
        onOwnershipConflict: () => reject(new Error('Fixture Machine ownership conflict')) }));
      const manager: unknown = Reflect.get(machine, 'rpcHandlerManager');
      if (!(manager instanceof RpcHandlerManager)) throw new Error('Actual Machine RPC receiver unavailable');
      // ApiMachine owns initial registration plus replay, each ten seconds.
      const readiness = await manager.waitForRegisteredHandlers([EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1], { timeoutMs: 20_000 });
      if (readiness.status !== 'ready') throw new Error('Actual Machine receiver did not register');
      return { machine, manager, close };
    });
  } catch (error) { await close(); throw error; }
}
