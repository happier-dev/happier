import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useFeatureDetails', () => {
    it('returns selected server details when features are ready', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ automationsEnabled: true, automationsExistingSessionTarget: true });

        const { useFeatureDetails } = await import('./useFeatureDetails');
        const seen = await renderHookAndCollectValues(() =>
            useFeatureDetails({
                fallback: false,
                select: (features) => features.features.automations.existingSessionTarget === true,
            }),
        );

        expect(seen.at(-1)).toBe(true);
    });

    it('returns fallback when feature probing fails', async () => {
        vi.resetModules();
        stubServerFeaturesFetchFailure();

        const { useFeatureDetails } = await import('./useFeatureDetails');
        const seen = await renderHookAndCollectValues(() =>
            useFeatureDetails({
                fallback: false,
                select: () => true,
            }),
        );

        expect(seen.at(-1)).toBe(false);
    });
});
