import { describe, expect, it } from 'vitest';

import { buildUiFeatureToggleDefaults } from './uiFeatureToggles';
import { getUiFeatureDefinition } from './uiFeatureRegistry';

describe('uiFeatureRegistry activity surfaces', () => {
    it('registers the activity surface feature toggles as experimental settings entries', () => {
        const liveActivities = getUiFeatureDefinition('app.ui.liveActivities');
        expect(liveActivities.settingsToggle?.showInSettings).toBe(true);
        expect(liveActivities.settingsToggle?.isExperimental).toBe(true);
        expect(liveActivities.settingsToggle?.defaultEnabled).toBe(false);
        expect(liveActivities.settingsToggle?.titleKey).toBe('settingsFeatures.expLiveActivities');
        expect(liveActivities.settingsToggle?.subtitleKey).toBe('settingsFeatures.expLiveActivitiesSubtitle');

        const widgets = getUiFeatureDefinition('app.ui.homeScreenWidgets');
        expect(widgets.settingsToggle?.showInSettings).toBe(true);
        expect(widgets.settingsToggle?.isExperimental).toBe(true);
        expect(widgets.settingsToggle?.defaultEnabled).toBe(false);
        expect(widgets.settingsToggle?.titleKey).toBe('settingsFeatures.expHomeScreenWidgets');
        expect(widgets.settingsToggle?.subtitleKey).toBe('settingsFeatures.expHomeScreenWidgetsSubtitle');
    });

    it('keeps activity surface toggles disabled by default in the experimental settings snapshot', () => {
        const defaults = buildUiFeatureToggleDefaults({ experimentalOnly: true });
        expect(defaults['app.ui.liveActivities']).toBe(false);
        expect(defaults['app.ui.homeScreenWidgets']).toBe(false);
    });
});
