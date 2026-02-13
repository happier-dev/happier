import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubServerFeaturesFetch } from './serverFeaturesTestUtils';
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
        getStorage().getState().applySettingsLocal({ experiments: false, expInboxFriends: true });

        const { useFeatureEnabled } = await import('./useFeatureEnabled');
        const seen = await renderHookAndCollectValues(() => useFeatureEnabled('inbox.friends'));

        expect(seen.at(-1)).toBe(false);
    });
});
