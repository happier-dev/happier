import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol';
import { t } from '@/text';

/** FIN's authored-step summary is distinct from public invocation counts. */
export function describeWorkflowRunProgress(progress: WorkflowRunSummaryV1['stepProgress']): string | null {
    return progress ? [
        t('workflows.list.stepsProgress', progress),
        progress.currentLoop ? t('workflows.list.loopProgress', progress.currentLoop) : null,
    ].filter(Boolean).join(' · ') : null;
}
