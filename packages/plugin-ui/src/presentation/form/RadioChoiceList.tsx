import { useRef, type ReactNode } from 'react';
import { View } from 'react-native';

import { useOptionalHappierUiTypography } from '../../environment/context.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { resolveHappierPageTextStyle } from '../layout/pageText.js';
import { HappierText } from '../text/Text.js';
import { HappierRadioMark } from './RadioMark.js';

/** The gap between the mark and its label, and each option's vertical inset (lab `.fm-rd` rows). */
export const HAPPIER_RADIO_CHOICE_LIST_METRICS = Object.freeze({
  markGap: 10,
  optionPaddingVertical: 5,
});

export type HappierRadioChoiceOption<T extends string = string> = Readonly<{
  id: T;
  title: string;
  disabled?: boolean;
}>;

/**
 * One choice among a few long-labelled options, as a compact list of radio rows: the control for a
 * decision whose options are sentences ("Stop after 1 h unused") and so do not fit a segmented bar,
 * inside a summary, a settings section or a provisioner's options page. State the chosen option's
 * consequence in one line beneath it; the list itself draws only the options.
 *
 * It is a real radio group: one tab stop on the chosen option, arrow keys move and choose (a radio
 * group has no separate focus and selection), and each option announces its checked state. The mark
 * is the shared `HappierRadioMark`.
 */
export function HappierRadioChoiceList<T extends string>(
  props: Readonly<{
    options: readonly HappierRadioChoiceOption<T>[];
    value: T | null;
    onChange: (id: T) => void;
    accessibilityLabel: string;
    disabled?: boolean;
    theme: HappierUiTheme;
    /** Each option's test id is `prefix:id`. */
    testIDPrefix?: string;
    /** A host binds its own text owner; the default is the row-description step in primary ink. */
    renderTitle?: (option: HappierRadioChoiceOption<T>, selected: boolean) => ReactNode;
  }>,
) {
  const typography = useOptionalHappierUiTypography();
  const controls = useRef<Array<Readonly<{ focus: () => void }> | null>>([]);
  const move = (from: number, delta: number) => {
    const count = props.options.length;
    for (let step = 1; step <= count; step += 1) {
      const next = (from + delta * step + count * step) % count;
      const option = props.options[next]!;
      if (option.disabled) continue;
      props.onChange(option.id);
      controls.current[next]?.focus();
      return;
    }
  };
  // With nothing chosen the first option takes the group's one tab stop.
  const tabStop = props.options.some((option) => option.id === props.value)
    ? props.value
    : (props.options[0]?.id ?? null);
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={props.accessibilityLabel}
      aria-label={props.accessibilityLabel}
    >
      {props.options.map((option, index) => {
        const selected = option.id === props.value;
        const disabled = props.disabled === true || option.disabled === true;
        return (
          <HappierPressable
            key={option.id}
            testID={props.testIDPrefix ? `${props.testIDPrefix}:${option.id}` : undefined}
            controlRef={(instance) => {
              controls.current[index] = instance;
            }}
            accessibilityRole="radio"
            accessibilityLabel={option.title}
            checked={selected}
            tabIndex={option.id === tabStop ? 0 : -1}
            disabled={disabled}
            onPress={() => props.onChange(option.id)}
            onKeyDown={(key) => {
              if (key === 'ArrowDown' || key === 'ArrowRight') {
                move(index, 1);
                return true;
              }
              if (key === 'ArrowUp' || key === 'ArrowLeft') {
                move(index, -1);
                return true;
              }
              return false;
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: HAPPIER_RADIO_CHOICE_LIST_METRICS.markGap,
              paddingVertical: HAPPIER_RADIO_CHOICE_LIST_METRICS.optionPaddingVertical,
            }}
          >
            <HappierRadioMark selected={selected} disabled={disabled} theme={props.theme} />
            {props.renderTitle ? (
              props.renderTitle(option, selected)
            ) : (
              <HappierText
                style={{
                  ...resolveHappierPageTextStyle('rowDescription', typography),
                  color: props.theme.colors.text,
                  flexShrink: 1,
                }}
              >
                {option.title}
              </HappierText>
            )}
          </HappierPressable>
        );
      })}
    </View>
  );
}
