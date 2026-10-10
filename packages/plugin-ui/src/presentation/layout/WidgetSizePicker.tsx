import { useCallback, useState, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { HappierSegmentedChoice, type HappierSegmentedChoiceColors } from '../form/SegmentedChoice.js';

export type WidgetSizePickerChoice = Readonly<{
  key: string;
  label: string;
  footprint: Readonly<{ columnSpan: number; columns: number; rowSpan: number }>;
  /** The size cannot be chosen here (a widget inside a half-width group); the host says why beside it. */
  unavailable?: boolean;
}>;

/** What a host's compact picker receives when the segments do not fit: the same choices and value. */
export type WidgetSizePickerCompactInput = Readonly<{
  choices: readonly WidgetSizePickerChoice[];
  value?: string;
  onChange: (size: string) => void;
  accessibilityLabel: string;
  disabled?: boolean;
}>;

export type WidgetSizePickerProps = Readonly<{
  /** Choices are already intersected and ordered by the domain presentation owner. */
  choices: readonly WidgetSizePickerChoice[];
  value?: string;
  onChange: (size: string) => void;
  accessibilityLabel: string;
  colors: HappierSegmentedChoiceColors;
  disabled?: boolean;
  /**
   * The host's menu/select form of the same choice, used when the room is narrower than the
   * segments. Without one, the track keeps its one line and scrolls sideways.
   */
  renderCompact?: (input: WidgetSizePickerCompactInput) => ReactNode;
  testID?: string;
}>;

type LayoutEvent = Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ width: number }> }> }>;

/**
 * One size choice control for hosts and plugins; the footprint is a glyph, never a widget replica.
 *
 * It never wraps: the segments stand on one track while the room holds them, and below that the
 * host's compact picker takes over (segmented when it fits, the menu otherwise). The track's own
 * width is measured where nothing constrains it, so the choice follows the real labels at the
 * person's text size rather than an estimate.
 */
export function WidgetSizePicker(props: WidgetSizePickerProps) {
  const [room, setRoom] = useState<number | null>(null);
  const [natural, setNatural] = useState<number | null>(null);
  const onRoomLayout = useCallback((event: LayoutEvent) => {
    const width = Math.round(event.nativeEvent.layout.width);
    setRoom((previous) => (previous === width ? previous : width));
  }, []);
  const onTrackLayout = useCallback((event: LayoutEvent) => {
    const width = Math.round(event.nativeEvent.layout.width);
    setNatural((previous) => (previous === width ? previous : width));
  }, []);
  if (props.choices.length === 0) return null;
  const compact = props.renderCompact !== undefined && room !== null && natural !== null && natural > room;
  const testID = props.testID;
  if (compact) {
    return (
      <View testID={testID ? `${testID}.room` : undefined} onLayout={onRoomLayout} style={{ alignSelf: 'stretch' }}>
        {props.renderCompact!({
          choices: props.choices,
          ...(props.value === undefined ? {} : { value: props.value }),
          onChange: props.onChange,
          accessibilityLabel: props.accessibilityLabel,
          ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
        })}
      </View>
    );
  }
  const maxRows = Math.max(...props.choices.map(choice => choice.footprint.rowSpan));
  return (
    <View testID={testID ? `${testID}.room` : undefined} onLayout={onRoomLayout} style={{ alignSelf: 'stretch', alignItems: 'center' }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxWidth: '100%', flexGrow: 0 }}>
        <View testID={testID ? `${testID}.track` : undefined} onLayout={onTrackLayout} style={{ flexDirection: 'row' }}>
          <HappierSegmentedChoice
            testID={testID}
            accessibilityLabel={props.accessibilityLabel}
            colors={props.colors}
            disabled={props.disabled}
            segments={props.choices.map(choice => ({
              key: choice.key, label: choice.label, selected: choice.key === props.value, disabled: choice.unavailable === true,
              testID: testID ? `${testID}.${choice.key}` : undefined,
              leading: <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
                style={{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: 16 * choice.footprint.columnSpan / choice.footprint.columns,
                  height: 16 * choice.footprint.rowSpan / maxRows, borderWidth: 1, borderRadius: 2,
                  borderColor: choice.key === props.value ? props.colors.activeLabel : props.colors.label }} />
              </View>,
            }))}
            onSelect={index => {
              const choice = props.choices[index];
              if (choice && !choice.unavailable && choice.key !== props.value) props.onChange(choice.key);
            }}
          />
        </View>
      </ScrollView>
    </View>
  );
}
