import { storageReasonLabel } from '@/components/machines/storage/storageReasonPresentation';
import { t } from '@/text';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';

import type { ResourceProposalModel } from './readResourceProposalApproval';

import type { ResourceProposalController } from './useResourceProposalCheck';

export function readResourceProposalTitle(model: ResourceProposalModel): string {
  return t(model.kind === 'processes' ? 'resourceProposal.title.processes'
    : model.retry ? 'resourceProposal.title.retry' : 'resourceProposal.title.storage');
}

/** The card's title and the decision labels the existing approval footers take (lab `ra` A2/A3/A4). */
export function resolveResourceProposalLabels(
  proposal: ResourceProposalController,
): Readonly<{
  title: string;
  approve: string;
  reject: string;
}> {
  const { model, selectedCount } = proposal;
  if (model.kind === 'processes') {
    return {
      title: readResourceProposalTitle(model),
      approve: model.actionId === 'machines.processes.kill'
        ? t('machineProcesses.kill.confirmTree', { count: selectedCount })
        : model.actionId === 'machines.processes.leftBehind.cleanUp'
          ? t('machineProcesses.cleanUp', { count: selectedCount, amount: formatMachineBytes(proposal.selectedBytes, 'memory') })
          : t('resourceProposal.approve.stop', { count: selectedCount }),
      reject: t('resourceProposal.notNow'),
    };
  }
  return {
    title: readResourceProposalTitle(model),
    approve: model.storageMode === 'delete'
      ? t('machineStorage.review.deleteForGood', { count: selectedCount })
      : model.emptyAfter
        ? t('resourceProposal.approve.emptyAndRetry')
        : t('resourceProposal.approve.trash', { count: selectedCount }),
    reject: t('resourceProposal.notNow'),
  };
}

/**
 * The Inbox row's facts for a proposal (lab `ra` A5): "7 items, all safe · merged worktrees, old caches"
 * or "19 items · 16 safe, 3 need your eye", from the request's own claims (nothing is read).
 */
export function describeResourceProposalInboxFacts(model: ResourceProposalModel): string {
    const count = model.items.length;
    if (model.kind === 'processes') return model.actionId === 'machines.processes.kill'
        ? t('machineProcesses.kill.confirmTree', { count })
        : model.actionId === 'machines.processes.leftBehind.cleanUp'
          ? t('machineProcesses.review.title', { count })
          : t('resourceProposal.inbox.stops', { count });
    const safe = model.items.filter((item) => item.claimedVerdict === 'safe').length;
    const head = safe === count
        ? t('resourceProposal.inbox.allSafe', { count })
        : t('resourceProposal.inbox.mixed', { count, safe, attention: count - safe });
    const reasons = [...new Set(model.items.flatMap((item) => (item.reason ? [storageReasonLabel(item.reason)] : [])))].slice(0, 3);
    return reasons.length > 0 ? `${head} · ${reasons.join(', ')}` : head;
}
