import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture, createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';

import { captureSessionTurnBaseline, collectFinalAssistantReplySinceBaseline, waitForTurnFinalAssistantText } from './waitForNextAssistantTextMessage';

const initialState = storage.getState();
let abort: AbortController;

function agent(id: string, text: string, seq: number): Message {
  return { kind: 'agent-text', id, text, seq, createdAt: 1, localId: null };
}

function user(id: string, localId: string, seq: number): Message {
  return { kind: 'user-text', id, text: 'question', localId, seq, createdAt: 1 };
}

function turns(turnId: string, status: 'in_progress' | 'completed' | 'cancelled' | 'failed', userMessageSeqs: number[], endSeqInclusive?: number): NonNullable<Session['sessionTurns']> {
  return {
    v: 1, sessionId: 's1', latestTurnId: turnId, updatedAt: Date.now(),
    turns: [{
      turnId, status, startedAt: 1, updatedAt: Date.now(),
      transcriptAnchors: { startUserMessageSeq: userMessageSeqs[0], userMessageSeqs, endSeqInclusive },
    }],
  };
}

function publish(projection: NonNullable<Session['sessionTurns']>, messages: Message[]) {
  const latest = projection.turns.find((turn) => turn.turnId === projection.latestTurnId)!;
  const now = Date.now();
  storage.setState({
    sessions: { s1: createSessionFixture({
      id: 's1', active: true, activeAt: now, sessionTurns: projection,
      latestTurnId: latest.turnId, latestTurnStatus: latest.status, latestTurnStatusObservedAt: now,
    }) },
    sessionMessages: { s1: createSessionMessagesFixture({
      messageIdsOldestFirst: messages.map((message) => message.id),
      messagesById: Object.fromEntries(messages.map((message) => [message.id, message])),
    }) },
  });
}

beforeEach(() => {
  storage.setState(initialState, true);
  abort = new AbortController();
});

afterEach(() => {
  abort.abort();
  storage.setState(initialState, true);
});

describe('voice reply binding through the real transcript store', () => {
  it('reads a delayed committed voice input before its reply when an unsequenced permission row is present', () => {
    storage.setState({ sessions: { s1: createSessionFixture({
      id: 's1',
      agentState: { requests: { permission: {
        tool: 'Bash', arguments: { command: 'pwd' }, createdAt: 2_000,
      } } },
    }) } });
    storage.getState().applyMessages('s1', []);
    const baseline = captureSessionTurnBaseline('s1');

    storage.getState().applyMessages('s1', [{
      id: 'reply', seq: 13, localId: null, createdAt: 1_000,
      isSidechain: false, role: 'agent',
      content: [{ type: 'text', text: 'Your answer.', uuid: 'reply', parentUUID: null }],
    }]);
    // The sending client and provider can have different clocks. The delayed user
    // acknowledgement still owns an earlier transcript sequence than the answer.
    storage.getState().applyMessages('s1', [{
      id: 'submitted', seq: 12, localId: 'voice-input', createdAt: 3_000,
      isSidechain: false, role: 'user', content: { type: 'text', text: 'question' },
    }]);

    expect(collectFinalAssistantReplySinceBaseline('s1', baseline, {
      localId: 'voice-input', endSeqInclusive: 13,
    })).toBe('Your answer.');
    const entry = storage.getState().sessionMessages.s1!;
    expect(entry.messageIdsOldestFirst.map((id) => entry.messagesById[id]?.seq)
      .filter((seq) => typeof seq === 'number')).toEqual([12, 13]);
  });

  it('completes when the voice input steered the already-running turn', async () => {
    publish(turns('turn-a', 'in_progress', [10]), []);
    const baseline = captureSessionTurnBaseline('s1');
    let settled: string | null | undefined;
    const waiting = waitForTurnFinalAssistantText({
      sessionId: 's1', baseline, signal: abort.signal, submittedUserLocalId: 'voice-input',
    }).then((text) => { settled = text; return text; });
    publish(turns('turn-a', 'completed', [10, 12], 13), [user('u1', 'voice-input', 12), agent('a1', 'Both checks pass.', 13)]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe('Both checks pass.');
    await waiting;
  });

  it('never speaks a delivered subagent report as the assistant reply', async () => {
    publish(turns('turn-0', 'completed', [1], 2), []);
    const baseline = captureSessionTurnBaseline('s1');
    const waiting = waitForTurnFinalAssistantText({
      sessionId: 's1', baseline, signal: abort.signal, submittedUserLocalId: 'voice-input',
    });
    publish(turns('turn-voice', 'completed', [12], 15), [
      user('u1', 'voice-input', 12),
      { kind: 'agent-text', id: 'report', text: 'Subagent findings.', seq: 13, createdAt: 1, localId: null,
        peer: { name: 'general-purpose', handback: true } },
      agent('a1', 'The fix is ready.', 14),
    ]);
    await expect(waiting).resolves.toBe('The fix is ready.');
  });

  it.each([false, true])('retains an answer before a late peer delivery unless the assistant answers again (laterReply=%s)', async laterReply => {
    publish(turns('turn-0', 'completed', [1], 2), []);
    const baseline = captureSessionTurnBaseline('s1');
    const waiting = waitForTurnFinalAssistantText({
      sessionId: 's1', baseline, signal: abort.signal, submittedUserLocalId: 'voice-input',
    });
    publish(turns('turn-voice', 'completed', [12], 16), [
      user('u1', 'voice-input', 12),
      agent('a1', 'The fix is ready.', 13),
      { kind: 'agent-text', id: 'report', text: 'Subagent findings.', seq: 14, createdAt: 1, localId: null,
        peer: { name: 'general-purpose', handback: true } },
      ...(laterReply ? [agent('a2', 'The final checks pass too.', 15)] : []),
    ]);
    await expect(waiting).resolves.toBe(laterReply ? 'The final checks pass too.' : 'The fix is ready.');
  });

  it.each(['tool', 'user'] as const)('clears the pre-peer fallback when a later %s starts new work', async boundary => {
    publish(turns('turn-0', 'completed', [1], 2), []);
    const baseline = captureSessionTurnBaseline('s1');
    const waiting = waitForTurnFinalAssistantText({
      sessionId: 's1', baseline, signal: abort.signal, submittedUserLocalId: 'voice-input',
    });
    publish(turns('turn-voice', 'completed', [12], 16), [
      user('u1', 'voice-input', 12), agent('a1', 'Let me check.', 13),
      { kind: 'agent-text', id: 'report', text: 'Subagent findings.', seq: 14, createdAt: 1, localId: null,
        peer: { name: 'general-purpose', handback: true } },
      boundary === 'tool' ? createToolCallMessageFixture({ id: 'tool', seq: 15 }) : user('u2', 'followup', 15),
    ]);
    await expect(waiting).resolves.toBeNull();
  });

  it('does not mistake another client\'s terminal turn for the queued voice input', async () => {
    publish(turns('turn-0', 'completed', [1], 2), []);
    const baseline = captureSessionTurnBaseline('s1');
    let settled: string | null | undefined;
    const waiting = waitForTurnFinalAssistantText({
      sessionId: 's1', baseline, signal: abort.signal, submittedUserLocalId: 'voice-input',
    }).then((text) => { settled = text; return text; });
    publish(turns('turn-other', 'completed', [10], 11), [user('other-user', 'other-client', 10), agent('other', 'Unrelated reply.', 11)]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBeUndefined();
    publish(turns('turn-voice', 'completed', [12], 13), [user('u1', 'voice-input', 12), agent('a1', 'Your answer.', 13)]);
    await expect(waiting).resolves.toBe('Your answer.');
  });

  it('reads the submitted turn rather than a later conversation already in the store', async () => {
    publish(turns('turn-0', 'completed', [1], 2), []);
    const baseline = captureSessionTurnBaseline('s1');
    const waiting = waitForTurnFinalAssistantText({
      sessionId: 's1', baseline, signal: abort.signal, submittedUserLocalId: 'voice-input',
    });
    const submitted = turns('turn-voice', 'completed', [12], 13).turns[0]!;
    const later = turns('turn-later', 'completed', [14], 15);
    publish({ ...later, turns: [submitted, ...later.turns] }, [
      user('u1', 'voice-input', 12), agent('older-hydrated', 'An older hydrated reply.', 11), agent('a1', 'Your answer.', 13),
      user('u2', 'other-client', 14), agent('a2', 'Later unrelated answer.', 15),
      { kind: 'agent-text', id: 'later-stream', text: 'Uncommitted later narration.', localId: null, createdAt: 2 },
    ]);
    await expect(waiting).resolves.toBe('Your answer.');
  });

  it('waits for the completed turn end anchor to arrive before reading a reply', async () => {
    publish(turns('turn-0', 'completed', [1], 2), []);
    const baseline = captureSessionTurnBaseline('s1');
    let settled: string | null | undefined;
    const waiting = waitForTurnFinalAssistantText({
      sessionId: 's1', baseline, signal: abort.signal, submittedUserLocalId: 'voice-input',
    }).then(text => { settled = text; return text; });
    const messages = [user('u1', 'voice-input', 12), agent('a1', 'Your answer.', 13),
      user('u2', 'other-client', 14), agent('a2', 'Later unrelated answer.', 15)];
    publish(turns('turn-voice', 'completed', [12]), messages);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBeUndefined();
    publish(turns('turn-voice', 'completed', [12], 13), messages);
    await expect(waiting).resolves.toBe('Your answer.');
  });

  it.each(['cancelled', 'failed'] as const)('does not speak another turn after an unbounded %s turn', async status => {
    publish(turns('turn-0', 'completed', [1], 2), []);
    const baseline = captureSessionTurnBaseline('s1');
    const waiting = waitForTurnFinalAssistantText({
      sessionId: 's1', baseline, signal: abort.signal, submittedUserLocalId: 'voice-input',
    });
    publish(turns('turn-voice', status, [12]), [user('u1', 'voice-input', 12),
      user('u2', 'other-client', 14), agent('a2', 'Later unrelated answer.', 15)]);
    await expect(waiting).resolves.toBeNull();
  });

  it('does not infer current producer anchor support from a historical turn', async () => {
    const historical = turns('historical', 'completed', [1], 2).turns[0]!;
    publish({ ...turns('current', 'in_progress', []), turns: [historical,
      { turnId: 'current', status: 'in_progress', startedAt: 3, updatedAt: 3 }] }, []);
    const baseline = captureSessionTurnBaseline('s1');
    let settled: string | null | undefined;
    const waiting = waitForTurnFinalAssistantText({
      sessionId: 's1', baseline, signal: abort.signal, submittedUserLocalId: 'voice-input',
    }).then(text => { settled = text; return text; });
    publish({ ...turns('next', 'completed', []), turns: [historical,
      { turnId: 'next', status: 'completed', startedAt: 4, updatedAt: 4 }] },
      [user('u1', 'voice-input', 12), agent('a1', 'Current producer reply.', 13)]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe('Current producer reply.');
    await waiting;
  });

  it('waits for projection hydration before treating the current producer as unanchored', async () => {
    publish(turns('old', 'completed', [1], 2), []);
    const baseline = captureSessionTurnBaseline('s1');
    let settled: string | null | undefined;
    const waiting = waitForTurnFinalAssistantText({
      sessionId: 's1', baseline, signal: abort.signal, submittedUserLocalId: 'voice-input',
    }).then(text => { settled = text; return text; });
    const oldSession = storage.getState().sessions.s1!;
    storage.setState({ sessions: { s1: { ...oldSession, latestTurnId: 'other', latestTurnStatus: 'completed' } },
      sessionMessages: { s1: createSessionMessagesFixture({ messageIdsOldestFirst: ['u1'],
        messagesById: { u1: user('u1', 'voice-input', 12) } }) } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBeUndefined();
    publish(turns('voice', 'completed', [12], 13), [user('u1', 'voice-input', 12), agent('a1', 'Your answer.', 13)]);
    await expect(waiting).resolves.toBe('Your answer.');
  });
});
