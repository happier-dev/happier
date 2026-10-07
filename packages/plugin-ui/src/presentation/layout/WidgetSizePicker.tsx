import { View } from 'react-native';
import { HappierSegmentedChoice, type HappierSegmentedChoiceColors } from '../form/SegmentedChoice.js';

export type WidgetSizePickerChoice = Readonly<{
  key: string;
  label: string;
  footprint: Readonly<{ columnSpan: number; columns: number; rowSpan: number }>;
}>;

export type WidgetSizePickerProps = Readonly<{
  /** Choices are already intersected and ordered by the domain presentation owner. */
  choices: readonly WidgetSizePickerChoice[];
  value?: string;
  onChange: (size: string) => void;
  accessibilityLabel: string;
  colors: HappierSegmentedChoiceColors;
  disabled?: boolean;
  testID?: string;
}>;

/** One size choice control for hosts and plugins; the footprint is a glyph, never a widget replica. */
export function WidgetSizePicker(props: WidgetSizePickerProps) {
  if (props.choices.length === 0) return null;
  const maxRows = Math.max(...props.choices.map(choice => choice.footprint.rowSpan));
  return <HappierSegmentedChoice
    testID={props.testID}
    accessibilityLabel={props.accessibilityLabel}
    colors={props.colors}
    disabled={props.disabled}
    wrap
    segments={props.choices.map(choice => ({
      key: choice.key, label: choice.label, selected: choice.key === props.value, disabled: false,
      testID: props.testID ? `${props.testID}.${choice.key}` : undefined,
      leading: <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 16 * choice.footprint.columnSpan / choice.footprint.columns,
          height: 16 * choice.footprint.rowSpan / maxRows, borderWidth: 1, borderRadius: 2,
          borderColor: choice.key === props.value ? props.colors.activeLabel : props.colors.label }} />
      </View>,
    }))}
    onSelect={index => {
      const choice = props.choices[index];
      if (choice && choice.key !== props.value) props.onChange(choice.key);
    }}
  />;
}
