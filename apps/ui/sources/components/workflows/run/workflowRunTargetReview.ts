import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowMaterializedLeafV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { t } from '@/text';

type WorkflowRunTargetReview = Pick<WorkflowMaterializedLeafV1, 'sourceKey' | 'blockId' | 'executionTarget'>;

export function formatWorkflowRunTargetReviewSummary(
    review: readonly WorkflowRunTargetReview[],
    executionTarget?: WorkflowRunTargetReview['executionTarget'],
): string {
    const kind = executionTarget?.kind ?? 'session';
    const label = kind === 'detached_run'
        ? t('workflows.page.sections.aBackgroundRun') : t('workflows.page.sections.aSession');
    const count = review.reduce((total, leaf) => total + Number(leaf.executionTarget.kind !== kind), 0);
    return count === 0 ? label : `${label} · ${t('workflows.start.targetsOwn', { count })}`;
}

/** Fresh Starts review authored target overrides; repeats review their accepted targets. */
export function projectWorkflowRunTargetReview(params: Readonly<{
    definition?: WorkflowDefinitionV1;
    materializedLeaves?: readonly WorkflowMaterializedLeafV1[];
}>): readonly WorkflowRunTargetReview[] {
    if (params.materializedLeaves !== undefined) return params.materializedLeaves;
    return walkWorkflowBlocks(params.definition?.blocks ?? []).flatMap(block => {
        switch (block.kind) {
            case 'step':
            case 'action':
            case 'workflow':
            case 'wait':
                return block.execution?.executionTarget
                    ? [{ sourceKey: '$root', blockId: block.id, executionTarget: block.execution.executionTarget }]
                    : [];
            default:
                return [];
        }
    });
}
