import { HAPPIER_MOTION_V1, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';
import { Easing } from 'react-native';

export const motionTokens = {
    gesture: {
        /** Shared movement tolerance before a tap becomes a drag. */
        slopPx: 12,
        doubleTapMs: 300,
        /** A held on-screen key (the editor's arrow keys) repeats like a hardware key: first after the delay, then every interval. */
        keyRepeatDelayMs: 400,
        keyRepeatIntervalMs: 60,
    },
    durationMs: {
        instant: 0,
        /** Press acknowledgement: fast enough to feel immediate under the finger. */
        press: HAPPIER_PRESS_FEEDBACK_V1.pressMs,
        /** Press release settle: slower than the press so a cancelled press eases back. */
        release: HAPPIER_PRESS_FEEDBACK_V1.releaseMs,
        // The state-transition scale core and plugin controls share (a switch's fade and slide);
        // plugin-ui's presentation layer owns the values (`interaction/motion.ts`).
        /** Hover paints colour only, never movement (`HAPPIER_MOTION_V1.hoverMs`). */
        hover: HAPPIER_MOTION_V1.hoverMs,
        fast: HAPPIER_MOTION_V1.fastMs,
        base: HAPPIER_MOTION_V1.baseMs,
        slow: HAPPIER_MOTION_V1.slowMs,
        stageCrossfade: 320,
        stageCamera: 1000,
    },
    /**
     * Pressed-state values shared by every press-feedback owner.
     * `scale`: tactile press (never below 0.95; smaller reads as exaggerated).
     * `opacity`: the standard pressed dip (icons, glyphs, compact controls, reduced motion).
     * `opacitySubtle`: the gentler dip for large text-led cards and rows, where a
     * full-strength dip would flash the whole surface.
     * `opacitySurface`: the near-static acknowledgement for whole elevated card surfaces
     * (`SurfaceCard`), where even `opacitySubtle` would wash out the card and its shadow;
     * mirrors plugin-ui `Surface`'s pressed dip.
     */
    // One press vocabulary for core and plugin surfaces; plugin-ui's shared
    // presentation layer owns the values (`interaction/pressFeedback.ts`).
    press: {
        scale: HAPPIER_PRESS_FEEDBACK_V1.scale,
        opacity: HAPPIER_PRESS_FEEDBACK_V1.opacity,
        opacitySubtle: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle,
        opacitySurface: HAPPIER_PRESS_FEEDBACK_V1.opacitySurface,
    },
    /** How long a done-with-Undo line stays before it leaves on its own (owner ruling: 5 s). A pointer resting on it holds it. */
    undoHoldMs: 5_000,
    overlay: {
        popover: {
            enterMs: 140,
            exitMs: 120,
            fromScale: 0.98,
            fromDistance: 8,
            /**
             * How long a pointer rests on a trigger before its popover previews (sidebar Usage).
             * Long enough that passing over the button does not flash it open.
             */
            hoverOpenDelayMs: 300,
            /**
             * The app rail is a dock: resting this long on one of its icons previews it. A pointer
             * crossing the rail spends well under this on each icon (a ~40 px pitch), so a pass does
             * not flash; once a rail preview shows, the next icon answers at once (`HoverPreviewScope`).
             */
            dockHoverOpenDelayMs: 140,
        },
        /**
         * Popovers and menus grow from their trigger and leave faster than they arrive; dialogs fade
         * and scale a little. Under reduced motion both become a short cross-fade (`reducedMotionFadeMs`).
         */
        modal: {
            enterMs: 200,
            exitMs: 160,
            fromScale: 0.98,
            fromTranslateY: 10,
            backdropMaxOpacity: 0.5,
        },
        /**
         * A panel that slides in from the edge it stands on, as a layer over what is there (the
         * rail's column peek): a short travel in, a quicker way out, and a fade alone under reduced
         * motion.
         */
        panel: {
            enterMs: HAPPIER_MOTION_V1.baseMs,
            exitMs: HAPPIER_MOTION_V1.fastMs,
            reducedMotionFadeMs: HAPPIER_MOTION_V1.fastMs,
            /** A panel standing in another's place (a peek over the open column) cross-fades with it, both ways. */
            crossfadeMs: HAPPIER_MOTION_V1.fastMs,
        },
    },
    /**
     * A tile that grows in place into what it offers (Home → Get set up → Add your phone): the frame
     * grows over `frameMs`, the tiles it covers fade in `coveredFadeMs`, and its content arrives
     * `contentDelayMs` in. Reduced motion swaps at once with a `reducedCrossFadeMs` cross-fade.
     */
    /**
     * The Media stage (lab files MS1k): the picture flies on `useRectFlip`, the backdrop rides the same
     * progress, and the floating chrome fades in at `durationMs.fast` once the flight is `chromeDelayMs` in.
     */
    mediaStage: {
        chromeDelayMs: 80,
    },
    inPlaceMorph: {
        frameMs: 240,
        coveredFadeMs: 120,
        contentDelayMs: 80,
        reducedCrossFadeMs: 120,
    },
    /**
     * A write's success moment (Git lab SX): what you acted on moves to where it now lives. The commit's rows
     * gather into a chip (0–140 ms), the chip travels to the timeline (140–340 ms) and lands as the newest node
     * (340–440 ms, one ring of `ringMs`). Nodes that change state fill one after another (`fillStaggerMs` bottom-up
     * after a push, `solidifyStaggerMs` top-down after a pull). Reduced motion: a `reducedCrossFadeMs` cross-fade
     * to the end state, no travel, no ring, no stagger.
     */
    /**
     * A page header entering from the row that opened it (MPG-32, lab `MO` 3): the mark and name travel from the
     * row's rect over `travelMs` on the strong ease-out; the sentence, facts and actions fade in over its last
     * `contentFadeMs`. Reduced motion: a `reducedCrossFadeMs` cross-fade, nothing travels.
     */
    headerEnter: {
        travelMs: 320,
        contentFadeMs: 140,
        reducedCrossFadeMs: 160,
    },
    successMoment: {
        gatherMs: 140,
        travelMs: 200,
        landMs: 100,
        ringMs: 360,
        fillStaggerMs: 40,
        fillMs: 120,
        solidifyStaggerMs: 120,
        checkMs: 160,
        reducedCrossFadeMs: 120,
    },
    /**
     * Home's atmosphere (plan R-10, R-13): a picture arrives over `readyFadeMs` and never holds Home's
     * content; on send the ordered fade climbs the band over `sendDissolveMs`. Any other leaving (a
     * picture taking over, a moment holding the planet) is a quicker `leaveFadeMs` fade on the exit
     * curve. Reduced motion turns each into a `reducedCrossFadeMs` cross-fade.
     */
    atmosphere: {
        readyFadeMs: 500,
        leaveFadeMs: 300,
        sendDissolveMs: 600,
        reducedCrossFadeMs: 140,
    },
    /**
     * A Session's guard moments (plan 50 GM, lab `rg`): the composer status line cross-fades between
     * warning, stopped and waking over `lineCrossFadeMs`; the list row's word (idle time · Stops in ·
     * Stopped) over `wordCrossFadeMs`; a fresh stop marker rises `markerRisePx` into the transcript over
     * `markerRiseMs`. Reduced motion: the text changes at once.
     */
    guardMoment: {
        lineCrossFadeMs: 200,
        wordCrossFadeMs: 160,
        markerRiseMs: 200,
        markerRisePx: 6,
    },
    /** One file publication's changed-line tint; subsequent publications redirect the fade. */
    liveEdit: {
        flashMs: 1200,
    },
    /**
     * A carried object (a Board card picked up on the Canvas): it grows by `liftScale` as it leaves the
     * surface, on the travel spring, and sinks back as it lands. Reduced motion: no scale; the shadow
     * alone says it is lifted.
     */
    drag: {
        liftScale: 1.02,
    },
    /**
     * Springs for things a person watches travel or reshape (the agent's cursor gliding to its next
     * target, a capsule morphing between states). Critically damped (`dampingRatio: 1`): it settles,
     * it never overshoots or wobbles, and a new target redirects it from where it is with its
     * velocity kept. Duration-based, so the same spring reads the same at any distance.
     * Reduced motion: callers place the value at once instead.
     */
    spring: {
        travel: { durationMs: 320, dampingRatio: 1 },
    },
    easing: {
        standard: Easing.bezier(...HAPPIER_MOTION_V1.standardBezier),
        /** Leaving content: starts slow and accelerates away (the table's columns fading as a row opens). */
        exit: Easing.bezier(0.4, 0, 1, 1),
        stageCamera: Easing.bezier(0.22, 0.82, 0.2, 1),
        linear: Easing.linear,
    },
    easingCss: {
        standard: HAPPIER_MOTION_V1.standardEasingCss,
        exit: 'cubic-bezier(0.4, 0, 1, 1)',
        stageCamera: 'cubic-bezier(0.22, 0.82, 0.2, 1)',
    },
} as const;

export type InPlaceMorphTiming = Readonly<{
    frameMs: number;
    coveredFadeMs: number;
    contentDelayMs: number;
    contentFadeMs: number;
    clockMs: number;
}>;

/** One timeline for in-place growth and its opacity tracks, including reduced motion. */
export function resolveInPlaceMorphTiming(reducedMotion: boolean): InPlaceMorphTiming {
    const morph = motionTokens.inPlaceMorph;
    const frameMs = reducedMotion ? 0 : morph.frameMs;
    const coveredFadeMs = reducedMotion ? morph.reducedCrossFadeMs : morph.coveredFadeMs;
    const contentDelayMs = reducedMotion ? 0 : morph.contentDelayMs;
    return {
        frameMs,
        coveredFadeMs,
        contentDelayMs,
        contentFadeMs: reducedMotion ? morph.reducedCrossFadeMs : frameMs - contentDelayMs,
        clockMs: Math.max(frameMs, coveredFadeMs),
    };
}
