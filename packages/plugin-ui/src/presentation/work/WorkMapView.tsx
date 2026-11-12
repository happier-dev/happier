import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { WorkMapItem } from './WorkMapItem.js';
import { createMapSelection } from './mapSelection.js';
import type { HappierGestureResponderEvent, HappierLayoutChangeEvent } from '../portableTypes.js';
import { formatHappierWorkMapNodeName, type HappierWorkMap, type HappierWorkMapNode } from './workMap.js';
import type { HappierWorkStatusTone } from './workStatus.js';
import {
  resolveHappierWorkHost,
  useHappierWorkTheme,
  type HappierWorkHost,
  type HappierWorkTheme,
} from './workTheme.js';

/**
 * The one Work map renderer (unified-work lab `map-M1`, `map-M2`): node cards joined by hairline
 * connectors. Work that happens one after another stacks down a rail; work that happens side by side
 * sits in lanes under a shared bus, and the lanes stack when they would be too narrow to read, so a
 * phone never pans a canvas. The accessible order is the DOM order; every connector is decorative.
 *
 * It draws exactly the map's declared structure. Producers supply the words and the grammar through
 * slots — the mark, the one quiet line, the status, the tone, and how a node presents itself and its
 * children (`presentNode`) — so the renderer never derives an edge, a lifecycle or a label.
 *
 * Extracted from Happier core's `apps/ui/sources/components/work/map/WorkMapView.tsx`, which now binds
 * this renderer to the app's theme and text owner.
 */

export type HappierWorkMapNodeAppearance =
  /** A bordered card: mark, title, one line, status. The default. */
  | 'card'
  /** A header row that owns what follows (a side-by-side group, a condition). */
  | 'group'
  /** A lane caption above its own stack (one branch of side-by-side work). */
  | 'lane'
  /** A tinted frame around its header and body (a loop). */
  | 'frame';

export type HappierWorkMapNodePresentation = Readonly<{
  appearance?: HappierWorkMapNodeAppearance;
  /** How the node's children sit: down a rail (default) or side by side in lanes. */
  childLayout?: 'sequence' | 'lanes';
  /** The state treatment (INT I3): a soft ring and tint only for needs-you or failed work. */
  tone?: HappierWorkStatusTone;
  /** A quieter card for something that does not happen (a refused hand-off): same anatomy, softer ink. */
  muted?: boolean;
  /**
   * The children are alternatives, and only one of them runs (an If's Yes and Otherwise): this word
   * ("or") sits between them on a dashed rule, and nothing joins them underneath.
   */
  alternatives?: string;
  /** A caption under the children saying how they rejoin ("All 3 lanes finish"), on a bar that closes the lanes. */
  join?: string;
}>;

export type HappierWorkMapDensity = 'regular' | 'compact';

export type HappierWorkMapViewProps<TNode extends HappierWorkMapNode> = Readonly<{
  map: HappierWorkMap<TNode>;
  selectedNodeId: string | null;
  testIDPrefix: string;
  /** The producer's accessible name for a node, including any structure and state words. */
  accessibilityLabelForNode: (node: TNode) => string;
  /** The status slot, trailing the label (a `HappierWorkStatusWord`, a glyph). */
  renderStatus?: (node: TNode) => ReactNode;
  /** The node's mark (an Agent mark, an avatar, a glyph), leading the card. */
  renderLeading?: (node: TNode) => ReactNode;
  /** One quiet line under the label (engine · machine, "round 1 of up to 3"). */
  renderSubtitle?: (node: TNode) => ReactNode;
  /** The producer's grammar for this node; omitted means a card with its children down a rail. */
  presentNode?: (node: TNode) => HappierWorkMapNodePresentation;
  /** Content a node owns below its row and above its children. */
  renderDetail?: (node: TNode) => ReactNode;
  isNodeDisabled?: (node: TNode) => boolean;
  /**
   * Opening forwards the node (and its open target); the press event lets callers restore focus.
   * Omitted, the map is read-only: its cards are not pressable and carry no button role.
   */
  onOpen?: (node: TNode, event: HappierGestureResponderEvent) => void;
  /** Rendered before the nodes, inside the map. */
  header?: ReactNode;
  /** Rendered after the nodes, inside the map. */
  footer?: ReactNode;
  /**
   * `sequence`: the roots happen one after another (a workflow's top-level steps), so a spine joins
   * each root to the next under its mark, as a lane joins its own steps. Omitted keeps roots unlinked:
   * a producer that does not know how its roots relate never suggests an order.
   */
  rootLayout?: 'sequence' | 'separate';
  /**
   * `compact` is the live mini-map a Work row carries under it (lab `.wm.sm`, `convo-W8full`):
   * smaller cards and marks, one-line labels, no subtitle line, the same structure and connectors.
   */
  density?: HappierWorkMapDensity;
  /** Omitted inside a mounted plugin surface: the environment's theme. */
  theme?: HappierWorkTheme;
  /** Omitted inside a mounted plugin surface: the environment's text. */
  host?: HappierWorkHost;
}>;

/**
 * A lane narrower than this stacks instead: side-by-side cards would truncate every title. Three
 * lanes fit a Work sidebar (lab `map-M2`), and stack on a phone (`phone-P5m`).
 * Recursive nesting spends this same budget before adding another horizontal inset.
 */
export const HAPPIER_WORK_MAP_LANE_MIN_WIDTH = 128;

/**
 * The connector geometry of each density. `markX` is where every connector meets a node: the centre
 * of its mark (card padding 10 + half a 28pt mark; compact 5 + half a 22pt mark). `cardCenterY` is half
 * a card's minimum height; a child's card starts `railIndent` in, leaving the rail and its tick room.
 */
type WorkMapGeometry = Readonly<{
  markX: number;
  cardCenterY: number;
  railIndent: number;
  /** Between a node's row and what it owns (its detail, its children). */
  itemGap: number;
  /** Between one step of a sequence and the next (lab `--wm-step`). */
  stepGap: number;
  connectorGap: number;
  mark: number;
  cardMinHeight: number;
  cardGap: number;
  cardPaddingVertical: number | null;
  cardPaddingRight: number;
  headerMinHeight: number;
  framePadding: number;
}>;

const GEOMETRY: Readonly<Record<HappierWorkMapDensity, WorkMapGeometry>> = {
  regular: {
    markX: 24, cardCenterY: 24, railIndent: 36, itemGap: 8, stepGap: 18, connectorGap: 10, mark: 28, cardMinHeight: 48,
    cardGap: 10, cardPaddingVertical: null, cardPaddingRight: 10, headerMinHeight: 32, framePadding: 10,
  },
  compact: {
    markX: 16, cardCenterY: 17, railIndent: 26, itemGap: 6, stepGap: 10, connectorGap: 8, mark: 22, cardMinHeight: 34,
    cardGap: 8, cardPaddingVertical: 4, cardPaddingRight: 9, headerMinHeight: 26, framePadding: 8,
  },
};
const LANE_GAP = 8;
/** The width of the dashed rule and its word between two alternatives. */
const ALTERNATIVE_RULE_WIDTH = 20;
const CARD_BORDER_WIDTH = 1;
/** A header or lane caption's glyph slot, at least; an ordinal before the glyph widens it. */
const GLYPH_MIN_WIDTH = 18;

const DEFAULT_PRESENTATION: HappierWorkMapNodePresentation = Object.freeze({});

/** The node and connector styles one density draws with, from the Work theme. */
function createWorkMapStyles(theme: HappierWorkTheme, density: HappierWorkMapDensity) {
  const g = GEOMETRY[density];
  const compact = density === 'compact';
  const hairline = StyleSheet.hairlineWidth;
  const connector: ViewStyle = { position: 'absolute', backgroundColor: theme.colors.border };
  return StyleSheet.create({
    container: { gap: g.stepGap },
    item: { gap: g.itemGap, minWidth: 0 },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: g.cardGap,
      minHeight: g.cardMinHeight,
      paddingVertical: g.cardPaddingVertical ?? theme.spacing.small,
      paddingLeft: g.markX - g.mark / 2,
      paddingRight: g.cardPaddingRight,
      borderRadius: compact ? theme.radii.control : theme.radii.card,
      borderWidth: CARD_BORDER_WIDTH,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
    },
    // A header's glyph centres on the same line as a card's mark, so the rail leaves from under it.
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.small,
      minHeight: g.headerMinHeight,
      paddingLeft: g.markX - 9,
      paddingRight: theme.spacing.xsmall,
      borderRadius: theme.radii.control,
    },
    laneCaption: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xsmall,
      minHeight: 24,
      paddingHorizontal: theme.spacing.small,
      borderRadius: theme.radii.control,
    },
    frame: {
      padding: g.framePadding,
      borderRadius: compact ? theme.radii.inset : theme.radii.card,
      backgroundColor: theme.colors.inset,
    },
    // The mark column is at least one mark wide; a leading that also carries the step's ordinal chip
    // (a Run's map, numbered as the editor numbers it) widens it instead of running into the title.
    mark: { minWidth: g.mark, height: g.mark, alignItems: 'center', justifyContent: 'center' },
    // A frame caption's glyph slot widens the same way when the ordinal leads it (a Run's group step).
    glyph: { minWidth: GLYPH_MIN_WIDTH, alignItems: 'center', justifyContent: 'center' },
    copy: { flex: 1, minWidth: 0 },
    rowWrap: { flexWrap: 'wrap', alignContent: 'center' },
    subtitle: { marginTop: 1 },
    stackedStatus: { alignItems: 'stretch', marginTop: 2, minWidth: 0 },
    // The title keeps the room: a long state word truncates before the name does.
    trailingStatus: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xsmall, flexShrink: 0, maxWidth: '45%', minWidth: 0 },
    rowSelected: { backgroundColor: theme.colors.selected },
    /** Contact feedback for a node press. */
    rowPressed: { backgroundColor: theme.colors.hover },
    cardMuted: { opacity: 0.6 },
    // Sequence: children down a hairline rail that leaves from under the owner's mark; each child
    // draws its own segment so the rail stops at the last child's tick.
    sequence: { paddingLeft: g.railIndent, gap: g.stepGap },
    sequenceItem: { minWidth: 0 },
    // The first child's rail rises through the owner's item gap; a later child's through the step gap.
    rail: { ...connector, left: g.markX - g.railIndent, top: -g.stepGap, bottom: 0, width: hairline },
    railEnd: { ...connector, left: g.markX - g.railIndent, top: -g.stepGap, height: g.stepGap + g.cardCenterY, width: hairline },
    railFirst: { top: -g.itemGap },
    railEndFirst: { top: -g.itemGap, height: g.itemGap + g.cardCenterY },
    tick: { ...connector, left: g.markX - g.railIndent, top: g.cardCenterY, width: g.railIndent - g.markX, height: hairline },
    laneStack: { gap: g.stepGap },
    // A spine between consecutive items of a sequence that is not indented (the roots, a lane's
    // stack): it leaves from under the previous card's mark and meets the next one's.
    spine: { ...connector, left: g.markX, top: -g.stepGap, height: g.stepGap, width: hairline },
    // Lanes: a bus under the owner, one stub down into each lane.
    lanes: { flexDirection: 'row', alignItems: 'flex-start', gap: LANE_GAP, paddingTop: g.connectorGap },
    lane: { flex: 1, minWidth: 0 },
    leadStub: { ...connector, left: g.markX, top: -g.itemGap, height: g.itemGap, width: hairline },
    bus: { ...connector, left: g.markX, top: 0, height: hairline },
    laneStub: { ...connector, left: g.markX, top: -g.connectorGap, height: g.connectorGap, width: hairline },
    // Joined lanes: each lane's rail runs on from under its last card to a bar that closes the lanes,
    // and the caption hangs under that bar on the spine that continues down.
    lanesJoined: { alignItems: 'stretch', paddingBottom: g.connectorGap },
    laneJoinRail: { flexGrow: 1, minHeight: g.connectorGap },
    laneJoinRailLine: { ...connector, left: g.markX, top: 0, bottom: -g.connectorGap, width: hairline },
    joinBus: { ...connector, left: g.markX, bottom: 0, height: hairline },
    join: { paddingTop: g.itemGap, paddingLeft: g.markX + theme.spacing.small, minHeight: g.headerMinHeight / 1.5 },
    joinRail: { ...connector, left: g.markX, top: 0, bottom: 0, width: hairline },
    joinStacked: { paddingLeft: g.railIndent },
    // Alternatives: a dashed rule with the word in the middle, never a bar.
    alternativeRule: { width: ALTERNATIVE_RULE_WIDTH, alignSelf: 'stretch', alignItems: 'center', gap: theme.spacing.xsmall },
    alternativeDash: { flexGrow: 1, width: 0, borderLeftWidth: 1, borderStyle: 'dashed', borderColor: theme.colors.border },
    alternativeStacked: { paddingLeft: g.railIndent - g.markX + theme.spacing.small, paddingVertical: 2 },
  });
}

export type WorkMapStyles = ReturnType<typeof createWorkMapStyles>;

export function HappierWorkMapView<TNode extends HappierWorkMapNode>(props: HappierWorkMapViewProps<TNode>): ReactElement {
  const { testIDPrefix } = props;
  const theme = useHappierWorkTheme(props.theme);
  const { Text } = resolveHappierWorkHost(props.host);
  const density = props.density ?? 'regular';
  const compact = density === 'compact';
  const g = GEOMETRY[density];
  const styles = useMemo(() => createWorkMapStyles(theme, density), [theme, density]);
  const [selection] = useState(() => createMapSelection(props.selectedNodeId));
  useLayoutEffect(() => { selection.select(props.selectedNodeId); }, [selection, props.selectedNodeId]);
  const openRef = useRef(props.onOpen);
  useLayoutEffect(() => { openRef.current = props.onOpen; }, [props.onOpen]);
  const openNode = useCallback((node: TNode, event: HappierGestureResponderEvent) => openRef.current?.(node, event), []);
  const [width, setWidth] = useState<number | null>(null);
  const onLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    setWidth((current) => (current === next ? current : next));
  }, []);
  // Lanes sit side by side only when every lane still holds its deepest card at a readable width after
  // the frames and rails inside it take their room; otherwise they stack, judged by the map's own
  // measured width (a docked pane narrows it as much as a phone does), never by the device.
  const lanesFit = (childNodeIds: readonly string[], availableWidth: number | null, gutter: number) => {
    if (availableWidth === null) return true;
    const laneWidth = (availableWidth - gutter * (childNodeIds.length - 1)) / childNodeIds.length;
    const nestedInset = childNodeIds.reduce((widest, nodeId) => Math.max(widest, nestedInsetByNodeId.get(nodeId) ?? 0), 0);
    return laneWidth >= HAPPIER_WORK_MAP_LANE_MIN_WIDTH + nestedInset;
  };
  // Reserve connector space for the actual remaining structure, not an arbitrary depth ceiling.
  // At extreme depth the hairlines can share a compact gutter; no level or edge disappears.
  const insetLevelsByNodeId = useMemo(() => {
    const levels = new Map<string, number>();
    const pending = props.map.rootNodeIds.map(nodeId => ({ nodeId, visited: false }));
    while (pending.length > 0) {
      const entry = pending.pop()!;
      const node = props.map.nodesById.get(entry.nodeId);
      if (node === undefined) continue;
      if (!entry.visited) {
        pending.push({ nodeId: entry.nodeId, visited: true });
        for (const nodeId of node.childNodeIds) pending.push({ nodeId, visited: false });
        continue;
      }
      const childLevels = node.childNodeIds.reduce((deepest, nodeId) => Math.max(deepest, levels.get(nodeId) ?? 0), 0);
      const indented = node.childNodeIds.length > 0 && props.presentNode?.(node).appearance !== 'lane';
      levels.set(entry.nodeId, childLevels + (indented ? 1 : 0));
    }
    return levels;
  }, [props.map, props.presentNode]);

  // The ordinary horizontal room a node's structure spends before its deepest card: each frame's
  // padding and each rail indent along the widest path down.
  const nestedInsetByNodeId = useMemo(() => {
    const insets = new Map<string, number>();
    const visit = (nodeId: string): number => {
      const known = insets.get(nodeId);
      if (known !== undefined) return known;
      const node = props.map.nodesById.get(nodeId);
      if (node === undefined) return 0;
      insets.set(nodeId, 0);
      const presentation = props.presentNode?.(node) ?? DEFAULT_PRESENTATION;
      const appearance = presentation.appearance ?? 'card';
      const own = (appearance === 'frame' ? 2 * g.framePadding : 0)
        + (appearance !== 'lane' && presentation.childLayout !== 'lanes' && node.childNodeIds.length > 0 ? g.railIndent : 0);
      const inset = own + node.childNodeIds.reduce((widest, childNodeId) => Math.max(widest, visit(childNodeId)), 0);
      insets.set(nodeId, inset);
      return inset;
    };
    for (const nodeId of props.map.nodesById.keys()) visit(nodeId);
    return insets;
  }, [g, props.map, props.presentNode]);

  // Visits in depth-first declared order, so reading order and connectors match.
  const renderNode = (nodeId: string, inLane = false, availableWidth = width, compressed = false, rootSequencePosition?: number): ReactElement | null => {
    const node = props.map.nodesById.get(nodeId);
    if (node === undefined) return null;
    const presentation = props.presentNode?.(node) ?? DEFAULT_PRESENTATION;
    const appearance = presentation.appearance ?? 'card';
    const readOnly = props.onOpen === undefined;
    const disabled = readOnly || props.isNodeDisabled?.(node) === true;
    // Keep the approved anatomy while it fits alongside the remaining hairlines. Thereafter spend
    // half the spare budget here and leave half for deeper levels: progressively smaller insets,
    // never a flattened branch. Frame padding and its rail compress together, preserving grouping.
    const ordinaryPadding = appearance === 'frame' ? g.framePadding : 0;
    const ordinaryIndent = appearance !== 'lane' && node.childNodeIds.length > 0 ? g.railIndent : 0;
    const ordinaryInset = 2 * ordinaryPadding + ordinaryIndent;
    const levels = insetLevelsByNodeId.get(nodeId) ?? 0;
    const budget = availableWidth === null ? null : Math.max(0, availableWidth - HAPPIER_WORK_MAP_LANE_MIN_WIDTH);
    const minimumInset = budget === null || levels === 0 ? 0 : Math.min(StyleSheet.hairlineWidth, budget / levels);
    const scale = budget === null || ordinaryInset === 0
      || ordinaryInset + minimumInset * Math.max(0, levels - 1) <= budget
      ? 1
      : (minimumInset + Math.max(0, budget - minimumInset * levels) / 2) / ordinaryInset;
    const framePadding = ordinaryPadding * scale;
    const rowWidth = availableWidth === null ? null : availableWidth - 2 * framePadding;
    const indent = ordinaryIndent * scale;
    const railGeometry = scale === 1 ? null : { left: (g.markX - g.railIndent) * scale };
    const compressedNode = compressed || scale < 1;
    const alternatives = presentation.alternatives;
    const join = presentation.join;
    // Between two alternatives sits their dashed rule, so each gap holds it as well as the lane gaps.
    const laneGutter = alternatives === undefined ? LANE_GAP : 2 * LANE_GAP + ALTERNATIVE_RULE_WIDTH;
    const lanes = presentation.childLayout === 'lanes'
      && node.childNodeIds.length > 1
      && lanesFit(node.childNodeIds, rowWidth, laneGutter);
    const detailRole = compact ? 'mapDetailCompact' : 'mapDetail';
    const alternativeWord = (key: string, stacked: boolean) => alternatives === undefined ? null : (
      <View key={`or:${key}`} testID={`${testIDPrefix}-or-${key}`} style={stacked ? styles.alternativeStacked : styles.alternativeRule}>
        {stacked ? null : <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.alternativeDash} />}
        <Text role={detailRole} style={{ color: theme.colors.mutedText }}>{alternatives}</Text>
        {stacked ? null : <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.alternativeDash} />}
      </View>
    );
    const leading = props.renderLeading?.(node) ?? null;
    const rowPadding = appearance === 'card'
      ? g.markX - g.mark / 2 + g.cardPaddingRight + 2 * CARD_BORDER_WIDTH
      : appearance === 'lane' ? 2 * theme.spacing.small : g.markX - 9 + theme.spacing.xsmall;
    // The row's own padding and border are this renderer's; the leading slot's width is the producer's,
    // and the row reads it as drawn (`WorkMapItem`) to decide whether the name keeps its readable width.
    const copyRoom = rowWidth === null ? null : Math.max(0, rowWidth - rowPadding);
    const leadingGap = appearance === 'card' ? g.cardGap : appearance === 'lane' ? theme.spacing.xsmall : theme.spacing.small;
    // A compact map keeps each node to its title and state (lab `.wm.sm` hides the second line), and so
    // does a lane: its card is narrow, so the fact line would only truncate (lab `map-M2`). Stacked
    // lanes (a phone, `phone-P5m`) are full width again and keep it.
    const subtitle = compact || inLane ? null : props.renderSubtitle?.(node) ?? null;

    const children = node.childNodeIds.length === 0 ? null : lanes ? (
      <WorkMapLanes
        testID={`${testIDPrefix}-group-${node.nodeId}`}
        accessibilityLabel={formatHappierWorkMapNodeName(node)}
        count={node.childNodeIds.length}
        density={density}
        styles={styles}
        bus={alternatives === undefined}
        joined={join !== undefined}
      >
        {node.childNodeIds.flatMap((childNodeId, index) => [
          index === 0 ? null : alternativeWord(childNodeId, false),
          <View key={childNodeId} style={styles.lane}>
            {alternatives === undefined ? (
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={styles.laneStub}
              />
            ) : null}
            {renderNode(childNodeId, true, rowWidth === null ? null : (rowWidth - laneGutter * (node.childNodeIds.length - 1)) / node.childNodeIds.length, compressedNode)}
            {join === undefined ? null : (
              <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.laneJoinRail}>
                <View style={styles.laneJoinRailLine} />
              </View>
            )}
          </View>,
        ])}
      </WorkMapLanes>
    ) : (
      <View
        testID={`${testIDPrefix}-group-${node.nodeId}`}
        accessibilityRole="list"
        accessibilityLabel={formatHappierWorkMapNodeName(node)}
        style={appearance === 'lane' ? styles.laneStack : [styles.sequence, scale === 1 ? null : { paddingLeft: indent }]}
      >
        {node.childNodeIds.map((childNodeId, index) => (
          <View key={childNodeId} style={appearance === 'lane' ? null : styles.sequenceItem}>
            {index === 0 ? null : alternativeWord(childNodeId, true)}
            {appearance === 'lane' ? (index === 0 ? null : <WorkMapSpine style={styles.spine} />) : (
              <>
                <View
                  testID={`${testIDPrefix}-rail-${childNodeId}`}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={[index === node.childNodeIds.length - 1
                    ? [styles.railEnd, index === 0 ? styles.railEndFirst : null]
                    : [styles.rail, index === 0 ? styles.railFirst : null], railGeometry]}
                />
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={[styles.tick, scale === 1 ? null : { ...railGeometry, width: (g.railIndent - g.markX) * scale }]}
                />
              </>
            )}
            {renderNode(childNodeId, inLane, rowWidth === null ? null : rowWidth - indent, compressedNode)}
          </View>
        ))}
      </View>
    );

    const joinCaption = join === undefined || children === null ? null : (
      <View testID={`${testIDPrefix}-join-${node.nodeId}`} style={lanes ? styles.join : [styles.join, styles.joinStacked]}>
        {lanes ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.joinRail} /> : null}
        <Text role={detailRole} style={{ color: theme.colors.secondaryText }}>{join}</Text>
      </View>
    );

    return (
      <WorkMapItem
        key={node.nodeId}
        node={node}
        presentation={presentation}
        selection={selection}
        readOnly={readOnly}
        disabled={disabled}
        accessibilityLabel={props.accessibilityLabelForNode(node)}
        onOpen={openNode}
        theme={theme}
        Text={Text}
        styles={styles}
        testIDPrefix={testIDPrefix}
        compact={compact}
        inLane={inLane}
        compressed={compressedNode}
        copyRoom={copyRoom}
        copyFloor={HAPPIER_WORK_MAP_LANE_MIN_WIDTH}
        leadingGap={leadingGap}
        leadingMinWidth={appearance === 'card' ? g.mark : GLYPH_MIN_WIDTH}
        framePadding={framePadding}
        scale={scale}
        rootSequencePosition={rootSequencePosition}
        leading={leading}
        subtitle={subtitle}
        status={props.renderStatus?.(node)}
        detail={props.renderDetail?.(node)}
        children={children}
        joinCaption={joinCaption}
      />
    );
  };

  return (
    <View testID={testIDPrefix} accessibilityRole="list" style={styles.container} onLayout={onLayout}>
      {props.header}
      {props.rootLayout === 'sequence' && props.map.relationships === 'authored'
        ? props.map.rootNodeIds.map((rootNodeId, index) => renderNode(rootNodeId, false, width, false, index))
        : props.map.rootNodeIds.map((rootNodeId) => renderNode(rootNodeId))}
      {props.footer}
    </View>
  );
}

/** A decorative connector: hidden from assistive technology, which reads the DOM order instead. */
function WorkMapSpine(props: Readonly<{ style: ViewStyle }>) {
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={props.style} />;
}

/** Side-by-side lanes under one bus: the bus runs from the first lane's stub to the last one's. */
function WorkMapLanes(props: Readonly<{
  testID: string;
  accessibilityLabel: string;
  count: number;
  density: HappierWorkMapDensity;
  styles: WorkMapStyles;
  /** The bar the lanes hang from; alternatives hang from none. */
  bus: boolean;
  /** A second bar under the lanes, where they rejoin. */
  joined: boolean;
  children: ReactNode;
}>) {
  const { styles } = props;
  const { markX } = GEOMETRY[props.density];
  const [width, setWidth] = useState(0);
  const laneWidth = props.count > 0 ? (width - LANE_GAP * (props.count - 1)) / props.count : 0;
  return (
    <View
      testID={props.testID}
      accessibilityRole="list"
      accessibilityLabel={props.accessibilityLabel}
      style={[styles.lanes, props.joined ? styles.lanesJoined : null]}
      onLayout={(event) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setWidth((current) => (current === next ? current : next));
      }}
    >
      {props.bus ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.leadStub}
        />
      ) : null}
      {props.bus && width > 0 ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.bus, { right: Math.max(0, laneWidth - markX) }]}
        />
      ) : null}
      {props.joined && width > 0 ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.joinBus, { right: Math.max(0, laneWidth - markX) }]}
        />
      ) : null}
      {props.children}
    </View>
  );
}
