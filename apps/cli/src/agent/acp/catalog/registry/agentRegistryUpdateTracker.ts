import { isDeepStrictEqual } from 'node:util';
import { registryUpstreamEqualV1 } from '@happier-dev/protocol/registries';
import type { CliAcpCatalogStore } from '../acpCatalogStore';
import { requireReadyAcpCatalog } from '../configured/resolveBackend';
import type { RegistryUpdateTrackerV1 } from '@/registries/updates/registryUpdateTracker';
import { AcpCatalogRecordV1Schema, type AcpCatalogRecordV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

/** Observations use the existing Account catalog CAS and never advance a launch pin. */
export function createAgentRegistryUpdateTracker(input: Readonly<{
  store: Pick<CliAcpCatalogStore, 'readCatalog' | 'updateCatalog'>;
}>): RegistryUpdateTrackerV1 {
  const current = async () => requireReadyAcpCatalog(await input.store.readCatalog());
  return {
    kind: 'agent',
    async list(keys) {
      if (keys?.length === 0) return [];
      const selected = keys ? new Set(keys) : undefined;
      return (await current()).record.definitions.flatMap(definition => (!selected || selected.has(definition.id)) && definition.origin?.kind === 'registry' ? [{
        key: definition.id, provenance: definition.origin.provenance,
        ...(definition.origin.upstream ? { upstream: definition.origin.upstream } : {}),
      }] : []);
    },
    async record(changes) {
      if (changes.length === 0) return;
      const byKey = new Map(changes.map(change => [change.key, change]));
      const shouldRecord = (origin: AcpCatalogRecordV1['definitions'][number]['origin'],
        change: typeof changes[number]) => origin?.kind === 'registry'
        && (!change.provenance || isDeepStrictEqual(origin.provenance, change.provenance))
        && !registryUpstreamEqualV1(origin.upstream, change.upstream);
      const attempted: typeof changes[number][] = [];
      const result = await input.store.updateCatalog(raw => {
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: raw && typeof raw === 'object' ? Reflect.get(raw, 'backends') : undefined });
        const backends = record.definitions.map(entry => {
          const change = byKey.get(entry.id);
          if (!change || !entry.origin || !shouldRecord(entry.origin, change)) return entry;
          attempted.push(change);
          return { ...entry, origin: { ...entry.origin, upstream: change.upstream } };
        });
        return attempted.length > 0 ? { v: 2, backends } : raw;
      });
      if (result.status === 'updated' || result.status === 'unchanged') return;
      if (result.status === 'conflict') {
        const definitions = new Map((await current()).record.definitions.map(entry => [entry.id, entry]));
        if (attempted.every(change => !shouldRecord(definitions.get(change.key)?.origin, change))) return;
      }
      throw Object.assign(new Error('Agent registry observation was not recorded'), { code: `agent_registry_update_${result.status}` });
    },
  };
}
