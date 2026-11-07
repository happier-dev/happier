import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import {
    buildUiFeatureExperimentsChange,
    buildUiFeatureToggleChange,
    buildUiFeatureToggleDefaults,
    listUiFeatureToggleDefinitions,
    resolveUiFeatureToggleEnabled,
} from './featurePreferenceMutations.js';

// Owner ruling 2026-11-05: Subagents ships standard and enabled by default in 0.3.
describe('standard Subagents preference', () => {
    it('enables existing and new Accounts with no stored choice independently of Experiments', () => {
        for (const experiments of [undefined, false, true]) {
            const settings = accountSettingsParse({ experiments });
            expect(settings.featureToggles).not.toHaveProperty('execution.runs');
            expect(resolveUiFeatureToggleEnabled(settings, 'execution.runs')).toBe(true);
        }
        expect(listUiFeatureToggleDefinitions().find(row => row.featureId === 'execution.runs')).toMatchObject({
            isExperimental: false,
            defaultEnabled: true,
        });
        expect(buildUiFeatureToggleDefaults({ experimentalOnly: true })).not.toHaveProperty('execution.runs');
    });

    it.each([false, true])('preserves the stored Subagents choice %s across Experiments changes', storedChoice => {
        const settings = accountSettingsParse({ experiments: false, featureToggles: { 'execution.runs': storedChoice } });
        expect(resolveUiFeatureToggleEnabled(settings, 'execution.runs')).toBe(storedChoice);
        const changed = accountSettingsParse({ ...settings, ...buildUiFeatureExperimentsChange(settings, true) });
        expect(changed.featureToggles['execution.runs']).toBe(storedChoice);
        expect(resolveUiFeatureToggleEnabled(changed, 'execution.runs')).toBe(storedChoice);
    });

    it('keeps the explicit opt-out cascade for Voice Agent and Machine speech', () => {
        const settings = accountSettingsParse({ experiments: false });
        const changed = accountSettingsParse({ ...settings, ...buildUiFeatureToggleChange(settings, 'execution.runs', false) });
        for (const featureId of ['execution.runs', 'voice.agent', 'voice.daemonInference'] as const) {
            expect(resolveUiFeatureToggleEnabled(changed, featureId)).toBe(false);
        }
    });
});
