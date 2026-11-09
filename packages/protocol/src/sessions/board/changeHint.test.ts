import { describe, expect, it } from 'vitest';
import { readSessionUpdatedMessageChangeHintV1 } from '../../changes/index.js';
import { buildSessionSystemRecordChangeV1, isSessionSystemRecordUnchangedHintV1, readSessionSystemRecordChangeV1 } from './changeHint.js';

describe('Session record change routing', () => {
  it('keeps the physical record entity separate and admits only its strict content-free address', () => {
    const target = { sessionId: 'session-one', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' } } as const;
    const change = buildSessionSystemRecordChangeV1('physical-row', target);
    expect(change.entityId).toBe('session-record:physical-row');
    expect(readSessionSystemRecordChangeV1(change)).toEqual(target);
    for (const hint of [
      { v: 2, sessionRecords: target },
      { ...change.hint, content: 'private content' },
      { v: 1, sessionRecords: { ...target, content: 'private content' } },
    ]) expect(readSessionSystemRecordChangeV1({ ...change, hint })).toBeNull();
    expect(readSessionSystemRecordChangeV1({ ...change, kind: 'session' })).toBeNull();
  });
  it('excludes only known row facts from record invalidation', () => {
    expect(isSessionSystemRecordUnchangedHintV1({ lastMessageSeq: 2, lastMessageId: 'ordinary-message' })).toBe(true);
    // The changes HTTP owner enriches these same stored hints with pending Run targets.
    expect(isSessionSystemRecordUnchangedHintV1({ lastMessageSeq: 2, pendingExecutionRunIds: ['run-one'] })).toBe(true);
    expect(isSessionSystemRecordUnchangedHintV1({ sharedMetadataVersion: 3, pendingExecutionRunIds: [] })).toBe(true);
    for (const hint of [{ metadataVersion: 2 }, { agentStateVersion: 3 }, { metadataVersion: 2, agentStateVersion: 3 },
      { runtimeActivityRevision: 4 }, { latestTurnStatusObservedAt: 100 },
      { latestReadyEventSeq: 7, latestReadyEventAt: 123 }]) {
      expect(isSessionSystemRecordUnchangedHintV1(hint)).toBe(true);
      expect(isSessionSystemRecordUnchangedHintV1({ ...hint, pendingExecutionRunIds: [] })).toBe(true);
      expect(isSessionSystemRecordUnchangedHintV1({ ...hint, followSourceChanged: false })).toBe(true);
      expect(isSessionSystemRecordUnchangedHintV1({ ...hint, followReceiverAvailabilityChanged: false })).toBe(true);
      expect(isSessionSystemRecordUnchangedHintV1({ ...hint, followReceiverAvailabilityChanged: true,
        followReceiverAvailabilityChangedAtCursor: 1 })).toBe(true);
      expect(isSessionSystemRecordUnchangedHintV1({ ...hint, followSourceChanged: false, followSourceUnchangedSinceCursor: 1 })).toBe(true);
      expect(isSessionSystemRecordUnchangedHintV1({ ...hint, followSourceChanged: true })).toBe(false);
      expect(isSessionSystemRecordUnchangedHintV1({ ...hint, futureAccessFact: true })).toBe(false);
    }
    for (const hint of [null, {}, { lastMessageSeq: 2, futureAccessFact: true }, { access: 'revoked' }]) {
      expect(isSessionSystemRecordUnchangedHintV1(hint)).toBe(false);
    }
    for (const hint of [{ pendingExecutionRunIds: [] }, { lastMessageSeq: 2, pendingExecutionRunIds: [7] },
      { lastMessageSeq: 2, pendingExecutionRunIds: [], futureAccessFact: true }]) {
      expect(isSessionSystemRecordUnchangedHintV1(hint)).toBe(false);
    }
  });
  it('carries a durable row revision as a known row fact and reads it only when well-formed', () => {
    const hint = { updatedMessageSeq: 15, updatedMessageId: 'm15', updatedMessageUpdatedAt: 1_700_000_000_123 };
    expect(isSessionSystemRecordUnchangedHintV1(hint)).toBe(true);
    expect(isSessionSystemRecordUnchangedHintV1({ ...hint, pendingExecutionRunIds: [] })).toBe(true);
    expect(readSessionUpdatedMessageChangeHintV1({ kind: 'session', hint }))
      .toEqual({ seq: 15, messageId: 'm15', updatedAt: 1_700_000_000_123 });
    // Hints without (or with a malformed) revision keep the conservative read.
    for (const updatedMessageUpdatedAt of [undefined, -1, 1.5, '1700000000123']) {
      expect(readSessionUpdatedMessageChangeHintV1({ kind: 'session', hint: { ...hint, updatedMessageUpdatedAt } }))
        .toEqual({ seq: 15, messageId: 'm15' });
    }
  });
});
