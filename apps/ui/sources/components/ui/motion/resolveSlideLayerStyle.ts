/**
 * Pure, worklet-safe layer-style helper for `SlideTransitionFrame`.
 *
 * The `'worklet';` directive lets Reanimated execute this on the UI thread inside
 * `useAnimatedStyle`. When called from JS (unit tests, fallback paths), Reanimated
 * treats it as an ordinary function — no Reanimated import required.
 *
 * Math (validated by `resolveSlideLayerStyle.test.ts`):
 *   - `current`: `translateX = distance * progress`; `opacity = 1 - |progress|`.
 *   - `previous`: `translateX = distance * (progress - 1)`; `opacity = max(0, progress)`.
 *   - `next`: `translateX = distance * (progress + 1)`; `opacity = max(0, -progress)`.
 *   - `blurPx` (same for all roles): `interpolate(|progress|, [0, 0.5, 1], [0, maxBlur, 0])`.
 *
 * At progress=0: only `current` visible at center. `previous` off-screen left, `next`
 * off-screen right. At progress=+1 (committed previous): only `previous` visible at
 * center; `current` slid right out. At progress=-1 (committed next): only `next` visible
 * at center; `current` slid left out. The blur curve peaks at midpoint and returns to
 * zero at extremes — matches the reference screenshots.
 */

export type SlideLayerRole = 'previous' | 'current' | 'next';

export type SlideLayerStyle = Readonly<{
    translateX: number;
    opacity: number;
    blurPx: number;
}>;

export type ResolveSlideLayerStyleParams = Readonly<{
    role: SlideLayerRole;
    /** -1..1; -1 = next fully in view; 0 = current fully in view; +1 = previous fully in view. */
    progress: number;
    /** px translation distance for non-current layers at progress=0. */
    distance: number;
    /** Peak blur (px on web; the blur layer scales to native intensity). 0 disables blur entirely. */
    maxBlur: number;
}>;

function computeBlurPx(absProgress: number, maxBlur: number): number {
    'worklet';
    if (maxBlur === 0) return 0;
    if (absProgress <= 0) return 0;
    if (absProgress >= 1) return 0;
    if (absProgress < 0.5) {
        return maxBlur * (absProgress / 0.5);
    }
    return maxBlur * ((1 - absProgress) / 0.5);
}

export function resolveSlideLayerStyle(params: ResolveSlideLayerStyleParams): SlideLayerStyle {
    'worklet';
    const { role, progress, distance, maxBlur } = params;
    const absP = progress < 0 ? -progress : progress;
    const blurPx = computeBlurPx(absP, maxBlur);

    if (role === 'current') {
        return { translateX: distance * progress, opacity: 1 - absP, blurPx };
    }
    if (role === 'previous') {
        return {
            translateX: distance * (progress - 1),
            opacity: progress > 0 ? progress : 0,
            blurPx,
        };
    }
    return {
        translateX: distance * (progress + 1),
        opacity: progress < 0 ? -progress : 0,
        blurPx,
    };
}
