import type { Message } from '@happier-dev/session-core/messages';
import { readTurnChangeToolMetadataFromToolCall } from '@happier-dev/protocol/sessions/messages/canonicalTurnDiffTool';
import type { SessionTurnV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';

import type { TranscriptMarker } from '@/components/sessions/chatListItems';
import type { TranscriptRowShellItem } from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';

/**
 * A settled turn's end, placed by its recorded transcript anchors: how long it ran from its recorded start to its
 * recorded end, and whether it finished or was stopped. Turns without both recorded times or an end anchor
 * have no line; nothing here is inferred from message timestamps.
 */
export type TranscriptTurnEndFact = Readonly<{
  turnId: string;
  startSeq: number | null;
  endSeq: number;
  outcome: 'worked' | 'stopped';
  durationMs: number;
}>;

/** What the transcript needs to place its markers; both facts come from their owners, resolved by the root. */
export type TranscriptMarkerInputs = Readonly<{
    /** The Session's read cursor as captured when this surface was opened; null draws no divider. */
    newDividerAfterSeq: number | null;
    /** Settled turns, empty while "Show turn duration" is off. */
    turnEnds: readonly TranscriptTurnEndFact[];
}>;

const EMPTY_TURN_ENDS: readonly TranscriptTurnEndFact[] = Object.freeze([]);
/** The shared formatter shows nothing below a second, so a sub-second turn draws no line. */
const SHORTEST_SHOWN_TURN_MS = 1_000;

function readSeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

/** The Session's settled turns as turn-end facts, oldest end first. */
export function projectTranscriptTurnEnds(
  turns: readonly SessionTurnV1[] | null | undefined,
): readonly TranscriptTurnEndFact[] {
  if (!turns || turns.length === 0) return EMPTY_TURN_ENDS;
  const facts: TranscriptTurnEndFact[] = [];
  for (const turn of turns) {
    const outcome =
      turn.status === 'completed'
        ? 'worked'
        : turn.status === 'cancelled' || turn.status === 'failed'
          ? 'stopped'
          : null;
    if (!outcome || typeof turn.terminalAt !== 'number') continue;
    const durationMs = turn.terminalAt - turn.startedAt;
    if (!(durationMs >= SHORTEST_SHOWN_TURN_MS)) continue;
    const anchors = turn.transcriptAnchors;
    const endSeq =
      readSeq(anchors?.endSeqInclusive) ??
      readSeq(anchors?.finalAssistantMessageSeq);
    if (endSeq === null) continue;
    facts.push({
      turnId: turn.turnId,
      startSeq:
        readSeq(anchors?.startSeqInclusive) ??
        readSeq(anchors?.startUserMessageSeq),
      endSeq,
      outcome,
      durationMs,
    });
  }
  if (facts.length === 0) return EMPTY_TURN_ENDS;
  return facts.sort((left, right) => left.endSeq - right.endSeq);
}

type SeqBlock = { first: number; last: number; minSeq: number; maxSeq: number };

function markerItem(
  id: string,
  marker: TranscriptMarker,
): Extract<TranscriptRowShellItem, { kind: 'transcript-marker' }> {
  return { kind: 'transcript-marker', id, marker };
}

/** Index of the last block whose newest row is at or before `seq`, or -1. */
function lastBlockEndingAtOrBefore(
  blocks: readonly SeqBlock[],
  seq: number,
): number {
  let low = 0;
  let high = blocks.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (blocks[middle]!.maxSeq <= seq) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * Places the transcript's quiet markers between its rows (one pass over the rows, linear and turns layouts
 * alike since both arrive here as rows):
 *
 * - "New" before the first row this Session's read cursor had not reached when it was opened, only when
 *   some read row precedes it (a divider needs read history above it).
 * - Each settled turn's duration line after the turn's last row, or directly above the turn's own
 *   changes card when that card is in the transcript, so the line and the card read as one turn end.
 *
 * Rows carry their message `seq`; rows from a fork's ancestor context count from another Session's origin
 * and are skipped. Returns `items` itself when nothing is placed.
 */
export function insertTranscriptMarkers(
  params: Readonly<{
    items: readonly TranscriptRowShellItem[];
    sessionId: string;
    getMessageById: (messageId: string) => Message | null;
    newDividerAfterSeq: number | null;
    turnEnds: readonly TranscriptTurnEndFact[];
  }>,
): readonly TranscriptRowShellItem[] {
  const { items, sessionId, getMessageById, newDividerAfterSeq, turnEnds } =
    params;
  if (
    items.length === 0 ||
    (newDividerAfterSeq === null && turnEnds.length === 0)
  )
    return items;

  const blocks: SeqBlock[] = [];
  const changesRowIndexByTurnId = new Map<string, number>();
  let openGroup: {
    groupId: string;
    first: number;
    minSeq: number;
    maxSeq: number;
  } | null = null;
  const isForeign = (item: {
    originSessionId?: string;
    isReadOnlyContext?: boolean;
  }) =>
    item.isReadOnlyContext === true ||
    (item.originSessionId !== undefined && item.originSessionId !== sessionId);

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind === 'message') {
      if (isForeign(item) || item.seq === null) continue;
      if (turnEnds.length > 0) {
        const message = getMessageById(item.messageId);
        if (message?.kind === 'tool-call' && message.tool?.name === 'Diff') {
          const changes = readTurnChangeToolMetadataFromToolCall(message.tool);
          if (changes) changesRowIndexByTurnId.set(changes.turnId, index);
        }
      }
      blocks.push({
        first: index,
        last: index,
        minSeq: item.seq,
        maxSeq: item.seq,
      });
      continue;
    }
    if (item.kind === 'tool-group-header') {
      openGroup = null;
      if (isForeign(item)) continue;
      let minSeq = Number.POSITIVE_INFINITY;
      let maxSeq = Number.NEGATIVE_INFINITY;
      for (const toolMessageId of item.toolMessageIds) {
        const seq = readSeq(getMessageById(toolMessageId)?.seq);
        if (seq === null) continue;
        if (seq < minSeq) minSeq = seq;
        if (seq > maxSeq) maxSeq = seq;
      }
      if (minSeq <= maxSeq)
        openGroup = { groupId: item.groupId, first: index, minSeq, maxSeq };
      continue;
    }
    if (
      item.kind === 'tool-group-footer' &&
      openGroup?.groupId === item.groupId
    ) {
      blocks.push({
        first: openGroup.first,
        last: index,
        minSeq: openGroup.minSeq,
        maxSeq: openGroup.maxSeq,
      });
      openGroup = null;
    }
  }
  if (blocks.length === 0) return items;

  const before = new Map<number, TranscriptRowShellItem[]>();
  const after = new Map<number, TranscriptRowShellItem[]>();
  const place = (
    target: Map<number, TranscriptRowShellItem[]>,
    index: number,
    item: TranscriptRowShellItem,
  ) => {
    const list = target.get(index);
    if (list) list.push(item);
    else target.set(index, [item]);
  };

  if (newDividerAfterSeq !== null) {
    const firstUnread = blocks.findIndex(
      (block) => block.maxSeq > newDividerAfterSeq,
    );
    if (firstUnread > 0)
      place(
        before,
        blocks[firstUnread]!.first,
        markerItem('transcript-marker:new', { type: 'new' }),
      );
  }

  for (const fact of turnEnds) {
    const marker = markerItem(`transcript-marker:turn-end:${fact.turnId}`, {
      type: 'turn-end',
      outcome: fact.outcome,
      durationMs: fact.durationMs,
    });
    const changesRowIndex = changesRowIndexByTurnId.get(fact.turnId);
    if (changesRowIndex !== undefined) {
      place(before, changesRowIndex, marker);
      continue;
    }
    const blockIndex = lastBlockEndingAtOrBefore(blocks, fact.endSeq);
    if (blockIndex < 0) continue;
    const block = blocks[blockIndex]!;
    if (fact.startSeq !== null && block.maxSeq < fact.startSeq) continue;
    place(after, block.last, marker);
  }
  if (before.size === 0 && after.size === 0) return items;

  const output: TranscriptRowShellItem[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const ahead = before.get(index);
    if (ahead) output.push(...ahead);
    output.push(items[index]!);
    const behind = after.get(index);
    if (behind) output.push(...behind);
  }
  return output;
}
