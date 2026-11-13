import {
    describeApprovalActionFields as describeProtocolApprovalActionFields,
    describeApprovalRequestFields as describeProtocolApprovalRequestFields,
} from '@happier-dev/protocol/actions';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

/** All UI readings use the program's quantity formatter; Protocol still owns the fields. */
export function describeApprovalActionFields(input: Parameters<typeof describeProtocolApprovalActionFields>[0]) {
    return describeProtocolApprovalActionFields({ ...input,
        context: { ...input.context, formatDataBytes: formatHappierDataBytes } });
}

/** Immediate and retained reviews disclose the same evaluated facts with the UI's quantity formatter. */
export function describeApprovalRequestFields(input: Parameters<typeof describeProtocolApprovalRequestFields>[0]) {
    return describeProtocolApprovalRequestFields(input, { formatDataBytes: formatHappierDataBytes });
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
