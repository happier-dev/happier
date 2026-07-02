import type { StorageState } from '@/sync/store/types';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { LruMap } from '@/utils/cache/lruMap';

export type ForkedTranscriptSegment = Readonly<{
  sessionId: string;
  isReadOnlyContext: boolean;
  /**
   * For ancestor segments, only include parent messages whose committed `seq` is <= cutoff.
   * `null` means "no cutoff" (current session).
   */
  cutoffSeqInclusive: number | null;
  messageIdsOldestFirst: readonly string[];
}>;

export type ForkedTranscriptSnapshot = Readonly<{
  segments: readonly ForkedTranscriptSegment[];
  combinedMessageIdsOldestFirst: readonly string[];
  combinedMessagesById: Readonly<Record<string, Message>>;
  messageOriginById: Readonly<Record<string, { sessionId: string; isReadOnlyContext: boolean }>>;
  isLoaded: boolean;
}>;

type MinimalState = Pick<StorageState, 'sessions' | 'sessionMessages'>;

type CacheEntry = Readonly<{
  key: string;
  snapshot: ForkedTranscriptSnapshot;
}>;

const cacheByChildSessionId = new LruMap<string, CacheEntry>({
  maxEntries: loadSyncTuning().transcriptForkedSnapshotCacheMaxSessions,
});

function normalizeSeq(seq: unknown): number | null {
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
  return Math.max(0, Math.trunc(seq));
}

function readForkV1(state: MinimalState, sessionId: string): any | null {
  const session = state.sessions[sessionId];
  const fork = session?.metadata?.forkV1 as any;
  if (!fork || typeof fork !== 'object') return null;
  if (fork.v !== 1) return null;
  if (typeof fork.parentSessionId !== 'string' || fork.parentSessionId.length === 0) return null;
  return fork;
}

function buildSegmentsRootToChild(state: MinimalState, childSessionId: string): Array<{
  sessionId: string;
  isReadOnlyContext: boolean;
  cutoffSeqInclusive: number | null;
}> | null {
  const childFork = readForkV1(state, childSessionId);
  if (!childFork) return null;

  const segments: Array<{ sessionId: string; isReadOnlyContext: boolean; cutoffSeqInclusive: number | null }> = [];

  // Child session: no cutoff.
  segments.push({ sessionId: childSessionId, isReadOnlyContext: false, cutoffSeqInclusive: null });

  let current = childSessionId;
  for (let depth = 0; depth < 20; depth += 1) {
    const fork = readForkV1(state, current);
    if (!fork) break;
    const parentSessionId = String(fork.parentSessionId);
    const parentCutoffSeqInclusive = normalizeSeq(fork.parentCutoffSeqInclusive) ?? 0;
    segments.push({ sessionId: parentSessionId, isReadOnlyContext: true, cutoffSeqInclusive: parentCutoffSeqInclusive });
    current = parentSessionId;
  }

  return segments.reverse();
}

function filterIdsByCutoffSeqInclusive(params: Readonly<{
  messageIdsOldestFirst: readonly string[];
  messagesById: Readonly<Record<string, Message>>;
  cutoffSeqInclusive: number;
}>): string[] {
  const out: string[] = [];
  for (const id of params.messageIdsOldestFirst) {
    const m = params.messagesById[id];
    if (!m) continue;
    const seq = normalizeSeq((m as any).seq);
    if (seq == null || seq <= params.cutoffSeqInclusive) {
      out.push(id);
    }
  }
  return out;
}

export function getForkedTranscriptSnapshotCached(state: MinimalState, childSessionId: string): ForkedTranscriptSnapshot | null {
  const segmentsRaw = buildSegmentsRootToChild(state, childSessionId);
  if (!segmentsRaw) return null;

  const keyParts: string[] = [];
  for (const seg of segmentsRaw) {
    const sessionMessages = state.sessionMessages[seg.sessionId];
    const version = sessionMessages?.messagesVersion ?? 0;
    const idsLen = sessionMessages?.messageIdsOldestFirst?.length ?? 0;
    keyParts.push(`${seg.sessionId}:${seg.cutoffSeqInclusive ?? 'full'}:${version}:${idsLen}`);
  }
  const key = keyParts.join('|');

  const existing = cacheByChildSessionId.get(childSessionId);
  if (existing && existing.key === key) {
    return existing.snapshot;
  }

  const segmentDrafts: Array<{
    sessionId: string;
    isReadOnlyContext: boolean;
    cutoffSeqInclusive: number | null;
    messageIdsOldestFirst: string[];
    allMessagesById: Readonly<Record<string, Message>>;
  }> = [];

  for (const seg of segmentsRaw) {
    const sessionMessages = state.sessionMessages[seg.sessionId];
    const idsOldestFirst = sessionMessages?.messageIdsOldestFirst ?? [];
    const messagesById = sessionMessages?.messagesById ?? {};
    const messagesMap = sessionMessages?.messagesMap ?? {};
    const allMessagesById = messagesById === messagesMap ? messagesById : { ...messagesMap, ...messagesById };

    const filteredIds =
      seg.cutoffSeqInclusive == null
        ? idsOldestFirst.slice()
        : filterIdsByCutoffSeqInclusive({
            messageIdsOldestFirst: idsOldestFirst,
            messagesById: allMessagesById,
            cutoffSeqInclusive: seg.cutoffSeqInclusive,
          });

    segmentDrafts.push({
      sessionId: seg.sessionId,
      isReadOnlyContext: seg.isReadOnlyContext,
      cutoffSeqInclusive: seg.cutoffSeqInclusive,
      messageIdsOldestFirst: filteredIds,
      allMessagesById,
    });
  }

  // De-duplicate message ids across segments by preferring the earliest (ancestor) segment.
  // This matters for provider-native forks where the provider may reuse message ids across forked sessions,
  // which would otherwise render duplicate rows in the forked transcript view.
  const seenAcrossSegments = new Set<string>();
  for (const seg of segmentDrafts) {
    const nextIds: string[] = [];
    for (const id of seg.messageIdsOldestFirst) {
      if (seenAcrossSegments.has(id)) continue;
      nextIds.push(id);
      seenAcrossSegments.add(id);
    }
    seg.messageIdsOldestFirst = nextIds;
  }

  const segments: ForkedTranscriptSegment[] = [];
  const combinedMessageIdsOldestFirst: string[] = [];
  const combinedMessagesById: Record<string, Message> = {};
  const messageOriginById: Record<string, { sessionId: string; isReadOnlyContext: boolean }> = {};

  for (const seg of segmentDrafts) {
    segments.push({
      sessionId: seg.sessionId,
      isReadOnlyContext: seg.isReadOnlyContext,
      cutoffSeqInclusive: seg.cutoffSeqInclusive,
      messageIdsOldestFirst: seg.messageIdsOldestFirst,
    });

    for (const id of seg.messageIdsOldestFirst) {
      const message = seg.allMessagesById[id];
      if (!message) continue;
      combinedMessageIdsOldestFirst.push(id);
      combinedMessagesById[id] = message;
      messageOriginById[id] = { sessionId: seg.sessionId, isReadOnlyContext: seg.isReadOnlyContext };
    }
  }

  const isLoaded = state.sessionMessages[childSessionId]?.isLoaded ?? false;

  const snapshot: ForkedTranscriptSnapshot = {
    segments,
    combinedMessageIdsOldestFirst,
    combinedMessagesById,
    messageOriginById,
    isLoaded,
  };

  cacheByChildSessionId.set(childSessionId, { key, snapshot });
  return snapshot;
}
