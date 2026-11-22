import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  CompositionStrip,
  happierPageTextMetrics,
  type CompositionSegment,
} from '@happier-dev/plugin-ui/presentation';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

const BAR_HEIGHT = 10;
/** A part the legend names stays visible on the bar: a few MB on a 2 TB disk is still a sliver of its colour. */
const MIN_PART_WIDTH = 4;
/** The legend reads at the row-description size, like the lab's key under each bar. */
const LEGEND_TEXT = happierPageTextMetrics('meta');

/**
 * One capacity row (lab `rs` H / HR volume row, storage-view lab `sv-vol`): a name and its figure on one line, one
 * `CompositionStrip` bar of the parts against the whole, and the compact legend with each part's amount beneath.
 * A Machine's disk and the Account's storage (and its Artifact limit) are each one of these. Every amount is the
 * owner's own number; the row never sums or estimates. `children` are the row's own lines under the legend.
 */
export const StorageCapacityRow = React.memo(function StorageCapacityRow(
  props: Readonly<{
    testID?: string;
    title: string;
    /** A quiet hint after the name (a disk's mount path); dropped on a phone by the caller. */
    hint?: string | null;
    /** "412 GB free of 994", "1.84 GB stored": the strong part, then the rest of the phrase. */
    figure: Readonly<{ strong: string; rest: string; tone?: 'warning' }>;
    /** The bar's accessible description. */
    label: string;
    /** The whole the bar stands for; parts are drawn as their share of it. */
    total: number;
    barSegments: readonly CompositionSegment[];
    legendSegments: readonly CompositionSegment[];
    formatValue: (value: number) => string;
    /** What a legend entry without a measured amount says beside its name. */
    unknownLabel?: string;
    showDivider?: boolean;
    children?: React.ReactNode;
  }>,
) {
  const { theme } = useUnistyles();
  const pluginTheme = usePluginUiTheme(theme);
  const warning = props.figure.tone === 'warning';
  return (
    <SectionContentRow testID={props.testID} showDivider={props.showDivider}>
      <View style={styles.head}>
        <View style={styles.name}>
          <Text style={styles.nameText} numberOfLines={1}>
            {props.title}
          </Text>
          {props.hint ? (
            <Text style={styles.hint} numberOfLines={1}>
              {props.hint}
            </Text>
          ) : null}
        </View>
        <Text
          style={[styles.figure, warning ? styles.figureWarning : null]}
          numberOfLines={1}
          testID={props.testID ? `${props.testID}-figure` : undefined}
        >
          <Text
            style={[styles.figureStrong, warning ? styles.figureWarning : null]}
          >
            {props.figure.strong}
          </Text>
          {props.figure.rest ? ` ${props.figure.rest}` : ''}
        </Text>
      </View>
      <View
        style={styles.bar}
        accessible
        accessibilityRole="image"
        accessibilityLabel={props.label}
      >
        <CompositionStrip
          theme={pluginTheme}
          label={props.label}
          total={props.total}
          segments={props.barSegments}
          variant="bar"
          segmentGap={0}
          minimumFillWidth={MIN_PART_WIDTH}
          appearance={{ legend: 'compact', height: BAR_HEIGHT }}
        />
      </View>
      <View style={styles.legend}>
        <CompositionStrip
          theme={pluginTheme}
          label={props.label}
          total={props.total}
          segments={props.legendSegments}
          variant="legend"
          unknownLabel={props.unknownLabel ?? ''}
          appearance={{
            legend: 'compact',
            figure: 'value',
            textStyle: LEGEND_TEXT,
          }}
          valueFormatter={props.formatValue}
        />
      </View>
      {props.children}
    </SectionContentRow>
  );
});

/** A quiet line under a capacity row's legend ("No storage limit is set on this server."). */
export function StorageCapacityNote(
  props: Readonly<{ text: string; testID?: string }>,
) {
  return (
    <Text testID={props.testID} style={styles.note}>
      {props.text}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  head: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: theme.space.s12,
  },
  name: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.s10,
    flexShrink: 1,
    minWidth: 0,
  },
  nameText: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
    flexShrink: 0,
  },
  hint: {
    ...Typography.mono(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
    flexShrink: 1,
  },
  figure: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
    flexShrink: 0,
  },
  figureStrong: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  figureWarning: {
    color: theme.colors.state.warning.textForeground,
  },
  bar: {
    marginTop: theme.space.s10,
  },
  legend: {
    marginTop: theme.space.s8,
  },
  note: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    marginTop: theme.space.s6,
  },
}));
