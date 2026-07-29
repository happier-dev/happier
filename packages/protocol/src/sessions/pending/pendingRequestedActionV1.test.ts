import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PENDING_REQUESTED_ACTION_V1,
  PendingRequestedActionV1Schema,
  normalizePendingRequestedActionV1,
} from './pendingRequestedActionV1';

describe('PendingRequestedActionV1', () => {
  it.each(['enqueue', 'steer_if_active', 'steer_now', 'send_now'] as const)(
    'accepts the canonical %s action',
    (kind) => {
      expect(PendingRequestedActionV1Schema.parse({ v: 1, kind })).toEqual({ v: 1, kind });
    },
  );

  it('defaults only omitted legacy actions and rejects malformed non-null actions', () => {
    expect(normalizePendingRequestedActionV1(undefined)).toEqual(DEFAULT_PENDING_REQUESTED_ACTION_V1);
    expect(normalizePendingRequestedActionV1(null)).toEqual(DEFAULT_PENDING_REQUESTED_ACTION_V1);
    expect(() => normalizePendingRequestedActionV1({ v: 1, kind: 'interrupt_and_send' }))
      .toThrow('Malformed non-null Pending requested action');
  });
});
