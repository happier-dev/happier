import {
    BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS,
    BUNDLED_FIRST_PARTY_BACKEND_CONTRIBUTIONS,
    BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS,
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
        activationTargets: BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS,
        hookRegistrations: EMPTY_CONTRIBUTIONS,
        pluginDiagnosticsByPluginId: EMPTY_DIAGNOSTICS,
    };
}
