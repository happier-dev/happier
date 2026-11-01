import { describe, expect, it } from 'vitest';
import { ACCENT_COLOR_KEYS } from '@/theme/accentColors';
import { areSessionAppearanceColorsEqual, parseSessionAppearanceColor, resolveEffectiveSessionAppearanceColor, resolveSessionAppearanceColor } from './appearanceColor';
import { mergeWorkspaceDisplay } from './workspaceDisplay';

describe('appearance colours', () => {
    it('reads canonical accents and opaque custom hex while rejecting junk and alpha', () => {
        for (const key of ACCENT_COLOR_KEYS) expect(parseSessionAppearanceColor({ kind: 'accent', key })).toEqual({ kind: 'accent', key });
        expect(parseSessionAppearanceColor({ kind: 'custom', hex: ' #aBc ' })).toEqual({ kind: 'custom', hex: '#AABBCC' });
        for (const value of [null, [], 'blue', { kind: 'accent', key: 'nope' }, { kind: 'custom', hex: '#abcd' }, { kind: 'custom', hex: 'rgb(1,2,3)' }]) expect(parseSessionAppearanceColor(value)).toBeNull();
    });

    it('resolves override, inherit and clear without changing colour identity', () => {
        const sessionColor = { kind: 'accent', key: 'blue' } as const;
        const workspaceColor = { kind: 'custom', hex: '#AABBCC' } as const;
        expect(resolveEffectiveSessionAppearanceColor({ sessionColor, workspaceColor })).toBe(sessionColor);
        expect(resolveEffectiveSessionAppearanceColor({ sessionColor: null, workspaceColor })).toBe(workspaceColor);
        expect(resolveEffectiveSessionAppearanceColor({})).toBeNull();
        expect(areSessionAppearanceColorsEqual(workspaceColor, parseSessionAppearanceColor({ kind: 'custom', hex: '#abc' }))).toBe(true);
        expect(resolveSessionAppearanceColor(sessionColor, { colors: { accent: Object.fromEntries(ACCENT_COLOR_KEYS.map((key) => [key, key])) as Record<typeof ACCENT_COLOR_KEYS[number], string> } })).toBe('blue');
    });

    it('merges rename, colour and clear intents and preserves other display fields', () => {
        const color = { kind: 'accent', key: 'purple' } as const;
        const initial = { t: 'plain', v: { label: 'Before', color, extension: true } } as const;
        expect(mergeWorkspaceDisplay(initial, { label: 'After' })).toEqual({ t: 'plain', v: { label: 'After', color, extension: true } });
        expect(mergeWorkspaceDisplay(initial, { color: null })).toEqual({ t: 'plain', v: { label: 'Before', extension: true } });
        expect(mergeWorkspaceDisplay(initial, { label: null })).toEqual({ t: 'plain', v: { color, extension: true } });
        expect(mergeWorkspaceDisplay({ t: 'plain', v: { color } }, { color: null })).toBeNull();
        expect(() => mergeWorkspaceDisplay({ t: 'encrypted', c: 'unreadable' }, { label: 'After' })).toThrow();
    });
});
