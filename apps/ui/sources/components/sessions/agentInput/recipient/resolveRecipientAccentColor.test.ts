import { describe, expect, it } from 'vitest';

import { lightTheme } from '@/theme';

import { resolveRecipientAccentColor } from './resolveRecipientAccentColor';

describe('resolveRecipientAccentColor', () => {
    it('maps known accent names to theme accents', () => {
        expect(resolveRecipientAccentColor({ theme: lightTheme as any, accentName: 'blue' })).toBe(lightTheme.colors.accent.blue);
        expect(resolveRecipientAccentColor({ theme: lightTheme as any, accentName: 'green' })).toBe(lightTheme.colors.accent.green);
    });

    it('returns undefined for unknown accent names', () => {
        expect(resolveRecipientAccentColor({ theme: lightTheme as any, accentName: 'not-a-color' })).toBeUndefined();
    });
});
