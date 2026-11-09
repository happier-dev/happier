import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { MachineStorageSuggestionsDeclineInputV1 } from '@happier-dev/protocol/storage/storageV1';

import { declineMachineStorageSuggestionsViaAction } from '@/sync/domains/machines/storage/machineRpc';

import { readResourceProposalApproval } from './readResourceProposalApproval';
import { resolveResourceProposalDeclines } from './resourceProposalPresentation';

/**
 * After a storage proposal's decision lands, the items the person turned down are remembered by the
 * storage owner (plan 40 STO-31): all of them on Not now, the unticked ones on a subset approval.
 * Best effort: an unreachable machine just offers them again later; the decision already stands.
 */
export async function recordResourceProposalDeclines(
  approval: ApprovalRequest,
  decision: 'approve' | 'reject' | 'cancel',
  narrowedInput: unknown,
  declinedItems: readonly Readonly<Record<string, unknown>>[] | undefined,
  serverId: string | null,
): Promise<boolean> {
  const input = resolveResourceProposalDeclines(
    readResourceProposalApproval(approval),
    decision,
    narrowedInput,
    declinedItems,
  );
  if (!input) return false;
  const target = input.serverId ?? serverId;
  const result = await declineMachineStorageSuggestionsViaAction({
    machineId: input.machineId,
    ...(target ? { serverId: target } : {}),
    items: input.items as MachineStorageSuggestionsDeclineInputV1['items'],
  }).catch(() => null);
  return Boolean(result?.ok);
}
