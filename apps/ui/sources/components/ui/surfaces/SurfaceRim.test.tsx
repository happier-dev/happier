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
            // The rim light keeps a share of its mid ink at the far edge (owner 2026-11-11: no cut in the seam); the sheen fades out.
            const share = index === 2 ? 0.35 : index === 4 ? 0 : 1;
            expect(stop.props.stopOpacity ?? 1).toBeCloseTo(share * Math.round(ink.alpha() * 255) / 255);
            expect(Color(stop.props.stopColor).alpha()).toBe(1);
        }
    });

    // Owner 2026-11-10: a phone popover showed a second, smaller border inside its glass. Native SVG resolved the
    // rim's "100%" against the popover's first layout (370 pt) and kept it after the popover settled at 378 pt
    // (device A/B: hiding the glass left the 370-wide rim alone). The rim draws at its surface's laid-out size.
    it('draws its hairline at the surface\'s laid-out size, following a resize', async () => {
        const { act } = await import('react');
        const screen = await renderScreen(<SurfaceRim role="floating" radius={10} border="modal" theme={darkTheme} />);
        const svg = () => screen.findAll((node) => String(node.type) === 'Svg')[0]!;
        // A plain view measures the surface: react-native-svg's view reported only its first layout (device probe).
        const isSvg = (node: { type: unknown }) => String(node.type) === 'Svg' || (node.type as { displayName?: string })?.displayName === 'Svg';
        expect(screen.findAll((node) => isSvg(node) && node.props.onLayout !== undefined).length).toBe(0);
        const frame = () => screen.findAll((node) => String(node.type) === 'View' && typeof node.props.onLayout === 'function')[0]!;
        const layout = (width: number, height: number) => act(() => { frame().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } }); });
        await layout(370, 631);
        await layout(378, 634);
        // react-native-svg sizes its view from width/height props: pinned to the first layout, the rim could never
        // measure the settled size (device probe: Svg 370 inside a 378 surface). Its frame follows the surface.
        expect([svg().props.width, svg().props.height]).toEqual([undefined, undefined]);
        const rects = screen.findAll((node) => String(node.type) === 'Rect');
        expect(rects.length).toBeGreaterThan(0);
        for (const rect of rects) expect([rect.props.width, rect.props.height]).toEqual([378, 634]);
    });

    it('anchors its corner light where the surface asks, top-left unless told otherwise', async () => {
        const anchors = async (anchor?: 'bottom-left') => {
            const screen = await renderScreen(<SurfaceRim role="floating" radius={12} border="default" theme={darkTheme} anchor={anchor} />);
            return screen.findAll((node) => String(node.type) === 'RadialGradient').map((node) => [node.props.cx, node.props.cy]);
        };
        expect(await anchors()).toEqual([[0, 0], [0, 0]]);
        expect(await anchors('bottom-left')).toEqual([[0, 1], [0, 1]]);
    });

    it('renders nothing where the role stands on the flat edge: cards and the composer, in either scheme', async () => {
        for (const [role, theme] of [['card', darkTheme], ['card', lightTheme], ['composer', darkTheme]] as const) {
            const screen = await renderScreen(<SurfaceRim role={role} radius={16} border="surface" theme={theme} />);
            expect(screen.findAll((node) => String(node.type) === 'Rect')).toHaveLength(0);
        }
    });
});
