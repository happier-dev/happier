import { describe, expect, it, vi } from 'vitest';
import type { Message, TranscriptAccountActor } from '@happier-dev/session-core/messages';
import type { SessionTurnV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';

import type { TranscriptRowShellItem } from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';
import { buildTranscriptTurnUnits } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurnUnits';
import { buildTranscriptTurns } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import {
  insertTranscriptMarkers,
  projectTranscriptTurnEnds,
} from './transcriptMarkers';

const viewer = { serverId: 'home', accountId: 'viewer' };
const user = (seq: number, accountActor?: TranscriptAccountActor): Message => ({
  kind: 'user-text',
  id: `m${seq}`,
  localId: null,
  seq,
  createdAt: seq,
  accountActor,
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
  it('projects settled turn anchors with the next running turn boundary', () => {
    const facts = projectTranscriptTurnEnds([
      { turnId: 'running', status: 'in_progress', startedAt: 10_000, updatedAt: 10_000,
        transcriptAnchors: { startSeqInclusive: 7 } },
      { turnId: 'stopped', status: 'failed', startedAt: 5_000, updatedAt: 9_000, terminalAt: 9_000,
        transcriptAnchors: { startSeqInclusive: 4, finalAssistantMessageSeq: 6 } },
      { turnId: 'completed', status: 'completed', startedAt: 0, updatedAt: 3_000, terminalAt: 3_000,
        transcriptAnchors: { startSeqInclusive: 1, endSeqInclusive: 3 } },
    ]);

    expect(facts.map(({ turnId, startSeq, endSeq, nextTurnStartSeq, outcome, durationMs, endedAtMs }) =>
      ({ turnId, startSeq, endSeq, nextTurnStartSeq, outcome, durationMs, endedAtMs }))).toEqual([
      { turnId: 'completed', startSeq: 1, endSeq: 3, nextTurnStartSeq: 4,
        outcome: 'worked', durationMs: 3_000, endedAtMs: 3_000 },
      { turnId: 'stopped', startSeq: 4, endSeq: 6, nextTurnStartSeq: 7,
        outcome: 'stopped', durationMs: 4_000, endedAtMs: 9_000 },
    ]);
  });

  it.each([100, 1_000, 2_500])('looks up later starts with linear visits for %i settled turns', (turnCount) => {
    const turns: SessionTurnV1[] = Array.from({ length: turnCount }, (_, index) => ({
      turnId: String(index), status: 'completed', startedAt: index * 2_000,
      terminalAt: index * 2_000 + 1_500, updatedAt: index * 2_000 + 1_500,
      transcriptAnchors: { startSeqInclusive: index * 2 + 1, endSeqInclusive: index * 2 + 2 },
    }));
    const sort = Array.prototype.sort;
    let orderedSlotVisits = 0;
    // Observe reads from sorted lists outside the sort itself, without replacing the projection or its decisions.
    const spy = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: unknown[], compare?: (a: unknown, b: unknown) => number) {
      return new Proxy(sort.call(this, compare), {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) orderedSlotVisits++;
          return Reflect.get(target, key, receiver);
        },
      });
    });
    let facts;
    try {
      facts = projectTranscriptTurnEnds(turns);
    } finally {
      spy.mockRestore();
    }
    expect(orderedSlotVisits).toBeLessThanOrEqual(2 * turnCount);
    expect(facts.map((fact) => fact.nextTurnStartSeq)).toEqual(turns.map((_, index) =>
      turns[index + 1]?.transcriptAnchors?.startSeqInclusive ?? null));
  });

  it('projects each row once on a reply arrival after 5,000 rows and 2,500 settled turns', () => {
    const turns: SessionTurnV1[] = Array.from({ length: 2_500 }, (_, index) => ({
      turnId: String(index),
      status: 'completed',
      startedAt: index * 10_000,
      terminalAt: index * 10_000 + 8_000,
      updatedAt: index * 10_000 + 8_000,
      transcriptAnchors: { startSeqInclusive: index * 2 + 1, endSeqInclusive: (index + 1) * 2 },
    }));
    turns.push({
      turnId: 'active', status: 'in_progress', startedAt: 25_000_000, updatedAt: 25_000_000,
      transcriptAnchors: { startSeqInclusive: 5_001 },
    });
    const messages = Array.from({ length: 5_002 }, (_, index) => index % 2 === 0
      ? user(index + 1, { v: 1, ...viewer, profile: null })
      : agent(index + 1));
    const rows: TranscriptRowShellItem[] = messages.map((message) => ({
      kind: 'message', id: `msg:${message.id}`, messageId: message.id, seq: message.seq ?? null, createdAt: message.createdAt,
    }));
    const byId = new Map(messages.map((message) => [message.id, message]));
    const getMessageById = (id: string) => byId.get(id) ?? null;
    const shared = { sessionId: 's1', turnEnds: projectTranscriptTurnEnds(turns), newDividerAfterSeq: 4800, viewerScope: viewer };
    const before = insertTranscriptMarkers({ ...shared, items: rows.slice(0, -1), getMessageById });
    let rowVisits = 0;
    let messageLookups = 0;
    const countedRows = new Proxy(rows, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) rowVisits += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const after = insertTranscriptMarkers({
      ...shared,
      items: countedRows,
      getMessageById: (id) => {
        messageLookups += 1;
        return getMessageById(id);
      },
    });
    expect(after).toEqual([...before, rows.at(-1)]);
    expect(after).toHaveLength(7_503);
    expect(messageLookups).toBe(rows.length);
    // One projection pass and at most one additional pass to materialize the marker rows.
    expect(rowVisits).toBeLessThanOrEqual(2 * rows.length);
  });

  it('puts a turn line above its own changes card, after a tool group, and New at the opened cursor', () => {
    const { rows, getMessageById } = rowsFor([
      user(1),
      tool(2, 'Bash'),
      tool(3, 'Read'),
      agent(4),
      turnDiff(5, 'turn-1'),
      user(6, { v: 1, ...viewer, profile: null }),
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
      ['turn-4', 'worked', 400],
    ]);

    const marked = insertTranscriptMarkers({
      items: rows,
      sessionId: 's1',
      getMessageById,
      viewerScope: viewer,
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
      'm6',
      'transcript-marker:new',
      'm7',
      'transcript-marker:turn-end:turn-2',
    ]);
  });

  it('keeps a collaborator prompt or a prompt of unknown authorship eligible for New', () => {
    const otherActors = [undefined, { v: 1 as const, ...viewer, accountId: 'collaborator', profile: null },
      { v: 1 as const, ...viewer, serverId: 'other-home', profile: null }];
    for (const otherActor of otherActors) {
      const { rows, getMessageById } = rowsFor([agent(5), user(6, { v: 1, ...viewer, profile: null }), user(7, otherActor), agent(8)]);
      const marked = insertTranscriptMarkers({
        items: rows, sessionId: 's1', getMessageById, viewerScope: viewer, newDividerAfterSeq: 5, turnEnds: [],
      });
      expect(shape(marked)).toEqual(['m5', 'm6', 'transcript-marker:new', 'm7', 'm8']);
    }
  });

  it('waits for the closing anchor when a transcript page stops before it or has a gap at it', () => {
    const turnEnds = projectTranscriptTurnEnds([
      { turnId: 'turn-1', status: 'completed', startedAt: 0, updatedAt: 4_000, terminalAt: 4_000,
        transcriptAnchors: { startSeqInclusive: 1, endSeqInclusive: 100 } },
    ]);
    for (const messages of [[user(1), agent(2)], [user(1), agent(2), agent(101)]]) {
      const { rows, getMessageById } = rowsFor(messages);
      expect(insertTranscriptMarkers({ items: rows, sessionId: 's1', getMessageById, viewerScope: null, newDividerAfterSeq: null, turnEnds })).toBe(rows);
    }
    const { rows, getMessageById } = rowsFor([user(1), agent(2), agent(100)]);
    expect(shape(insertTranscriptMarkers({ items: rows, sessionId: 's1', getMessageById, viewerScope: null, newDividerAfterSeq: null, turnEnds })))
      .toEqual(['m1', 'm2', 'm100', 'transcript-marker:turn-end:turn-1']);
  });

  it('allows a loaded target-window end that was absorbed into a visible row', () => {
    const { rows, getMessageById } = rowsFor([user(1), agent(2)]);
    const turnEnds = projectTranscriptTurnEnds([
      { turnId: 'turn-1', status: 'completed', startedAt: 0, updatedAt: 4_000, terminalAt: 4_000,
        transcriptAnchors: { startSeqInclusive: 1, endSeqInclusive: 3 } },
    ]);
    expect(shape(insertTranscriptMarkers({
      items: rows, sessionId: 's1', getMessageById, viewerScope: null, newDividerAfterSeq: null, turnEnds,
      isSeqRangeLoaded: (from, to) => from >= 1 && to <= 3,
    }))).toEqual(['m1', 'm2', 'transcript-marker:turn-end:turn-1']);
  });

  it('closes after the whole collapsed tool group when a member represents the closing anchor', () => {
    const turnEnds = projectTranscriptTurnEnds([
      { turnId: 'turn-1', status: 'completed', startedAt: 0, updatedAt: 4_000, terminalAt: 4_000,
        transcriptAnchors: { startSeqInclusive: 1, endSeqInclusive: 3 } },
    ]);
    const place = (messages: Message[]) => {
      const { rows, getMessageById } = rowsFor(messages);
      return shape(insertTranscriptMarkers({ items: rows, sessionId: 's1', getMessageById, viewerScope: null, newDividerAfterSeq: null, turnEnds }));
    };
    expect(place([tool(2, 'Bash'), tool(3, 'Read'), tool(4, 'Bash'), user(5)]))
      .toEqual(['tool-group-header', 'tool-group-footer', 'transcript-marker:turn-end:turn-1', 'm5']);
    expect(place([tool(2, 'Bash'), tool(4, 'Bash'), user(5)]))
      .toEqual(['tool-group-header', 'tool-group-footer', 'm5']);
  });

  it('ends a turn after its own error and late tool rows, before the next prompt or turn, with closing spacing', () => {
    const error: Message = { kind: 'agent-event', id: 'm3', localId: null, seq: 3, createdAt: 3,
      event: { type: 'message', message: 'The agent stopped with an error.' } } as Message;
    const { rows, getMessageById } = rowsFor([user(1), agent(2), error, tool(4, 'Bash'), user(5), agent(6), agent(7)]);
    const turnEnds = projectTranscriptTurnEnds([
      // Failed: its end anchor is the reply; the error and a delegate tool row were recorded after it.
      { turnId: 'turn-1', status: 'failed', startedAt: 0, updatedAt: 6_000, terminalAt: 6_000,
        transcriptAnchors: { startSeqInclusive: 1, endSeqInclusive: 2 } },
      { turnId: 'turn-2', status: 'completed', startedAt: 10_000, updatedAt: 19_000, terminalAt: 19_000,
        transcriptAnchors: { startSeqInclusive: 5, endSeqInclusive: 6 } },
      // A context-only turn with no prompt row starts at seq 7: turn 2's line stays before it.
      { turnId: 'turn-3', status: 'in_progress', startedAt: 20_000, updatedAt: 20_000, transcriptAnchors: { startSeqInclusive: 7 } },
    ]);
    const marked = insertTranscriptMarkers({ items: rows, sessionId: 's1', getMessageById, viewerScope: null, newDividerAfterSeq: null, turnEnds });
    expect(shape(marked)).toEqual(['m1', 'm2', 'm3', 'tool-group-header', 'tool-group-footer', 'transcript-marker:turn-end:turn-1',
      'm5', 'm6', 'transcript-marker:turn-end:turn-2', 'm7']);
    expect(marked.filter((row) => row.kind === 'transcript-marker').map((row) => row.kind === 'transcript-marker' ? row.marker : null))
      .toEqual([{ type: 'turn-end', outcome: 'stopped', durationMs: 6_000, joinsChanges: false },
        { type: 'turn-end', outcome: 'worked', durationMs: 9_000, joinsChanges: false }]);
  });

  it('draws no New when nothing read precedes it, and leaves rows untouched when nothing is placed', () => {
    const { rows, getMessageById } = rowsFor([user(1), agent(2)]);
    expect(
      shape(
        insertTranscriptMarkers({
          items: rows,
          sessionId: 's1',
          getMessageById,
          viewerScope: null,
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
        viewerScope: null,
        newDividerAfterSeq: 2,
        turnEnds: [],
      }),
    ).toBe(rows);
  });
});
