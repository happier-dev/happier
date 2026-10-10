import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol';
import { t } from '@/text';
import { describeWorkflowInvocationLifecycle } from './workflowLifecyclePresentation';

/** FIN's authored-step summary is distinct from public invocation counts. */
export function describeWorkflowRunProgress(progress: WorkflowRunSummaryV1['stepProgress']): string | null {
    return progress ? [
        t('workflows.list.stepsProgress', progress),
        progress.currentLoop ? t('workflows.list.loopProgress', progress.currentLoop) : null,
    ].filter(Boolean).join(' · ') : null;
}

/** Accepted destination identity with an exact observed state, never a guessed loop total. */
export function describeWorkflowRunDestinationProgress(progress: WorkflowRunSummaryV1['stepProgress'], sessionId: string): string[] {
    return progress?.destinations?.flatMap(leaf => {
        if (!leaf.sessionIds.includes(sessionId) || leaf.ordinal === undefined) return [];
        const label = t('sessionWork.scheduled.step', { ordinal: leaf.ordinal,
            title: leaf.name?.trim() || t('message.provenanceWorkflow') });
        return [[label, leaf.observation ? t('workflows.list.observedProgress', {
            status: describeWorkflowInvocationLifecycle(leaf.observation.lifecycle, { blockKind: leaf.observation.blockKind }).label,
        }) : null].filter(Boolean).join(' · ')];
    }) ?? [];
}
