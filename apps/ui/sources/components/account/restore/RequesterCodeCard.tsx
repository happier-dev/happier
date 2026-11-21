import * as React from 'react';
import {
  Platform,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PairingCountdown } from '@/components/auth/pairing/PairingCountdown';
import { PairingQrCode } from '@/components/auth/pairing/PairingQrCode';
import { PairingStatusPill, PairingStatusWaitingDot, pairingStatusStyles } from '@/components/auth/pairing/PairingStatusPill';
import { PAIRING_QR_PALETTE } from '@/components/auth/pairing/pairingQrPalette';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
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
  /** The rising words come into focus as they rise (web; native draws no blur on a view). */
  riseBlurPx: 8,
  softenMs: 450,
  pillDelayMs: 140,
  softenedBlurPx: 5,
  /** What remains of the code once it has let go: a trace of the code that was approved, under the check. */
  softenedOpacity: 0.45,
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
    link: string | null;
    qrAvailable: boolean;
    /** When the shown code renews; absent once approved. */
    expiresAtMs: number | null;
    approved: boolean;
    onApprovedSettled?: () => void;
    style?: StyleProp<ViewStyle>;
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
    const onApprovedSettled = props.onApprovedSettled;
    const onPillSettled = props.approved && onApprovedSettled
      ? (finished?: boolean) => {
          'worklet';
          if (finished) runOnJS(onApprovedSettled)();
        }
      : undefined;
    if (reducedMotion) {
      const fade = {
        duration: reanimatedMotionTokens.durationMs.base,
        easing: reanimatedMotionTokens.easing.standard,
      };
      progress.value = withTiming(target, fade);
      pill.value = withTiming(target, fade, onPillSettled);
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
      }, onPillSettled),
    );
  }, [pill, progress, props.approved, props.onApprovedSettled, reducedMotion]);

  const web = Platform.OS === 'web';
  const codeStyle = useAnimatedStyle(() => {
    // The softening runs on the first half of the entrance, so the check rises over a code that has already let go.
    const soften = Math.min(
      1,
      progress.value * (APPROVED_ENTRANCE.riseMs / APPROVED_ENTRANCE.softenMs),
    );
    const opacity = 1 - soften * (1 - APPROVED_ENTRANCE.softenedOpacity);
    return web
      ? ({
          filter: `blur(${(soften * APPROVED_ENTRANCE.softenedBlurPx).toFixed(2)}px)`,
          opacity,
        } as ViewStyle)
      : // Native draws no blur on a view: the code fades back instead (accepted refinement).
        { opacity };
  });
  // The check and the approved words share the welcome words' rise: up into place, coming into focus.
  const rise = (value: number) => {
    'worklet';
    if (reducedMotion) return { opacity: value };
    const style = {
      opacity: value,
      transform: [{ translateY: (1 - value) * APPROVED_ENTRANCE.risePx }],
    };
    return web && value < 0.98
      ? ({ ...style, filter: `blur(${((1 - value) * APPROVED_ENTRANCE.riseBlurPx).toFixed(2)}px)` } as ViewStyle)
      : style;
  };
  const checkStyle = useAnimatedStyle(() => rise(progress.value));
  const approvedStyle = useAnimatedStyle(() => rise(pill.value));

  const onWaitingLayout = React.useCallback(
    (event: LayoutChangeEvent) => {
      if (props.approved) return;
      setWaitingPillWidth(event.nativeEvent.layout.width);
    },
    [props.approved],
  );

  const approvedCheck = (
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
  );

  return (
    <View testID="restore-requester-code" style={[styles.root, props.style]}>
      <View
        ref={focal}
        collapsable={false}
        testID={props.link === null ? 'restore-requester-qr-pending' : 'restore-requester-qr'}
        accessibilityLabel={props.link === null ? t('common.loading') : undefined}
        style={styles.codeFrame}
      >
        {props.link === null ? <ActivitySpinner size="small" /> : props.qrAvailable ? (
          <PairingQrCode
            link={props.link}
            size={REQUESTER_CODE_SIZE_PX}
            // The paper keeps its edge; only the code inside it lets go.
            codeStyle={codeStyle}
            overlay={props.approved ? approvedCheck : null}
          />
        ) : (
          <>
            <Animated.View style={[styles.codeFallback, codeStyle]}>
              <Text style={styles.codeFallbackText}>
                {t('connect.pairingQrTooLargeBody')}
              </Text>
            </Animated.View>
            {props.approved ? approvedCheck : null}
          </>
        )}
      </View>
      {/* One status line in one box: approved, its words rise into the place the waiting words held. */}
      <PairingStatusPill
        testID="restore-requester-status"
        style={props.approved && waitingPillWidth !== null ? { width: waitingPillWidth } : undefined}
        onLayout={onWaitingLayout}
      >
        {props.approved ? null : (
          <View style={pairingStatusStyles.line}>
            {props.link !== null ? <PairingStatusWaitingDot /> : null}
            {props.expiresAtMs !== null ? (
              <PairingCountdown
                testID="restore-requester-countdown"
                expiresAtMs={props.expiresAtMs}
                style={pairingStatusStyles.text}
                formatLabel={(time) =>
                  t('connect.waitingForApprovalNewCodeIn', { time })
                }
              />
            ) : (
              <Text style={pairingStatusStyles.text}>
                {t(props.link === null ? 'common.loading' : 'connect.waitingForApproval')}
              </Text>
            )}
          </View>
        )}
        {props.approved ? (
          <Animated.View
            testID="restore-requester-approved"
            style={[pairingStatusStyles.line, approvedStyle]}
          >
            <Icon
              name="check"
              size={14}
              color={theme.colors.state.success.foreground}
            />
            <Text style={[pairingStatusStyles.text, pairingStatusStyles.textSettled]}>
              {t('connect.requesterApproved')}
            </Text>
          </Animated.View>
        ) : null}
      </PairingStatusPill>
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
}));
