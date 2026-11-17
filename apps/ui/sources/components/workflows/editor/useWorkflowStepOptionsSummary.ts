import type { WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';

import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import { formatWorkflowConversationLabel, formatWorkflowWorkspaceLabel, useWorkflowContinuedSessionLabel } from './WorkflowContinuityControls';
import { formatWorkflowBlockOptionsSummary } from './WorkflowStepOptionsChip';

/** One option a step changes from the workflow, as its bordered chip reads it ("Conversation: Fresh"). */
export type WorkflowStepOptionChange = Readonly<{ id: string; title: string; value?: string }>;

/**
 * What a step changes from the workflow besides its Session fields (D-7, round 1116b step options A):
 * its conversation, workspace, background run, review and condition. Each is one bordered chip at the
 * card's foot; `label` is the same set in words, for the card at rest. An engine change is the engine
 * chip's to show, and a Session field's change is its own chip's.
 */
export function useWorkflowStepOptionsSummary(draft: WorkflowEditorDraft, step: WorkflowStep): Readonly<{
    label: string;
    changed: boolean;
    changes: readonly WorkflowStepOptionChange[];
}> {
    const continuedSessionLabel = useWorkflowContinuedSessionLabel(step.execution?.conversation);
    const execution = step.execution;
    const changes: WorkflowStepOptionChange[] = [
        ...(execution?.conversation === undefined ? [] : [{ id: 'conversation', title: t('workflows.conversation.title'),
            value: formatWorkflowConversationLabel({ draft, conversation: execution.conversation, sessionLabel: continuedSessionLabel }) }]),
        ...(execution?.workspace === undefined ? [] : [{ id: 'workspace', title: t('workflows.workspace.title'),
            value: formatWorkflowWorkspaceLabel(draft, execution.workspace) }]),
        ...(execution?.executionTarget?.kind === 'detached_run' ? [{ id: 'runs-in', title: t('workflows.page.inspector.runsIn'),
            value: t('workflows.page.sections.aBackgroundRun') }] : []),
        ...(step.pauseForReview === true ? [{ id: 'review', title: t('workflows.page.inspector.reviewTitle') }] : []),
        ...(step.onlyWhen === undefined ? [] : [{ id: 'only-when', title: t('workflows.condition.onlyWhen') }]),
    ];
    const summary = formatWorkflowBlockOptionsSummary(step, changes.filter((change) => change.id !== 'only-when')
        .map((change) => change.value ?? change.title));
    return { ...summary, changes };
}
