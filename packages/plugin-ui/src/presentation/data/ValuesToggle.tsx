import type { HappierUiTheme } from '../../environment/types.js';
import { HappierPressable } from '../interaction/Pressable.js';
import type { HappierStyleProp } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { useHappierDataTextStyles } from './dataText.js';

/**
 * The one control that opens a chart's exact values (Details, Exact values, Show all): quiet meta in the secondary
 * ink, like the axis it sits by, never a bold word under the plot. Every chart owner draws it here so it reads the
 * same under each plot; the owner decides only where it stands (the legend's end or its own trailing line).
 */
export function HappierDataValuesToggle(props: Readonly<{
  theme: HappierUiTheme;
  /** The words shown now: what pressing does ("Details" closed, "Collapse" open). */
  label: string;
  accessibilityLabel?: string;
  expanded: boolean;
  onPress: () => void;
  style?: HappierStyleProp;
  testID?: string;
}>) {
  const text = useHappierDataTextStyles(props.theme);
  return (
    <HappierPressable testID={props.testID} accessibilityLabel={props.accessibilityLabel ?? props.label}
      expanded={props.expanded} onPress={props.onPress} style={props.style}>
      <HappierText style={{ ...text.caption, color: props.theme.colors.secondaryText }}>{props.label}</HappierText>
    </HappierPressable>
  );
}
