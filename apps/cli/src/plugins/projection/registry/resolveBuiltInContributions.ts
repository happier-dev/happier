import { GH_INSTALLABLE_DESCRIPTOR } from '@happier-dev/protocol';

import {
    BUNDLED_FIRST_PARTY_IMPLEMENTATION_BINDINGS,
    BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS,
} from './sources/generatedBundledPlugins';
import { projectBuiltInAgents } from './builtIn/agents';
import { loadBundledPluginLocators } from './builtIn/locators';
import { projectLoadedPluginContributes } from './resolvePluginContributions';
import type { ResolvedContributionInputs, ResolvedInstallableContribution } from './types';

const EMPTY_CONTRIBUTIONS = Object.freeze([]);

type ResolvedBuiltInContributionInputs = ResolvedContributionInputs & Required<
    Pick<ResolvedContributionInputs, 'agents' | 'providers'>
>;

/**
 * Projects first-party packages through the same canonical manifest path as
 * installed plugins, then overlays only host-owned executable Agent facts.
 */
export function resolveBuiltInContributions(): ResolvedBuiltInContributionInputs {
    const loadedPlugins = loadBundledPluginLocators(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS);
    const projected = projectLoadedPluginContributes({
        loadResult: {
            loadedPlugins,
            diagnosticsByPluginId: {},
        },
        provenance: 'first_party',
    });
    const agents = projectBuiltInAgents({
        manifestAgents: projected.agents ?? EMPTY_CONTRIBUTIONS,
        implementationBindings: BUNDLED_FIRST_PARTY_IMPLEMENTATION_BINDINGS,
    });

    return Object.freeze({
        ...projected,
        agents,
        providers: projected.providers ?? EMPTY_CONTRIBUTIONS,
        catalogEntries: EMPTY_CONTRIBUTIONS,
        managedDependencies: Object.freeze([
            {
                provenance: 'first_party',
                source: { kind: 'bundled' },
                pluginId: 'happier.core',
                definition: GH_INSTALLABLE_DESCRIPTOR,
            } satisfies ResolvedInstallableContribution,
            ...(projected.managedDependencies ?? EMPTY_CONTRIBUTIONS),
        ]),
    });
}
