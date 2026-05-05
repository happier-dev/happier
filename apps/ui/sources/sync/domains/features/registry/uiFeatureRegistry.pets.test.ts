import { describe, expect, it } from 'vitest';

import {
    listUiFeatureToggleDefinitions,
    resolveUiFeatureToggleEnabled,
} from '@/sync/domains/features/featureRegistry';
import { settingsDefaults } from '@/sync/domains/settings/settings';

describe('UI pets feature registry', () => {
    it('registers pets.companion as an opt-in settings toggle', () => {
        const petsCompanion = listUiFeatureToggleDefinitions().find((definition) => (
            definition.featureId === 'pets.companion'
        ));

        expect(petsCompanion).toMatchObject({
            featureId: 'pets.companion',
            isExperimental: true,
            defaultEnabled: false,
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
            experiments: true,
            featureToggles: {},
        }, 'pets.companion')).toBe(false);

        expect(resolveUiFeatureToggleEnabled({
            ...settingsDefaults,
            experiments: true,
            featureToggles: { 'pets.companion': true },
        }, 'pets.companion')).toBe(true);
    });
});
