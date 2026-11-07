import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from '@/theme';
import type { SessionRowAttentionState } from './resolveSessionRowPresentation';
import {
    normalizeUpdatedSessionAnimation,
    resolveUpdatedAnimationPalette,
    resolveUpdatedAnimationTone,
    shadeHex,
    withAlpha,
} from './updatedSessionAnimation';

describe('resolveUpdatedAnimationTone', () => {
    it.each<[SessionRowAttentionState, 'warning' | 'danger']>([
        ['permission_required', 'warning'],
        ['action_required', 'warning'],
        ['failed', 'danger'],
    ])('colours %s as %s, the states that wait on the person', (state, tone) => {
        expect(resolveUpdatedAnimationTone(state)).toBe(tone);
    });

    it.each<SessionRowAttentionState>(['unread', 'ready'])(
        'colours %s light blue: an unseen update that needs no input',
        (state) => {
            expect(resolveUpdatedAnimationTone(state)).toBe('info');
        },
    );

    it.each<SessionRowAttentionState>(['quiet', 'pending', 'working'])(
        'stays still for %s',
        (state) => {
            expect(resolveUpdatedAnimationTone(state)).toBeNull();
        },
    );
});

describe('normalizeUpdatedSessionAnimation', () => {
    it.each(['none', 'fade', 'glow', 'sweep'] as const)('keeps %s', (value) => {
        expect(normalizeUpdatedSessionAnimation(value)).toBe(value);
    });

    it.each([undefined, null, 'bogus', true, 3])('falls back to none for %s', (value) => {
        expect(normalizeUpdatedSessionAnimation(value)).toBe('none');
    });
});

describe('resolveUpdatedAnimationPalette', () => {
    it.each([
        ['light', lightTheme],
        ['dark', darkTheme],
    ] as const)('inverts the row surface and ink in the %s theme', (_name, theme) => {
        const palette = resolveUpdatedAnimationPalette(theme, 'warning');

        expect(palette.invertedSurface).toBe(theme.colors.text.primary);
        expect(palette.invertedInk).toBe(theme.colors.surface.base);
        expect(palette.restSurface).toBe(theme.colors.surface.base);
        expect(palette.invertedSurface).not.toBe(palette.restSurface);
    });

    it('takes the tone colour from the theme state roles', () => {
        expect(resolveUpdatedAnimationPalette(lightTheme, 'info').toneColor).toBe(lightTheme.colors.state.info.foreground);
        expect(resolveUpdatedAnimationPalette(darkTheme, 'info').toneColor).toBe(darkTheme.colors.state.info.foreground);
        expect(resolveUpdatedAnimationPalette(lightTheme, 'warning').toneColor).toBe(lightTheme.colors.state.warning.foreground);
        expect(resolveUpdatedAnimationPalette(lightTheme, 'danger').toneColor).toBe(lightTheme.colors.state.danger.foreground);
    });

    it('sweeps in the plain tone on the light theme and a darker shade of it on the dark theme', () => {
        const light = resolveUpdatedAnimationPalette(lightTheme, 'warning');
        const dark = resolveUpdatedAnimationPalette(darkTheme, 'warning');

        expect(light.sweepColor).toBe(light.toneColor);
        expect(dark.sweepColor).not.toBe(dark.toneColor);
    });
});

describe('colour helpers', () => {
    it('shades a hex colour toward black', () => {
        expect(shadeHex('#ff9500', 0.5)).toBe('#804b00');
    });

    it('adds alpha to a hex colour', () => {
        expect(withAlpha('#ff9500', 0.5)).toBe('#ff950080');
    });

    it('leaves colours it cannot parse untouched', () => {
        expect(shadeHex('orange', 0.5)).toBe('orange');
        expect(withAlpha('orange', 0.5)).toBe('orange');
    });
});
