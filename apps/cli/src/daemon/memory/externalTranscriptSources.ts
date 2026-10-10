import type { Disposable } from '@happier-dev/plugin-sdk';
import type { MemoryExternalTranscriptSourceV1 } from '@happier-dev/protocol/memory/memorySearch';
import type { MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';
import type { MemoryIndexSourceStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import type { DeepIndexDbHandle } from './deepIndex/deepIndexDb';
import { configuration } from '@/configuration';
import { fetchAccountProfile } from '@/api/accountProfile';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { NativeUsageSourceBoundary } from '@/usage/collector/nativeUsageSourceDiscovery';
import type { discoverNativeUsageSourceMetadata } from '@/usage/collector/nativeUsageSourceDiscovery';
import type { createExternalSessionObservationDaemonProjection } from '@/api/session/external/leases/createExternalSessionObservationDaemonProjection';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from '@/session/external/agentExternalSessionsInvocation';
import { externalMemoryStorageId, type MemoryExternalSourceReader } from './externalTranscriptIndex';

export type MemoryExternalObservation = Pick<ReturnType<typeof createExternalSessionObservationDaemonProjection>, 'registerAccountingSource'>;

type MemoryExternalTranscriptCandidate = Readonly<{
  source: MemoryExternalTranscriptSourceV1;
  native: MemoryExternalSourceReader;
}>;

/** The incumbent source inventory owns its one in-memory traversal position. */
export function createMemoryExternalTranscriptTraversal() {
  let candidates: readonly MemoryExternalTranscriptCandidate[] = [];
  let candidateIndex = 0;
  const results = new Map<string, 'current' | 'more' | 'removed' | 'error'>();
  return {
    replace(next: readonly MemoryExternalTranscriptCandidate[]) {
      const upcoming = candidates.length ? candidates[candidateIndex % candidates.length] : undefined;
      const upcomingId = upcoming ? externalMemoryStorageId(upcoming.source) : null;
      const retainedIndex = upcomingId === null ? -1
        : next.findIndex(candidate => externalMemoryStorageId(candidate.source) === upcomingId);
      const retainedIds = new Set(next.map(candidate => externalMemoryStorageId(candidate.source)));
      for (const id of results.keys()) if (!retainedIds.has(id)) results.delete(id);
      candidates = next;
      candidateIndex = next.length ? retainedIndex >= 0 ? retainedIndex : candidateIndex % next.length : 0;
    },
    size() { return candidates.length; },
    invalidate(agentId?: string, sourceKey?: string) {
      for (const candidate of candidates) {
        if ((agentId === undefined || candidate.source.agentId === agentId)
          && (sourceKey === undefined || candidate.source.sourceKey === sourceKey)) results.delete(externalMemoryStorageId(candidate.source));
      }
    },
    noteSyncResult(source: MemoryExternalTranscriptSourceV1, state: 'current' | 'more' | 'removed' | 'error') {
      results.set(externalMemoryStorageId(source), state);
    },
    getIndexSources(db: Pick<DeepIndexDbHandle, 'getExternalSourceState'> | null): MemoryIndexSourceStatusV1[] {
      const groups = new Map<string, MemoryIndexSourceStatusV1>();
      for (const candidate of candidates) {
        const { agentId, sourceKey } = candidate.source;
        const id = externalMemoryStorageId(candidate.source);
        const result = results.get(id);
        const state = result === 'error' ? 'error' : result === 'current' && db?.getExternalSourceState({ sessionId: id })?.coverageComplete === true ? 'ready' : 'indexing';
        const key = JSON.stringify([agentId, sourceKey]);
        const previous = groups.get(key);
        if (!previous || state === 'error' || (previous.state !== 'error' && state !== 'ready')) {
          groups.set(key, { source: { type: 'external_transcript', agentId, sourceKey }, state });
        }
      }
      return [...groups.values()];
    },
    take(count: number) {
      const result: MemoryExternalTranscriptCandidate[] = [];
      for (let i = 0; i < Math.min(count, candidates.length); i++) {
        result.push(candidates[candidateIndex]!);
        candidateIndex = (candidateIndex + 1) % candidates.length;
      }
      return result;
    },
  };
}

/** Configured topology and executable source readiness have distinct authority. */
export async function discoverMemoryExternalTranscriptSources(input: Parameters<typeof discoverNativeUsageSourceMetadata>[0]) {
  const [{ discoverNativeUsageSourceMetadata }, {
    materializeConfiguredExternalSessionSourceCandidates, resolveConfiguredExternalSessionSourceAtAdmission,
  }] = await Promise.all([import('@/usage/collector/nativeUsageSourceDiscovery'), import('@/session/external/configuredSourceMaterializer')]);
  const configuredSourceKeys = new Set<string>();
  for (const candidate of materializeConfiguredExternalSessionSourceCandidates(input)) {
    if (candidate.refusal) continue;
    const admitted = resolveConfiguredExternalSessionSourceAtAdmission({ ...input,
      agentId: candidate.agentId, source: candidate.source });
    if (admitted.ok) configuredSourceKeys.add(JSON.stringify([candidate.agentId, admitted.sourceKey]));
  }
  const descriptors = await discoverNativeUsageSourceMetadata(input);
  return { descriptors, configuredSourceKeys };
}

/** Configured native sources consume the incumbent observation resource owner. */
export function createMemoryExternalTranscriptSources(input: Readonly<{
  credentials: StoredCredentials;
  onChange(): void;
}>) {
  let observation: MemoryExternalObservation | null = null;
  let records: ReadonlyArray<MemoryExternalSourceReader & { demand: Disposable | null }> = [];
  let dirty = true;
  const traversal = createMemoryExternalTranscriptTraversal();
  let configuredSourceKeys = new Set<string>();
  let completeSources = new Set<string>();
  let stopped = false;
  let unsubscribeRegistry: (() => void) | null = null;
  const lifetime = new AbortController();

  const acquire = async (agentId: string): Promise<NativeUsageSourceBoundary | null> => {
    const [{ activateAgentRuntimeContributionOnDemand }, { acquireAuthoritativePluginRuntimeRegistryLease }] = await Promise.all([
      import('@/agent/runtime/registry/activationDemand'), import('@/plugins/runtime/reload/runtimeLease'),
    ]);
    const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
      await activateAgentRuntimeContributionOnDemand(lease.registry, agentId);
      const runtime = lease.registry.agentRuntimesByAgentId.get(agentId);
      return runtime?.externalSessions && runtime.isCurrent() && !runtime.retirementSignal.aborted
        ? { externalSessions: runtime.externalSessions, occurrenceId: runtime.occurrenceId,
          retirementSignal: runtime.retirementSignal, isCurrent: runtime.isCurrent } : null;
    } finally { await lease.release(); }
  };

  const refresh = async (settings: MemorySettingsV1, signal: AbortSignal) => {
    if (stopped || !observation || !settings.enabled || !settings.conversationSearch.indexExternal.enabled) {
      const prior = records;
      records = [];
      traversal.replace([]);
      configuredSourceKeys.clear();
      completeSources.clear();
      await Promise.all(prior.map(record => record.demand?.dispose()));
      return;
    }
    const operationSignal = AbortSignal.any([signal, lifetime.signal]);
    if (!unsubscribeRegistry) {
      const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
      unsubscribeRegistry = pluginReloadController.subscribe(() => { dirty = true; traversal.invalidate(); input.onChange(); });
    }
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
    const { descriptors, configuredSourceKeys: nextConfiguredSourceKeys } = await discoverMemoryExternalTranscriptSources({ agents: selected, account,
      agentSettings: getActiveAccountSettingsSnapshot()?.settings,
      activeServerId: configuration.activeServerId, activeServerDir: configuration.activeServerDir,
      resolveBoundary: acquire, signal: operationSignal });
    operationSignal.throwIfAborted();
    const next: typeof records[number][] = [];
    try {
      for (const descriptor of descriptors) {
        const agentId = selected.find(agent => agent.identity?.pluginId === descriptor.agent.pluginId
          && agent.identity.localId === descriptor.agent.localId)?.id;
        if (!agentId) continue;
        const boundary = await acquire(agentId);
        if (!boundary) continue;
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
          onChange: () => { dirty = true; traversal.invalidate(agentId, descriptor.configuredSourceKey ?? descriptor.sourceKey); input.onChange(); },
        }) : null;
        next.push({ agentId, sourceKey: descriptor.configuredSourceKey ?? descriptor.sourceKey, source: resolved.descriptor.source,
          reader: boundary.externalSessions, demand });
      }
      operationSignal.throwIfAborted();
    } catch (error) { await Promise.all(next.map(record => record.demand?.dispose())); throw error; }
    const prior = records;
    records = next;
    configuredSourceKeys = nextConfiguredSourceKeys;
    traversal.invalidate();
    await Promise.all(prior.map(record => record.demand?.dispose()));
    dirty = true;
  };

  const inventory = async (signal: AbortSignal) => {
    if (!observation || !dirty) return null;
    // A change observed during inventory remains pending for the next pass.
    dirty = false;
    completeSources.clear();
    try {
    // A failed or retired source never supplies absence evidence.
    const next: MemoryExternalTranscriptCandidate[] = [];
    const current = new Set<string>();
    const nextCompleteSources = new Set<string>();
    for (const native of records) {
      let sourceComplete = true;
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (;;) {
        const page = await native.reader.listCandidates({ source: native.source,
          maxItems: EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxItems,
          maxSerializedBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxSerializedBytes,
          ...(cursor ? { cursor } : {}), signal });
        signal.throwIfAborted();
        if (!page.ok) { sourceComplete = false; break; }
        for (const candidate of page.value.candidates) {
          current.add(externalMemoryStorageId({ type: 'external_transcript', agentId: native.agentId,
            sourceKey: native.sourceKey, nativeSessionId: candidate.remoteSessionId }));
          const identity = await native.reader.resolveLinkIdentity({ source: native.source,
            remoteSessionId: candidate.remoteSessionId, ...(candidate.linkData ? { linkData: candidate.linkData } : {}), signal });
          signal.throwIfAborted();
          if (!identity.ok) { sourceComplete = false; continue; }
          next.push({ native: { ...native, source: identity.value.source }, source: { type: 'external_transcript',
            agentId: native.agentId, sourceKey: native.sourceKey, nativeSessionId: identity.value.remoteSessionId } });
        }
        if (!page.value.nextCursor) {
          if (sourceComplete && !page.value.searchIncomplete && !page.value.preparation) nextCompleteSources.add(JSON.stringify([native.agentId, native.sourceKey]));
          break;
        }
        if (seen.has(page.value.nextCursor)) throw new Error('memory_external_inventory_cursor_stalled');
        cursor = page.value.nextCursor;
        seen.add(cursor);
      }
    }
    for (const candidate of next) current.add(externalMemoryStorageId(candidate.source));
    traversal.replace(next);
    completeSources = nextCompleteSources;
    return { current, completeSources, configuredSourceKeys };
    } catch (error) { dirty = true; throw error; }
  };

  return {
    refresh,
    inventory,
    invalidate() { dirty = true; },
    noteSyncResult(source: MemoryExternalTranscriptSourceV1, state: 'current' | 'more' | 'removed' | 'error') {
      if (!dirty) traversal.noteSyncResult(source, state);
    },
    getIndexSources(db: DeepIndexDbHandle | null): MemoryIndexSourceStatusV1[] {
      const groups = new Map(traversal.getIndexSources(db).map(row =>
        [JSON.stringify([row.source.type === 'external_transcript' ? row.source.agentId : '', row.source.type === 'external_transcript' ? row.source.sourceKey : '']), row]));
      return [...configuredSourceKeys].map(key => {
        const [agentId, sourceKey] = JSON.parse(key) as [string, string];
        return { source: { type: 'external_transcript', agentId, sourceKey },
          state: !db || dirty || !completeSources.has(key) ? 'indexing' : groups.get(key)?.state ?? 'ready' };
      });
    },
    getReadySourceCount: traversal.size,
    attach(next: MemoryExternalObservation) {
      observation = next;
      dirty = true;
      input.onChange();
      return () => { if (observation === next) { observation = null; dirty = true; input.onChange(); } };
    },
    take: traversal.take,
    async readPage(request: Readonly<{ source: MemoryExternalTranscriptSourceV1; cursor?: string }>, settings: MemorySettingsV1, signal: AbortSignal) {
      if (!records.length) await refresh(settings, signal);
      const native = records.find(record => record.agentId === request.source.agentId && record.sourceKey === request.source.sourceKey);
      if (!native) return null;
      const identity = await native.reader.resolveLinkIdentity({ source: native.source,
        remoteSessionId: request.source.nativeSessionId, signal });
      if (!identity.ok) return null;
      const result = await native.reader.pageTranscript({ source: identity.value.source, remoteSessionId: identity.value.remoteSessionId,
        direction: 'older', ...(request.cursor ? { cursor: request.cursor } : {}),
        maxItems: EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxItems,
        maxSerializedBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxSerializedBytes, signal });
      return result.ok ? result.value : null;
    },
    async dispose() { stopped = true; lifetime.abort(); unsubscribeRegistry?.(); unsubscribeRegistry = null;
      await Promise.all(records.map(record => record.demand?.dispose())); records = []; },
  };
}
