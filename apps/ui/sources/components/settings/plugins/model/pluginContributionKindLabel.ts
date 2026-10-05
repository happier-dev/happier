import type { PluginContributionKind } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { t } from '@/text';

/**
 * The kind of thing a plugin adds, as one short label ("Agent", "Code hosting", "Voice"): its first
 * projected contribution kind that a person would recognise. Kinds that describe plumbing (managed
 * dependencies, Account collections) have no label. `null` when nothing recognisable is projected,
 * so a plugin never gets invented copy.
 */
export function resolvePluginContributionKindLabel(kinds: readonly PluginContributionKind[] | null | undefined): string | null {
    for (const kind of kinds ?? []) {
        const label = labelFor(kind);
        if (label) return label;
    }
    return null;
}

function labelFor(kind: PluginContributionKind): string | null {
    switch (kind) {
        case 'agent': return t('settingsPlugins.surfaces.kinds.agent');
        case 'roles': return t('roles.rail.label');
        case 'workflows': return t('workflows.title');
        case 'providers': return t('settingsPlugins.surfaces.kinds.providers');
        case 'scmHostingProviders': return t('settingsPlugins.surfaces.kinds.scmHostingProviders');
        case 'scmBackends': return t('settingsPlugins.surfaces.kinds.scmBackends');
        case 'voiceProviders':
        case 'voiceModelPacks': return t('settingsPlugins.surfaces.kinds.voice');
        case 'connectedAccounts': return t('settingsPlugins.surfaces.kinds.connectedAccounts');
        case 'inputTypes': return t('settingsPlugins.surfaces.kinds.inputTypes');
        case 'mcp': return t('settingsPlugins.surfaces.kinds.mcp');
        case 'pluginUi': return t('settingsPlugins.surfaces.kinds.pluginUi');
        case 'pluginBrowser': return t('settingsPlugins.surfaces.kinds.pluginBrowser');
        case 'composerAttachments':
        case 'composerControls':
        case 'composerRegions': return t('settingsPlugins.surfaces.kinds.composer');
        case 'managedDependencies':
        case 'accountCollections':
        case 'dragSources':
        case 'dropTargets': return null;
    }
    kind satisfies never;
    return null;
}
