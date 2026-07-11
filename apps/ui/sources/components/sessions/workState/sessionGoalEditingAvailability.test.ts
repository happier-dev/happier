import { describe, expect, it } from 'vitest';

import { isSessionGoalEditingAvailable } from './sessionGoalEditingAvailability';

describe('isSessionGoalEditingAvailable', () => {
    it('requires provider support, the goals feature gate, AND write access', () => {
        expect(isSessionGoalEditingAvailable({
            providerSupportsEditableGoals: true,
            goalsFeatureEnabled: true,
            hasWriteAccess: true,
        })).toBe(true);

        expect(isSessionGoalEditingAvailable({
            providerSupportsEditableGoals: true,
            goalsFeatureEnabled: false,
            hasWriteAccess: true,
        })).toBe(false);

        expect(isSessionGoalEditingAvailable({
            providerSupportsEditableGoals: false,
            goalsFeatureEnabled: true,
            hasWriteAccess: true,
        })).toBe(false);
    });

    it('denies goal editing in a read-only (view-only) session even when provider+feature support it (G5/D4)', () => {
        expect(isSessionGoalEditingAvailable({
            providerSupportsEditableGoals: true,
            goalsFeatureEnabled: true,
            hasWriteAccess: false,
        })).toBe(false);
    });
});
