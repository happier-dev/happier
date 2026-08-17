import type { CompanionPointerDragSelectors } from '@/components/companion/interaction/useCompanionPointerDragSession';
import { PET_POSITION_SPRING_DAMPING_FRACTION, PET_POSITION_SPRING_RESPONSE } from '@/components/pets/animation/petAnimationPlaybackConfig';
import type { CompanionReleaseMotion } from '@/components/companion/interaction/companionReleaseMotion';

/**
 * The pet's half of the shared companion drag contract.
 *
 * The selectors are the pet's own DOM attributes and the release motion is the pet's own settle —
 * a small overshoot that is then clipped. Both used to live inside the drag hooks; keeping them at
 * the call site is what lets the Voice orb reuse the same hooks without inheriting either.
 */
export const PET_POINTER_DRAG_SELECTORS: CompanionPointerDragSelectors = Object.freeze({
    noDrag: '[data-pet-no-drag="true"], .no-drag',
    handle: '[data-pet-mascot="true"], [data-avatar-mascot="true"], [data-avatar-overlay-hit-region]',
});

/**
 * Unchanged pet behaviour: spring to the point the finger left (`projectionSeconds: 0`), with the
 * historical damping and overshoot clamping, and without handing the release velocity to the
 * spring.
 */
export const PET_COMPANION_RELEASE_MOTION: CompanionReleaseMotion = Object.freeze({
    durationMs: PET_POSITION_SPRING_RESPONSE * 1000,
    dampingRatio: PET_POSITION_SPRING_DAMPING_FRACTION,
    overshootClamping: true,
    carryVelocity: false,
    projectionSeconds: 0,
});
