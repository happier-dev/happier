import type { ServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import type { StoredCredentials } from '@/persistence';
import type { DaemonPluginAvailabilityReporter } from '@/plugins/daemon/runtimeOwner';
import { logger } from '@/ui/logger';

import {
  createServerPluginAvailabilityPublisher,
  isPluginAvailabilityReleaseContentConflictError,
} from './serverPublisher';

/**
 * Binds the install registry's exact persisted Availability facts to the
 * daemon's live transport identity. The registry remains the only owner of
 * releases and materializations; this seam supplies neither source selection
 * nor lifecycle state.
 */
export function createDaemonPluginAvailabilityReporter(params: Readonly<{
  credentials: StoredCredentials;
  serverFeaturesSnapshotStore: Pick<ServerFeaturesSnapshotStore, 'getSnapshot'>;
  getMachineId: () => string;
}>): DaemonPluginAvailabilityReporter {
  const publisher = createServerPluginAvailabilityPublisher({
    credentials: params.credentials,
  });

  return Object.freeze({
    async report(inventory) {
      const snapshot = params.serverFeaturesSnapshotStore.getSnapshot();
      const serverIdentityId = snapshot?.status === 'ready'
        ? snapshot.features.capabilities.serverIdentity.serverIdentityId
        : null;
      if (!serverIdentityId) return;

      for (const release of inventory.releasePublications) {
        try {
          await publisher.publishRelease(release);
        } catch (error) {
          if (!isPluginAvailabilityReleaseContentConflictError(error)) throw error;
          const { pluginId, version } = release.facts.ref;
          // Materialization evidence is intentionally retained. The Account
          // release owner classifies its digest mismatch as a visible conflict
          // and exact-currentness continues to reject it; filtering would hide
          // the required version-bump diagnosis from every consumer.
          logger.warn('[PLUGIN AVAILABILITY] Release-content conflict retained for Account availability classification; publish a new version', {
            pluginId,
            version,
          });
        }
      }

      const machineId = params.getMachineId();
      await publisher.reportMaterializations({
        snapshot: {
          serverIdentityId,
          machineId,
          revision: inventory.revision,
          materializations: inventory.materializations
            .map((materialization) => ({
              ...materialization,
              serverIdentityId,
              machineId,
            })),
        },
      });
    },
  });
}
