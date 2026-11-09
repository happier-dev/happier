import type { MemoryExternalTranscriptSourceV1 } from '@happier-dev/protocol/memory/memorySearch';
import type { MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';
import type { MemoryIndexSourceStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import type { DeepIndexDbHandle } from './deepIndex/deepIndexDb';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from '@/session/external/agentExternalSessionsInvocation';
import { externalMemoryStorageId, memoryExternalSourceReadError, memoryExternalSourceFailure, readExternalMemoryUnavailableFailure, type MemoryExternalSourceReader } from './externalTranscriptIndex';
import { resolveMemoryCoverageCreatedAtCutoffMs } from './transcript/coveragePolicy';
import { logger } from '@/ui/logger';
import type { MemoryExternalTranscriptSourcesSnapshot } from './externalTranscriptObservation';
export { createMemoryExternalTranscriptObservation, discoverMemoryExternalTranscriptSources } from './externalTranscriptObservation';
export type { MemoryExternalObservation, MemoryExternalTranscriptSourceDescriptor, MemoryExternalTranscriptSourceChange, MemoryExternalTranscriptSourcesSnapshot } from './externalTranscriptObservation';

type MemoryExternalTranscriptCandidate = Readonly<{
  source: MemoryExternalTranscriptSourceV1;
  native: MemoryExternalSourceReader;
}>;

type NativeInventory = {
  native: MemoryExternalSourceReader;
  candidates: Map<string, MemoryExternalTranscriptCandidate>;
  pending: Map<string, MemoryExternalTranscriptCandidate> | null;
  pendingIdentitiesComplete: boolean;
  cursor?: string;
  refresh: { cursor?: string } | null;
  refreshRequested: boolean;
  preferRefresh: boolean;
  needsInventory: boolean;
  failed: boolean;
  initialInventoryComplete: boolean;
  failure?: Pick<MemoryIndexSourceStatusV1, 'errorCode' | 'errorReason'>;
};

/** One ordered work list shares the existing allowance between refresh and backfill. */
export function createMemoryExternalTranscriptTraversal() {
  type Entry = { candidate: MemoryExternalTranscriptCandidate; state?: 'current' | 'more' | 'removed' | 'error' | 'invalidated'; refresh: boolean;
    failure?: Pick<MemoryIndexSourceStatusV1, 'errorCode' | 'errorReason'> };
  const candidates = new Map<string, Entry>();
  let preferRefresh = true;
  let preferUnstarted = false;
  return {
    replace(next: readonly MemoryExternalTranscriptCandidate[], refreshIds?: ReadonlySet<string>) {
      const discovered: [string, Entry][] = [];
      const retainedIds = new Set(next.map(candidate => externalMemoryStorageId(candidate.source)));
      for (const id of candidates.keys()) if (!retainedIds.has(id)) candidates.delete(id);
      for (const candidate of next) {
        const id = externalMemoryStorageId(candidate.source);
        const existing = candidates.get(id);
        if (existing) {
          existing.candidate = candidate;
          if (refreshIds?.has(id)) existing.refresh = true;
        } else {
          const entry = { candidate, refresh: refreshIds?.has(id) ?? false };
          if (entry.refresh) discovered.push([id, entry]);
          else candidates.set(id, entry);
        }
      }
      if (discovered.length) {
        // A new sibling must not queue behind every previously discovered,
        // unstarted refresh. Keep the incumbent rotation behind this batch.
        const retained = [...candidates];
        candidates.clear();
        for (const [id, entry] of [...discovered, ...retained]) candidates.set(id, entry);
      }
    },
    size() { return candidates.size; },
    sourceIds: () => candidates.keys(),
    hasPendingWork() {
      for (const entry of candidates.values()) if (entry.refresh || entry.state === undefined || entry.state === 'invalidated' || entry.state === 'more') return true;
      return false;
    },
    invalidate(agentId?: string, sourceKey?: string) {
      for (const entry of candidates.values()) {
        const candidate = entry.candidate;
        if ((agentId === undefined || candidate.source.agentId === agentId)
          && (sourceKey === undefined || candidate.source.sourceKey === sourceKey)) entry.state = 'invalidated';
      }
    },
    changed(agentId: string, sourceKey: string, nativeSessionIds?: readonly string[]) {
      for (const entry of candidates.values()) {
        const source = entry.candidate.source;
        if (source.agentId === agentId && source.sourceKey === sourceKey
          && (nativeSessionIds ? nativeSessionIds.includes(source.nativeSessionId) : entry.state === 'current')) entry.refresh = true;
      }
    },
    noteSyncResult(source: MemoryExternalTranscriptSourceV1, state: 'current' | 'more' | 'removed' | 'error', failure?: Pick<MemoryIndexSourceStatusV1, 'errorCode' | 'errorReason'>) {
      const entry = candidates.get(externalMemoryStorageId(source));
      if (entry) {
        const changed = entry.state !== state;
        entry.state = state;
        entry.failure = state === 'error' ? failure ?? entry.failure : undefined;
        // Replacement first clears the old index and returns more. Keep that
        // requested refresh ahead of the backlog until its new pages complete.
        if (state !== 'more') entry.refresh = false;
        return changed;
      }
      return false;
    },
    getIndexSources(db: Pick<DeepIndexDbHandle, 'getExternalSourceState'> | null): MemoryIndexSourceStatusV1[] {
      const groups = new Map<string, MemoryIndexSourceStatusV1>();
      // Establish group order and decisive in-memory facts before consulting
      // persisted coverage. Candidate rotation cannot turn a pending sibling
      // into a scan of every already-settled frontier.
      for (const { candidate, state, failure } of candidates.values()) {
        const { agentId, sourceKey } = candidate.source;
        const key = JSON.stringify([agentId, sourceKey]);
        const previous = groups.get(key);
        if (!previous) groups.set(key, { source: { type: 'external_transcript', agentId, sourceKey }, state: 'ready' });
        if (state === 'error') groups.set(key, { source: { type: 'external_transcript', agentId, sourceKey }, state: 'error', ...failure });
        else if (state !== undefined && state !== 'current' && state !== 'more' && previous?.state !== 'error') {
          groups.set(key, { source: { type: 'external_transcript', agentId, sourceKey }, state: 'indexing' });
        }
      }
      // Qualify fresh identities first. A missing frontier can settle its group
      // without revisiting all the already-settled siblings ahead of it.
      for (const unattempted of [true, false]) for (const { candidate, state: result } of candidates.values()) {
        if ((result === undefined) !== unattempted) continue;
        const { agentId, sourceKey } = candidate.source;
        const key = JSON.stringify([agentId, sourceKey]);
        const previous = groups.get(key);
        if (previous?.state !== 'ready') continue;
        const id = externalMemoryStorageId(candidate.source);
        const retained = db?.getExternalSourceState({ sessionId: id });
        const unavailable = readExternalMemoryUnavailableFailure(retained?.cursor);
        if (unavailable) {
          groups.set(key, { source: { type: 'external_transcript', agentId, sourceKey }, state: 'error', ...unavailable });
          continue;
        }
        // An append may have several tail pages; it does not reopen completed
        // initial history. Replacement deletes this persisted frontier.
        // A fresh child has not attempted these admitted identities yet. Their
        // durable initial coverage survives its birth; new identities and
        // replacements still have no completed retained frontier.
        const initialComplete = retained?.coverageComplete === true && (result === undefined || result === 'current' || (retained.cursor
          && (JSON.parse(retained.cursor) as { type?: unknown }).type === 'tail'));
        if (!initialComplete) groups.set(key, { source: { type: 'external_transcript', agentId, sourceKey }, state: 'indexing' });
      }
      return [...groups.values()];
    },
    take(count: number) {
      const result: MemoryExternalTranscriptCandidate[] = [];
      const selected = new Set<string>();
      for (let i = 0; i < Math.min(count, candidates.size); i++) {
        let first: [string, Entry] | undefined;
        let refresh: [string, Entry] | undefined;
        let unstartedRefresh: [string, Entry] | undefined;
        let backfill: [string, Entry] | undefined;
        let continuation: [string, Entry] | undefined;
        let unstarted: [string, Entry] | undefined;
        for (const pair of candidates) {
          if (selected.has(pair[0])) continue;
          first ??= pair;
          if (pair[1].refresh) {
            if (pair[1].state === undefined || pair[1].state === 'invalidated') unstartedRefresh ??= pair;
            else refresh ??= pair;
          }
          if (pair[1].state !== 'current') backfill ??= pair;
          if (pair[1].state === undefined || pair[1].state === 'invalidated') unstarted ??= pair;
          if (pair[1].state === 'more' && !pair[1].refresh) continuation ??= pair;
          if (refresh && continuation) break;
        }
        // Continue admitted history without queuing every page behind the whole
        // corpus. Unstarted pre-opt-in histories share the existing alternate
        // slot, so one large transcript cannot postpone all their first pages.
        const history = continuation ?? backfill;
        // A continuously refreshed sibling and an admitted continuation must
        // not monopolize both slots. Share the requested slot with initial
        // history while preserving the continuation slot and Map rotation.
        const initial = unstartedRefresh ?? unstarted;
        const requested = preferUnstarted ? initial ?? refresh : refresh ?? initial;
        const next = preferRefresh ? requested ?? history ?? first : history ?? requested ?? first;
        if (!next) break;
        if (next === requested && refresh && initial) preferUnstarted = !preferUnstarted;
        const [id, entry] = next;
        selected.add(id);
        candidates.delete(id);
        candidates.set(id, entry);
        result.push(entry.candidate);
        // A continuously active conversation cannot starve initial backfill,
        // even when the user selects one source per tick.
        preferRefresh = !preferRefresh;
      }
      return result;
    },
  };
}

/** Child-owned inventories and executable native readers; admission stays in the daemon. */
export function createMemoryExternalTranscriptReader(input: Readonly<{
  resolveReader(agentId: string): Promise<MemoryExternalSourceReader['reader'] | null>;
  onChange(refreshSources: boolean): void;
}>) {
  let records: ReadonlyArray<{ native: MemoryExternalSourceReader; occurrenceId: string; observationId?: string; lifetime?: AbortController;
    observationState?: { value: NonNullable<MemoryExternalSourceReader['observation']> } }> = [];
  const traversal = createMemoryExternalTranscriptTraversal();
  const inventories = new Map<string, NativeInventory>();
  let inventoryChanged = false;
  let configuredSourceKeys = new Set<string>();
  const completeSources = new Set<string>();
  let stopped = false;
  let indexSettings: MemorySettingsV1 | null = null;

  const releaseSources = async () => {
    for (const record of records) record.lifetime?.abort();
    records = [];
    traversal.replace([]);
    configuredSourceKeys.clear();
    completeSources.clear();
    inventories.clear();
    inventoryChanged = false;
    indexSettings = null;
  };

  const invalidateInventory = (agentId?: string, sourceKey?: string, changed = true) => {
    for (const [key, state] of inventories) {
      if ((agentId === undefined || state.native.agentId === agentId)
        && (sourceKey === undefined || state.native.sourceKey === sourceKey)
        && (changed || state.pending === null)) {
        state.needsInventory = true;
        state.refreshRequested = true;
        completeSources.delete(key);
      }
    }
  };

  const refresh = async (snapshot: MemoryExternalTranscriptSourcesSnapshot, settings: MemorySettingsV1, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (stopped || !settings.enabled || !settings.conversationSearch.indexExternal.enabled
      || settings.conversationSearch.indexExternal.agents.length === 0) {
      await releaseSources();
      return;
    }
    if (indexSettings && indexSettings.conversationSearch.indexExternal.historyDays
      !== settings.conversationSearch.indexExternal.historyDays) invalidateInventory();
    indexSettings = settings;
    const next: typeof records[number][] = [];
    try {
      for (const descriptor of snapshot.sources) {
        const previous = records.find(record => record.native.agentId === descriptor.agentId && record.native.sourceKey === descriptor.sourceKey);
        const reader = previous?.occurrenceId === descriptor.occurrenceId
          ? previous.native.reader : await input.resolveReader(descriptor.agentId);
        signal.throwIfAborted();
        if (!reader) continue;
        const retained = previous?.native.reader === reader && previous.occurrenceId === descriptor.occurrenceId
          && previous.observationId === descriptor.observation?.id
          && JSON.stringify(previous.native.source) === JSON.stringify(descriptor.source);
        const lifetime = descriptor.observation ? retained ? previous.lifetime : new AbortController() : undefined;
        const observation = lifetime ? { lifetime: lifetime.signal,
          ...(descriptor.observation?.changedFiles ? { changedFiles: descriptor.observation.changedFiles } : {}) } : undefined;
        const observationState = observation ? retained && previous.observationState ? previous.observationState : { value: observation } : undefined;
        if (observationState && observation) {
          const pending = observationState.value;
          observationState.value = { lifetime: observation.lifetime, ...(pending.changedFiles && observation.changedFiles
            ? { changedFiles: [...new Set([...pending.changedFiles, ...observation.changedFiles])] } : {}) };
        }
        next.push({ native: { agentId: descriptor.agentId, sourceKey: descriptor.sourceKey, source: descriptor.source, reader,
          ...(observationState ? { observation: observationState.value, readObservation() {
            const value = observationState.value;
            observationState.value = { lifetime: value.lifetime, changedFiles: [] };
            return value;
          } } : {}) }, occurrenceId: descriptor.occurrenceId,
          ...(descriptor.observation ? { observationId: descriptor.observation.id, lifetime, observationState } : {}) });
      }
    } catch (error) {
      for (const record of next) if (!records.some(prior => prior.lifetime === record.lifetime)) record.lifetime?.abort();
      throw error;
    }
    const prior = records;
    records = next;
    configuredSourceKeys = new Set(snapshot.configuredSourceKeys);
    const retainedKeys = new Set<string>();
    for (const { native } of records) {
      const key = JSON.stringify([native.agentId, native.sourceKey]);
      retainedKeys.add(key);
      const previous = inventories.get(key);
      if (previous?.native.reader === native.reader
        && previous.native.observation?.lifetime === native.observation?.lifetime
        && JSON.stringify(previous.native.source) === JSON.stringify(native.source)) {
        previous.native = native;
        continue;
      }
      if (previous) traversal.invalidate(native.agentId, native.sourceKey);
      inventories.set(key, { native, candidates: new Map(), pending: null, pendingIdentitiesComplete: true,
        refresh: null, refreshRequested: true, preferRefresh: true,
        needsInventory: true, failed: false, initialInventoryComplete: false });
      inventoryChanged = true;
      completeSources.delete(key);
    }
    for (const key of inventories.keys()) if (!retainedKeys.has(key)) {
      inventories.delete(key);
      completeSources.delete(key);
      inventoryChanged = true;
    }
    for (const record of prior) if (!records.some(next => next.lifetime === record.lifetime)) record.lifetime?.abort();
    for (const change of snapshot.changes) {
      if (change.refreshSources) invalidateInventory(change.agentId, change.sourceKey);
      traversal.changed(change.agentId, change.sourceKey, change.changedNativeSessionIds);
    }
  };

  const inventory = async (signal: AbortSignal) => {
    if (!indexSettings) return null;
    const cutoff = resolveMemoryCoverageCreatedAtCutoffMs({ nowMs: Date.now(), enabledAtMs: 0,
      historyDays: indexSettings.conversationSearch.indexExternal.historyDays });
    let changed = inventoryChanged;
    const refreshIds = new Set<string>();
    inventoryChanged = false;
    for (const { native } of records) {
      const key = JSON.stringify([native.agentId, native.sourceKey]);
      const state = inventories.get(key)!;
      // Incompleteness is retained coverage, not another admission. Only an
      // actual observation/policy refresh may reopen a finished or failed scan.
      if (state.needsInventory && state.pending === null && state.refreshRequested) {
        state.pending = new Map();
        state.pendingIdentitiesComplete = true;
        state.cursor = undefined;
        state.needsInventory = false;
        state.refreshRequested = false;
        completeSources.delete(key);
      }
      if (state.pending === null) continue;
      if (state.refreshRequested && state.refresh === null) {
        state.refresh = {};
        state.refreshRequested = false;
        state.preferRefresh = true;
      }
      // New siblings can precede an opaque crawl's frontier. Alternate fresh
      // discovery with retained coverage without restarting either on writes.
      const refresh = state.refresh && state.preferRefresh ? state.refresh : null;
      if (state.refresh) state.preferRefresh = !state.preferRefresh;
      const cursor = refresh ? refresh.cursor : state.cursor;
      changed = true;
      try {
        // Consume one existing bounded native page per source, then let the
        // worker ingest it. A large sibling cannot hold all transcript work
        // behind its whole-corpus inventory. Continuations live here, in the
        // incumbent inventory owner, across ticks and observation refreshes.
        const page = await native.reader.listCandidates({ source: native.source,
          maxItems: EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxItems,
          maxSerializedBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxSerializedBytes,
          includeTitles: false,
          ...(cutoff === null ? {} : { updatedAfterMs: cutoff }),
          ...(cursor ? { cursor } : {}), signal });
        signal.throwIfAborted();
        if (!page.ok) throw memoryExternalSourceReadError(native, page);
        state.failed = false;
        state.failure = undefined;
        for (const candidate of page.value.candidates) {
          // Native activity metadata is the source's last-update authority.
          // Unknown activity stays eligible; an expired source never needs a
          // link-identity or transcript read just to discard its old rows.
          if (cutoff !== null && typeof candidate.updatedAtMs === 'number' && candidate.updatedAtMs < cutoff) continue;
          const identity = await native.reader.resolveLinkIdentity({ source: native.source,
            remoteSessionId: candidate.remoteSessionId, ...(candidate.linkData ? { linkData: candidate.linkData } : {}), signal });
          signal.throwIfAborted();
          if (!identity.ok) { state.needsInventory = true; state.pendingIdentitiesComplete = false; continue; }
          const source = { type: 'external_transcript' as const,
            agentId: native.agentId, sourceKey: native.sourceKey, nativeSessionId: identity.value.remoteSessionId };
          const id = externalMemoryStorageId(source);
          // Inventory may finish long before transcript backfill. A sibling
          // discovered by a later ordinary crawl needs the same refresh slot
          // as one found during an interrupted inventory's refresh pass.
          if ((refresh || state.initialInventoryComplete) && !state.pending.has(id) && !state.candidates.has(id)) refreshIds.add(id);
          state.pending.set(id, { native: { ...native, source: identity.value.source,
            readObservation: () => state.native.readObservation?.() ?? state.native.observation }, source });
        }
        if (page.value.nextCursor) {
          const position = refresh ?? state;
          position.cursor = page.value.nextCursor;
        } else if (refresh) {
          state.refresh = null;
          if (page.value.searchIncomplete) state.needsInventory = true;
        } else {
          // Preparation describes the native inventory chunk, including its
          // terminal page. Its exhausted cursor establishes inventory completion.
          if (!state.needsInventory && !page.value.searchIncomplete) {
            state.candidates = state.pending;
            // This full traversal also covers the older refresh request.
            state.refresh = null;
            state.refreshRequested = false;
            completeSources.add(key);
          } else {
            // Changes during a crawl or an incomplete page cannot prove absence.
            state.candidates = new Map([...state.candidates, ...state.pending]);
            // A real topology invalidation still owns a clean absence pass.
            // Unreadable identities/partial pages wait for later observation.
            if (!page.value.searchIncomplete && state.pendingIdentitiesComplete) state.refreshRequested = true;
            state.needsInventory = true;
          }
          // A later topology change does not erase completed initial coverage.
          // Only the uninterrupted full crawl above may prove absence.
          if (!page.value.searchIncomplete && state.pendingIdentitiesComplete) state.initialInventoryComplete = true;
          state.pending = null;
        }
      } catch (error) {
        signal.throwIfAborted();
        if (refresh) state.refresh = null;
        else {
          state.candidates = new Map([...state.candidates, ...(state.pending ?? [])]);
          state.pending = null;
        }
        state.needsInventory = true;
        state.failed = true;
        state.failure = memoryExternalSourceFailure(error);
        completeSources.delete(key);
        logger.debug('[memoryWorker] Native inventory failed; retaining incomplete coverage', {
          agentId: native.agentId, ...state.failure,
        });
      } finally {
        if (state.pending === null) {
          state.cursor = undefined;
        }
      }
    }
    if (!changed) return null;
    const candidates = new Map([...inventories.values()].flatMap(state => [...state.candidates, ...(state.pending ?? [])]));
    traversal.replace([...candidates.values()], refreshIds);
    return { current: new Set(candidates.keys()), completeSources, configuredSourceKeys };
  };

  return {
    refresh,
    inventory,
    // A periodic inventory request does not invalidate an unfinished crawl.
    invalidate() { invalidateInventory(undefined, undefined, false); },
    retryIncompleteInventory() {
      for (const state of inventories.values()) {
        if (state.needsInventory && state.pending === null) state.refreshRequested = true;
      }
    },
    noteSyncResult(source: MemoryExternalTranscriptSourceV1, state: 'current' | 'more' | 'removed' | 'error', failure?: Pick<MemoryIndexSourceStatusV1, 'errorCode' | 'errorReason'>) {
      const changed = traversal.noteSyncResult(source, state, failure);
      if (state === 'removed' && changed) {
        invalidateInventory(source.agentId, source.sourceKey);
        input.onChange(true);
      }
    },
    getIndexSources(db: DeepIndexDbHandle | null): MemoryIndexSourceStatusV1[] {
      const groups = new Map(traversal.getIndexSources(db).map(row =>
        [JSON.stringify([row.source.type === 'external_transcript' ? row.source.agentId : '', row.source.type === 'external_transcript' ? row.source.sourceKey : '']), row]));
      return [...configuredSourceKeys].map(key => {
        const [agentId, sourceKey] = JSON.parse(key) as [string, string];
        const inventory = inventories.get(key);
        const group = groups.get(key);
        return { source: { type: 'external_transcript', agentId, sourceKey },
          state: !inventory ? 'error' : !db ? 'indexing' : inventory.failed ? 'error'
            : !inventory?.initialInventoryComplete ? 'indexing' : group?.state ?? 'ready',
          ...(!inventory ? { errorCode: 'agent_unavailable' } : db && inventory.failed ? inventory.failure : group?.state === 'error'
            ? { errorCode: group.errorCode, errorReason: group.errorReason } : {}) };
      });
    },
    getReadySourceCount: traversal.size,
    sourceIds: traversal.sourceIds,
    take: traversal.take,
    async readPage(request: Readonly<{ source: MemoryExternalTranscriptSourceV1; cursor?: string }>, settings: MemorySettingsV1, signal: AbortSignal) {
      signal.throwIfAborted();
      const native = records.find(({ native }) => native.agentId === request.source.agentId && native.sourceKey === request.source.sourceKey)?.native;
      if (!native) return null;
      const identity = await native.reader.resolveLinkIdentity({ source: native.source,
        remoteSessionId: request.source.nativeSessionId, signal });
      if (!identity.ok) return null;
      const observation = native.readObservation?.() ?? native.observation;
      const result = await native.reader.pageTranscript({ source: identity.value.source, remoteSessionId: identity.value.remoteSessionId,
        direction: 'older', ...(request.cursor ? { cursor: request.cursor } : {}),
        ...(observation ? { observation } : {}),
        maxItems: EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxItems,
        maxSerializedBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxSerializedBytes, signal });
      return result.ok ? result.value : null;
    },
    hasPendingWork() {
      if (traversal.hasPendingWork()) return true;
      // Incomplete absence proof needs a later observation/admission, not an
      // immediate retry. Only a cursor or an actual requested refresh keeps a
      // finite run alive; needsInventory alone is retained coverage state.
      for (const state of inventories.values()) if (state.pending !== null || state.refreshRequested) return true;
      return false;
    },
    async dispose() { stopped = true; await releaseSources(); },
  };
}
