import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';

import { useOptionalHappierUiPalette, useOptionalHappierUiTheme, useOptionalHappierUiTypography } from '../../environment/context.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { resolveHappierPageTextStyle } from '../layout/pageText.js';
import { HappierText } from '../text/Text.js';

/** The one filter chip's geometry, shared with core's `SelectionListFilterChip`: a search field's height, a pill. */
export const HAPPIER_FILTER_CHIP_METRICS = Object.freeze({ minHeightPx: 32, radiusPx: 16, paddingHorizontalPx: 10, gapPx: 8 });

/** One common filter value, one press from on or off. It says only a value the list can really filter by. */
export type HappierCollectionFilterChip = Readonly<{
  id: string;
  label: string;
  selected: boolean;
  onToggle: () => void;
  testID?: string;
}>;

/**
 * The inline half of the one filter pattern (DESIGN.md "One filter pattern"): what people filter by most, one press
 * away. `trailing` ends the row with the long tail (the condition editor's trigger). A narrow toolbar keeps one line
 * that scrolls sideways under the finger.
 */
export function HappierCollectionFilterChips(props: Readonly<{
  chips: readonly HappierCollectionFilterChip[];
  trailing?: ReactNode;
  scrolls?: boolean;
  testID?: string;
}>) {
  const theme = useOptionalHappierUiTheme();
  const palette = useOptionalHappierUiPalette(theme);
  const typography = useOptionalHappierUiTypography();
  const metrics = HAPPIER_FILTER_CHIP_METRICS;
  const textStyle = resolveHappierPageTextStyle('meta', typography);
  const chips = props.chips.map((chip) => (
    <HappierPressable
      key={chip.id}
      {...(chip.testID === undefined ? {} : { testID: chip.testID })}
      accessibilityRole="checkbox"
      accessibilityLabel={chip.label}
      checked={chip.selected}
      onPress={chip.onToggle}
      style={(state) => [
        {
          minHeight: metrics.minHeightPx,
          justifyContent: 'center',
          paddingHorizontal: metrics.paddingHorizontalPx,
          borderRadius: metrics.radiusPx,
          borderWidth: 1,
          borderColor: chip.selected ? 'transparent' : palette?.controlBorder ?? 'transparent',
          ...(chip.selected ? { backgroundColor: palette?.pageTabSelected ?? theme?.colors.control }
            : state.hovered || state.pressed ? { backgroundColor: palette?.navigationHover } : null),
        },
        happierFocusRingStyle({ visible: state.focused && theme !== null, color: theme?.colors.focus ?? '' }),
      ]}
    >
      <HappierText numberOfLines={1} style={[textStyle, { color: chip.selected ? theme?.colors.text : theme?.colors.secondaryText }]}>
        {chip.label}
      </HappierText>
    </HappierPressable>
  ));
  const row = { flexDirection: 'row', alignItems: 'center', gap: metrics.gapPx } as const;
  return props.scrolls ? (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} {...(props.testID === undefined ? {} : { testID: props.testID })}
      contentContainerStyle={row}>{chips}{props.trailing}</ScrollView>
  ) : (
    <View {...(props.testID === undefined ? {} : { testID: props.testID })} style={[row, { flexWrap: 'wrap', minWidth: 0 }]}>
      {chips}
      {/* Chips can arrive with the data; the long tail holds the row's end, so it never moves. */}
      {props.trailing ? <View style={{ marginLeft: 'auto' }}>{props.trailing}</View> : null}
    </View>
  );
}
