import { describe, expect, it } from 'vitest';

import { isSessionGoalEditingAvailable } from './sessionGoalEditingAvailability';

describe('isSessionGoalEditingAvailable', () => {
    it('requires both provider support and the Codex app-server goals feature gate', () => {
        expect(isSessionGoalEditingAvailable({
            providerSupportsEditableGoals: true,
            goalsFeatureEnabled: true,
        })).toBe(true);

        expect(isSessionGoalEditingAvailable({
            providerSupportsEditableGoals: true,
            goalsFeatureEnabled: false,
        })).toBe(false);

        expect(isSessionGoalEditingAvailable({
            providerSupportsEditableGoals: false,
            goalsFeatureEnabled: true,
        })).toBe(false);
    });
});
