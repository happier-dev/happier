import { SessionStopRecordV1StoredSchema, type SessionStopRecordV1 } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import { buildSessionStopSystemRecordLocalId } from '@happier-dev/protocol/sessions/system/records/activity/activitySystemRecordKinds';
import { createSessionSystemRecordPayloadService } from '@/session/systemRecords/sessionSystemRecordPayloadService';

export type GuardSessionStopReceipt = Readonly<{
  settle(status: Exclude<SessionStopRecordV1['status'], 'requested'>): Promise<void>;
}>;

/** Retained by the exact runner's exit custody, using its already admitted requester record port. */
export function createGuardSessionStopReceipt(input: Readonly<{
  records: ReturnType<typeof createSessionSystemRecordPayloadService>;
  at: number;
  nowMs?: () => number;
  onSettled?(record: SessionStopRecordV1): Promise<void>;
}>): GuardSessionStopReceipt {
  const localId = buildSessionStopSystemRecordLocalId({ at: input.at });
  let settled: SessionStopRecordV1['status'] = 'requested';
  let pending: Promise<void> | undefined;
  return {
    async settle(status) {
      if (pending) await pending;
      if (settled === 'stopped' || settled === 'cancelled' || settled === status || settled !== 'requested' && status !== 'stopped') return;
      pending = (async () => {
        const record = await input.records.read({ namespace: 'activity', localId });
        // A refused pre-stop publication may definitively have created no record. Never create one at exit.
        if (!record) { settled = status; return; }
        if (record.kind !== 'session_stop.v1') throw new Error('guard_stop_receipt_unavailable');
        const facts = SessionStopRecordV1StoredSchema.parse(record.payload);
        if (facts.at !== input.at) throw new Error('guard_stop_receipt_identity_changed');
        if (facts.status === 'stopped' || facts.status === 'cancelled' || facts.status === status) {
          await input.onSettled?.(facts); settled = facts.status; return;
        }
        const result = { ...facts, status, settledAt: (input.nowMs ?? Date.now)() };
        await input.records.write({ namespace: 'activity', kind: 'session_stop.v1', localId, payload: result });
        await input.onSettled?.(result);
        settled = status;
      })();
      try { await pending; } finally { pending = undefined; }
    },
  };
}
