import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import {
    buildUiFeatureExperimentsChange,
    buildUiFeatureToggleDefaults,
    listUiFeatureToggleDefinitions,
    resolveUiFeatureToggleEnabled,
} from './featurePreferenceMutations.js';
import { readBuiltInSettingDeclarationV1 } from './settingsDeclarations.js';

describe('graduated Friends availability', () => {
    it.each([undefined, false, true])('ignores retained Friends preference %s with Experiments off', storedChoice => {
        const settings = accountSettingsParse({
            experiments: false,
            featureToggles: storedChoice === undefined ? {} : { 'social.friends': storedChoice },
        });

        expect(resolveUiFeatureToggleEnabled(settings, 'social.friends')).toBe(true);
        expect(settings.featureToggles['social.friends']).toBe(storedChoice);
    });

    it('retires Friends preference authoring and experiment defaults', () => {
        expect(listUiFeatureToggleDefinitions().some(row => row.featureId === 'social.friends')).toBe(false);
        expect(buildUiFeatureToggleDefaults({ experimentalOnly: true })).not.toHaveProperty('social.friends');
        expect(readBuiltInSettingDeclarationV1('features.social.friends')).toBeNull();
        const settings = accountSettingsParse({ featureToggles: { 'social.friends': false } });
        const change = buildUiFeatureExperimentsChange(settings, true);
        expect(change.featureToggles?.['social.friends']).toBe(false);
    });
});
