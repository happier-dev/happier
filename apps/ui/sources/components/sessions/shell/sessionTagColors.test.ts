import { describe, expect, it } from 'vitest';

import { resolveSessionTagColorRole } from './sessionTagColors';

describe('resolveSessionTagColorRole', () => {
    it('assigns each tag a stable muted color role', () => {
        expect(resolveSessionTagColorRole('focus')).toBe(resolveSessionTagColorRole('focus'));
        expect(resolveSessionTagColorRole('focus')).not.toBe('neutral');
        expect(new Set(['focus', 'later', 'urgent', 'review'].map(resolveSessionTagColorRole)).size).toBeGreaterThan(1);
    });

    it('keeps overflow chips neutral', () => {
        expect(resolveSessionTagColorRole('+2', true)).toBe('neutral');
    });
});
