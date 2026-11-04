import type { RegistryHostDepsV1 } from '@happier-dev/protocol/registries';
import { checkRegistryUpstreamV1, registryUpstreamEqualV1, RegistryFetchErrorV1,
  type RegistryFetchContextV1, type RegistryKindV1, type RegistryProvenanceV1,
  type RegistrySourceDescriptorV1, type RegistryUpstreamV1, type RegistryUpstreamCheckV1, type RegistryUpdateCheckResultV1 } from '@happier-dev/protocol/registries';

type RegistryTrackedItemV1 = Readonly<{
  key: string; provenance?: RegistryProvenanceV1; upstream?: RegistryUpstreamV1;
  /** Installed native package baseline, retained through observation recording. */
  installedVersion?: string;
  /** A link's tracked repository descriptor, derived by its owning tracker. */
  source?: RegistrySourceDescriptorV1;
}>;

export type RegistryUpdateTrackerV1 = Readonly<{
  kind: 'skill' | 'mcpServer' | 'agent' | 'browserExtension';
  list: () => Promise<readonly RegistryTrackedItemV1[]>;
  /** Source-native versions use the same check/record lifecycle without invented catalog provenance. */
  check?: (items: readonly RegistryTrackedItemV1[]) => Promise<ReadonlyMap<string, RegistryUpstreamCheckV1>>;
  record: (changes: readonly Readonly<{
    key: string; upstream: RegistryUpstreamV1;
    /** The kind's CAS refuses an observation if its installed baseline moved. */
    provenance?: RegistryProvenanceV1;
    installedVersion?: string;
  }>[]) => Promise<void>;
  /** Revisit an unchanged pending update when the user has since opted into auto. */
  applyAutomaticUpdates?: (observations: Parameters<RegistryUpdateTrackerV1['record']>[0]) => Promise<void>;
}>;

export type RegistryUpdateCheckFilterV1 = Readonly<{ kind?: RegistryKindV1; keys?: readonly string[] }>;

export function createRegistryUpdateCheck(params: Readonly<{
  admitSource?: RegistryHostDepsV1['admitSource'];
  trackers: readonly RegistryUpdateTrackerV1[];
  ctx: RegistryFetchContextV1;
  readSources: () => Promise<readonly RegistrySourceDescriptorV1[]>;
}>): Readonly<{
  checkNow: (filter?: RegistryUpdateCheckFilterV1) => Promise<RegistryUpdateCheckResultV1>;
  runBackgroundAutoUpdateCheck: () => Promise<void>;
}> {
  const checkNow = async (filter: RegistryUpdateCheckFilterV1 = {}): Promise<RegistryUpdateCheckResultV1> => {
    params.ctx.signal?.throwIfAborted();
    const groups = await Promise.all(params.trackers.filter(tracker => !filter.kind || tracker.kind === filter.kind).map(async tracker => ({
      tracker, items: (await tracker.list()).filter(item => !filter.keys || filter.keys.includes(item.key)),
    })));
    params.ctx.signal?.throwIfAborted();
    const listed = groups.flatMap(group => group.items.map(item => ({ tracker: group.tracker, item })));
    if (listed.length === 0) return { checkedAt: Date.now(), results: [] };
    const observations = new Map<string, RegistryUpstreamCheckV1>();
    const projected: RegistrySourceDescriptorV1[] = [];
    await Promise.all(groups.filter(group => group.tracker.check && group.items.length > 0).map(async group => {
      const native = await group.tracker.check!(group.items);
      for (const [index, entry] of listed.entries()) {
        if (entry.tracker !== group.tracker) continue;
        const observation = native.get(entry.item.key);
        if (!observation) throw new Error('registry_update_observation_missing');
        observations.set(String(index), observation);
      }
    }));
    const catalogItems = listed.flatMap(({ tracker, item }, index) => {
      if (tracker.check) return [];
      if (!item.provenance) throw new Error('registry_update_provenance_missing');
      return [{ key: String(index), provenance: item.provenance }];
    });
    if (catalogItems.length > 0) {
      try {
        const sources = await params.readSources();
        params.ctx.signal?.throwIfAborted();
        projected.push(...sources);
        for (const { item } of listed) {
          if (item.source && !projected.some(source => source.id === item.source!.id)) projected.push(item.source);
        }
        // Run-local keys preserve independent tracked kinds that share an item key.
        const catalog = await checkRegistryUpstreamV1(params.ctx, { sources: projected, admitSource: params.admitSource,
          items: catalogItems });
        for (const [key, observation] of catalog) observations.set(key, observation);
      } catch (error) {
        params.ctx.signal?.throwIfAborted();
        if (!(error instanceof RegistryFetchErrorV1)) throw error;
        for (const { key } of catalogItems) observations.set(key, { state: 'unchecked', reason: error.status });
      }
    }
    params.ctx.signal?.throwIfAborted();
    const results: RegistryUpdateCheckResultV1['results'][number][] = [];
    const changes = new Map<RegistryUpdateTrackerV1, Parameters<RegistryUpdateTrackerV1['record']>[0][number][]>();
    const automatic = new Map<RegistryUpdateTrackerV1, Parameters<RegistryUpdateTrackerV1['record']>[0][number][]>();
    for (const [index, { tracker, item }] of listed.entries()) {
      const upstream = observations.get(String(index));
      if (!upstream) throw new Error('registry_update_observation_missing');
      results.push({ kind: tracker.kind, key: item.key, upstream });
      if (upstream.state === 'unchecked') continue;
      const observation = { key: item.key, upstream,
        ...(item.provenance ? { provenance: item.provenance } : {}),
        ...(item.installedVersion ? { installedVersion: item.installedVersion } : {}) };
      if (registryUpstreamEqualV1(item.upstream, upstream)) {
        if (upstream.state === 'update_available' && tracker.applyAutomaticUpdates) {
          const pending = automatic.get(tracker) ?? [];
          pending.push(observation); automatic.set(tracker, pending);
        }
        continue;
      }
      const records = changes.get(tracker) ?? [];
      records.push(observation); changes.set(tracker, records);
    }
    await Promise.all([...changes].map(async ([tracker, records]) => {
      params.ctx.signal?.throwIfAborted();
      await tracker.record(records);
    }));
    await Promise.all([...automatic].map(async ([tracker, observations]) => {
      params.ctx.signal?.throwIfAborted();
      await tracker.applyAutomaticUpdates!(observations);
    }));
    params.ctx.signal?.throwIfAborted();
    return { checkedAt: Date.now(), results };
  };
  return { checkNow, runBackgroundAutoUpdateCheck: async () => { await checkNow(); } };
}
