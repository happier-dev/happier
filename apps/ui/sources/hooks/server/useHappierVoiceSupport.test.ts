import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { useHappierVoiceSupport } from './useHappierVoiceSupport';

import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('useHappierVoiceSupport', () => {
    it('returns true when voice is enabled', async () => {
        await stubServerFeaturesFetch({ voiceEnabled: true });

        const storage = getStorage();
        storage.getState().applySettingsLocal({
            experiments: true,
            featureToggles: { voice: true },
        });

        resetServerFeaturesClientForTests();
        await getServerFeaturesSnapshot({ force: true });

        const hook = await renderHook(() => useHappierVoiceSupport(), {
            flushOptions: { cycles: 6, turns: 2 },
        });

        expect(hook.getCurrent()).toBe(true);
        await hook.unmount();
    });

    it('returns false when voice is enabled but Happier Voice is disabled', async () => {
        await stubServerFeaturesFetch({ voiceEnabled: true, happierVoiceEnabled: false });

        resetServerFeaturesClientForTests();

        const hook = await renderHook(() => useHappierVoiceSupport(), {
            flushOptions: { cycles: 6, turns: 2 },
        });

        expect(hook.getCurrent()).toBe(false);
        await hook.unmount();
    });

    it('returns false when voice is disabled', async () => {
        await stubServerFeaturesFetch({ voiceEnabled: false });

        resetServerFeaturesClientForTests();

        const hook = await renderHook(() => useHappierVoiceSupport(), {
            flushOptions: { cycles: 6, turns: 2 },
        });

        expect(hook.getCurrent()).toBe(false);
        await hook.unmount();
    });

    it('fails closed when the request fails', async () => {
        await stubServerFeaturesFetchFailure();

        resetServerFeaturesClientForTests();

        const hook = await renderHook(() => useHappierVoiceSupport(), {
            flushOptions: { cycles: 6, turns: 2 },
        });

        expect(hook.getCurrent()).toBe(false);
        await hook.unmount();
    });
});
