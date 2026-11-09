import { describe, expect, it } from 'vitest';
import {
  SessionPendingQueueHoldV1Schema,
  isSessionPendingQueueHoldBlockingPendingDrain,
  readSessionPendingQueueHoldV1FromMetadata,
  writeSessionPendingQueueHoldV1ToMetadata,
} from './sessionPendingQueueHoldV1.js';

describe('retained pending-message edit holds', () => {
  it('retains an active edit hold through retired annotations and still rejects invalid declared fields', () => {
    const hold = { v: 1, holdId: 'editing', kind: 'pending_message_edit', localId: 'pending-1',
      updatedAtMs: 1000, expiresAtMs: 61000 };
    const retained = { v: 1, retired: true, holdsById: { editing: { ...hold, retired: true } } };
    const metadata = { sessionPendingQueueHoldV1: retained };
    expect(isSessionPendingQueueHoldBlockingPendingDrain(metadata, ['editing'])).toBe(true);
    expect(readSessionPendingQueueHoldV1FromMetadata(metadata)).toEqual({ v: 1, holdsById: { editing: hold } });
    const updated = writeSessionPendingQueueHoldV1ToMetadata(metadata, {
      holdId: 'second', localId: 'pending-2', updatedAtMs: 2000, expiresAtMs: 62000,
    });
    expect(updated.sessionPendingQueueHoldV1).toMatchObject({ holdsById: { editing: hold } });
    expect(readSessionPendingQueueHoldV1FromMetadata({ sessionPendingQueueHoldV1: {
      ...retained, holdsById: { editing: { ...hold, expiresAtMs: 'invalid' } },
    } })).toBeNull();
    expect(SessionPendingQueueHoldV1Schema.safeParse(retained).success).toBe(false);
  });
});
