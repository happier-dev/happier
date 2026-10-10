import type { ReactNode } from 'react';
import { View } from 'react-native';

import { useOptionalHappierUiTypography } from '../../environment/context.js';
import { HAPPIER_MENU_ROW_METRICS } from '../interaction/Menu.js';
import { resolveHappierPageTextStyle } from '../layout/pageText.js';
import { HappierText } from '../text/Text.js';
import {
  HappierSegmentedChoice,
  type HappierSegmentedChoiceColors,
  type HappierSegmentedSize,
} from './SegmentedChoice.js';

/** One choice of a segmented row. */
export type HappierSegmentedChoiceRowOption<T extends string = string> =
  Readonly<{
    id: T;
    label: string;
    /** What choosing this option means; the row shows the chosen option's description under its label. */
    description?: string;
    /** Not choosable right now, and the row's own description already says why. */
    disabled?: boolean;
    /**
     * Not choosable right now, and why ("Daily usage needs the full width"). The segment stays visible,
     * announces the reason with its name, and the row shows the reason under its label.
     */
    unavailableReason?: string;
    /** A glyph before the segment's label. */
    leading?: ReactNode;
  }>;

export type HappierSegmentedChoiceRowModel<T extends string = string> =
  Readonly<{
    segments: readonly Readonly<{
      id: T;
      label: string;
      selected: boolean;
      disabled: boolean;
      /** The option's name, with why it is unavailable when it is. */
      accessibilityLabel: string;
      unavailableReason?: string;
      leading?: ReactNode;
    }>[];
    /** The chosen option's description, else the row's own. */
    description: string | undefined;
    /** Each distinct reason an option is unavailable, in option order. */
    unavailableReasons: readonly string[];
    /** The one line under the label: the description, then why any option is unavailable. */
    detail: string | undefined;
  }>;

/**
 * The ONE rule of a "label + inline segmented choice" row (a group's Width, Frame and Dividers; a
 * setting choosing between two to four short options): an unavailable option is shown, never hidden,
 * and says why — in its accessible name and in the line under the row's label. Happier core's
 * configuration and menu rows and a plugin's own rows resolve their segments through here, so an
 * unavailable choice reads the same wherever it is drawn.
 */
export function resolveHappierSegmentedChoiceRow<T extends string>(
  input: Readonly<{
    options: readonly HappierSegmentedChoiceRowOption<T>[];
    value: T;
    /** The row's own description, shown when the chosen option has none. */
    description?: string;
  }>,
): HappierSegmentedChoiceRowModel<T> {
  const description =
    input.options.find((option) => option.id === input.value)?.description ??
    input.description;
  const unavailableReasons = [
    ...new Set(
      input.options.flatMap((option) =>
        option.unavailableReason ? [option.unavailableReason] : [],
      ),
    ),
  ];
  const detail = [description, ...unavailableReasons].filter(Boolean).join(' ');
  return {
    segments: input.options.map((option) => ({
      id: option.id,
      label: option.label,
      selected: option.id === input.value,
      disabled:
        option.disabled === true || option.unavailableReason !== undefined,
      accessibilityLabel: option.unavailableReason
        ? `${option.label}, ${option.unavailableReason}`
        : option.label,
      ...(option.unavailableReason
        ? { unavailableReason: option.unavailableReason }
        : {}),
      ...(option.leading ? { leading: option.leading } : {}),
    })),
    description,
    unavailableReasons,
    detail: detail.length > 0 ? detail : undefined,
  };
}

export type HappierSegmentedChoiceRowColors = HappierSegmentedChoiceColors &
  Readonly<{
    /** The row's label ink. */
    rowLabel: string;
    /** The line under the label (a description, or why an option is unavailable). */
    rowDetail: string;
  }>;

export type HappierSegmentedChoiceRowProps<T extends string = string> =
  Readonly<{
    label: string;
    /** The row's glyph, in the menu row's leading column so labels align down a menu. */
    leading?: ReactNode;
    description?: string;
    options: readonly HappierSegmentedChoiceRowOption<T>[];
    value: T;
    onChange: (next: T) => void;
    disabled?: boolean;
    size?: HappierSegmentedSize;
    colors: HappierSegmentedChoiceRowColors;
    /** Per-option test ids are `${testID}:${id}`. */
    testID?: string;
  }>;

/**
 * A menu row that chooses between a few short options in place: its label (and the line under it) at
 * the leading edge, the segmented control at the trailing edge. On the transient-menu row scale, so
 * it lines up with the action rows around it. When the row is too narrow for both, the control moves
 * beneath the label rather than squeezing it.
 */
export function HappierSegmentedChoiceRow<T extends string>(
  props: HappierSegmentedChoiceRowProps<T>,
) {
  const typography = useOptionalHappierUiTypography();
  const model = resolveHappierSegmentedChoiceRow({
    options: props.options,
    value: props.value,
    ...(props.description === undefined
      ? {}
      : { description: props.description }),
  });
  return (
    <View
      testID={props.testID}
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: HAPPIER_MENU_ROW_METRICS.iconMarginRightPx,
        rowGap: HAPPIER_MENU_ROW_METRICS.subtitleGapPx * 2,
        minHeight: HAPPIER_MENU_ROW_METRICS.minHeightPx,
        marginHorizontal: HAPPIER_MENU_ROW_METRICS.insetPx,
        paddingHorizontal: HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx,
        paddingVertical: HAPPIER_MENU_ROW_METRICS.paddingVerticalPx / 2,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
        }}
      >
        {props.leading ? (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
              width: HAPPIER_MENU_ROW_METRICS.iconBoxSizePx,
              height: HAPPIER_MENU_ROW_METRICS.iconBoxSizePx,
              marginRight: HAPPIER_MENU_ROW_METRICS.iconMarginRightPx,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {props.leading}
          </View>
        ) : null}
        <View
          style={{
            flexShrink: 1,
            minWidth: 0,
            gap: HAPPIER_MENU_ROW_METRICS.subtitleGapPx,
          }}
        >
          <HappierText
            numberOfLines={1}
            testID={props.testID ? `${props.testID}.label` : undefined}
            style={[
              resolveHappierPageTextStyle('pageDescription', typography),
              { color: props.colors.rowLabel },
            ]}
          >
            {props.label}
          </HappierText>
          {model.detail ? (
            <HappierText
              testID={props.testID ? `${props.testID}.detail` : undefined}
              style={[
                resolveHappierPageTextStyle('meta', typography),
                { color: props.colors.rowDetail },
              ]}
            >
              {model.detail}
            </HappierText>
          ) : null}
        </View>
      </View>
      <HappierSegmentedChoice
        accessibilityLabel={props.label}
        segments={model.segments.map((segment) => ({
          key: segment.id,
          label: segment.label,
          selected: segment.selected,
          disabled: segment.disabled,
          accessibilityLabel: segment.accessibilityLabel,
          ...(props.testID ? { testID: `${props.testID}:${segment.id}` } : {}),
          ...(segment.leading ? { leading: segment.leading } : {}),
        }))}
        onSelect={(index) => {
          const next = model.segments[index];
          if (next && !next.disabled && next.id !== props.value)
            props.onChange(next.id);
        }}
        {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
        {...(props.size === undefined ? {} : { size: props.size })}
        colors={props.colors}
        {...(props.testID ? { testID: `${props.testID}.choice` } : {})}
      />
    </View>
  );
}
