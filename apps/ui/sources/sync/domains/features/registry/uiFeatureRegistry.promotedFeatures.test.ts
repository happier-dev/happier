import { describe, expect, it } from 'vitest';

import {
    listUiFeatureToggleDefinitions,
    resolveUiFeatureToggleEnabled,
} from './uiFeatureToggles';
import type { FeatureId } from '@happier-dev/protocol';

const promotedFeatureIds = [
    // Graduated with the Workflows destination (FIN 04 §3.1): the switch governs triggers.
    'automations',
    'files.reviewComments',
    'files.syntaxHighlighting.advanced',
    'scm.writeOperations',
    'sessions.direct',
    'sessions.folders',
    'terminal.embeddedPty',
    // Voice Experience (plan r1 VE-04/VE-06): the composer mark, presence and "Set up voice" are the
    // product's Voice entry; the Settings → Features switch remains the person's own off switch.
    'voice',
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
                experiments: false,
                featureToggles: {},
            }, featureId)).toBe(true);
        }
    });

    it('preserves an explicit Voice off choice over its standard default', () => {
        expect(resolveUiFeatureToggleEnabled({
            experiments: false,
            featureToggles: { voice: false },
        }, 'voice')).toBe(false);
    });

    it('preserves an explicit source-control read-only choice over its standard default', () => {
        expect(resolveUiFeatureToggleEnabled({
            experiments: false,
            featureToggles: { 'scm.writeOperations': false },
        }, 'scm.writeOperations')).toBe(false);
    });
});
