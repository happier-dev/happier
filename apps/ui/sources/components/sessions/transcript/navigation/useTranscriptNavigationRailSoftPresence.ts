import * as React from 'react';
import { Platform, type ViewStyle } from 'react-native';

/**
 * How long a soft-dismissed rail element stays mounted (hidden) so its CSS
 * opacity fade-out can run before unmount. Matches the exit transition
 * duration used by the rail and its hover preview.
 */
export const TRANSCRIPT_NAVIGATION_RAIL_SOFT_EXIT_MS = 120;

export type TranscriptNavigationRailSoftFadeOptions = Readonly<{
    /**
     * Offset the element rests at while hidden; it travels to 0 as it appears,
     * so a positive value enters upward and a negative value enters downward.
     * Dropped entirely under reduced motion, which leaves the plain cross-fade.
     */
    hiddenTranslateYPx?: number;
}>;

/**
 * Soft fade paired with the presence hook: enter eases out over 140ms, exit
 * eases in within the `TRANSCRIPT_NAVIGATION_RAIL_SOFT_EXIT_MS` unmount
 * window. Reduced motion (and native, where the rail never renders) snaps
 * instantly. Apply this on the element that owns any backdrop-filter — an
 * opacity-animated ancestor of a glass surface silently defeats its blur on
 * web, which is why `hiddenTranslateYPx` stays opt-in rather than default.
 *
 * This is the rail family's only fade/translate grammar; callers pass an
 * offset here instead of hand-rolling a second set of durations and curves.
 */
export function resolveTranscriptNavigationRailSoftFadeStyle(
    shown: boolean,
    reducedMotion: boolean,
    options?: TranscriptNavigationRailSoftFadeOptions,
): ViewStyle {
    if (reducedMotion || Platform.OS !== 'web') {
        return { opacity: shown ? 1 : 0 };
    }
    const hiddenTranslateYPx = typeof options?.hiddenTranslateYPx === 'number' && Number.isFinite(options.hiddenTranslateYPx)
        ? options.hiddenTranslateYPx
        : 0;
    // react-native-web supports transition* style props; cast at this web boundary.
    const fade = {
        opacity: shown ? 1 : 0,
        // Never a blanket `transition: all` — only the properties that move.
        transitionProperty: hiddenTranslateYPx === 0 ? 'opacity' : 'opacity, transform',
        transitionDuration: shown ? '140ms' : '110ms',
        transitionTimingFunction: shown ? 'ease-out' : 'ease-in',
    };
    if (hiddenTranslateYPx === 0) return fade as unknown as ViewStyle;
    return {
        ...fade,
        transform: [{ translateY: shown ? 0 : hiddenTranslateYPx }],
    } as unknown as ViewStyle;
}

export type TranscriptNavigationRailSoftPresence = Readonly<{
    /** Whether the element should be in the tree at all. */
    mounted: boolean;
    /** Whether the element should render at full opacity (drives the CSS fade). */
    shown: boolean;
}>;

/**
 * Soft appear/disappear presence for the navigation rail and its hover
 * preview: opening mounts immediately and flips `shown` on the next frame so
 * an opacity transition can run from 0 → 1; closing hides immediately
 * (`shown: false`) and defers unmount by the exit window so the fade-out is
 * visible. Reduced motion bypasses both — mount and unmount are instant.
 *
 * Opacity-only by design: the preview renders on a backdrop-filter glass
 * surface, and animating transform (or opacity) on an ancestor of that
 * surface silently defeats the blur on web. Callers must apply the faded
 * opacity on the glass element itself, never on a positioned wrapper.
 */
export function useTranscriptNavigationRailSoftPresence(
    open: boolean,
    reducedMotion: boolean,
): TranscriptNavigationRailSoftPresence {
    const [mounted, setMounted] = React.useState(open);
    const [shown, setShown] = React.useState(open);
    const shownRef = React.useRef(open);
    shownRef.current = shown;

    React.useEffect(() => {
        if (open) {
            setMounted(true);
            if (shownRef.current) return;
            if (reducedMotion || typeof globalThis.requestAnimationFrame !== 'function') {
                setShown(true);
                return;
            }
            // Flip shown one frame after mount so the browser commits the
            // opacity: 0 state first and the 0 → 1 transition actually runs.
            const frame = globalThis.requestAnimationFrame(() => setShown(true));
            return () => {
                if (typeof globalThis.cancelAnimationFrame === 'function') {
                    globalThis.cancelAnimationFrame(frame);
                }
            };
        }

        setShown(false);
        if (reducedMotion) {
            setMounted(false);
            return;
        }
        const timeout = setTimeout(() => setMounted(false), TRANSCRIPT_NAVIGATION_RAIL_SOFT_EXIT_MS);
        return () => clearTimeout(timeout);
    }, [open, reducedMotion]);

    return { mounted, shown };
}
