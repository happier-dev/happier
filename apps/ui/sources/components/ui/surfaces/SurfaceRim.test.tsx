import * as React from 'react';
import Color from 'color';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { darkTheme, lightTheme } from '@/theme';

import { SurfaceRim } from './SurfaceRim';
import { SURFACE_EDGE_TREATMENT } from './surfaceEdgeTreatment';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

type Screen = Awaited<ReturnType<typeof renderScreen>>;
const strokes = (screen: Screen) => screen.findAll((node) => String(node.type) === 'Rect' && node.props.fill === 'none').map((node) => String(node.props.stroke));

describe('SurfaceRim', () => {
    it('draws a dark rim-role surface\'s whole hairline in its border colour, under the corner light and sheen', async () => {
        expect(SURFACE_EDGE_TREATMENT.floating.dark).toBe('rim');
        const screen = await renderScreen(<SurfaceRim role="floating" radius={12} border="modal" theme={darkTheme} />);

        const drawn = strokes(screen);
        expect(drawn[0]).toBe(darkTheme.colors.border.modal);
        expect(drawn.slice(1).every((stroke) => stroke.startsWith('url(#'))).toBe(true);
        expect(drawn).toHaveLength(2);
        // The sheen fills the corner; every layer keeps the surface's own radius.
        expect(screen.findAll((node) => String(node.type) === 'Rect').every((node) => node.props.rx === 12)).toBe(true);
    });

    it.each([['light', lightTheme], ['dark', darkTheme]] as const)('preserves the %s rim ink strength at the native gradient boundary', async (_mode, theme) => {
        const screen = await renderScreen(<SurfaceRim role="floating" radius={12} border="modal" theme={theme} />);
        const authored = [theme.colors.edge.rimHi, theme.colors.edge.rimMid, theme.colors.edge.rimMid, theme.colors.edge.sheen, theme.colors.edge.sheen];
        const stops = screen.findAll((node) => String(node.type) === 'Stop');
        expect(stops).toHaveLength(authored.length);
        for (const [index, stop] of stops.entries()) {
            const ink = Color(authored[index]!);
            // Native SVG replaces the stopColor alpha with stopOpacity. The
            // boundary must receive the ink's opacity explicitly, exactly once.
            expect(Color(stop.props.stopColor).rgb().array().slice(0, 3)).toEqual(ink.rgb().array().slice(0, 3));
            expect(stop.props.stopOpacity ?? 1).toBeCloseTo(index === 2 || index === 4 ? 0 : Math.round(ink.alpha() * 255) / 255);
            expect(Color(stop.props.stopColor).alpha()).toBe(1);
        }
    });

    it('renders nothing where the role stands on the flat edge: cards and the composer, in either scheme', async () => {
        for (const [role, theme] of [['card', darkTheme], ['card', lightTheme], ['composer', darkTheme]] as const) {
            const screen = await renderScreen(<SurfaceRim role={role} radius={16} border="surface" theme={theme} />);
            expect(screen.findAll((node) => String(node.type) === 'Rect')).toHaveLength(0);
        }
    });
});
