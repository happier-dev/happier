import { View } from 'react-native';
import type { HappierStyleProp } from '../portableTypes.js';

/** A row-sized target's corner; a target laid over a rounded host passes that host's radius instead. */
const DEFAULT_RADIUS = 6;

/**
 * The entity drop vocabulary's strokes (DnD lab E1/C2, widget-groups wgdnd): a row target takes the
 * hairline outline, a container that will hold the carried item (a group, a pane zone) the stronger
 * one, and an insertion place the line. Hosts read these instead of restating a width.
 */
export const HAPPIER_DROP_INDICATOR_METRICS = Object.freeze({
  rowOutlinePx: 1,
  containerOutlinePx: 1.5,
  linePx: 2,
});

/** Shared admitted-target chrome. Admission and pending/retired visibility stay with the drag owner. */
export function HappierDropTargetOutline(props: Readonly<{
  colors: Readonly<{ border: string; background: string }>;
  /** The radius of the surface the outline lies over (a composer, a card), so the corners coincide. */
  radius?: number;
  /** `container`: the target will hold the carried item (a group); `row` (default): it is the place itself. */
  weight?: 'row' | 'container';
  testID?: string;
  style?: HappierStyleProp;
}>) {
  const borderWidth = props.weight === 'container'
    ? HAPPIER_DROP_INDICATOR_METRICS.containerOutlinePx : HAPPIER_DROP_INDICATOR_METRICS.rowOutlinePx;
  return <View testID={props.testID} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    pointerEvents="none" style={[{ borderWidth, borderRadius: props.radius ?? DEFAULT_RADIUS, borderColor: props.colors.border, backgroundColor: props.colors.background }, props.style]} />;
}

/**
 * The insertion line: where the carried item will land between two others. `vertical` marks a place
 * between items laid out in a row (a tab strip). The drag owner decides whether a line shows at all.
 */
export function HappierDropInsertionLine(props: Readonly<{
  color: string;
  orientation?: 'horizontal' | 'vertical';
  testID?: string;
  style?: HappierStyleProp;
}>) {
  const thickness = HAPPIER_DROP_INDICATOR_METRICS.linePx;
  return <View testID={props.testID} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    pointerEvents="none" style={[
      props.orientation === 'vertical' ? { width: thickness, alignSelf: 'stretch' } : { height: thickness },
      { borderRadius: thickness / 2, backgroundColor: props.color },
      props.style,
    ]} />;
}
