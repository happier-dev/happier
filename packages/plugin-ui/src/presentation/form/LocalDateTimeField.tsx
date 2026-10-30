import {
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { View } from 'react-native';

import { useOptionalHappierUiAccessibility } from '../../environment/context.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { happierDiscretePressStyle } from '../interaction/pressFeedback.js';
import {
  HappierField,
  HappierTextField,
  HappierValidationMessage,
} from './Fields.js';
import {
  formatHappierLocalDateInput,
  formatHappierLocalTimeInput,
  parseHappierLocalDateTime,
  type HappierLocalDateTimeDraft,
} from './localDateTimeValue.js';

export type HappierLocalDateTimePickerMode = 'date' | 'time';

/** One open picker: which part, where it hangs, what it shows, and how it answers. */
export type HappierLocalDateTimePickerRequest = Readonly<{
  mode: HappierLocalDateTimePickerMode;
  /** The field the picker hangs from. */
  anchorRef: RefObject<unknown>;
  /** The reading the picker starts from: the typed moment when it parses, otherwise now. */
  value: Date;
  /** The earliest day the picker offers. */
  minimumDate: Date;
  /** The picked moment; the field takes the part it asked for and keeps the other. */
  onChange: (value: Date) => void;
  onDismiss: () => void;
}>;

/**
 * The host's own platform date and time picker. Absent where the host has none (a binary without the
 * native picker, an isolated test), and then the field is typed alone.
 */
export type HappierLocalDateTimePickerHost = Readonly<{
  /** The glyph on each field's picker button (a calendar, a clock). */
  renderGlyph: (mode: HappierLocalDateTimePickerMode) => ReactNode;
  renderPicker: (request: HappierLocalDateTimePickerRequest) => ReactNode;
}>;

export type HappierLocalDateTimeFieldProps = Readonly<{
  /** The instant the reading must be after; also the picker's earliest day. */
  nowMs: number;
  value: HappierLocalDateTimeDraft;
  onChange: (value: HappierLocalDateTimeDraft) => void;
  labels: Readonly<{ date: string; time: string; pastInstant: string }>;
  /** Distinguishes this field's controls from any other on the same screen. */
  testIDPrefix: string;
  picker?: HappierLocalDateTimePickerHost;
  theme: HappierUiTheme;
}>;

const TIME_FIELD_WIDTH = 132;
/** A whole `YYYY-MM-DD` beside the picker button; narrower, the time wraps below. */
const DATE_FIELD_MIN_WIDTH = 168;
const PICKER_BUTTON_WIDTH = 40;

/**
 * One local date and time, typed or picked: a date field and a time field, each with the host's picker
 * behind its own button, and one message when the reading is not a future moment. It owns no domain
 * meaning; the caller decides what the instant is for (a reminder, a lease's end, an expiry), what the
 * fields are called, and what to do while the reading does not resolve
 * (`resolveHappierFutureLocalDateTime` returns `null`).
 */
export function HappierLocalDateTimeField(
  props: HappierLocalDateTimeFieldProps,
): ReactElement {
  const { theme, picker } = props;
  const reducedMotion =
    useOptionalHappierUiAccessibility()?.reducedMotion === true;
  const [pickerMode, setPickerMode] =
    useState<HappierLocalDateTimePickerMode | null>(null);
  const dateAnchorRef = useRef<View | null>(null);
  const timeAnchorRef = useRef<View | null>(null);
  const parsed = parseHappierLocalDateTime(props.value);
  const pickerValue = useMemo(
    () => new Date(parsed ?? props.nowMs),
    [parsed, props.nowMs],
  );

  const part = (mode: HappierLocalDateTimePickerMode) => {
    const label = props.labels[mode];
    return (
      <HappierField
        label={label}
        theme={theme}
        style={
          mode === 'date'
            ? { flexGrow: 1, flexShrink: 1, flexBasis: DATE_FIELD_MIN_WIDTH, minWidth: DATE_FIELD_MIN_WIDTH }
            : { width: TIME_FIELD_WIDTH }
        }
      >
        <View
          ref={mode === 'date' ? dateAnchorRef : timeAnchorRef}
          style={{ position: 'relative' }}
        >
          <HappierTextField
            label={label}
            value={props.value[mode]}
            onChangeText={(text) =>
              props.onChange({ ...props.value, [mode]: text })
            }
            placeholder={mode === 'date' ? 'YYYY-MM-DD' : '09:00'}
            autoCapitalize="none"
            autoCorrect={false}
            {...(mode === 'time'
              ? { keyboardType: 'numbers-and-punctuation' as const }
              : {})}
            testID={`${props.testIDPrefix}-${mode}-input`}
            theme={theme}
          />
          {picker ? (
            <HappierPressable
              testID={`${props.testIDPrefix}-${mode}-picker-button`}
              accessibilityRole="button"
              accessibilityLabel={label}
              expanded={pickerMode === mode}
              // The glyph button sits inside the field: its hit area never reaches left into the text it shares the field with.
              hitReach={{ left: 0 }}
              onPress={() =>
                setPickerMode((current) => (current === mode ? null : mode))
              }
              style={({ pressed }) => [
                {
                  position: 'absolute',
                  right: 4,
                  top: 4,
                  bottom: 4,
                  width: PICKER_BUTTON_WIDTH,
                  alignItems: 'center',
                  justifyContent: 'center',
                },
                happierDiscretePressStyle(pressed, reducedMotion),
              ]}
            >
              {picker.renderGlyph(mode)}
            </HappierPressable>
          ) : null}
        </View>
      </HappierField>
    );
  };

  return (
    <View style={{ gap: theme.spacing.medium }}>
      {/* A column too narrow for both fields puts the time under the date instead of clipping the date. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.medium }}>
        {part('date')}
        {part('time')}
      </View>
      {picker && pickerMode
        ? picker.renderPicker({
            mode: pickerMode,
            anchorRef: pickerMode === 'date' ? dateAnchorRef : timeAnchorRef,
            value: pickerValue,
            minimumDate: new Date(props.nowMs),
            onDismiss: () => setPickerMode(null),
            onChange: (picked) =>
              props.onChange(
                pickerMode === 'date'
                  ? {
                      ...props.value,
                      date: formatHappierLocalDateInput(picked),
                    }
                  : {
                      ...props.value,
                      time: formatHappierLocalTimeInput(picked),
                    },
              ),
          })
        : null}
      {parsed !== null && parsed <= props.nowMs ? (
        <HappierValidationMessage
          message={props.labels.pastInstant}
          testID={`${props.testIDPrefix}-past-instant`}
          theme={theme}
        />
      ) : null}
    </View>
  );
}
