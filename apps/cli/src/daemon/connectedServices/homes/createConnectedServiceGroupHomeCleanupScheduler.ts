import { readBuiltInLegacyConnectedAccountServiceKeyIngress, type ConnectedServiceId } from '@happier-dev/protocol';

import { resolveTrackedSessionCatalogAgentId } from '../../sessions/resolveTrackedSessionCatalogAgentId';
import type { TrackedSession } from '../../types';
import { hasTrackedConnectedServiceGroupBinding } from '../trackedSessionConnectedServiceBindings';
import {
  ConnectedServiceGroupHomeCleanupScheduler,
  type ConnectedServiceGroupDeletionAuthority,
} from './ConnectedServiceGroupHomeCleanupScheduler';

export function createConnectedServiceGroupHomeCleanupScheduler(params: Readonly<{
  activeServerDir: string;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  groupExists?: (target: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>) => Promise<boolean>;
  resolveGroupDeletionAuthority?: (target: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>) => Promise<ConnectedServiceGroupDeletionAuthority>;
}>): ConnectedServiceGroupHomeCleanupScheduler {
  return new ConnectedServiceGroupHomeCleanupScheduler({
    activeServerDir: params.activeServerDir,
    groupExists: params.groupExists,
    resolveGroupDeletionAuthority: params.resolveGroupDeletionAuthority,
    hasLiveTarget: ({ serviceId, groupId, agentId }) => {
      // Group-home paths retain the bundled scalar service identity, while
      // current and released tracked bindings parse to qualified Account keys.
      const serviceKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(serviceId);
      if (!serviceKey) return false;
      for (const tracked of params.pidToTrackedSession.values()) {
        const trackedAgentId = resolveTrackedSessionCatalogAgentId(tracked);
        if (trackedAgentId !== agentId) continue;
        if (hasTrackedConnectedServiceGroupBinding({ tracked, serviceId: serviceKey, groupId })) {
          return true;
        }
      }
      return false;
    },
  });
}
