import { describe, expect, it } from 'vitest';

import {
    getUiFeatureDefinition,
    shouldTrackUiFeatureEffective,
    shouldTrackUiFeaturePreference,
} from './uiFeatureRegistry';
import { listUiFeatureToggleDefinitions } from './uiFeatureToggles';

const PLUGIN_UI_FEATURE_IDS = [
    'plugins',
    'plugins.ui',
    'plugins.ui.hostedWeb',
    'plugins.ui.reactNativeBundles',
    'plugins.ui.reactNativeBundles.devHotReload',
] as const;

describe('UI plugin feature registry', () => {
    it('does not advertise the retired structured-message feature', () => {
        expect(getUiFeatureDefinition('plugins.ui.structuredMessages' as never)).toBeUndefined();
    });

    it('projects plugin webhooks as a server-owned runtime feature', () => {
        expect(getUiFeatureDefinition('plugins.webhooks').settingsToggle).toBeUndefined();
    });

    it('registers plugin UI tier feature ids as runtime-only UI features', () => {
        for (const featureId of PLUGIN_UI_FEATURE_IDS) {
            expect(getUiFeatureDefinition(featureId).settingsToggle).toBeUndefined();
        }
    });

    it('does not expose executable plugin UI tier gates as independent settings toggles', () => {
        const toggleIds = new Set(listUiFeatureToggleDefinitions().map((definition) => definition.featureId));

        for (const featureId of PLUGIN_UI_FEATURE_IDS) {
            expect(toggleIds.has(featureId)).toBe(false);
            expect(shouldTrackUiFeaturePreference(featureId)).toBe(false);
            expect(shouldTrackUiFeatureEffective(featureId)).toBe(true);
        }
    });
});
