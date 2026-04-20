import { describe, expect, it } from 'vitest';

import { buildUiFeatureToggleDefaults } from './uiFeatureToggles';
import { getUiFeatureDefinition } from './uiFeatureRegistry';

describe('uiFeatureRegistry voice daemon inference', () => {
    it('registers voice.daemonInference as an experimental settings toggle', () => {
        const daemonInference = getUiFeatureDefinition('voice.daemonInference');

        expect(daemonInference.settingsToggle?.showInSettings).toBe(true);
        expect(daemonInference.settingsToggle?.isExperimental).toBe(true);
        expect(daemonInference.settingsToggle?.defaultEnabled).toBe(false);
        expect(daemonInference.settingsToggle?.titleKey).toBe('settingsFeatures.expVoiceDaemonInference');
        expect(daemonInference.settingsToggle?.subtitleKey).toBe('settingsFeatures.expVoiceDaemonInferenceSubtitle');
    });

    it('keeps voice.daemonInference disabled by default in the experimental settings snapshot', () => {
        const defaults = buildUiFeatureToggleDefaults({ experimentalOnly: true });
        expect(defaults['voice.daemonInference']).toBe(false);
    });
});
