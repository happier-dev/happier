import { describe, expect, it } from 'vitest';

import { isUserFacingSession } from './isUserFacingSession';

describe('isUserFacingSession', () => {
    it('excludes hidden system sessions', () => {
        expect(isUserFacingSession({
            metadata: { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
        })).toBe(false);
    });

    it('keeps Voice transcript history out of ordinary coding-session lists', () => {
        expect(isUserFacingSession({
            metadata: {
                systemSessionV1: {
                    v: 1,
                    key: 'voice_transcript_history',
                    hidden: true,
                },
            },
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

    it('fails unavailable when a layout-v1 row has no owner compatibility view', () => {
        expect(isUserFacingSession({
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                summary: { text: 'Shared title', updatedAt: 1 },
            },
            ownerMetadataView: null,
        })).toBe(false);
    });

    it('keeps layout-v1 participant rows visible from their strict shared projection', () => {
        expect(isUserFacingSession({
            metadataLayoutVersion: 1,
            accessLevel: 'view',
            metadata: {
                v: 1,
                summary: { text: 'Shared title', updatedAt: 1 },
            },
            ownerMetadataView: null,
        })).toBe(true);
    });

    it('reads layout-v1 system visibility from the owner compatibility view', () => {
        expect(isUserFacingSession({
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                systemSessionV1: { v: 1, key: 'injected-visible', hidden: false },
            },
            ownerMetadataView: {
                systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
            },
        })).toBe(false);
    });
});
