import {
    AutomationStoredDefinitionExecutionRecipeV1Schema,
    AutomationSourceSelectorIdV1Schema,
    type AutomationAssignmentInput,
    type AutomationDefinitionDetail,
    type AutomationEventTriggerDefinitionStoredPayloadV1,
    type AutomationStoredDefinitionExecutionRecipeV1,
    type AutomationSourceSelectorIdV1,
    type AutomationTriggerDefinitionInput,
    type AutomationTriggerId,
    type AutomationTriggerRevision,
} from '@happier-dev/protocol';
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
        && (trigger.persisted === null || trigger.isDirty === true);
}

export type AutomationEditorDraft = Readonly<{
    automationId: string | null;
    /** Client-stable identity used only by a not-yet-persisted definition. */
    pendingAutomationId: string | null;
    expectedTemplateVersion: number | null;
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
    /** True only after the canonical recipe composer reseals a next-version recipe. */
    recipeDirty?: boolean;
    executionRecipe: AutomationStoredDefinitionExecutionRecipeV1;
    assignments: ReadonlyArray<AutomationAssignmentInput>;
    triggers: ReadonlyArray<AutomationEditorTriggerDraft>;
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
    executionRecipe: AutomationStoredDefinitionExecutionRecipeV1,
): AutomationEditorDraft {
    const recipe = AutomationStoredDefinitionExecutionRecipeV1Schema.parse(executionRecipe);
    const expectedVersion = draft.expectedTemplateVersion === null
        ? draft.executionRecipe.templateVersion
        : draft.expectedTemplateVersion + 1;
    if (recipe.templateVersion !== expectedVersion) {
        throw new Error('Automation recipe must use the exact next template version');
    }
    return { ...draft, executionRecipe: recipe, recipeDirty: true };
}

/**
 * Projects direct detail after the caller has opened each private Event
 * envelope through the canonical stored-content owner. Detail intentionally
 * cannot expose those inputs by itself, so a missing exact definition fails
 * closed instead of fabricating an editable trigger.
 */
export function automationEditorDraftFromDetail(
    detail: AutomationDefinitionDetail,
    triggerDefinitions: ReadonlyMap<string, AutomationEditorTriggerDefinitionSeed>,
): AutomationEditorDraft | null {
    const executionRecipe = AutomationStoredDefinitionExecutionRecipeV1Schema.safeParse(detail.executionRecipe);
    if (!executionRecipe.success || executionRecipe.data.templateVersion !== detail.templateVersion) return null;
    const triggers: AutomationEditorTriggerDraft[] = [];
    for (const trigger of detail.triggers) {
        const seed = triggerDefinitions.get(trigger.id);
        if (!seed) return null;
        if (
            (seed.definition && seed.definition.kind !== trigger.kind)
            || (!seed.definition && (trigger.kind !== 'pluginEvent' || !seed.retainedEvent))
            || (trigger.kind === 'pluginEvent' && !seed.eventSourceBinding)
        ) return null;
        triggers.push({
            clientId: trigger.id,
            persisted: { id: trigger.id, revision: trigger.revision },
            definition: seed.definition,
            ...(seed.retainedEvent ? { retainedEvent: seed.retainedEvent } : {}),
            ...(seed.eventSourceBinding ? { eventSourceBinding: seed.eventSourceBinding } : {}),
            ...(seed.retainedEventPrivateDefinition ? {
                retainedEventPrivateDefinition: seed.retainedEventPrivateDefinition,
            } : {}),
        });
    }
    return {
        automationId: detail.id,
        pendingAutomationId: null,
        expectedTemplateVersion: detail.templateVersion,
        removedTriggers: [],
        name: detail.name,
        description: detail.description,
        enabled: detail.enabled,
        recipeDirty: false,
        executionRecipe: executionRecipe.data,
        assignments: detail.assignments.map((assignment) => ({
            machineId: assignment.machineId,
            enabled: assignment.enabled,
            priority: assignment.priority,
        })),
        triggers,
    };
}
