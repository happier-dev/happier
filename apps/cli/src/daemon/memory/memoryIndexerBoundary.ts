import type { AgentExternalSessionsTranscriptPage } from '@happier-dev/plugin-sdk/sessions/external';
import type { MemoryExternalTranscriptSourceV1 } from '@happier-dev/protocol/memory/memorySearch';
import type { MemoryIndexSourceStatusV1, MemoryWorkerStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import type { SessionSummaryShardV1, SessionSynopsisV1 } from '@happier-dev/protocol';

import type { MemorySettingsV1 } from '@/settings/memorySettings';
import type { DeepIndexDocumentEntry, DeepIndexDocumentIdentity } from './deepIndex/deepIndexDb';
import type { OperationalMemoryEmbeddingsDiagnostics } from './resolveOperationalMemoryEmbeddingsSettings';
import type { MemoryExternalTranscriptSourcesSnapshot } from './externalTranscriptObservation';
import type { MemoryInventorySessionEligibility } from './inventory/refreshMemoryInventory';

/** An exact Session observation already authorized and admitted by the daemon. */
export type MemorySessionInventoryObservation = Readonly<{
  sessionId: string;
  eligibility: MemoryInventorySessionEligibility | null;
}>;

/** Volatile indexer facts; SQLite remains the authority for retained progress. */
export type MemoryIndexerSnapshot = Readonly<{
  settings: MemorySettingsV1;
  embeddings: OperationalMemoryEmbeddingsDiagnostics;
  worker: MemoryWorkerStatusV1;
  indexesQualified: boolean;
  candidateSessionIds: readonly string[];
  observedSeqBySessionId: readonly (readonly [string, number])[];
  editedSessionIds: readonly string[];
  externalSources: readonly MemoryIndexSourceStatusV1[];
  nextWorkAtMs?: number | null;
}>;

/** Omitted inventory facts retain the daemon's last admitted projection. */
export type MemoryIndexerPublication = Pick<MemoryIndexerSnapshot, 'settings' | 'embeddings' | 'worker'>
  & Partial<Omit<MemoryIndexerSnapshot, 'settings' | 'embeddings' | 'worker'>>
  & Readonly<{
    sessionUpdates?: readonly Readonly<{ sessionId: string; candidate?: boolean; observedSeq?: number; edited?: boolean }>[];
    removedSessionIds?: readonly string[];
  }>;

/** Fold source-owned changes; status publications never rebuild inventory. */
export function applyMemoryIndexerPublication(previous: MemoryIndexerSnapshot, publication: MemoryIndexerPublication): MemoryIndexerSnapshot {
  const { sessionUpdates, removedSessionIds, ...facts } = publication;
  let next = { ...previous, ...facts, worker: { ...facts.worker,
    // A fresh query/purge child has no scheduler or inventory run to report.
    // Those nulls do not withdraw the daemon's last completed run facts.
    lastTickAtMs: facts.worker.lastTickAtMs ?? previous.worker.lastTickAtMs,
    lastInventoryAtMs: facts.worker.lastInventoryAtMs ?? previous.worker.lastInventoryAtMs,
  } };
  if (sessionUpdates?.length || removedSessionIds?.length) {
    const removed = new Set(removedSessionIds);
    const candidates = removed.size || sessionUpdates?.some(update => update.candidate)
      ? new Set(next.candidateSessionIds.filter(id => !removed.has(id))) : null;
    const observed = removed.size || sessionUpdates?.some(update => update.observedSeq !== undefined)
      ? new Map(next.observedSeqBySessionId.filter(([id]) => !removed.has(id))) : null;
    const edited = removed.size || sessionUpdates?.some(update => update.edited !== undefined)
      ? new Set(next.editedSessionIds.filter(id => !removed.has(id))) : null;
    for (const update of sessionUpdates ?? []) {
      if (update.candidate) candidates?.add(update.sessionId);
      if (update.observedSeq !== undefined) observed?.set(update.sessionId, update.observedSeq);
      if (update.edited === true) edited?.add(update.sessionId);
      else if (update.edited === false) edited?.delete(update.sessionId);
    }
    next = { ...next, ...(candidates ? { candidateSessionIds: [...candidates] } : {}),
      ...(observed ? { observedSeqBySessionId: [...observed] } : {}), ...(edited ? { editedSessionIds: [...edited] } : {}) };
  }
  return next;
}

export type MemoryDocumentIndexUpdate = Readonly<{
  documents: readonly (DeepIndexDocumentIdentity & Readonly<{ entries: readonly DeepIndexDocumentEntry[] }>)[];
  prune: boolean;
}>;

export type MemoryHintRun = Readonly<{
  sessionId: string;
  prompt: string;
  backendId: string;
  modelId?: string;
  permissionMode: 'no_tools' | 'read_only';
}>;

export type MemoryHintCommit = Readonly<{
  sessionId: string;
  shardPayload: SessionSummaryShardV1;
  synopsisPayload: SessionSynopsisV1 | null;
}>;

/** Functions bind transport lifetimes; their inputs/results are serializable. */
export type MemoryIndexerConnection = Readonly<{
  applySettings(settings: MemorySettingsV1, signal?: AbortSignal): Promise<void>;
  inventory(signal?: AbortSignal, observations?: readonly MemorySessionInventoryObservation[]): Promise<void>;
  tick(signal?: AbortSignal): Promise<void>;
  refresh(sessionId?: string, signal?: AbortSignal): Promise<void>;
  revise(change: Readonly<{ sessionId: string; seq: number; messageId?: string }>, signal?: AbortSignal): Promise<void>;
  removeSessions(sessionIds: readonly string[], signal?: AbortSignal): Promise<void>;
  reconcileAccess(signal?: AbortSignal): Promise<void>;
  archive(change: Readonly<{ sessionId: string; archived: boolean }>, signal?: AbortSignal): Promise<void>;
  readExternalPage(request: Readonly<{ source: MemoryExternalTranscriptSourceV1; cursor?: string }>, signal?: AbortSignal): Promise<AgentExternalSessionsTranscriptPage | null>;
  embedQuery(text: string, signal?: AbortSignal): Promise<readonly number[] | null>;
  indexDocuments(update: MemoryDocumentIndexUpdate, signal?: AbortSignal): Promise<void>;
  retryEmbeddings(signal?: AbortSignal): Promise<void>;
  /** Resolves only after all operations drain and every writer handle closes. */
  retire(): Promise<void>;
}>;

export type MemoryIndexerHost = Readonly<{
  publish(snapshot: MemoryIndexerPublication): void;
  failed(error: unknown): void;
  settled?(): void;
  readExternalSources(refresh: boolean, signal: AbortSignal): Promise<MemoryExternalTranscriptSourcesSnapshot>;
  observeSessions(sessionIds: readonly string[]): Promise<readonly string[]>;
  runHint(request: MemoryHintRun, signal?: AbortSignal): Promise<string>;
  commitHint(request: MemoryHintCommit, signal?: AbortSignal): Promise<void>;
}>;

/** The shared background-service placement adapter supplies this connection. */
export type ConnectMemoryIndexer = (host: MemoryIndexerHost) => Promise<MemoryIndexerConnection>;
