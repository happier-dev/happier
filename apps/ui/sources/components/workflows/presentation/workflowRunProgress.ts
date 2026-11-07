import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { t } from '@/text';

/** FIN's authored-step summary is distinct from public invocation counts. */
export function describeWorkflowRunProgress(progress: WorkflowRunSummaryV1['stepProgress']): string | null {
    return progress ? [
        progress.skipped !== undefined && progress.skipped > 0
            ? t('workflows.run.completedWithSkipped', { completed: progress.completed, skipped: progress.skipped })
            : t('workflows.list.stepsProgress', progress),
        progress.currentLoop ? t('workflows.list.loopProgress', progress.currentLoop) : null,
    ].filter(Boolean).join(' · ') : null;
}

/**
 * Accepted destination identity for a lean Run row, never a guessed loop total.
 * The row's Run status owns its lifecycle word; destination observations belong in Run detail.
 */
export function describeWorkflowRunDestinationProgress(progress: WorkflowRunSummaryV1['stepProgress'], sessionId: string): string[] {
    return progress?.destinations?.flatMap(leaf => {
        if (!leaf.sessionIds.includes(sessionId) || leaf.ordinal === undefined) return [];
        return [t('sessionWork.scheduled.step', { ordinal: leaf.ordinal,
            title: leaf.name?.trim() || t('message.provenanceWorkflow') })];
    }) ?? [];
}
