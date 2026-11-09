import { describe, expect, it } from 'vitest';

import { createSessionFollowOriginalWork } from './sessionFollowOriginalWork';

const receiver = 'receiver';
const original = { sourceSessionId: 'source', sourceMessage: { seq: 1, localId: 'original' } };

describe('Session Follow original scheduling custody', () => {
  it('retains receiver availability during admission and consumes duplicate releases in one retry', () => {
    const work = createSessionFollowOriginalWork();
    const finish = work.start(receiver, original, 1)!;
    work.available(receiver);
    work.available(receiver);
    expect(work.state(receiver, original)).toBe('running');
    expect(work.start(receiver, original, 1)).toBeNull();
    finish('held', 'receiver');
    const retry = work.start(receiver, original, 1);
    expect(retry).not.toBeNull();
    retry!('held', 'receiver');
    expect(work.start(receiver, original, 1)).toBeNull();
  });

  it('does not let an overlapping source push release a receiver-held admission failure', () => {
    const work = createSessionFollowOriginalWork();
    const finish = work.start(receiver, original, 1)!;
    work.sourceAvailable(original.sourceSessionId);
    finish('held', 'receiver');
    expect(work.state(receiver, original)).toBe('held');
    expect(work.start(receiver, original, 1)).toBeNull();
    work.sourceAvailable(original.sourceSessionId);
    expect(work.start(receiver, original, 1)).toBeNull();
    work.available(receiver);
    expect(work.start(receiver, original, 1)).not.toBeNull();
  });

  it('retains source recovery during evaluation and releases only the affected source once', () => {
    const work = createSessionFollowOriginalWork();
    const finish = work.start(receiver, original, 1)!;
    work.sourceAvailable('unrelated');
    finish('held', 'source');
    expect(work.start(receiver, original, 1)).toBeNull();
    const sibling = { ...original, sourceMessage: { seq: 2, localId: 'sibling' } };
    const finishSibling = work.start(receiver, sibling, 1)!;
    work.sourceAvailable(original.sourceSessionId);
    finishSibling('held', 'source');
    const retry = work.start(receiver, sibling, 1);
    expect(retry).not.toBeNull();
    retry!('held', 'source');
    expect(work.start(receiver, sibling, 1)).toBeNull();
  });

  it.each(['held', 'settled'] as const)('retains a rule edit during evaluation ending %s without repeated retries', outcome => {
    const work = createSessionFollowOriginalWork();
    const finish = work.start(receiver, original, 1)!;
    work.changed(false);
    finish(outcome, 'receiver');
    expect(work.state(receiver, original)).toBeUndefined();
    const retry = work.start(receiver, original, 1);
    expect(retry).not.toBeNull();
    retry!(outcome, 'receiver');
    expect(work.start(receiver, original, 1)).toBeNull();
  });

  it('retains accepted Pending custody through overlapping and later invalidations', () => {
    const work = createSessionFollowOriginalWork();
    const finish = work.start(receiver, original, 1)!;
    work.available(receiver);
    work.sourceAvailable(original.sourceSessionId);
    work.changed(false);
    finish('admitted');
    expect(work.state(receiver, original)).toBe('admitted');
    work.available(receiver);
    work.sourceAvailable(original.sourceSessionId);
    work.changed(false);
    expect(work.start(receiver, original, 1)).toBeNull();
  });

  it('keeps settled misses quiet through source and receiver availability', () => {
    const work = createSessionFollowOriginalWork();
    work.start(receiver, original, 1)!('settled');
    work.available(receiver);
    work.sourceAvailable(original.sourceSessionId);
    expect(work.state(receiver, original)).toBe('settled');
    expect(work.start(receiver, original, 1)).toBeNull();
  });

  it('keeps receiver demand through release fanout and withdraws it for settled or admitted custody', () => {
    const work = createSessionFollowOriginalWork();
    expect(work.hasHeldReceiver(receiver)).toBe(false);
    const finish = work.start(receiver, original, 1)!;
    expect(work.hasHeldReceiver(receiver)).toBe(true);
    expect(work.hasHeldReceiver('unrelated')).toBe(false);
    work.available(receiver);
    finish('held', 'receiver');
    expect(work.hasHeldReceiver(receiver)).toBe(true);
    work.available(receiver);
    expect(work.hasHeldReceiver(receiver)).toBe(true);
    work.start(receiver, original, 1)!('settled');
    expect(work.hasHeldReceiver(receiver)).toBe(false);
    work.changed(false);
    work.start(receiver, original, 1)!('admitted');
    expect(work.hasHeldReceiver(receiver)).toBe(false);
  });

  it('keeps held source/route work reachable by a qualified receiver recovery and consumes the release once', () => {
    const work = createSessionFollowOriginalWork();
    work.start(receiver, original, 1)!('held', 'source');
    expect(work.hasHeldReceiver(receiver)).toBe(true);
    work.available(receiver);
    const retry = work.start(receiver, original, 1);
    expect(retry).not.toBeNull();
    retry!('admitted');
    expect(work.hasHeldReceiver(receiver)).toBe(false);
  });

  it('retires applied terminal history and visits no unrelated live originals', () => {
    const work = createSessionFollowOriginalWork();
    let visits = 0;
    for (let index = 0; index < 1000; index++) {
      const terminal = { get sourceSessionId() { visits++; return 'source'; },
        sourceTurn: { id: `turn-${index}`, status: 'completed' as const } };
      work.start(receiver, terminal)!('admitted');
      work.observed(receiver, 'source', { transcriptSeq: index + 1, agentStateVersion: 0,
        readyEventSeq: 0, turn: terminal.sourceTurn });
      expect(work.state(receiver, terminal)).toBeUndefined();
    }
    const held = { get sourceSessionId() { visits++; return 'held-source'; },
      sourceTurn: { id: 'held-turn', status: 'completed' as const } };
    work.start(receiver, held)!('held', 'source');
    const awaitingEffect = { get sourceSessionId() { visits++; return 'pending-source'; },
      sourceTurn: { id: 'pending-turn', status: 'completed' as const } };
    work.start(receiver, awaitingEffect)!('admitted');
    work.observed(receiver, 'pending-source', { transcriptSeq: 0, agentStateVersion: 0, readyEventSeq: 0, turn: null });
    expect(work.state(receiver, awaitingEffect)).toBe('admitted');
    visits = 0;
    work.sourceAvailable('unrelated');
    expect(visits).toBe(0);
    expect(work.state(receiver, awaitingEffect)).toBe('admitted');
    work.sourceAvailable('held-source');
    const retry = work.start(receiver, held);
    expect(retry).not.toBeNull();
    retry!('held', 'source');
    expect(work.start(receiver, held)).toBeNull();
  });
});
