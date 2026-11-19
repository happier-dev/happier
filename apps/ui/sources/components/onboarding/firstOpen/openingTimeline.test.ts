import { welcomePlanetPose } from '@happier-dev/brand/planet-placement';
import { describe, expect, it } from 'vitest';
import { createOpeningTimeline } from './openingTimeline';

describe('first-open scene timing', () => {
    it('starts clear, holds the assembled mark, and turns while the planet descends', () => {
        const sample = createOpeningTimeline({ width: 1440, height: 900, phone: false, theme: 'dark' });
        expect(sample(0)).toEqual([]);
        const mark = sample(1.1).find(layer => layer.kind === 'mark');
        expect(mark).toMatchObject({ centre: { x: 720, y: 414 }, fill: 1, turn: 0, dissolve: 0 });
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
});
