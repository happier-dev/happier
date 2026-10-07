import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { darkTheme, lightTheme } from '@/theme';

import { SurfaceRim } from './SurfaceRim';
import { SURFACE_EDGE_TREATMENT } from './surfaceEdgeTreatment';

type Screen = Awaited<ReturnType<typeof renderScreen>>;
const strokes = (screen: Screen) => screen.findAll((node) => node.type === 'Rect' && node.props.fill === 'none').map((node) => String(node.props.stroke));

describe('SurfaceRim', () => {
    it('draws a dark rim-role surface\'s whole hairline in its border colour, under the corner light and sheen', async () => {
        expect(SURFACE_EDGE_TREATMENT.floating.dark).toBe('rim');
        const screen = await renderScreen(<SurfaceRim role="floating" radius={12} border="modal" theme={darkTheme} />);

        const drawn = strokes(screen);
        expect(drawn[0]).toBe(darkTheme.colors.border.modal);
        expect(drawn.slice(1).every((stroke) => stroke.startsWith('url(#'))).toBe(true);
        expect(drawn).toHaveLength(2);
        // The sheen fills the corner; every layer keeps the surface's own radius.
        expect(screen.findAll((node) => node.type === 'Rect').every((node) => node.props.rx === 12)).toBe(true);
        // Light from the top left in every theme: the light's stops are the theme's own rim ink.
        const stops = screen.findAll((node) => node.type === 'Stop').map((node) => String(node.props.stopColor));
        expect(stops).toContain(darkTheme.colors.edge.rimHi);
        expect(stops).toContain(darkTheme.colors.edge.rimMid);
        expect(stops).toContain(darkTheme.colors.edge.sheen);
    });

    it('renders nothing where the role stands on the flat edge: cards and the composer, in either scheme', async () => {
        for (const [role, theme] of [['card', darkTheme], ['card', lightTheme], ['composer', darkTheme]] as const) {
            const screen = await renderScreen(<SurfaceRim role={role} radius={16} border="surface" theme={theme} />);
            expect(screen.findAll((node) => node.type === 'Rect')).toHaveLength(0);
        }
    });
});
