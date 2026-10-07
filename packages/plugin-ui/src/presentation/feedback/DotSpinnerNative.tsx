import { memo, useMemo } from 'react';
import { Animated } from 'react-native';

import { useDotSpinnerBreathClock, useDotSpinnerCycleClock } from './dotSpinnerClock.js';
import {
  DOT_SPINNER_STILL_OPACITY,
  getDotSpinnerFrames,
  readDotSeries,
  resolveAuroraBlend,
  unwrapHueSeries,
  type DotSpinnerFrames,
  type DotSpinnerInk,
} from './dotSpinnerFrames.js';
import { type DotSpinnerStyleId, type HappierSpinnerTiming, type SpinnerDot } from './spinnerStyles.js';

const BREATH_LOW_OPACITY = 0.45;

/**
 * The accent gradient repeated over hue positions −2…2, so an unwrapped hue series (which drifts
 * past 0 and 1 instead of jumping back) always lands on it. Colour interpolation runs on the native
 * driver: `backgroundColor` is in React Native's native-animated colour allow-list.
 */
const HUE_STOP_INDICES = Array.from({ length: 13 }, (_, i) => i - 6);

function frameInputRange(frameCount: number): number[] {
  return Array.from({ length: frameCount + 1 }, (_, frame) => frame / frameCount);
}

/** A dot's series closed back onto its first frame, so the loop's wrap is seamless. */
function closedSeries(series: readonly number[]): number[] {
  return [...series, series[0]!];
}

type DotDrive = Readonly<{
  opacity: Animated.AnimatedInterpolation<number> | number;
  color: Animated.AnimatedInterpolation<string> | string;
}>;

function driveDots(
  frames: DotSpinnerFrames,
  ink: DotSpinnerInk,
  clock: Animated.Value,
  still: boolean,
): readonly DotDrive[] {
  const inputRange = frameInputRange(frames.frameCount);
  return frames.dots.map((_, index) => {
    const opacity = still
      ? DOT_SPINNER_STILL_OPACITY
      : clock.interpolate({ inputRange, outputRange: closedSeries(readDotSeries(frames, frames.opacity, index)) });
    if ('color' in ink || !frames.hue) {
      return { opacity, color: 'color' in ink ? ink.color : ink.aurora[0] };
    }
    const hue = unwrapHueSeries(readDotSeries(frames, frames.hue, index));
    const gradient = { inputRange: HUE_STOP_INDICES.map((k) => k / 3), outputRange: HUE_STOP_INDICES.map((k) => ink.aurora[((k % 3) + 3) % 3]!) };
    if (still) {
      // A still aurora dot holds its nearest accent; blending two arbitrary colours statically
      // would need a colour parser the native driver otherwise does for us.
      const { from, to, mix } = resolveAuroraBlend(hue[0]!);
      return { opacity, color: ink.aurora[mix < 0.5 ? from : to] };
    }
    const color = clock.interpolate({ inputRange, outputRange: [...hue, hue[0]! - Math.round(hue[0]! - hue[hue.length - 1]!)] }).interpolate(gradient);
    return { opacity, color };
  });
}

/**
 * The native dots. Every dot is an `Animated.View` whose opacity (and aurora colour) is an
 * interpolation of the shared clock for its played cycle over the 30 fps frame table, so the whole
 * animation runs on the native driver with no per-frame JavaScript. Still and breathing poses hold
 * no cycle clock; the breath holds the one shared breath clock.
 */
export const DotSpinnerNative = memo(function DotSpinnerNative(props: Readonly<{
  styleId: DotSpinnerStyleId;
  timing: HappierSpinnerTiming;
  size: number;
  ink: DotSpinnerInk;
  motion: 'animate' | 'still' | 'breathe';
}>) {
  const { styleId, timing, size, ink, motion } = props;
  const frames = getDotSpinnerFrames(styleId, timing);
  const animate = motion === 'animate';
  const clock = useDotSpinnerCycleClock(frames.cycleMs, animate);
  const breath = useDotSpinnerBreathClock(motion === 'breathe');
  const drives = useMemo(() => driveDots(frames, ink, clock, !animate), [animate, clock, frames, ink]);
  const layerOpacity = useMemo(
    () => (motion === 'breathe' ? breath.interpolate({ inputRange: [0, 1], outputRange: [1, BREATH_LOW_OPACITY] }) : 1),
    [breath, motion],
  );

  return (
    <Animated.View
      testID="happier-spinner-dots"
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, width: size, height: size, opacity: layerOpacity }}
    >
      {frames.dots.map((dot, index) => (
        <NativeDot key={dot.id} dot={dot} size={size} drive={drives[index]!} />
      ))}
    </Animated.View>
  );
});

function NativeDot(props: Readonly<{ dot: SpinnerDot; size: number; drive: DotDrive }>) {
  const { dot, size, drive } = props;
  const pitch = size / 3;
  const diameter = size / 6;
  return (
    <Animated.View
      testID="happier-spinner-dot"
      style={{
        position: 'absolute',
        left: (dot.col + 0.5) * pitch - diameter / 2,
        top: (dot.row + 0.5) * pitch - diameter / 2,
        width: diameter,
        height: diameter,
        borderRadius: diameter / 2,
        backgroundColor: drive.color,
        opacity: drive.opacity,
      }}
    />
  );
}
