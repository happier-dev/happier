import { describe, expect, it } from 'vitest';

import { isUserFacingSession } from './isUserFacingSession';

describe('isUserFacingSession', () => {
    it('excludes hidden system sessions', () => {
        expect(isUserFacingSession({
            metadata: { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
        })).toBe(false);
    });

    it('excludes projected hidden system session rows', () => {
        expect(isUserFacingSession({
            metadata: { hiddenSystemSession: true },
        })).toBe(false);
    });

    it('keeps visible system sessions when they are not hidden', () => {
        expect(isUserFacingSession({
            metadata: { systemSessionV1: { v: 1, key: 'diagnostics', hidden: false } },
        })).toBe(true);
    });

    it('keeps ordinary user sessions', () => {
        expect(isUserFacingSession({
            metadata: { summary: { text: 'User-visible work', updatedAt: 1 } },
        })).toBe(true);
    });
});
