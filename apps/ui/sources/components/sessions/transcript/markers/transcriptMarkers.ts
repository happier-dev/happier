import type { Message } from '@happier-dev/session-core/messages';
import { readTurnChangeToolMetadataFromToolCall } from '@happier-dev/protocol/sessions/messages/canonicalTurnDiffTool';
import type { SessionTurnV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';

import type { TranscriptMarker } from '@/components/sessions/chatListItems';
import type { TranscriptRowShellItem } from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/**
 * A settled turn's end, placed by its recorded transcript anchors: how long it ran from its recorded start to its
 * recorded end, and whether it finished or was stopped. Turns without both recorded times or an end anchor
 * have no line; nothing here is inferred from message timestamps.
 */
export type TranscriptTurnEndFact = Readonly<{
  turnId: string;
  startSeq: number | null;
  endSeq: number;
  /** Where the next turn starts; rows between this turn's end anchor and it (its error, late tool rows) are still this turn's. */
  nextTurnStartSeq: number | null;
  outcome: 'worked' | 'stopped';
  durationMs: number;
  endedAtMs: number;
}>;

/** What the transcript needs to place its markers; both facts come from their owners, resolved by the root. */
export type TranscriptMarkerInputs = Readonly<{
  /** The Session's read cursor as captured when this surface was opened; null draws no divider. */
  newDividerAfterSeq: number | null;
  viewerScope: ServerAccountScope | null;
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

function readStartSeq(turn: SessionTurnV1): number | null {
  return readSeq(turn.transcriptAnchors?.startSeqInclusive) ?? readSeq(turn.transcriptAnchors?.startUserMessageSeq);
}

/** The Session's settled turns as turn-end facts, oldest end first. */
export function projectTranscriptTurnEnds(
  turns: readonly SessionTurnV1[] | null | undefined,
): readonly TranscriptTurnEndFact[] {
  if (!turns || turns.length === 0) return EMPTY_TURN_ENDS;
  // Every turn's start, running ones included: a settled turn's rows stop where any later turn begins.
  const starts = turns.map(readStartSeq).filter((seq): seq is number => seq !== null).sort((left, right) => left - right);
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
    const startSeq = readStartSeq(turn);
    facts.push({
      turnId: turn.turnId,
      startSeq,
      endSeq,
      nextTurnStartSeq: starts.find((seq) => seq > endSeq && (startSeq === null || seq > startSeq)) ?? null,
      outcome,
      durationMs,
      endedAtMs: turn.terminalAt,
    });
  }
  if (facts.length === 0) return EMPTY_TURN_ENDS;
  return facts.sort((left, right) => left.endSeq - right.endSeq);
}

type SeqBlock = {
  first: number;
  last: number;
  minSeq: number;
  maxSeq: number;
  prompt: boolean;
  viewerPrompt: boolean;
  memberSeqs?: readonly number[];
};

function markerItem(
  id: string,
  marker: TranscriptMarker,
): Extract<TranscriptRowShellItem, { kind: 'transcript-marker' }> {
  return { kind: 'transcript-marker', id, marker };
}

/** Index of the last block starting at or before `seq`, including a group spanning it. */
function lastBlockStartingAtOrBefore(blocks: readonly SeqBlock[], seq: number): number {
  let low = 0;
  let high = blocks.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (blocks[middle]!.minSeq <= seq) {
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
 * - "New" before the first row beyond the opened read cursor that was not authored by the viewer as a
 *   prompt, only when some read row precedes it (a divider needs read history above it).
 * - Each settled turn's duration line after the turn's last row, or directly above the turn's own
 *   changes card when that card is in the transcript, so the line and the card read as one turn end. A
 *   turn's last row is the last one before the next prompt or the next turn's start: its error row and any
 *   tool rows recorded after its end anchor still belong to it. The end anchor must be represented
 *   by a row, a group member, or loaded coverage for an absorbed row.
 *
 * Rows carry their message `seq`; rows from a fork's ancestor context count from another Session's origin
 * and are skipped. Returns `items` itself when nothing is placed.
 */
export function insertTranscriptMarkers(params: TranscriptMarkerInputs & Readonly<{
  items: readonly TranscriptRowShellItem[];
  sessionId: string;
  getMessageById: (messageId: string) => Message | null;
  isSeqRangeLoaded?: (fromInclusive: number, toInclusive: number) => boolean;
}>): readonly TranscriptRowShellItem[] {
  const { items, sessionId, getMessageById, newDividerAfterSeq, viewerScope, turnEnds, isSeqRangeLoaded } = params;
  if (items.length === 0 || (newDividerAfterSeq === null && turnEnds.length === 0)) return items;

  const blocks: SeqBlock[] = [];
  const changesRowIndexByTurnId = new Map<string, number>();
  let openGroup: { groupId: string; first: number; minSeq: number; maxSeq: number; memberSeqs: number[] } | null = null;
  const isForeign = (item: { originSessionId?: string; isReadOnlyContext?: boolean }) =>
    item.isReadOnlyContext === true || (item.originSessionId !== undefined && item.originSessionId !== sessionId);

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind === 'message') {
      if (isForeign(item) || item.seq === null) continue;
      const message = getMessageById(item.messageId);
      if (turnEnds.length > 0 && message?.kind === 'tool-call' && message.tool?.name === 'Diff') {
        const changes = readTurnChangeToolMetadataFromToolCall(message.tool);
        if (changes) changesRowIndexByTurnId.set(changes.turnId, index);
      }
      const prompt = message?.kind === 'user-text';
      blocks.push({
        first: index, last: index, minSeq: item.seq, maxSeq: item.seq, prompt,
        viewerPrompt: newDividerAfterSeq !== null && prompt && areServerAccountScopesEqual(message.accountActor, viewerScope),
      });
      continue;
    }
    if (item.kind === 'tool-group-header') {
      openGroup = null;
      if (isForeign(item)) continue;
      let minSeq = Number.POSITIVE_INFINITY;
      let maxSeq = Number.NEGATIVE_INFINITY;
      const memberSeqs: number[] = [];
      for (const toolMessageId of item.toolMessageIds) {
        const seq = readSeq(getMessageById(toolMessageId)?.seq);
        if (seq === null) continue;
        memberSeqs.push(seq);
        if (seq < minSeq) minSeq = seq;
        if (seq > maxSeq) maxSeq = seq;
      }
      if (minSeq <= maxSeq) {
        openGroup = { groupId: item.groupId, first: index, minSeq, maxSeq, memberSeqs };
      }
      continue;
    }
    if (item.kind === 'tool-group-footer' && openGroup?.groupId === item.groupId) {
      blocks.push({
        first: openGroup.first, last: index, minSeq: openGroup.minSeq, maxSeq: openGroup.maxSeq,
        prompt: false, viewerPrompt: false, memberSeqs: openGroup.memberSeqs,
      });
      openGroup = null;
    }
  }
  if (blocks.length === 0) return items;

  const before = new Map<number, TranscriptRowShellItem[]>();
  const after = new Map<number, TranscriptRowShellItem[]>();
  const place = (target: Map<number, TranscriptRowShellItem[]>, index: number, item: TranscriptRowShellItem) => {
    const list = target.get(index);
    if (list) list.push(item);
    else target.set(index, [item]);
  };

  if (newDividerAfterSeq !== null && blocks[0]!.maxSeq <= newDividerAfterSeq) {
    const firstUnread = blocks.findIndex((block) => block.maxSeq > newDividerAfterSeq && !block.viewerPrompt);
    if (firstUnread > 0) place(before, blocks[firstUnread]!.first, markerItem('transcript-marker:new', { type: 'new' }));
  }

  for (const fact of turnEnds) {
    let blockIndex = lastBlockStartingAtOrBefore(blocks, fact.endSeq);
    const anchoredBlock = blocks[blockIndex];
    if (!anchoredBlock || (fact.startSeq !== null && anchoredBlock.maxSeq < fact.startSeq)) continue;
    if (
      anchoredBlock.minSeq !== fact.endSeq
      && !anchoredBlock.memberSeqs?.includes(fact.endSeq)
      && !isSeqRangeLoaded?.(Math.min(anchoredBlock.maxSeq, fact.endSeq), fact.endSeq)
    ) continue;

    const id = `transcript-marker:turn-end:${fact.turnId}`;
    const changesRowIndex = changesRowIndexByTurnId.get(fact.turnId);
    if (changesRowIndex !== undefined) {
      place(before, changesRowIndex, markerItem(id, {
        type: 'turn-end', outcome: fact.outcome, durationMs: fact.durationMs, joinsChanges: true,
      }));
      continue;
    }
    const until = fact.nextTurnStartSeq ?? Number.POSITIVE_INFINITY;
    while (blockIndex + 1 < blocks.length && !blocks[blockIndex + 1]!.prompt && blocks[blockIndex + 1]!.minSeq < until) {
      blockIndex += 1;
    }
    place(after, blocks[blockIndex]!.last, markerItem(id, {
      type: 'turn-end', outcome: fact.outcome, durationMs: fact.durationMs, joinsChanges: false,
    }));
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
