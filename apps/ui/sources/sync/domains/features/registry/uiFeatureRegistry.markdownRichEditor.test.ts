import { describe, expect, it } from 'vitest';

import {
    listUiFeatureToggleDefinitions,
    resolveUiFeatureToggleEnabled,
} from '@/sync/domains/features/featureRegistry';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';
import { settingsDefaults } from '@/sync/domains/settings/settings';

/**
 * Lane T / T4: the `files.markdownRichEditor` rollout flag (S2 / D7) is an
 * EXPERIMENTAL, default-OFF UI feature gated behind the experiments master
 * switch. The protocol catalog side (representation + dependencies +
 * fail-closed) is asserted in `packages/protocol/src/features/catalog.test.ts`;
 * this file covers the UI side the plan requires: the registry registration and
 * the local-policy resolver. Without an explicit resolver the feature would be
 * always-on (R8), so we assert the resolver is wired AND that it respects the
 * experiments switch + explicit overrides.
 */
describe('UI markdown rich editor feature registry', () => {
    it('registers files.markdownRichEditor as an experimental, default-off settings toggle', () => {
        const definition = listUiFeatureToggleDefinitions().find((entry) => (
            entry.featureId === 'files.markdownRichEditor'
        ));

        expect(definition).toMatchObject({
            featureId: 'files.markdownRichEditor',
            isExperimental: true,
            defaultEnabled: false,
        });
    });

    it('keeps files.markdownRichEditor disabled by default even when experiments are on', () => {
        expect(resolveUiFeatureToggleEnabled({
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        }, 'files.markdownRichEditor')).toBe(false);
    });

    it('stays disabled when experiments are off regardless of the toggle map', () => {
        // Experimental features require the master experiments switch; an
        // explicit toggle without experiments must not enable it.
        expect(resolveUiFeatureToggleEnabled({
            ...settingsDefaults,
            experiments: false,
            featureToggles: { 'files.markdownRichEditor': true },
        }, 'files.markdownRichEditor')).toBe(false);
    });

    it('enables files.markdownRichEditor when experiments are on and it is explicitly toggled on', () => {
        expect(resolveUiFeatureToggleEnabled({
            ...settingsDefaults,
            experiments: true,
            featureToggles: { 'files.markdownRichEditor': true },
        }, 'files.markdownRichEditor')).toBe(true);
    });
});

describe('featureLocalPolicy files.markdownRichEditor', () => {
    it('routes files.markdownRichEditor through an explicit local-policy resolver (not always-on)', () => {
        // A missing resolver would default the feature to always-enabled (R8).
        // With experiments off the resolver must report disabled.
        expect(resolveLocalFeaturePolicyEnabled('files.markdownRichEditor', {
            ...settingsDefaults,
            experiments: false,
            featureToggles: {},
        })).toBe(false);
    });

    it('keeps files.markdownRichEditor disabled by default when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('files.markdownRichEditor', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(false);
    });

    it('enables files.markdownRichEditor when experiments are on and it is explicitly enabled', () => {
        expect(resolveLocalFeaturePolicyEnabled('files.markdownRichEditor', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: { 'files.markdownRichEditor': true },
        })).toBe(true);
    });
});
