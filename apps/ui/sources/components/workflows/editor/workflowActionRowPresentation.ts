import { listWorkflowActionFieldReferencesV1 } from '@happier-dev/protocol/workflows/workflowActionTextV1';
import type { WorkflowBlock } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { workflowIssuesForBlock, type WorkflowDraftValidation } from '@/sync/domains/workflows/workflowAuthoring';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { formatWorkflowValueReference } from '../presentation/workflowValuePresentation';
import { formatWorkflowConditionSentence } from '../presentation/workflowConditionPresentation';
import { collectWorkflowFieldIssueTexts } from './workflowIssueText';

export type WorkflowActionRowPresentation = Readonly<{
    referenceLabels: Readonly<Record<string, readonly string[]>>;
    fieldIssues: Readonly<Record<string, string>>;
    condition: string | null;
}>;

/** Publish only the reference words and revealed issues this Action actually reads. */
export function projectWorkflowActionRowPresentation(
    draft: WorkflowEditorDraft,
    block: Extract<WorkflowBlock, { kind: 'action' }>,
    validation: WorkflowDraftValidation,
    revealIssues: boolean,
    previous?: WorkflowActionRowPresentation,
): WorkflowActionRowPresentation {
    const referenceLabels = Object.fromEntries(Object.entries(block.input).map(([field, binding]) => [field,
        listWorkflowActionFieldReferencesV1(binding).map(reference =>
            reference.kind === 'origin_session_id' ? '' : formatWorkflowValueReference(draft, reference, field)),
    ]));
    const fieldIssues = collectWorkflowFieldIssueTexts(revealIssues ? workflowIssuesForBlock(validation, block.id, draft) : [], draft);
    const condition = block.onlyWhen === undefined ? null : formatWorkflowConditionSentence(draft, block.onlyWhen);
    return retainDeep(previous, { referenceLabels, fieldIssues, condition });
}
