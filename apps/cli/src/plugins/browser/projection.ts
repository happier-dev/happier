import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

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
            target: contribution.definition.target,
            display: contribution.definition.display,
            visibility: contribution.definition.visibility,
            featureGate: contribution.definition.featureGate,
            order: contribution.definition.order,
            compatibility: contribution.definition.compatibility,
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
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'browserAction',
            contributionId: contribution.definition.id,
            actionKind: contribution.definition.kind,
            target: contribution.definition.target,
            display: contribution.definition.display,
            visibility: contribution.definition.visibility,
            enabled: contribution.definition.enabled,
            featureGate: contribution.definition.featureGate,
            order: contribution.definition.order,
            compatibility: contribution.definition.compatibility,
            policy: contribution.definition.policy,
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
