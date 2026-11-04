import { captureElementFlightRect, playElementRectDeparture, playElementRectFlight } from '@/components/ui/motion/rectFlight';
import { motionTokens, resolveInPlaceMorphTiming } from '@/components/ui/motion/motionTokens';

import type { CaptureRect } from './resolveCaptureWindowFrame';

/** MIS §6: the picture fades in the last part of its flight, so it lands as it disappears. */
const FLIGHT_FADE_MS = 60;
/** MIS §6: it lifts a breath under the press before it leaves. */
const FLIGHT_LIFT_SCALE = 1.02;
/** MIS §6: the pill drops this far as it leaves. */
const PILL_EXIT_DROP_PX = 4;

const MORPH_ID = 'capture-window-morph';
const PILL_HOLD_ID = 'capture-window-pill-hold';
const standard = motionTokens.easingCss.standard;

/** Each animation ends in its final state and can be interrupted by the next one. */
function settled(animation: Animation | null | undefined): Promise<void> {
    if (!animation) return Promise.resolve();
    return animation.finished.then(() => undefined, () => undefined);
}

function cancelMorph(elements: readonly (HTMLElement | null)[]): void {
    for (const element of elements) {
        for (const animation of element?.getAnimations?.() ?? []) {
            if (animation.id === MORPH_ID) animation.cancel();
        }
    }
}

const px = (rect: CaptureRect, radius: number) => ({
    left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, borderRadius: `${radius}px`,
});

function clip(rect: CaptureRect, window: CaptureRect, radius: number): string {
    const top = rect.y - window.y;
    const left = rect.x - window.x;
    const right = window.x + window.width - rect.x - rect.width;
    const bottom = window.y + window.height - rect.y - rect.height;
    return `inset(${top}px ${right}px ${bottom}px ${left}px round ${radius}px)`;
}

export type CapturePaperElements = Readonly<{
    /** The drawn paper (fill, rim, shadow): the only box whose layout animates. */
    paper: HTMLElement;
    /** Everything on the paper, laid out once at the window's size and revealed by a clip. */
    content: HTMLElement;
}>;

/** The paper grows between two rects; what stands on it never reflows (`inPlaceMorph`). */
function morphPaper(elements: CapturePaperElements, input: Readonly<{
    from: CaptureRect;
    to: CaptureRect;
    /** The content's own rect. */
    window: CaptureRect;
    radiusFrom: number;
    radiusTo: number;
    durationMs: number;
}>): Promise<void> {
    cancelMorph([elements.paper, elements.content]);
    const options = { duration: input.durationMs, easing: standard, fill: 'forwards' as const };
    const paper = elements.paper.animate([px(input.from, input.radiusFrom), px(input.to, input.radiusTo)], options);
    paper.id = MORPH_ID;
    const content = elements.content.animate([
        { clipPath: clip(input.from, input.window, input.radiusFrom) },
        { clipPath: clip(input.to, input.window, input.radiusTo) },
    ], options);
    content.id = MORPH_ID;
    return settled(paper);
}

function fade(elements: readonly HTMLElement[], from: number, to: number, durationMs: number, delayMs = 0, easing = standard): Promise<void> {
    return Promise.all(elements.map((element) => settled(element.animate(
        [{ opacity: from }, { opacity: to }],
        { duration: durationMs, delay: delayMs, easing, fill: 'both' },
    )))).then(() => undefined);
}

/** MIS §2.1: the area becomes the window. The picture stays put, or glides when it was clamped or fitted. */
export async function playOpenFromArea(elements: CapturePaperElements & Readonly<{ picture: HTMLElement; chrome: readonly HTMLElement[] }>, input: Readonly<{
    area: CaptureRect;
    /** The area in the page's coordinates, for the picture's flight. */
    areaInPage: CaptureRect;
    window: CaptureRect;
    radius: number;
    reducedMotion: boolean;
}>): Promise<void> {
    const timing = resolveInPlaceMorphTiming(input.reducedMotion);
    if (input.reducedMotion) {
        await fade([elements.paper, elements.content], 0, 1, timing.contentFadeMs);
        return;
    }
    void fade(elements.chrome, 0, 1, timing.contentFadeMs, timing.contentDelayMs);
    playElementRectFlight(elements.picture, {
        x: input.areaInPage.x, y: input.areaInPage.y, width: input.areaInPage.width, height: input.areaInPage.height,
    }, { animationId: 'capture-window-picture', durationMs: timing.frameMs });
    await morphPaper(elements, {
        from: input.area, to: input.window, window: input.window, radiusFrom: 0, radiusTo: input.radius, durationMs: timing.frameMs,
    });
}

/** MIS §2.2: nothing to grow from, so the window arrives like a dialog. */
export async function playOpenCentred(root: HTMLElement, reducedMotion: boolean): Promise<void> {
    const modal = motionTokens.overlay.modal;
    if (reducedMotion) {
        await fade([root], 0, 1, motionTokens.inPlaceMorph.reducedCrossFadeMs);
        return;
    }
    await settled(root.animate([
        { opacity: 0, transform: `translateY(${modal.fromTranslateY}px) scale(${modal.fromScale})` },
        { opacity: 1, transform: 'none' },
    ], { duration: modal.enterMs, easing: standard, fill: 'both' }));
}

/** MIS §2.4: the window leaves, from wherever it is. */
export async function playWindowExit(root: HTMLElement, reducedMotion: boolean): Promise<void> {
    const modal = motionTokens.overlay.modal;
    if (reducedMotion) {
        await fade([root], 1, 0, motionTokens.inPlaceMorph.reducedCrossFadeMs);
        return;
    }
    await settled(root.animate([
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: `scale(${modal.fromScale})` },
    ], { duration: modal.exitMs, easing: motionTokens.easingCss.exit, fill: 'both' }));
}

/**
 * MIS §6, Send and Add to draft: the picture lifts, flies into the Session chip's mark, the chip takes one
 * ring, the content clears and the empty paper folds into the pill. It resolves when the pill stands.
 */
export async function playDeliveryMoment(elements: CapturePaperElements & Readonly<{
    picture: HTMLElement;
    chipMark: HTMLElement;
    chip: HTMLElement;
    chrome: readonly HTMLElement[];
    pill: HTMLElement;
}>, input: Readonly<{
    window: CaptureRect;
    pillRect: CaptureRect;
    radius: number;
    pillRadius: number;
    ringColor: string;
    reducedMotion: boolean;
}>): Promise<void> {
    const moment = motionTokens.successMoment;
    const morph = resolveInPlaceMorphTiming(input.reducedMotion);
    // The pill stands inside the window until the fold brings it out.
    elements.pill.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 1, fill: 'forwards' }).id = PILL_HOLD_ID;
    const release = () => {
        for (const animation of elements.pill.getAnimations?.() ?? []) {
            if (animation.id === PILL_HOLD_ID) animation.cancel();
        }
    };
    if (input.reducedMotion) {
        // No two texts overlap (MIS §11): the note clears, the paper becomes the pill, then the pill speaks.
        await fade([elements.picture], 1, 0, moment.reducedCrossFadeMs);
        await fade([elements.content], 1, 0, moment.reducedCrossFadeMs);
        await morphPaper(elements, {
            from: input.pillRect, to: input.pillRect, window: input.window,
            radiusFrom: input.pillRadius, radiusTo: input.pillRadius, durationMs: 0,
        });
        const appear = fade([elements.pill], 0, 1, moment.reducedCrossFadeMs);
        release();
        await appear;
        return;
    }
    await settled(elements.picture.animate(
        [{ transform: 'none' }, { transform: `scale(${FLIGHT_LIFT_SCALE})` }],
        { duration: moment.gatherMs, easing: standard },
    ));
    await settled(playElementRectDeparture(elements.picture, captureElementFlightRect(elements.chipMark), {
        animationId: 'capture-window-picture', durationMs: moment.travelMs,
        easingCss: motionTokens.easingCss.stageCamera, fadeMs: FLIGHT_FADE_MS,
    }));
    void settled(elements.chip.animate(
        [{ boxShadow: `0 0 0 2px ${input.ringColor}` }, { boxShadow: `0 0 0 2px transparent` }],
        { duration: moment.ringMs, easing: standard },
    ));
    await fade([...elements.chrome], 1, 0, morph.coveredFadeMs);
    void fade([elements.pill], 0, 1, morph.contentFadeMs, morph.contentDelayMs);
    release();
    await morphPaper(elements, {
        from: input.window, to: input.pillRect, window: input.window,
        radiusFrom: input.radius, radiusTo: input.pillRadius, durationMs: morph.frameMs,
    });
}

/** MIS §2.5: the same fold with nothing to carry; the picture simply clears with the rest. */
export async function playDiscardFold(elements: CapturePaperElements & Readonly<{
    picture: HTMLElement;
    chrome: readonly HTMLElement[];
    pill: HTMLElement;
}>, input: Readonly<{
    window: CaptureRect;
    pillRect: CaptureRect;
    radius: number;
    pillRadius: number;
    reducedMotion: boolean;
}>): Promise<void> {
    const morph = resolveInPlaceMorphTiming(input.reducedMotion);
    await fade([...elements.chrome, elements.picture], 1, 0, morph.coveredFadeMs);
    void fade([elements.pill], 0, 1, morph.contentFadeMs, morph.contentDelayMs);
    await morphPaper(elements, {
        from: input.window, to: input.pillRect, window: input.window,
        radiusFrom: input.radius, radiusTo: input.pillRadius, durationMs: morph.frameMs,
    });
}

/** MIS §6, Edit on a failed pill: the fold runs backwards and everything is as it was. */
export async function playPillReopen(elements: CapturePaperElements & Readonly<{
    picture: HTMLElement;
    chrome: readonly HTMLElement[];
    pill: HTMLElement;
}>, input: Readonly<{
    window: CaptureRect;
    pillRect: CaptureRect;
    radius: number;
    pillRadius: number;
    reducedMotion: boolean;
}>): Promise<void> {
    const morph = resolveInPlaceMorphTiming(input.reducedMotion);
    for (const element of [elements.picture, ...elements.chrome, elements.pill]) {
        for (const animation of element.getAnimations?.() ?? []) animation.cancel();
    }
    if (input.reducedMotion) {
        cancelMorph([elements.paper, elements.content]);
        await fade([elements.paper, elements.content], 0, 1, morph.contentFadeMs);
        return;
    }
    void fade([elements.pill], 1, 0, morph.coveredFadeMs);
    void fade(elements.chrome, 0, 1, morph.contentFadeMs, morph.contentDelayMs);
    await morphPaper(elements, {
        from: input.pillRect, to: input.window, window: input.window,
        radiusFrom: input.pillRadius, radiusTo: input.radius, durationMs: morph.frameMs,
    });
}

/** The motion is over: the layout owns the rect again, so a moved native frame can't strand a stale fill. */
export function releasePaper(elements: CapturePaperElements): void {
    cancelMorph([elements.paper, elements.content]);
}

/** MIS §6: the pill leaves with a small drop. */
export async function playPillExit(paper: HTMLElement, reducedMotion: boolean): Promise<void> {
    const modal = motionTokens.overlay.modal;
    await settled(paper.animate([
        { opacity: 1, translate: '0 0' },
        { opacity: 0, translate: reducedMotion ? '0 0' : `0 ${PILL_EXIT_DROP_PX}px` },
    ], { duration: modal.exitMs, easing: motionTokens.easingCss.exit, fill: 'forwards' }));
}
