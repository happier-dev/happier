import { describe, expect, it } from 'vitest';

import { resolveSessionTagChipColors, resolveSessionTagColorRole } from './sessionTagColors';

describe('resolveSessionTagColorRole', () => {
    it('assigns each tag a stable muted color role', () => {
        expect(resolveSessionTagColorRole('focus')).toBe(resolveSessionTagColorRole('focus'));
        expect(resolveSessionTagColorRole('focus')).not.toBe('neutral');
        expect(new Set(['focus', 'later', 'urgent', 'review'].map(resolveSessionTagColorRole)).size).toBeGreaterThan(1);
    });

    it('keeps overflow chips neutral', () => {
        expect(resolveSessionTagColorRole('+2', true)).toBe('neutral');
    });

    it('gives distinct tag labels distinct muted dark colors', () => {
        const backgrounds = ['Phone Farming', 'Outlandish', 'Happier', 'Hermes']
            .map((label) => resolveSessionTagChipColors(label, false, true).backgroundColor);

        expect(new Set(backgrounds)).toHaveLength(4);
    });
});
