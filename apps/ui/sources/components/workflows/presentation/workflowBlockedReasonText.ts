import type {
    WorkflowInputDefinition,
    WorkflowValidationIssue,
} from '@happier-dev/protocol/workflows/workflowV1';

import type {
    WorkflowCommandBlockedReason,
    WorkflowRunInputFieldState,
} from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { formatWorkflowIssueText } from '../editor/workflowIssueText';
import { t } from '@/text';

const WORKFLOW_INPUT_VALUE_TYPE_LABEL_KEYS = {
    string: 'workflows.inputs.typeString',
    number: 'workflows.inputs.typeNumber',
    boolean: 'workflows.inputs.typeBoolean',
    json: 'workflows.inputs.typeJson',
} as const;

/** The declared value type of a workflow input, in the person's language. */
export function describeWorkflowInputValueType(
    valueType: WorkflowInputDefinition['valueType'],
): string {
    return t(WORKFLOW_INPUT_VALUE_TYPE_LABEL_KEYS[valueType]);
}

/**
 * How to repair one declared input value, in the person's language.
 *
 * The authoring editor's default-value field and the Run-now sheet's own field
 * report the same two repairable facts, so they name them with the same sentence
 * from one owner instead of each assembling the copy locally.
 */
export function describeWorkflowInputRepair(params: Readonly<{
    valueType: WorkflowInputDefinition['valueType'];
    errorCode: WorkflowRunInputFieldState['errorCode'];
}>): string | null {
    switch (params.errorCode) {
        case null:
            return null;
        case 'missing_required_input':
            return t('workflows.inputs.missingRequired');
        case 'invalid_input':
            return t('workflows.inputs.wrongType', {
                type: describeWorkflowInputValueType(params.valueType),
            });
    }
}

/**
 * Why a disabled workflow command cannot make progress, in the person's language.
 *
 * The eligibility owner returns a reason code; this is the one place that turns
 * it into copy. The editor page, the Automation wrapper's outer Save and the
 * create wrapper all name the same blocker with the same sentence, so a control
 * disabled by the same fact cannot explain itself two different ways — or, as
 * the outer Save did, not at all.
 */
export function describeWorkflowCommandBlockedReason(params: Readonly<{
    reason: WorkflowCommandBlockedReason | null;
    /** The first issue the canonical validator reported, when there is one. */
    blockingIssue?: Pick<WorkflowValidationIssue, 'code' | 'path'> & Partial<Pick<WorkflowValidationIssue, 'blockId'>> | null;
    /** The draft the issue belongs to, so the reason names its field in the editor's own words. */
    draft?: WorkflowEditorDraft;
}>): string | null {
    switch (params.reason) {
        case null:
        // A pending command is already acknowledged by its own label; it is not
        // a repairable reason and does not need a second sentence.
        case 'pending':
            return null;
        case 'target_required':
            return t('workflows.editor.targetRequired');
        case 'name_required':
            return t('workflows.save.nameRequired');
        case 'unsupported_persisted_attachment':
            return t('workflows.save.unsupportedAttachment');
        case 'definition_invalid':
            return params.blockingIssue == null
                ? null
                : formatWorkflowIssueText(params.blockingIssue, params.draft);
    }
}
