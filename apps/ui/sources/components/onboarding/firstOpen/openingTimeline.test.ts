import { glyphFrame } from '@happier-dev/brand/glyph-scene';
import { welcomePlanetPose } from '@happier-dev/brand/planet-placement';
import { describe, expect, it } from 'vitest';
import { visualAt } from '@/components/ui/motion/stepMotion/stepMotionChoreography';
import { stepMotionTiming } from '@/components/ui/motion/stepMotion/stepMotionTiming';
import { createOpeningTimeline, openingClimbSeconds, openingSceneSeconds } from './openingTimeline';

describe('first-open scene timing', () => {
    it('finishes building the real window on the lab swap beat', () => {
        const end = openingClimbSeconds + stepMotionTiming.openingS;
        expect(end).toBeCloseTo(openingSceneSeconds, 4);
        const climb = (seconds: number) => visualAt('opening', seconds / stepMotionTiming.openingS).arriveFront;
        expect(climb(0.15)).toBeLessThan(climb(0.3) / 2);
        expect(climb(stepMotionTiming.openingS)).toBe(1);
    });

    it('starts clear, holds the assembled mark, and turns while the planet descends', () => {
        const sample = createOpeningTimeline({ width: 1440, height: 900, theme: 'dark' });
        expect(sample(0)).toEqual([]);
        const mark = sample(1.1).find(layer => layer.kind === 'mark');
        expect(mark).toMatchObject({ centre: { x: 720, y: 414 }, turn: 0 });
        const overlap = sample(1.6);
        const turning = overlap.find(layer => layer.kind === 'mark');
        const falling = overlap.find(layer => layer.kind === 'planet');
        expect(turning?.turn).toBeGreaterThan(0);
        expect(falling?.geometry.cy).toBeGreaterThan(414);
        // As the lab draws it: the dissolving mark rides the falling planet's frame.
        expect(turning?.centre).toEqual({ x: falling?.geometry.cx, y: falling?.geometry.cy });
        expect(turning?.size).toBeGreaterThan(mark!.size);
        expect(sample(2).find(layer => layer.kind === 'mark')).toBeUndefined();
    });

    it('lands at the welcome pose calculated inside the real window rectangle', () => {
        const windowRect = { x: 70, y: 60, width: 1300, height: 760 };
        const sample = createOpeningTimeline({ width: 1440, height: 900, theme: 'light', windowRect });
        const pose = welcomePlanetPose('welcome', windowRect, { phone: false });
        expect(sample(3.17).find(layer => layer.kind === 'planet')?.geometry).toMatchObject({
            cx: pose.cx + windowRect.x,
            cy: pose.cy + windowRect.y,
            R: pose.R,
        });
    });

    it('lands an in-app phone opening on the pose and look the compact Welcome draws', () => {
        const pane = { width: 390, height: 844 };
        const sample = createOpeningTimeline({ ...pane, theme: 'light' });
        const pose = welcomePlanetPose('welcome', pane, { phone: true });
        const planet = sample(openingSceneSeconds).find(layer => layer.kind === 'planet');
        expect(planet?.soft).toBe(true);
        expect(planet?.geometry.cx).toBeCloseTo(pose.cx, 6);
        expect(planet?.geometry.cy).toBeCloseTo(pose.cy, 6);
        expect(planet?.geometry.R).toBeCloseTo(pose.R, 6);
    });

    it('turns the same mark cells it assembled and removes them progressively', () => {
        const view = { w: 1440, h: 900 };
        const sample = createOpeningTimeline({ width: view.w, height: view.h, theme: 'dark' });
        const markAt = (time: number) => glyphFrame({ view, dpr: 1, cell: [8, 16], theme: 'dark',
            layers: sample(time).filter(layer => layer.kind === 'mark'),
        }, { time }).sprites;
        const assembled = markAt(1.1);
        const turned = markAt(1.5);
        expect(markAt(0.65).glyph.length).toBeLessThan(assembled.glyph.length);
        expect(turned.glyph.length).toBeGreaterThan(0);
        expect(turned.glyph.length).toBeLessThan(assembled.glyph.length);
        expect(turned.at.some((position, i) => i % 2 === 0 && Math.abs(position % 8 - 4) > 0.001)).toBe(true);
        expect(markAt(1.93).glyph.length).toBe(0);
    });
    it('keeps loose digits quieter than the mark and gives the formed planet a lifting halo of grey digits', () => {
        const sample = createOpeningTimeline({ width: 1440, height: 900, theme: 'light' });
        const loose = (time: number) => sample(time).flatMap(layer => layer.kind === 'traveller' ? [layer] : []);
        const reading = loose(1.0);
        expect(reading.filter(layer => (layer.alpha ?? 1) < 1).reduce((sum, layer) => sum + layer.particles.length / 8, 0))
            .toBeGreaterThan(100);
        const planet = sample(2.0).find(layer => layer.kind === 'planet')!;
        const { cx, cy, R } = planet.geometry;
        const haloAt = (time: number) => loose(time).filter(layer => Array.isArray(layer.ink)).reduce((sum, layer) => {
            let around = 0;
            for (let i = 0; i < layer.particles.length; i += 8) {
                if (Math.hypot(layer.particles[i] - cx, layer.particles[i + 1] - cy) > R * 1.04) around++;
            }
            return sum + around;
        }, 0);
        expect(haloAt(2.0)).toBeGreaterThan(50);
        expect(haloAt(openingClimbSeconds + 0.7)).toBe(0);
    });
});
