import * as React from 'react';
import Color from 'color';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Unistyles from 'react-native-unistyles';
import { resolveHappierScene } from '@happier-dev/plugin-ui/presentation';
import { planetLightForProgress } from '@happier-dev/brand/planet';

import { renderScreen } from '@/dev/testkit';
import { PlanetCanvas } from '@/components/atmosphere/PlanetCanvas';
import { createPlanetCanvasSceneCache } from '@/components/atmosphere/planetCanvasScene';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

import { SceneArt } from './SceneArt';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function planetStyle(screen: Screen) {
    const body = screen.findHostByTestId('scene-planet-body');
    const style = [body?.props.style].flat(Infinity).filter(Boolean) as Record<string, unknown>[];
    return Object.assign({}, ...style) as { opacity?: number; transform?: readonly Record<string, number>[] };
}
const propGroup = (screen: Screen, transform: string) =>
    screen.findAll((node) => String(node.type) === 'G' && String(node.props.transform).startsWith(transform))[0]!;

/**
 * Widgets plan A5: the host's scene renderer. The registry owns parts and composition; this renderer
 * owns the ink, the Brand planet and the one-shot rise, which reduced motion and still requests turn off.
 */
describe('SceneArt', () => {
    afterEach(() => {
        setReducedMotionPreferenceOverride(null);
        vi.restoreAllMocks();
    });

    it('preserves custom theme alpha through the scene fades once at the native drawing boundary', async () => {
        const runtime = Unistyles.useUnistyles();
        vi.spyOn(Unistyles, 'useUnistyles').mockReturnValue({
            ...runtime,
            theme: {
                ...runtime.theme,
                colors: {
                    ...runtime.theme.colors,
                    text: { ...runtime.theme.colors.text, primary: 'rgba(12, 24, 36, 0.4)' },
                    state: {
                        ...runtime.theme.colors.state,
                        attention: { ...runtime.theme.colors.state.attention, foreground: 'rgba(72, 84, 96, 0.6)' },
                    },
                },
            },
        });
        const screen = await renderScreen(<SceneArt scene={resolveHappierScene('nothingListening')} size="pane" still />);
        const gradients = screen.findAll((node) => String(node.type) === 'SvgLinearGradient');
        expect(gradients.length).toBeGreaterThan(0);
        const alpha = [0.4, 0.4, 0.6];
        const fade = [0.64, 0.24, 1];
        const channels = [[12, 24, 36], [12, 24, 36], [72, 84, 96]];
        for (const [index, gradient] of gradients.entries()) {
            const tone = index % 3;
            const stops = gradient.findAll((node) => String(node.type) === 'Stop');
            expect(stops).toHaveLength(4);
            for (const [stopIndex, stop] of stops.entries()) {
                expect(Color(stop.props.stopColor).rgb().array().slice(0, 3)).toEqual(channels[tone]);
                const strength = Math.round(alpha[tone]! * 255) / 255 * fade[tone]!;
                expect(stop.props.stopOpacity ?? 1).toBeCloseTo(stopIndex === 0 || stopIndex === 3 ? 0 : strength);
                if (stopIndex === 1 || stopIndex === 2) expect(Color(stop.props.stopColor).alpha()).toBe(1);
            }
        }
    });

    it('draws the scene at its size, with the Brand dot planet hidden below the ground', async () => {
        const screen = await renderScreen(<SceneArt testID="art" scene={resolveHappierScene('nothingListening', 'page')} size="page" still />);
        const art = screen.findHostByTestId('art');
        expect(art?.props.style.width).toBe(232);
        expect(art?.props.style.height).toBeCloseTo(92.8);
        expect(art?.props.accessibilityElementsHidden).toBe(true);
        // the planet layer ends just above the ground (y 45.6 of 64, at 232 / 160)
        expect(screen.findHostByTestId('scene-planet')?.props.style).toMatchObject({ height: 45.6 * 1.45, overflow: 'hidden' });
        const planet = screen.findAll(node => typeof node.type !== 'string' && node.props.mark?.size !== undefined)[0]!;
        expect(planet.props.mark).toMatchObject({ radiusScale: 1.38, halo: 0.55, theme: 'light' });
        expect(planet.props.width).toBeGreaterThan(0);
    });

    it('brings a rising planet up once, and holds it in place under reduced motion or a still request', async () => {
        const scene = resolveHappierScene('firstRun');

        const moving = await renderScreen(<SceneArt scene={scene} size="pane" still={false} />);
        expect(planetStyle(moving).opacity).toBe(0);
        expect(planetStyle(moving).transform?.[0]?.translateY).toBeGreaterThan(0);

        const still = await renderScreen(<SceneArt scene={scene} size="pane" still />);
        expect(planetStyle(still)).toMatchObject({ opacity: 1, transform: [{ translateY: 0 }] });

        setReducedMotionPreferenceOverride(true);
        const reduced = await renderScreen(<SceneArt scene={scene} size="pane" still={false} />);
        expect(planetStyle(reduced)).toMatchObject({ opacity: 1, transform: [{ translateY: 0 }] });

        // a resting planet never moves
        setReducedMotionPreferenceOverride(null);
        const resting = await renderScreen(<SceneArt scene={resolveHappierScene('inboxZero')} size="pane" still={false} />);
        expect(planetStyle(resting)).toMatchObject({ opacity: 1 });
    });

    it('renders a plugin planet look and placement through the scene core, including explicit zero and false', async () => {
        const renderLook = async (style: 'airy' | 'rich' | undefined, fullness: number, digits: boolean) => {
            const scene = resolveHappierScene({
                name: 'acme.custom-planet', moment: 'dusk',
                planetAt: { x: 88, y: 29, r: 30, style, fullness, digits },
            }, 'page');
            const screen = await renderScreen(<SceneArt scene={scene} size="page" still />);
            const canvas = screen.findAllByType(PlanetCanvas)[0]!;
            expect(canvas.props.options).toMatchObject({
                R: 30 * 1.45, cx: 88 * 1.45, cy: 29 * 1.45,
                view: { w: 232, h: 92.8 }, style, fullness,
                light: planetLightForProgress(0.38),
            });
            expect(screen.findHostByTestId('scene-planet-body')?.props.style[0]).toMatchObject({ left: 0, top: 0, width: 232, height: 92.8 });
            return createPlanetCanvasSceneCache()({ width: canvas.props.width, height: canvas.props.height,
                options: canvas.props.options }, 1);
        };
        const rich = await renderLook('rich', 0.7, true);
        const airy = await renderLook('airy', 0, false);
        expect(rich.body.length).toBeGreaterThan(airy.body.length);
        expect(rich.cells.length).toBeGreaterThan(0);
        expect(airy.cells).toEqual([]);
        const hollow = await renderLook('rich', 0, true);
        expect(rich.body).not.toEqual(hollow.body);
        // Zero/false alone still select the authored scene path, without a truthy style to mask them.
        expect((await renderLook(undefined, 0, false)).cells).toEqual([]);
    });

    it('keeps customized rising planets behind the ground and still under reduced motion', async () => {
        const scene = resolveHappierScene({
            name: 'acme.custom-dawn', moment: 'rising', planet: 'rising',
            planetAt: { x: 112, r: 28, digits: true },
        });
        const moving = await renderScreen(<SceneArt scene={scene} size="pane" still={false} />);
        expect(moving.findAllByType(PlanetCanvas)[0]!.props.options).toBeDefined();
        expect(moving.findHostByTestId('scene-planet')?.props.style).toMatchObject({ height: 45.6 * 1.1, overflow: 'hidden' });
        expect(planetStyle(moving).transform?.[0]?.translateY).toBeGreaterThan(0);
        setReducedMotionPreferenceOverride(true);
        const reduced = await renderScreen(<SceneArt scene={scene} size="pane" still={false} />);
        expect(planetStyle(reduced)).toMatchObject({ opacity: 1, transform: [{ translateY: 0 }] });
    });

    it('draws a plugin prop in the scene ink at the host line width, mirrored when flipped', async () => {
        const scene = resolveHappierScene({
            name: 'acme.crate',
            moment: 'dusk',
            props: [{ prop: { name: 'acme.crate', marks: [{ shape: 'rect', x: -6, y: -8, width: 12, height: 8 }] }, x: 60, scale: 2, flip: true }],
        });
        const screen = await renderScreen(<SceneArt scene={scene} size="pane" still />);
        const rect = propGroup(screen, 'translate(60 46) scale(-2 2)').findAll((node) => String(node.type) === 'Rect')[0]!;
        expect(Color(rect.props.stroke).rgb().array().slice(0, 3)).toEqual(Color(screen.findAll((node) => String(node.type) === 'Stop')[1]!.props.stopColor).rgb().array().slice(0, 3));
        expect(rect.props.strokeWidth).toBeCloseTo((1.3 / 1.1) / 2);
    });

    it('paints the one accent in the attention amber, and the beacon of a waiting planet too', async () => {
        const accentOf = async (accent: string | undefined) => {
            const screen = await renderScreen(<SceneArt scene={resolveHappierScene({ name: 'test.shield', moment: 'noon', props: [{ prop: 'shield', x: 56 }], accent })} size="pane" still />);
            const line = screen.findAll((node) => String(node.type) === 'Stop')[1]!.props.stopColor;
            const tick = propGroup(screen, 'translate(56 46)').findAll((node) => String(node.type) === 'Path').at(-1)!;
            return { line, stroke: tick.props.stroke, opacity: tick.props.strokeOpacity };
        };
        const on = await accentOf('shield');
        expect(on.stroke).not.toBe(on.line);
        expect(on.opacity).toBe(1);
        const off = await accentOf(undefined);
        expect(Color(off.stroke).rgb().array().slice(0, 3)).toEqual(Color(off.line).rgb().array().slice(0, 3));
        expect(off.opacity).toBeLessThan(1);

        const waiting = await renderScreen(<SceneArt scene={resolveHappierScene('reconnecting')} size="pane" still />);
        const beacon = waiting.findAll((node) => String(node.type) === 'Circle' && node.props.r === 1.5)[0]!;
        expect(beacon.props.fill).toBe(on.stroke);
    });
});
