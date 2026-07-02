import { describe, expect, it } from 'vitest';

import {
    listUiFeatureToggleDefinitions,
    resolveUiFeatureToggleEnabled,
} from './uiFeatureToggles';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { FeatureId } from '@happier-dev/protocol';

const promotedFeatureIds = [
    'files.reviewComments',
    'files.syntaxHighlighting.advanced',
    'sessions.direct',
    'sessions.folders',
] satisfies FeatureId[];

describe('UI promoted feature registry', () => {
    it('registers promoted features as standard enabled-by-default settings toggles', () => {
        const definitionsById = new Map(
            listUiFeatureToggleDefinitions().map((definition) => [definition.featureId, definition]),
        );

        for (const featureId of promotedFeatureIds) {
            expect(definitionsById.get(featureId)).toMatchObject({
                featureId,
                isExperimental: false,
                defaultEnabled: true,
            });
        }
    });

    it('enables promoted features without the experiments master switch', () => {
        for (const featureId of promotedFeatureIds) {
            expect(resolveUiFeatureToggleEnabled({
                ...settingsDefaults,
                experiments: false,
                featureToggles: {},
            }, featureId)).toBe(true);
        }
    });
});
