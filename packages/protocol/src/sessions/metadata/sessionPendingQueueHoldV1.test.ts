import { describe, expect, it } from 'vitest';

import {
  SESSION_PENDING_QUEUE_HOLD_MAX_TTL_MS,
  SessionMetadataSchema,
  readSessionPendingQueueHoldV1FromMetadata,
  isSessionPendingQueueHoldBlockingPendingDrain,
  removeSessionPendingQueueHoldV1FromMetadata,
  writeSessionPendingQueueHoldV1ToMetadata,
} from '../../index.js';

describe('session pending queue hold metadata', () => {
  it('preserves the exact opaque pending-message local id', () => {
    const metadata = writeSessionPendingQueueHoldV1ToMetadata({}, {
      holdId: 'hold-opaque',
      localId: ' pending-1 ',
      updatedAtMs: 1_000,
      expiresAtMs: 61_000,
    });

    expect(SessionMetadataSchema.safeParse(metadata).success).toBe(true);
    expect((metadata.sessionPendingQueueHoldV1 as {
      holdsById: Record<string, { localId: string }>;
    }).holdsById['hold-opaque']?.localId).toBe(' pending-1 ');
  });

  it('blocks only while the admitted edit is present, independently of the old metadata expiry', () => {
    const metadata = writeSessionPendingQueueHoldV1ToMetadata({}, {
      holdId: 'hold-1',
      localId: 'pending-1',
      updatedAtMs: 1_000,
      expiresAtMs: 61_000,
    });

    expect(SessionMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(isSessionPendingQueueHoldBlockingPendingDrain(metadata, ['hold-1'])).toBe(true);
    expect(isSessionPendingQueueHoldBlockingPendingDrain(metadata, [])).toBe(false);
    expect(isSessionPendingQueueHoldBlockingPendingDrain({}, ['another-device'])).toBe(true);
    expect(isSessionPendingQueueHoldBlockingPendingDrain(metadata, null)).toBe(true);
    expect(isSessionPendingQueueHoldBlockingPendingDrain({}, null)).toBe(false);
  });

  it('removes the hold key when the final pending queue hold is cleared', () => {
    const metadata = writeSessionPendingQueueHoldV1ToMetadata({}, {
      holdId: 'hold-1',
      localId: 'pending-1',
      updatedAtMs: 1_000,
      expiresAtMs: 61_000,
    });

    const nextMetadata = removeSessionPendingQueueHoldV1FromMetadata(metadata, 'hold-1');

    expect(isSessionPendingQueueHoldBlockingPendingDrain(nextMetadata, ['hold-1'])).toBe(true);
    expect(isSessionPendingQueueHoldBlockingPendingDrain(nextMetadata, [])).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(nextMetadata, 'sessionPendingQueueHoldV1')).toBe(false);
  });

  it('clamps newly written pending queue holds to the protocol max ttl', () => {
    const metadata = writeSessionPendingQueueHoldV1ToMetadata({}, {
      holdId: 'hold-1',
      localId: 'pending-1',
      updatedAtMs: 1_000,
      expiresAtMs: 1_000 + SESSION_PENDING_QUEUE_HOLD_MAX_TTL_MS + 1,
    });

    const hold = readSessionPendingQueueHoldV1FromMetadata(metadata)?.holdsById['hold-1'];
    expect(hold?.expiresAtMs).toBe(1_000 + SESSION_PENDING_QUEUE_HOLD_MAX_TTL_MS);
  });

  it('does not erase another device edit when its old metadata expiry has passed', () => {
    const metadata = {
      sessionPendingQueueHoldV1: {
        v: 1,
        holdsById: {
          expired: {
            v: 1,
            holdId: 'expired',
            kind: 'pending_message_edit',
            localId: 'pending-old',
            updatedAtMs: 1_000,
            expiresAtMs: 2_000,
          },
          active: {
            v: 1,
            holdId: 'active',
            kind: 'pending_message_edit',
            localId: 'pending-active',
            updatedAtMs: 2_000,
            expiresAtMs: 4_000,
          },
        },
      },
    };

    const nextMetadata = writeSessionPendingQueueHoldV1ToMetadata(metadata, {
      holdId: 'next',
      localId: 'pending-next',
      updatedAtMs: 3_000,
      expiresAtMs: 4_000,
    });

    const holdsById = readSessionPendingQueueHoldV1FromMetadata(nextMetadata)!.holdsById;
    expect(Object.keys(holdsById)).toEqual(['expired', 'active', 'next']);
    expect(isSessionPendingQueueHoldBlockingPendingDrain(nextMetadata, ['expired'])).toBe(true);
    const released = removeSessionPendingQueueHoldV1FromMetadata(nextMetadata, 'next');
    expect(isSessionPendingQueueHoldBlockingPendingDrain(released, ['expired'])).toBe(true);
  });
});
