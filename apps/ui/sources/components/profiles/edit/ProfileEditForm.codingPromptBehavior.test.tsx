import { describe, expect, it } from 'vitest';

import {
    AIBackendProfileSchema,
    getProfileCodingPromptBehaviorOverride,
    type AIBackendProfile,
} from '@/sync/domains/profiles/profileCompatibility';

function parseProfile(overrides: Partial<AIBackendProfile> = {}): AIBackendProfile {
    return AIBackendProfileSchema.parse({
        id: 'p1',
        name: 'P',
        ...overrides,
    });
}

describe('getProfileCodingPromptBehaviorOverride', () => {
    it('returns null when the profile has no codingPromptBehaviorV1 field', () => {
        expect(getProfileCodingPromptBehaviorOverride(parseProfile())).toBeNull();
    });

    it('returns the full override when both knobs are set', () => {
        const profile = parseProfile({
            codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'initial', responseOptions: 'disabled' },
        });
        expect(getProfileCodingPromptBehaviorOverride(profile)).toEqual({
            v: 1,
            sessionTitleUpdates: 'initial',
            responseOptions: 'disabled',
        });
    });

    it('preserves partial overrides (omit-means-inherit semantics survive parsing)', () => {
        const profile = parseProfile({
            codingPromptBehaviorV1: { v: 1, responseOptions: 'disabled' },
        });
        expect(getProfileCodingPromptBehaviorOverride(profile)).toEqual({
            v: 1,
            responseOptions: 'disabled',
        });
    });

    it('drops a malformed override to a minimal object while keeping the profile valid', () => {
        const profile = parseProfile({
            codingPromptBehaviorV1: { sessionTitleUpdates: 'bogus' } as unknown as AIBackendProfile['codingPromptBehaviorV1'],
        });
        // Malformed override is reduced to { v: 1 } (no knobs set => inherit global for both).
        expect(getProfileCodingPromptBehaviorOverride(profile)).toEqual({ v: 1 });
    });
});
