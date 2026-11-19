import {
    AutomationActionConsentTriggerSchema,
    AutomationActionTriggerStructuralV1Schema,
    type AutomationActionConsentTrigger,
} from '@happier-dev/protocol/automations/automationActionTriggerV1';
import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { AutomationValidationError } from './automationValidation';

/** Physical Action projection, shared by CRUD DTOs and occurrence admission. */
export interface AutomationActionTriggerColumns {
    actionId?: string | null;
    actionIdsJson?: string | null;
    phase?: string | null;
    mode?: string | null;
    onFailure?: string | null;
    subjectKind?: string | null;
    subjectKey?: string | null;
    reachesOthers?: boolean;
    consentForAutomationId?: string | null;
    consentForTriggerId?: string | null;
    consentedWorkflowRevision?: number | null;
}

export const AUTOMATION_ACTION_TRIGGER_FIELDS_CLEARED = {
    actionId: null, actionIdsJson: null, phase: null, mode: null, onFailure: null,
    subjectKind: null, subjectKey: null, reachesOthers: false,
    consentForAutomationId: null, consentForTriggerId: null, consentedWorkflowRevision: null,
} as const;

/** Structural source shared by publication and Run custody. */
export const automationConsentReferenceSelect = {
    consentForAutomationId: true, consentForTriggerId: true,
} as const;

/** One physical routing projection shared by admission, definition reads and index seed. */
export const automationActionTriggerConfigurationSelect = {
    actionIdsJson: true, phase: true, mode: true, onFailure: true,
    subjectKind: true, subjectKey: true, reachesOthers: true,
    ...automationConsentReferenceSelect, consentedWorkflowRevision: true,
} as const;

/** Publication and Run custody consume the trigger owner's structural reference. */
export function readAutomationDefinitionConsentFor(
    triggers: readonly (AutomationActionTriggerColumns | AutomationTriggerDefinitionInput)[],
): AutomationActionConsentTrigger['consentFor'] | null {
    for (const trigger of triggers) {
        if ('consentFor' in trigger) return trigger.consentFor;
        if ('consentForAutomationId' in trigger && trigger.consentForAutomationId && trigger.consentForTriggerId) {
            return { automationId: trigger.consentForAutomationId, triggerId: trigger.consentForTriggerId };
        }
    }
    return null;
}

/** Consent definitions take their execution Machine from invocation admission. */
export function isAutomationConsentDefinition(
    triggers: readonly Readonly<AutomationActionTriggerColumns & { kind: string }>[],
): boolean {
    return triggers.length > 0 && triggers.every(trigger => trigger.kind === 'action'
        && readAutomationDefinitionConsentFor([trigger]) !== null);
}

export function decodeAutomationActionTriggerConfiguration(row: AutomationActionTriggerColumns) {
    if (row.consentForAutomationId != null || row.consentForTriggerId != null) {
        return AutomationActionConsentTriggerSchema.parse({ kind: 'action',
            consentFor: { automationId: row.consentForAutomationId, triggerId: row.consentForTriggerId },
            consentedWorkflowRevision: row.consentedWorkflowRevision });
    }
    if (!row.actionIdsJson) throw new AutomationValidationError('source_unavailable');
    return AutomationActionTriggerStructuralV1Schema.parse({
        kind: 'action', actionIds: JSON.parse(row.actionIdsJson), phase: row.phase,
        ...(row.mode == null ? {} : { mode: row.mode }),
        ...(row.onFailure == null ? {} : { onFailure: row.onFailure }),
        ...(row.subjectKind == null ? {} : { subjectKind: row.subjectKind }),
        ...(row.subjectKey == null ? {} : { subjectKey: row.subjectKey }),
        ...(row.reachesOthers === undefined ? {} : { reachesOthers: row.reachesOthers }),
    });
}
