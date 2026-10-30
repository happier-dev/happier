import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { useHappierVoiceSupport } from './useHappierVoiceSupport';

import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
import { resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import type { Settings } from '@/sync/domains/settings/settings';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let originalSettings: Settings;
beforeEach(() => {
    originalSettings = getStorage().getState().settings;
    getStorage().getState().applySettingsLocal({ experiments: true, featureToggles: { voice: true, 'voice.happierVoice': true } });
    resetServerFeaturesClientForTests();
});
afterEach(() => {
    standardCleanup();
    getStorage().setState({ settings: originalSettings });
    resetServerFeaturesClientForTests();
    resetRuntimeFetch();
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

        expect(await getServerFeaturesSnapshot({ force: true })).toMatchObject({ status: 'ready',
            features: { features: { voice: { enabled: true, happierVoice: { enabled: false } } } } });

        const hook = await renderHook(() => useHappierVoiceSupport(), {
            flushOptions: { cycles: 6, turns: 2 },
        });

        expect(hook.getCurrent()).toBe(false);
        await hook.unmount();
    });

    it('returns false when voice is disabled', async () => {
        await stubServerFeaturesFetch({ voiceEnabled: false, happierVoiceEnabled: true });

        resetServerFeaturesClientForTests();

        expect(await getServerFeaturesSnapshot({ force: true })).toMatchObject({ status: 'ready',
            features: { features: { voice: { enabled: false, happierVoice: { enabled: true } } } } });

        const hook = await renderHook(() => useHappierVoiceSupport(), {
            flushOptions: { cycles: 6, turns: 2 },
        });

        expect(hook.getCurrent()).toBe(false);
        await hook.unmount();
    });

    it('fails closed when the request fails', async () => {
        await stubServerFeaturesFetchFailure();

        resetServerFeaturesClientForTests();

        expect(await getServerFeaturesSnapshot({ force: true })).toMatchObject({ status: 'error' });
        expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).includes('/v1/features'))).toBe(true);

        const hook = await renderHook(() => useHappierVoiceSupport(), {
            flushOptions: { cycles: 6, turns: 2 },
        });

        expect(hook.getCurrent()).toBe(false);
        await hook.unmount();
    });
});
