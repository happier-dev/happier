import { CODEX_ACP_INSTALLABLE_DESCRIPTOR, GH_INSTALLABLE_DESCRIPTOR } from '@happier-dev/protocol';

import {
    BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS,
    BUNDLED_FIRST_PARTY_BACKEND_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_SCM_HOSTING_PROVIDER_CONTRIBUTIONS,
} from './sources/generatedBundledPlugins';
import type { ResolvedContributionInputs } from './types';

const EMPTY_CONTRIBUTIONS = Object.freeze([]);
const EMPTY_DIAGNOSTICS = Object.freeze({});

export function resolveBuiltInContributions(): ResolvedContributionInputs {
    return {
        providers: BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS,
        backends: BUNDLED_FIRST_PARTY_BACKEND_CONTRIBUTIONS,
        catalogEntries: EMPTY_CONTRIBUTIONS,
        actions: EMPTY_CONTRIBUTIONS,
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
        ]),
        activationTargets: BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS,
        scmHostingProviders: BUNDLED_FIRST_PARTY_SCM_HOSTING_PROVIDER_CONTRIBUTIONS,
        hookRegistrations: EMPTY_CONTRIBUTIONS,
        pluginDiagnosticsByPluginId: EMPTY_DIAGNOSTICS,
    };
}
