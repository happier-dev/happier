import {
    describeApprovalActionFields as describeProtocolApprovalActionFields,
    describeApprovalRequestFields as describeProtocolApprovalRequestFields,
    describeActionResultFields as describeProtocolStructuredFields,
    resolveApprovalRequestApproveAdmission as resolveProtocolApprovalRequestApproveAdmission,
    type ApprovalRequestApproveAdmission,
} from '@happier-dev/protocol/actions';
import { WORKFLOW_TRIGGER_ADD_ACTION_ID, WORKFLOW_TRIGGER_UPDATE_ACTION_ID } from '@happier-dev/protocol/actions/workflowTriggerActionIds';
import { WorkflowTriggerAddRequestV1Schema, WorkflowTriggerUpdateRequestV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { HealthCheckSourceConfigV1Schema } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import { formatTriggerSummary } from '@/components/workflows/triggers/formatTriggerSummary';
import { t } from '@/text';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

type TriggerApprovalInput = Readonly<{ actionId?: string | null; actionArgs?: unknown }>;

function readTriggerApproval(input: TriggerApprovalInput) {
    const add = input.actionId === WORKFLOW_TRIGGER_ADD_ACTION_ID ? WorkflowTriggerAddRequestV1Schema.safeParse(input.actionArgs) : null;
    const update = input.actionId === WORKFLOW_TRIGGER_UPDATE_ACTION_ID ? WorkflowTriggerUpdateRequestV1Schema.safeParse(input.actionArgs) : null;
    const added = add?.success ? add.data : null;
    const updated = update?.success ? update.data : null;
    const trigger = added?.trigger ?? updated?.patch.trigger;
    if (!added && !updated) return null;
    return { added, updated, trigger: trigger && (trigger.kind !== 'sessionLifecycle' || 'events' in trigger) ? trigger : null };
}

function formatTriggerApprovalSummary(change: NonNullable<ReturnType<typeof readTriggerApproval>>, environmentName?: string | null): string | null {
    if (!change.trigger) return null;
    const summary = formatTriggerSummary(change.trigger, { eventEnvironmentName: environmentName });
    return change.added?.trigger.enabled === false ? `${summary} · ${t('common.disabled')}` : summary;
}

export function readPluginEventTriggerApprovalSummary(input: TriggerApprovalInput, environmentName?: string | null): string | null {
    const change = readTriggerApproval(input);
    return change?.trigger?.kind === 'pluginEvent' ? formatTriggerApprovalSummary(change, environmentName) : null;
}

/** Where a retained Event request supplies only a resource identity. */
export function readPluginEventTriggerApprovalEnvironmentId(input: TriggerApprovalInput): string | null {
    const change = readTriggerApproval(input);
    if (change?.trigger?.kind !== 'pluginEvent') return null;
    const observation = change.added?.observationOnly?.deploymentEnvironment;
    if (observation) return observation.environmentId;
    if (change.trigger.subject?.kind === 'environment') return change.trigger.subject.environmentId;
    const event = change.trigger.eventRef;
    if (event.pluginId !== HEALTH_CHECK_EVENT_REFS_V1.status.pluginId || event.localId !== HEALTH_CHECK_EVENT_REFS_V1.status.localId) return null;
    const source = HealthCheckSourceConfigV1Schema.safeParse(change.trigger.sourceConfig);
    return source.success && source.data.subject.kind === 'environment' ? source.data.subject.environmentId : null;
}

export function readTriggerUpdateApprovalAutomationId(input: TriggerApprovalInput): string | null {
    return readTriggerApproval(input)?.updated?.automationId ?? null;
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

function presentTriggerDetails(
    input: Parameters<typeof describeProtocolApprovalRequestFields>[0],
    presentation: ReturnType<typeof describeProtocolApprovalRequestFields>,
    environmentName?: string | null,
): ReturnType<typeof describeProtocolApprovalRequestFields> {
    if (presentation.unrepresentable || !('actionArgs' in input)) return presentation;
    const change = readTriggerApproval(input);
    if (!change) return presentation;
    const { added, updated } = change;
    const value = formatTriggerApprovalSummary(change, environmentName);
    return { ...presentation, rows: [
        ...(value ? [{ kind: 'value' as const, path: 'trigger.summary', title: t('workflows.sentence.when'), value }] : []),
        ...presentation.rows.flatMap((row): typeof presentation.rows => {
            if (row.kind !== 'value') return [row];
            if (row.path === 'project' && added?.project) {
                return [{ ...row, technical: true }, { kind: 'value', path: 'project.directory',
                    title: t('workflows.sentence.rows.folder'), value: added.project.directory }];
            }
            if (row.path === 'observationOnly' && added?.observationOnly
                && Object.keys(added.observationOnly).length === 1) return [];
            if (row.path === 'patch' && updated && value) {
                const { trigger: _summarized, ...otherChanges } = updated.patch;
                if (Object.keys(otherChanges).length === 0) return [{ ...row, technical: true }];
                const remaining = describeProtocolStructuredFields({ result: { patch: otherChanges } })?.rows[0];
                return remaining?.kind === 'value' ? [{ ...remaining, title: row.title }] : [{ ...row, technical: true }];
            }
            return [row.path === 'trigger' || row.path === 'automationId' || row.path === 'triggerId' || row.path === 'observationOnly'
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
export function describeApprovalRequestFields(input: Parameters<typeof describeProtocolApprovalRequestFields>[0],
    environmentName?: string | null, automationName?: string | null) {
    const presentation = presentTriggerDetails(input, describeProtocolApprovalRequestFields(input, { formatDataBytes: formatHappierDataBytes }), environmentName);
    return presentTriggerUpdateAutomationName(presentation, automationName);
}

/** Keep Protocol's admission decision and adapt its disclosure through the same UI presenter. */
export function resolveApprovalRequestApproveAdmission(request: ApprovalRequest): ApprovalRequestApproveAdmission;
export function resolveApprovalRequestApproveAdmission(request: ApprovalRequest | TargetActionApprovalRequestV1):
    ReturnType<typeof resolveProtocolApprovalRequestApproveAdmission>;
export function resolveApprovalRequestApproveAdmission(request: ApprovalRequest | TargetActionApprovalRequestV1) {
    const admission = resolveProtocolApprovalRequestApproveAdmission(request);
    const presentation = presentTriggerDetails(request, admission.presentation);
    return presentation === admission.presentation ? admission : { ...admission, presentation };
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
