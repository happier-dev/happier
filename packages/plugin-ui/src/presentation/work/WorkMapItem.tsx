import { memo, type ReactElement, type ReactNode } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
import type { HappierGestureResponderEvent } from '../portableTypes.js';
import type { HappierWorkMapNode } from './workMap.js';
import { resolveHappierWorkStatusSurfaceStyle, softenHappierWorkColor, type HappierWorkStatusTone } from './workStatus.js';
import type { HappierWorkColors, HappierWorkHost, HappierWorkTextRole, HappierWorkTheme } from './workTheme.js';
import type { HappierWorkMapNodeAppearance, HappierWorkMapNodePresentation, WorkMapStyles } from './WorkMapView.js';

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
  selected: boolean;
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
}>;

/** The shared row boundary consumes retained producer slots with default prop identity semantics. */
function WorkMapItemView<TNode extends HappierWorkMapNode>(props: WorkMapItemProps<TNode>): ReactElement {
  const { node, presentation, selected, readOnly, disabled, theme, Text, styles, testIDPrefix,
    compact, inLane, wrapRow, copyMinWidth, stackStatus, framePadding, scale, leading, subtitle } = props;
  const appearance = presentation.appearance ?? 'card';
  const tone = presentation.tone ?? 'neutral';
  const role = labelRole(appearance, compact);
  const row = (
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
          style={{ color: appearance === 'lane' ? theme.colors.secondaryText : theme.colors.text, overflow: 'hidden' }}
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

  const item = (
    <View
      testID={`${testIDPrefix}-item-${node.nodeId}`}
      role="listitem"
      style={[styles.item, appearance === 'frame' ? [styles.frame, scale === 1 ? null : { paddingHorizontal: framePadding }] : null]}
    >
      {row}
      {props.detail}
      {props.children}
    </View>
  );
  return props.rootSequencePosition === undefined ? item : (
    <View>
      {props.rootSequencePosition === 0 ? null : (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.spine} />
      )}
      {item}
    </View>
  );
}

export const WorkMapItem = memo(WorkMapItemView) as typeof WorkMapItemView;
