import { describeApprovalActionFields as describeProtocolApprovalActionFields } from '@happier-dev/protocol/actions';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

/** All UI readings use the program's quantity formatter; Protocol still owns the fields. */
export function describeApprovalActionFields(input: Parameters<typeof describeProtocolApprovalActionFields>[0]) {
    return describeProtocolApprovalActionFields({ ...input,
        context: { ...input.context, formatDataBytes: formatHappierDataBytes } });
}

export {
    describeActionResultFields,
    describeApprovalRequestFields,
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
