import type { BrowserProfileV1, BrowserViewTargetV1, FeatureDecision } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

async function loadPolicyModule() {
    return import('./evaluate').catch(() => null);
}

const enabledBrowserDecision = {
    featureId: 'browser',
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: 1_000,
    scope: { scopeKind: 'runtime' },
} satisfies FeatureDecision;

const disabledBrowserDecision = {
    ...enabledBrowserDecision,
    state: 'disabled',
    blockedBy: 'client',
    blockerCode: 'feature_disabled',
} satisfies FeatureDecision;

const sessionProfile = {
    profileId: 'profile_1',
    storageMode: 'session',
    owner: { kind: 'session', id: 'session_1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    cleanupOnSessionClose: true,
} satisfies BrowserProfileV1;

const pluginProfile = {
    profileId: 'profile_plugin_1',
    storageMode: 'plugin',
    owner: {
        kind: 'plugin',
        id: 'acme.preview',
        contributionId: 'previewPane',
    },
    createdAt: 1_000,
    updatedAt: 1_000,
    cleanupOnSessionClose: true,
} satisfies BrowserProfileV1;

const externalTarget = {
    kind: 'externalUrl',
    targetId: 'external_1',
    url: 'https://example.com/',
} satisfies BrowserViewTargetV1;

const localPreviewTarget = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
} satisfies BrowserViewTargetV1;

const hostedPluginTarget = {
    kind: 'hostedPluginWeb',
    targetId: 'plugin_preview_1',
    pluginId: 'acme.preview',
    contributionId: 'previewPane',
} satisfies BrowserViewTargetV1;

const simulatorPreviewTarget = {
    kind: 'simulatorPreview',
    targetId: 'simulator_1',
    deviceId: 'device_1',
} satisfies BrowserViewTargetV1;

describe('evaluateBrowserTargetPolicy', () => {
    it('fails closed when the browser feature decision is missing or disabled', async () => {
        const mod = await loadPolicyModule();

        expect(mod).not.toBeNull();
        if (!mod) return;

        expect(mod.evaluateBrowserTargetPolicy({
            target: localPreviewTarget,
            profile: sessionProfile,
            browserFeatureDecision: null,
        })).toMatchObject({
            state: 'unavailable',
            reasonCode: 'feature_disabled',
        });

        expect(mod.evaluateBrowserTargetPolicy({
            target: localPreviewTarget,
            profile: sessionProfile,
            browserFeatureDecision: disabledBrowserDecision,
        })).toMatchObject({
            state: 'unavailable',
            reasonCode: 'feature_disabled',
        });
    });

    it('keeps arbitrary external URLs unavailable unless an explicit policy-backed adapter path is enabled', async () => {
        const mod = await loadPolicyModule();

        expect(mod).not.toBeNull();
        if (!mod) return;

        expect(mod.evaluateBrowserTargetPolicy({
            target: externalTarget,
            profile: sessionProfile,
            browserFeatureDecision: enabledBrowserDecision,
        })).toMatchObject({
            state: 'unavailable',
            reasonCode: 'external_url_disabled',
        });
    });

    it('requires external URL browsing to use an isolated non-plugin browser profile', async () => {
        const mod = await loadPolicyModule();

        expect(mod).not.toBeNull();
        if (!mod) return;

        expect(mod.evaluateBrowserTargetPolicy({
            target: externalTarget,
            profile: pluginProfile,
            browserFeatureDecision: enabledBrowserDecision,
            allowExternalUrlBrowsing: true,
        })).toMatchObject({
            state: 'unavailable',
            reasonCode: 'profile_unusable',
            disabledReasons: ['external_url_profile_not_isolated'],
        });

        expect(mod.evaluateBrowserTargetPolicy({
            target: externalTarget,
            profile: sessionProfile,
            browserFeatureDecision: enabledBrowserDecision,
            allowExternalUrlBrowsing: true,
        })).toMatchObject({
            state: 'allowed',
            profileId: 'profile_1',
            profileMode: 'session',
            disabledReasons: [],
        });
    });

    it('allows local previews without granting downloads, uploads, or popups by default', async () => {
        const mod = await loadPolicyModule();

        expect(mod).not.toBeNull();
        if (!mod) return;

        expect(mod.evaluateBrowserTargetPolicy({
            target: localPreviewTarget,
            profile: sessionProfile,
            browserFeatureDecision: enabledBrowserDecision,
        })).toMatchObject({
            state: 'allowed',
            permissions: {
                downloads: 'deny',
                uploads: 'deny',
                popups: 'deny',
            },
        });
    });

    it('allows simulator preview targets when the browser feature and profile are usable', async () => {
        const mod = await loadPolicyModule();

        expect(mod).not.toBeNull();
        if (!mod) return;

        expect(mod.evaluateBrowserTargetPolicy({
            target: simulatorPreviewTarget,
            profile: sessionProfile,
            browserFeatureDecision: enabledBrowserDecision,
        })).toMatchObject({
            state: 'allowed',
            targetKind: 'simulatorPreview',
            disabledReasons: [],
        });
    });

    it('fails closed when a hosted-plugin target uses a profile scoped to another contribution', async () => {
        const mod = await loadPolicyModule();

        expect(mod).not.toBeNull();
        if (!mod) return;

        expect(mod.evaluateBrowserTargetPolicy({
            target: hostedPluginTarget,
            profile: {
                ...pluginProfile,
                owner: { ...pluginProfile.owner, contributionId: 'otherPane' },
                createdAt: 1_000,
                updatedAt: 1_000,
            },
            browserFeatureDecision: enabledBrowserDecision,
        })).toMatchObject({
            state: 'unavailable',
            reasonCode: 'hosted_plugin_profile_mismatch',
        });
    });
});
