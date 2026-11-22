import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  CapacityBar,
  formatHappierDataBytes,
  happierPageTextMetrics,
} from '@happier-dev/plugin-ui/presentation';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { readStorageBarInk } from '@/components/storage/storageKindMarks';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

const CELL_BAR_WIDTH = 96;

/**
 * The one size bar of Storage rows (lab `rs` `.rss-row > .br`, storage-view lab `sv-mb`): a thing's size against the
 * largest beside it, in the storage ink's mid step (`color` for a kind's own mark), hatched once it is set aside. A wide row draws it
 * a step thicker than a phone row, so the hatch reads at a glance. Machines › Storage and the Account's Storage view
 * share it.
 */
export function StorageSizeBar(
  props: Readonly<{
    label: string;
    bytes: number;
    largest: number;
    hatched: boolean;
    compact: boolean;
    color?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const pluginTheme = usePluginUiTheme(theme);
  // Drawn for the eye: the row already says its size in the words it shows, so the bar adds no raw byte counts.
  return (
    <View
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <CapacityBar
        theme={pluginTheme}
        label={props.label}
        value={props.bytes}
        capacity={Math.max(1, props.largest)}
        size="inline"
        height={props.compact ? undefined : theme.space.s6}
        showCaption={false}
        color={props.color ?? readStorageBarInk(theme)}
        trackColor={theme.colors.border.default}
        pattern={props.hatched ? 'hatched' : 'solid'}
      />
    </View>
  );
}

/**
 * A listed item's meter on its own, at the table cell's width (a phone row draws it under line 2, lab scene 1 390), so
 * every row's track is the same length and the fills compare against the largest item.
 */
export function StorageSizeMeter(
  props: Readonly<{ label: string; bytes: number; largest: number; hatched: boolean; color?: string }>,
) {
  return (
    <View style={styles.bar}>
      <StorageSizeBar label={props.label} bytes={props.bytes} largest={props.largest} compact hatched={props.hatched}
        color={props.color} />
    </View>
  );
}

/**
 * A listed item's stored size (storage-view lab `sv-t .s`, Artifacts table Size): the bar against the largest listed
 * item, then the size in one right-aligned tabular column; a size the Home has not measured is a dash and draws no bar.
 * The Storage view's items table and the Artifacts page's table and rows share it. Every number is the server's.
 */
export function StorageSizeCell(
  props: Readonly<{
    label: string;
    /** `undefined` while the Home has not measured it. */
    bytes: number | undefined;
    largest: number;
    /** A table cell draws the bar; a phone row's trailing value is the size alone. */
    bar: boolean;
    color?: string;
    /** Hatch the bar: what can be cleared (an Artifact's old versions). */
    hatched?: boolean;
    testID?: string;
    unknownLabel: string;
  }>,
) {
  const size =
    props.bytes === undefined
      ? '—'
      : formatHappierDataBytes(props.bytes, { kind: 'storage' });
  return (
    <View style={styles.cell}>
      {props.bar && props.bytes !== undefined ? (
        <View style={styles.bar}>
          <StorageSizeBar
            label={props.label}
            bytes={props.bytes}
            largest={props.largest}
            compact={false}
            hatched={props.hatched === true}
            color={props.color}
          />
        </View>
      ) : null}
      <Text
        // A table's size column keeps one width so the bars before it align; a row's trailing size keeps only its own.
        style={[styles.size, props.bar ? styles.sizeColumn : null]}
        numberOfLines={1}
        testID={props.testID}
        {...(props.bytes === undefined
          ? { accessibilityLabel: props.unknownLabel }
          : {})}
      >
        {size}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  cell: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.space.s12,
  },
  bar: {
    width: CELL_BAR_WIDTH,
    flexShrink: 0,
  },
  size: {
    ...Typography.default('medium'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  // One size column: the bars before it start at the same x on every row.
  sizeColumn: {
    minWidth: 72,
  },
}));
