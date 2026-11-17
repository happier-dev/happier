import {
  runOnJS,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { botFaceSeedOffsetMs, type BotFaceLoop } from './botFaceIdle';

/**
 * A face's stepped timeline, the one timing owner for every compositor face playback: a working face's loop of
 * drawings (one layer per drawing, stepped opacity) and a pet face's row (one image, stepped offset). Each step shows
 * from its `at` until the next step's; the host maps a step to what it shows.
 */
export type BotFaceSteps = Readonly<{
  periodMs: number;
  /** Ascending step starts, ms into the period; the first is 0. */
  at: readonly number[];
  /** `Infinity` loops; a finite count plays from its first step and then hands back to the host's still drawing. */
  iterations: number;
  /** A loop runs this far ahead of the wall clock (a Bot's seed), so it starts and resumes in phase. */
  phaseOffsetMs: number;
}>;

/** A face loop's timeline as steps, endless and in phase with its Bot: step k shows `loop.frames[k].drawing`. */
export function botFaceLoopSteps(
  loop: BotFaceLoop,
  seed: number,
): BotFaceSteps {
  return {
    periodMs: loop.periodMs,
    at: loop.frames.map((frame) => frame.atMs),
    iterations: Infinity,
    phaseOffsetMs: botFaceSeedOffsetMs(seed),
  };
}

/** Where a run starts, ms into the period: a loop's phase now, a finite run's first step. */
function startMs(steps: BotFaceSteps, now: number): number {
  if (steps.iterations !== Infinity) return 0;
  const { periodMs } = steps;
  return (((now + steps.phaseOffsetMs) % periodMs) + periodMs) % periodMs;
}

type Animator = {
  animate?: (
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
  ) => Animation;
};

/**
 * Web: plays the steps as one stepped Web Animation on `node` (the compositor; no script or React render per step).
 * `keyframe(step)` is what the node shows during that step. A finite run uses no fill, so the node's own style (the
 * host's still drawing) shows again when it ends. Returns null where the platform has no Web Animations.
 */
export function playBotFaceSteps(
  node: unknown,
  steps: BotFaceSteps,
  keyframe: (step: number) => Omit<Keyframe, 'offset' | 'easing'>,
  onFinish?: () => void,
): Animation | null {
  const animator = node as Animator | null;
  if (!animator?.animate || steps.at.length === 0) return null;
  const { periodMs, at } = steps;
  const keyframes: Keyframe[] = at.map((atMs, step) => ({
    ...keyframe(step),
    offset: atMs / periodMs,
    easing: 'step-end',
  }));
  keyframes.push({ ...keyframe(at.length - 1), offset: 1 });
  const animation = animator.animate(keyframes, {
    duration: periodMs,
    iterations: steps.iterations,
  });
  animation.currentTime = startMs(steps, Date.now());
  if (onFinish) animation.onfinish = onFinish;
  return animation;
}

/**
 * Native: steps `value` through the step indices on the UI thread (Reanimated). A loop starts in phase; a finite run
 * starts at its first step, ends on −1 (the host's still drawing) and then calls `onFinish` on the JS thread.
 */
export function startBotFaceSteps(
  value: SharedValue<number>,
  steps: BotFaceSteps,
  onFinish?: () => void,
): void {
  const { periodMs, at, iterations } = steps;
  const n = at.length;
  if (n === 0) return;
  const hold = (k: number) => (k + 1 < n ? at[k + 1]! : periodMs) - at[k]!;
  const to = (step: number, afterMs: number) =>
    withDelay(afterMs, withTiming(step, { duration: 0 }));
  if (iterations === Infinity) {
    const phase = startMs(steps, Date.now());
    let k0 = 0;
    while (k0 + 1 < n && at[k0 + 1]! <= phase) k0++;
    value.set(k0);
    if (n < 2) return;
    // Switch to step k after holding step k − 1; the first hold is what is left of the current step.
    const cycle = at.map((_, j) =>
      to((k0 + 2 + j) % n, hold((k0 + 1 + j) % n)),
    );
    const rest = (k0 + 1 < n ? at[k0 + 1]! : periodMs) - phase;
    value.set(
      withSequence(
        to((k0 + 1) % n, rest),
        withRepeat(withSequence(...cycle), -1),
      ),
    );
    return;
  }
  value.set(0);
  const run: ReturnType<typeof to>[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let k = 1; k < n; k++) run.push(to(k, hold(k - 1)));
    if (iteration + 1 < iterations) run.push(to(0, hold(n - 1)));
  }
  run.push(
    withDelay(
      hold(n - 1),
      withTiming(-1, { duration: 0 }, (finished) => {
        'worklet';
        if (finished && onFinish) runOnJS(onFinish)();
      }),
    ),
  );
  value.set(withSequence(...run));
}
