import { describe, expect, it } from 'vitest';

import { resolveLocalFeaturePolicyEnabled } from './featureLocalPolicy';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { FeatureId } from '@happier-dev/protocol';

describe('featureLocalPolicy', () => {
    it('disables connectedServices when build-time env is falsy', () => {
        const envBackup = process.env.EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED;
        try {
            process.env.EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED = '0';
            expect(resolveLocalFeaturePolicyEnabled('connectedServices', {
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

    it('disables connectedServices by default when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('connectedServices', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(false);
    });

    it('disables connectedServices.quotas by default when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('connectedServices.quotas', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(false);
    });

    it('disables app.ui.liveActivities by default when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('app.ui.liveActivities', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(false);
    });

    it('enables app.ui.liveActivities when explicitly enabled', () => {
        expect(resolveLocalFeaturePolicyEnabled('app.ui.liveActivities', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: { 'app.ui.liveActivities': true },
        })).toBe(true);
    });

    it('disables app.ui.homeScreenWidgets by default when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('app.ui.homeScreenWidgets', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(false);
    });

    it('enables app.ui.homeScreenWidgets when explicitly enabled', () => {
        expect(resolveLocalFeaturePolicyEnabled('app.ui.homeScreenWidgets', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: { 'app.ui.homeScreenWidgets': true },
        })).toBe(true);
    });

    it('enables connectedServices.quotas when explicitly enabled', () => {
        expect(resolveLocalFeaturePolicyEnabled('connectedServices.quotas', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: { 'connectedServices.quotas': true },
        })).toBe(true);
    });

    it('disables memory.search by default when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('memory.search', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(false);
    });

    it('disables terminal.embeddedPty by default when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('terminal.embeddedPty', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(false);
    });

    it('enables terminal.embeddedPty when explicitly enabled', () => {
        expect(resolveLocalFeaturePolicyEnabled('terminal.embeddedPty', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: { 'terminal.embeddedPty': true },
        })).toBe(true);
    });

    it('enables memory.search when explicitly enabled', () => {
        expect(resolveLocalFeaturePolicyEnabled('memory.search', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: { 'memory.search': true },
        })).toBe(true);
    });

    it('disables voice.agent by default when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('voice.agent', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(false);
    });

    it('disables attachments.uploads by default when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('attachments.uploads', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(false);
    });

    it('enables attachments.uploads when explicitly enabled', () => {
        expect(resolveLocalFeaturePolicyEnabled('attachments.uploads', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: { 'attachments.uploads': true },
        })).toBe(true);
    });

    it('enables voice.agent when explicitly enabled', () => {
        expect(resolveLocalFeaturePolicyEnabled('voice.agent', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: { 'voice.agent': true },
        })).toBe(true);
    });

    it('disables voice.daemonInference by default when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('voice.daemonInference', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(false);
    });

    it('enables voice.daemonInference when explicitly enabled', () => {
        expect(resolveLocalFeaturePolicyEnabled('voice.daemonInference', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: { 'voice.daemonInference': true },
        })).toBe(true);
    });

    it('enables automations by default when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('automations', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(true);
    });

    it('enables sessions.direct by default even when experiments are off', () => {
        expect(resolveLocalFeaturePolicyEnabled('sessions.direct', {
            ...settingsDefaults,
            experiments: false,
            featureToggles: {},
        })).toBe(true);
    });

    it('enables sessions.folders by default even when experiments are off', () => {
        expect(resolveLocalFeaturePolicyEnabled('sessions.folders', {
            ...settingsDefaults,
            experiments: false,
            featureToggles: {},
        })).toBe(true);
    });

    it('keeps pets.companion disabled by default even when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('pets.companion', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(false);
    });

    it('enables pets.companion when explicitly enabled', () => {
        expect(resolveLocalFeaturePolicyEnabled('pets.companion', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: { 'pets.companion': true },
        })).toBe(true);
    });

    it('enables sessions.direct when explicitly enabled', () => {
        expect(resolveLocalFeaturePolicyEnabled('sessions.direct', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: { 'sessions.direct': true },
        })).toBe(true);
    });

    it('enables sessions.folders when explicitly enabled', () => {
        expect(resolveLocalFeaturePolicyEnabled('sessions.folders', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: { 'sessions.folders': true },
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

    it('defaults file review comments and the file editor to enabled even when experiments are off', () => {
        expect(resolveLocalFeaturePolicyEnabled('files.reviewComments', {
            ...settingsDefaults,
            experiments: false,
            featureToggles: {},
        })).toBe(true);

        expect(resolveLocalFeaturePolicyEnabled('files.editor', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(true);

        expect(resolveLocalFeaturePolicyEnabled('files.editor', {
            ...settingsDefaults,
            experiments: false,
            featureToggles: {},
        })).toBe(true);
    });

    it('enables advanced syntax highlighting by default even when experiments are off', () => {
        expect(resolveLocalFeaturePolicyEnabled('files.syntaxHighlighting.advanced', {
            ...settingsDefaults,
            experiments: false,
            featureToggles: {},
        })).toBe(true);
    });

    it('defaults files.diffSyntaxHighlighting to enabled when experiments are on', () => {
        expect(resolveLocalFeaturePolicyEnabled('files.diffSyntaxHighlighting', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).toBe(true);
    });

    it('defaults files.diffSyntaxHighlighting to enabled when experiments are off', () => {
        expect(resolveLocalFeaturePolicyEnabled('files.diffSyntaxHighlighting', {
            ...settingsDefaults,
            experiments: false,
            featureToggles: {},
        })).toBe(true);
    });

    it('allows disabling voice via local feature toggles', () => {
        expect(resolveLocalFeaturePolicyEnabled('voice', {
            ...settingsDefaults,
            experiments: true,
            featureToggles: { voice: false },
        })).toBe(false);
    });

    it('does not throw when passed an unknown feature id at runtime', () => {
        expect(() => resolveLocalFeaturePolicyEnabled('unknown.feature' as unknown as FeatureId, {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        })).not.toThrow();
    });
});
