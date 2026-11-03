import { MachineAgentIsolationSetResultV1Schema } from '@happier-dev/protocol';

import type { ActionOperationStore } from './actionOperationStore';
import type { ActionOperationScope, ResolvedTrackedAction } from './actionOperationTypes';

export function settleReviewedIsolationPredecessors(input: Readonly<{
  store: ActionOperationStore;
  scope: ActionOperationScope;
  action: ResolvedTrackedAction;
  operationId: string;
  requestInput: unknown;
  result: unknown;
  isActive: (operationId: string) => boolean;
}>): void {
  if (input.action.actionId !== 'machines.agentIsolation.set' || !input.action.operationReentry) return;
  const result = MachineAgentIsolationSetResultV1Schema.safeParse(input.result);
  if (!result.success || (result.data.kind !== 'accepted' && result.data.kind !== 'unchanged')) return;

  for (const held of input.store.list({ ...input.scope, states: ['running'] }).items) {
    if (held.operationId === input.operationId || input.isActive(held.operationId)
      || held.actionId !== input.action.actionId || held.observation?.kind !== 'review_required') continue;
    // The existing reviewed-effect owner identifies the same intent. This only
    // settles its retained receipt; it neither admits nor repeats the effect.
    if (input.action.operationReentry(held, input.requestInput) === 'resume') {
      input.store.succeed(held.operationId, result.data);
    }
  }
}
