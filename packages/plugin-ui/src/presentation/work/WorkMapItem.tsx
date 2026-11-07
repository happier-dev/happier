import { memo, type ReactElement, type ReactNode } from 'react';
import { Platform, Pressable, View, type ViewStyle } from 'react-native';
import type { HappierGestureResponderEvent, HappierPortableStyle } from '../portableTypes.js';
import type { HappierWorkMapNode } from './workMap.js';
import { resolveHappierWorkStatusSurfaceStyle, softenHappierWorkColor, type HappierWorkStatusTone } from './workStatus.js';
import type { HappierWorkColors, HappierWorkHost, HappierWorkTextRole, HappierWorkTheme } from './workTheme.js';
import type { HappierWorkMapNodeAppearance, HappierWorkMapNodePresentation, WorkMapStyles } from './WorkMapView.js';
import { useMapNodeSelected, type MapSelection } from './mapSelection.js';

/**
 * The open card keeps its own ground and tone and is ringed (lab `.wm-node.on`, `.wm-node.need.on`): a
 * paper gap, then the tone's hue, or the ink while healthy. A grey fill would bury a held step's amber.
 */
function selectedCardRing(colors: HappierWorkColors, tone: HappierWorkStatusTone): ViewStyle {
  // A tone's ring is its card ring strengthened (the hue at 70%), so selection reads as the same hue, not a darker one.
  const ring = tone === 'attention' ? softenHappierWorkColor(colors.attention.border, 0.7) ?? colors.attention.border
    : tone === 'danger' ? softenHappierWorkColor(colors.danger.border, 0.7) ?? colors.danger.border : colors.text;
  return { boxShadow: `0 0 0 2px ${colors.surface}, 0 0 0 3.5px ${ring}` };
}

/**
 * Web only: a node's name wraps between its words and never inside one. The browser's default for text
 * (`overflow-wrap: break-word`) split "changelog" across two lines in a narrow lane; the portable style
 * has no overflow-wrap, but react-native-web still receives it.
 */
const WRAP_BY_WORD = Platform.select<HappierPortableStyle>({ web: { overflowWrap: 'normal' } as unknown as HappierPortableStyle });

function detailRole(compact: boolean): HappierWorkTextRole {
  return compact ? 'mapDetailCompact' : 'mapDetail';
}

function labelRole(appearance: HappierWorkMapNodeAppearance, compact: boolean): HappierWorkTextRole {
  if (appearance === 'lane') return 'mapLane';
  if (appearance === 'card') return compact ? 'mapLabelCompact' : 'mapLabel';
  return compact ? 'mapHeadingCompact' : 'mapHeading';
}

type WorkMapItemProps<TNode extends HappierWorkMapNode> = Readonly<{
  node: TNode;
  presentation: HappierWorkMapNodePresentation;
  selection: MapSelection;
  readOnly: boolean;
  disabled: boolean;
  accessibilityLabel: string;
  onOpen: (node: TNode, event: HappierGestureResponderEvent) => void;
  theme: HappierWorkTheme;
  Text: HappierWorkHost['Text'];
  styles: WorkMapStyles;
  testIDPrefix: string;
  compact: boolean;
  inLane: boolean;
  wrapRow: boolean;
  copyMinWidth: number;
  stackStatus: boolean;
  framePadding: number;
  scale: number;
  rootSequencePosition: number | undefined;
  leading: ReactNode;
  subtitle: ReactNode;
  status: ReactNode;
  detail: ReactNode;
  children: ReactNode;
  joinCaption?: ReactNode;
}>;

/** The shared row boundary consumes retained producer slots with default prop identity semantics. */
function WorkMapItemView<TNode extends HappierWorkMapNode>(props: Omit<WorkMapItemProps<TNode>,
  'children' | 'joinCaption' | 'detail' | 'framePadding' | 'scale' | 'rootSequencePosition'>): ReactElement {
  const { node, presentation, readOnly, disabled, theme, Text, styles, testIDPrefix,
    compact, inLane, wrapRow, copyMinWidth, stackStatus, leading, subtitle } = props;
  const selected = useMapNodeSelected(props.selection, node.nodeId);
  const appearance = presentation.appearance ?? 'card';
  const tone = presentation.tone ?? 'neutral';
  const role = labelRole(appearance, compact);
  return (
    <Pressable
      testID={`${testIDPrefix}-node-${node.nodeId}`}
      accessibilityRole={readOnly ? undefined : 'button'}
      accessibilityState={{ selected, ...(disabled && !readOnly ? { disabled: true } : {}) }}
      disabled={disabled}
      accessibilityLabel={props.accessibilityLabel}
      onPress={(event) => props.onOpen(node, event)}
      style={({ pressed }) => [
        appearance === 'card' ? styles.card : appearance === 'lane' ? styles.laneCaption : styles.headerRow,
        wrapRow ? styles.rowWrap : null,
        appearance === 'card' ? resolveHappierWorkStatusSurfaceStyle(tone, theme.colors) as ViewStyle | null : null,
        presentation.muted ? styles.cardMuted : null,
        selected ? appearance === 'card' ? selectedCardRing(theme.colors, tone) : styles.rowSelected : null,
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
      <View style={[styles.copy, wrapRow ? { minWidth: copyMinWidth } : null]}>
        <Text
          role={role}
          strong={selected}
          // A card's name is read in full: the card grows rather than ellipsizing a short name in a
          // narrow lane or nested frame. Only a compact full-width map keeps each node to one line
          // (lab `.wm.sm`); its lane cards wrap like any other.
          numberOfLines={compact && !(appearance === 'card' && inLane) ? 1 : undefined}
          style={{ color: appearance === 'lane' ? theme.colors.secondaryText : theme.colors.text, overflow: 'hidden', ...WRAP_BY_WORD }}
        >
          {node.label}
          {node.labelDetail === undefined ? null : (
            <Text role={detailRole(compact)} style={{ color: theme.colors.secondaryText }}>{` \u00b7 ${node.labelDetail}`}</Text>
          )}
        </Text>
        {subtitle ? <View style={styles.subtitle}>{subtitle}</View> : null}
        {stackStatus ? (
          <View style={styles.stackedStatus}>{props.status}</View>
        ) : null}
      </View>
      {stackStatus ? null : appearance === 'card'
        ? <View style={styles.trailingStatus}>{props.status}</View>
        : props.status}
    </Pressable>
  );
}

// Child-tree identity must not invalidate the node's own row when a sibling is selected.
const WorkMapItemRow = memo(WorkMapItemView) as typeof WorkMapItemView;

function WorkMapItemLayout<TNode extends HappierWorkMapNode>(props: WorkMapItemProps<TNode>): ReactElement {
  const { children, joinCaption, detail, framePadding, scale, rootSequencePosition, ...rowProps } = props;
  const { node, presentation, styles, testIDPrefix } = props;
  const appearance = presentation.appearance ?? 'card';
  const item = (
    <View
      testID={`${testIDPrefix}-item-${node.nodeId}`}
      role="listitem"
      style={[styles.item, appearance === 'frame' ? [styles.frame, scale === 1 ? null : { paddingHorizontal: framePadding }] : null]}
    >
      <WorkMapItemRow {...rowProps} />
      {detail}
      {children}
      {joinCaption}
    </View>
  );
  return rootSequencePosition === undefined ? item : (
    <View>
      {rootSequencePosition === 0 ? null : (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.spine} />
      )}
      {item}
    </View>
  );
}

export const WorkMapItem = memo(WorkMapItemLayout) as typeof WorkMapItemLayout;
