import { describe, expect, it } from 'vitest';

import { resolveLocalFeaturePolicyEnabled } from './featureLocalPolicy';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { FeatureId } from '@happier-dev/protocol';

describe('featureLocalPolicy', () => {
    it('disables connected.services when build-time env is falsy', () => {
        const envBackup = process.env.EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED;
        try {
            process.env.EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED = '0';
            expect(resolveLocalFeaturePolicyEnabled('connected.services', {
                ...settingsDefaults,
                experiments: true,
                featureToggles: {},
            })).toBe(false);
        } finally {
            if (typeof envBackup === 'string') {
                process.env.EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED = envBackup;
            } else {
                const env = process.env as Record<string, string | undefined>;
                delete env.EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED;
            }
        }
    });

    it('fails closed for connected.services.quotas when build-time env is missing', () => {
        const envBackup = process.env.EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED;
        try {
            const env = process.env as Record<string, string | undefined>;
            delete env.EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED;
            expect(resolveLocalFeaturePolicyEnabled('connected.services.quotas', {
                ...settingsDefaults,
                experiments: true,
                featureToggles: {},
            })).toBe(false);
        } finally {
            if (typeof envBackup === 'string') {
                process.env.EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED = envBackup;
            } else {
                const env = process.env as Record<string, string | undefined>;
                delete env.EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED;
            }
        }
    });

    it('enables connected.services.quotas when build-time env is truthy', () => {
        const envBackup = process.env.EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED;
        try {
            process.env.EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED = '1';
            expect(resolveLocalFeaturePolicyEnabled('connected.services.quotas', {
                ...settingsDefaults,
                experiments: true,
                featureToggles: {},
            })).toBe(true);
        } finally {
            if (typeof envBackup === 'string') {
                process.env.EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED = envBackup;
            } else {
                const env = process.env as Record<string, string | undefined>;
                delete env.EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED;
            }
        }
    });

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

    it('does not throw when passed an unknown feature id at runtime', () => {
        expect(() => resolveLocalFeaturePolicyEnabled('unknown.feature' as unknown as FeatureId, {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).not.toThrow();
    });
});
