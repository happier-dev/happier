import * as React from 'react';
import {
  runOnJS,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';

import type { NotchForm, NotchSize } from './notchShapeGeometry';

/** What the island is moving to: its body, free-corner radius and centre offset inside the window. */
export type NotchMotionTarget = Readonly<{
  form: NotchForm;
  body: NotchSize;
  corner: number;
  /** Concave shoulder size where the island meets its edge (0 on Floating). */
  shoulder: number;
  /** Body centre relative to the window centre on an axis the island is centred on (0 elsewhere). */
  centre: Readonly<{ x: number; y: number }>;
  /** Which content layer shows: the standard content, the open panel, or neither (the tip). */
  standardShown: boolean;
  openShown: boolean;
}>;

export type NotchMotionValues = Readonly<{
  width: SharedValue<number>;
  height: SharedValue<number>;
  corner: SharedValue<number>;
  shoulder: SharedValue<number>;
  centreX: SharedValue<number>;
  centreY: SharedValue<number>;
  standardOpacity: SharedValue<number>;
  openOpacity: SharedValue<number>;
  /** The whole island's opacity: the reduced-motion and dock-change cross-fade. */
  islandOpacity: SharedValue<number>;
}>;

function targetKey(target: NotchMotionTarget): string {
  return [
    target.form,
    target.body.width,
    target.body.height,
    target.corner,
    target.shoulder,
    target.centre.x,
    target.centre.y,
    target.standardShown ? 1 : 0,
    target.openShown ? 1 : 0,
  ].join(':');
}

function isShrinking(from: NotchMotionTarget, to: NotchMotionTarget): boolean {
  return to.body.width * to.body.height < from.body.width * from.body.height;
}

/**
 * Drives the island between its forms on shared values, so a transition renders nothing per frame.
 *
 * Envelope first, envelope last: `present(false)` lets native grow the window to cover both shapes
 * before anything moves; `present(true)` runs once the spring settles, so native shrinks it to the new
 * shape. Growing, the shape springs out (`spring.travel`) and content arrives `inPlaceMorph.contentDelayMs`
 * in at `durationMs.fast`; shrinking, content leaves first (`overlay.panel.exitMs`) and the shape follows.
 * A new target redirects every value from where it is, velocity kept. Reduced motion and a dock change
 * place the shape at once and cross-fade it in (`overlay.panel.reducedMotionFadeMs` / `crossfadeMs`).
 */
export function useNotchMotion(
  params: Readonly<{
    target: NotchMotionTarget;
    /** Changes when the island moves to another edge or display: no travel across the screen. */
    placementKey: string;
    reduceMotion: boolean;
    present: (settled: boolean) => Promise<void> | void;
  }>,
): NotchMotionValues {
  const { target } = params;
  const width = useSharedValue(target.body.width);
  const height = useSharedValue(target.body.height);
  const corner = useSharedValue(target.corner);
  const shoulder = useSharedValue(target.shoulder);
  const centreX = useSharedValue(target.centre.x);
  const centreY = useSharedValue(target.centre.y);
  const standardOpacity = useSharedValue(target.standardShown ? 1 : 0);
  const openOpacity = useSharedValue(target.openShown ? 1 : 0);
  const islandOpacity = useSharedValue(1);

  const presentRef = React.useRef(params.present);
  presentRef.current = params.present;
  const previousTargetRef = React.useRef(target);
  const previousPlacementKeyRef = React.useRef(params.placementKey);
  // A transition superseded while native was still growing the envelope must not start afterwards.
  const transitionTokenRef = React.useRef(0);
  const key = targetKey(target);

  React.useEffect(() => {
    const from = previousTargetRef.current;
    const placementChanged =
      previousPlacementKeyRef.current !== params.placementKey;
    previousTargetRef.current = target;
    previousPlacementKeyRef.current = params.placementKey;
    const token = transitionTokenRef.current + 1;
    transitionTokenRef.current = token;

    const settle = () => {
      if (transitionTokenRef.current !== token) return;
      void presentRef.current(true);
    };

    if (params.reduceMotion || placementChanged) {
      width.value = target.body.width;
      height.value = target.body.height;
      corner.value = target.corner;
      shoulder.value = target.shoulder;
      centreX.value = target.centre.x;
      centreY.value = target.centre.y;
      standardOpacity.value = target.standardShown ? 1 : 0;
      openOpacity.value = target.openShown ? 1 : 0;
      islandOpacity.value = 0;
      islandOpacity.value = withTiming(1, {
        duration: placementChanged
          ? motionTokens.overlay.panel.crossfadeMs
          : motionTokens.overlay.panel.reducedMotionFadeMs,
      });
      void presentRef.current(true);
      return;
    }

    const shrinking = isShrinking(from, target);
    const shapeDelayMs = shrinking ? motionTokens.overlay.panel.exitMs : 0;
    const enter = (value: SharedValue<number>, shown: boolean) => {
      value.value = shown
        ? withDelay(
            motionTokens.inPlaceMorph.contentDelayMs,
            withTiming(1, { duration: motionTokens.durationMs.fast }),
          )
        : withTiming(0, { duration: motionTokens.overlay.panel.exitMs });
    };

    const run = () => {
      if (transitionTokenRef.current !== token) return;
      const spring = reanimatedMotionTokens.spring.travel;
      const shape = (toValue: number) =>
        withDelay(shapeDelayMs, withSpring(toValue, spring));
      enter(standardOpacity, target.standardShown);
      enter(openOpacity, target.openShown);
      islandOpacity.value = 1;
      height.value = shape(target.body.height);
      corner.value = shape(target.corner);
      shoulder.value = shape(target.shoulder);
      centreX.value = shape(target.centre.x);
      centreY.value = shape(target.centre.y);
      width.value = withDelay(
        shapeDelayMs,
        withSpring(target.body.width, spring, (finished) => {
          if (finished) runOnJS(settle)();
        }),
      );
    };

    const grown = presentRef.current(false);
    if (grown && typeof (grown as Promise<void>).then === 'function') {
      (grown as Promise<void>).then(run, run);
    } else {
      run();
    }
    // The key folds every target field; the shared values are stable.
    // A new frame for native (extent, surface, engagement) presents again even when the shape holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, params.placementKey, params.reduceMotion, params.present]);

  return {
    width,
    height,
    corner,
    shoulder,
    centreX,
    centreY,
    standardOpacity,
    openOpacity,
    islandOpacity,
  };
}
