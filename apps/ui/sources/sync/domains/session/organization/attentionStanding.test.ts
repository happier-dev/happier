import { describe, expect, it } from 'vitest';

import {
    resolveSessionAttentionStanding,
    resolveSessionAttentionStandingSource,
    type SessionAttentionStandingPolicy,
} from './attentionStanding';

function policy(overrides?: Partial<SessionAttentionStandingPolicy>): SessionAttentionStandingPolicy {
    return {
        defaultStanding: false,
        overridesBySessionKey: {},
        ...overrides,
    };
}

describe('resolveSessionAttentionStanding', () => {
    it('lets an explicit override win over the account default in both directions', () => {
        expect(resolveSessionAttentionStanding(
            policy({ defaultStanding: false, overridesBySessionKey: { 'server-a:s1': true } }),
            'server-a:s1',
        )).toBe(true);
        expect(resolveSessionAttentionStanding(
            policy({ defaultStanding: true, overridesBySessionKey: { 'server-a:s1': false } }),
            'server-a:s1',
        )).toBe(false);
    });

    it('inherits the account default for a session with no override of its own', () => {
        const overridesBySessionKey = { 'server-a:other': true };

        expect(resolveSessionAttentionStanding(
            policy({ defaultStanding: false, overridesBySessionKey }),
            'server-a:s1',
        )).toBe(false);
        expect(resolveSessionAttentionStanding(
            policy({ defaultStanding: true, overridesBySessionKey }),
            'server-a:s1',
        )).toBe(true);
    });

    it('reports whether standing came from the session override or the account default', () => {
        expect(resolveSessionAttentionStandingSource(
            policy({ defaultStanding: false, overridesBySessionKey: { 'server-a:s1': true } }),
            'server-a:s1',
        )).toBe('override');
        expect(resolveSessionAttentionStandingSource(
            policy({ defaultStanding: true, overridesBySessionKey: {} }),
            'server-a:s1',
        )).toBe('default');
        expect(resolveSessionAttentionStandingSource(
            policy({ defaultStanding: true, overridesBySessionKey: { 'server-a:s1': false } }),
            'server-a:s1',
        )).toBe('none');
        expect(resolveSessionAttentionStandingSource(
            policy({ defaultStanding: false, overridesBySessionKey: {} }),
            'server-a:s1',
        )).toBe('none');
    });
});
