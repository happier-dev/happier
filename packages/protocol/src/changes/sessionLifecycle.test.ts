import { describe, expect, it } from 'vitest';

import {
  SessionDeletedChangeHintV1Schema,
  readAuthoritativeSessionDeletionChangeV1,
} from './index.js';

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
