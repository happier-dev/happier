import { describe, expect, it } from 'vitest';

import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';
import { settingsDefaults } from '@/sync/domains/settings/settings';

/**
 * `files.markdownRichEditor` graduated (2026-11-08): Docs and Markdown fields open in the rich editor.
 * Its registry entry is asserted with the other promoted features
 * (`uiFeatureRegistry.promotedFeatures.test.ts`); this file covers the local-policy resolver that the
 * feature decision reads.
 */
describe('featureLocalPolicy files.markdownRichEditor', () => {
    it('is enabled with default settings, without the experiments switch', () => {
        expect(resolveLocalFeaturePolicyEnabled('files.markdownRichEditor', {
            ...settingsDefaults,
            experiments: false,
            featureToggles: {},
        })).toBe(true);
    });

    it('keeps a person’s explicit off choice', () => {
        expect(resolveLocalFeaturePolicyEnabled('files.markdownRichEditor', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: { 'files.markdownRichEditor': false },
        })).toBe(false);
    });
});
