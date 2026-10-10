import { z } from 'zod';

import { AutomationStoredDefinitionExecutionRecipeV1Schema, type AutomationStoredDefinitionExecutionRecipeV1 } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema, type AutomationStoredWorkflowDefinitionRecipeV2 } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
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

export function getAutomationEditorTriggerKind(
    trigger: AutomationEditorTriggerDraft,
): AutomationTriggerDefinitionInput['kind'] {
    return trigger.definition?.kind ?? 'pluginEvent';
}

export function getAutomationEditorTriggerEnabled(trigger: AutomationEditorTriggerDraft): boolean {
    return trigger.definition?.enabled ?? trigger.retainedEvent?.enabled ?? false;
}

/**
 * Exact source truth is creation/edit authority, not a perpetual validity
 * requirement for an unchanged historical one-off row. The server uses the
 * same changed-row boundary during transactional reconciliation.
 */
export function shouldValidateAutomationEditorLifecycleTrigger(
    trigger: AutomationEditorTriggerDraft,
): boolean {
    return trigger.definition?.kind === 'sessionLifecycle'
        && trigger.definition.policy.kind === 'currentTurn'
        // A disabled historical one-off trigger no longer needs a live source
        // turn. New rows and enabled/re-enabled rows still require the exact
        // current-turn proof; the server remains authoritative for all other
        // source/target and revision invariants.
        && (trigger.persisted === null || (trigger.isDirty === true && getAutomationEditorTriggerEnabled(trigger)));
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

/** The one parser for either arm, so no caller re-derives which shape it holds. */
export const AutomationEditorExecutionRecipeSchema = z.union([
    AutomationStoredDefinitionExecutionRecipeV1Schema,
    AutomationStoredWorkflowDefinitionRecipeV2Schema,
]);

export function isAutomationWorkflowRecipe(
    recipe: AutomationEditorExecutionRecipe,
): recipe is AutomationStoredWorkflowDefinitionRecipeV2 {
    return recipe.v === 2;
}

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
    executionRecipe: AutomationEditorExecutionRecipe;
    assignments: ReadonlyArray<AutomationAssignmentInput>;
}>;

/** One durable-or-pending identity for editor-owned plugin setup and writes. */
export function requireAutomationEditorDraftIdentity(draft: AutomationEditorDraft): string {
    const identity = draft.automationId ?? draft.pendingAutomationId;
    if (!identity) throw new Error('Automation editor draft has no definition identity');
    return identity;
}

/** Account/server plus durable-or-pending definition identity for one mounted draft. */
export function createAutomationEditorLifetimeIdentity(
    scope: Readonly<{ serverId: string; accountId: string }>,
    definitionIdentity: string,
): string {
    return JSON.stringify([scope.serverId, scope.accountId, definitionIdentity]);
}

/** Exact save-time proof that a mounted draft still belongs to this Account and definition. */
export function isAutomationEditorLifetimeIdentityCurrent(
    mountedIdentity: string | null,
    scope: Readonly<{ serverId: string; accountId: string }> | null,
    definitionIdentity: string,
): boolean {
    return mountedIdentity !== null
        && scope !== null
        && mountedIdentity === createAutomationEditorLifetimeIdentity(scope, definitionIdentity);
}

export function createAutomationEditorAutomationId(): string {
    return `automation-${randomUUID()}`;
}

export function createAutomationEditorSourceSelectorId(stableRowId?: string): AutomationSourceSelectorIdV1 {
    const embeddedUuid = stableRowId?.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u)?.[0];
    return AutomationSourceSelectorIdV1Schema.parse(embeddedUuid ?? randomUUID());
}

/**
 * Creates one client-stable row identity. For new rows the canonical writer
 * sends this exact value as the trigger ID, making retries rejoin one row.
 */
export function createAutomationEditorTriggerClientId(): string {
    return randomUUID();
}

/** The sole editor transition for a semantic recipe mutation. */
export function replaceAutomationEditorExecutionRecipe(
    draft: AutomationEditorDraft,
    executionRecipe: AutomationEditorExecutionRecipe,
): AutomationEditorDraft {
    const recipe = AutomationEditorExecutionRecipeSchema.parse(executionRecipe);
    const expectedVersion = draft.expectedTemplateVersion === null
        ? draft.executionRecipe.templateVersion
        : draft.expectedTemplateVersion + 1;
    if (recipe.templateVersion !== expectedVersion) {
        throw new Error('Automation recipe must use the exact next template version');
    }
    return { ...draft, executionRecipe: recipe, recipeDirty: true };
}
