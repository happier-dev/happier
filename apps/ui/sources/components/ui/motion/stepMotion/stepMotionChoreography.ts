import type { StepMoveKind } from './stepMotionTypes';
import type { GlyphPoint, GlyphRect } from '@happier-dev/brand/glyph-scene';
import { stepMotionTiming } from './stepMotionTiming';

export type StepGrammar = 'fade' | 'morph' | 'fold' | 'home' | 'opening';

export function resolveMoveGrammar(input: Readonly<{
    kind: StepMoveKind;
    reduced: boolean;
    compact: boolean;
    fromWelcome?: boolean;
    toWelcome?: boolean;
}>): StepGrammar {
    if (input.reduced || input.kind === 'notice') return 'fade';
    if (input.kind === 'home') return 'home';
    if (input.compact && (input.fromWelcome || input.toWelcome)) return 'fold';
    return 'morph';
}

const segment = (p: number, start: number, end: number) => Math.min(1, Math.max(0, (p - start) / (end - start)));
export const easeInOutCubic = (p: number) => p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
const smooth = (p: number) => p * p * (3 - 2 * p);

function climbPace(p: number) {
    const knee = 1.5 / (3.6 - 3.6 * stepMotionTiming.homeClimbStart);
    return p < knee
        ? 0.62 * (1 - (1 - p / knee) ** 3)
        : 0.62 + 0.38 * easeInOutCubic(segment(p, knee, 1));
}

const homeClimbAtClear = climbPace(segment(stepMotionTiming.homeClear, stepMotionTiming.homeClimbStart, 1));

export function radialDistance(x: number, y: number, origin: GlyphPoint): number {
    return Math.hypot((x - origin.x) ** 2, (y - origin.y) ** 2) ** 0.5;
}

export function revealRadius(region: GlyphRect, origin: GlyphPoint): number {
    const x = Math.max(Math.abs(region.x - origin.x), Math.abs(region.x + region.width - origin.x));
    const y = Math.max(Math.abs(region.y - origin.y), Math.abs(region.y + region.height - origin.y));
    return radialDistance(x, y, { x: 0, y: 0 });
}

export function progressAt(from: number, to: number, elapsed: number): number {
    const travel = Math.min(Math.abs(to - from), Math.max(0, elapsed));
    return from + Math.sign(to - from) * travel;
}

export function visualAt(grammar: Exclude<StepGrammar, 'fade'>, p: number) {
    if (grammar === 'opening') {
        const { openingS, openingSoftStartS } = stepMotionTiming;
        const elapsed = segment(p, 0, 1) * openingS;
        const travel = elapsed < openingSoftStartS
            ? elapsed ** 2 / (2 * openingSoftStartS)
            : elapsed - openingSoftStartS / 2;
        const arriveFront = travel / (openingS - openingSoftStartS / 2);
        return { leave: 0, arrive: arriveFront, pressed: 0, focal: 0, leaveFront: 1, arriveFront };
    }
    if (grammar === 'home') {
        const leaveFront = easeInOutCubic(segment(p, 0, stepMotionTiming.homeClear));
        const pace = climbPace(segment(p, stepMotionTiming.homeClimbStart, 1));
        // Home's early climb travels below the window while the outgoing digits clear.
        const arriveFront = segment(pace, homeClimbAtClear, 1);
        return {
            leave: 1 - leaveFront,
            arrive: arriveFront,
            pressed: 0,
            focal: 0,
            leaveFront,
            arriveFront,
        };
    }
    const leaveFront = easeInOutCubic(segment(p, 0, 0.55));
    const arriveFront = easeInOutCubic(segment(p, 0.2, 1));
    return {
        leave: 1 - leaveFront,
        arrive: arriveFront,
        pressed: 1 - smooth(segment(p, 0, 0.06)),
        focal: smooth(segment(p, 0.8, 0.95)),
        leaveFront,
        arriveFront,
    };
}
