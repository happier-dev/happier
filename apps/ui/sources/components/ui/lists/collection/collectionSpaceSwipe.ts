import { SESSION_SWITCHER_COMMIT_VELOCITY_PX_PER_S } from '@/components/navigation/mobile/chrome/lateralSwipe/sessionSwitcherGesture';

/** The lab's commit point: past 30 % of the width, or a flick at the lateral swipe's commit speed. */
const COMMIT_WIDTH_FRACTION = 0.3;

/**
 * Where a released swipe lands (lab `clspaces:swipe`): toward the previous space when dragged right, the next when
 * dragged left, once past 30 % of the width or on a flick in the same direction; null settles back.
 */
export function resolveCollectionSpaceSwipeCommit(input: Readonly<{
  translationX: number;
  velocityX: number;
  width: number;
  canPrevious: boolean;
  canNext: boolean;
}>): -1 | 1 | null {
  'worklet';
  const towardPrevious = input.translationX > 0;
  const allowed = towardPrevious ? input.canPrevious : input.canNext;
  const far = Math.abs(input.translationX) >= input.width * COMMIT_WIDTH_FRACTION;
  const flick =
    Math.abs(input.velocityX) >= SESSION_SWITCHER_COMMIT_VELOCITY_PX_PER_S &&
    input.velocityX > 0 === towardPrevious;
  return input.translationX !== 0 && allowed && (far || flick) ? (towardPrevious ? -1 : 1) : null;
}


