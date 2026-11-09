import { isDeepStrictEqual } from 'node:util';
import type { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';
import type { MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';
import { configuration } from '@/configuration';
import { fetchAccountProfile } from '@/api/accountProfile';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot, subscribeActiveAccountConfiguredExternalSessionSourceRevision } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { NativeUsageSourceBoundary, discoverNativeUsageSourceMetadata as DiscoverNativeUsageSourceMetadata } from '@/usage/collector/nativeUsageSourceDiscovery';
import type { createExternalSessionObservationDaemonProjection } from '@/api/session/external/leases/createExternalSessionObservationDaemonProjection';

export type MemoryExternalObservation = Pick<ReturnType<typeof createExternalSessionObservationDaemonProjection>, 'registerAccountingSource'>;
type ObservationDemand = Awaited<ReturnType<MemoryExternalObservation['registerAccountingSource']>>;

/** Daemon-admitted topology only: executable readers and watch handles never cross. */
export type MemoryExternalTranscriptSourceDescriptor = Readonly<{
  agentId: string;
  sourceKey: string;
  source: AgentExternalSessionSource;
  occurrenceId: string;
  observation?: Readonly<{ id: string; changedFiles?: readonly string[] }>;
}>;

export type MemoryExternalTranscriptSourceChange = Readonly<{
  agentId: string;
  sourceKey: string;
  refreshSources: boolean;
  changedNativeSessionIds?: readonly string[];
}>;

export type MemoryExternalTranscriptSourcesSnapshot = Readonly<{
  sources: readonly MemoryExternalTranscriptSourceDescriptor[];
  configuredSourceKeys: readonly string[];
  changes: readonly MemoryExternalTranscriptSourceChange[];
}>;

/** Configured topology and executable source readiness have distinct authority. */
export async function discoverMemoryExternalTranscriptSources(input: Parameters<typeof DiscoverNativeUsageSourceMetadata>[0]) {
  const [{ discoverNativeUsageSourceMetadata }, {
    materializeConfiguredExternalSessionSourceCandidates, resolveConfiguredExternalSessionSourceAtAdmission,
  }] = await Promise.all([import('@/usage/collector/nativeUsageSourceDiscovery'), import('@/session/external/configuredSourceMaterializer')]);
  const configuredSourceKeys = new Set<string>();
  for (const candidate of materializeConfiguredExternalSessionSourceCandidates(input)) {
    if (candidate.refusal) continue;
    const boundary = await input.resolveBoundary(candidate.agentId).catch(() => null);
    const admitted = await resolveConfiguredExternalSessionSourceAtAdmission({ ...input,
      agentId: candidate.agentId, source: candidate.source, catalogEntry: boundary?.catalogEntry ?? null });
    if (admitted.ok) configuredSourceKeys.add(JSON.stringify([candidate.agentId, admitted.sourceKey]));
  }
  const descriptors = await discoverNativeUsageSourceMetadata({ ...input, includeAccountingSource: false });
  return { descriptors, configuredSourceKeys };
}

/** Shared daemon observation survives each finite indexer lifetime. */
export function createMemoryExternalTranscriptObservation(input: Readonly<{
  credentials: StoredCredentials;
  onChange(refreshSources: boolean, cause?: 'registry'): void;
}>) {
  let observation: MemoryExternalObservation | null = null;
  let records: readonly Readonly<{ descriptor: Omit<MemoryExternalTranscriptSourceDescriptor, 'observation'>; demand: ObservationDemand | null }>[] = [];
  let configuredSourceKeys: readonly string[] = [];
  const changes = new Map<string, MemoryExternalTranscriptSourceChange>();
  // Native incremental readers key their filesystem preparation by this
  // incumbent observation lifetime. Carry its identity, never its AbortSignal.
  const observationIds = new WeakMap<AbortSignal, string>();
  const pendingObservations = new WeakMap<ObservationDemand, ReturnType<ObservationDemand['readObservation']>>();
  let nextObservationId = 0;
  let refreshAllSources = true;
  let stopped = false;
  let unsubscribeRegistry: (() => void) | null = null;
  let unsubscribeAccountSources: (() => void) | null = null;
  const lifetime = new AbortController();

  const changed = (change: MemoryExternalTranscriptSourceChange) => {
    const key = JSON.stringify([change.agentId, change.sourceKey]);
    const prior = changes.get(key);
    changes.set(key, { ...change, refreshSources: change.refreshSources || prior?.refreshSources === true,
      ...(prior && (!prior.changedNativeSessionIds || !change.changedNativeSessionIds)
        ? { changedNativeSessionIds: undefined }
        : change.changedNativeSessionIds ? { changedNativeSessionIds: [...new Set([...(prior?.changedNativeSessionIds ?? []), ...change.changedNativeSessionIds])] } : {}) });
    input.onChange(change.refreshSources);
  };

  const release = async () => {
    const prior = records;
    records = [];
    configuredSourceKeys = [];
    changes.clear();
    refreshAllSources = true;
    await Promise.all(prior.map(record => record.demand?.dispose()));
  };

  const stopWatching = () => {
    unsubscribeAccountSources?.();
    unsubscribeAccountSources = null;
    unsubscribeRegistry?.();
    unsubscribeRegistry = null;
  };

  const watchRegistry = async () => {
    if (unsubscribeRegistry) return;
    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    unsubscribeRegistry = pluginReloadController.subscribe(() => {
      refreshAllSources = true;
      for (const { descriptor } of records) changed({ agentId: descriptor.agentId, sourceKey: descriptor.sourceKey, refreshSources: true });
      input.onChange(true, 'registry');
    });
  };

  // Declaration subscriptions follow native selection, independently of the
  // shorter filesystem-observation and finite indexer lifetimes.
  const configure = async (settings: MemorySettingsV1, previous: MemorySettingsV1, registryChanged = false) => {
    const selectedIds = (value: MemorySettingsV1) => value.enabled && value.conversationSearch.indexExternal.enabled
      ? value.conversationSearch.indexExternal.agents : [];
    const selected = selectedIds(settings);
    const prior = selectedIds(previous);
    if (!registryChanged && selected.length === prior.length && selected.every(id => prior.includes(id))) return;
    refreshAllSources = true;
    unsubscribeAccountSources?.();
    unsubscribeAccountSources = null;
    if (stopped || selected.length === 0) {
      stopWatching();
      return;
    }
    await watchRegistry();
    const { tryAcquireAuthoritativePluginRuntimeRegistryLease } = await import('@/plugins/runtime/reload/runtimeLease');
    const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
    if (!lease) return;
    try {
      const declarations = lease.registry.contributes.agents.filter(agent => selected.includes(agent.id))
        .flatMap(agent => agent.richDefinition?.definition.surfaces?.externalSession?.sources ?? []);
      if (declarations.length === 0) return;
      unsubscribeAccountSources = subscribeActiveAccountConfiguredExternalSessionSourceRevision(
        () => { refreshAllSources = true; input.onChange(true); }, declarations, configuration.activeServerId);
    } finally { await lease.release(); }
  };

  const acquire = async (agentId: string): Promise<NativeUsageSourceBoundary | null> => {
    const [{ readRegistryCatalogHook }, { acquireAuthoritativePluginRuntimeRegistryLease }] = await Promise.all([
      import('@/agent/catalog/runtimeEntry'), import('@/plugins/runtime/reload/runtimeLease'),
    ]);
    const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
      const catalogEntry = await readRegistryCatalogHook(lease.registry, agentId, entry => entry);
      const runtime = lease.registry.agentRuntimesByAgentId.get(agentId);
      return runtime?.externalSessions && runtime.isCurrent() && !runtime.retirementSignal.aborted
        ? { catalogEntry, externalSessions: runtime.externalSessions, occurrenceId: runtime.occurrenceId,
          retirementSignal: runtime.retirementSignal, isCurrent: runtime.isCurrent } : null;
    } finally { await lease.release(); }
  };

  const refresh = async (settings: MemorySettingsV1, signal: AbortSignal) => {
    if (stopped || !settings.enabled || !settings.conversationSearch.indexExternal.enabled
      || settings.conversationSearch.indexExternal.agents.length === 0) {
      stopWatching();
      await release();
      return;
    }
    if (!observation) { await release(); return; }
    const operationSignal = AbortSignal.any([signal, lifetime.signal]);
    await watchRegistry();
    const [{ acquireAuthoritativePluginRuntimeRegistryLease }, { configuredExternalSessionSourcesUseConnectedProfiles },
      { resolveNativeUsageSourceMetadata }] = await Promise.all([
      import('@/plugins/runtime/reload/runtimeLease'), import('@/session/external/configuredSourceMaterializer'),
      import('@/usage/collector/nativeUsageSourceDiscovery'),
    ]);
    const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    const agents = lease.registry.contributes.agents;
    await lease.release();
    const selected = agents.filter(agent => settings.conversationSearch.indexExternal.agents.includes(agent.id));
    const account = configuredExternalSessionSourcesUseConnectedProfiles(selected)
      ? await fetchAccountProfile({ token: input.credentials.token, signal: operationSignal }) : { connectedServicesV2: [] };
    const fullRefresh = refreshAllSources;
    refreshAllSources = false;
    // Observation hints already name the invalidated source. Unscoped
    // discovery (initial, explicit, settings or registry) stays full.
    const scopedRefresh = !fullRefresh && changes.size > 0;
    const invalidatedSources = new Set([...changes].filter(([, change]) => change.refreshSources).map(([key]) => key));
    const prior = new Set(records);
    const retained = new Map(records.map(record => [JSON.stringify([record.descriptor.agentId, record.descriptor.sourceKey]), record]));
    const next: typeof records[number][] = [];
    try {
      const { descriptors, configuredSourceKeys: nextConfiguredSourceKeys } = await discoverMemoryExternalTranscriptSources({ agents: selected, account,
        agentSettings: getActiveAccountSettingsSnapshot()?.settings,
        activeServerId: configuration.activeServerId, activeServerDir: configuration.activeServerDir,
        resolveBoundary: acquire, signal: operationSignal });
      operationSignal.throwIfAborted();
      for (const descriptor of descriptors) {
        const agentId = selected.find(agent => agent.identity?.pluginId === descriptor.agent.pluginId
          && agent.identity.localId === descriptor.agent.localId)?.id;
        if (!agentId) continue;
        const boundary = await acquire(agentId);
        if (!boundary) continue;
        const sourceKey = descriptor.configuredSourceKey ?? descriptor.sourceKey;
        const key = JSON.stringify([agentId, sourceKey]);
        const previous = retained.get(key);
        if (scopedRefresh && !invalidatedSources.has(key) && previous
          && previous.descriptor.occurrenceId === boundary.occurrenceId
          && isDeepStrictEqual(previous.descriptor.source, descriptor.source)) {
          next.push(previous);
          continue;
        }
        const resolved = await resolveNativeUsageSourceMetadata({ agents: selected, agentId,
          source: descriptor.source, boundary, activeServerDir: configuration.activeServerDir, signal: operationSignal });
        if (!resolved) continue;
        const sourceObservation = resolved.metadata.accountingSource;
        const demand = sourceObservation ? await observation.registerAccountingSource({
          resource: { pluginId: descriptor.agent.pluginId, agentLocalId: descriptor.agent.localId,
            occurrenceId: boundary.occurrenceId, resourceKey: sourceObservation.resourceKey,
            retirementSignal: AbortSignal.any([lifetime.signal, boundary.retirementSignal]) },
          source: resolved.descriptor.source, changeObservation: sourceObservation.changeObservation,
          ...(sourceObservation.watchFileChanges ? { watchFileChanges: sourceObservation.watchFileChanges } : {}),
          onChange: ({ reason, changedNativeSessionIds }) => changed({ agentId, sourceKey,
            refreshSources: reason !== 'file_changed', ...(changedNativeSessionIds ? { changedNativeSessionIds } : {}) }),
        }) : null;
        next.push({ descriptor: { agentId, sourceKey, source: resolved.descriptor.source, occurrenceId: boundary.occurrenceId }, demand });
      }
      operationSignal.throwIfAborted();
      records = next;
      configuredSourceKeys = [...nextConfiguredSourceKeys];
    } catch (error) {
      refreshAllSources ||= fullRefresh;
      await Promise.all(next.filter(record => !prior.has(record)).map(record => record.demand?.dispose()));
      throw error;
    }
    const active = new Set(next);
    await Promise.all([...prior].filter(record => !active.has(record)).map(record => record.demand?.dispose()));
  };

  const getSnapshot = (): MemoryExternalTranscriptSourcesSnapshot => ({
    sources: records.map(({ descriptor, demand }) => {
      const current = demand?.readObservation();
      const pending = demand ? pendingObservations.get(demand) : undefined;
      const snapshot = current && pending?.lifetime === current.lifetime
        ? { lifetime: current.lifetime, ...(pending.changedFiles && current.changedFiles
          ? { changedFiles: [...new Set([...pending.changedFiles, ...current.changedFiles])] } : {}) }
        : current;
      if (demand && snapshot) pendingObservations.set(demand, snapshot);
      if (!snapshot || snapshot.lifetime.aborted) return descriptor;
      let id = observationIds.get(snapshot.lifetime);
      if (!id) { id = String(++nextObservationId); observationIds.set(snapshot.lifetime, id); }
      return { ...descriptor, observation: { id, ...('changedFiles' in snapshot && snapshot.changedFiles ? { changedFiles: snapshot.changedFiles } : {}) } };
    }),
    configuredSourceKeys,
    changes: [...changes.values()],
  });

  return {
    configure, refresh, release, getSnapshot,
    hasPendingChanges: () => changes.size > 0,
    takeSnapshot() {
      const snapshot = getSnapshot();
      changes.clear();
      for (const { demand } of records) if (demand) pendingObservations.delete(demand);
      return snapshot;
    },
    attach(next: MemoryExternalObservation) {
      observation = next;
      refreshAllSources = true;
      input.onChange(true);
      return () => { if (observation === next) { observation = null; input.onChange(true); } };
    },
    async dispose() {
      stopped = true;
      lifetime.abort();
      stopWatching();
      await release();
      observation = null;
    },
  };
}
