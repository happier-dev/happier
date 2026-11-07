import * as React from 'react';
import Animated, {
  Easing,
  useAnimatedStyle,
  runOnJS,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useEventCallback } from '@/hooks/ui/useEventCallback';

export type PublishRiseTiming = Readonly<{
  travelPx: number;
  riseMs: number;
  lineDelayMs: number;
  lineEnterMs: number;
  lineRisePx: number;
}>;

/**
 * The first-publish rise (lab ppmotion M1) for one publish in front of the owner, or null when there is none:
 * a reload, a visitor's page and an Apply never play it. Reduced motion keeps the cause with one cross-fade.
 */
export function resolvePublishRiseTiming(
  input: Readonly<{
    reducedMotion: boolean;
    bandHeightPx: number;
    moment: number | null;
  }>,
): PublishRiseTiming | null {
  if (input.moment === null) return null;
  const rise = motionTokens.publishRise;
  if (input.reducedMotion) {
    return {
      travelPx: 0,
      riseMs: rise.reducedCrossFadeMs,
      lineDelayMs: 0,
      lineEnterMs: rise.reducedCrossFadeMs,
      lineRisePx: 0,
    };
  }
  return {
    travelPx: Math.round(input.bandHeightPx * rise.travelShare),
    riseMs: rise.riseMs,
    lineDelayMs: rise.riseMs,
    lineEnterMs: rise.lineEnterMs,
    lineRisePx: rise.lineRisePx,
  };
}

const easeOutCubic = Easing.out(Easing.cubic);

/** The band, coming up from its shadow pose once per `moment`; the band's own frame clips the travel. */
export function PublishRiseBand(
  props: Readonly<{
    moment: number | null;
    bandHeightPx: number;
    children: React.ReactNode;
  }>,
) {
  const reducedMotion = useReducedMotionPreference();
  const progress = useSharedValue(1);
  const travel = useSharedValue(0);
  // Only a new moment replays; the height is read at that moment, so a layout change never replays it.
  const bandHeight = React.useRef(props.bandHeightPx);
  bandHeight.current = props.bandHeightPx;
  // A layout effect sets the start pose before the browser paints the publish result, so the band
  // never shows one frame in its risen pose first (a passive effect runs after that paint).
  React.useLayoutEffect(() => {
    const timing = resolvePublishRiseTiming({
      reducedMotion,
      bandHeightPx: bandHeight.current,
      moment: props.moment,
    });
    if (!timing) return;
    travel.value = timing.travelPx;
    progress.value = 0;
    progress.value = withTiming(1, {
      duration: timing.riseMs,
      easing:
        timing.travelPx > 0
          ? easeOutCubic
          : reanimatedMotionTokens.easing.standard,
    });
  }, [props.moment, reducedMotion, progress, travel]);
  const style = useAnimatedStyle(() => ({
    opacity:
      travel.value > 0
        ? motionTokens.publishRise.shadowOpacity +
          (1 - motionTokens.publishRise.shadowOpacity) * progress.value
        : progress.value,
    transform: [{ translateY: travel.value * (1 - progress.value) }],
  }));
  // It takes the band's whole frame, as the band did before it was wrapped.
  return <Animated.View style={[fillsBand, style]}>{props.children}</Animated.View>;
}

const fillsBand = { flex: 1 } as const;

/**
 * The result line after the rise: from below, on the standard curve, once per `moment`. Each moment
 * gets its own frame that is born in the start pose, so the line is never painted before the rise.
 * `onEntered` reports the finished entrance so the owner can retire its moment: a later remount (Edit
 * and Preview place the line in different slots) then shows the settled line instead of replaying it.
 */
export function PublishRiseLine(
  props: Readonly<{ moment: number | null; onEntered?: () => void; children: React.ReactNode }>,
) {
  return (
    <PublishRiseLineFrame key={props.moment ?? 'settled'} moment={props.moment} onEntered={props.onEntered}>
      {props.children}
    </PublishRiseLineFrame>
  );
}

function PublishRiseLineFrame(
  props: Readonly<{ moment: number | null; onEntered?: () => void; children: React.ReactNode }>,
) {
  const reducedMotion = useReducedMotionPreference();
  const progress = useSharedValue(props.moment === null ? 1 : 0);
  const rise = useSharedValue(0);
  const reportEntered = useEventCallback(() => props.onEntered?.());
  React.useLayoutEffect(() => {
    const timing = resolvePublishRiseTiming({
      reducedMotion,
      bandHeightPx: 0,
      moment: props.moment,
    });
    if (!timing) return;
    rise.value = timing.lineRisePx;
    progress.value = 0;
    progress.value = withDelay(
      timing.lineDelayMs,
      withTiming(
        1,
        {
          duration: timing.lineEnterMs,
          easing: reanimatedMotionTokens.easing.standard,
        },
        finished => {
          if (finished) runOnJS(reportEntered)();
        },
      ),
    );
  }, [props.moment, reducedMotion, progress, rise, reportEntered]);
  const style = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: rise.value * (1 - progress.value) }],
  }));
  return <Animated.View style={style}>{props.children}</Animated.View>;
}
