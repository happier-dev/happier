import type { ConversationDeliveryResultV1, ConversationSessionStatusInputV1 } from '@happier-dev/channels-protocol/v1';
import type { ConversationPermissionWaitMediationSourceReadResult } from './outwardDelivery.js';

export type SessionStatusTarget = Extract<ConversationPermissionWaitMediationSourceReadResult, { kind: 'ready' }>;
type Status = ConversationSessionStatusInputV1['status'];
type Presentation = { targetKey: string; status?: Status; providerMessageId?: string; acceptedLocalId?: string };

/** Activation-local presentation only; Session lifecycle remains the host's fact. */
export function createSessionStatusProjection(publish: (
  target: SessionStatusTarget, status: Status, providerMessageId?: string,
) => Promise<ConversationDeliveryResultV1>) {
  const presentations = new Map<string, Presentation>();
  async function show(target: SessionStatusTarget, status: Status) {
    const key = JSON.stringify([target.source.sessionId, target.source.sourceRevisionOrEpoch, target.endpoint.id]);
    let presentation = presentations.get(target.source.bindingId);
    if (presentation?.targetKey !== key) {
      presentation = { targetKey: key };
      presentations.set(target.source.bindingId, presentation);
    }
    if (presentation.status === status || (status === 'idle' && presentation.providerMessageId === undefined)) return;
    const result = await publish(target, status, presentation.providerMessageId);
    if (result.kind === 'delivered') {
      presentation.status = status;
      presentation.providerMessageId = result.providerMessageIds[0];
    }
  }
  return {
    async accepted(target: SessionStatusTarget, localId: string) {
      const prior = presentations.get(target.source.bindingId);
      const key = JSON.stringify([target.source.sessionId, target.source.sourceRevisionOrEpoch, target.endpoint.id]);
      if (prior?.targetKey === key && prior.acceptedLocalId === localId) return;
      await show(target, 'received');
      const presentation = presentations.get(target.source.bindingId);
      if (presentation) presentation.acceptedLocalId = localId;
    },
    async activity(target: SessionStatusTarget, activity: 'active' | 'idle' | 'stopped' | undefined, waitingForApproval: boolean) {
      if (activity === 'stopped') await show(target, 'idle');
      else if (waitingForApproval) await show(target, 'waitingForApproval');
      // Idle before the turn starts does not complete a newly queued input.
      else if (activity === 'active') await show(target, 'working');
      else if (activity === 'idle' && presentations.get(target.source.bindingId)?.status !== 'received') await show(target, 'idle');
    },
    async finished(target: SessionStatusTarget) { await show(target, 'idle'); },
    reconcile(bindingIds: ReadonlySet<string>) {
      for (const id of presentations.keys()) if (!bindingIds.has(id)) presentations.delete(id);
    },
  };
}
