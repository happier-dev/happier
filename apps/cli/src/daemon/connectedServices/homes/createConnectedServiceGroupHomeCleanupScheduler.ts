import type { ConnectedServiceId } from '@happier-dev/protocol';

import { resolveDaemonCatalogAgentIdFromBackendTarget } from '../../backendTargetRouting';
import type { TrackedSession } from '../../types';
import { parseConnectedServiceBindingSelections } from '../parseConnectedServicesBindings';
import { ConnectedServiceGroupHomeCleanupScheduler } from './ConnectedServiceGroupHomeCleanupScheduler';

export function createConnectedServiceGroupHomeCleanupScheduler(params: Readonly<{
  activeServerDir: string;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  groupExists?: (target: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>) => Promise<boolean>;
}>): ConnectedServiceGroupHomeCleanupScheduler {
  return new ConnectedServiceGroupHomeCleanupScheduler({
    activeServerDir: params.activeServerDir,
    groupExists: params.groupExists,
    hasLiveTarget: ({ serviceId, groupId, agentId }) => {
      for (const tracked of params.pidToTrackedSession.values()) {
        const trackedAgentId = resolveDaemonCatalogAgentIdFromBackendTarget(tracked.spawnOptions?.backendTarget);
        if (trackedAgentId !== agentId) continue;
        const hasMatchingSelection = parseConnectedServiceBindingSelections(tracked.spawnOptions?.connectedServices)
          .some((selection) => selection.kind === 'group' && selection.serviceId === serviceId && selection.groupId === groupId);
        if (hasMatchingSelection) {
          return true;
        }
      }
      return false;
    },
  });
}
