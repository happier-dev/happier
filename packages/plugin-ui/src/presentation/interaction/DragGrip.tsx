import { forwardRef, type ReactNode, type Ref } from 'react';
import { View } from 'react-native';

import type { HappierStyleProp } from '../portableTypes.js';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, happierFocusRingStyle, resolveHappierFocusRingVisible } from './focusVisible.js';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '../../environment/interactiveTarget.js';
import { useHappierHitArea } from './hitArea.js';
import { HappierPressable, type HappierPressableProps } from './Pressable.js';

/**
 * The ONE drag grip: the intentional handle a list shows when dragging must not compete with scroll,
 * swipe and tap (phone Organize mode, lab K1h) and wherever a surface keeps its body for other input
 * (a Board card). It is chrome only: the host attaches its gesture/keyboard owner around it.
 *
 * The visible glyph stays small; its hit area (the shared owner's: an invisible frame on the web,
 * `hitSlop` on native) reaches the platform's finger target, and the WCAG floor under a pointer, so the
 * grip is easy to catch without crowding the row.
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
  colors: Readonly<{ glyph: string; activeGlyph: string; activeFill: string; hoverFill?: string; focusRing?: string }>;
  renderGlyph: (color: string, size: number) => ReactNode;
  testID?: string;
  style?: HappierStyleProp;
}>;

type DragGripChromeProps = HappierDragGripProps & Readonly<{
  /** The grip's own hit area, when the grip itself is the target; a trigger's pressable owns it instead. */
  hitArea?: ReturnType<typeof useHappierHitArea>;
}>;

/** A standalone grip (a host gesture surface): the grip's box is the target, so it owns the hit area. */
export const HappierDragGrip = forwardRef<unknown, HappierDragGripProps>(function HappierDragGrip(props, ref) {
  const metrics = GRIP_METRICS[props.density ?? 'pointer'];
  const hitArea = useHappierHitArea({
    restingStyle: () => ({ width: metrics.box, height: metrics.box }),
    hitTarget: HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE,
  });
  return <DragGripChrome ref={ref} {...props} hitArea={hitArea} />;
});

const DragGripChrome = forwardRef<unknown, DragGripChromeProps>(function DragGripChrome(props, ref) {
  const metrics = GRIP_METRICS[props.density ?? 'pointer'];
  const active = props.active === true;
  const focused = props.interaction?.focused === true;
  const lit = props.interaction?.hovered === true || props.interaction?.pressed === true;
  const visible = props.revealed !== false || active || focused || props.density === 'touch';
  return (
    <View
      // The native renderer owns the instance; the public ref is deliberately opaque.
      ref={ref as Ref<View>}
      testID={props.testID}
      accessible={props.accessibilityLabel !== undefined}
      accessibilityLabel={props.accessibilityLabel}
      hitSlop={props.hitArea?.hitSlop}
      onLayout={props.hitArea?.onLayout}
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
      {props.hitArea?.frame}
      {props.renderGlyph(active ? props.colors.activeGlyph : props.colors.glyph, metrics.glyph)}
    </View>
  );
});

/** The interactive grip, shared by core, native plugins and hosted sources. */
export type HappierDragGripTriggerProps = Omit<HappierDragGripProps, 'interaction'> & Pick<HappierPressableProps,
  'onPress' | 'onKeyDown' | 'onFocusChange' | 'accessibilityHint' | 'accessibilityActions' | 'onAccessibilityAction'
  | 'controlRef' | 'expanded' | 'disabled' | 'tabIndex'>;

export function HappierDragGripTrigger(props: HappierDragGripTriggerProps) {
  return <HappierPressable
    testID={props.testID} accessibilityLabel={props.accessibilityLabel} accessibilityHint={props.accessibilityHint}
    accessibilityActions={props.accessibilityActions} onAccessibilityAction={props.onAccessibilityAction}
    controlRef={props.controlRef} expanded={props.expanded} disabled={props.disabled} hasPopup="menu"
    tabIndex={props.tabIndex}
    // The pressable is the target: it owns the one hit area, reaching the finger target past the grip.
    hitTarget={HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE}
    onPress={props.onPress} onKeyDown={props.onKeyDown} onFocusChange={props.onFocusChange}
    style={({ pressed }) => [props.style, {
      borderRadius: GRIP_METRICS[props.density ?? 'pointer'].radius,
      backgroundColor: pressed && !props.active ? props.colors.hoverFill ?? 'transparent' : 'transparent',
      // The grip draws the ring; without a ring colour the browser's own ring stays.
      ...(props.colors.focusRing ? HAPPIER_FOCUS_RING_DELEGATED_STYLE : null),
    }]}
  >{state => <DragGripChrome active={props.active} revealed={props.revealed} density={props.density}
    interaction={{ focused: state.focused, hovered: state.hovered }} colors={props.colors}
    renderGlyph={props.renderGlyph} />}</HappierPressable>;
}
