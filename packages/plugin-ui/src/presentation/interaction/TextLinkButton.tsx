import type { ComponentType, ReactNode } from 'react';
import { View } from 'react-native';

import { resolveHappierInteractiveTargetFloor, useHappierTouchTargetSize } from '../../environment/interactiveTarget.js';
import type { HappierFocusable, HappierPortableStyle } from '../portableTypes.js';
import { happierFocusRingStyle } from './focusVisible.js';
import { HappierPressable } from './Pressable.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from './pressFeedback.js';

export type HappierTextLinkButtonProps = Readonly<{
  label: string;
  onPress: () => unknown;
  accessibilityLabel?: string;
  expanded?: boolean;
  disabled?: boolean;
  testID?: string;
  Text: ComponentType<Readonly<{
    children: ReactNode;
    style: HappierPortableStyle;
    numberOfLines?: number;
    testID?: string;
  }>>;
  labelStyle: HappierPortableStyle & Readonly<{ lineHeight: number }>;
  hoverColor: string;
  focusColor: string;
  /** A sentence that wraps naturally, with the action following its final separator. */
  note?: Readonly<{ text: string; style: HappierPortableStyle }>;
  /** The host's hit-area request; a finger's touch target applies without it. It never widens the label. */
  minimumTargetSize?: number;
  /** A surface's way to land keyboard focus on this link. */
  controlRef?: (instance: HappierFocusable | null) => void;
}>;

/** One inline operation owner for host links and Find notes, with host-bound text and theme. */
export function HappierTextLinkButton(props: HappierTextLinkButtonProps): ReactNode {
  const targetFloor = resolveHappierInteractiveTargetFloor(props.minimumTargetSize, useHappierTouchTargetSize());
  const grow = targetFloor === undefined ? 0 : Math.max(0, (targetFloor - props.labelStyle.lineHeight) / 2);
  const action = (
    <HappierPressable
      testID={props.testID}
      controlRef={props.controlRef}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      expanded={props.expanded}
      disabled={props.disabled}
      onPress={props.onPress}
      // The padded frame below already is the hit area; it never reaches sideways over the
      // neighbouring words, however short the label.
      hitReach={0}
      style={(state) => ({
        alignSelf: 'flex-start',
        // The frame grows vertically inside a wrapping sentence and gives that space back to it.
        paddingTop: grow,
        paddingBottom: grow,
        marginTop: -grow,
        marginBottom: -grow,
        opacity: state.disabled ? 0.4 : state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1,
      })}
    >
      {(state) => (
        <View style={{ borderRadius: 4, ...happierFocusRingStyle({ visible: state.focused, color: props.focusColor }) }}>
          <props.Text numberOfLines={1} style={{
            ...props.labelStyle,
            ...(state.hovered ? { color: props.hoverColor, textDecorationLine: 'underline' as const } : null),
          }}>
            {props.label}
          </props.Text>
        </View>
      )}
    </HappierPressable>
  );
  return props.note ? <props.Text style={props.note.style}>{`${props.note.text} · `}{action}</props.Text> : action;
}
