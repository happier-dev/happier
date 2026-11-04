import { describe, expect, it } from 'vitest';
import { buildSessionSystemRecordChangeV1, isSessionSystemRecordUnchangedHintV1, readSessionSystemRecordChangeV1, SessionSurfacesChangeHintV1Schema } from './changeHint.js';

describe('Session surface change hint', () => {
  it('admits only the versioned content-free invalidation signal', () => {
    expect(SessionSurfacesChangeHintV1Schema.parse({ v: 1, sessionSurfaces: true }))
      .toEqual({ v: 1, sessionSurfaces: true });
    for (const hint of [
      { v: 1, sessionSurfaces: false },
      { v: 2, sessionSurfaces: true },
      { v: 1, sessionSurfaces: true, content: 'private content' },
    ]) expect(SessionSurfacesChangeHintV1Schema.safeParse(hint).success).toBe(false);
  });
});

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
});
