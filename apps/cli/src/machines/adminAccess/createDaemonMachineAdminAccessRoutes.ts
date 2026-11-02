import type { ApiMachineClient } from '@/api/apiMachine';
import type { DaemonMachineAdminAccessRoutes } from '@/rpc/handlers/daemonMachineAdminAccess';
import { createMachineAdminAccessObserver, type MachineAdminAccessNativeDependencies } from '@/machines/adminAccess/observeMachineAdminAccess';
import { createMachineAdminAccessHost } from './machineAdminAccessHost';
import { resolveInstalledMachineEffectCli, type MachineElevationSpawn } from './runElevatedEffect';
import { getMachineAdminAccessV1 } from '@happier-dev/protocol';

/** Compose the unprivileged native reader with its incumbent daemon-state writer. */
export function createDaemonMachineAdminAccessRoutes(input: Readonly<{
  target: DaemonMachineAdminAccessRoutes['target'];
  getMachineClient: () => Pick<ApiMachineClient, 'updateDaemonState'> | null;
  nativeDependencies?: MachineAdminAccessNativeDependencies;
  spawnElevation?: MachineElevationSpawn;
}>): DaemonMachineAdminAccessRoutes {
  const observer = createMachineAdminAccessObserver({ ...input.nativeDependencies,
    onChanged: async observation => {
      const current = input.getMachineClient();
      if (!current) throw new Error('machine_admin_access_publication_unavailable');
      const outcome = await current.updateDaemonState(state => {
        if (!state) throw new Error('machine_admin_access_publication_unavailable');
        return { ...state, adminAccess: observation };
      });
      if (outcome === 'suppressed') throw new Error('machine_admin_access_publication_unavailable');
    },
  });
  return { observer, target: input.target, reconcile: async ({ port, inspect, installationId, emit, prompt, ...transition }) => {
    const host = createMachineAdminAccessHost({ installationId, installedCli: resolveInstalledMachineEffectCli(),
      readPolicy: async () => {
        const current = await getMachineAdminAccessV1(port);
        if (current.status !== 'ready') throw new Error('machine_admin_access_policy_unavailable');
        return current.policy;
      },
      observe: async () => (await inspect()).observation,
      ...(emit ? { emit } : {}), ...(prompt ? { prompt } : {}), ...(input.spawnElevation ? { spawn: input.spawnElevation } : {}),
    });
    return host.reconcile(transition);
  } };
}
