import { buildQualifiedPluginContributionKey, PluginContributionIdentityV1Schema, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { NormalizedPluginCollectionUiQueryDescriptorV1Schema, type NormalizedPluginCollectionUiQueryDescriptorV1 } from '@happier-dev/protocol/plugins/data/collectionUiQueryWireV1';
import { PluginDeclarativeProjectedModelV1Schema } from '@happier-dev/protocol/plugins/contributions/ui/declarativeProjectedModelV1';
import { PluginDeclarativeSettingsInventoryEntryV1Schema, type PluginDeclarativeSettingsInventoryEntryV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeDocument';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';

export type DeclarativeStaticRecord = Readonly<Record<string, unknown>>;

export type AdmittedDeclarativeAction = Readonly<{
    identity: PluginContributionIdentityV1;
    qualifiedId: string;
    enabled: boolean;
    title?: string;
    icon?: string;
}>;

export type AdmittedDeclarativeDestination = Readonly<{
    identity: PluginContributionIdentityV1;
    qualifiedId: string;
}>;

export type AdmittedDeclarativeSetting = Readonly<{
    inventory: PluginDeclarativeSettingsInventoryEntryV1;
    setting: DeclarativeStaticRecord;
}>;

export type AdmittedDeclarativeStaticModel = Readonly<{
    dragSources: ReadonlyMap<string, AdmittedDeclarativeDestination & Readonly<{ referenceSchema: PluginJsonSchemaV2 }>>;
    dropTargets: ReadonlyMap<string, AdmittedDeclarativeDestination>;
    model: DeclarativeStaticRecord;
    root: DeclarativeStaticRecord;
    occurrenceId?: string;
    qualifiedId: string;
    actions: ReadonlyMap<string, AdmittedDeclarativeAction>;
    destinations: ReadonlyMap<string, AdmittedDeclarativeDestination>;
    settingsById: ReadonlyMap<string, AdmittedDeclarativeSetting>;
    settingsByQualifiedId: ReadonlyMap<string, AdmittedDeclarativeSetting>;
    settings: readonly PluginDeclarativeSettingsInventoryEntryV1[];
    uiQueries: ReadonlyMap<string, NormalizedPluginCollectionUiQueryDescriptorV1>;
}>;

function record(value: unknown): DeclarativeStaticRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as DeclarativeStaticRecord
        : null;
}

function nonemptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function declarativeCollectionUiQueryKey(collectionId: string, uiQueryId: string): string {
    return `${collectionId}\u0000${uiQueryId}`;
}

function readQualifiedReference(input: Readonly<{
    value: unknown;
    pluginId: string;
    occurrenceId?: string;
}>): AdmittedDeclarativeDestination | null {
    const value = record(input.value);
    const identity = PluginContributionIdentityV1Schema.safeParse(value?.identity);
    const qualifiedId = nonemptyString(value?.qualifiedId);
    if (
        !identity.success
        || identity.data.pluginId !== input.pluginId
        || value?.occurrenceId !== input.occurrenceId
        || qualifiedId !== buildQualifiedPluginContributionKey(identity.data)
    ) {
        return null;
    }
    return Object.freeze({ identity: identity.data, qualifiedId });
}

/**
 * The one immutable UI admission view over the daemon's static declarative
 * projection. This is a value decoder, never a registry: callers retain no
 * authority outside the exact model/occurrenceId supplied here.
 */
export function admitDeclarativeStaticModel(input: Readonly<{
    model: unknown;
    expectedPluginId: string;
}>): AdmittedDeclarativeStaticModel | null {
    // Structural admission belongs to the one strict Protocol-owned projected
    // model contract — the same schema the daemon wire enforces. This UI
    // admission keeps only the relational/currentness checks that own the
    // mounted plugin/occurrenceId/Settings lifetimes.
    const structural = PluginDeclarativeProjectedModelV1Schema.safeParse(input.model);
    if (!structural.success) return null;
    const model = record(structural.data);
    const identity = record(model?.identity);
    const contributionIdentity = PluginContributionIdentityV1Schema.safeParse({
        pluginId: identity?.pluginId,
        localId: identity?.localId,
    });
    const occurrenceId = structural.data.identity.occurrenceId;
    const qualifiedId = nonemptyString(identity?.qualifiedId);
    const root = record(model?.root);
    if (
        !model
        || model.visible !== true
        || !contributionIdentity.success
        || contributionIdentity.data.pluginId !== input.expectedPluginId
        || qualifiedId !== buildQualifiedPluginContributionKey(contributionIdentity.data)
        || !root
    ) {
        return null;
    }

    const inventory = record(model.declarativeInventory);
    if (!inventory) return null;
    const dragSources = new Map<string, AdmittedDeclarativeDestination & Readonly<{ referenceSchema: PluginJsonSchemaV2 }>>();
    const dropTargets = new Map<string, AdmittedDeclarativeDestination>();
    for (const entry of structural.data.declarativeInventory.dragSources ?? []) {
        const reference = readQualifiedReference({ value: entry, pluginId: input.expectedPluginId, occurrenceId });
        if (!reference || dragSources.has(reference.qualifiedId)) return null;
        dragSources.set(reference.qualifiedId, Object.freeze({ ...reference, referenceSchema: entry.referenceSchema }));
    }
    for (const entry of structural.data.declarativeInventory.dropTargets ?? []) {
        const reference = readQualifiedReference({ value: entry, pluginId: input.expectedPluginId, occurrenceId });
        if (!reference || dropTargets.has(reference.qualifiedId)) return null;
        dropTargets.set(reference.qualifiedId, reference);
    }
    const actionEntries = inventory.actions;
    const destinationEntries = inventory.destinations;
    const settingEntries = inventory.settings;
    const uiQueryEntries = inventory.uiQueries;
    if (
        !Array.isArray(actionEntries)
        || !Array.isArray(destinationEntries)
        || !Array.isArray(settingEntries)
        || !Array.isArray(uiQueryEntries)
    ) {
        return null;
    }
    const actions = new Map<string, AdmittedDeclarativeAction>();
    const destinations = new Map<string, AdmittedDeclarativeDestination>();
    const settingsById = new Map<string, AdmittedDeclarativeSetting>();
    const settingsByQualifiedId = new Map<string, AdmittedDeclarativeSetting>();
    const settings: PluginDeclarativeSettingsInventoryEntryV1[] = [];
    const uiQueries = new Map<string, NormalizedPluginCollectionUiQueryDescriptorV1>();

    for (const value of actionEntries) {
        const entry = record(value);
        const reference = readQualifiedReference({ value, pluginId: input.expectedPluginId, occurrenceId });
        if (!entry || !reference || actions.has(reference.qualifiedId)) return null;
        const title = nonemptyString(entry.title);
        const icon = nonemptyString(entry.icon);
        actions.set(reference.qualifiedId, Object.freeze({
            ...reference,
            enabled: entry.enabled === true,
            ...(title ? { title } : {}),
            ...(icon ? { icon } : {}),
        }));
    }

    for (const value of destinationEntries) {
        const reference = readQualifiedReference({ value, pluginId: input.expectedPluginId, occurrenceId });
        if (!reference || destinations.has(reference.qualifiedId)) return null;
        destinations.set(reference.qualifiedId, reference);
    }

    for (const value of settingEntries) {
        const entry = record(value);
        const setting = record(entry?.setting);
        const descriptor = record(setting?.descriptor);
        const parsed = PluginDeclarativeSettingsInventoryEntryV1Schema.safeParse({
            pluginId: entry?.pluginId,
            id: entry?.id,
            qualifiedId: entry?.qualifiedId,
            schema: entry?.schema,
            secret: entry?.secret,
        });
        if (
            !parsed.success
            || parsed.data.pluginId !== input.expectedPluginId
            || !setting
            || setting.id !== parsed.data.id
            || setting.qualifiedId !== parsed.data.qualifiedId
            || !descriptor
            || !sameStrictJsonValue(descriptor.schema, parsed.data.schema)
            || (descriptor.secret === true) !== parsed.data.secret
            || settingsById.has(parsed.data.id)
            || settingsByQualifiedId.has(parsed.data.qualifiedId)
        ) {
            return null;
        }
        const admitted = Object.freeze({ inventory: parsed.data, setting });
        settings.push(parsed.data);
        settingsById.set(parsed.data.id, admitted);
        settingsByQualifiedId.set(parsed.data.qualifiedId, admitted);
    }

    for (const value of uiQueryEntries) {
        const parsed = NormalizedPluginCollectionUiQueryDescriptorV1Schema.safeParse(value);
        if (!parsed.success || parsed.data.collection.pluginId !== input.expectedPluginId) return null;
        const key = declarativeCollectionUiQueryKey(parsed.data.collection.collectionId, parsed.data.id);
        if (uiQueries.has(key)) return null;
        uiQueries.set(key, parsed.data);
    }

    const pendingNodes: unknown[] = [root];
    while (pendingNodes.length > 0) {
        const node = record(pendingNodes.pop());
        if (!node) return null;
        if (node.kind === 'dragSource' || node.kind === 'dropTarget') {
            const reference = readQualifiedReference({ value: node.kind === 'dragSource' ? node.source : node.target,
                pluginId: input.expectedPluginId, occurrenceId });
            if (!reference || !(node.kind === 'dragSource' ? dragSources : dropTargets).has(reference.qualifiedId)) return null;
        }
        if (node.kind === 'field') {
            const nodeSetting = record(node.setting);
            const nodeSettingId = nonemptyString(nodeSetting?.id);
            const nodeSettingQualifiedId = nonemptyString(nodeSetting?.qualifiedId);
            const admitted = nodeSettingQualifiedId
                ? settingsByQualifiedId.get(nodeSettingQualifiedId)
                : undefined;
            if (
                !nodeSetting
                || !nodeSettingId
                || !admitted
                || admitted.inventory.id !== nodeSettingId
                || !sameStrictJsonValue(nodeSetting, admitted.setting)
            ) {
                return null;
            }
        }
        if (Array.isArray(node.children)) pendingNodes.push(...node.children);
        if (node.kind === 'targetedSurface' && Object.hasOwn(node, 'fallback')) {
            pendingNodes.push(node.fallback);
        }
    }

    return Object.freeze({
        model,
        root,
        occurrenceId,
        qualifiedId,
        actions,
        destinations,
        settingsById,
        settingsByQualifiedId,
        settings: Object.freeze(settings),
        uiQueries,
        dragSources,
        dropTargets,
    });
}
