import { describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';

import { buildTranscriptTurnUnits } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurnUnits';
import { buildTranscriptTurns } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import {
  insertTranscriptMarkers,
  projectTranscriptTurnEnds,
} from './transcriptMarkers';

const user = (seq: number): Message => ({
  kind: 'user-text',
  id: `m${seq}`,
  localId: null,
  seq,
  createdAt: seq,
  text: `prompt ${seq}`,
});
const agent = (seq: number): Message => ({
  kind: 'agent-text',
  id: `m${seq}`,
  localId: null,
  seq,
  createdAt: seq,
  text: `reply ${seq}`,
});
const tool = (seq: number, name: string, input: unknown = {}): Message =>
  ({
    kind: 'tool-call',
    id: `m${seq}`,
    localId: null,
    seq,
    createdAt: seq,
    children: [],
    tool: {
      id: `t${seq}`,
      name,
      state: 'completed',
      createdAt: seq,
      startedAt: seq,
      completedAt: seq,
      description: null,
      input,
      result: null,
    },
  }) as Message;
const turnDiff = (seq: number, turnId: string) =>
  tool(seq, 'Diff', {
    _happier: {
      v: 2,
      protocol: 'claude',
      rawToolName: 'Diff',
      canonicalToolName: 'Diff',
      sessionChangeScope: 'turn',
      sessionId: 's1',
      turnId,
      provider: 'claude',
      source: 'scm_checkpoint',
      confidence: 'exact',
      turnStatus: 'completed',
      seqRange: { startSeqInclusive: 1, endSeqInclusive: seq },
    },
    files: [
      {
        file_path: 'a.ts',
        source: 'scm_checkpoint',
        unified_diff: '@@ -1 +1 @@\n-old\n+new\n',
      },
    ],
  });

/** The rows both layouts hand to the marker stage: real turn grouping, then real unit decomposition. */
function rowsFor(messages: readonly Message[]) {
  const byId = Object.fromEntries(
    messages.map((message) => [message.id, message]),
  );
  const turns = buildTranscriptTurns({
    messageIdsOldestFirst: messages.map((m) => m.id),
    messagesById: byId,
    groupToolCalls: true,
  });
  const rows = buildTranscriptTurnUnits({
    items: turns.map((turn) => ({ kind: 'turn' as const, id: turn.id, turn })),
    getMessageById: (id) => byId[id] ?? null,
    isGroupExpanded: () => false,
    collapsedPreviewCount: 0,
  });
  return { rows, getMessageById: (id: string) => byId[id] ?? null };
}
const shape = (rows: readonly { kind: string; id: string }[]) =>
  rows.map((row) =>
    row.kind === 'transcript-marker'
      ? row.id
      : row.kind === 'message'
        ? row.id.replace(/^msg:/, '')
        : row.kind,
  );

describe('transcript markers', () => {
  it('puts a turn line above its own changes card, after a tool group, and New at the opened cursor', () => {
    const { rows, getMessageById } = rowsFor([
      user(1),
      tool(2, 'Bash'),
      tool(3, 'Read'),
      agent(4),
      turnDiff(5, 'turn-1'),
      user(6),
      agent(7),
    ]);
    const turnEnds = projectTranscriptTurnEnds([
      {
        turnId: 'turn-1',
        status: 'completed',
        startedAt: 0,
        updatedAt: 72_000,
        terminalAt: 72_000,
        transcriptAnchors: {
          startSeqInclusive: 1,
          endSeqInclusive: 5,
          finalAssistantMessageSeq: 4,
        },
      },
      {
        turnId: 'turn-2',
        status: 'failed',
        startedAt: 80_000,
        updatedAt: 120_000,
        terminalAt: 120_000,
        transcriptAnchors: { startSeqInclusive: 6, endSeqInclusive: 7 },
      },
      // Still running, and a sub-second turn: neither draws a line.
      {
        turnId: 'turn-3',
        status: 'in_progress',
        startedAt: 130_000,
        updatedAt: 130_000,
        transcriptAnchors: { startSeqInclusive: 8 },
      },
      {
        turnId: 'turn-4',
        status: 'completed',
        startedAt: 0,
        updatedAt: 400,
        terminalAt: 400,
        transcriptAnchors: { endSeqInclusive: 7 },
      },
    ]);
    expect(
      turnEnds.map((fact) => [fact.turnId, fact.outcome, fact.durationMs]),
    ).toEqual([
      ['turn-1', 'worked', 72_000],
      ['turn-2', 'stopped', 40_000],
    ]);

    const marked = insertTranscriptMarkers({
      items: rows,
      sessionId: 's1',
      getMessageById,
      newDividerAfterSeq: 5,
      turnEnds,
    });
    expect(shape(marked)).toEqual([
      'm1',
      'tool-group-header',
      'tool-group-footer',
      'm4',
      'transcript-marker:turn-end:turn-1',
      'm5',
      'transcript-marker:new',
      'm6',
      'm7',
      'transcript-marker:turn-end:turn-2',
    ]);
  });

  it('draws no New when nothing read precedes it, and leaves rows untouched when nothing is placed', () => {
    const { rows, getMessageById } = rowsFor([user(1), agent(2)]);
    expect(
      shape(
        insertTranscriptMarkers({
          items: rows,
          sessionId: 's1',
          getMessageById,
          newDividerAfterSeq: 0,
          turnEnds: [],
        }),
      ),
    ).toEqual(['m1', 'm2']);
    expect(
      insertTranscriptMarkers({
        items: rows,
        sessionId: 's1',
        getMessageById,
        newDividerAfterSeq: 2,
        turnEnds: [],
      }),
    ).toBe(rows);
  });
});
