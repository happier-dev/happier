import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
import { flushHookEffects } from './serverFeatureHookHarness.testHelpers';

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

        const seen: Array<{ value: boolean | null; decision: any }> = [];
        function Test() {
            const value = useHappierVoiceSupport();
            const decision = useFeatureDecision('voice.happierVoice');
            React.useEffect(() => {
                seen.push({ value, decision });
            }, [decision, value]);
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await flushHookEffects(6);
        });

        expect(seen.at(-1)?.decision?.blockedBy).toBe(null);
        expect(seen.at(-1)?.decision?.blockerCode).toBe('none');
        expect(seen.at(-1)?.decision?.state).toBe('enabled');
        expect(seen.at(-1)?.value).toBe(true);
    });

    it('returns false when voice is enabled but Happier Voice is disabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ voiceEnabled: true, happierVoiceEnabled: false });

        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const { useHappierVoiceSupport } = await import('./useHappierVoiceSupport');

        const seen: Array<boolean | null> = [];
        function Test() {
            const value = useHappierVoiceSupport();
            React.useEffect(() => {
                seen.push(value);
            }, [value]);
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await flushHookEffects(6);
        });

        expect(seen.at(-1)).toBe(false);
    });

    it('returns false when voice is disabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ voiceEnabled: false });

        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const { useHappierVoiceSupport } = await import('./useHappierVoiceSupport');

        const seen: Array<boolean | null> = [];
        function Test() {
            const value = useHappierVoiceSupport();
            React.useEffect(() => {
                seen.push(value);
            }, [value]);
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await flushHookEffects(6);
        });

        expect(seen.at(-1)).toBe(false);
    });

    it('fails closed when the request fails', async () => {
        vi.resetModules();
        stubServerFeaturesFetchFailure();

        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const { useHappierVoiceSupport } = await import('./useHappierVoiceSupport');

        const seen: Array<boolean | null> = [];
        function Test() {
            const value = useHappierVoiceSupport();
            React.useEffect(() => {
                seen.push(value);
            }, [value]);
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await flushHookEffects(6);
        });

        expect(seen.at(-1)).toBe(false);
    });
});
