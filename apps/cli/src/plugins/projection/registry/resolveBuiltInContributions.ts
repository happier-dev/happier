import { GH_INSTALLABLE_DESCRIPTOR } from '@happier-dev/protocol';

import {
    BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS,
    BUNDLED_FIRST_PARTY_AGENT_RUNTIME_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_CONNECTED_ACCOUNT_DESCRIPTOR_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_EXECUTION_RUN_PROFILE_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_INSTALLABLE_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_PLUGIN_AGENT_RUNTIME_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_AGENT_CATALOG_ENTRY_HOOKS,
    BUNDLED_FIRST_PARTY_AGENT_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_SCM_BACKEND_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_SCM_HOSTING_PROVIDER_CONTRIBUTIONS,
} from './sources/generatedBundledPlugins';
import {
    FIRST_PARTY_REACT_NATIVE_BUNDLES,
    FIRST_PARTY_SETTINGS,
    FIRST_PARTY_STRUCTURED_MESSAGES,
    FIRST_PARTY_SURFACE_PLACEMENTS,
    FIRST_PARTY_UI_ARTIFACTS,
    FIRST_PARTY_UI_TRANSLATIONS,
} from './firstPartyUiContributions';
import { applyProviderCatalogEntryHooks } from './providerCatalogEntryHooks';
import type { ResolvedContributionInputs } from './types';

const EMPTY_CONTRIBUTIONS = Object.freeze([]);
const EMPTY_DIAGNOSTICS = Object.freeze({});

type ResolvedBuiltInContributionInputs = ResolvedContributionInputs & Required<
    Pick<ResolvedContributionInputs, 'agents' | 'agentRuntimes'>
>;

export function resolveBuiltInContributions(): ResolvedBuiltInContributionInputs {
    return {
        agents: BUNDLED_FIRST_PARTY_AGENT_CONTRIBUTIONS.map((provider) =>
            applyProviderCatalogEntryHooks(provider, BUNDLED_FIRST_PARTY_AGENT_CATALOG_ENTRY_HOOKS)
        ),
        agentRuntimes: Object.freeze([
            ...BUNDLED_FIRST_PARTY_AGENT_RUNTIME_CONTRIBUTIONS,
            ...BUNDLED_FIRST_PARTY_PLUGIN_AGENT_RUNTIME_CONTRIBUTIONS,
        ]),
        catalogEntries: EMPTY_CONTRIBUTIONS,
        actions: EMPTY_CONTRIBUTIONS,
        executionRunProfiles: BUNDLED_FIRST_PARTY_EXECUTION_RUN_PROFILE_CONTRIBUTIONS,
        managedDependencies: Object.freeze([
            {
                provenance: 'first_party',
                source: { kind: 'bundled' },
                pluginId: 'happier.core',
                definition: GH_INSTALLABLE_DESCRIPTOR,
            },
            ...BUNDLED_FIRST_PARTY_INSTALLABLE_CONTRIBUTIONS,
        ]),
        activationTargets: BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS,
        scmHostingProviders: BUNDLED_FIRST_PARTY_SCM_HOSTING_PROVIDER_CONTRIBUTIONS,
        scmBackends: BUNDLED_FIRST_PARTY_SCM_BACKEND_CONTRIBUTIONS,
        connectedAccountDescriptors: BUNDLED_FIRST_PARTY_CONNECTED_ACCOUNT_DESCRIPTOR_CONTRIBUTIONS,
        uiTranslations: FIRST_PARTY_UI_TRANSLATIONS,
        surfacePlacements: FIRST_PARTY_SURFACE_PLACEMENTS,
        structuredMessages: FIRST_PARTY_STRUCTURED_MESSAGES,
        reactNativeBundles: FIRST_PARTY_REACT_NATIVE_BUNDLES,
        uiArtifacts: FIRST_PARTY_UI_ARTIFACTS,
        settings: FIRST_PARTY_SETTINGS,
        hookRegistrations: EMPTY_CONTRIBUTIONS,
        pluginDiagnosticsByPluginId: EMPTY_DIAGNOSTICS,
    };
}
