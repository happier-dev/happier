import { Pressable as ReactNativePressable, Switch as ReactNativeSwitch, View, type ViewStyle } from 'react-native';

import { HappierPressable } from '../interaction/Pressable.js';
import { useHappierHitArea } from '../interaction/hitArea.js';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HAPPIER_MOTION_V1 } from '../interaction/motion.js';
import type { HappierFocusable, HappierStyleProp } from '../portableTypes.js';
import type { HappierHitReach } from '../../environment/interactiveTarget.js';

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
  default: Object.freeze({ trackWidth: 40, trackHeight: 24, thumbSize: 20, padding: 2 }),
  compact: Object.freeze({ trackWidth: 32, trackHeight: 18, thumbSize: 14, padding: 2 }),
  /**
   * While pressed, the thumb widens toward the track's centre (the physical
   * squash of a switch about to move), by this much, and settles back on release.
   */
  pressStretchPx: 4,
  /** The web control's hit area around the drawn track (the shared hit-area owner's frame); it takes no layout. */
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
  /**
   * How far the hit area may reach past the drawn switch on each side (the shared hit-area owner's
   * reach): half the gap to a neighbour, `0` toward a control that owns that space (the row above a
   * trigger's actions line).
   */
  hitReach?: HappierHitReach;
  /**
   * The row this switch sits in owns its press (tap anywhere on the row toggles it): the switch draws
   * its state only — no press, focus or accessibility node of its own — so a tap is counted once.
   */
  presentational?: boolean;
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
  transitionProperty: 'transform, width',
  transitionDuration: `${HAPPIER_MOTION_V1.baseMs}ms`,
  transitionTimingFunction: HAPPIER_MOTION_V1.standardEasingCss,
};

const THUMB_SHADOW = '0 1px 2px rgba(0, 0, 0, 0.18), 0 1px 1px rgba(0, 0, 0, 0.06)';

function isToggleKey(key: string): boolean {
  return key === ' ' || key === 'Spacebar' || key === 'Enter';
}

/**
 * The platform switch (iOS/Android) in the caller's colours, at the platform's own size. Under a finger
 * its hit area reaches the touch target past the drawn switch: a press there toggles it, while the
 * switch itself stays the one accessible control.
 */
export function HappierSwitchNative(props: HappierSwitchProps) {
  const { colors } = props;
  const hitArea = useHappierHitArea({ restingStyle: () => null, hitTarget: props.minimumTouchTarget, hitReach: props.hitReach });
  const toggle = props.onValueChange;
  const control = (
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
      style={props.style as ViewStyle | undefined}
      onLayout={hitArea.onLayout}
      trackColor={{ false: colors.trackOff, true: colors.trackOn }}
      ios_backgroundColor={colors.trackOff}
      thumbColor={colors.thumb}
    />
  );
  if (!props.presentational) {
    if (hitArea.onLayout === undefined || toggle === undefined) return control;
    // The wrapper only catches presses that land beside the switch; one on the switch is its own.
    return (
      <ReactNativePressable
        accessible={false}
        importantForAccessibility="no"
        disabled={props.disabled}
        hitSlop={hitArea.hitSlop}
        onPress={() => { toggle(!props.value); }}
      >
        {control}
      </ReactNativePressable>
    );
  }
  return (
    <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {control}
    </View>
  );
}

/** The drawn switch: the web control (see the module note). */
export function HappierSwitch(props: HappierSwitchProps) {
  const { value, onValueChange, disabled, colors } = props;
  const metrics = HAPPIER_SWITCH_METRICS[props.size ?? 'default'];
  const thumbTravel = (thumbWidth: number) => (value ? metrics.trackWidth - thumbWidth - metrics.padding * 2 : 0);
  const toggle = () => { onValueChange?.(!value); };
  const renderTrack = (pressed: boolean, focused: boolean) => {
    const thumbWidth = metrics.thumbSize + (pressed && disabled !== true ? HAPPIER_SWITCH_METRICS.pressStretchPx : 0);
    return <View
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
        happierFocusRingStyle({ visible: focused, color: colors.focusRing }),
        props.reducedMotion ? null : TRACK_TRANSITION,
      ]}
    >
      <View
        style={[
          {
            width: thumbWidth,
            height: metrics.thumbSize,
            borderRadius: metrics.thumbSize / 2,
            backgroundColor: colors.thumb,
            // A soft, close shadow lifts the thumb off either track colour (white on a light-grey
            // off track otherwise reads as a hole, not a knob).
            boxShadow: THUMB_SHADOW,
            transform: [{ translateX: thumbTravel(thumbWidth) }],
          },
          props.reducedMotion ? null : THUMB_TRANSITION,
        ]}
      />
    </View>;
  };
  if (props.presentational) {
    // The enclosing row is the control; this is only its picture (no role, focus or press).
    return (
      <View
        pointerEvents="none"
        aria-hidden
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        testID={props.testID}
        style={[props.style as ViewStyle | undefined, { opacity: disabled ? HAPPIER_SWITCH_METRICS.disabledOpacity : 1, alignSelf: 'flex-start' }]}
      >
        {renderTrack(false, false)}
      </View>
    );
  }
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
      // The switch is drawn at its track; its hit area reaches the target past it, within the caller's reach.
      hitTarget={HAPPIER_SWITCH_METRICS.webTargetPx}
      hitReach={props.hitReach}
      onKeyDown={(key) => {
        if (disabled === true || !isToggleKey(key)) return false;
        toggle();
        return true;
      }}
      style={(state) => [
        props.style,
        {
          // In flow the switch is exactly its track, so it never makes a row taller.
          width: metrics.trackWidth,
          height: metrics.trackHeight,
          alignItems: 'center',
          justifyContent: 'center',
          alignSelf: 'flex-start',
          ...HAPPIER_FOCUS_RING_DELEGATED_STYLE,
          // The thumb's squash is the press feedback; the control never dims on press.
          opacity: disabled ? HAPPIER_SWITCH_METRICS.disabledOpacity : 1,
        },
      ]}
    >
      {(state) => renderTrack(state.pressed, state.focused)}
    </HappierPressable>
  );
}
