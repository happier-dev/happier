import { describe, expect, it } from 'vitest';

import { normalizeLoadedNativeBundleRevision } from './loadedNativeBundleRevision';

describe('normalizeLoadedNativeBundleRevision', () => {
    it('accepts only the canonical immutable mobile-row revision', () => {
        expect(normalizeLoadedNativeBundleRevision(
            'mobile-row:123e4567-e89b-42d3-a456-426614174000',
        )).toBe('mobile-row:123e4567-e89b-42d3-a456-426614174000');
        expect(normalizeLoadedNativeBundleRevision('sha256:host-only')).toBeNull();
        expect(normalizeLoadedNativeBundleRevision('mobile-row:not-a-uuid')).toBeNull();
        expect(normalizeLoadedNativeBundleRevision(null)).toBeNull();
    });
});
