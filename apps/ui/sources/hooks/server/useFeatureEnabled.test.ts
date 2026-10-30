import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { useFeatureEnabled } from './useFeatureEnabled';

import { buildServerFeaturesResponse, stubServerFeaturesFetch } from './serverFeaturesTestUtils';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let restoreSettings: (() => void) | undefined;
beforeEach(() => {
    const settings = getStorage().getState().settings;
    restoreSettings = () => getStorage().setState({ settings });
    resetServerFeaturesClientForTests();
    resetRuntimeFetch();
});

afterEach(() => {
    standardCleanup();
    restoreSettings?.();
    restoreSettings = undefined;
    resetServerFeaturesClientForTests();
    resetRuntimeFetch();
    vi.unstubAllGlobals();
});

describe('useFeatureEnabled', () => {
    it('returns true when a feature is enabled', async () => {
        await stubServerFeaturesFetch({ voiceEnabled: true });
        getStorage().getState().applySettingsLocal({ experiments: true, featureToggles: { voice: true } });
        await getServerFeaturesSnapshot({ force: true });
        const seen = await renderHookAndCollectValues(() => useFeatureEnabled('voice'));

        expect(seen.at(-1)).toBe(true);
    });

    it('does not probe server features for local-only features', async () => {

        const fetchMock = vi.fn(async () => ({
            ok: false,
            status: 404,
            json: async () => ({}),
        }));
        vi.stubGlobal('fetch', fetchMock as any);

        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'zen.navigation': true },
        });

        const seen = await renderHookAndCollectValues(() => useFeatureEnabled('zen.navigation'));

        expect(seen.at(-1)).toBe(true);
        expect(fetchMock.mock.calls.some((call) => String((call as unknown[])[0] ?? '').endsWith('/v1/features'))).toBe(false);
    });

    it('keeps usage reporting enabled without requiring experimental settings', async () => {

        const fetchMock = vi.fn(async () => ({
            ok: false,
            status: 404,
            json: async () => ({}),
        }));
        vi.stubGlobal('fetch', fetchMock as any);

        getStorage().getState().applySettingsLocal({
            experiments: false,
            featureToggles: {},
        });

        const seen = await renderHookAndCollectValues(() => useFeatureEnabled('usage.reporting'));

        expect(seen.at(-1)).toBe(true);
        expect(fetchMock.mock.calls.some((call) => String((call as unknown[])[0] ?? '').endsWith('/v1/features'))).toBe(false);
    });

    it('does not probe server features when build policy denies a server-required feature', async () => {

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
            const seen = await renderHookAndCollectValues(() => useFeatureEnabled('voice'));

            expect(seen.at(-1)).toBe(false);
            expect(fetchMock.mock.calls.some((call) => String((call as unknown[])[0] ?? '').endsWith('/v1/features'))).toBe(false);
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('fails closed when the features endpoint is missing', async () => {
        await stubServerFeaturesFetch({ voiceEnabled: true });
        getStorage().getState().applySettingsLocal({ experiments: true, featureToggles: { voice: true } });
        const request = vi.fn(async () => new Response('{}', { status: 404 }));
        setRuntimeFetch(request);
        vi.stubGlobal('fetch', request);
        resetServerFeaturesClientForTests();
        expect(await getServerFeaturesSnapshot({ force: true })).toMatchObject({ status: 'unsupported' });
        expect(request.mock.calls.some(call => String((call as unknown[])[0]).includes('/v1/features'))).toBe(true);

        const seen = await renderHookAndCollectValues(() => useFeatureEnabled('voice'));

        expect(seen.at(-1)).toBe(false);
    });

    it('applies local policy before server support', async () => {
        await stubServerFeaturesFetch({ friendsEnabled: true });
        getStorage().getState().applySettingsLocal({
            experiments: false,
            featureToggles: { 'social.friends': true },
        });

        const seen = await renderHookAndCollectValues(() => useFeatureEnabled('social.friends'));

        expect(seen.at(-1)).toBe(false);
    });

});
