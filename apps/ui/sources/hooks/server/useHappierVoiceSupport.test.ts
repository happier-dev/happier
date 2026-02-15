import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

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
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(seen.at(-1)).toBe(true);
    });

    it('returns false when voice is disabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ voiceEnabled: false });

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
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(seen.at(-1)).toBe(false);
    });

    it('fails closed when the request fails', async () => {
        vi.resetModules();
        stubServerFeaturesFetchFailure();

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
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(seen.at(-1)).toBe(false);
    });
});
