import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
} from '@happier-dev/protocol';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import type { ResolvedContributionRegistry } from './types';

type PluginBrowserProjectedEntry = Readonly<Record<string, unknown> & {
    id: string;
    pluginId?: string;
    contributionKind: 'browserTarget' | 'browserAction';
}>;

function readPluginId(entry: Readonly<{ pluginId?: string }>): string | null {
    const pluginId = entry.pluginId?.trim();
    return pluginId && pluginId.length > 0 ? pluginId : null;
}

function addEntry(
    entriesById: Record<string, PluginBrowserProjectedEntry>,
    entry: PluginBrowserProjectedEntry,
): void {
    entriesById[entry.id] = Object.freeze(entry);
}

function resolveReference(
    pluginId: string,
    reference: string | Readonly<{ pluginId: string; localId: string }>,
): Readonly<{
    pluginId: string;
    localId: string;
}> {
    return typeof reference === 'string'
        ? createPluginContributionIdentity({ pluginId, localId: reference })
        : createPluginContributionIdentity(reference);
}

function projectBrowserTargets(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginBrowserProjectedEntry>,
): void {
    for (const contribution of registry.browserTargets ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `browserTarget:${pluginId}:${contribution.definition.id}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'browserTarget',
            contributionId: contribution.definition.id,
            target: Object.freeze({
                kind: 'externalUrl',
                targetId: id,
                url: contribution.definition.url,
            }),
            display: Object.freeze({
                title: contribution.definition.title,
                addressLabel: contribution.definition.url,
            }),
            currentUrl: contribution.definition.url,
            launchMode: contribution.definition.launch,
            profileMode: contribution.definition.profile,
            description: contribution.definition.description,
            availability: contribution.definition.availability,
            metadata: contribution.definition.metadata,
        });
    }
}

function projectBrowserActions(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginBrowserProjectedEntry>,
): void {
    for (const contribution of registry.browserActions ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `browserAction:${pluginId}:${contribution.definition.id}`;
        const actionReference = resolveReference(pluginId, contribution.definition.action);
        const targetReference = resolveReference(pluginId, contribution.definition.target);
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'browserAction',
            contributionId: contribution.definition.id,
            qualifiedActionId: buildQualifiedPluginContributionKey(actionReference),
            targetId: `browserTarget:${targetReference.pluginId}:${targetReference.localId}`,
            placement: contribution.definition.placement,
            display: Object.freeze({
                title: contribution.definition.title,
                ...(contribution.definition.icon ? { iconToken: contribution.definition.icon } : {}),
            }),
            description: contribution.definition.description,
            order: contribution.definition.order,
            availability: contribution.definition.availability,
            metadata: contribution.definition.metadata,
        });
    }
}

export const pluginBrowserProjectionFamily = definePluginProjectionFamilyV2({
    family: 'pluginBrowser',
    project({ registry }) {
        const entriesById: Record<string, PluginBrowserProjectedEntry> = {};
        projectBrowserTargets(registry, entriesById);
        projectBrowserActions(registry, entriesById);

        return {
            family: 'pluginBrowser',
            entriesById: Object.freeze(entriesById),
        };
    },
});
