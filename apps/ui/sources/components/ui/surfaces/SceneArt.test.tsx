import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveHappierScene } from '@happier-dev/plugin-ui/presentation';

import { renderScreen } from '@/dev/testkit';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

import { SceneArt } from './SceneArt';

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function planetStyle(screen: Screen) {
    const body = screen.findHostByTestId('scene-planet-body');
    const style = [body?.props.style].flat(Infinity).filter(Boolean) as Record<string, unknown>[];
    return Object.assign({}, ...style) as { opacity?: number; transform?: readonly Record<string, number>[] };
}
const propGroup = (screen: Screen, transform: string) =>
    screen.findAll((node) => node.type === 'G' && String(node.props.transform).startsWith(transform))[0]!;

/**
 * Widgets plan A5: the host's scene renderer. The registry owns parts and composition; this renderer
 * owns the ink, the Brand planet and the one-shot rise, which reduced motion and still requests turn off.
 */
describe('SceneArt', () => {
    afterEach(() => setReducedMotionPreferenceOverride(null));

    it('draws the scene at its size, with the Brand dot planet hidden below the ground', async () => {
        const screen = await renderScreen(<SceneArt testID="art" scene={resolveHappierScene('nothingListening', 'page')} size="page" still />);
        const art = screen.findHostByTestId('art');
        expect(art?.props.style.width).toBe(232);
        expect(art?.props.style.height).toBeCloseTo(92.8);
        expect(art?.props.accessibilityElementsHidden).toBe(true);
        // the planet layer ends just above the ground (y 45.6 of 64, at 232 / 160)
        expect(screen.findHostByTestId('scene-planet')?.props.style).toMatchObject({ height: 45.6 * 1.45, overflow: 'hidden' });
        const planetDots = screen.findHostByTestId('scene-planet-body')!.findAll((node) => node.type === 'Circle');
        expect(planetDots.length).toBeGreaterThan(40);
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

    it('draws a plugin prop in the scene ink at the host line width, mirrored when flipped', async () => {
        const scene = resolveHappierScene({
            name: 'acme.crate',
            moment: 'dusk',
            props: [{ prop: { name: 'acme.crate', marks: [{ shape: 'rect', x: -6, y: -8, width: 12, height: 8 }] }, x: 60, scale: 2, flip: true }],
        });
        const screen = await renderScreen(<SceneArt scene={scene} size="pane" still />);
        const rect = propGroup(screen, 'translate(60 46) scale(-2 2)').findAll((node) => node.type === 'Rect')[0]!;
        expect(rect.props.stroke).toBe(screen.findAll((node) => node.type === 'Stop')[1]!.props.stopColor);
        expect(rect.props.strokeWidth).toBeCloseTo((1.3 / 1.1) / 2);
    });

    it('paints the one accent in the attention amber, and the beacon of a waiting planet too', async () => {
        const accentOf = async (accent: string | undefined) => {
            const screen = await renderScreen(<SceneArt scene={resolveHappierScene({ name: 'test.shield', moment: 'noon', props: [{ prop: 'shield', x: 56 }], accent })} size="pane" still />);
            const line = screen.findAll((node) => node.type === 'Stop')[1]!.props.stopColor;
            const tick = propGroup(screen, 'translate(56 46)').findAll((node) => node.type === 'Path').at(-1)!;
            return { line, stroke: tick.props.stroke, opacity: tick.props.strokeOpacity };
        };
        const on = await accentOf('shield');
        expect(on.stroke).not.toBe(on.line);
        expect(on.opacity).toBe(1);
        const off = await accentOf(undefined);
        expect(off.stroke).toBe(off.line);
        expect(off.opacity).toBeLessThan(1);

        const waiting = await renderScreen(<SceneArt scene={resolveHappierScene('reconnecting')} size="pane" still />);
        const beacon = waiting.findAll((node) => node.type === 'Circle' && node.props.r === 1.5)[0]!;
        expect(beacon.props.fill).toBe(on.stroke);
    });
});
