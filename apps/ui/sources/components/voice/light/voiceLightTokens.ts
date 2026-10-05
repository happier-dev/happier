import { PLANET_LIGHT_RAMP } from '@happier-dev/brand/planet';

/**
 * The Voice light stops are the Brand light ramp's names (warm · blush · violet · cool · deep); the
 * colours themselves stay in `@happier-dev/brand/planet`, the one palette owner.
 */
export type VoiceLightStop = keyof typeof PLANET_LIGHT_RAMP;

/**
 * Motion tokens for the Voice presence. Durations are deliberately short for repeated
 * actions and longer only for the one signature transition (collapse ⇄ expand).
 * Easings are expressed as cubic-bezier control points so both the Reanimated
 * `Easing.bezier(...)` and the web CSS forms stay in lockstep.
 */
export const VOICE_MOTION = {
    /** Press feedback and other level-1 state feedback. */
    feedback: { durationMs: 120, bezier: [0.2, 0, 0, 1] },
    /** Local continuity: status swaps, control appear/disappear. */
    local: { durationMs: 220, bezier: [0.2, 0, 0, 1] },
    /**
     * Spatial transition: the collapse ⇄ expand of the presence itself.
     *
     * 420ms on an expo-out curve read as a snap — the object arrived before the
     * eye could follow it, which is the "jiggly" quality. The presence is a
     * *breathing body*, so its own transitions should move like one: slower, and
     * on a curve that eases at BOTH ends rather than firing hard and braking.
     * This is a single signature transition, not a repeated utility action, so
     * it can afford the extra 200ms.
     */
    spatial: { durationMs: 620, bezier: [0.32, 0.06, 0.2, 1] },
    /** Exits are quieter and faster than entrances. */
    exit: { durationMs: 180, bezier: [0.4, 0, 1, 1] },
    /** Stagger between semantic chunks in a staged reveal. */
    staggerMs: 46,
    /**
     * Where a thrown object comes to rest.
     *
     * **Critically damped — it settles, it does not bounce.** `dampingRatio: 1`
     * is the no-overshoot boundary: the orb decelerates into its corner and
     * stops, rather than arriving, passing the target, and springing back. A
     * bounce here reads as a toy; the presence should feel like a heavy, calm
     * object coming to rest.
     *
     * These are Apple's own values for *repositioning a floating companion*
     * (the PiP window): damping 1.0, response 0.4. Bounce is reserved for
     * moments where overshoot expresses something — and "I put this down where
     * I wanted it" is not one of them.
     *
     * The release velocity is still handed to the spring (see `SETTLE_SPRING`
     * in the orb): removing bounce must not remove *continuity*. The motion
     * begins at exactly the speed the finger left, then decays — no seam
     * between dragging and animating.
     */
    settle: { durationMs: 400, dampingRatio: 1 },
    /**
     * Momentum projection — where a flick is *aiming*, not where the finger let go.
     *
     * Apple's exponential-decay projection from *Designing Fluid Interfaces*:
     *
     *   projected = current + (velocity / 1000) · d / (1 − d)
     *
     * With `d = 0.998` the coefficient is ≈ 0.499 s. The lab previously used a
     * flat `0.12`, which is roughly four times too weak — every flick fell short
     * of where it was thrown, so the orb felt heavier than the gesture implied.
     */
    throwProjectionSeconds: 0.499,
} as const;
