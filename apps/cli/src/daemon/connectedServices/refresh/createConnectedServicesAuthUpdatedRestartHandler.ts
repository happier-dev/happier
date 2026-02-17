import type { CatalogAgentId } from '@/backends/types';
import type { TrackedSession } from '@/daemon/types';

type ConnectedServiceBindingRef = Readonly<{ serviceId: string; profileId: string }>;

type ConnectedServiceSpawnTargetRef = Readonly<{
  pid: number;
  agentId: CatalogAgentId;
}>;

export function createConnectedServicesAuthUpdatedRestartHandler(params: Readonly<{
  restartRequestedPids: Set<number>;
  pidToTrackedSession: Map<number, TrackedSession>;
  restartAgentIds: ReadonlySet<CatalogAgentId>;
}>): (event: Readonly<{
  binding: ConnectedServiceBindingRef;
  affectedTargets: ReadonlyArray<ConnectedServiceSpawnTargetRef>;
}>) => void {
  return (event) => {
    for (const target of event.affectedTargets) {
      if (!params.restartAgentIds.has(target.agentId)) continue;
      if (params.restartRequestedPids.has(target.pid)) continue;

      const tracked = params.pidToTrackedSession.get(target.pid);
      if (!tracked) continue;
      if (tracked.startedBy !== 'daemon') continue;
      if (tracked.reattachedFromDiskMarker) continue;
      if (!tracked.childProcess) continue;

      try {
        tracked.childProcess.kill('SIGTERM');
      } catch {
        continue;
      }
      params.restartRequestedPids.add(target.pid);
    }
  };
}
