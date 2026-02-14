import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildServerFeaturesResponse, stubServerFeaturesFetch } from './serverFeaturesTestUtils';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useFeatureEnabled', () => {
    it('returns true when a feature is enabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ voiceEnabled: true });

        const { useFeatureEnabled } = await import('./useFeatureEnabled');
        const seen = await renderHookAndCollectValues(() => useFeatureEnabled('voice'));

        expect(seen.at(-1)).toBe(true);
    });

    it('does not probe server features for local-only features', async () => {
        vi.resetModules();

        const fetchMock = vi.fn(async () => ({
            ok: false,
            status: 404,
            json: async () => ({}),
        }));
        vi.stubGlobal('fetch', fetchMock as any);

        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'zen.navigation': true },
        });

        const { useFeatureEnabled } = await import('./useFeatureEnabled');
        const seen = await renderHookAndCollectValues(() => useFeatureEnabled('zen.navigation'));

        expect(seen.at(-1)).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not probe server features when build policy denies a server-required feature', async () => {
        vi.resetModules();

        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'voice';

        const payload = buildServerFeaturesResponse({ voiceEnabled: true });
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => payload,
        }));
        vi.stubGlobal('fetch', fetchMock as any);

        try {
            const { useFeatureEnabled } = await import('./useFeatureEnabled');
            const seen = await renderHookAndCollectValues(() => useFeatureEnabled('voice'));

            expect(seen.at(-1)).toBe(false);
            expect(fetchMock).not.toHaveBeenCalled();
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('fails closed when the features endpoint is missing', async () => {
        vi.resetModules();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 404,
                json: async () => ({}),
            })) as any,
        );

        const { useFeatureEnabled } = await import('./useFeatureEnabled');
        const seen = await renderHookAndCollectValues(() => useFeatureEnabled('voice'));

        expect(seen.at(-1)).toBe(false);
    });

    it('applies local policy before server support', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ friendsEnabled: true });
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: false,
            featureToggles: { 'social.friends': true },
        });

        const { useFeatureEnabled } = await import('./useFeatureEnabled');
        const seen = await renderHookAndCollectValues(() => useFeatureEnabled('social.friends'));

        expect(seen.at(-1)).toBe(false);
    });
});
