import { forwardRef, type ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierStyleProp } from '../portableTypes.js';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, happierFocusRingStyle, resolveHappierFocusRingVisible } from './focusVisible.js';
import { HappierPressable, type HappierPressableProps } from './Pressable.js';

/**
 * The ONE drag grip: the intentional handle a list shows when dragging must not compete with scroll,
 * swipe and tap (phone Organize mode, lab K1h) and wherever a surface keeps its body for other input
 * (a Board card). It is chrome only: the host attaches its gesture/keyboard owner around it.
 *
 * The visible glyph stays small; the touch target is widened with hit slop to the platform minimum
 * so the grip is easy to catch without crowding the row.
 */
export type HappierDragGripDensity = 'pointer' | 'touch';

const GRIP_METRICS = {
  pointer: { box: 22, glyph: 15, radius: 6 },
  touch: { box: 30, glyph: 18, radius: 8 },
} as const satisfies Record<HappierDragGripDensity, Readonly<{ box: number; glyph: number; radius: number }>>;

export const HAPPIER_DRAG_GRIP_METRICS = GRIP_METRICS;

export type HappierDragGripProps = Readonly<{
  density?: HappierDragGripDensity;
  /** The item is picked up through this grip right now. */
  active?: boolean;
  /** Pointer chrome may stay quiet until its host is hovered or focused. Touch and active grips stay visible. */
  revealed?: boolean;
  /**
   * Interaction state of the pressable that owns this grip (the shared grip trigger). Keyboard focus
   * draws the focus ring (focus-visible only, never after a pointer press); hover and press tint it.
   */
  interaction?: Readonly<{ focused?: boolean; hovered?: boolean; pressed?: boolean }>;
  /**
   * Spoken name ("Move Review #2481") when the grip itself is the control. Omit it inside a pressable
   * that already owns the name, so the grip is not announced twice.
   */
  accessibilityLabel?: string;
  /** Minimum interactive size of the platform; the hit area grows to it around the glyph. */
  minimumTargetSize?: number;
  colors: Readonly<{ glyph: string; activeGlyph: string; activeFill: string; hoverFill?: string; focusRing?: string }>;
  renderGlyph: (color: string, size: number) => ReactNode;
  testID?: string;
  style?: HappierStyleProp;
}>;

export const HappierDragGrip = forwardRef<View, HappierDragGripProps>(function HappierDragGrip(props, ref) {
  const metrics = GRIP_METRICS[props.density ?? 'pointer'];
  const slop = Math.max(0, Math.ceil(((props.minimumTargetSize ?? metrics.box) - metrics.box) / 2));
  const active = props.active === true;
  const focused = props.interaction?.focused === true;
  const lit = props.interaction?.hovered === true || props.interaction?.pressed === true;
  const visible = props.revealed !== false || active || focused || props.density === 'touch';
  return (
    <View
      ref={ref}
      testID={props.testID}
      accessible={props.accessibilityLabel !== undefined}
      accessibilityLabel={props.accessibilityLabel}
      hitSlop={slop > 0 ? { top: slop, bottom: slop, left: slop, right: slop } : undefined}
      style={[
        {
          width: metrics.box,
          height: metrics.box,
          borderRadius: metrics.radius,
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          // Only the chrome fades: the host's focus/gesture target and this grip's geometry remain mounted.
          opacity: visible ? 1 : 0,
          backgroundColor: active ? props.colors.activeFill : lit ? props.colors.hoverFill ?? 'transparent' : 'transparent',
          // The ring follows the grip's own corner, so it is concentric with the glyph's box.
          ...(props.colors.focusRing ? happierFocusRingStyle({ visible: resolveHappierFocusRingVisible(focused), color: props.colors.focusRing }) : null),
        },
        props.style,
      ] as HappierStyleProp}
    >
      {props.renderGlyph(active ? props.colors.activeGlyph : props.colors.glyph, metrics.glyph)}
    </View>
  );
});

/** The interactive grip, shared by core, native plugins and hosted sources. */
export type HappierDragGripTriggerProps = Omit<HappierDragGripProps, 'interaction'> & Pick<HappierPressableProps,
  'onPress' | 'onKeyDown' | 'onFocusChange' | 'accessibilityHint' | 'accessibilityActions' | 'onAccessibilityAction'
  | 'controlRef' | 'expanded' | 'disabled'>;

export function HappierDragGripTrigger(props: HappierDragGripTriggerProps) {
  return <HappierPressable
    testID={props.testID} accessibilityLabel={props.accessibilityLabel} accessibilityHint={props.accessibilityHint}
    accessibilityActions={props.accessibilityActions} onAccessibilityAction={props.onAccessibilityAction}
    controlRef={props.controlRef} expanded={props.expanded} disabled={props.disabled} hasPopup="menu"
    onPress={props.onPress} onKeyDown={props.onKeyDown} onFocusChange={props.onFocusChange}
    style={({ pressed }) => [props.style, {
      borderRadius: GRIP_METRICS[props.density ?? 'pointer'].radius,
      backgroundColor: pressed && !props.active ? props.colors.hoverFill ?? 'transparent' : 'transparent',
      // The grip draws the ring; without a ring colour the browser's own ring stays.
      ...(props.colors.focusRing ? HAPPIER_FOCUS_RING_DELEGATED_STYLE : null),
    }]}
  >{state => <HappierDragGrip active={props.active} revealed={props.revealed} density={props.density}
    interaction={{ focused: state.focused, hovered: state.hovered }} colors={props.colors}
    minimumTargetSize={props.minimumTargetSize} renderGlyph={props.renderGlyph} />}</HappierPressable>;
}
