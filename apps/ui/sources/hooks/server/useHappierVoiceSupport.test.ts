import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';

import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useHappierVoiceSupport', () => {
    it('returns true when voice is enabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ voiceEnabled: true });

        const { getStorage } = await import('@/sync/domains/state/storage');
        const storage = getStorage();
        storage.getState().applySettingsLocal({
            experiments: true,
            featureToggles: { voice: true },
        });

        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const { useHappierVoiceSupport } = await import('./useHappierVoiceSupport');
        const { useFeatureDecision } = await import('./useFeatureDecision');

        const hook = await renderHook(() => ({
            value: useHappierVoiceSupport(),
            decision: useFeatureDecision('voice.happierVoice'),
        }), {
            flushOptions: { cycles: 6, turns: 2 },
        });

        expect(hook.getCurrent().decision?.blockedBy).toBe(null);
        expect(hook.getCurrent().decision?.blockerCode).toBe('none');
        expect(hook.getCurrent().decision?.state).toBe('enabled');
        expect(hook.getCurrent().value).toBe(true);
        await hook.unmount();
    });

    it('returns false when voice is enabled but Happier Voice is disabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ voiceEnabled: true, happierVoiceEnabled: false });

        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const { useHappierVoiceSupport } = await import('./useHappierVoiceSupport');
        const hook = await renderHook(() => useHappierVoiceSupport(), {
            flushOptions: { cycles: 6, turns: 2 },
        });

        expect(hook.getCurrent()).toBe(false);
        await hook.unmount();
    });

    it('returns false when voice is disabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ voiceEnabled: false });

        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const { useHappierVoiceSupport } = await import('./useHappierVoiceSupport');
        const hook = await renderHook(() => useHappierVoiceSupport(), {
            flushOptions: { cycles: 6, turns: 2 },
        });

        expect(hook.getCurrent()).toBe(false);
        await hook.unmount();
    });

    it('fails closed when the request fails', async () => {
        vi.resetModules();
        stubServerFeaturesFetchFailure();

        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const { useHappierVoiceSupport } = await import('./useHappierVoiceSupport');
        const hook = await renderHook(() => useHappierVoiceSupport(), {
            flushOptions: { cycles: 6, turns: 2 },
        });

        expect(hook.getCurrent()).toBe(false);
        await hook.unmount();
    });
});
