import { z } from '../zodRuntimePolicy.js';
import type { DiscussionProducerV1 } from './content.js';

/** Shared wire invariant for stored and executor-opened Discussion messages. */
export function refineDiscussionAccountActor(
  value: Readonly<{
    authorAccountId: string | null;
    accountActor: Readonly<{ accountId: string }> | null;
    requesterAccountActor?: Readonly<{ accountId: string }> | null;
    producerV1?: DiscussionProducerV1 | null;
  }>,
  context: z.core.$RefinementCtx,
): void {
  if (value.accountActor !== null && value.accountActor.accountId !== value.authorAccountId) {
    context.addIssue({
      code: 'custom',
      path: ['accountActor', 'accountId'],
      message: 'Discussion actor identity must match the authenticated author',
    });
  }
  if (value.requesterAccountActor != null && value.requesterAccountActor.accountId !== (value.producerV1?.kind === 'agent'
    ? value.producerV1.actionRequestAttributionV1?.requester?.accountId : undefined)) {
    context.addIssue({ code: 'custom', path: ['requesterAccountActor', 'accountId'],
      message: 'Discussion requester actor must match its host-stamped cause' });
  }
}

