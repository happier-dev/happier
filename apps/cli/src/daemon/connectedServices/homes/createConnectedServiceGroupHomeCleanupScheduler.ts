import { readBuiltInLegacyConnectedAccountServiceKeyIngress, type ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { resolveTrackedSessionCatalogAgentId } from '../../sessions/resolveTrackedSessionCatalogAgentId';
import type { TrackedSession } from '../../types';
import type { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { hasTrackedConnectedServiceGroupBinding, resolveTrackedConnectedServiceBindingsRaw } from '../trackedSessionConnectedServiceBindings';
import { parseConnectedServicesBindings } from '../parseConnectedServicesBindings';
import {
  ConnectedServiceGroupHomeCleanupScheduler,
  type ConnectedServiceGroupDeletionAuthority,
} from './ConnectedServiceGroupHomeCleanupScheduler';

export function createConnectedServiceGroupHomeCleanupScheduler(params: Readonly<{
  activeServerDir: string;
  additionalAccountHomeRoots?: readonly string[];
  runtimeRegistry?: ConnectedServiceRuntimeRegistry;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  groupExists?: (target: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>) => Promise<boolean>;
  resolveGroupDeletionAuthority?: (target: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>) => Promise<ConnectedServiceGroupDeletionAuthority>;
}>): ConnectedServiceGroupHomeCleanupScheduler {
  return new ConnectedServiceGroupHomeCleanupScheduler({
    activeServerDir: params.activeServerDir,
    additionalAccountHomeRoots: params.additionalAccountHomeRoots,
    runtimeRegistry: params.runtimeRegistry,
    groupExists: params.groupExists,
    resolveGroupDeletionAuthority: params.resolveGroupDeletionAuthority,
    hasLiveAccountTarget: account => {
      const serviceKey = buildQualifiedPluginContributionKey(account.service);
      return [...params.pidToTrackedSession.values()].some(tracked =>
        parseConnectedServicesBindings(resolveTrackedConnectedServiceBindingsRaw(tracked)).some(binding =>
          binding.serviceId === serviceKey && binding.profileId === account.accountId));
    },
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
