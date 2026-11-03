import { join } from 'node:path';
import { getFirstPartyComponentCatalogEntry, resolveFirstPartyInstallLayout, resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { getMachineAdminAccessV1 } from '@happier-dev/protocol';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { DaemonMachineAdminAccessRoutes } from '@/rpc/handlers/daemonMachineAdminAccess';
import type { AgentIsolationEffectDependencies } from './agentIsolationProvisioner';

/** The daemon's exact-Machine metadata and Workspace census remain authorities. */
export function createDaemonAgentIsolationEffects(input: Readonly<{
  getMachineClient(): Pick<ApiMachineClient, 'getMachineMetadataSnapshot' | 'compareAndSwapMachineMetadata' | 'publishAgentIsolationStatus'> | null;
  adminAccess: Pick<DaemonMachineAdminAccessRoutes, 'target' | 'observer'>;
  readRoots: AgentIsolationEffectDependencies['readRoots'];
  trackedSessions: ReadonlyMap<number, unknown>;
  protectedRoots: readonly string[];
  privateRoots: readonly string[];
  readMemberBindingScope?: AgentIsolationEffectDependencies['readMemberBindingScope'];
}>): AgentIsolationEffectDependencies {
  const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', channel: resolveManagedCliReleaseChannelSync().ringId });
  const installedCli = join(layout.currentPath, getFirstPartyComponentCatalogEntry('happier-cli').binaryRelativePath);
  return { platform: process.platform, installedCli, readRoots: input.readRoots, nativeReadiness: { privateRoots: input.privateRoots },
    // Retained entries remain in custody until the existing exit observer
    // finishes retirement. A requested stop, pause or unknown identity is live.
    readSessionsToReplace: () => input.trackedSessions.size,
    protectedRoots: input.protectedRoots,
    readMemberBindingScope: input.readMemberBindingScope,
    readDaemonObservation: () => input.adminAccess.observer.read(),
    elevation: { get installationId() { return input.adminAccess.target()?.installationId ?? ''; }, installedCli,
      readPolicy: async () => {
        const current = await getMachineAdminAccessV1({
          read: async () => input.getMachineClient()?.getMachineMetadataSnapshot() ?? { status: 'unavailable' },
          compareAndSwap: async () => ({ status: 'unavailable' }),
        });
        if (current.status !== 'ready') throw new Error('machine_admin_access_policy_unavailable');
        return current.policy;
      },
      observe: async () => (await input.adminAccess.observer.inspect()).observation,
    },
    publishStatus: async status => {
      const client = input.getMachineClient();
      if (!client) throw new Error('machine_agent_isolation_publication_unavailable');
      await client.publishAgentIsolationStatus(status);
    },
  };
}
