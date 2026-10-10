import * as React from 'react';
import { Platform, StyleSheet as RNStyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { useMotionPreferences } from '@/components/instrument';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { hapticsSuccess } from '@/components/ui/theme/haptics';
import { t } from '@/text';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { usageSeriesColor } from '../usageAccent';
import {
  usageWitnessedResetWatch,
  type UsageWindowReading,
} from '../usageWitnessedReset';

/** The lab's burst (`kitmotion` reset): 24 pieces, 700ms, then gone. */
const PIECES = 24;
const BURST_MS = 700;
const ORIGIN_TOP_PX = 40;

export type UsageResetCelebrationWindow = UsageWindowReading &
  Readonly<{
    /** The account as the viewer knows it, and the window's own name. */
    name: string;
    window: string;
  }>;

/**
 * Celebrates a witnessed reset, once: a window the viewer used up coming back while they are looking
 * at Happier. It says so through the app's transient notice (so it is read out and never shifts the
 * layout), gives the success haptic, and — unless motion is reduced — throws one short burst over the
 * body. A first read, a routine rollover, or a reset that happened while hidden shows nothing.
 */
export function UsageResetCelebration(
  props: Readonly<{
    windows: readonly UsageResetCelebrationWindow[];
    /** Glance sizes say it without the burst. */
    burst: boolean;
    testID?: string;
  }>,
) {
  const motion = useMotionPreferences();
  const viewed = useHostActivelyViewed();
  const [burstId, setBurstId] = React.useState<string | null>(null);
  const readingsKey = JSON.stringify(
    props.windows.map((entry) => [
      entry.key,
      entry.resetAtMs,
      entry.remainingFraction,
    ]),
  );
  const windowsRef = React.useRef(props.windows);
  windowsRef.current = props.windows;
  const animate = props.burst && motion.level !== 'minimal';
  React.useEffect(() => {
    const witnessed = usageWitnessedResetWatch.observe(
      windowsRef.current,
      viewed,
    );
    if (witnessed.length === 0) return;
    for (const reading of witnessed) {
      const entry = windowsRef.current.find(
        (candidate) => candidate.key === reading.key,
      );
      if (!entry) continue;
      publishPresentationNotice({
        key: `usage-window-reset:${entry.key}`,
        severity: 'info',
        message: `${t('usage.board.page.windowReset', { name: entry.name, window: entry.window })} · ${t('usage.board.page.windowResetFull')}`,
      });
    }
    // Reduced motion keeps the confirmation and the haptic; only the burst goes.
    if (Platform.OS !== 'web') void hapticsSuccess();
    if (animate) setBurstId(`${witnessed[0]!.key}:${witnessed[0]!.resetAtMs}`);
  }, [readingsKey, viewed, animate]);
  const finish = React.useCallback(() => setBurstId(null), []);
  if (!burstId) return null;
  return <ResetBurst key={burstId} onDone={finish} testID={props.testID} />;
}

function ResetBurst(props: Readonly<{ onDone: () => void; testID?: string }>) {
  const { theme } = useUnistyles();
  const progress = useSharedValue(0);
  const { onDone } = props;
  React.useEffect(() => {
    progress.value = withTiming(
      1,
      { duration: BURST_MS, easing: Easing.out(Easing.cubic) },
      (finished) => {
        if (finished) runOnJS(onDone)();
      },
    );
    // One run per mount; a new reset mounts a new burst.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <View
      testID={props.testID}
      pointerEvents="none"
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={[RNStyleSheet.absoluteFill, styles.burst]}
    >
      {Array.from({ length: PIECES }, (_, index) => (
        <ResetPiece
          key={index}
          index={index}
          progress={progress}
          color={usageSeriesColor(theme, index % 5)}
        />
      ))}
    </View>
  );
}

function ResetPiece(
  props: Readonly<{
    index: number;
    progress: SharedValue<number>;
    color: string;
  }>,
) {
  const { index, progress } = props;
  const angle = (index / PIECES) * Math.PI * 2;
  const reach = 46 + (index % 3) * 16;
  const spin = index * 33;
  const style = useAnimatedStyle(() => {
    const p = progress.value;
    return {
      // Out from the middle, a little drop at the end, and gone in the last third.
      opacity: p < 0.65 ? 0.9 : 0.9 * (1 - (p - 0.65) / 0.35),
      transform: [
        { translateX: Math.cos(angle) * reach * p },
        { translateY: Math.sin(angle) * reach * p + 12 * p * p },
        { rotate: `${spin + 120 * p}deg` },
      ],
    };
  });
  return (
    <Animated.View
      style={[styles.piece, { backgroundColor: props.color }, style]}
    />
  );
}

const styles = RNStyleSheet.create({
  burst: { alignItems: 'center', overflow: 'visible' },
  piece: {
    position: 'absolute',
    top: ORIGIN_TOP_PX,
    width: 4,
    height: 7,
    borderRadius: 1,
  },
});
