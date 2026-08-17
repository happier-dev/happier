import { describe, expect, it } from 'vitest';

import { AuthErrorCodeSchema } from './errors';

describe('AuthErrorCodeSchema', () => {
    it('recognizes the server signup policy error', () => {
        expect(AuthErrorCodeSchema.parse('signup-disabled')).toBe('signup-disabled');
    });

    it('rejects unknown auth error codes', () => {
        expect(AuthErrorCodeSchema.safeParse('signup-disable').success).toBe(false);
    });
});
