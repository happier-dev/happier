import { frontGlyphLayer, travellerGlyphLayer, type GlyphInk, type GlyphInkMap, type GlyphLayer, type GlyphRect } from '@happier-dev/brand/glyph-scene';

import { leavingEdge, progressAt, revealRadius, visualAt, type StepGrammar } from './stepMotionChoreography';
import { stepMotionTiming } from './stepMotionTiming';
import type { StepGrid } from './stepMotionTypes';

export type StepAnimation = Readonly<{
    grammar: Exclude<StepGrammar, 'fade'>;
    from: number;
    to: number;
    secondsPerProgress: number;
    epoch: number;
}>;

export function readStepProgress(animation: StepAnimation, elapsed: number): number {
    return progressAt(animation.from, animation.to, elapsed / animation.secondsPerProgress);
}

export function stepAnimationDuration(animation: StepAnimation): number {
    return Math.abs(animation.from - animation.to) * animation.secondsPerProgress;
}

function centre(rect: GlyphRect) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

const scatter = (index: number, salt: number) => {
    const hash = Math.imul(index + salt, 0x45d9f3b);
    return ((Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) ^ hash) >>> 0) / 2 ** 32;
};

export type StepFocalInk = readonly (readonly [number, number])[];

function makeParticles(source: GlyphRect, target: GlyphRect, focalInk?: StepFocalInk) {
    const t = stepMotionTiming;
    const small = source.width * source.height < t.smallArea;
    const sourceCells = Math.round(source.width * source.height * t.particleDensity / t.particleArea);
    // The focal ink only places the digits; their number follows the larger area, as in the lab, so it holds when
    // the ink arrives mid-move.
    const targetCells = Math.round(target.width * target.height * t.particleDensity / t.particleArea);
    const count = Math.min(t.particleLimit, Math.max(small ? t.smallMinimum : 1, sourceCells, targetCells));
    const cols = Math.max(1, Math.round(Math.sqrt(count * Math.max(1, target.width) / Math.max(1, target.height))));
    const rows = Math.ceil(count / cols);
    const particles = new Float32Array(count * 8);
    // A small control's digits fill it and thin out over twice its halo on every side (a box convolved with a
    // triangle), so the dissolving control never reads as a hard-edged block.
    const feather = (i: number, salt: number) => (scatter(i, salt) + scatter(i, salt + 104) - 1) * 2 * t.smallHalo;
    for (let i = 0; i < count; i++) {
        const x = (i % cols + 0.5) / cols;
        const y = (Math.floor(i / cols) + 0.5) / rows;
        const left = small ? source.x + scatter(i, 3) * source.width + feather(i, 101) : source.x + x * source.width;
        const top = small ? source.y + scatter(i, 5) * source.height + feather(i, 307) : source.y + y * source.height;
        const [targetX, targetY] = focalInk?.[Math.floor(i * focalInk.length / count)] ?? [x, y];
        const right = target.x + targetX * target.width;
        const bottom = target.y + targetY * target.height;
        const variation = ((Math.imul(i + 1, 2654435761) >>> 0) % 65536) / 65536;
        const stagger = t.stagger * (0.65 * variation + 0.35 * y) * (small ? 0.6 : 1);
        particles.set([
            left, top, right, bottom, (0.05 + stagger) * t.forwardS, t.travel * t.forwardS,
            t.lift * (0.6 + 0.4 * variation), variation,
        ], i * 8);
    }
    return { particles, small };
}

export function createStepMotionScene(input: Readonly<{
    animation: StepAnimation;
    grid: StepGrid;
    outgoing?: GlyphRect;
    incoming: GlyphRect;
    source?: GlyphRect;
    target?: GlyphRect;
    readFocalInk?: () => StepFocalInk | undefined;
    outgoingInk?: GlyphInkMap;
    incomingInk?: GlyphInkMap;
    ink?: GlyphInk;
    cover?: GlyphInk;
}>): (elapsed: number) => readonly GlyphLayer[] {
    const { animation, grid, outgoing, incoming, source, target, outgoingInk, incomingInk, cover } = input;
    const t = stepMotionTiming;
    const viewport = { x: 0, y: 0, width: grid.width, height: grid.height };
    const building = animation.grammar === 'home' || animation.grammar === 'opening';
    const noInk = { rgba: new Uint8Array(0), cols: 0, rows: 0 };
    const folding = animation.grammar === 'fold' && source !== undefined;
    const climbing = animation.grammar === 'morph';
    const arrivingFromControl = !building && source !== undefined;
    const leaveOrigin = folding ? centre(source) : building && outgoing ? centre(outgoing)
        : { x: grid.width / 2, y: grid.height + grid.width };
    const buildRegion = animation.grammar === 'home' ? incoming : viewport;
    const arriveOrigin = arrivingFromControl ? centre(source) : building
        ? { x: buildRegion.x + buildRegion.width / 2, y: buildRegion.y + buildRegion.height + 60 }
        : leaveOrigin;
    let focalInk = input.readFocalInk?.();
    let travellers = animation.grammar === 'morph' && source && target
        ? makeParticles(source, target, focalInk) : null;
    const ink = input.ink ?? 'sunrise';
    const front = (region: GlyphRect, origin: { x: number; y: number }, p: number) =>
        origin.y - region.y - region.height - t.band + p * (region.height + 2 * t.band);
    return elapsed => {
        if (elapsed >= stepAnimationDuration(animation)) return [];
        const p = readStepProgress(animation, elapsed);
        const visual = visualAt(animation.grammar, p);
        const layers: GlyphLayer[] = [];
        if (outgoing && (visual.leaveFront < 1 || climbing && p < 1)) layers.push(frontGlyphLayer({
            shape: climbing ? 'horizontal' : building || folding ? 'superellipse' : 'roundRect', origin: leaveOrigin, rect: outgoing,
            front: climbing ? leavingEdge(outgoing, visual.leaveFront)
                : building || folding ? revealRadius(outgoing, leaveOrigin) * (1 - visual.leaveFront)
                    : front(outgoing, leaveOrigin, visual.leaveFront),
            band: t.band, ragged: (climbing ? 0.5 : t.ragged) * t.band,
            alpha: climbing ? t.alpha * Math.min(1, p / 0.12) : t.alpha, ink, mode: 'eat', inkMap: outgoingInk ?? noInk,
            climbProgress: climbing ? p : undefined,
        }));
        if ((cover || visual.arriveFront > 0) && visual.arriveFront < 1) {
            const area = animation.grammar === 'opening' && !cover ? viewport : incoming;
            const openingSoft = animation.grammar === 'opening' ? Math.min(1, p * t.openingS / 0.3) : 1;
            layers.push(frontGlyphLayer({
                shape: arrivingFromControl ? 'superellipse' : 'roundRect', origin: arriveOrigin, rect: area,
                front: arrivingFromControl ? revealRadius(area, arriveOrigin) * visual.arriveFront : front(area, arriveOrigin, visual.arriveFront),
                band: t.band * openingSoft, ragged: (building ? 0.14 : t.ragged) * t.band,
                alpha: (animation.grammar === 'opening' ? 0.4 : t.alpha) * openingSoft,
                ink, mode: 'decode', inkMap: building ? undefined : incomingInk ?? noInk, cover,
            }));
        }
        if (travellers && source && target && p > 0 && p < 0.97) {
            const nextInk = input.readFocalInk?.();
            if (nextInk !== focalInk) {
                focalInk = nextInk;
                travellers = makeParticles(source, target, focalInk);
            }
            layers.push(travellerGlyphLayer({
                ...travellers, ink,
                presentationTimeS: p * t.forwardS, stepMorphProgress: p,
            }));
        }
        return layers;
    };
}
