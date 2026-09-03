import { describe, expect, it } from 'vitest';

import {
  PendingActivationAuthorizationV1Schema,
  PendingActivationFailureRequestV1Schema,
} from './pendingActivationAuthorizationV1.js';

describe('PendingActivationAuthorizationV1Schema', () => {
  it('accepts waiting and terminal-failed authorizations and rejects unbounded failure codes', () => {
    expect(PendingActivationAuthorizationV1Schema.parse({
      requestId: 'pending-1',
      requestedAt: 42,
      status: 'waiting',
    })).toEqual({ requestId: 'pending-1', requestedAt: 42, status: 'waiting' });
    expect(PendingActivationAuthorizationV1Schema.parse({
      requestId: 'pending-1',
      requestedAt: 42,
      status: 'failed',
      failureCode: 'runtime_start_failed',
    })).toMatchObject({ status: 'failed', failureCode: 'runtime_start_failed' });
    expect(PendingActivationFailureRequestV1Schema.safeParse({
      requestId: 'pending-1',
      requestedAt: 42,
      failureCode: 'machine_offline',
    }).success).toBe(false);
  });
});
