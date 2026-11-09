import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_DATA_METRICS, HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useDeviceType } from '@/utils/platform/responsive';

/** A tile reads at about a phone's width; below two of them side by side the sheet stacks them. */
const TWO_COLUMN_MIN_WIDTH_PX = 560;

/**
 * The four vitals in one sheet with ink dividers (lab `rv` O): two by two where there is room, one tile
 * per row on a phone or in a narrow pane. Tiles in a row share the row's height, so their charts start
 * on one line; nothing about the sheet's shape depends on its values.
 */
export const VitalsSheet = React.memo(function VitalsSheet(
  props: Readonly<{
    children: readonly React.ReactNode[];
    testID?: string;
    /** Tiles side by side where there is room (the Processes tab's three vitals sit in one row, lab `rp` H). */
    columns?: 2 | 3;
  }>,
) {
  const phone = useDeviceType() === 'phone';
  const [narrow, setNarrow] = React.useState(false);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const width = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
    if (width !== null) setNarrow(width < TWO_COLUMN_MIN_WIDTH_PX);
  }, []);
  const columns = phone || narrow ? 1 : (props.columns ?? 2);
  const stacked = columns === 1;
  const tiles = React.Children.toArray(props.children);
  const rows: React.ReactNode[][] = [];
  for (let index = 0; index < tiles.length; index += columns)
    rows.push(tiles.slice(index, index + columns));
  return (
    <ItemGroup header="none">
      <VitalsSheetStackedContext.Provider value={stacked}>
      <View testID={props.testID} onLayout={phone ? undefined : onLayout}>
        {rows.map((row, rowIndex) => (
          <View
            key={rowIndex}
            style={[styles.row, rowIndex > 0 ? styles.rowDivider : null]}
          >
            {row.map((tile, columnIndex) => (
              <View
                key={columnIndex}
                style={[
                  styles.cell,
                  columnIndex > 0 ? styles.cellDivider : null,
                ]}
              >
                {tile}
              </View>
            ))}
          </View>
        ))}
      </View>
      </VitalsSheetStackedContext.Provider>
    </ItemGroup>
  );
});

/**
 * Whether the sheet stacks its tiles one per row (a phone or a narrow pane). A stacked tile with no
 * instruments reads as a row, its figure at the right (lab `rg` G7p, `rv` Op "More from"), so a summary of
 * a few figures does not take a screen.
 */
const VitalsSheetStackedContext = React.createContext(false);
/** A figure drawn as a row's value rather than a tile's headline. */
const VitalsValueInRowContext = React.createContext(false);

/**
 * The room a tile's host gives it. The Overview's sheet gives a tile everything (the default); a Metric widget
 * gives each of its sizes what fits there (lab `rw` M, MM: Wide puts the figure beside the chart, Wide and Medium
 * keep the chart alone, only the sizes with height keep the minute maximum, per-core, composition and swap).
 * The host decides the room once; every tile reads it here, so no tile grows a widget-only variant.
 */
export type VitalsTileRoom = Readonly<{
  /**
   * `side`: the label, figure and sub line stand left of the instruments (a short, wide host). `line`: one meter row,
   * the label at the left and the figure at the right on one line, the instruments beneath (a phone's Processes
   * tiles, lab `rp` Hp); the tile's quiet top-right fact is left to the page.
   */
  layout: 'stack' | 'side' | 'line';
  /**
   * `primary`: only the tile's first instrument (its chart or volume rows); `secondary` adds the next ones
   * (per-core, composition); `all` also draws the last details (swap). See {@link VitalsTileSecondary}.
   */
  instruments: 'all' | 'secondary' | 'primary';
  /** Whether a history chart also draws its minute maximum (and the key that names the two lines). */
  chartMaximum: boolean;
  /** Whether the tile pads itself; a widget body already holds its content to the frame's inset. */
  inset: boolean;
  /**
   * How the history chart takes its room. `plot`: the tile's plot with its scale and axis. `spark`: the bare line
   * beneath the figure, with no scale or axis (a Small widget, lab `rw` M).
   */
  chart: 'plot' | 'spark';
  /**
   * Whether the chart takes what the host's room leaves after the tile's own lines (a widget measures its room and
   * gives the tile that height), instead of the plot's default height. Without a measured room it keeps the default.
   */
  fill: boolean;
  /**
   * Whether the tile names itself. A host that already names the tile's vital (a Metric widget's frame title, "CPU")
   * says `false`: the label is not drawn, only the quiet facts that stand beside it, and the figure takes the tile's
   * open target.
   */
  title: boolean;
}>;
const FULL_TILE_ROOM: VitalsTileRoom = Object.freeze({ layout: 'stack', instruments: 'all', chartMaximum: true, inset: true, chart: 'plot', fill: false, title: true });
export const VitalsTileRoomContext = React.createContext<VitalsTileRoom>(FULL_TILE_ROOM);
export function useVitalsTileRoom(): VitalsTileRoom {
  return React.useContext(VitalsTileRoomContext);
}

/**
 * A tile's instrument after its first: `secondary` (per-core, composition) is drawn unless the host gives only
 * the primary room; `tertiary` (swap) only where the host gives the tile all of its room.
 */
export function VitalsTileSecondary(props: Readonly<{ children: React.ReactNode; tier?: 'secondary' | 'tertiary' }>) {
  const instruments = useVitalsTileRoom().instruments;
  const shown = instruments === 'all' || (instruments === 'secondary' && props.tier !== 'tertiary');
  return shown ? <>{props.children}</> : null;
}

/**
 * A tile shown somewhere else (a Metric widget) opens its machine page from its title. The tile's own
 * chart and disclosures stay separate controls, never nested inside one big button.
 */
export const VitalsTileOpenContext = React.createContext<Readonly<{ onOpen: () => void; accessibilityLabel: string }> | null>(null);

/**
 * One vital's anatomy (lab kit `vital`): the label with its quiet fact at the right, the value with its
 * unit and a short phrase, one line under it, then the tile's instruments. Every tile keeps this rhythm,
 * so their values and charts line up across the sheet.
 */
export const VitalsTile = React.memo(function VitalsTile(
  props: Readonly<{
    label: string;
    labelAccessory?: React.ReactNode;
    meta?: React.ReactNode;
    value: React.ReactNode;
    sub?: React.ReactNode;
    children?: React.ReactNode;
    testID?: string;
  }>,
) {
  const open = React.useContext(VitalsTileOpenContext);
  const stacked = React.useContext(VitalsSheetStackedContext);
  const room = useVitalsTileRoom();
  const side = room.layout === 'side' && props.children != null;
  const figure = (
    <>
      <View style={styles.valueRow}>{props.value}</View>
      {props.sub ? <View style={styles.sub}>{props.sub}</View> : null}
    </>
  );
  if (room.layout === 'line') {
    return (
      <View testID={props.testID} style={[styles.tile, styles.lineTile]}>
        <View style={styles.rowTile}>
          <View style={[styles.rowText, styles.labelRow]}>
            <Text accessibilityRole="header" numberOfLines={1} style={styles.rowLabel}>
              {props.label}
            </Text>
            {props.labelAccessory}
          </View>
          <View style={styles.rowValue}>
            <VitalsValueInRowContext.Provider value>{props.value}</VitalsValueInRowContext.Provider>
          </View>
        </View>
        {props.children ? <View style={styles.lineBody}>{props.children}</View> : null}
      </View>
    );
  }
  if (stacked && !props.children && !open && (props.meta === undefined || props.meta === null)) {
    return (
      <View testID={props.testID} style={[styles.tile, styles.rowTile]}>
        <View style={styles.rowText}>
          <View style={styles.labelRow}>
            <Text accessibilityRole="header" numberOfLines={1} style={styles.rowLabel}>
              {props.label}
            </Text>
            {props.labelAccessory}
          </View>
          {props.sub ? <View style={styles.sub}>{props.sub}</View> : null}
        </View>
        <View style={styles.rowValue}>
          <VitalsValueInRowContext.Provider value>{props.value}</VitalsValueInRowContext.Provider>
        </View>
      </View>
    );
  }
  return (
    <View testID={props.testID} style={[styles.tile, room.inset ? null : styles.tileFlush, side ? styles.tileSide : null, room.fill ? styles.tileFill : null]}>
      <View style={side ? styles.sideLead : null}>
      {room.title || props.labelAccessory || (props.meta !== undefined && props.meta !== null) ? (
      <View style={[styles.labelRow, room.title ? null : styles.labelRowUntitled]}>
        {!room.title ? null : open ? (
          <HappierPressable
            testID={props.testID ? `${props.testID}.open` : undefined}
            accessibilityRole="button"
            accessibilityLabel={open.accessibilityLabel}
            onPress={open.onOpen}
          >
            {(state) => (
              <Text numberOfLines={1} style={[styles.label, state.hovered ? styles.labelHovered : null]}>
                {props.label}
              </Text>
            )}
          </HappierPressable>
        ) : (
          <Text accessibilityRole="header" numberOfLines={1} style={styles.label}>
            {props.label}
          </Text>
        )}
        {props.labelAccessory}
        {props.meta !== undefined && props.meta !== null ? (
          <View style={styles.meta}>{props.meta}</View>
        ) : null}
      </View>
      ) : null}
      {room.title || !open ? figure : (
        <HappierPressable
          testID={props.testID ? `${props.testID}.open` : undefined}
          accessibilityRole="button"
          accessibilityLabel={open.accessibilityLabel}
          onPress={open.onOpen}
        >
          {figure}
        </HappierPressable>
      )}
      </View>
      {props.children ? (
        <View style={[side ? styles.sideBody : styles.body, room.fill ? styles.bodyFill : null]}>{props.children}</View>
      ) : null}
    </View>
  );
});

/** The tile's value: the number, its unit and the phrase after it ("71 GB free", "12 %"). */
export function VitalsValue(
  props: Readonly<{
    value: string;
    unit?: string;
    phrase?: string;
    color?: string;
    leading?: React.ReactNode;
  }>,
) {
  const inRow = React.useContext(VitalsValueInRowContext);
  return (
    <>
      {props.leading}
      <Text
        numberOfLines={1}
        style={[inRow ? styles.rowValueText : styles.value, props.color ? { color: props.color } : null]}
      >
        {props.value}
      </Text>
      {props.unit ? (
        <Text numberOfLines={1} style={styles.unit}>
          {props.unit}
        </Text>
      ) : null}
      {props.phrase ? (
        <Text numberOfLines={1} style={[styles.phrase, inRow ? styles.phraseInRow : null]}>
          {props.phrase}
        </Text>
      ) : null}
    </>
  );
}

/** The one line under a value; `strong` runs read in ink ("**180 MB** free · 3.8 GB in use"). */
export function VitalsSubLine(
  props: Readonly<{ children: React.ReactNode; testID?: string }>,
) {
  return (
    <Text testID={props.testID} numberOfLines={1} style={styles.subText}>
      {props.children}
    </Text>
  );
}

export function VitalsStrong(
  props: Readonly<{ children: React.ReactNode; color?: string }>,
) {
  return (
    <Text style={[styles.strong, props.color ? { color: props.color } : null]}>
      {props.children}
    </Text>
  );
}

/** A quiet fact at a tile's top right ("load 2.31", "128 GB", "2 volumes"). */
export function VitalsMeta(
  props: Readonly<{ children: React.ReactNode; leading?: React.ReactNode }>,
) {
  return (
    <View style={styles.metaRow}>
      {props.leading}
      <Text numberOfLines={1} style={styles.metaText}>
        {props.children}
      </Text>
    </View>
  );
}

export const vitalsSheetStyles = StyleSheet.create((theme) => ({
  caption: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.tertiary,
  },
}));

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  cell: {
    flex: 1,
    minWidth: 0,
  },
  cellDivider: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.border.subtle,
  },
  tile: {
    paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    paddingTop: PAGE_LIST_METRICS.rowPaddingVerticalPx + 4,
    paddingBottom: PAGE_LIST_METRICS.rowPaddingVerticalPx + 4,
    minWidth: 0,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minHeight: 18,
  },
  // A tile its host names carries only its quiet facts, at the end.
  labelRowUntitled: {
    justifyContent: 'flex-end',
  },
  label: {
    ...Typography.variant('meta'),
    ...Typography.default('medium'),
    color: theme.colors.text.secondary,
    flexShrink: 0,
  },
  // Hover changes colour only: the title it opens from reads as ink.
  labelHovered: {
    color: theme.colors.text.primary,
  },
  meta: {
    marginLeft: 'auto',
    minWidth: 0,
    flexShrink: 1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    minWidth: 0,
  },
  metaText: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.tertiary,
    flexShrink: 1,
  },
  valueRow: {
    marginTop: theme.space.s6,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.s4,
    minHeight: HAPPIER_DATA_METRICS.statValue.lineHeight,
    minWidth: 0,
  },
  value: {
    ...Typography.default('semiBold'),
    ...Typography.tabular(),
    fontSize: HAPPIER_DATA_METRICS.statValue.fontSize,
    lineHeight: HAPPIER_DATA_METRICS.statValue.lineHeight,
    letterSpacing: HAPPIER_DATA_METRICS.statValue.letterSpacing,
    color: theme.colors.text.primary,
  },
  unit: {
    ...Typography.variant('meta'),
    ...Typography.default('medium'),
    color: theme.colors.text.secondary,
  },
  phrase: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    marginLeft: theme.space.s6,
    flexShrink: 1,
  },
  // A row's figure reads as one run ("84.4 GB free"); the headline's extra air before its phrase is a tile's.
  phraseInRow: {
    marginLeft: 0,
  },
  sub: {
    marginTop: theme.space.s2,
    minWidth: 0,
  },
  subText: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.secondary,
  },
  strong: {
    ...Typography.default('medium'),
    color: theme.colors.text.primary,
  },
  tileFlush: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
  },
  // Side by side (a Wide widget): the figure keeps its column, the chart takes the rest.
  tileSide: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s20,
  },
  sideLead: {
    flexBasis: '38%',
    flexShrink: 0,
    minWidth: 0,
  },
  sideBody: {
    flex: 1,
    minWidth: 0,
    gap: HAPPIER_DATA_METRICS.rowGapPx,
  },
  // A filling tile stretches to the room its host measured; its body hands the rest to the chart.
  tileFill: {
    flexGrow: 1,
    alignItems: 'stretch',
  },
  bodyFill: {
    flexGrow: 1,
  },
  rowTile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  rowLabel: {
    ...Typography.variant('label'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  rowValue: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.s4,
    flexShrink: 0,
  },
  rowValueText: {
    ...Typography.variant('label'),
    ...Typography.tabular(),
    color: theme.colors.text.primary,
  },
  lineTile: {
    paddingTop: PAGE_LIST_METRICS.rowPaddingVerticalPx,
    paddingBottom: PAGE_LIST_METRICS.rowPaddingVerticalPx,
  },
  lineBody: {
    marginTop: theme.space.s8,
    gap: HAPPIER_DATA_METRICS.rowGapPx,
    minWidth: 0,
  },
  body: {
    marginTop: HAPPIER_DATA_METRICS.blockGapPx,
    gap: HAPPIER_DATA_METRICS.rowGapPx,
    minWidth: 0,
  },
}));

/**
 * A whole translated sentence with one figure in it read in ink ("**180 MB** free · 3.8 GB in use"): the
 * figure is found in the sentence the locale built, so word order stays the locale's.
 */
export function VitalsEmphasis(props: Readonly<{ text: string; emphasis: string }>) {
  const at = props.text.indexOf(props.emphasis);
  if (!props.emphasis || at < 0) return <>{props.text}</>;
  return (
    <>
      {props.text.slice(0, at)}
      <VitalsStrong>{props.emphasis}</VitalsStrong>
      {props.text.slice(at + props.emphasis.length)}
    </>
  );
}

