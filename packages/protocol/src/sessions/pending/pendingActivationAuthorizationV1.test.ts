import { describe, expect, it } from 'vitest';

import {
  PendingActivationAuthorizationV1Schema,
  PendingActivationFailureRequestV1Schema,
  PendingActivationFailureResponseV1Schema,
  PendingActivationFailureQueryV1Schema,
} from './pendingActivationAuthorizationV1.js';

describe('PendingActivationAuthorizationV1', () => {
  it('accepts closed diagnostic query facts without admitting private failure prose', () => {
    const failureDetails = { reason: 'spawn-rejected', spawnErrorCode: 'SPAWN_VALIDATION_FAILED', runtimeReason: 'no_eligible_member' };
    expect(PendingActivationFailureQueryV1Schema.parse({ failureDetails: JSON.stringify(failureDetails) })).toEqual({ failureDetails });
    expect(PendingActivationFailureQueryV1Schema.safeParse({ failureDetails: JSON.stringify({ ...failureDetails, message: 'private' }) }).success).toBe(false);
    expect(PendingActivationFailureQueryV1Schema.safeParse({ failureDetails: JSON.stringify({ reason: 'private' }) }).success).toBe(false);
  });
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
    })).toEqual({
      requestId: 'pending-1',
      requestedAt: 42,
      status: 'failed',
      failureCode: 'runtime_start_failed',
    });
    expect(PendingActivationFailureRequestV1Schema.safeParse({
      requestId: 'pending-1',
      requestedAt: 42,
      failureCode: 'machine_offline',
    }).success).toBe(false);
    expect(PendingActivationFailureResponseV1Schema.parse({ ok: true, didFail: false }))
      .toEqual({ ok: true, didFail: false });
  });
});
