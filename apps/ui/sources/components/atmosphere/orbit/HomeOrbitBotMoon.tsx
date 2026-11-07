import * as React from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withTiming,
  type FrameInfo,
  type SharedValue,
} from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import { BOT_FACE_MOMENT_MS } from '@/components/sessions/bots/face/useBotFaceMoment';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';

import {
  homeOrbitBotPoint,
  isHomeOrbitBotBehindPlanet,
  type HomeOrbitBotMoon as HomeOrbitBotMoonLayout,
} from './homeOrbitScene';

/** Lab R6: a moon the planet hides drops to this strength. */
const BEHIND_OPACITY = 0.2;
/** Lab R6 trail: dots behind a working moon along its orbit, each this far back (radians). */
const TRAIL_DOTS = 6;
const TRAIL_STEP = 0.075;

export type HomeOrbitBotMoonProps = Readonly<{
  moon: HomeOrbitBotMoonLayout;
  /** The planet the orbit goes round. */
  cx: number;
  cy: number;
  pr: number;
  /** Home on screen, the app viewed and reduced motion off: only then does anything move. */
  eligible: boolean;
  continuous?: boolean;
  /** The face, at the moon's size; `done` while its spark plays. */
  mark: (size: number, done: boolean) => React.ReactNode;
  label: string | null;
  accessibilityLabel: string;
  onPress: () => void;
  /** A new value drops one spark into the planet; missed sparks are not replayed. */
  spark: number;
  ink: string;
  testID?: string;
}>;

/**
 * One Bot moon (lab R6 `worldMount`). Its place lives in shared values and moves by transform on the
 * UI thread, so nothing above it renders per frame. A working moon's frame callback runs only while
 * `eligible`; a quiet moon has none running. Needs-you travels once to its waiting place in front
 * and stays there; a completion drops one finite spark into the planet.
 */
export const HomeOrbitBotMoon = React.memo(function HomeOrbitBotMoon(
  props: HomeOrbitBotMoonProps,
) {
  const { moon, cx, cy, pr, eligible } = props;
  const angle = useSharedValue(moon.angle);
  const speed = useSharedValue(moon.speed);
  const park = useSharedValue(moon.park ? 1 : 0);
  // Leaving the front travels back from where it waited, so the last waiting place is kept.
  const lastPark = React.useRef(moon.park);
  if (moon.park) lastPark.current = moon.park;
  const parkX = lastPark.current?.x ?? 0;
  const parkY = lastPark.current?.y ?? 0;
  const orbit = moon.orbit;
  // A relayout (a Bot joined or left, the pane resized) re-spaces the lane: the moon takes its new place.
  React.useEffect(() => {
    angle.set(moon.angle);
  }, [angle, moon.angle, orbit]);
  React.useEffect(() => {
    speed.set(moon.speed);
  }, [moon.speed, speed]);
  React.useEffect(() => {
    const target = moon.park ? 1 : 0;
    // The one finite move to or from the front; hidden or reduced motion just stands it there.
    park.set(
      eligible
        ? withTiming(target, {
            duration: motionTokens.spring.travel.durationMs,
            easing: Easing.out(Easing.cubic),
          })
        : target,
    );
    // `eligible` is read at the change, not followed: regaining it does not replay the move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moon.park !== null, park]);
  const onFrame = React.useCallback(
    (info: FrameInfo) => {
      'worklet';
      const dt = Math.min(0.1, (info.timeSincePreviousFrame ?? 16) / 1000);
      angle.set(angle.get() + speed.get() * dt);
    },
    [angle, speed],
  );
  const frame = useFrameCallback(onFrame, false);
  const travelling = eligible && props.continuous !== false && moon.speed > 0 && moon.park === null;
  React.useEffect(() => {
    frame.setActive(travelling);
  }, [frame, travelling]);
  const size = moon.size;
  const style = useAnimatedStyle(() => {
    const p = homeOrbitBotPoint(cx, cy, orbit, angle.get());
    const k = park.get();
    const x = p.x + (parkX - p.x) * k;
    const y = p.y + (parkY - p.y) * k;
    const behind = k < 0.5 && isHomeOrbitBotBehindPlanet(cx, cy, pr, p);
    const scale = p.scale + (1 - p.scale) * k;
    return {
      opacity: behind ? BEHIND_OPACITY : 1,
      transform: [
        { translateX: x - size / 2 },
        { translateY: y - size / 2 },
        { scale },
      ],
    };
  });
  const sparkProgress = useSharedValue(0);
  const [sparking, setSparking] = React.useState(false);
  const firstSpark = React.useRef(props.spark);
  React.useEffect(() => {
    if (props.spark === firstSpark.current) return;
    firstSpark.current = props.spark;
    if (!eligible) return;
    setSparking(true);
    sparkProgress.set(0);
    sparkProgress.set(
      withTiming(
        1,
        { duration: SPARK_MS, easing: Easing.linear },
        (finished) => {
          if (finished) runOnJS(setSparking)(false);
        },
      ),
    );
    // A spark plays from the change it answers; regaining eligibility never replays it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.spark]);
  React.useEffect(() => {
    if (eligible) return;
    // Hidden, scrolled away or reduced motion: finite moves end at their resting place, no frames left.
    cancelAnimation(sparkProgress);
    cancelAnimation(park);
    park.set(moon.park ? 1 : 0);
    setSparking(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible]);
  return (
    <>
      {moon.speed > 0 && moon.park === null
        ? TRAIL_INDICES.map((index) => (
            <TrailDot
              key={index}
              index={index}
              angle={angle}
              cx={cx}
              cy={cy}
              pr={pr}
              orbit={orbit}
              ink={props.ink}
            />
          ))
        : null}
      {sparking
        ? SPARK_INDICES.map((index) => (
            <SparkDot
              key={index}
              index={index}
              progress={sparkProgress}
              angle={angle}
              park={park}
              parkX={parkX}
              parkY={parkY}
              cx={cx}
              cy={cy}
              pr={pr}
              orbit={orbit}
              ink={props.ink}
            />
          ))
        : null}
      <Animated.View
        style={[styles.moon, { width: size, height: size }, style]}
        pointerEvents="box-none"
      >
        <Pressable
          testID={props.testID}
          accessibilityRole="button"
          accessibilityLabel={props.accessibilityLabel}
          onPress={props.onPress}
          style={styles.hit}
        >
          {props.mark(size, sparking)}
        </Pressable>
        {/* Named only where the scene gives the name room (a waiting moon), so names never overlap. */}
        {props.label && moon.labelWidth > 0 ? (
          <View
            pointerEvents="none"
            style={[
              styles.label,
              { top: size + 2, left: size / 2 - moon.labelWidth / 2, width: moon.labelWidth },
            ]}
          >
            <Text
              variant="meta"
              numberOfLines={1}
              style={[
                styles.labelText,
                workStatusWordStyle(
                  moon.activity === 'needsYou' ? 'attention' : 'neutral',
                ),
              ]}
            >
              {props.label}
            </Text>
          </View>
        ) : null}
      </Animated.View>
    </>
  );
});

/** The face's own done moment (lab R6 `DONE_MS`): the spark falls, lands and fades within it. */
const SPARK_MS = BOT_FACE_MOMENT_MS.done;
const SPARK_DOTS = 8;
const TRAIL_INDICES = Array.from(
  { length: TRAIL_DOTS },
  (_, index) => index + 1,
);
const SPARK_INDICES = Array.from({ length: SPARK_DOTS }, (_, index) => index);

type OrbitDotProps = Readonly<{
  index: number;
  angle: SharedValue<number>;
  cx: number;
  cy: number;
  pr: number;
  orbit: HomeOrbitBotMoonLayout['orbit'];
  ink: string;
}>;

function TrailDot(props: OrbitDotProps) {
  const { index, angle, cx, cy, pr, orbit } = props;
  const style = useAnimatedStyle(() => {
    const p = homeOrbitBotPoint(
      cx,
      cy,
      orbit,
      angle.get() - index * TRAIL_STEP,
    );
    const behind = isHomeOrbitBotBehindPlanet(cx, cy, pr, p);
    return {
      opacity:
        (behind ? BEHIND_OPACITY : 1) * 0.5 * (1 - index / (TRAIL_DOTS + 1)),
      transform: [
        { translateX: p.x - TRAIL_DOT_PX / 2 },
        { translateY: p.y - TRAIL_DOT_PX / 2 },
      ],
    };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.dot, { backgroundColor: props.ink }, style]}
    />
  );
}

function SparkDot(
  props: OrbitDotProps &
    Readonly<{
      progress: SharedValue<number>;
      park: SharedValue<number>;
      parkX: number;
      parkY: number;
    }>,
) {
  const { index, angle, cx, cy, orbit, progress, park, parkX, parkY } = props;
  const style = useAnimatedStyle(() => {
    // Lab R6: the spark leaves the moon after a beat, arcs up and falls into the planet, its trail behind it.
    const t = progress.get();
    const q = Math.max(0, Math.min(1, (t - 0.24) / 0.48) - index * 0.03);
    const p = homeOrbitBotPoint(cx, cy, orbit, angle.get());
    const k = park.get();
    const sx = p.x + (parkX - p.x) * k;
    const sy = p.y + (parkY - p.y) * k;
    const tx = cx + (sx - cx) * 0.35;
    const ty = cy + (sy - cy) * 0.35;
    const x = sx + (tx - sx) * q * q;
    const y =
      sy + (ty - sy) * q * q - Math.sin(q * Math.PI) * props.pr * 0.15;
    const fade =
      t < 0.24 ? 0 : t > 0.72 ? Math.max(0, 1 - (t - 0.72) / 0.28) : 1;
    return {
      opacity: fade * (1 - index / SPARK_DOTS),
      transform: [
        { translateX: x - SPARK_DOT_PX / 2 },
        { translateY: y - SPARK_DOT_PX / 2 },
        { scale: 1 - index * 0.08 },
      ],
    };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.spark, { backgroundColor: props.ink }, style]}
    />
  );
}

const TRAIL_DOT_PX = 3;
const SPARK_DOT_PX = 5;

const styles = StyleSheet.create(() => ({
  moon: { position: 'absolute', left: 0, top: 0 },
  hit: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { position: 'absolute', alignItems: 'center' },
  labelText: { textAlign: 'center' },
  dot: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: TRAIL_DOT_PX,
    height: TRAIL_DOT_PX,
    borderRadius: TRAIL_DOT_PX / 2,
  },
  spark: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: SPARK_DOT_PX,
    height: SPARK_DOT_PX,
    borderRadius: SPARK_DOT_PX / 2,
  },
}));
