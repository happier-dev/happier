import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_WIDGET_FRAME_METRICS,
  happierPageRowDividerWidth,
  type HappierWidgetFrameSourceDescriptor,
} from '@happier-dev/plugin-ui/presentation';
import type { WidgetLayoutGroupV1 } from '@happier-dev/protocol/widgets';

import { EmptySlot } from '@/components/ui/empty/EmptySlot';
import { ItemLoadStateRowDividersContext } from '@/components/ui/lists/ItemLoadStateRows';
import { PAGE_ROW_TOUCH_MIN_HEIGHT_PX } from '@/components/ui/lists/pageRowMetrics';
import {
  WidgetFrame,
  type WidgetFramePlacement,
} from '@/components/widgets/frame/WidgetFrame';
import { t } from '@/text';

import {
  packWidgetGroupBands,
  type WidgetGroupBand,
  type WidgetGroupCell,
  type WidgetGroupCellInput,
} from './widgetGroupLayout';

/** A grouped child draws plain; its text keeps the card's inset from the group's edge and dividers. */
const CELL_INSET_PX =
  HAPPIER_WIDGET_FRAME_METRICS.cardInsetPx -
  HAPPIER_WIDGET_FRAME_METRICS.plainInsetPx;

/** Where a child is drawn: across the whole group (room for its full follow phrase) or in a column. */
export type WidgetGroupChildPlacement = Readonly<{ wide: boolean }>;

export type WidgetGroupFrameProps = Readonly<{
  testID: string;
  group: Pick<WidgetLayoutGroupV1, 'id' | 'frameStyle' | 'dividers'>;
  placement: WidgetFramePlacement;
  /** The children's footprints, in reading order (A3 sizes; never changed by the group). */
  cells: readonly WidgetGroupCellInput[];
  columns: 1 | 2;
  /** Customize: a lone child keeps its saved half beside an empty slot. */
  customizing: boolean;
  /**
   * The header: the title at section weight with no mark, the group's input value in the source
   * slot, and the ⋯. An untitled group has no header row; its options live in Customize.
   */
  title: string | React.ReactElement | null;
  source?: string | React.ReactElement | HappierWidgetFrameSourceDescriptor | undefined;
  menu?: React.ReactNode;
  /** While organizing: the group's bar (name, width, ⋯) above its widgets; an untitled group's options. */
  bar?: React.ReactNode;
  accessibilityLabel: string;
  renderChild: (instanceId: string, placement: WidgetGroupChildPlacement) => React.ReactNode;
  /** The empty slot's "add one": opens the surface's Add, placing into this group. */
  onAddToGroup?: (() => void) | undefined;
  /** Where the Add surface opened from the empty slot anchors. */
  addAnchorRef?: React.RefObject<View | null> | undefined;
  /** Drop-target ref/feedback from the shared entity DnD owner, drawn over the whole group. */
  dropRef?: ((node: View | null) => void) | undefined;
  onDropLayout?: (() => void) | undefined;
  dropFeedback?: React.ReactNode;
  /** While the whole group is carried it stays in place, dimmed, until the release settles. */
  carriedStyle?: Readonly<{ opacity: number }> | null | undefined;
}>;

/**
 * One widget group (lab `widget-groups`): the shared widget frame as the shell — card with the flat
 * edge, or plain on the page — with its children as the body, packed in the group's columns and
 * separated by ink dividers the group draws. Children always render plain inside it. On a phone,
 * or at half width, it is one stacked surface with horizontal hairlines.
 */
export const WidgetGroupFrame = React.memo(function WidgetGroupFrame(
  props: WidgetGroupFrameProps,
) {
  const bands = React.useMemo(
    () =>
      packWidgetGroupBands(
        props.cells,
        props.columns,
        props.customizing ? 'customize' : 'view',
      ),
    [props.cells, props.columns, props.customizing],
  );
  const titled = props.title !== null;
  const body = React.useMemo(
    () => ({
      kind: 'content' as const,
      children: (
        <>
        {props.bar ?? null}
        <WidgetGroupBands
          testID={props.testID}
          bands={bands}
          card={props.group.frameStyle === 'card'}
          lines={props.group.dividers === 'hairline'}
          columns={props.columns}
          // Under a title, the first band starts below the header's own divider.
          lineAbove={titled || props.bar != null}
          renderChild={props.renderChild}
          onAddToGroup={props.onAddToGroup}
          addAnchorRef={props.addAnchorRef}
        />
        </>
      ),
    }),
    [
      bands,
      props.columns,
      props.group.dividers,
      props.group.frameStyle,
      props.onAddToGroup,
      props.addAnchorRef,
      props.renderChild,
      props.testID,
      props.bar,
      titled,
    ],
  );
  return (
    <View
      ref={props.dropRef}
      collapsable={false}
      onLayout={props.onDropLayout}
      style={[styles.cell, props.carriedStyle]}
      testID={`${props.testID}.group`}
      accessibilityLabel={props.accessibilityLabel}
    >
      <WidgetFrame
        testID={`${props.testID}.frame`}
        frameStyle={props.group.frameStyle}
        placement={props.placement}
        title={props.title}
        {...(titled && props.source ? { source: props.source } : {})}
        {...(titled && props.menu ? { menu: props.menu } : {})}
        rows={0}
        bodyStyle={styles.body}
        body={body}
        fill
      />
      {props.customizing ? (
        // While its surface is customized, a group is marked as the thing being edited (lab wgmenu E).
        <View
          pointerEvents="none"
          testID={`${props.testID}.editing`}
          style={[
            styles.editing,
            props.group.frameStyle === 'plain' ? styles.editingPlain : null,
          ]}
        />
      ) : null}
      {props.dropFeedback ?? null}
    </View>
  );
});

function WidgetGroupBands(
  props: Readonly<{
    testID: string;
    bands: readonly WidgetGroupBand[];
    card: boolean;
    lines: boolean;
    columns: 1 | 2;
    lineAbove: boolean;
    renderChild: (instanceId: string, placement: WidgetGroupChildPlacement) => React.ReactNode;
    onAddToGroup?: (() => void) | undefined;
    addAnchorRef?: React.RefObject<View | null> | undefined;
  }>,
) {
  const { theme } = useUnistyles();
  // The page row divider (ink, lighter than the card edge): groups and sheets cannot drift apart.
  const divider = props.lines ? theme.colors.border.subtle : 'transparent';
  const dividerWidth = happierPageRowDividerWidth();
  const seam = (show: boolean) =>
    show ? { borderTopWidth: dividerWidth, borderTopColor: divider } : null;
  const cell = (entry: WidgetGroupCell, index: number, side?: 0 | 1) => (
    <View
      key={entry.id}
      testID={`${props.testID}.cell.${entry.id}`}
      style={[
        styles.childCell,
        // A card group insets every child from its edges; a plain group only from the vertical divider.
        props.card
          ? styles.cardCell
          : side === 0
            ? styles.leftCell
            : side === 1
              ? styles.rightCell
              : null,
        seam(index > 0),
      ]}
    >
      {/* The group draws every divider: a child's loading rows add none of their own. */}
      <ItemLoadStateRowDividersContext.Provider value={false}>
        {props.renderChild(entry.id, { wide: side === undefined && props.columns === 2 })}
      </ItemLoadStateRowDividersContext.Provider>
    </View>
  );
  return (
    <View testID={`${props.testID}.bands`}>
      {props.bands.map((band, index) => (
        <View key={band.key} style={seam(index > 0 || props.lineAbove)}>
          {band.kind === 'row' ? (
            cell(band.cell, 0)
          ) : band.kind === 'slot' ? (
            <WidgetGroupEmptySlot
              testID={`${props.testID}.slot`}
              onAdd={props.onAddToGroup}
              anchorRef={props.addAnchorRef}
              seam={null}
              minHeight={SLOT_ROW_MIN_HEIGHT_PX}
            />
          ) : (
            <View style={styles.columns}>
              {([0, 1] as const).map((side) => (
                <View
                  key={side}
                  style={[
                    styles.column,
                    band.taller === side
                      ? // The vertical divider belongs to the taller column and spans it.
                        side === 0
                        ? {
                            borderRightWidth: dividerWidth,
                            borderRightColor: divider,
                          }
                        : {
                            borderLeftWidth: dividerWidth,
                            borderLeftColor: divider,
                          }
                      : null,
                  ]}
                >
                  {band.columns[side].map((entry, at) => cell(entry, at, side))}
                  {band.slot === side ? (
                    <WidgetGroupEmptySlot
                      testID={`${props.testID}.slot`}
                      onAdd={props.onAddToGroup}
                      anchorRef={props.addAnchorRef}
                      seam={seam(band.columns[side].length > 0)}
                    />
                  ) : null}
                </View>
              ))}
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

/**
 * Customize's empty slot beside a lone child (lab wgvar 6): the one dashed slot, filling the height of
 * the cell beside it.
 */
function WidgetGroupEmptySlot(
  props: Readonly<{
    testID: string;
    onAdd?: (() => void) | undefined;
    anchorRef?: React.RefObject<View | null> | undefined;
    seam: Readonly<{ borderTopWidth: number; borderTopColor: string }> | null;
    /** A slot that is a row of its own has no neighbour to take its height from. */
    minHeight?: number;
  }>,
) {
  return (
    <View
      ref={props.anchorRef}
      collapsable={false}
      style={[styles.slotCell, props.seam]}
    >
      <EmptySlot
        testID={props.testID}
        icon="plus"
        label={t('widgetFrame.groupSlot')}
        {...(props.minHeight === undefined ? {} : { minHeight: props.minHeight })}
        {...(props.onAdd
          ? {
              action: {
                label: t('widgetFrame.groupSlotAdd'),
                onPress: props.onAdd,
                testID: `${props.testID}.add`,
              },
            }
          : {})}
      />
    </View>
  );
}

const EDITING_RING_PX = 3;
/** A slot row keeps two touch rows of room: enough to aim a carried card at. */
const SLOT_ROW_MIN_HEIGHT_PX = 2 * PAGE_ROW_TOUCH_MIN_HEIGHT_PX;

const styles = StyleSheet.create((theme) => ({
  cell: { flexGrow: 1, minWidth: 0 },
  // The children own every inset: the group's body is full-bleed so its dividers reach the edge.
  body: { paddingLeft: 0, paddingRight: 0, paddingBottom: 0 },
  // Both columns take the band's height, so a hole's slot fills the room beside the cell next to it.
  columns: { flexDirection: 'row', alignItems: 'stretch' },
  column: { flex: 1, minWidth: 0 },
  childCell: { minWidth: 0 },
  cardCell: { paddingHorizontal: CELL_INSET_PX },
  leftCell: { paddingRight: CELL_INSET_PX },
  rightCell: { paddingLeft: CELL_INSET_PX },
  slotCell: { flexGrow: 1, padding: CELL_INSET_PX },
  editing: {
    position: 'absolute',
    top: -EDITING_RING_PX,
    right: -EDITING_RING_PX,
    bottom: -EDITING_RING_PX,
    left: -EDITING_RING_PX,
    borderWidth: EDITING_RING_PX,
    borderColor: theme.colors.state.active.background,
    borderRadius: HAPPIER_WIDGET_FRAME_METRICS.cardRadiusPx + EDITING_RING_PX,
  },
  editingPlain: { borderRadius: EDITING_RING_PX * 2 },
}));
