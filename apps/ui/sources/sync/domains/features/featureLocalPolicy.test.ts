import { describe, expect, it } from 'vitest';

import { resolveLocalFeaturePolicyEnabled } from './featureLocalPolicy';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { FeatureId } from '@happier-dev/protocol';

describe('featureLocalPolicy', () => {
    it('does not let a persisted retired channel bridge toggle decide local availability', () => {
        // Account settings from a predecessor can contain a retired feature identifier.
        expect(resolveLocalFeaturePolicyEnabled('channelBridges' as unknown as FeatureId, {
            ...settingsDefaults,
            experiments: true,
            featureToggles: { channelBridges: false },
        })).toBe(true);
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

    it('does not hard-disable native terminal renderer gates when the TERM foundation is eligible', () => {
        const settings = {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {},
        };

        expect(resolveLocalFeaturePolicyEnabled('terminal.renderer.native', settings)).toBe(true);
        expect(resolveLocalFeaturePolicyEnabled('terminal.renderer.iosGhostty', settings)).toBe(true);
        expect(resolveLocalFeaturePolicyEnabled('terminal.renderer.androidTermux', settings)).toBe(true);
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

    it('defers browser.automation to the server decision and keeps the finer eval tiers fail-closed', () => {
        // §13.4: browser.automation is server-represented + default-ALLOW. The UI local policy must
        // NOT force it closed (that would override the now-ON server bit, since a server-represented
        // decision combines `localPolicyEnabled && serverEnabled`). It defers via the unlisted-id
        // fallback (returns true). The finer injectedPage/eval tiers stay client + fail-closed.
        const settings = { ...settingsDefaults, experiments: true, featureToggles: {} };
        expect(resolveLocalFeaturePolicyEnabled('browser.automation', settings)).toBe(true);
        expect(resolveLocalFeaturePolicyEnabled('browser.automation.injectedPage', settings)).toBe(false);
        expect(resolveLocalFeaturePolicyEnabled('browser.automation.eval', settings)).toBe(false);
    });

    it('defers server-represented plugin UI tiers to the server decision and keeps dev hot reload fail-closed', () => {
        // §4.1/§13.5.3: hostedWeb / reactNativeBundles are
        // server-represented + default-ALLOW kill-switches. The UI local policy must NOT force them
        // closed (that would override the now-ON server bit, since a server-represented decision
        // combines `localPolicyEnabled && serverEnabled`). They defer via the unlisted-id fallback
        // (returns true). Per-plugin install/enable/trust/runtime derivation (5.1/5.2) still governs
        // actual render. The finer dev-only hot-reload tier stays client + fail-closed.
        const settings = { ...settingsDefaults, experiments: true, featureToggles: {} };
        expect(resolveLocalFeaturePolicyEnabled('plugins.ui.hostedWeb', settings)).toBe(true);
        expect(resolveLocalFeaturePolicyEnabled('plugins.ui.reactNativeBundles', settings)).toBe(true);
        expect(resolveLocalFeaturePolicyEnabled('plugins.ui.reactNativeBundles.devHotReload', settings)).toBe(false);
    });

    it('resolves the client fail-closed browser/plugin opt-in tiers from a REAL env flag (never a hardcoded false)', () => {
        // A6 / PATCH-04: the injectedPage/eval/devHotReload tiers are fail-closed but the opt-in must
        // genuinely exist (mirror the CLI featureLocalPolicy env opt-in). With the env flag set the
        // resolver returns true — proving the value comes from env, not a dead `() => false` constant.
        const settings = { ...settingsDefaults, experiments: true, featureToggles: {} };
        const env = process.env as Record<string, string | undefined>;
        const keys = [
            'EXPO_PUBLIC_HAPPIER_FEATURE_BROWSER_AUTOMATION_INJECTED_PAGE__ENABLED',
            'EXPO_PUBLIC_HAPPIER_FEATURE_BROWSER_AUTOMATION_EVAL__ENABLED',
            'EXPO_PUBLIC_HAPPIER_FEATURE_PLUGINS_UI_REACT_NATIVE_BUNDLES_DEV_HOT_RELOAD__ENABLED',
        ] as const;
        const backup = keys.map((key) => [key, env[key]] as const);
        try {
            for (const key of keys) env[key] = '1';
            expect(resolveLocalFeaturePolicyEnabled('browser.automation.injectedPage', settings)).toBe(true);
            expect(resolveLocalFeaturePolicyEnabled('browser.automation.eval', settings)).toBe(true);
            expect(resolveLocalFeaturePolicyEnabled('plugins.ui.reactNativeBundles.devHotReload', settings)).toBe(true);
        } finally {
            for (const [key, value] of backup) {
                if (typeof value === 'string') env[key] = value; else delete env[key];
            }
        }
    });

    it('defers devices.simulatorPreview to the server decision', () => {
        // §4.1: devices.simulatorPreview is server-represented + default-ALLOW (viewing your own
        // simulator). The UI local policy defers to the server bit via the unlisted-id fallback.
        const settings = { ...settingsDefaults, experiments: true, featureToggles: {} };
        expect(resolveLocalFeaturePolicyEnabled('devices.simulatorPreview', settings)).toBe(true);
    });
});
