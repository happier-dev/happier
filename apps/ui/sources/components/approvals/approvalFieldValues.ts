import {
    describeApprovalActionFields as describeProtocolApprovalActionFields,
    describeApprovalRequestFields as describeProtocolApprovalRequestFields,
    formatWorkflowTriggerApprovalSummary,
    readWorkflowTriggerApproval,
    type WorkflowTriggerApprovalInput,
    type WorkflowTriggerApprovalLabels,
    resolveApprovalRequestApproveAdmission as resolveProtocolApprovalRequestApproveAdmission,
    type ApprovalRequestApproveAdmission,
} from '@happier-dev/protocol/actions';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { HealthCheckSourceConfigV1Schema } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import { formatTriggerSummary } from '@/components/workflows/triggers/formatTriggerSummary';
import { getTranslationValue, t } from '@/text';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { readVoiceSettingsDeclaration } from '@/voice/settings/voiceContributedSettingsDeclarations';

function workflowTriggerLabels(environmentName?: string | null): WorkflowTriggerApprovalLabels {
    return {
        when: t('workflows.sentence.when'),
        folder: t('workflows.sentence.rows.folder'),
        disabled: t('common.disabled'),
        summarize: trigger => formatTriggerSummary(trigger, { eventEnvironmentName: environmentName }),
    };
}

export function resolvePluginConfirmationText(text: NonNullable<TargetActionApprovalRequestV1['inputFields']>[number]['title']): string {
    const translated = typeof text === 'string' ? undefined : getTranslationValue(text.key);
    return resolvePluginLocalizedStringV2Text(text, typeof translated === 'string' ? translated : undefined);
}

export function readPluginEventTriggerApprovalSummary(input: WorkflowTriggerApprovalInput, environmentName?: string | null): string | null {
    const change = readWorkflowTriggerApproval(input);
    return change?.trigger?.kind === 'pluginEvent' ? formatWorkflowTriggerApprovalSummary(change, workflowTriggerLabels(environmentName)) : null;
}

/** Where a retained Event request supplies only a resource identity. */
export function readPluginEventTriggerApprovalEnvironmentId(input: WorkflowTriggerApprovalInput): string | null {
    const change = readWorkflowTriggerApproval(input);
    if (change?.trigger?.kind !== 'pluginEvent') return null;
    const observation = change.added?.observationOnly?.deploymentEnvironment;
    if (observation) return observation.environmentId;
    if (change.trigger.subject?.kind === 'environment') return change.trigger.subject.environmentId;
    const event = change.trigger.eventRef;
    if (event.pluginId !== HEALTH_CHECK_EVENT_REFS_V1.status.pluginId || event.localId !== HEALTH_CHECK_EVENT_REFS_V1.status.localId) return null;
    const source = HealthCheckSourceConfigV1Schema.safeParse(change.trigger.sourceConfig);
    return source.success && source.data.subject.kind === 'environment' ? source.data.subject.environmentId : null;
}

export function readTriggerUpdateApprovalAutomationId(input: WorkflowTriggerApprovalInput): string | null {
    return readWorkflowTriggerApproval(input)?.updated?.automationId ?? null;
}

export function presentTriggerUpdateAutomationName(
    presentation: ReturnType<typeof describeProtocolApprovalRequestFields>, name?: string | null,
): ReturnType<typeof describeProtocolApprovalRequestFields> {
    if (!name || !presentation.rows.some(row => row.path === 'automationId')) return presentation;
    return { ...presentation, rows: [
        { kind: 'value', path: 'automation.name', title: t('navigation.automations'), value: name },
        ...presentation.rows,
    ] };
}

/** All UI readings use the program's quantity formatter; Protocol still owns the fields. */
export function describeApprovalActionFields(input: Parameters<typeof describeProtocolApprovalActionFields>[0]) {
    return describeProtocolApprovalActionFields({ ...input, context: { ...input.context,
        readSettingDeclaration: readVoiceSettingsDeclaration,
        formatDataBytes: formatHappierDataBytes, workflowTriggerLabels: workflowTriggerLabels() } });
}

/** Immediate and retained reviews disclose the same evaluated facts with the UI's quantity formatter. */
export function describeApprovalRequestFields(input: Parameters<typeof describeProtocolApprovalRequestFields>[0],
    environmentName?: string | null, automationName?: string | null) {
    const presentation = describeProtocolApprovalRequestFields(input, {
        resolvePluginConfirmationText,
        readSettingDeclaration: readVoiceSettingsDeclaration,
        formatDataBytes: formatHappierDataBytes, workflowTriggerLabels: workflowTriggerLabels(environmentName),
    });
    return presentTriggerUpdateAutomationName(presentation, automationName);
}

/** Keep Protocol's admission decision and adapt its disclosure through the same UI presenter. */
export function resolveApprovalRequestApproveAdmission(request: ApprovalRequest): ApprovalRequestApproveAdmission;
export function resolveApprovalRequestApproveAdmission(request: ApprovalRequest | TargetActionApprovalRequestV1):
    ReturnType<typeof resolveProtocolApprovalRequestApproveAdmission>;
export function resolveApprovalRequestApproveAdmission(request: ApprovalRequest | TargetActionApprovalRequestV1) {
    return resolveProtocolApprovalRequestApproveAdmission(request, {
        resolvePluginConfirmationText,
        readSettingDeclaration: readVoiceSettingsDeclaration, workflowTriggerLabels: workflowTriggerLabels() });
}

export {
    describeActionResultFields,
    formatApprovalFieldValues,
    getApprovalFieldValues,
    projectApprovalStructuredAnswers,
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
