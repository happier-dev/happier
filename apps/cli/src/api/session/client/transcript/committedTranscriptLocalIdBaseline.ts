import { readStreamedTranscriptSourceMessageId } from '../../streamedTranscriptWriter/buildStreamedTranscriptSegmentSnapshot';

export type CommittedTranscriptLocalIdBaseline = Readonly<{
  localIds: Set<string>;
  complete: boolean;
}>;

const committedLocalIdsBySession = new WeakMap<object, Set<string>>();

/** Live projection and follow retain the same custody identities for the Session lifetime. */
export function getSessionCommittedTranscriptLocalIds(session: object): Set<string> {
  let localIds = committedLocalIdsBySession.get(session);
  if (!localIds) {
    localIds = new Set<string>();
    committedLocalIdsBySession.set(session, localIds);
  }
  return localIds;
}

/** A new Run transcript target writes through its parent Session's durable identity owner. */
export function shareSessionCommittedTranscriptLocalIds(target: object, session: object): void {
  committedLocalIdsBySession.set(target, getSessionCommittedTranscriptLocalIds(session));
}

type TranscriptLocalIdBaselinePage = Readonly<{
  messages: readonly Readonly<{
    seq?: unknown;
    localId?: unknown;
    meta?: unknown;
  }>[];
  hasMore: boolean;
  nextBeforeSeq: number | null;
}>;

export async function loadCommittedTranscriptLocalIdBaseline(params: Readonly<{
  localIds?: Set<string>;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  fetchPage(input: Readonly<{
    limit: number;
    beforeSeq?: number;
    signal?: AbortSignal;
    deadlineAtMs?: number;
  }>): Promise<TranscriptLocalIdBaselinePage>;
}>): Promise<CommittedTranscriptLocalIdBaseline> {
  const localIds = params.localIds ?? new Set<string>();
  let beforeSeq: number | undefined;
  let complete = true;

  // Completeness belongs to the containing follow admission, not a total-row
  // cutoff. Keep only identities and discard each transport page after reading.
  for (;;) {
    params.signal?.throwIfAborted();
    const page = await params.fetchPage({
      limit: 500,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      ...(params.signal === undefined ? {} : { signal: params.signal }),
      ...(params.deadlineAtMs === undefined
        ? {}
        : { deadlineAtMs: params.deadlineAtMs }),
    });
    for (const row of page.messages) {
      if (typeof row.localId === 'string' && row.localId.trim().length > 0) {
        localIds.add(row.localId);
        const sourceMessageId = readStreamedTranscriptSourceMessageId(row.localId, row.meta);
        if (sourceMessageId) localIds.add(sourceMessageId);
      }
    }
    if (!page.hasMore) break;
    if (
      page.messages.length === 0
      || page.nextBeforeSeq === null
      || (beforeSeq !== undefined && page.nextBeforeSeq >= beforeSeq)
    ) {
      complete = false;
      break;
    }
    beforeSeq = page.nextBeforeSeq;
  }

  return Object.freeze({
    localIds,
    complete,
  });
}
