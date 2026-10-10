import { describe, expect, it } from 'vitest';

import {
  SessionFollowFrontierV1Schema,
  compareSessionFollowFrontierProgressV1,
  isSessionFollowFrontierEqualV1,
  isSessionFollowConsumptionWithinCurrentV1,
  normalizeSessionFollowFrontierV1,
  projectSessionFollowFrontierFromSourceV1,
  encodePersistedSessionFollowFrontierV1,
  parsePersistedSessionFollowFrontierV1,
} from './sessionFollowFrontierV1.js';

describe('SessionFollowFrontierV1', () => {
  it('makes inactive own-turn progress deliverable without transcript or clock progress', () => {
    const source = { seq: 0, latestReadyEventSeq: 0, agentStateVersion: 0,
      latestTurnId: 'worker-turn', latestTurnStatus: 'in_progress', active: true };
    const online = projectSessionFollowFrontierFromSourceV1(source);
    const offline = projectSessionFollowFrontierFromSourceV1({ ...source, active: false });
    expect(online.turn).toBeNull();
    expect(offline.turn).toEqual({ id: 'worker-turn', status: 'stalled' });
    expect(compareSessionFollowFrontierProgressV1(online, offline)).toBe('ahead');
    expect(compareSessionFollowFrontierProgressV1(offline, offline)).toBe('equal');
    expect(parsePersistedSessionFollowFrontierV1(encodePersistedSessionFollowFrontierV1(offline))).toEqual(offline);
    expect(projectSessionFollowFrontierFromSourceV1({ ...source, active: false, latestTurnStatus: 'completed' }).turn)
      .toEqual({ id: 'worker-turn', status: 'completed' });
  });

  it('rejects unknown top-level fields', () => {
    const parsed = SessionFollowFrontierV1Schema.safeParse({
      transcriptSeq: 1,
      readyEventSeq: 0,
      agentStateVersion: 0,
      turn: null,
      pendingVersion: 3,
    });
    expect(parsed.success).toBe(false);
  });

  it('drops additive persisted Voice frontier fields but refuses corrupt known frontier facts', () => {
    const frontier = { transcriptSeq: 3, readyEventSeq: 2, agentStateVersion: 1, turn: { id: 'turn-1', status: 'completed' as const } };
    expect(parsePersistedSessionFollowFrontierV1(encodePersistedSessionFollowFrontierV1(frontier))).toEqual(frontier);
    expect(parsePersistedSessionFollowFrontierV1(JSON.stringify(frontier))).toBeNull();
    expect(parsePersistedSessionFollowFrontierV1(JSON.stringify({ v: 1, ...frontier, future: true,
      turn: { ...frontier.turn, future: true } }))).toEqual(frontier);
    expect(parsePersistedSessionFollowFrontierV1(JSON.stringify({ v: 1, ...frontier, transcriptSeq: -1 }))).toBeNull();
    expect(parsePersistedSessionFollowFrontierV1(JSON.stringify({ v: 1, ...frontier, turn: { id: 'turn-1', status: 'running' } }))).toBeNull();
  });

  it('rejects a partially present terminal turn', () => {
    expect(SessionFollowFrontierV1Schema.safeParse({
      transcriptSeq: 0,
      readyEventSeq: 0,
      agentStateVersion: 0,
      turn: { id: 'turn-1', status: 'running' },
    }).success).toBe(false);
  });

  it('normalizes a null ready-event sequence to the same pre-ready frontier as 0', () => {
    const fromNull = normalizeSessionFollowFrontierV1({
      transcriptSeq: 4,
      readyEventSeq: null,
      agentStateVersion: 2,
      turn: null,
    });
    const fromZero = normalizeSessionFollowFrontierV1({
      transcriptSeq: 4,
      readyEventSeq: 0,
      agentStateVersion: 2,
      turn: null,
    });
    expect(fromNull).toEqual(fromZero);
    expect(isSessionFollowFrontierEqualV1(fromNull, fromZero)).toBe(true);
    expect(compareSessionFollowFrontierProgressV1(fromZero, fromNull)).toBe('equal');
  });

  it('treats the first positive ready sequence as pending progress', () => {
    const delivered = normalizeSessionFollowFrontierV1({
      transcriptSeq: 4,
      readyEventSeq: null,
      agentStateVersion: 2,
      turn: null,
    });
    const current = normalizeSessionFollowFrontierV1({
      transcriptSeq: 4,
      readyEventSeq: 1,
      agentStateVersion: 2,
      turn: null,
    });
    expect(compareSessionFollowFrontierProgressV1(delivered, current)).toBe('ahead');
  });

  it('compares terminal turns by exact identity and status, never by ordering', () => {
    const base = {
      transcriptSeq: 7,
      readyEventSeq: 2,
      agentStateVersion: 3,
    } as const;
    const completed = normalizeSessionFollowFrontierV1({
      ...base,
      turn: { id: 'turn-b', status: 'completed' },
    });
    const failedSameTurn = normalizeSessionFollowFrontierV1({
      ...base,
      turn: { id: 'turn-b', status: 'failed' },
    });
    const otherTurn = normalizeSessionFollowFrontierV1({
      ...base,
      turn: { id: 'turn-a', status: 'completed' },
    });
    expect(isSessionFollowFrontierEqualV1(completed, failedSameTurn)).toBe(false);
    expect(compareSessionFollowFrontierProgressV1(completed, failedSameTurn)).toBe('ahead');
    expect(compareSessionFollowFrontierProgressV1(completed, otherTurn)).toBe('ahead');
    expect(compareSessionFollowFrontierProgressV1(completed, completed)).toBe('equal');
  });

  it('reports regression when any numeric component moves backwards', () => {
    const delivered = normalizeSessionFollowFrontierV1({
      transcriptSeq: 7,
      readyEventSeq: 2,
      agentStateVersion: 3,
      turn: null,
    });
    const regressed = normalizeSessionFollowFrontierV1({
      transcriptSeq: 6,
      readyEventSeq: 2,
      agentStateVersion: 3,
      turn: null,
    });
    expect(compareSessionFollowFrontierProgressV1(delivered, regressed)).toBe('behind');
  });

  it('projects the frontier from the canonical source Session facts', () => {
    expect(projectSessionFollowFrontierFromSourceV1({
      seq: 12,
      latestReadyEventSeq: null,
      agentStateVersion: 5,
      latestTurnId: 'turn-x',
      latestTurnStatus: 'completed',
    })).toEqual({
      transcriptSeq: 12,
      readyEventSeq: 0,
      agentStateVersion: 5,
      turn: { id: 'turn-x', status: 'completed' },
    });
  });

  it('drops a non-terminal latest turn instead of inventing a partial turn state', () => {
    expect(projectSessionFollowFrontierFromSourceV1({
      seq: 12,
      latestReadyEventSeq: 3,
      agentStateVersion: 5,
      latestTurnId: 'turn-x',
      latestTurnStatus: 'running',
    })).toEqual({
      transcriptSeq: 12,
      readyEventSeq: 3,
      agentStateVersion: 5,
      turn: null,
    });
  });

  it('never derives a turn from a status without an id', () => {
    expect(projectSessionFollowFrontierFromSourceV1({
      seq: 1,
      latestReadyEventSeq: 0,
      agentStateVersion: 0,
      latestTurnId: null,
      latestTurnStatus: 'completed',
    }).turn).toBeNull();
  });

  it('rejects consumption past the exact frontier that was observed', () => {
    const expected = { transcriptSeq: 1, readyEventSeq: 1, agentStateVersion: 1, turn: null };
    const observed = { transcriptSeq: 2, readyEventSeq: 2, agentStateVersion: 2, turn: null };
    const current = { transcriptSeq: 3, readyEventSeq: 3, agentStateVersion: 3, turn: null };

    expect(isSessionFollowConsumptionWithinCurrentV1({
      expected,
      observed,
      consumed: { ...observed, transcriptSeq: 3 },
      current,
    })).toBe(false);
    expect(isSessionFollowConsumptionWithinCurrentV1({ expected, observed, consumed: observed, current })).toBe(true);
  });

  it('rejects a terminal turn that was current later but was not observed', () => {
    const expected = { transcriptSeq: 1, readyEventSeq: 1, agentStateVersion: 1, turn: null };
    const observed = {
      transcriptSeq: 2,
      readyEventSeq: 2,
      agentStateVersion: 2,
      turn: { id: 'turn-observed', status: 'completed' as const },
    };
    const current = {
      ...observed,
      turn: { id: 'turn-current', status: 'completed' as const },
    };

    expect(isSessionFollowConsumptionWithinCurrentV1({ expected, observed, consumed: current, current })).toBe(false);
  });
});
