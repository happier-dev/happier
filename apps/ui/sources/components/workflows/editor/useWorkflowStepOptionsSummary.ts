import type { WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';

import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import { formatWorkflowConversationLabel, formatWorkflowWorkspaceLabel, useWorkflowContinuedSessionLabel } from './WorkflowContinuityControls';
import { formatWorkflowBlockOptionsSummary } from './WorkflowStepOptionsChip';

/**
 * What a step's Step options read, for its chip and its row at rest: "Workflow defaults" or what
 * differs ("Fresh", "A background run", "Reviews before continuing"), D-7. An engine change is the
 * engine chip's to show, so it adds no words here.
 */
export function useWorkflowStepOptionsSummary(draft: WorkflowEditorDraft, step: WorkflowStep): Readonly<{ label: string; changed: boolean }> {
    const continuedSessionLabel = useWorkflowContinuedSessionLabel(step.execution?.conversation);
    return formatWorkflowBlockOptionsSummary(step, [
        ...(step.execution?.conversation === undefined
            ? []
            : [formatWorkflowConversationLabel({ draft, conversation: step.execution.conversation, sessionLabel: continuedSessionLabel })]),
        ...(step.execution?.workspace === undefined ? [] : [formatWorkflowWorkspaceLabel(draft, step.execution.workspace)]),
        ...(step.execution?.executionTarget?.kind === 'detached_run' ? [t('workflows.page.sections.aBackgroundRun')] : []),
        ...(step.pauseForReview === true ? [t('workflows.page.inspector.reviewsBeforeContinuing')] : []),
    ]);
}
