import { describe, expect, it } from 'vitest';

import {
    listUiFeatureToggleDefinitions,
    resolveUiFeatureToggleEnabled,
} from '@/sync/domains/features/featureRegistry';
import { settingsDefaults } from '@/sync/domains/settings/settings';

describe('UI pets feature registry', () => {
    it('registers pets.companion as an enabled-by-default settings toggle', () => {
        const petsCompanion = listUiFeatureToggleDefinitions().find((definition) => (
            definition.featureId === 'pets.companion'
        ));

        expect(petsCompanion).toMatchObject({
            featureId: 'pets.companion',
            isExperimental: false,
            defaultEnabled: true,
            serverVisibilityScope: 'main_selection',
        });
    });

    it('does not expose pets.sync as a local settings toggle', () => {
        expect(listUiFeatureToggleDefinitions().some((definition) => (
            definition.featureId === 'pets.sync'
        ))).toBe(false);
    });

    it('resolves pets.companion through the account feature toggle map', () => {
        expect(resolveUiFeatureToggleEnabled({
            ...settingsDefaults,
            featureToggles: {},
        }, 'pets.companion')).toBe(true);

        expect(resolveUiFeatureToggleEnabled({
            ...settingsDefaults,
            featureToggles: { 'pets.companion': false },
        }, 'pets.companion')).toBe(false);

        expect(resolveUiFeatureToggleEnabled({
            ...settingsDefaults,
            featureToggles: { 'pets.companion': true },
        }, 'pets.companion')).toBe(true);
    });
});
