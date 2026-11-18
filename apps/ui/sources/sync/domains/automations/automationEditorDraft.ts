import type { AutomationStoredDefinitionExecutionRecipeV1 } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import type { AutomationStoredWorkflowDefinitionRecipeV2, AutomationObservationOnlyDefinitionV1 } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { AutomationSourceSelectorIdV1Schema, type AutomationSourceSelectorIdV1 } from '@happier-dev/protocol/automations/automationEventJsonBoundsV1';
import type { AutomationAssignmentInput } from '@happier-dev/protocol/automations/automationApiV3';
import type { AutomationEventTriggerDefinitionStoredPayloadV1 } from '@happier-dev/protocol/automations/event';
import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import type { AutomationTriggerId, AutomationTriggerRevision } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { randomUUID } from '@/platform/randomUUID';

export type AutomationEditorTriggerDraft = Readonly<{
    /** Stable editor identity; new rows reuse it as their durable trigger ID. */
    clientId: string;
    /** Exact trigger CAS identity, or null until the row is persisted. */
    persisted: Readonly<{
        id: AutomationTriggerId;
        revision: AutomationTriggerRevision;
    }> | null;
    /** True only after this persisted row's definition or enablement changes. */
    isDirty?: boolean;
    /**
     * Strict write input after a trigger has been newly configured or edited.
     * A retained durable-push Event may be null because its one-time endpoint
     * setup is intentionally not persisted as reusable authoring input.
     */
    definition: AutomationTriggerDefinitionInput | null;
    retainedEvent?: Readonly<{
        kind: 'pluginEvent';
        enabled: boolean;
        displayLabel: string;
        eventRef: Readonly<{ pluginId: string; localId: string }>;
    }>;
    /** Stable public selector for the current private Event source identity. */
    eventSourceBinding?: Readonly<{
        sourceSelectorId: AutomationSourceSelectorIdV1;
        sourceInstanceId: string;
    }>;
    /** Already-open Account-private payload, retained only for exact-revision reseal while mounted. */
    retainedEventPrivateDefinition?: AutomationEventTriggerDefinitionStoredPayloadV1;
}>;

export type AutomationEditorTriggerDefinitionSeed = Readonly<{
    definition: AutomationTriggerDefinitionInput | null;
    retainedEvent?: AutomationEditorTriggerDraft['retainedEvent'];
    eventSourceBinding?: AutomationEditorTriggerDraft['eventSourceBinding'];
    retainedEventPrivateDefinition?: AutomationEditorTriggerDraft['retainedEventPrivateDefinition'];
}>;

export function getAutomationEditorTriggerEnabled(trigger: AutomationEditorTriggerDraft): boolean {
    return trigger.definition?.enabled ?? trigger.retainedEvent?.enabled ?? false;
}

/**
 * Recipe-independent value owned by the shared metadata/trigger editor.
 * Embedded Session authoring uses this directly instead of fabricating a
 * recipe that its save owner would immediately discard.
 */
export type AutomationTriggerEditorValue = Readonly<{
    /**
     * Exact CAS witnesses for persisted rows intentionally removed in this
     * editor lifetime. Keeping them outside the visible collection prevents a
     * fresh pre-save read from authorizing deletion of somebody else's newer
     * or newly-added trigger.
     */
    removedTriggers: ReadonlyArray<Readonly<{
        id: AutomationTriggerId;
        revision: AutomationTriggerRevision;
    }>>;
    name: string;
    description: string | null;
    enabled: boolean;
    triggers: ReadonlyArray<AutomationEditorTriggerDraft>;
}>;

/**
 * What an Automation may execute: the incumbent one-shot recipe, or a frozen
 * workflow trigger context. Both arms are accepted by the canonical Automation API
 * union, so the editor carries the same union rather than a second draft store
 * for workflows.
 */
export type AutomationEditorExecutionRecipe =
    | AutomationStoredDefinitionExecutionRecipeV1
    | AutomationStoredWorkflowDefinitionRecipeV2;

export type AutomationEditorDraft = AutomationTriggerEditorValue & Readonly<{
    automationId: string | null;
    /** Client-stable identity used only by a not-yet-persisted definition. */
    pendingAutomationId: string | null;
    expectedTemplateVersion: number | null;
    /** The canonical live target, null for an inline workflow or legacy recipe. */
    workflowDefinitionId?: string | null;
    scopeSessionId?: string | null;
    /** True only after the canonical recipe composer reseals a next-version recipe. */
    recipeDirty?: boolean;
}> & (
    | Readonly<{ executionRecipe: AutomationEditorExecutionRecipe; observationOnly?: never;
        assignments: ReadonlyArray<AutomationAssignmentInput> }>
    | Readonly<{ observationOnly: AutomationObservationOnlyDefinitionV1; executionRecipe?: never;
        assignments: readonly [] }>
);

export function createAutomationEditorAutomationId(): string {
    return `automation-${randomUUID()}`;
}

export function createAutomationEditorSourceSelectorId(stableRowId?: string): AutomationSourceSelectorIdV1 {
    const embeddedUuid = stableRowId?.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u)?.[0];
    return AutomationSourceSelectorIdV1Schema.parse(embeddedUuid ?? randomUUID());
}
