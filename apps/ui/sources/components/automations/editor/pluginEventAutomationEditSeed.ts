import {
    AutomationEventTriggerDefinitionStoredPayloadV1Schema,
    AutomationRunExecutionRecipeV1Schema,
    AutomationRunExecutionTargetV1Schema,
    AutomationRunTemplateV1Schema,
    AutomationSourceSelectorIdV1Schema,
    AutomationV3DefinitionDetailSchema,
    PluginEventAutomationSetupResultV1Schema,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
} from '@happier-dev/protocol';
import type {
    AutomationEventFilterV1,
    AutomationEventTriggerDefinitionStoredPayloadV1,
    AutomationRunExecutionRecipeV1,
    AutomationRunExecutionTargetV1,
    MentionRefV1,
    PluginEventAutomationSetupResultV1,
} from '@happier-dev/protocol';

import type {
    AutomationDefinition,
    AutomationDefinitionDetailForTrigger,
} from '@/sync/domains/automations/automationTypes';

/**
 * Direct-detail-only Event edit input. It is handed once to the incumbent
 * new-session composer and is never projected into an Event-specific store.
 */
export type PluginEventAutomationEditSeed = Readonly<{
    automationId: string;
    expectedTemplateVersion: number;
    name: string;
    description: string | null;
    enabled: boolean;
    eventRef: Readonly<{ pluginId: string; localId: string }>;
    source: PluginEventAutomationSetupResultV1;
    watcherMaterializationRef: Readonly<{
        machineId: string;
        pluginId: string;
        materializationId: string;
    }>;
    filter: AutomationEventFilterV1 | null;
    maximumObservationAgeMs: number | null;
    prompt: string;
    /**
     * The composer references persisted beside `prompt`, in the same
     * identity-only shape the writer stored. The editor re-hydrates them so a
     * save that never touched the composer rewrites the template it read; an
     * older definition authored before the field simply seeds an empty list.
     */
    mentions: readonly MentionRefV1[];
    /**
     * The exact persisted target arm. Target kind is immutable while editing,
     * but its own fields remain ordinary Event-editor inputs.
     */
    target: AutomationRunExecutionTargetV1;
}>;

function sameContributionIdentity(
    left: Readonly<{ pluginId: string; localId: string }>,
    right: Readonly<{ pluginId: string; localId: string }>,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function isPluginEventDefinitionDetail(
    detail: unknown,
): detail is AutomationDefinitionDetailForTrigger<'pluginEvent'> {
    const parsed = AutomationV3DefinitionDetailSchema.safeParse(detail);
    return parsed.success && parsed.data.trigger.kind === 'pluginEvent';
}

function parseStoredEnvelope(value: string): unknown | null {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

/**
 * Opens the Event-only private detail attached by the canonical Automation
 * definition projection. Consumers receive no values from the safe list
 * summary, and any unavailable or stale direct detail fails closed.
 */
export type PluginEventAutomationPrivateDetail = Readonly<{
    detail: AutomationDefinitionDetailForTrigger<'pluginEvent'>;
    storedDefinition: AutomationEventTriggerDefinitionStoredPayloadV1;
    recipe: AutomationRunExecutionRecipeV1;
}>;

export function readPluginEventAutomationPrivateDetail(
    definition: AutomationDefinition | null,
): PluginEventAutomationPrivateDetail | null {
    if (
        !definition
        || definition.trigger.kind !== 'pluginEvent'
        || definition.detail.kind !== 'available'
        || definition.detail.templateVersion !== definition.templateVersion
    ) {
        return null;
    }

    const detail = definition.detail.value;
    if (!isPluginEventDefinitionDetail(detail)) return null;
    if (
        detail.id !== definition.id
        || detail.templateVersion !== definition.templateVersion
        || detail.targetType !== definition.targetType
        || !sameContributionIdentity(detail.trigger.eventRef, definition.trigger.eventRef)
        || detail.trigger.sourceSelectorId !== definition.trigger.sourceSelectorId
        || detail.trigger.sourceContractVersion !== definition.trigger.sourceContractVersion
        || typeof detail.triggerDefinitionEnvelope !== 'string'
    ) {
        return null;
    }

    const sourceSelectorId = AutomationSourceSelectorIdV1Schema.safeParse(detail.trigger.sourceSelectorId);
    if (!sourceSelectorId.success) return null;

    const storedEnvelope = parseStoredEnvelope(detail.triggerDefinitionEnvelope);
    if (storedEnvelope === null) return null;
    const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({
        mode: 'plain',
        binding: {
            v: 1,
            automationId: detail.id,
            templateVersion: detail.templateVersion,
            triggerKind: 'pluginEvent',
            eventRef: detail.trigger.eventRef,
            sourceSelectorId: sourceSelectorId.data,
        },
        envelope: storedEnvelope,
    });
    if (opened.kind !== 'available') return null;

    const storedDefinition = AutomationEventTriggerDefinitionStoredPayloadV1Schema.safeParse(opened.definition);
    if (!storedDefinition.success) return null;

    const recipe = AutomationRunExecutionRecipeV1Schema.safeParse(detail.executionRecipe);
    if (
        !recipe.success
        || recipe.data.templateVersion !== detail.templateVersion
    ) {
        return null;
    }

    return Object.freeze({
        detail,
        storedDefinition: storedDefinition.data,
        recipe: recipe.data,
    });
}

/**
 * Opens only the direct detail associated with the currently displayed
 * definition. The writer repeats its direct-detail/current-version check
 * immediately before mutation; this reader only prepares one editor handoff.
 */
export function readPluginEventAutomationEditSeed(
    definition: AutomationDefinition | null,
): PluginEventAutomationEditSeed | null {
    const privateDetail = readPluginEventAutomationPrivateDetail(definition);
    if (!privateDetail) {
        return null;
    }

    const { detail, storedDefinition: privateDefinition, recipe } = privateDetail;
    if (
        detail.trigger.observation.kind !== 'checkpointedPull'
        || detail.trigger.observation.watcher === null
    ) {
        return null;
    }
    if (
        // This editor is the explicitly pull-only r0.28 vertical. Dropping a
        // push routing source would silently change a durable definition.
        privateDefinition.webhookRoutingSourceInstanceId !== undefined
    ) {
        return null;
    }
    const source = PluginEventAutomationSetupResultV1Schema.safeParse({
        v: 1,
        sourceInstanceId: privateDefinition.sourceInstanceId,
        sourceContractVersion: detail.trigger.sourceContractVersion,
        sourceConfig: privateDefinition.sourceConfig,
        displayLabel: privateDefinition.displayLabel,
    });
    if (!source.success) return null;

    if (
        recipe.template.t !== 'plain'
        || recipe.triggerEvidence !== null
        || recipe.target.kind !== detail.targetType
    ) {
        return null;
    }
    const template = AutomationRunTemplateV1Schema.safeParse(recipe.template.v);
    const target = AutomationRunExecutionTargetV1Schema.safeParse(recipe.target);
    if (!template.success || !target.success) return null;

    const watcher = detail.trigger.observation.watcher;
    if (watcher.pluginId !== detail.trigger.eventRef.pluginId) return null;

    return Object.freeze({
        automationId: detail.id,
        expectedTemplateVersion: detail.templateVersion,
        name: detail.name,
        description: detail.description,
        enabled: detail.enabled,
        eventRef: Object.freeze({ ...detail.trigger.eventRef }),
        source: source.data,
        watcherMaterializationRef: Object.freeze({
            machineId: watcher.machineId,
            pluginId: watcher.pluginId,
            materializationId: watcher.materializationId,
        }),
        filter: privateDefinition.filter,
        maximumObservationAgeMs: privateDefinition.maximumObservationAgeMs,
        prompt: template.data.prompt,
        mentions: Object.freeze([...template.data.mentions ?? []]),
        target: target.data,
    });
}
