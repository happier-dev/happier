import { describe, expect, it } from 'vitest';

import { normalizeSocketHandshakeClientType } from './socket';

describe('normalizeSocketHandshakeClientType', () => {
    it('preserves supported client types', () => {
        expect(normalizeSocketHandshakeClientType('user-scoped')).toBe('user-scoped');
        expect(normalizeSocketHandshakeClientType('session-scoped')).toBe('session-scoped');
        expect(normalizeSocketHandshakeClientType('machine-scoped')).toBe('machine-scoped');
    });

    it('normalizes missing and unknown handshake client types to user-scoped', () => {
        expect(normalizeSocketHandshakeClientType(undefined)).toBe('user-scoped');
        expect(normalizeSocketHandshakeClientType(null)).toBe('user-scoped');
        expect(normalizeSocketHandshakeClientType('future-scoped')).toBe('user-scoped');
    });
});
