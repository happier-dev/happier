import { View } from 'react-native';
import type { HappierStyleProp } from '../portableTypes.js';

/** A row-sized target's corner; a target laid over a rounded host passes that host's radius instead. */
const DEFAULT_RADIUS = 6;

/** Shared admitted-target chrome. Admission and pending/retired visibility stay with the drag owner. */
export function HappierDropTargetOutline(props: Readonly<{
  colors: Readonly<{ border: string; background: string }>;
  /** The radius of the surface the outline lies over (a composer, a card), so the corners coincide. */
  radius?: number;
  testID?: string;
  style?: HappierStyleProp;
}>) {
  return <View testID={props.testID} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    pointerEvents="none" style={[{ borderWidth: 1, borderRadius: props.radius ?? DEFAULT_RADIUS, borderColor: props.colors.border, backgroundColor: props.colors.background }, props.style]} />;
}
