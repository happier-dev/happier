import { frontGlyphLayer, travellerGlyphLayer, type GlyphInk, type GlyphInkMap, type GlyphLayer, type GlyphRect } from '@happier-dev/brand/glyph-scene';

import { progressAt, revealRadius, visualAt, type StepGrammar } from './stepMotionChoreography';
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

function makeParticles(source: GlyphRect, target: GlyphRect) {
    const t = stepMotionTiming;
    const small = source.width * source.height < t.smallArea;
    const count = Math.min(t.particleLimit, Math.max(small ? t.smallMinimum : 1,
        Math.round(Math.max(source.width * source.height, target.width * target.height) * t.particleDensity / t.particleArea)));
    const cols = Math.max(1, Math.round(Math.sqrt(count * Math.max(1, target.width) / Math.max(1, target.height))));
    const rows = Math.ceil(count / cols);
    const particles = new Float32Array(count * 8);
    for (let i = 0; i < count; i++) {
        const x = (i % cols + 0.5) / cols;
        const y = (Math.floor(i / cols) + 0.5) / rows;
        const halo = small ? t.smallHalo : 0;
        const left = source.x - halo + x * (source.width + 2 * halo);
        const top = source.y - halo + y * (source.height + 2 * halo);
        const right = target.x + x * target.width;
        const bottom = target.y + y * target.height;
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
    outgoingInk?: GlyphInkMap;
    incomingInk?: GlyphInkMap;
    ink?: GlyphInk;
    controlInk?: GlyphInk;
    cover?: GlyphInk;
}>): (elapsed: number) => readonly GlyphLayer[] {
    const { animation, grid, outgoing, incoming, source, target, outgoingInk, incomingInk, cover } = input;
    const t = stepMotionTiming;
    const viewport = { x: 0, y: 0, width: grid.width, height: grid.height };
    const building = animation.grammar === 'home' || animation.grammar === 'opening';
    const folding = animation.grammar === 'fold' && source !== undefined;
    const arrivingFromControl = !building && source !== undefined;
    const leaveOrigin = folding ? centre(source) : building && outgoing ? centre(outgoing)
        : { x: grid.width / 2, y: grid.height + grid.width };
    const arriveOrigin = arrivingFromControl ? centre(source) : building ? { x: grid.width / 2, y: grid.height + 60 } : leaveOrigin;
    const travellers = animation.grammar === 'morph' && source && target
        ? makeParticles(source, target) : null;
    const ink = input.ink ?? 'sunrise';
    const front = (region: GlyphRect, origin: { x: number; y: number }, p: number) =>
        origin.y - region.y - region.height - t.band + p * (region.height + 2 * t.band);
    return elapsed => {
        if (elapsed >= stepAnimationDuration(animation)) return [];
        const p = readStepProgress(animation, elapsed);
        const visual = visualAt(animation.grammar, p);
        const layers: GlyphLayer[] = [];
        if (outgoing && visual.leaveFront < 1) layers.push(frontGlyphLayer({
            shape: building || folding ? 'superellipse' : 'roundRect', origin: leaveOrigin, rect: outgoing,
            front: building || folding ? revealRadius(outgoing, leaveOrigin) * (1 - visual.leaveFront)
                : front(outgoing, leaveOrigin, visual.leaveFront),
            band: t.band, ragged: t.ragged * t.band, alpha: t.alpha, ink, mode: 'eat', inkMap: outgoingInk,
        }));
        if ((cover || visual.arriveFront > 0) && visual.arriveFront < 1) {
            const area = building && !cover ? viewport : incoming;
            const openingSoft = animation.grammar === 'opening' ? Math.min(1, p * t.openingS / 0.3) : 1;
            layers.push(frontGlyphLayer({
                shape: arrivingFromControl ? 'superellipse' : 'roundRect', origin: arriveOrigin, rect: area,
                front: arrivingFromControl ? revealRadius(area, arriveOrigin) * visual.arriveFront : front(area, arriveOrigin, visual.arriveFront),
                band: t.band * openingSoft, ragged: (building ? 0.14 : t.ragged) * t.band,
                alpha: (animation.grammar === 'opening' ? 0.4 : t.alpha) * openingSoft,
                ink, mode: 'decode', inkMap: incomingInk, cover,
            }));
        }
        if (travellers && p > 0 && p < 0.97) layers.push(travellerGlyphLayer({
            ...travellers, ink: travellers.small ? input.controlInk ?? ink : ink,
            presentationTimeS: p * t.forwardS, stepMorphProgress: p,
        }));
        return layers;
    };
}
