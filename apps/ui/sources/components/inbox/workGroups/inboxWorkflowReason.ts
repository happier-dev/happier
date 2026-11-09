import type { InboxWorkItem } from '@/activity/presentation/buildInboxWorkGroups';
import { isTerminalWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { t } from '@/text';

/** The Run's admitted hold, shared by its Inbox row and Brief; never inferred from its title. */
export function buildInboxWorkflowReasonFacts(item: Extract<InboxWorkItem, { kind: 'workflow_run' }>): readonly string[] {
    const summary = item.row.summary;
    if (!item.heldStepLabel || summary && isTerminalWorkflowRunState(summary.state)) return [];
    const moreHeld = Math.max(0, (summary?.heldCount ?? 1) - 1);
    const sentence = moreHeld > 0
        ? t('workflows.run.attentionWaitRowMore', { step: item.heldStepLabel, count: moreHeld })
        : item.heldStepNeed === 'approval'
            ? t('workflows.run.attentionApprovalRow', { step: item.heldStepLabel })
            : t('workflows.run.attentionWaitRow', { step: item.heldStepLabel });
    return [sentence, ...(item.heldStepLaneLabel ? [item.heldStepLaneLabel] : [])];
}
