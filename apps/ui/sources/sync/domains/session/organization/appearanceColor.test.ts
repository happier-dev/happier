import { describe, expect, it } from 'vitest';
import { ACCENT_COLOR_KEYS } from '@/theme/accentColors';
import { areSessionAppearanceColorsEqual, parseSessionAppearanceColor, readSessionAppearanceColorFromDisplay, resolveEffectiveSessionAppearanceColor, resolveSessionAppearanceColor } from './appearanceColor';

describe('appearance colours', () => {
    it('admits canonical accents and normalizes opaque custom colours', () => {
        for (const key of ACCENT_COLOR_KEYS) expect(parseSessionAppearanceColor({ kind: 'accent', key })).toEqual({ kind: 'accent', key });
        expect(parseSessionAppearanceColor({ kind: 'custom', hex: ' #aBc ' })).toEqual({ kind: 'custom', hex: '#AABBCC' });
        for (const value of [null, [], 'blue', { kind: 'accent', key: 'nope' }, { kind: 'custom', hex: '#abcd' }]) expect(parseSessionAppearanceColor(value)).toBeNull();
    });

    it('uses the opened display owner and never reads a locked envelope', () => {
        const color = { kind: 'accent', key: 'blue' } as const;
        const encrypted = { t: 'encrypted', c: 'cipher' } as const;
        expect(readSessionAppearanceColorFromDisplay(encrypted, { status: 'available', value: { color } })).toEqual(color);
        expect(readSessionAppearanceColorFromDisplay({ t: 'plain', v: { color } }, { status: 'locked', reason: 'account_key_unavailable' })).toBeNull();
        expect(readSessionAppearanceColorFromDisplay({ t: 'plain', v: { color } })).toEqual(color);
    });

    it('resolves override and inheritance with stable identities', () => {
        const sessionColor = { kind: 'accent', key: 'blue' } as const;
        const workspaceColor = { kind: 'custom', hex: '#AABBCC' } as const;
        expect(resolveEffectiveSessionAppearanceColor({ sessionColor, workspaceColor })).toBe(sessionColor);
        expect(resolveEffectiveSessionAppearanceColor({ sessionColor: null, workspaceColor })).toBe(workspaceColor);
        expect(resolveEffectiveSessionAppearanceColor({})).toBeNull();
        expect(areSessionAppearanceColorsEqual(workspaceColor, parseSessionAppearanceColor({ kind: 'custom', hex: '#abc' }))).toBe(true);
        expect(resolveSessionAppearanceColor(sessionColor, { colors: { accent: { blue: 'theme-blue', green: '', orange: '', yellow: '', red: '', indigo: '', purple: '' } } })).toBe('theme-blue');
    });
});
