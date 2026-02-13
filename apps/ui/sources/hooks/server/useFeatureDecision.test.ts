import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useFeatureDecision', () => {
    it('returns enabled decision when the feature is available', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ voiceEnabled: true });

        const { useFeatureDecision } = await import('./useFeatureDecision');
        const seen = await renderHookAndCollectValues(() => useFeatureDecision('voice'));

        expect(seen.at(-1)?.state).toBe('enabled');
        expect(seen.at(-1)?.blockedBy).toBeNull();
    });

    it('returns unsupported when the features endpoint is missing', async () => {
        vi.resetModules();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 404,
                json: async () => ({}),
            })) as any,
        );

        const { useFeatureDecision } = await import('./useFeatureDecision');
        const seen = await renderHookAndCollectValues(() => useFeatureDecision('voice'));

        expect(seen.at(-1)?.state).toBe('unsupported');
        expect(seen.at(-1)?.blockerCode).toBe('endpoint_missing');
    });

    it('returns unknown when probing features fails', async () => {
        vi.resetModules();
        stubServerFeaturesFetchFailure();

        const { useFeatureDecision } = await import('./useFeatureDecision');
        const seen = await renderHookAndCollectValues(() => useFeatureDecision('voice'));

        expect(seen.at(-1)?.state).toBe('unknown');
        expect(seen.at(-1)?.blockerCode).toBe('probe_failed');
    });
});
