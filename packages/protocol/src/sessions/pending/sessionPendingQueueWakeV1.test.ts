import { describe, expect, it } from 'vitest';

import {
  SessionPendingQueueLegacyMaterializeDeferredResponseV0Schema,
  SessionPendingQueueWakeCapabilityResponseV1Schema,
  SessionPendingQueueWakeRequestV1Schema,
  SessionPendingQueueWakeResponseV1Schema,
} from './sessionPendingQueueWakeV1';

describe('sessionPendingQueueWakeV1', () => {
  it('freezes V0 as an upgrade deferral and rejects materializer results', () => {
    expect(SessionPendingQueueLegacyMaterializeDeferredResponseV0Schema.parse({
      ok: true, didMaterialize: false, result: { type: 'deferred', reason: 'runtime_upgrade_required' },
    })).toBeTruthy();
    expect(() => SessionPendingQueueLegacyMaterializeDeferredResponseV0Schema.parse({
      ok: true, didMaterialize: true, result: { type: 'materialized' },
    })).toThrow();
  });

  it('requires exact V1 discovery, request, and wake-only responses', () => {
    expect(SessionPendingQueueWakeCapabilityResponseV1Schema.parse({
      ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1',
    })).toBeTruthy();
    expect(SessionPendingQueueWakeRequestV1Schema.parse({ protocolVersion: 1 })).toEqual({ protocolVersion: 1 });
    expect(SessionPendingQueueWakeResponseV1Schema.parse({ ok: true, result: 'wake_published' })).toBeTruthy();
    expect(() => SessionPendingQueueWakeResponseV1Schema.parse({
      ok: true, result: 'wake_published', materialized: true,
    })).toThrow();
  });

  it('keeps the deployed wake request identity-free and strict', () => {
    expect(SessionPendingQueueWakeRequestV1Schema.safeParse({
      protocolVersion: 1,
      requestedAction: { v: 1, kind: 'send_now' },
    }).success).toBe(false);
  });
});
