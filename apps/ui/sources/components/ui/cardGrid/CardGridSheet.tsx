import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_PAGE_METRICS,
  HappierPressable,
} from '@happier-dev/plugin-ui/presentation';
import { readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';

import { Text } from '@/components/ui/text/Text';

import { CARD_GRID_SHEET, resolveCardGridSheetColumns } from './cardGridMetrics';

export type CardGridSheetCell = Readonly<{
  key: string;
  testID: string;
  title: string;
  /** The mark drawn at the grid's mark size, standing on its own (no tile behind it). */
  mark: React.ReactNode;
  /** One short state under the name; `attention` is the amber "needs you" word. */
  state?: Readonly<{ label: string; tone?: 'attention' }> | null;
  dimmed?: boolean;
  onPress: () => void;
}>;

/**
 * The cells of one section's sheet in a standalone collection page (R6): hairline cells, each a mark, a name and
 * its state, as many to a row as `resolveCardGridSheetColumns` fits in the measured sheet. It lives
 * inside an `ItemGroup`, which draws the section title and the sheet.
 */
export const CardGridSheet = React.memo(
  function CardGridSheet(
    props: Readonly<{
      testID?: string;
      cells: readonly CardGridSheetCell[];
    }>,
  ) {
    const { theme } = useUnistyles();
    const [columns, setColumns] = React.useState<number | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
      const width = readHappierVisibleLayoutWidth(
        event.nativeEvent.layout.width,
      );
      if (width !== null)
        setColumns(resolveCardGridSheetColumns(width));
    }, []);
    // Until measured the grid holds the phone's three, so a phone's first paint is its final layout.
    const perRow = columns ?? 3;
    return (
      <View testID={props.testID} style={styles.grid} onLayout={onLayout}>
        {props.cells.map((cell, index) => {
          const lastInRow = (index + 1) % perRow === 0;
          const firstRow = index < perRow;
          return (
            <HappierPressable
              key={cell.key}
              testID={cell.testID}
              accessibilityRole="button"
              accessibilityLabel={
                cell.state ? `${cell.title}. ${cell.state.label}` : cell.title
              }
              onPress={cell.onPress}
              style={[
                styles.cell,
                { width: `${100 / perRow}%` },
                lastInRow
                  ? null
                  : {
                      borderRightWidth: StyleSheet.hairlineWidth,
                      borderRightColor: theme.colors.border.subtle,
                    },
                firstRow
                  ? null
                  : {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: theme.colors.border.subtle,
                    },
              ]}
            >
              <View style={[styles.mark, cell.dimmed ? styles.dimmed : null]}>
                {cell.mark}
              </View>
              <Text
                variant="label"
                numberOfLines={1}
                style={[styles.title, cell.dimmed ? styles.dimmedText : null]}
              >
                {cell.title}
              </Text>
              {cell.state ? (
                <Text
                  variant="meta"
                  numberOfLines={1}
                  style={
                    cell.state.tone === 'attention'
                      ? styles.stateAttention
                      : styles.state
                  }
                >
                  {cell.state.label}
                </Text>
              ) : null}
            </HappierPressable>
          );
        })}
      </View>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  cell: {
    alignItems: 'center',
    paddingVertical: HAPPIER_PAGE_METRICS.cardPaddingPx,
    paddingHorizontal: theme.space.s8,
    gap: theme.space.s2,
  },
  mark: {
    width: CARD_GRID_SHEET.markPx,
    height: CARD_GRID_SHEET.markPx,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.space.s6,
  },
  dimmed: {
    opacity: 0.55,
  },
  title: {
    color: theme.colors.text.primary,
    textAlign: 'center',
  },
  dimmedText: {
    color: theme.colors.text.secondary,
  },
  state: {
    color: theme.colors.text.secondary,
    textAlign: 'center',
  },
  stateAttention: {
    color: theme.colors.state.warning.textForeground,
    textAlign: 'center',
  },
}));
