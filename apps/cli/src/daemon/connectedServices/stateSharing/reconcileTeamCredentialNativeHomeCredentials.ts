import { join } from 'node:path';
import type { ActionExecutorDeps, TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol';

import { readConnectedServiceHomeDirectoryNames } from '../homes/inventory';
import { listConnectedServiceMaterializedIdentityRoots } from '../materialize/cleanup/ConnectedServiceMaterializedHomeCleanupScheduler';
import { runSerializedMaterializationPromotion } from '../materialize/rootQueue';
import { readSessionTeamCredentialResourceCatalog } from '@/session/services/sessionTeamCredentialCatalog';
import { readExistingConnectedServiceStateSharingManifest, writeConnectedServiceStateSharingManifest } from './connectedServiceStateSharingManifest';
import { removeConnectedServiceNativeHomeCredentials } from './materializeConnectedServiceNativeHomeCredentials';

/** The daemon owns only these Account-local staging homes. Agent-UID launch
 * material is removed by its existing child-finally cleanup at process exit. */
export async function reconcileTeamCredentialNativeHomeCredentials(input: Readonly<{
  baseDir: string;
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  signal?: AbortSignal;
}>): Promise<void> {
  const resources = new Map<string, Promise<readonly TeamCredentialResourceCatalogEntryV1[]>>();
  const failures: unknown[] = [];
  const reconcileHome = async (home: string): Promise<boolean> => {
    try {
      return await runSerializedMaterializationPromotion(home, async () => {
        const manifest = await readExistingConnectedServiceStateSharingManifest(home);
        if (!manifest) return false;
        if (!manifest.teamCredentialDeliveries?.length) return true;
        const retained = [];
        for (const delivery of manifest.teamCredentialDeliveries) {
          input.signal?.throwIfAborted();
          const key = JSON.stringify([delivery.teamId ?? null, delivery.resourceId]);
          let current = resources.get(key);
          if (!current) {
            current = readSessionTeamCredentialResourceCatalog({
              homeDomainAction: input.homeDomainAction, applications: [], resourceId: delivery.resourceId,
              ...(delivery.teamId ? { teamIds: [delivery.teamId] } : {}),
              ...(input.signal ? { signal: input.signal } : {}),
            });
            resources.set(key, current);
          }
          const rows = await current;
          const resource = rows.find(row => row.id === delivery.resourceId);
          // Successful absence is Home's unentitled answer. A source outage,
          // corrupt projection, stale tuple or transport failure cannot prove withdrawal.
          const withdrawn = !resource || resource.readiness.kind === 'available' && !resource.mayReceiveDirect;
          if (!withdrawn) { retained.push(delivery); continue; }
          await removeConnectedServiceNativeHomeCredentials({ targetRoot: home, declaredSecretEntries: delivery.credentialPaths,
            expectedFileDigests: delivery.credentialFileDigests ?? {} });
        }
        if (retained.length !== manifest.teamCredentialDeliveries.length) {
          await writeConnectedServiceStateSharingManifest(home, { ...manifest, teamCredentialDeliveries: retained }, undefined, manifest);
        }
        return true;
      }, input.signal);
    } catch (error) {
      input.signal?.throwIfAborted();
      failures.push(error);
      return true;
    }
  };
  for (const identity of await listConnectedServiceMaterializedIdentityRoots(input.baseDir)) {
    input.signal?.throwIfAborted();
    // The existing hierarchy has either routing-id or plugin/local-id homes.
    // Recognize stored manifests even after plugin uninstall, and stop at a home;
    // never traverse native state, attempts, or another requester's namespace.
    for (const directory of await readConnectedServiceHomeDirectoryNames(identity.path)) {
      const home = join(identity.path, directory);
      if (await reconcileHome(home)) continue;
      for (const localId of await readConnectedServiceHomeDirectoryNames(home)) await reconcileHome(join(home, localId));
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Team delivered credential cleanup failed');
}
