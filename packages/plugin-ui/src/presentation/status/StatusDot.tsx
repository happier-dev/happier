import { useEffect, useRef, useState } from 'react';
import { AppState, Animated, Platform, View, type ViewStyle } from 'react-native';

import { useOptionalHappierUiAccessibility } from '../../environment/context.js';
import type { HappierStyleProp } from '../portableTypes.js';

/**
 * The single implementation owner for Happier's status dot (UI-T27).
 *
 * Extracted from `apps/ui/sources/components/ui/status/StatusDot.tsx` with its
 * measured behaviour intact: a stepped CSS pulse on web, a native
 * `Animated.loop` elsewhere, a static dot when the pulse is switched off, and
 * accessibility identity that either NAMES the status or hides the dot from
 * assistive technology entirely — a colour-only dot with no label is decoration
 * and must not be announced.
 *
 * `reducedMotion` is injected (§3.10.2), and only the pulsing path reads it.
 * Status dots mount by the hundred in virtualized lists, so a preference read
 * on the static path would make every row pay for a value it cannot use.
 *
 * The pulse also PAUSES while the surface is hidden or backgrounded, which
 * `apps/ui/AGENTS.md` and `DESIGN.md` both require of long-running status
 * motion. That belongs here rather than at a call site: a launchpad of N rows
 * beside a services pane of N rows is 2N loops, and every one of them was
 * running behind a backgrounded pane. Subscribing only on the pulsing path
 * keeps the static dot free.
 */
const WEB_PULSE_TIMING_FUNCTION = 'steps(6, end)';
const DEFAULT_STATUS_DOT_SIZE = 6;

/**
 * Whether the surface this dot lives on is on screen.
 *
 * `AppState` is the single mechanism on purpose: react-native-web implements it
 * on top of `document.visibilityState`, so one subscription covers a
 * backgrounded app on native and a hidden tab/window on web without a second,
 * web-only listener beside it.
 */
function useSurfaceVisible(): boolean {
  const [visible, setVisible] = useState(() => AppState.currentState !== 'background' && AppState.currentState !== 'inactive');

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      setVisible(next !== 'background' && next !== 'inactive');
    });
    return () => { subscription.remove(); };
  }, []);

  return visible;
}

export type HappierStatusDotProps = Readonly<{
  color: string;
  isPulsing?: boolean;
  size?: number;
  style?: HappierStyleProp;
  testID?: string;
  /**
   * The semantic meaning of the colour. Present: the dot is announced as an
   * image with this label. Absent: it is hidden from assistive technology,
   * because an unnamed colour conveys nothing to a screen reader.
   */
  accessibilityLabel?: string;
  /** Keep the pulsing state visible while disabling the animation. */
  animationEnabled?: boolean;
  /**
   * The resolved reduced-motion preference. When omitted the environment value
   * is used; when there is no environment the dot animates.
   */
  reducedMotion?: boolean;
}>;

function accessibilityProps(accessibilityLabel: string | undefined) {
  return accessibilityLabel
    ? {
      accessibilityRole: 'image' as const,
      accessibilityLabel,
    }
    : {
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants' as const,
    };
}

function dotStyle(color: string, size: number): ViewStyle {
  return {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: color,
  };
}

export function HappierStatusDot(props: HappierStatusDotProps) {
  if (!props.isPulsing || props.animationEnabled === false) {
    return <StaticStatusDot {...props} />;
  }
  return <MotionAwareStatusDot {...props} />;
}

function MotionAwareStatusDot(props: HappierStatusDotProps) {
  const environmentAccessibility = useOptionalHappierUiAccessibility();
  const reducedMotion = props.reducedMotion ?? environmentAccessibility?.reducedMotion ?? false;
  const surfaceVisible = useSurfaceVisible();

  if (reducedMotion) {
    return <StaticStatusDot {...props} />;
  }
  if (Platform.OS === 'web') {
    return <WebStatusDot {...props} paused={!surfaceVisible} />;
  }
  return <PulsingStatusDot {...props} paused={!surfaceVisible} />;
}

function StaticStatusDot({
  color,
  size = DEFAULT_STATUS_DOT_SIZE,
  style,
  testID,
  accessibilityLabel,
}: HappierStatusDotProps) {
  return (
    <View
      testID={testID}
      {...accessibilityProps(accessibilityLabel)}
      style={[dotStyle(color, size), style]}
    />
  );
}

type PausableStatusDotProps = HappierStatusDotProps & Readonly<{ paused: boolean }>;

function WebStatusDot({
  color,
  isPulsing,
  size = DEFAULT_STATUS_DOT_SIZE,
  style,
  testID,
  animationEnabled = true,
  accessibilityLabel,
  paused,
}: PausableStatusDotProps) {
  return (
    <View
      testID={testID}
      {...accessibilityProps(accessibilityLabel)}
      style={[
        dotStyle(color, size),
        isPulsing && animationEnabled ? webPulseStyle : null,
        // `paused` rather than dropping the animation entirely: the keyframe holds
        // its current frame and resumes in place, so a returning tab does not
        // restart every dot on the screen in lockstep.
        isPulsing && animationEnabled && paused ? webPulsePausedStyle : null,
        style,
      ]}
    />
  );
}

function PulsingStatusDot({
  color,
  size = DEFAULT_STATUS_DOT_SIZE,
  style,
  testID,
  accessibilityLabel,
  paused,
}: PausableStatusDotProps) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (paused) {
      opacity.setValue(1);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => {
      animation.stop();
    };
  }, [opacity, paused]);

  return (
    <Animated.View
      testID={testID}
      {...accessibilityProps(accessibilityLabel)}
      style={[
        dotStyle(color, size),
        { opacity },
        style,
      ]}
    />
  );
}

type WebPulseStyle = ViewStyle & {
  animationDirection?: 'alternate';
  animationDuration?: string;
  animationIterationCount?: string;
  animationName?: string;
  animationTimingFunction?: string;
  animationPlayState?: 'running' | 'paused';
};

const webPulseStyle: WebPulseStyle = {
  animationDirection: 'alternate',
  animationDuration: '1000ms',
  animationIterationCount: 'infinite',
  animationName: 'happierStatusDotPulse',
  animationTimingFunction: WEB_PULSE_TIMING_FUNCTION,
};

const webPulsePausedStyle: WebPulseStyle = {
  animationPlayState: 'paused',
};
