import {
    describeApprovalActionFields as describeProtocolApprovalActionFields,
    describeApprovalRequestFields as describeProtocolApprovalRequestFields,
    describeActionResultFields as describeProtocolStructuredFields,
} from '@happier-dev/protocol/actions';
import { WORKFLOW_TRIGGER_ADD_ACTION_ID, WORKFLOW_TRIGGER_UPDATE_ACTION_ID } from '@happier-dev/protocol/actions/workflowTriggerActionIds';
import { WorkflowTriggerAddRequestV1Schema, WorkflowTriggerUpdateRequestV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { formatTriggerSummary } from '@/components/workflows/triggers/formatTriggerSummary';
import { t } from '@/text';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

function presentTriggerDetails(
    input: Parameters<typeof describeProtocolApprovalRequestFields>[0],
    presentation: ReturnType<typeof describeProtocolApprovalRequestFields>,
): ReturnType<typeof describeProtocolApprovalRequestFields> {
    if (!('actionArgs' in input)) return presentation;
    const added = input.actionId === WORKFLOW_TRIGGER_ADD_ACTION_ID ? WorkflowTriggerAddRequestV1Schema.safeParse(input.actionArgs) : null;
    const updated = input.actionId === WORKFLOW_TRIGGER_UPDATE_ACTION_ID ? WorkflowTriggerUpdateRequestV1Schema.safeParse(input.actionArgs) : null;
    const trigger = added?.success ? added.data.trigger : updated?.success ? updated.data.patch.trigger : undefined;
    if (!trigger || (trigger.kind === 'sessionLifecycle' && !('events' in trigger))) return presentation;
    const summary = formatTriggerSummary(trigger);
    const value = added?.success && !added.data.trigger.enabled ? `${summary} · ${t('common.disabled')}` : summary;
    return { ...presentation, rows: [
        { kind: 'value', path: 'trigger.summary', title: t('workflows.sentence.when'), value },
        ...presentation.rows.flatMap((row): typeof presentation.rows => {
            if (row.kind !== 'value') return [row];
            if (row.path === 'project' && added?.success && added.data.project) {
                return [{ ...row, technical: true }, { kind: 'value', path: 'project.directory',
                    title: t('workflows.sentence.rows.folder'), value: added.data.project.directory }];
            }
            if (row.path === 'patch' && updated?.success) {
                const { trigger: _summarized, ...otherChanges } = updated.data.patch;
                if (Object.keys(otherChanges).length === 0) return [{ ...row, technical: true }];
                const remaining = describeProtocolStructuredFields({ result: { patch: otherChanges } })?.rows[0];
                return remaining?.kind === 'value' ? [{ ...remaining, title: row.title }] : [{ ...row, technical: true }];
            }
            return [row.path === 'trigger' || row.path === 'automationId' || row.path === 'triggerId'
                ? { ...row, technical: true } : row];
        }),
    ] };
}

/** All UI readings use the program's quantity formatter; Protocol still owns the fields. */
export function describeApprovalActionFields(input: Parameters<typeof describeProtocolApprovalActionFields>[0]) {
    return presentTriggerDetails(input, describeProtocolApprovalActionFields({ ...input,
        context: { ...input.context, formatDataBytes: formatHappierDataBytes } }));
}

/** Immediate and retained reviews disclose the same evaluated facts with the UI's quantity formatter. */
export function describeApprovalRequestFields(input: Parameters<typeof describeProtocolApprovalRequestFields>[0]) {
    return presentTriggerDetails(input, describeProtocolApprovalRequestFields(input, { formatDataBytes: formatHappierDataBytes }));
}

export {
    describeActionResultFields,
    formatApprovalFieldValues,
    getApprovalFieldValues,
    projectApprovalStructuredAnswers,
    resolveApprovalRequestApproveAdmission,
    resolveApprovalVisualPreview,
    shouldHideApprovalField,
    type ApprovalVisualPreview,
    type ApprovalActionFieldRow,
    type ApprovalActionFieldsPresentation,
    type ApprovalRequestApproveAdmission,
    type ApprovalStructuredAnswer,
    type ApprovalStructuredAnswersProjection,
    type ApprovalUnrepresentableReason,
} from '@happier-dev/protocol/actions';
export {
    readAcknowledgedActionResult,
    type AcknowledgedActionResult,
    type AcknowledgedActionInverse,
} from './actionResultFacts';
