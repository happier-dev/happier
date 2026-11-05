import { describe, expect, it } from 'vitest';
import { readBuiltInSettingDeclarationV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';

import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { listUiFeatureToggleDefinitions } from '@/sync/domains/features/featureRegistry';

import { FEATURES_SETTINGS, resolveFeatureToggleHref } from './featuresSettings';

describe('Features page search declarations', () => {
    it.each(['voice.agent', 'voice.daemonInference'] as const)('keeps %s discoverable in optional features with Experiments off', (featureId) => {
        expect(FEATURES_SETTINGS.settings[featureId].sectionId).toBe('features.optionalFeatures');
        expect(resolveFeatureToggleHref(featureId, false)).toBe(`/settings/features?setting=features.${featureId}`);
    });
    it('declares every feature toggle this build can show, so search finds each one', () => {
        const declaredTitleKeys = Object.values(FEATURES_SETTINGS.settings).map((setting) => setting.titleKey);
        const buildAllowed = listUiFeatureToggleDefinitions()
            .filter((definition) => getFeatureBuildPolicyDecision(definition.featureId) !== 'deny');

        expect(buildAllowed.length).toBeGreaterThan(0);
        for (const definition of buildAllowed) {
            expect(declaredTitleKeys).toContain(definition.titleKey);
        }
        expect(declaredTitleKeys).toEqual(expect.arrayContaining([
            'terminalEmbedded.settings.rendererTitle',
        ]));
    });

    it('places every shared feature anchor in the section selected by the feature registry', () => {
        for (const definition of listUiFeatureToggleDefinitions()) {
            const shared = readBuiltInSettingDeclarationV1(`features.${definition.featureId}`);
            expect(shared, definition.featureId).toMatchObject({
                sectionId: definition.isExperimental ? 'features.experiments' : 'features.optionalFeatures',
                sectionTitleKey: definition.isExperimental ? 'settingsFeatures.experiments' : 'settingsFeatures.localTogglesTitle',
            });
        }
    });

    it('names the section of every declared setting, so a search result shows where it lives', () => {
        for (const setting of Object.values(FEATURES_SETTINGS.settings)) {
            expect(setting.sectionTitleKey).toBeTruthy();
        }
    });
});
