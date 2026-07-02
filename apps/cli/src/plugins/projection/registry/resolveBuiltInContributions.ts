import { CODEX_ACP_INSTALLABLE_DESCRIPTOR, GH_INSTALLABLE_DESCRIPTOR } from '@happier-dev/protocol';

import {
    BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS,
    BUNDLED_FIRST_PARTY_BACKEND_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_CONNECTED_ACCOUNT_DESCRIPTOR_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_EXECUTION_RUN_PROFILE_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_INSTALLABLE_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_PLUGIN_BACKEND_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_PROVIDER_CATALOG_ENTRY_HOOKS,
    BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_SCM_BACKEND_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_SCM_HOSTING_PROVIDER_CONTRIBUTIONS,
} from './sources/generatedBundledPlugins';
import { applyProviderCatalogEntryHooks } from './providerCatalogEntryHooks';
import type { ResolvedContributionInputs } from './types';

const EMPTY_CONTRIBUTIONS = Object.freeze([]);
const EMPTY_DIAGNOSTICS = Object.freeze({});

export function resolveBuiltInContributions(): ResolvedContributionInputs {
    return {
        providers: BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS.map((provider) =>
            applyProviderCatalogEntryHooks(provider, BUNDLED_FIRST_PARTY_PROVIDER_CATALOG_ENTRY_HOOKS)
        ),
        backends: Object.freeze([
            ...BUNDLED_FIRST_PARTY_BACKEND_CONTRIBUTIONS,
            ...BUNDLED_FIRST_PARTY_PLUGIN_BACKEND_CONTRIBUTIONS,
        ]),
        catalogEntries: EMPTY_CONTRIBUTIONS,
        actions: EMPTY_CONTRIBUTIONS,
        executionRunProfiles: BUNDLED_FIRST_PARTY_EXECUTION_RUN_PROFILE_CONTRIBUTIONS,
        installables: Object.freeze([
            {
                provenance: 'first_party',
                source: { kind: 'bundled' },
                pluginId: 'happier.core',
                definition: CODEX_ACP_INSTALLABLE_DESCRIPTOR,
            },
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
        hookRegistrations: EMPTY_CONTRIBUTIONS,
        pluginDiagnosticsByPluginId: EMPTY_DIAGNOSTICS,
    };
}
