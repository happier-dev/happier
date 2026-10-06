import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import type { HappierGestureResponderEvent, HappierLayoutChangeEvent } from '../portableTypes.js';
import type { HappierWorkMap, HappierWorkMapNode } from './workMap.js';
import { resolveHappierWorkStatusSurfaceStyle, type HappierWorkStatusTone } from './workStatus.js';
import {
  resolveHappierWorkHost,
  useHappierWorkTheme,
  type HappierWorkHost,
  type HappierWorkTextRole,
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
  /** Opening forwards the node (and its open target); the press event lets callers restore focus. */
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
      borderWidth: 1,
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
    mark: { width: g.mark, height: g.mark, alignItems: 'center', justifyContent: 'center' },
    glyph: { width: 18, alignItems: 'center', justifyContent: 'center' },
    copy: { flex: 1, minWidth: 0 },
    subtitle: { marginTop: 1 },
    stackedStatus: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
    rowSelected: { backgroundColor: theme.colors.selected },
    /** Contact feedback for a node press. */
    rowPressed: { backgroundColor: theme.colors.hover },
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
  });
}

type WorkMapStyles = ReturnType<typeof createWorkMapStyles>;

function labelRole(appearance: HappierWorkMapNodeAppearance, compact: boolean): HappierWorkTextRole {
  if (appearance === 'lane') return 'mapLane';
  if (appearance === 'card') return compact ? 'mapLabelCompact' : 'mapLabel';
  return compact ? 'mapHeadingCompact' : 'mapHeading';
}

export function HappierWorkMapView<TNode extends HappierWorkMapNode>(props: HappierWorkMapViewProps<TNode>): ReactElement {
  const { testIDPrefix } = props;
  const theme = useHappierWorkTheme(props.theme);
  const { Text } = resolveHappierWorkHost(props.host);
  const density = props.density ?? 'regular';
  const compact = density === 'compact';
  const styles = useMemo(() => createWorkMapStyles(theme, density), [theme, density]);
  const [width, setWidth] = useState<number | null>(null);
  const onLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    setWidth((current) => (current === next ? current : next));
  }, []);
  const lanesFit = (count: number) => width === null
    || (width - LANE_GAP * (count - 1)) / count >= HAPPIER_WORK_MAP_LANE_MIN_WIDTH;

  // Visits in depth-first declared order, so reading order and connectors match. Inside a lane a
  // card is narrow, so its status moves under its title instead of squeezing it.
  const renderNode = (nodeId: string, inLane = false): ReactElement | null => {
    const node = props.map.nodesById.get(nodeId);
    if (node === undefined) return null;
    const presentation = props.presentNode?.(node) ?? DEFAULT_PRESENTATION;
    const appearance = presentation.appearance ?? 'card';
    const selected = props.selectedNodeId === node.nodeId;
    const disabled = props.isNodeDisabled?.(node) === true;
    const tone = presentation.tone ?? 'neutral';
    const lanes = presentation.childLayout === 'lanes'
      && node.childNodeIds.length > 1
      && lanesFit(node.childNodeIds.length);
    const leading = props.renderLeading?.(node) ?? null;
    // A compact map keeps each node to its title and state (lab `.wm.sm` hides the second line).
    const subtitle = compact ? null : props.renderSubtitle?.(node) ?? null;
    const role = labelRole(appearance, compact);

    const row = (
      <Pressable
        testID={`${testIDPrefix}-node-${node.nodeId}`}
        accessibilityRole="button"
        accessibilityState={{ selected, ...(disabled ? { disabled: true } : {}) }}
        disabled={disabled}
        accessibilityLabel={props.accessibilityLabelForNode(node)}
        onPress={(event) => props.onOpen?.(node, event)}
        style={({ pressed }) => [
          appearance === 'card' ? styles.card : appearance === 'lane' ? styles.laneCaption : styles.headerRow,
          appearance === 'card' ? resolveHappierWorkStatusSurfaceStyle(tone, theme.colors) as ViewStyle | null : null,
          selected ? styles.rowSelected : null,
          pressed && !disabled ? styles.rowPressed : null,
        ]}
      >
        {leading ? (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={appearance === 'card' ? styles.mark : styles.glyph}
          >
            {leading}
          </View>
        ) : null}
        <View style={styles.copy}>
          <Text
            role={role}
            strong={selected}
            numberOfLines={appearance === 'card' && !compact ? 2 : 1}
            style={{ color: appearance === 'lane' ? theme.colors.secondaryText : theme.colors.text }}
          >
            {node.label}
          </Text>
          {subtitle ? <View style={styles.subtitle}>{subtitle}</View> : null}
          {inLane && appearance === 'card' ? (
            <View style={styles.stackedStatus}>{props.renderStatus?.(node)}</View>
          ) : null}
        </View>
        {inLane && appearance === 'card' ? null : props.renderStatus?.(node)}
      </Pressable>
    );

    const children = node.childNodeIds.length === 0 ? null : lanes ? (
      <WorkMapLanes
        testID={`${testIDPrefix}-group-${node.nodeId}`}
        accessibilityLabel={node.label}
        count={node.childNodeIds.length}
        density={density}
        styles={styles}
      >
        {node.childNodeIds.map((childNodeId) => (
          <View key={childNodeId} style={styles.lane}>
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={styles.laneStub}
            />
            {renderNode(childNodeId, true)}
          </View>
        ))}
      </WorkMapLanes>
    ) : (
      <View
        testID={`${testIDPrefix}-group-${node.nodeId}`}
        accessibilityRole="list"
        accessibilityLabel={node.label}
        style={appearance === 'lane' ? styles.laneStack : styles.sequence}
      >
        {node.childNodeIds.map((childNodeId, index) => (
          <View key={childNodeId} style={appearance === 'lane' ? null : styles.sequenceItem}>
            {appearance === 'lane' ? (index === 0 ? null : <WorkMapSpine style={styles.spine} />) : (
              <>
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={index === node.childNodeIds.length - 1
                    ? [styles.railEnd, index === 0 ? styles.railEndFirst : null]
                    : [styles.rail, index === 0 ? styles.railFirst : null]}
                />
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={styles.tick}
                />
              </>
            )}
            {renderNode(childNodeId, inLane)}
          </View>
        ))}
      </View>
    );

    return (
      <View
        key={node.nodeId}
        testID={`${testIDPrefix}-item-${node.nodeId}`}
        role="listitem"
        style={[styles.item, appearance === 'frame' ? styles.frame : null]}
      >
        {row}
        {props.renderDetail?.(node)}
        {children}
      </View>
    );
  };

  return (
    <View testID={testIDPrefix} accessibilityRole="list" style={styles.container} onLayout={onLayout}>
      {props.header}
      {props.rootLayout === 'sequence' && props.map.relationships === 'authored'
        ? props.map.rootNodeIds.map((rootNodeId, index) => (
          <View key={rootNodeId}>
            {index === 0 ? null : <WorkMapSpine style={styles.spine} />}
            {renderNode(rootNodeId)}
          </View>
        ))
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
      style={styles.lanes}
      onLayout={(event) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setWidth((current) => (current === next ? current : next));
      }}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.leadStub}
      />
      {width > 0 ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.bus, { right: Math.max(0, laneWidth - markX) }]}
        />
      ) : null}
      {props.children}
    </View>
  );
}
