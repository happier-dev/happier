import { describe, expect, it } from 'vitest';

import {
  SESSION_PENDING_QUEUE_HOLD_MAX_TTL_MS,
  SessionMetadataSchema,
  isSessionPendingQueueHoldBlockingPendingDrain,
  removeSessionPendingQueueHoldV1FromMetadata,
  writeSessionPendingQueueHoldV1ToMetadata,
} from '../../index.js';

describe('session pending queue hold metadata', () => {
  it('blocks pending drain while a pending-message edit hold is unexpired', () => {
    const metadata = writeSessionPendingQueueHoldV1ToMetadata({}, {
      holdId: 'hold-1',
      localId: 'pending-1',
      updatedAtMs: 1_000,
      expiresAtMs: 61_000,
    });

    expect(SessionMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(isSessionPendingQueueHoldBlockingPendingDrain(metadata, 60_000)).toBe(true);
    expect(isSessionPendingQueueHoldBlockingPendingDrain(metadata, 61_000)).toBe(false);
  });

  it('removes the hold key when the final pending queue hold is cleared', () => {
    const metadata = writeSessionPendingQueueHoldV1ToMetadata({}, {
      holdId: 'hold-1',
      localId: 'pending-1',
      updatedAtMs: 1_000,
      expiresAtMs: 61_000,
    });

    const nextMetadata = removeSessionPendingQueueHoldV1FromMetadata(metadata, 'hold-1');

    expect(isSessionPendingQueueHoldBlockingPendingDrain(nextMetadata, 60_000)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(nextMetadata, 'sessionPendingQueueHoldV1')).toBe(false);
  });

  it('clamps newly written pending queue holds to the protocol max ttl', () => {
    const metadata = writeSessionPendingQueueHoldV1ToMetadata({}, {
      holdId: 'hold-1',
      localId: 'pending-1',
      updatedAtMs: 1_000,
      expiresAtMs: 1_000 + SESSION_PENDING_QUEUE_HOLD_MAX_TTL_MS + 1,
    });

    const hold = (metadata.sessionPendingQueueHoldV1 as any)?.holdsById?.['hold-1'];
    expect(hold.expiresAtMs).toBe(1_000 + SESSION_PENDING_QUEUE_HOLD_MAX_TTL_MS);
    expect(isSessionPendingQueueHoldBlockingPendingDrain(metadata, 1_000 + SESSION_PENDING_QUEUE_HOLD_MAX_TTL_MS - 1)).toBe(true);
    expect(isSessionPendingQueueHoldBlockingPendingDrain(metadata, 1_000 + SESSION_PENDING_QUEUE_HOLD_MAX_TTL_MS)).toBe(false);
  });

  it('ignores unreasonably far-future pending queue holds when checking drain blocking', () => {
    const metadata = {
      sessionPendingQueueHoldV1: {
        v: 1,
        holdsById: {
          'hold-1': {
            v: 1,
            holdId: 'hold-1',
            kind: 'pending_message_edit',
            localId: 'pending-1',
            updatedAtMs: 1_000,
            expiresAtMs: 1_000 + SESSION_PENDING_QUEUE_HOLD_MAX_TTL_MS + 1,
          },
        },
      },
    };

    expect(SessionMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(isSessionPendingQueueHoldBlockingPendingDrain(metadata, 1_001)).toBe(false);
  });

  it('prunes expired pending queue holds when writing another hold', () => {
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

    const holdsById = (nextMetadata.sessionPendingQueueHoldV1 as any)?.holdsById;
    expect(Object.keys(holdsById)).toEqual(['active', 'next']);
  });
});
