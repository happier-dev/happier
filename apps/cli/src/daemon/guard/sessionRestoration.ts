import { randomUUID } from 'node:crypto';
import type { RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';
import type { PendingInactiveSessionActivationRejected } from '../sessions/activatePendingInactiveSession';
import type { TrackedSession } from '../types';
import type { ActivityLog } from './activityLog';

/** Observes admitted activation/start results; it never makes a resume or launch decision. */
export function createGuardSessionRestoration(input: Readonly<{
  activity: Pick<ActivityLog, 'list' | 'append' | 'markUndone'>;
  nowMs?: () => number;
  readCustodianTarget?: () => (Omit<RequesterWorkAttributionV1, 'accountId'> & Readonly<{ custodianAccountId: string }>) | null;
}>) {
  const now = input.nowMs ?? Date.now;
  const readStopped = async (sessionId: string, attribution: RequesterWorkAttributionV1) => {
    const rows = await input.activity.list({ range: '30d', requester: attribution });
    const latest = rows.entries.find(row => row.kind === 'stopped_session' && row.outcome !== 'failed'
      && ['idle_sessions', 'memory_guard', 'ceiling'].includes(row.rule)
      && row.subject?.kind === 'session' && row.subject.sessionId === sessionId);
    return latest?.undoneAt === undefined ? latest : undefined;
  };
  return {
    async onSessionRunnerStarted(tracked: TrackedSession): Promise<void> {
      if (!tracked.happySessionId || !tracked.requesterWorkAttributionV1) return;
      const notice = tracked.happySessionMetadataFromLocalWebhook?.sessionGuardStateV1;
      // Requested also covers a replacement becoming ready before stop-receipt settlement.
      if (!notice || typeof notice !== 'object' || !('kind' in notice)
        || notice.kind !== 'stopped' && notice.kind !== 'requested') return;
      const receipt = await readStopped(tracked.happySessionId, tracked.requesterWorkAttributionV1);
      if (receipt) await input.activity.markUndone({ id: randomUUID(), ref: receipt.id, at: now(), attribution: tracked.requesterWorkAttributionV1 });
    },
    async onActivationRejected(event: PendingInactiveSessionActivationRejected): Promise<void> {
      const target = event.requester ? null : input.readCustodianTarget?.();
      // Machine custody is private admission context, not a work-attribution field.
      const attribution = event.requester ?? (target ? {
        serverId: target.serverId, accountId: target.custodianAccountId,
        machineId: target.machineId, installationId: target.installationId,
      } : null);
      if (!attribution) return;
      const receipt = await readStopped(event.sessionId, attribution);
      if (!receipt) return;
      const failure = event.failure ?? { reason: 'other' as const };
      await input.activity.append({ v: 1, id: randomUUID(), at: now(), kind: 'start_failed', rule: receipt.rule,
        subject: receipt.subject, attribution, outcome: 'failed', ref: receipt.id,
        failure,
        nextStep: failure.reason === 'no_ptys' ? 'close_idle_terminals' : 'review_processes',
        ...(receipt.wayBack ? { wayBack: receipt.wayBack } : {}) });
    },
  };
}
