import {
    AutomationEventTriggerDefinitionStoredPayloadV1Schema,
    AutomationSourceSelectorIdV1Schema,
    AutomationTriggerIdSchema,
    AutomationTriggerRevisionSchema,
    PluginEventAutomationSetupResultV1Schema,
    PluginWebhookEndpointIdV1Schema,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
    type AccountScopedCryptoMaterial,
    type AutomationDefinitionDetail,
    type AutomationEventFilterV1,
    type AutomationEventTriggerDefinitionStoredPayloadV1,
    type AutomationPluginEventDefinitionTrigger,
    type AutomationTriggerId,
    type AutomationTriggerRevision,
    type PluginEventAutomationSetupResultV1,
    type PluginWebhookEndpointIdV1,
} from '@happier-dev/protocol';

import type { AutomationDefinition } from '@/sync/domains/automations/automationTypes';

type PluginEventTriggerDetail = Extract<
    AutomationDefinitionDetail['triggers'][number],
    Readonly<{ kind: 'pluginEvent' }>
>;

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
        webhookRoutingSourceInstanceId: string;
        /** Present for an in-memory strict draft; persisted rows rejoin it through the endpoint owner. */
        endpointMaterializationRef?: Readonly<{
            machineId: string;
            pluginId: string;
            materializationId: string;
        }>;
    }>;

export type PluginEventAutomationEditSeed = Readonly<{
    automationId: string;
    triggerId: AutomationTriggerId;
    expectedTriggerRevision: AutomationTriggerRevision;
    enabled: boolean;
    eventRef: Readonly<{ pluginId: string; localId: string }>;
    source: PluginEventAutomationSetupResultV1;
    observation: PluginEventAutomationEditSeedObservation;
    filter: AutomationEventFilterV1 | null;
    maximumObservationAgeMs: number | null;
}>;

export type PluginEventAutomationStoredContentAccess =
    | Readonly<{ mode: 'plain' }>
    | Readonly<{ mode: 'e2ee'; material?: AccountScopedCryptoMaterial }>;

export type PluginEventAutomationPrivateDetail = Readonly<{
    trigger: PluginEventTriggerDetail;
    storedDefinition: AutomationEventTriggerDefinitionStoredPayloadV1;
}>;

function parseStoredEnvelope(value: string): unknown | null {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

/** Opens one exact trigger-scoped private definition; no representative row exists. */
export function readPluginEventAutomationPrivateDetail(
    definition: AutomationDefinition | null,
    triggerId: string,
    access: PluginEventAutomationStoredContentAccess,
): PluginEventAutomationPrivateDetail | null {
    const id = AutomationTriggerIdSchema.safeParse(triggerId);
    if (
        !id.success
        || !definition
        || definition.detail.kind !== 'available'
        || definition.detail.templateVersion !== definition.templateVersion
    ) return null;

    const detail = definition.detail.value;
    if (detail.id !== definition.id || detail.templateVersion !== definition.templateVersion) return null;
    const trigger = detail.triggers.find((candidate) => candidate.id === id.data);
    const summary = definition.triggers.find((candidate) => candidate.id === id.data);
    if (
        !trigger
        || !summary
        || trigger.kind !== 'pluginEvent'
        || summary.kind !== 'pluginEvent'
        || trigger.revision !== summary.revision
        || trigger.eventRef.pluginId !== summary.eventRef.pluginId
        || trigger.eventRef.localId !== summary.eventRef.localId
        || trigger.sourceSelectorId !== summary.sourceSelectorId
        || trigger.sourceContractVersion !== summary.sourceContractVersion
    ) return null;

    const revision = AutomationTriggerRevisionSchema.safeParse(trigger.revision);
    const sourceSelectorId = AutomationSourceSelectorIdV1Schema.safeParse(trigger.sourceSelectorId);
    const envelope = parseStoredEnvelope(trigger.triggerDefinitionEnvelope);
    if (!revision.success || !sourceSelectorId.success || envelope === null) return null;
    const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({
        mode: access.mode,
        ...(access.mode === 'e2ee' && access.material ? { material: access.material } : {}),
        binding: {
            v: 1,
            automationId: detail.id,
            triggerId: id.data,
            triggerRevision: revision.data,
            triggerKind: 'pluginEvent',
            eventRef: trigger.eventRef,
            sourceSelectorId: sourceSelectorId.data,
        },
        envelope,
    });
    if (opened.kind !== 'available') return null;
    const storedDefinition = AutomationEventTriggerDefinitionStoredPayloadV1Schema.safeParse(opened.definition);
    if (!storedDefinition.success) return null;
    return Object.freeze({ trigger, storedDefinition: storedDefinition.data });
}

function readEditSeedObservation(
    trigger: PluginEventTriggerDetail,
    privateDefinition: AutomationEventTriggerDefinitionStoredPayloadV1,
): PluginEventAutomationEditSeedObservation | null {
    const observation = trigger.observation;
    if (observation.kind === 'checkpointedPull') {
        const watcher = observation.watcher;
        if (!watcher || watcher.pluginId !== trigger.eventRef.pluginId) return null;
        return Object.freeze({
            kind: 'checkpointedPull' as const,
            watcherMaterializationRef: Object.freeze({
                machineId: watcher.machineId,
                machineInstallationId: watcher.machineInstallationId,
                pluginId: watcher.pluginId,
                materializationId: watcher.materializationId,
            }),
        });
    }
    const endpointId = PluginWebhookEndpointIdV1Schema.safeParse(observation.webhookEndpointId);
    if (!endpointId.success || !privateDefinition.webhookRoutingSourceInstanceId) return null;
    return Object.freeze({
        kind: 'durablePush' as const,
        webhookEndpointId: endpointId.data,
        webhookRoutingSourceInstanceId: privateDefinition.webhookRoutingSourceInstanceId,
    });
}

export function readPluginEventAutomationEditSeed(
    definition: AutomationDefinition | null,
    triggerId: string,
    access: PluginEventAutomationStoredContentAccess,
): PluginEventAutomationEditSeed | null {
    const privateDetail = readPluginEventAutomationPrivateDetail(definition, triggerId, access);
    if (!privateDetail || definition?.detail.kind !== 'available') return null;
    const detail = definition.detail.value;
    const { trigger, storedDefinition } = privateDetail;
    const observation = readEditSeedObservation(trigger, storedDefinition);
    if (!observation) return null;
    const source = PluginEventAutomationSetupResultV1Schema.safeParse({
        v: 1,
        sourceInstanceId: storedDefinition.sourceInstanceId,
        sourceContractVersion: trigger.sourceContractVersion,
        sourceConfig: storedDefinition.sourceConfig,
        displayLabel: storedDefinition.displayLabel,
    });
    if (!source.success) return null;
    return Object.freeze({
        automationId: detail.id,
        triggerId: trigger.id,
        expectedTriggerRevision: trigger.revision,
        enabled: trigger.enabled,
        eventRef: Object.freeze({ ...trigger.eventRef }),
        source: source.data,
        observation,
        filter: storedDefinition.filter,
        maximumObservationAgeMs: storedDefinition.maximumObservationAgeMs,
    });
}

/**
 * Rehydrates the transient composer from the row's current strict value.
 * Persisted identity/revision remain the original CAS witness; only source
 * setup fields are replaced. This makes closing and reopening an unsaved row
 * show exactly what the plural draft currently contains.
 */
export function pluginEventAutomationEditSeedFromCurrentInput(
    seed: PluginEventAutomationEditSeed,
    value: AutomationPluginEventDefinitionTrigger & Readonly<{ enabled: boolean }>,
): PluginEventAutomationEditSeed {
    return Object.freeze({
        ...seed,
        enabled: value.enabled,
        eventRef: Object.freeze({ ...value.eventRef }),
        source: PluginEventAutomationSetupResultV1Schema.parse({
            v: 1,
            sourceInstanceId: value.sourceInstanceId,
            sourceContractVersion: value.sourceContractVersion,
            sourceConfig: value.sourceConfig,
            displayLabel: value.displayLabel,
        }),
        observation: value.observationTransport.kind === 'checkpointedPull'
            ? Object.freeze({
                kind: 'checkpointedPull' as const,
                watcherMaterializationRef: Object.freeze({ ...value.observationTransport.watcherMaterializationRef }),
            })
            : Object.freeze({
                kind: 'durablePush' as const,
                webhookEndpointId: value.observationTransport.webhookEndpointId,
                webhookRoutingSourceInstanceId: value.observationTransport.webhookRoutingSourceInstanceId,
                endpointMaterializationRef: Object.freeze({ ...value.observationTransport.endpointMaterializationRef }),
            }),
        filter: value.filter,
        maximumObservationAgeMs: value.maximumObservationAgeMs,
    });
}

/**
 * Seeds the canonical Event composer from one not-yet-persisted plural row.
 * The editor's client-stable Automation/trigger identities are presentation
 * currentness witnesses only; the sole Automation writer still owns durable
 * identity and revision admission.
 */
export function pluginEventAutomationEditSeedFromDraftInput(params: Readonly<{
    automationId: string;
    triggerId: string;
    value: AutomationPluginEventDefinitionTrigger & Readonly<{ enabled: boolean }>;
}>): PluginEventAutomationEditSeed {
    const triggerId = AutomationTriggerIdSchema.parse(params.triggerId);
    return pluginEventAutomationEditSeedFromCurrentInput(Object.freeze({
        automationId: params.automationId,
        triggerId,
        expectedTriggerRevision: AutomationTriggerRevisionSchema.parse(0),
        enabled: params.value.enabled,
        eventRef: Object.freeze({ ...params.value.eventRef }),
        source: PluginEventAutomationSetupResultV1Schema.parse({
            v: 1,
            sourceInstanceId: params.value.sourceInstanceId,
            sourceContractVersion: params.value.sourceContractVersion,
            sourceConfig: params.value.sourceConfig,
            displayLabel: params.value.displayLabel,
        }),
        observation: params.value.observationTransport.kind === 'checkpointedPull'
            ? Object.freeze({
                kind: 'checkpointedPull' as const,
                watcherMaterializationRef: Object.freeze({
                    ...params.value.observationTransport.watcherMaterializationRef,
                }),
            })
            : Object.freeze({
                kind: 'durablePush' as const,
                webhookEndpointId: params.value.observationTransport.webhookEndpointId,
                webhookRoutingSourceInstanceId:
                    params.value.observationTransport.webhookRoutingSourceInstanceId,
                endpointMaterializationRef: Object.freeze({
                    ...params.value.observationTransport.endpointMaterializationRef,
                }),
            }),
        filter: params.value.filter,
        maximumObservationAgeMs: params.value.maximumObservationAgeMs,
    }), params.value);
}
