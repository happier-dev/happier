import { describe, expect, it } from 'vitest';

import {
    getUiFeatureDefinition,
    shouldTrackUiFeatureEffective,
    shouldTrackUiFeaturePreference,
} from './uiFeatureRegistry';
import { listUiFeatureToggleDefinitions } from './uiFeatureToggles';

const CODEX_APP_SERVER_FEATURE_IDS = [
    'agents.codex.appServer.goals',
    'agents.codex.appServer.plugins',
    'agents.codex.appServer.structuredInput',
    'agents.codex.appServer.permissionProfiles',
] as const;
const PROVIDER_RUNTIME_FEATURE_IDS = [
    ...CODEX_APP_SERVER_FEATURE_IDS,
    'agents.claude.unifiedTerminal',
] as const;

describe('UI provider runtime feature registry', () => {
    it('registers provider runtime feature ids as runtime-only UI features', () => {
        for (const featureId of PROVIDER_RUNTIME_FEATURE_IDS) {
            expect(getUiFeatureDefinition(featureId).settingsToggle).toBeUndefined();
        }
    });

    it('does not expose provider runtime capability feature ids as independent settings toggles', () => {
        const toggleIds = new Set(listUiFeatureToggleDefinitions().map((definition) => definition.featureId));

        for (const featureId of PROVIDER_RUNTIME_FEATURE_IDS) {
            expect(toggleIds.has(featureId)).toBe(false);
            expect(shouldTrackUiFeaturePreference(featureId)).toBe(false);
            expect(shouldTrackUiFeatureEffective(featureId)).toBe(true);
        }
    });
});
