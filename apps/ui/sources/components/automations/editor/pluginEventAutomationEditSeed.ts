import {
    AutomationEventTriggerDefinitionStoredPayloadV1Schema,
    AutomationRunExecutionRecipeV1Schema,
    AutomationRunExecutionTargetV1Schema,
    AutomationRunTemplateV1Schema,
    AutomationSourceSelectorIdV1Schema,
    AutomationDefinitionDetailSchema,
    PluginEventAutomationSetupResultV1Schema,
    PluginWebhookEndpointIdV1Schema,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
} from '@happier-dev/protocol';
import type {
    AutomationEventFilterV1,
    AutomationEventTriggerDefinitionStoredPayloadV1,
    AutomationRunExecutionRecipeV1,
    AutomationRunExecutionTargetV1,
    MentionRefV1,
    PluginEventAutomationSetupResultV1,
    PluginWebhookEndpointIdV1,
} from '@happier-dev/protocol';

import type {
    AutomationDefinition,
    AutomationDefinitionDetailForTrigger,
} from '@/sync/domains/automations/automationTypes';
import { arePluginContributionIdentitiesEqual } from '@/sync/domains/automations/pluginEventAutomationCurrentness';

/**
 * The persisted observation transport, in the same discriminated shape the
 * composer draft and the current writer input use. Both arms are editable: the
 * pull arm re-selects its watcher materialization, and the push arm keeps the
 * already-ensured endpoint identity so an ordinary prompt, filter, or target
 * correction never re-runs one-time credential setup.
 */
export type PluginEventAutomationEditSeedObservation =
    | Readonly<{
        kind: 'checkpointedPull';
        watcherMaterializationRef: Readonly<{
            machineId: string;
            pluginId: string;
            materializationId: string;
        }>;
    }>
    | Readonly<{
        kind: 'durablePush';
        webhookEndpointId: PluginWebhookEndpointIdV1;
        /**
         * The generic endpoint-routing source instance retained privately
         * beside the provider's own source identity. The current writer requires
         * it, so a push definition missing it cannot be re-written.
         */
        webhookRoutingSourceInstanceId: string;
    }>;

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
    observation: PluginEventAutomationEditSeedObservation;
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
     * The exact persisted target arm, seeded as the editor's starting
     * selection. A strict patch replaces the whole recipe for future Runs,
     * so the arm and its own fields are both ordinary Event-editor inputs;
     * already-admitted Runs keep the recipe they were frozen with.
     */
    target: AutomationRunExecutionTargetV1;
}>;

function isPluginEventDefinitionDetail(
    detail: unknown,
): detail is AutomationDefinitionDetailForTrigger<'pluginEvent'> {
    const parsed = AutomationDefinitionDetailSchema.safeParse(detail);
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
        || !arePluginContributionIdentitiesEqual(detail.trigger.eventRef, definition.trigger.eventRef)
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
 * Projects the persisted transport into the editable observation union. Each
 * arm must be internally consistent with the private definition it was sealed
 * with: a pull definition never carries endpoint routing state, and a push
 * definition is unusable without the canonical endpoint identity plus the
 * routing source instance the current writer replays.
 */
function readEditSeedObservation(
    detail: AutomationDefinitionDetailForTrigger<'pluginEvent'>,
    privateDefinition: AutomationEventTriggerDefinitionStoredPayloadV1,
): PluginEventAutomationEditSeedObservation | null {
    const observation = detail.trigger.observation;
    if (observation.kind === 'checkpointedPull') {
        const watcher = observation.watcher;
        if (
            watcher === null
            || watcher.pluginId !== detail.trigger.eventRef.pluginId
            || privateDefinition.webhookRoutingSourceInstanceId !== undefined
        ) {
            return null;
        }
        return Object.freeze({
            kind: 'checkpointedPull' as const,
            watcherMaterializationRef: Object.freeze({
                machineId: watcher.machineId,
                pluginId: watcher.pluginId,
                materializationId: watcher.materializationId,
            }),
        });
    }
    const webhookEndpointId = PluginWebhookEndpointIdV1Schema.safeParse(observation.webhookEndpointId);
    const webhookRoutingSourceInstanceId = privateDefinition.webhookRoutingSourceInstanceId;
    if (!webhookEndpointId.success || webhookRoutingSourceInstanceId === undefined) return null;
    return Object.freeze({
        kind: 'durablePush' as const,
        webhookEndpointId: webhookEndpointId.data,
        webhookRoutingSourceInstanceId,
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
    const observation = readEditSeedObservation(detail, privateDefinition);
    if (!observation) return null;
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

    return Object.freeze({
        automationId: detail.id,
        expectedTemplateVersion: detail.templateVersion,
        name: detail.name,
        description: detail.description,
        enabled: detail.enabled,
        eventRef: Object.freeze({ ...detail.trigger.eventRef }),
        source: source.data,
        observation,
        filter: privateDefinition.filter,
        maximumObservationAgeMs: privateDefinition.maximumObservationAgeMs,
        prompt: template.data.prompt,
        mentions: Object.freeze([...template.data.mentions ?? []]),
        target: target.data,
    });
}
