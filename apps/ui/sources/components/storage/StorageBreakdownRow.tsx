import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { useMotionPreferences } from '@/components/instrument/motion/useMotionPreferences';

import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { StorageSizeBar } from './StorageSizeBar';

const BAR_WIDTH = 104;
const NARROW_BAR_WIDTH = 56;

/**
 * One kind of what is stored (SUB's row anatomy at the breakdown's scale, lab `rs` H / HR, storage-view lab `sv-k`):
 * glyph, name, evidence; a bar against the largest kind; its size; and what can go or a quiet fact. On a phone the
 * size rides the title line and the bar and the trailing fact sit beneath (lab `rs` Hp). Machines › Storage's kinds
 * and the Account's kinds are each one of these; the caller owns what the trailing column says and what a press opens.
 */
export const StorageBreakdownRow = React.memo(function StorageBreakdownRow(
  props: Readonly<{
    testID: string;
    icon: React.ReactNode;
    title: string;
    facts: string;
    /** `null` when the owner has not measured it: no bar, and the size column says so. */
    bytes: number | null;
    largest: number;
    /** `null` while the owner's read is out: the size shimmers in its column, nothing else moves. */
    size: string | null;
    hatched?: boolean;
    /** Only for what a limit counts (the usage accent); every other kind stays ink. */
    barColor?: string;
    trailing: React.ReactNode;
    /** The trailing control presses on its own (Trash's "Empty now"), outside the row's press. */
    trailingPressable?: boolean;
    compact: boolean;
    /** The row is too narrow for the full figures (beside a ring, or a narrow sheet). */
    narrowFigures?: boolean;
    selected?: boolean;
    showDivider: boolean;
    onPress?: () => void;
  }>,
) {
  const bar =
    props.bytes === null ? (
      <View style={styles.barTrackless} />
    ) : (
      <StorageSizeBar
        label={props.title}
        bytes={props.bytes}
        largest={props.largest}
        compact={props.compact}
        hatched={props.hatched === true}
        color={props.barColor}
      />
    );
  if (props.compact) {
    return (
      <Item
        testID={props.testID}
        icon={props.icon}
        title={props.title}
        subtitle={props.facts}
        subtitleLines={1}
        showChevron={props.onPress !== undefined}
        keepChevronWithRightElement
        onPress={props.onPress}
        showDivider={props.showDivider}
        selected={props.selected}
        rightElement={props.size === null ? <StorageSizePending /> : <Text style={styles.size}>{props.size}</Text>}
        bottomElementInset="text"
        bottomElementOutsidePressable={props.trailingPressable}
        bottomElement={
          <View style={styles.compactBottom}>
            {bar}
            {props.trailing}
          </View>
        }
      />
    );
  }
  return (
    <Item
      testID={props.testID}
      icon={props.icon}
      title={props.title}
      subtitle={props.facts}
      subtitleLines={1}
      showChevron={props.onPress !== undefined}
      keepChevronWithRightElement
      onPress={props.onPress}
      showDivider={props.showDivider}
      selected={props.selected}
      rightElementOutsidePressable={props.trailingPressable}
      rightElement={
        <View
          style={[
            styles.figures,
            props.narrowFigures ? styles.figuresNarrow : null,
          ]}
        >
          <View style={props.narrowFigures ? styles.barNarrow : styles.bar}>
            {bar}
          </View>
          {props.size === null ? (
            <View style={[styles.sizeColumn, styles.sizePendingColumn, props.narrowFigures ? styles.sizeNarrow : null]}>
              <StorageSizePending />
            </View>
          ) : (
            <Text
              style={[
                styles.size,
                styles.sizeColumn,
                props.narrowFigures ? styles.sizeNarrow : null,
              ]}
              numberOfLines={1}
            >
              {props.size}
            </Text>
          )}
          <View
            style={[
              styles.trailingColumn,
              props.narrowFigures ? styles.trailingNarrow : null,
            ]}
          >
            {props.trailing}
          </View>
        </View>
      }
    />
  );
});

/** A size still being read: one placeholder at the size's width, shimmering unless motion is reduced. */
export function StorageSizePending(props: Readonly<{ width?: number }>) {
  const { theme } = useUnistyles();
  const motion = useMotionPreferences();
  return (
    <HappierSkeletonBlock color={theme.colors.surface.skeleton} reducedMotion={motion.reduceMotion}
      width={props.width ?? theme.space.s48} height={theme.space.s12} radius={theme.space.s4} />
  );
}

/** A breakdown row's trailing words: an optional strong amount, then the quiet rest ("12 GB can go", "of 100 MB"). */
export function StorageBreakdownTrailingText(
  props: Readonly<{ strong?: string; text: string; testID?: string }>,
) {
  return (
    <Text testID={props.testID} style={styles.trailing} numberOfLines={1}>
      {props.strong ? (
        <Text style={styles.trailingStrong}>{props.strong}</Text>
      ) : null}
      {props.strong ? ` ${props.text}` : props.text}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  figures: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s16,
  },
  bar: {
    width: BAR_WIDTH,
  },
  // A kind the owner has not measured keeps the bar's column, drawn as an empty track's place.
  barTrackless: {
    height: theme.space.s6,
  },
  // Narrow figures fit Item's right slot (half the row, chevron included): bar, size and tail step down.
  figuresNarrow: {
    gap: theme.space.s12,
  },
  barNarrow: {
    width: NARROW_BAR_WIDTH,
  },
  sizeNarrow: {
    width: 68,
  },
  trailingNarrow: {
    width: 100,
  },
  size: {
    ...Typography.default('medium'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  // The figures keep their columns; the title is what gives way (lab: titles truncate, sizes never do).
  sizePendingColumn: {
    alignItems: 'flex-end',
  },
  sizeColumn: {
    width: 76,
    flexShrink: 0,
  },
  trailingColumn: {
    width: 132,
    flexShrink: 0,
    alignItems: 'flex-end',
  },
  trailing: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  trailingStrong: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  compactBottom: {
    gap: theme.space.s6,
    paddingTop: theme.space.s6,
  },
}));
