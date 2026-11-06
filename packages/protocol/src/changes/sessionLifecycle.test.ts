import { describe, expect, it } from 'vitest';

import {
  SessionDeletedChangeHintV1Schema,
  readAuthoritativeSessionDeletionChangeV1,
  readSessionFollowSourceChangedV1,
  readSessionUsageAccountingChangedV1,
} from './index.js';

it('retains accounting unless the consumed cursor proves every coalesced Session write unchanged', () => {
  const change = { kind: 'session', cursor: 14,
    hint: { agentStateVersion: 10, usageAccountingChanged: false, usageAccountingUnchangedSinceCursor: 8 } };
  expect(readSessionUsageAccountingChangedV1(change, 8)).toBe(false);
  expect(readSessionUsageAccountingChangedV1(change, 13)).toBe(false);
  expect(readSessionUsageAccountingChangedV1(change, 7)).toBe(true);
  expect(readSessionFollowSourceChangedV1(change, 13)).toBe(true);
  for (const hint of [undefined, {}, { agentStateVersion: 10 }, { usageAccountingChanged: false },
    { usageAccountingChanged: false, usageAccountingUnchangedSinceCursor: 14 },
    { usageAccountingChanged: false, usageAccountingUnchangedSinceCursor: -1 },
    { v: 1, lifecycle: 'deleted' }, { lastMessageSeq: 2 }]) {
    expect(readSessionUsageAccountingChangedV1({ ...change, hint }, 13)).toBe(true);
  }
  expect(readSessionUsageAccountingChangedV1({ ...change, kind: 'share' }, 13)).toBe(true);
});

describe('authoritative Session deletion AccountChange', () => {
  it('accepts only the closed deletion fact and projects its exact identity', () => {
    expect(SessionDeletedChangeHintV1Schema.parse({
      v: 1,
      lifecycle: 'deleted',
    })).toEqual({ v: 1, lifecycle: 'deleted' });
    expect(() => SessionDeletedChangeHintV1Schema.parse({
      v: 1,
      lifecycle: 'deleted',
      reason: 'access_revoked',
    })).toThrow();

    expect(readAuthoritativeSessionDeletionChangeV1({
      cursor: 12,
      kind: 'session',
      entityId: 'session-1',
      changedAt: 1,
      hint: { v: 1, lifecycle: 'deleted' },
    })).toEqual({ sessionId: 'session-1', cursor: 12 });
  });

  it('does not treat access/share revocation or another Session as deletion', () => {
    expect(readAuthoritativeSessionDeletionChangeV1({
      cursor: 13,
      kind: 'session',
      entityId: 'session-revoked',
      changedAt: 2,
      hint: null,
    })).toBeNull();
    expect(readAuthoritativeSessionDeletionChangeV1({
      cursor: 14,
      kind: 'share',
      entityId: 'session-1',
      changedAt: 3,
      hint: { v: 1, lifecycle: 'deleted' },
    })).toBeNull();
    expect(readAuthoritativeSessionDeletionChangeV1({
      cursor: 15,
      kind: 'session',
      entityId: ' session-1',
      changedAt: 4,
      hint: { v: 1, lifecycle: 'deleted' },
    })).toBeNull();
  });
});
