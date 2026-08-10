export { MOTION_STANDARD_BEZIER, motionTokens } from './motionTokens';

// The role-named spring vocabulary. Physics tables are module-private; a config is reachable only
// through a resolver, which is also the only place the reduced-motion policy is decided.
export {
    MOTION_SPRING_ROLES,
    createSpringConfigResolver,
    describeMotionSpring,
    resolveMotionReducedFallback,
    resolveMotionSpring,
    type MotionReducedMotionFallback,
    type MotionSpringProfile,
    type MotionSpringRole,
    type SpringConfigResolver,
    type SpringPhysics,
} from './motionSprings';
// The one mapping from "an animation this program ships" to what it does under reduced motion.
// Spring-backed rows derive from the table above rather than restating it.
export {
    MOTION_ANIMATIONS,
    MOTION_ELAPSED_TICK_MS,
    resolveElapsedTickCadence,
    resolveMotionAnimationSpringRole,
    resolveMotionPresentation,
    type ElapsedTickCadence,
    type MotionAnimationId,
    type MotionPresentation,
} from './reducedMotionTable';
export {
    STATUS_TRANSITION_TIMELINE,
    StatusTransition,
    type StatusTransitionProps,
} from './StatusTransition';
export { stepTransitionTokens, type StepTransitionTokens } from './stepTransitionTokens';
export {
    resolveStepTransitionDirection,
    type StepTransitionDirection,
    type ResolveStepTransitionDirectionParams,
} from './resolveStepTransitionDirection';
export {
    StepTransitionFrame,
    type StepTransitionFrameProps,
} from './StepTransitionFrame';

// Unified slide transition primitives (Phase 1A — Lane L; Lane R3 motion finish)
export { SlideTransitionFrame } from './SlideTransitionFrame';
export { SlideTransitionSwitch } from './SlideTransitionSwitch';
export {
    StoryDeckSlideTransition,
    type StoryDeckSlideTransitionHandle,
} from './StoryDeckSlideTransition';
export { resolveSlideTransitionSpring, slideTransitionTokens } from './slideTransitionTokens';
export type {
    SlideTransitionDirection,
    SlideTransitionFrameProps,
    SlideTransitionSwitchProps,
    StoryDeckSlideTransitionProps,
    StoryDeckSlideTransitionRole,
    SlideTransitionPreset,
    SlideLayerRole,
} from './_types';
