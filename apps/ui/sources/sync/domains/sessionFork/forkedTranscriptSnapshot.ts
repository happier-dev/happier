import type { StorageState } from '@/sync/store/types';
import type { Message } from "@happier-dev/session-core/messages";
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { LruMap } from '@/utils/cache/lruMap';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { SessionForkVisualOriginV1Schema, SessionForkVisualsV1Schema, type SessionForkVisualCopyV1 } from '@happier-dev/protocol/sessions/board/forkVisualCopies';

export type ForkedTranscriptSegment = Readonly<{
  sessionId: string;
  isReadOnlyContext: boolean;
  /**
   * For ancestor segments, only include parent messages whose committed `seq` is <= cutoff.
   * `null` means "no cutoff" (current session).
   */
  cutoffSeqInclusive: number | null;
  /** Sync has reached this segment's history start, even if initial records render no rows. */
  isHistoryStartLoaded?: boolean;
  messageIdsOldestFirst: readonly string[];
}>;

export type ForkedTranscriptSnapshot = Readonly<{
  segments: readonly ForkedTranscriptSegment[];
  combinedMessageIdsOldestFirst: readonly string[];
  combinedMessagesById: Readonly<Record<string, Message>>;
  messageOriginById: Readonly<Record<string, { sessionId: string; isReadOnlyContext: boolean }>>;
  isLoaded: boolean;
  visualSessionId?: string;
  visualCopies?: readonly SessionForkVisualCopyV1[];
}>;

type MinimalState = Pick<StorageState, 'sessions' | 'sessionMessages'>
  & Partial<Pick<StorageState, 'sessionMessagesHistoryStartLoaded' | 'sessionLocalStateScope'>>;

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
  const fork = session ? readSessionOwnerMetadataView(session)?.forkV1 as any : null;
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
  if (!childFork) {
    return SessionForkVisualsV1Schema.safeParse(state.sessions[childSessionId]?.metadata?.forkVisualsV1).success
      ? [{ sessionId: childSessionId, isReadOnlyContext: false, cutoffSeqInclusive: null }]
      : null;
  }

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

  const childSession = state.sessions[childSessionId];
  const ownerFork = readForkV1(state, childSessionId);
  const sharedVisuals = SessionForkVisualsV1Schema.safeParse(childSession?.metadata?.forkVisualsV1);
  const ownerVisuals = SessionForkVisualsV1Schema.safeParse({ v: 1, copies: ownerFork?.visualCopies });
  const visualCopies = sharedVisuals.success ? sharedVisuals.data.copies : ownerVisuals.success ? ownerVisuals.data.copies : [];

  const keyParts: string[] = [];
  for (const seg of segmentsRaw) {
    const sessionMessages = state.sessionMessages[seg.sessionId];
    const version = sessionMessages?.messagesVersion ?? 0;
    const idsLen = sessionMessages?.messageIdsOldestFirst?.length ?? 0;
    const historyStartLoaded = state.sessionMessagesHistoryStartLoaded?.[seg.sessionId] === true;
    keyParts.push(`${state.sessions[seg.sessionId]?.serverId ?? state.sessionLocalStateScope?.serverId ?? ''}:${seg.sessionId}:${seg.cutoffSeqInclusive ?? 'full'}:${version}:${idsLen}:${historyStartLoaded}:${sessionMessages?.isLoaded === true}`);
  }
  const key = `${keyParts.join('|')}|${JSON.stringify(visualCopies)}`;

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

  // Cached ancestry is not adjacent to a child window whose start has not been reached.
  // Keep the lineage for paging, but project only the reachable suffix. Do this before
  // deduplication so hidden native-fork copies cannot claim a visible child's message id.
  let firstVisibleSegmentIndex = segmentDrafts.length - 1;
  while (firstVisibleSegmentIndex > 0) {
    const segment = segmentDrafts[firstVisibleSegmentIndex]!;
    if (segment.cutoffSeqInclusive !== 0 && state.sessionMessagesHistoryStartLoaded?.[segment.sessionId] !== true) break;
    firstVisibleSegmentIndex -= 1;
  }
  for (let index = 0; index < firstVisibleSegmentIndex; index += 1) {
    segmentDrafts[index]!.messageIdsOldestFirst = [];
  }

  // Imported visual rows live in the child's transcript. Prefer them over the
  // ancestor's original provider-native row so reads never depend on its grant.
  const importedOrigins = new Map<string, { id: string; message: Message; storageSessionId: string }>();
  for (const segment of segmentDrafts) {
    for (const id of segment.messageIdsOldestFirst) {
      const origin = SessionForkVisualOriginV1Schema.safeParse(segment.allMessagesById[id]?.meta?.forkVisualOriginV1);
      if (origin.success) {
        const message = segment.allMessagesById[id];
        if (message) importedOrigins.set(JSON.stringify([origin.data.serverId, origin.data.sessionId,
          message.kind === 'tool-call' && message.tool.id ? `tool:${message.tool.id}` : origin.data.sourceMessageId]),
          { id, message, storageSessionId: segment.sessionId });
      }
    }
  }
  const placedImportedOrigins = new Set<string>();
  const importedStorageOrigins = new Map<string, string>();
  for (const segment of segmentDrafts) {
    const projectedIds: string[] = [];
    for (const id of segment.messageIdsOldestFirst) {
      const message = segment.allMessagesById[id];
      const origin = SessionForkVisualOriginV1Schema.safeParse(message?.meta?.forkVisualOriginV1);
      const key = JSON.stringify([
        origin.success ? origin.data.serverId : state.sessions[segment.sessionId]?.serverId ?? state.sessionLocalStateScope?.serverId ?? null,
        origin.success ? origin.data.sessionId : segment.sessionId,
        message?.kind === 'tool-call' && message.tool.id ? `tool:${message.tool.id}` : origin.success ? origin.data.sourceMessageId : message?.realID ?? id,
      ]);
      const imported = importedOrigins.get(key);
      if (!imported) {
        projectedIds.push(id);
        continue;
      }
      if (placedImportedOrigins.has(key)) continue;
      placedImportedOrigins.add(key);
      projectedIds.push(imported.id);
      segment.allMessagesById = { ...segment.allMessagesById, [imported.id]: imported.message };
      importedStorageOrigins.set(imported.id, imported.storageSessionId);
    }
    segment.messageIdsOldestFirst = projectedIds;
    if (!segment.isReadOnlyContext) {
      const inherited = segment.messageIdsOldestFirst.filter(id => SessionForkVisualOriginV1Schema.safeParse(segment.allMessagesById[id]?.meta?.forkVisualOriginV1).success);
      inherited.sort((a, b) => {
        const aOrigin = SessionForkVisualOriginV1Schema.parse(segment.allMessagesById[a]!.meta!.forkVisualOriginV1);
        const bOrigin = SessionForkVisualOriginV1Schema.parse(segment.allMessagesById[b]!.meta!.forkVisualOriginV1);
        return aOrigin.serverId === bOrigin.serverId && aOrigin.sessionId === bOrigin.sessionId ? aOrigin.sourceSeq - bOrigin.sourceSeq : 0;
      });
      const own = segment.messageIdsOldestFirst.filter(id => !SessionForkVisualOriginV1Schema.safeParse(segment.allMessagesById[id]?.meta?.forkVisualOriginV1).success);
      segment.messageIdsOldestFirst = [...inherited, ...own];
    }
  }

  // De-duplicate message ids across visible segments by preferring the earliest (ancestor) segment.
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
      isHistoryStartLoaded: seg.cutoffSeqInclusive === 0 || state.sessionMessagesHistoryStartLoaded?.[seg.sessionId] === true,
      messageIdsOldestFirst: seg.messageIdsOldestFirst,
    });

    for (const id of seg.messageIdsOldestFirst) {
      const message = seg.allMessagesById[id];
      if (!message) continue;
      combinedMessageIdsOldestFirst.push(id);
      combinedMessagesById[id] = message;
      messageOriginById[id] = { sessionId: importedStorageOrigins.get(id) ?? seg.sessionId, isReadOnlyContext: seg.isReadOnlyContext
        || SessionForkVisualOriginV1Schema.safeParse(message.meta?.forkVisualOriginV1).success };
    }
  }

  const isLoaded = state.sessionMessages[childSessionId]?.isLoaded ?? false;

  const snapshot: ForkedTranscriptSnapshot = {
    segments,
    combinedMessageIdsOldestFirst,
    combinedMessagesById,
    messageOriginById,
    isLoaded,
    visualSessionId: childSessionId,
    visualCopies,
  };

  cacheByChildSessionId.set(childSessionId, { key, snapshot });
  return snapshot;
}
