import { describe, expect, it } from 'vitest';
import { createGlyphFrameSampler } from '@happier-dev/brand/glyph-scene';

import { resolveMoveGrammar } from './stepMotionChoreography';
import { createStepMotionScene, type StepAnimation } from './stepMotionScene';

const geometry = {
    grid: { width: 390, height: 844, cols: 49, rows: 53, cell: [8, 16] as const },
    outgoing: { x: 0, y: 250, width: 390, height: 400 },
    incoming: { x: 0, y: 300, width: 390, height: 500 },
    source: { x: 100, y: 380, width: 140, height: 40 },
    target: { x: 60, y: 340, width: 240, height: 210 },
};

function scene(animation: Omit<StepAnimation, 'epoch'>) {
    const { cols, rows } = geometry.grid;
    const rgba = new Uint8Array(cols * rows * 4);
    for (const row of [16, 22, 27, 34]) for (let col = 10; col < 39; col++) rgba[(row * cols + col) * 4 + 3] = 255;
    return createStepMotionScene({ ...geometry, outgoingInk: { rgba, cols, rows }, animation: { ...animation, epoch: 0 } });
}

describe('first-open glyph choreography', () => {
    it('uses the same particle geometry and presentation time while reversing an interrupted move', () => {
        const forward = scene({ grammar: 'morph', from: 0, to: 1, secondsPerProgress: 0.92 });
        const reverse = scene({ grammar: 'morph', from: 0.6, to: 0, secondsPerProgress: 0.8 });
        const correspondingForwardFrame = forward(0.45 * 0.92).find(layer => layer.kind === 'traveller');
        const reverseFrame = reverse((0.6 - 0.45) * 0.8).find(layer => layer.kind === 'traveller');

        expect(correspondingForwardFrame).toBeDefined();
        expect(reverseFrame).toEqual(correspondingForwardFrame);
    });

    it('folds a compact Welcome move without producing travellers', () => {
        const grammar = resolveMoveGrammar({ kind: 'step', reduced: false, compact: true, fromWelcome: true });
        expect(grammar).toBe('fold');
        const fold = scene({ grammar: 'fold', from: 0, to: 1, secondsPerProgress: 0.92 });
        expect(fold(0.23).some(layer => layer.kind === 'traveller')).toBe(false);
    });

    it('moves small controls along the damped flight with two trailing echoes', () => {
        const forward = scene({ grammar: 'morph', from: 0, to: 1, secondsPerProgress: 0.92 });
        const layer = forward(0.45 * 0.92).find(layer => layer.kind === 'traveller');
        if (!layer) throw new Error('The focal element should receive the control particles');
        const sample = createGlyphFrameSampler();
        const frame = sample({ view: { w: 390, h: 844 }, dpr: 1, theme: 'light', layers: [layer] });
        expect(frame.sprites.glyph.length).toBeGreaterThan(layer.particles.length / 8);
        expect(Math.max(...frame.sprites.glyph)).toBeLessThan(20);
        expect(Math.min(...frame.sprites.glyph)).toBeGreaterThanOrEqual(10);
    });

    it('lifts outgoing ink and moves a scattered pill toward the focal element', () => {
        const forward = scene({ grammar: 'morph', from: 0, to: 1, secondsPerProgress: 0.92 });
        const sample = createGlyphFrameSampler();
        const positions = (progress: number, kind: 'front' | 'traveller') => {
            const layer = forward(progress * 0.92).find(layer => layer.kind === kind);
            if (!layer) throw new Error('Missing paint layer');
            return sample({ view: { w: 390, h: 844 }, dpr: 1, theme: 'light', layers: [layer] }).sprites.at.slice();
        };
        expect(positions(0.48, 'front').some((y, index) => index % 2 === 1 && y < geometry.outgoing.y)).toBe(true);
        const pill = positions(0.05, 'traveller');
        expect(new Set(pill.filter((_, index) => index % 2 === 1)).size).toBeGreaterThan(25);
        expect(positions(0.72, 'traveller').some((y, index) => index % 2 === 1 && y > 480)).toBe(true);
    });

    it('dissolves a small control into digits that thin out at its edges instead of a hard-edged block', () => {
        const forward = scene({ grammar: 'morph', from: 0, to: 1, secondsPerProgress: 0.92 });
        // At p = 0.05 every digit is fully faded in and none has started its flight.
        const layer = forward(0.05 * 0.92).find(layer => layer.kind === 'traveller');
        if (!layer) throw new Error('The pressed control should break into digits');
        const at = createGlyphFrameSampler()({ view: { w: 390, h: 844 }, dpr: 1, theme: 'light', layers: [layer] }).sprites.at;
        const { x, y, width, height } = geometry.source;
        const outside = (px: number, py: number) => Math.max(x - px, px - x - width, y - py, py - y - height);
        let core = 0, rim = 0;
        for (let index = 0; index < at.length; index += 2) {
            const distance = outside(at[index], at[index + 1]);
            if (distance <= -8) core++;
            else if (distance > 4 && distance <= 8) rim++;
        }
        const coreArea = (width - 16) * (height - 16);
        const rimArea = (width + 16) * (height + 16) - (width + 8) * (height + 8);
        expect(core / coreArea).toBeGreaterThan(0.03);
        expect(rim / rimArea).toBeLessThan(0.35 * core / coreArea);
    });

    it('keeps the lab digit count when the focal ink arrives mid-move, so the mass neither thins nor jumps', () => {
        let focalInk: Array<readonly [number, number]> | undefined;
        const { cols, rows } = geometry.grid;
        const forward = createStepMotionScene({
            ...geometry, outgoingInk: { rgba: new Uint8Array(cols * rows * 4), cols, rows },
            readFocalInk: () => focalInk,
            animation: { grammar: 'morph', from: 0, to: 1, secondsPerProgress: 0.92, epoch: 0 },
        });
        const count = (progress: number) => (forward(progress * 0.92).find(layer => layer.kind === 'traveller')?.particles.length ?? 0) / 8;
        const before = count(0.1);
        // A sparse code: far fewer ink cells than the target's area holds digits.
        focalInk = Array.from({ length: 120 }, (_, index) => [(index % 12 + 0.5) / 12, (Math.floor(index / 12) + 0.5) / 10] as const);
        const { width, height } = geometry.target;
        expect(before).toBe(Math.round(width * height * 0.8 / 70));
        expect(count(0.3)).toBe(before);
    });

    it('clears outgoing Home digits before revealing Home and leaves an empty scene at settle', () => {
        const home = scene({ grammar: 'home', from: 0, to: 1, secondsPerProgress: 3.4 });
        const modes = (seconds: number) => home(seconds).flatMap(layer => layer.kind === 'front' ? [layer.mode] : []);

        expect(modes(0.5)).toEqual(['eat']);
        expect(modes(1.05)).toEqual(['decode']);
        expect(home(1.5).find(layer => layer.kind === 'front')?.rect).toEqual(geometry.incoming);
        expect(home(3.4)).toEqual([]);
    });
});
