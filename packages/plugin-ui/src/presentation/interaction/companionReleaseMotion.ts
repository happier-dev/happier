/**
 * How a thrown companion comes to rest.
 *
 * This is the part of drag that is **not** shared. The pet arrives with a small overshoot that is
 * clipped (`dampingRatio 0.78`, `overshootClamping`); the Voice orb is critically damped and
 * settles without bouncing at all. Both also disagree about *where* a flick is aiming: the pet
 * springs to the point the finger left, the orb projects the throw forward before choosing an edge.
 *
 * Leaving either fact hard-coded inside the drag hooks is the whole reason this module exists — a
 * shared hook with the pet's spring baked in silently gives the orb the pet's bounce.
 */
export type CompanionReleaseMotion = Readonly<{
    /** Spring duration in ms. */
    durationMs: number;
    /** `1` is the no-overshoot boundary; below it the object overshoots and returns. */
    dampingRatio: number;
    /**
     * Clip the overshoot instead of removing it at the source. Clamping puts a hard edge on the
     * final milliseconds, so it is only worth it when the spring genuinely overshoots.
     */
    overshootClamping: boolean;
    /**
     * Hand the release velocity to the spring, per axis, so the object leaves the finger at exactly
     * the speed it was thrown. Removing bounce must not remove continuity.
     */
    carryVelocity: boolean;
    /**
     * Apple's exponential-decay momentum projection coefficient in seconds
     * (`projected = current + velocity × seconds`). `0` means "no projection": the object settles
     * where the finger let go.
     */
    projectionSeconds: number;
}>;

export type CompanionReleaseSpringConfig = Readonly<{
    duration: number;
    dampingRatio: number;
    overshootClamping?: boolean;
    velocity?: number;
}>;

/**
 * Single owner of `CompanionReleaseMotion → reanimated spring config`. Both companions go through
 * it, so "the orb inherited the pet's spring" is a test failure rather than a visual regression.
 */
export function resolveCompanionReleaseSpringConfig(
    motion: CompanionReleaseMotion,
    velocity?: number,
): CompanionReleaseSpringConfig {
    'worklet';
    return {
        duration: motion.durationMs,
        dampingRatio: motion.dampingRatio,
        ...(motion.overshootClamping ? { overshootClamping: true } : {}),
        ...(motion.carryVelocity && typeof velocity === 'number' && Number.isFinite(velocity)
            ? { velocity }
            : {}),
    };
}

/**
 * Where the throw is aiming. Projection picks the *target*; the velocity handoff above makes the
 * *motion* continuous. They answer different questions and are both required.
 */
export function projectCompanionRelease(
    value: number,
    velocity: number,
    motion: CompanionReleaseMotion,
): number {
    'worklet';
    if (!Number.isFinite(velocity) || motion.projectionSeconds === 0) return value;
    return value + velocity * motion.projectionSeconds;
}
