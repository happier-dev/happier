import { Switch as ReactNativeSwitch, View, type ViewStyle } from 'react-native';

import { HappierPressable } from '../interaction/Pressable.js';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HAPPIER_MOTION_V1 } from '../interaction/motion.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../interaction/pressFeedback.js';
import type { HappierFocusable, HappierStyleProp } from '../portableTypes.js';

/**
 * The one switch owner for Happier core and plugin surfaces (D6).
 *
 * - {@link HappierSwitch} is the drawn switch — the web control. Happier core's
 *   web `Switch` and the plugin `Toggle` on web both render it, so they look
 *   and move identically: the thumb slides and the track fades on the shared
 *   motion scale, interruptibly (a CSS transition retargets from the current
 *   value), and neither moves under reduced motion.
 * - {@link HappierSwitchNative} is the platform switch, which already owns its
 *   motion, haptics and accessibility on iOS and Android. Happier core's native
 *   `Switch` and the plugin `Toggle` on native both render it.
 *
 * Each adapter supplies only its colours, accessible-name source and
 * reduced-motion fact; core picks the host through its platform file split,
 * the plugin `Toggle` through the platform it runs on.
 */
export const HAPPIER_SWITCH_METRICS = Object.freeze({
  default: Object.freeze({ trackWidth: 40, trackHeight: 22, thumbSize: 18, padding: 2 }),
  compact: Object.freeze({ trackWidth: 32, trackHeight: 18, thumbSize: 14, padding: 2 }),
  /** The web control's own hit box around the drawn track. */
  webTargetPx: 44,
  disabledOpacity: 0.6,
});

export type HappierSwitchSize = 'default' | 'compact';

export type HappierSwitchColors = Readonly<{
  trackOn: string;
  trackOff: string;
  thumb: string;
  /** The keyboard focus ring (web). */
  focusRing: string;
}>;

export type HappierSwitchProps = Readonly<{
  value: boolean;
  onValueChange?: (value: boolean) => unknown;
  disabled?: boolean;
  size?: HappierSwitchSize;
  colors: HappierSwitchColors;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** The element describing this switch beside its name (web `aria-describedby`). */
  describedById?: string;
  /** The enclosing field is invalid; `errorMessageId` names its message. */
  invalid?: boolean;
  errorMessageId?: string;
  /** Skip the drawn switch's slide and fade. The platform switch follows the system setting itself. */
  reducedMotion?: boolean;
  /** The platform touch-target floor for {@link HappierSwitchNative}; the drawn switch keeps its own 44px box. */
  minimumTouchTarget?: number;
  nativeID?: string;
  testID?: string;
  /** Receives the focusable control (a caller returning focus to the switch after a transient surface closes). */
  controlRef?: (instance: HappierFocusable | null) => void;
  /** Caller layout for the control box; the switch's own target floor always applies over it. */
  style?: HappierStyleProp;
}>;

type WebTransitionStyle = ViewStyle & {
  transitionProperty?: string;
  transitionDuration?: string;
  transitionTimingFunction?: string;
};

const TRACK_TRANSITION: WebTransitionStyle = {
  transitionProperty: 'background-color',
  transitionDuration: `${HAPPIER_MOTION_V1.fastMs}ms`,
  transitionTimingFunction: HAPPIER_MOTION_V1.standardEasingCss,
};
const THUMB_TRANSITION: WebTransitionStyle = {
  transitionProperty: 'transform',
  transitionDuration: `${HAPPIER_MOTION_V1.baseMs}ms`,
  transitionTimingFunction: HAPPIER_MOTION_V1.standardEasingCss,
};

function isToggleKey(key: string): boolean {
  return key === ' ' || key === 'Spacebar' || key === 'Enter';
}

/** The platform switch (iOS/Android) in the caller's colours, on the platform touch-target floor. */
export function HappierSwitchNative(props: HappierSwitchProps) {
  const { colors } = props;
  const target = props.minimumTouchTarget;
  return (
    <ReactNativeSwitch
      ref={props.controlRef as ((instance: ReactNativeSwitch | null) => void) | undefined}
      value={props.value}
      onValueChange={props.onValueChange ? (next) => { props.onValueChange?.(next); } : undefined}
      disabled={props.disabled}
      nativeID={props.nativeID}
      testID={props.testID}
      accessibilityRole="switch"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      style={[
        props.style as ViewStyle | undefined,
        target === undefined ? null : { minWidth: target, minHeight: target },
      ]}
      trackColor={{ false: colors.trackOff, true: colors.trackOn }}
      ios_backgroundColor={colors.trackOff}
      thumbColor={colors.thumb}
    />
  );
}

/** The drawn switch: the web control (see the module note). */
export function HappierSwitch(props: HappierSwitchProps) {
  const { value, onValueChange, disabled, colors } = props;
  const metrics = HAPPIER_SWITCH_METRICS[props.size ?? 'default'];
  const translateX = value ? metrics.trackWidth - metrics.thumbSize - metrics.padding * 2 : 0;
  const toggle = () => { onValueChange?.(!value); };
  return (
    <HappierPressable
      accessibilityRole="switch"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      describedById={props.describedById}
      invalid={props.invalid}
      errorMessageId={props.errorMessageId}
      checked={value}
      disabled={disabled}
      nativeID={props.nativeID}
      testID={props.testID}
      controlRef={props.controlRef}
      // A switch settles synchronously: the press returns nothing, so the
      // shared pending lifecycle never disables it mid-change.
      onPress={toggle}
      onKeyDown={(key) => {
        if (disabled === true || !isToggleKey(key)) return false;
        toggle();
        return true;
      }}
      style={(state) => [
        props.style,
        {
          minWidth: HAPPIER_SWITCH_METRICS.webTargetPx,
          minHeight: HAPPIER_SWITCH_METRICS.webTargetPx,
          alignItems: 'center',
          justifyContent: 'center',
          alignSelf: 'flex-start',
          ...HAPPIER_FOCUS_RING_DELEGATED_STYLE,
          opacity: disabled
            ? HAPPIER_SWITCH_METRICS.disabledOpacity
            : state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle : 1,
        },
      ]}
    >
      {(state) => <View
        style={[
          {
            width: metrics.trackWidth,
            height: metrics.trackHeight,
            borderRadius: metrics.trackHeight / 2,
            padding: metrics.padding,
            justifyContent: 'center',
            backgroundColor: value ? colors.trackOn : colors.trackOff,
          },
          // The ring follows the drawn track, not the larger hit box around it.
          happierFocusRingStyle({ visible: state.focused, color: colors.focusRing }),
          props.reducedMotion ? null : TRACK_TRANSITION,
        ]}
      >
        <View
          style={[
            {
              width: metrics.thumbSize,
              height: metrics.thumbSize,
              borderRadius: metrics.thumbSize / 2,
              backgroundColor: colors.thumb,
              transform: [{ translateX }],
            },
            props.reducedMotion ? null : THUMB_TRANSITION,
          ]}
        />
      </View>}
    </HappierPressable>
  );
}
