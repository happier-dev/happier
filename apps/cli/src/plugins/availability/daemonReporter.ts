import type { ServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import type { StoredCredentials } from '@/persistence';
import type { DaemonPluginAvailabilityReporter } from '@/plugins/daemon/runtimeOwner';
import { logger } from '@/ui/logger';

import {
  createServerPluginAvailabilityPublisher,
  isPluginAvailabilityReleaseContentConflictError,
} from './serverPublisher';

type PendingAvailabilityReport = Readonly<{
  inventory: Parameters<DaemonPluginAvailabilityReporter['report']>[0];
}>;

type DrainResult =
  | Readonly<{ status: 'fulfilled' }>
  | Readonly<{ status: 'rejected'; error: unknown }>;

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
  signal?: AbortSignal;
}>): DaemonPluginAvailabilityReporter {
  const publisher = createServerPluginAvailabilityPublisher({
    credentials: params.credentials,
  });
  const publicationOptions: [options?: Readonly<{ signal: AbortSignal }>] = params.signal ? [{ signal: params.signal }] : [];

  let pendingLatest: PendingAvailabilityReport | null = null;
  let inFlight: Promise<void> | null = null;
  let lastAcknowledgedBody: string | null = null;
  let lastAcknowledgedServerRevision: number | null = null;

  const reportOne = async (initial: PendingAvailabilityReport): Promise<void> => {
    let current = initial;
    while (true) {
      params.signal?.throwIfAborted();
      const features = params.serverFeaturesSnapshotStore.getSnapshot();
      const serverIdentityId = features?.status === 'ready'
        ? features.features.capabilities.serverIdentity.serverIdentityId
        : null;
      if (!serverIdentityId) return;

      for (const release of current.inventory.releasePublications) {
        try {
          await publisher.publishRelease(release, ...publicationOptions);
        } catch (error) {
          if (!isPluginAvailabilityReleaseContentConflictError(error)) throw error;
          const { pluginId, version } = release.facts.ref;
          logger.warn('[PLUGIN AVAILABILITY] Release-content conflict retained for Account availability classification; publish a new version', {
            pluginId,
            version,
          });
        }
      }

      const machineId = params.getMachineId();
      const snapshot = {
        serverIdentityId,
        machineId,
        materializations: current.inventory.materializations.map((materialization) => ({
          ...materialization,
          serverIdentityId,
          machineId,
        })),
      };
      const body = JSON.stringify(snapshot);
      if (body === lastAcknowledgedBody) return;

      const result = await publisher.reportMaterializations({
        expectedRevision: lastAcknowledgedServerRevision,
        snapshot,
      }, ...publicationOptions);
      lastAcknowledgedServerRevision = result.revision;
      if (result.outcome !== 'conflict') {
        lastAcknowledgedBody = body;
        return;
      }

      // A conflict refreshes only this report seam's CAS token. If a newer
      // local commit arrived while this request was in flight, resend that
      // complete body rather than the superseded candidate.
      if (pendingLatest) {
        current = pendingLatest;
        pendingLatest = null;
      }
    }
  };

  const drain = async (): Promise<void> => {
    while (pendingLatest) {
      params.signal?.throwIfAborted();
      const current = pendingLatest;
      pendingLatest = null;
      try {
        await reportOne(current);
      } catch (error) {
        if (!pendingLatest) throw error;
      }
    }
  };

  const settleDrain = async (result: DrainResult): Promise<void> => {
    inFlight = null;
    if (params.signal?.aborted) {
      pendingLatest = null;
      params.signal.throwIfAborted();
    }
    if (pendingLatest) {
      await startDrain();
      return;
    }
    if (result.status === 'rejected') throw result.error;
  };

  function startDrain(): Promise<void> {
    const active = drain()
      .then<DrainResult, DrainResult>(
        () => ({ status: 'fulfilled' }),
        (error: unknown) => ({ status: 'rejected', error }),
      )
      .then(settleDrain);
    inFlight = active;
    return active;
  }

  return Object.freeze({
    report(inventory) {
      pendingLatest = { inventory };
      if (!inFlight) {
        inFlight = startDrain();
      }
      return inFlight;
    },
  });
}
