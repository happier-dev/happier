import type { ReactNode } from 'react';
import { View } from 'react-native';

import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HappierPressable } from '../interaction/Pressable.js';
import type { HappierStyleProp } from '../portableTypes.js';
import { HAPPIER_EMPTY_STATE_FRAME } from './InfoState.js';

/** Geometry of the one empty slot: the room inside the dashed frame and between its glyph, words and action. */
export const HAPPIER_EMPTY_SLOT_METRICS = Object.freeze({
  gapPx: 6,
  paddingPx: 12,
} as const);

export type HappierEmptySlotColors = Readonly<{
  /** The dashed edge: the host's ordinary border ink. */
  border: string;
  /** Under hover, press or while its surface is open, when the whole slot is the control. */
  activeFill?: string;
  focusRing?: string;
}>;

export type HappierEmptySlotProps = Readonly<{
  colors: HappierEmptySlotColors;
  /** A quiet leading mark (a plus). */
  glyph?: ReactNode;
  /** What belongs here ("Drop a widget here or"), drawn by the host's text owner. */
  label: ReactNode;
  /** One inline action that finishes the sentence ("add one"); a control of its own. */
  action?: ReactNode;
  /**
   * The whole slot is the control (an area's "Add widget" line). Leave it out when the slot only
   * marks a place, or carries its own inline `action`.
   */
  onPress?: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
  expanded?: boolean;
  hasPopup?: 'dialog' | 'menu';
  /** The least height the slot keeps (a touch target, a row). It grows with its container. */
  minHeight?: number;
  testID?: string;
  style?: HappierStyleProp;
}>;

/**
 * The ONE empty slot: the dashed outline that means "something can go here" (the empty-state owner's
 * `add` frame), with a glyph, a few words and at most one action, centred. A hole in a widget group,
 * the cell beside a previewed card, an area's "Add widget" line and a page's "new row" drop target
 * are all this slot, so dashed never means two things.
 *
 * It stretches to the room its container gives it; colours and text are the host's.
 */
export function HappierEmptySlot(props: HappierEmptySlotProps) {
  const frame = [
    HAPPIER_EMPTY_STATE_FRAME.add,
    {
      borderColor: props.colors.border,
      flexGrow: 1,
      minWidth: 0,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      // Wrapped or not, the words sit in the middle of the room the slot is given.
      alignContent: 'center',
      justifyContent: 'center',
      gap: HAPPIER_EMPTY_SLOT_METRICS.gapPx,
      padding: HAPPIER_EMPTY_SLOT_METRICS.paddingPx,
      ...(props.minHeight === undefined
        ? null
        : { minHeight: props.minHeight }),
    },
  ] as const;
  const content = (
    <>
      {props.glyph ?? null}
      {props.label}
      {props.action ?? null}
    </>
  );
  if (!props.onPress) {
    return (
      <View
        testID={props.testID}
        accessibilityLabel={props.accessibilityLabel}
        style={[...frame, props.style] as HappierStyleProp}
      >
        {content}
      </View>
    );
  }
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.disabled}
      expanded={props.expanded}
      hasPopup={props.hasPopup}
      onPress={props.onPress}
      style={(state) =>
        [
          ...frame,
          (state.hovered || state.pressed || props.expanded === true) &&
          props.colors.activeFill
            ? { backgroundColor: props.colors.activeFill }
            : null,
          props.colors.focusRing
            ? happierFocusRingStyle({
                visible: state.focused,
                color: props.colors.focusRing,
              })
            : null,
          props.style,
        ] as HappierStyleProp
      }
    >
      {content}
    </HappierPressable>
  );
}
