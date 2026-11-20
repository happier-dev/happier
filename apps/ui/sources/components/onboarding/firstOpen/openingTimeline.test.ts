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
        const sample = createOpeningTimeline({ width: 1440, height: 900, phone: false, theme: 'dark' });
        expect(sample(0)).toEqual([]);
        const mark = sample(1.1).find(layer => layer.kind === 'mark');
        expect(mark).toMatchObject({ centre: { x: 720, y: 414 }, turn: 0 });
        const overlap = sample(1.6);
        expect(overlap.find(layer => layer.kind === 'mark')?.turn).toBeGreaterThan(0);
        expect(overlap.find(layer => layer.kind === 'planet')?.geometry.cy).toBeGreaterThan(414);
        expect(sample(2).find(layer => layer.kind === 'mark')).toBeUndefined();
    });

    it('lands at the welcome pose calculated inside the real window rectangle', () => {
        const windowRect = { x: 70, y: 60, width: 1300, height: 760 };
        const sample = createOpeningTimeline({ width: 1440, height: 900, phone: false, theme: 'light', windowRect });
        const pose = welcomePlanetPose('welcome', windowRect, { phone: false });
        expect(sample(3.17).find(layer => layer.kind === 'planet')?.geometry).toMatchObject({
            cx: pose.cx + windowRect.x,
            cy: pose.cy + windowRect.y,
            R: pose.R,
        });
    });

    it('turns the same mark cells it assembled and removes them progressively', () => {
        const view = { w: 1440, h: 900 };
        const sample = createOpeningTimeline({ width: view.w, height: view.h, phone: false, theme: 'dark' });
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
});
