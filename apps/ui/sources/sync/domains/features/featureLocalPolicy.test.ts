import { describe, expect, it } from 'vitest';

import { resolveLocalFeaturePolicyEnabled } from './featureLocalPolicy';
import { settingsDefaults } from '@/sync/domains/settings/settings';

describe('featureLocalPolicy', () => {
    it('enables automations by default when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('automations', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(true);
    });

    it('disables automations when experiments are off', () => {
        expect(resolveLocalFeaturePolicyEnabled('automations', {
            ...settingsDefaults,
            experiments: false,
            featureToggles: { automations: true },
        })).toBe(false);
    });

    it('respects explicit featureToggles overrides', () => {
        expect(resolveLocalFeaturePolicyEnabled('automations', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: { automations: false },
        })).toBe(false);
    });

    it('keeps scm.writeOperations disabled by default even when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('scm.writeOperations', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(false);
    });

    it('defaults files.reviewComments and files.editor to disabled when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('files.reviewComments', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(false);

        expect(resolveLocalFeaturePolicyEnabled('files.editor', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(false);
    });

    it('defaults files.diffSyntaxHighlighting to enabled when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('files.diffSyntaxHighlighting', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(true);
    });
});
