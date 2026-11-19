import * as React from 'react';
import {
  Platform,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PairingCountdown } from '@/components/auth/pairing/PairingCountdown';
import { PairingQrCode } from '@/components/auth/pairing/PairingQrCode';
import { PAIRING_QR_PALETTE } from '@/components/auth/pairing/pairingQrPalette';
import { Icon } from '@/components/ui/icons/Icon';
import { useStepFocal } from '@/components/ui/motion/stepMotion/useStepFocal';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

/** The code's paper, the size a phone camera reads at arm's length (lab Approve, 228 px paper). */
export const REQUESTER_CODE_SIZE_PX = 228;

/**
 * The approved entrance (owner 2026-11-19, `final/decisions.js`): the code softens in place, the check rises with the
 * welcome words' rise (out-expo, 18 px, 0.9 s) and the pill follows a beat later in the same box. Reduced motion keeps
 * the change as a short fade.
 */
const APPROVED_ENTRANCE = {
  riseMs: 900,
  risePx: 18,
  softenMs: 450,
  pillDelayMs: 140,
  softenedBlurPx: 6,
  softenedOpacity: 0.32,
  easing: Easing.bezier(0.16, 1, 0.3, 1),
} as const;

const CHECK_DISC_PX = 64;

/**
 * The new device's code and its one status line, as the Approve step shows them. Waiting, the pill names the wait and
 * when the code renews; approved, the code stays where it was under a check and the pill says so in the box it already
 * had, so nothing on the step moves.
 */
export const RequesterCodeCard = React.memo(function RequesterCodeCard(
  props: Readonly<{
    link: string;
    qrAvailable: boolean;
    /** When the shown code renews; absent once approved. */
    expiresAtMs: number | null;
    approved: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const styles = stylesheet;
  const reducedMotion = useReducedMotionPreference();
  const focal = useStepFocal();
  const progress = useSharedValue(props.approved ? 1 : 0);
  const pill = useSharedValue(props.approved ? 1 : 0);
  // The waiting pill's measured width: the approved line keeps that box (owner: "the status pill keeps its exact box").
  const [waitingPillWidth, setWaitingPillWidth] = React.useState<number | null>(
    null,
  );

  React.useEffect(() => {
    const target = props.approved ? 1 : 0;
    if (reducedMotion) {
      const fade = {
        duration: reanimatedMotionTokens.durationMs.base,
        easing: reanimatedMotionTokens.easing.standard,
      };
      progress.value = withTiming(target, fade);
      pill.value = withTiming(target, fade);
      return;
    }
    progress.value = withTiming(target, {
      duration: APPROVED_ENTRANCE.riseMs,
      easing: APPROVED_ENTRANCE.easing,
    });
    pill.value = withDelay(
      APPROVED_ENTRANCE.pillDelayMs,
      withTiming(target, {
        duration: APPROVED_ENTRANCE.riseMs,
        easing: APPROVED_ENTRANCE.easing,
      }),
    );
  }, [pill, progress, props.approved, reducedMotion]);

  const codeStyle = useAnimatedStyle(() => {
    // The softening runs on the first half of the entrance, so the check rises over a code that has already let go.
    const soften = Math.min(
      1,
      progress.value * (APPROVED_ENTRANCE.riseMs / APPROVED_ENTRANCE.softenMs),
    );
    return Platform.OS === 'web'
      ? ({
          filter: `blur(${(soften * APPROVED_ENTRANCE.softenedBlurPx).toFixed(2)}px)`,
          opacity: 1 - soften * 0.35,
        } as ViewStyle)
      : // Native draws no blur on a view: the code fades back instead (accepted refinement).
        { opacity: 1 - soften * (1 - APPROVED_ENTRANCE.softenedOpacity) };
  });
  const checkStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [
      {
        translateY: reducedMotion
          ? 0
          : (1 - progress.value) * APPROVED_ENTRANCE.risePx,
      },
    ],
  }));
  const approvedStyle = useAnimatedStyle(() => ({
    opacity: pill.value,
    transform: [
      {
        translateY: reducedMotion
          ? 0
          : (1 - pill.value) * (APPROVED_ENTRANCE.risePx / 2),
      },
    ],
  }));

  const onWaitingLayout = React.useCallback(
    (event: LayoutChangeEvent) => {
      if (props.approved) return;
      setWaitingPillWidth(event.nativeEvent.layout.width);
    },
    [props.approved],
  );

  return (
    <View testID="restore-requester-code" style={styles.root}>
      <View ref={focal} collapsable={false} testID="restore-requester-qr" style={styles.codeFrame}>
        <Animated.View style={codeStyle}>
          {props.qrAvailable ? (
            <PairingQrCode link={props.link} size={REQUESTER_CODE_SIZE_PX} />
          ) : (
            <View style={styles.codeFallback}>
              <Text style={styles.codeFallbackText}>
                {t('connect.pairingQrTooLargeBody')}
              </Text>
            </View>
          )}
        </Animated.View>
        {props.approved ? (
          <Animated.View
            testID="restore-requester-approved-check"
            pointerEvents="none"
            style={[styles.checkSlot, checkStyle]}
          >
            <View
              style={[
                styles.checkDisc,
                { backgroundColor: theme.colors.state.success.border },
              ]}
            >
              {/* Drawn in the code's own paper white, so it reads the same over the softened code in both themes. */}
              <Icon name="check" size={28} color={PAIRING_QR_PALETTE.paper} />
            </View>
          </Animated.View>
        ) : null}
      </View>
      {/* One status line in one box: approved, its words rise into the place the waiting words held. */}
      <View
        testID="restore-requester-status"
        accessibilityLiveRegion="polite"
        role="status"
        style={[
          styles.pill,
          props.approved && waitingPillWidth !== null
            ? { width: waitingPillWidth }
            : null,
        ]}
        onLayout={onWaitingLayout}
      >
        {props.approved ? null : (
          <View style={styles.pillLine}>
            <View
              style={[
                styles.waitingDot,
                { backgroundColor: theme.colors.state.warning.foreground },
              ]}
            />
            {props.expiresAtMs !== null ? (
              <PairingCountdown
                testID="restore-requester-countdown"
                expiresAtMs={props.expiresAtMs}
                style={styles.pillText}
                formatLabel={(time) =>
                  t('connect.waitingForApprovalNewCodeIn', { time })
                }
              />
            ) : (
              <Text style={styles.pillText}>
                {t('connect.waitingForApproval')}
              </Text>
            )}
          </View>
        )}
        {props.approved ? (
          <Animated.View
            testID="restore-requester-approved"
            style={[styles.pillLine, approvedStyle]}
          >
            <Icon
              name="check"
              size={14}
              color={theme.colors.state.success.foreground}
            />
            <Text style={[styles.pillText, styles.pillTextApproved]}>
              {t('connect.requesterApproved')}
            </Text>
          </Animated.View>
        ) : null}
      </View>
    </View>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  root: {
    alignItems: 'center',
    gap: theme.space.s16,
  },
  codeFrame: {
    width: REQUESTER_CODE_SIZE_PX,
    height: REQUESTER_CODE_SIZE_PX,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeFallback: {
    width: REQUESTER_CODE_SIZE_PX,
    height: REQUESTER_CODE_SIZE_PX,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.space.s16,
  },
  codeFallbackText: {
    ...Typography.variant('body'),
    color: theme.colors.text.secondary,
    textAlign: 'center',
  },
  checkSlot: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkDisc: {
    width: CHECK_DISC_PX,
    height: CHECK_DISC_PX,
    borderRadius: CHECK_DISC_PX / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The status line is a quiet capsule on the page: hairline edge, the page's own paper, one line of meta text.
  pill: {
    minHeight: 32,
    paddingHorizontal: theme.space.s12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface.base,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  waitingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  // The countdown changes every second, so its figures are tabular: "4:52" → "4:51" changes no width.
  pillText: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  pillTextApproved: {
    color: theme.colors.text.primary,
  },
}));
