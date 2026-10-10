import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import { useOptionalHappierUiPalette, useOptionalHappierUiTypography } from '../../environment/context.js';
import { HappierDisclosureChevron } from '../collection/DisclosureChevron.js';
import { HAPPIER_COLLECTION_LIST_METRICS, HAPPIER_COLLECTION_LIST_TEXT } from '../collection/CollectionList.js';
import { resolveHappierTextStepStyle } from '../layout/pageText.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HappierPressable } from '../interaction/Pressable.js';
import {
  HAPPIER_PRESS_FEEDBACK_V1,
  happierPressTransitionStyle,
} from '../interaction/pressFeedback.js';
import type { HappierFocusable, HappierStyleProp } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import type { HappierTreeNode } from './treeInteraction.js';

/**
 * The tree row rhythm, shared by Happier core's file trees (Code, Files, Git changes, Machine paths) and a
 * plugin author's `Tree` (lab p-code BROWSE): one indent step per level up to a ceiling so deep paths keep
 * their names, a precise sidebar height and the touch height, and the table rhythm for a tree drawn with a
 * column beside its names.
 */
export const HAPPIER_TREE_ROW_METRICS = Object.freeze({
  minHeightPx: Object.freeze({ precise: 28, touch: 36 }),
  /** A tree drawn as a table (Code folder pages): each row carries a column, so it takes a list row's rhythm. */
  tableMinHeightPx: Object.freeze({ precise: 36, touch: 52 }),
  basePaddingPx: 10,
  indentStepPx: 14,
  maxIndentDepth: 6,
  /** The disclosure column: a branch's chevron, or the same width of space on a leaf so names align. */
  disclosureBoxPx: 20,
  glyphGapPx: 6,
});

/** The start padding of a row at this depth: base padding plus one step per level, capped. */
export function resolveHappierTreeRowIndentPx(
  depth: number,
  input: Readonly<{ basePaddingPx?: number; indentStepPx?: number }> = {},
): number {
  const base = input.basePaddingPx ?? HAPPIER_TREE_ROW_METRICS.basePaddingPx;
  const step = input.indentStepPx ?? HAPPIER_TREE_ROW_METRICS.indentStepPx;
  return (
    base +
    Math.min(HAPPIER_TREE_ROW_METRICS.maxIndentDepth, Math.max(0, depth)) * step
  );
}

/**
 * A tree row's disclosure column. A branch with `onPress` has its own target: pressing it opens or closes the
 * branch in place while the row itself activates (plan 70 §2: disclosure never secretly opens a file). The
 * row is the keyboard tree item, so the chevron stays out of the tab order. Without `onPress` the chevron is
 * the row's decoration; a leaf keeps the column as space.
 */
export function HappierTreeDisclosure(
  props: Readonly<{
    kind: HappierTreeNode['kind'];
    expanded: boolean;
    color: string;
    /** Under hover or focus of its own target. */
    activeColor?: string;
    onPress?: (() => void) | null;
    disabled?: boolean;
    accessibilityLabel?: string;
    reducedMotion?: boolean;
    /**
     * The column's width. A tree whose chevron is decoration (the row itself toggles) may keep a narrower
     * column than one whose chevron is its own target.
     */
    columnPx?: number;
    testID?: string;
  }>,
) {
  const box = props.columnPx ?? HAPPIER_TREE_ROW_METRICS.disclosureBoxPx;
  if (props.kind === 'leaf') return <View style={{ width: box }} />;
  if (!props.onPress) {
    return (
      <View
        style={{ width: box, alignItems: 'center', justifyContent: 'center' }}
      >
        <HappierDisclosureChevron
          expanded={props.expanded}
          color={props.color}
          reducedMotion={props.reducedMotion}
        />
      </View>
    );
  }
  return (
    <HappierPressable
      testID={props.testID}
      disabled={props.disabled}
      onPress={(event) => {
        // The chevron sits inside the row's own target: its press discloses, it must not also activate the row.
        (event as { stopPropagation?: () => void } | undefined)?.stopPropagation?.();
        props.onPress?.();
      }}
      expanded={props.expanded}
      accessibilityLabel={props.accessibilityLabel}
      tabIndex={-1}
      hitSlop={4}
      style={{
        width: box,
        height: box,
        borderRadius: box / 2,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {(state) => (
        <HappierDisclosureChevron
          expanded={props.expanded}
          color={
            state.hovered && props.activeColor ? props.activeColor : props.color
          }
          reducedMotion={props.reducedMotion}
        />
      )}
    </HappierPressable>
  );
}

export type HappierTreeRowProps = Readonly<{
  node: HappierTreeNode;
  title: string;
  /** The item's own mark (a folder or file glyph, a brand mark); it stands alone, never on a tile. */
  mark?: ReactNode;
  /** A controlled selection control before the mark (for example, a changed-file checkbox). */
  selection?: ReactNode;
  /** A compact state mark immediately after the selection control. */
  selectionMark?: ReactNode;
  /** A compact fact immediately after the title (for example, a changed-file count). */
  titleAccessory?: ReactNode;
  /** One quiet fact at the trailing edge ("2 days"). */
  meta?: ReactNode;
  /** The row's own controls after the meta (an author's menu). */
  trailing?: ReactNode;
  /** Row actions revealed by the shared row's hover/focus/selected state, or opened by a touch long press. */
  renderActions?: (control: HappierTreeRowActionsControl) => ReactNode;
  actionsRevealed?: boolean;
  /** Replaces display content while editing; nested controls retain their own press and keyboard intents. */
  inlineEdit?: ReactNode;
  selected?: boolean;
  /** The roving tab stop of the tree. */
  tabStop: boolean;
  presentation?: 'tree' | 'table';
  touch?: boolean;
  theme: HappierUiTheme;
  reducedMotion?: boolean;
  onActivate: () => void;
  onLongPress?: () => void;
  onContextMenu?: (event: unknown) => void;
  keyboardShortcuts?: string;
  onFocus: () => void;
  onKeyDown: (key: string, event: unknown) => boolean;
  controlRef: (target: HappierFocusable | null) => void;
  disclosure?: Readonly<{
    onPress?: () => void;
    accessibilityLabel: string;
    testID?: string;
  }>;
  testID?: string;
  style?: HappierStyleProp;
}>;

export type HappierTreeRowActionsControl = Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Touch rows open actions from long press and do not draw a separate trigger until opened. */
  triggerHidden: boolean;
}>;

const ROW_ACTIONS_OVERLAY_STYLE = {
  position: 'absolute',
  right: 0,
  top: 0,
  bottom: 0,
  justifyContent: 'center',
  borderRadius: 6,
} as const;
const ROW_ACTIONS_HIDDEN_ANCHOR_STYLE = {
  position: 'absolute',
  right: 0,
  width: 0,
  height: 0,
  overflow: 'visible',
} as const;

/**
 * One tree item: indent · disclosure · mark · title · meta · trailing, on the column row's inset chip (the
 * hover and selected fills a navigation row draws). A branch title is the bolder line and ellipsizes in the
 * middle so its last segment stays whole; a leaf truncates its end.
 */
export function HappierTreeRow(props: HappierTreeRowProps) {
  const { node, theme } = props;
  const palette = useOptionalHappierUiPalette(theme);
  const typography = useOptionalHappierUiTypography();
  const branch = node.kind === 'branch';
  const editing = Boolean(props.inlineEdit);
  const wasEditing = useRef(editing);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [rowFocused, setRowFocused] = useState(false);
  const target = useRef<HappierFocusable | null>(null);
  const controlRef = useRef(props.controlRef);
  controlRef.current = props.controlRef;
  const bindTarget = useCallback((value: HappierFocusable | null) => {
    target.current = value;
    controlRef.current(value);
  }, []);
  useEffect(() => {
    if (wasEditing.current && !editing) target.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const heights =
    props.presentation === 'table'
      ? HAPPIER_TREE_ROW_METRICS.tableMinHeightPx
      : HAPPIER_TREE_ROW_METRICS.minHeightPx;
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      webRole="treeitem"
      accessibilityLevel={node.depth + 1}
      accessibilityLabel={props.title}
      expanded={branch ? node.expanded : undefined}
      selected={props.selected === true}
      disabled={node.disabled}
      tabIndex={props.tabStop ? 0 : -1}
      controlRef={bindTarget}
      onKeyDown={editing ? () => false : props.onKeyDown}
      onFocusChange={(focused) => {
        setRowFocused(focused);
        if (focused) props.onFocus();
      }}
      onLongPress={props.renderActions && props.touch ? () => setActionsOpen(true) : props.onLongPress}
      onContextMenu={props.onContextMenu}
      keyboardShortcuts={props.keyboardShortcuts}
      onPress={() => {
        if (!editing) props.onActivate();
      }}
      style={(state) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: HAPPIER_TREE_ROW_METRICS.glyphGapPx,
          minWidth: 0,
          minHeight: props.touch ? heights.touch : heights.precise,
          paddingLeft: resolveHappierTreeRowIndentPx(node.depth),
          paddingRight: HAPPIER_TREE_ROW_METRICS.basePaddingPx,
          marginHorizontal:
            HAPPIER_COLLECTION_LIST_METRICS.rowInset -
            HAPPIER_TREE_ROW_METRICS.basePaddingPx,
          borderRadius: HAPPIER_COLLECTION_LIST_METRICS.rowRadius,
          ...happierFocusRingStyle({
            visible: state.focused,
            color: theme.colors.focus,
            placement: 'inset',
          }),
          backgroundColor:
            props.selected === true
              ? (palette?.navigationSelected ?? theme.colors.elevatedSurface)
              : state.hovered && !state.disabled
                ? (palette?.navigationHover ?? 'transparent')
                : 'transparent',
          opacity: state.disabled
            ? 0.5
            : state.pressed
              ? HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle
              : 1,
          ...happierPressTransitionStyle(state.pressed, ['opacity']),
        },
        props.style,
      ]}
    >
      {(state) => {
        const actionsVisible = Boolean(props.renderActions) && (props.touch
          ? actionsOpen
          : state.hovered || rowFocused || actionsOpen || props.actionsRevealed === true || props.selected === true);
        const actions = actionsVisible && props.renderActions
          ? props.renderActions({ open: actionsOpen, onOpenChange: setActionsOpen, triggerHidden: props.touch === true })
          : null;
        return (
          <>
            <HappierTreeDisclosure
              kind={node.kind}
              expanded={node.expanded}
              color={theme.colors.mutedText}
              activeColor={theme.colors.text}
              onPress={editing ? null : props.disclosure?.onPress ?? null}
              disabled={node.disabled}
              accessibilityLabel={props.disclosure?.accessibilityLabel}
              reducedMotion={props.reducedMotion}
              testID={props.disclosure?.testID}
            />
            {props.selection ?? null}
            {props.mark ? (
              <View aria-hidden style={{ alignItems: 'center', justifyContent: 'center' }}>
                {props.mark}
              </View>
            ) : null}
            {props.selectionMark ?? null}
            {editing ? (
              <View style={{ flex: 1, minWidth: 0 }}>{props.inlineEdit}</View>
            ) : (
              <>
                <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: HAPPIER_TREE_ROW_METRICS.glyphGapPx }}>
                  {/* One title size for every row (lab `.ca-row .t`); table branches keep the regular file-table weight. */}
                  <HappierText
                    numberOfLines={1}
                    ellipsizeMode={branch ? 'middle' : 'tail'}
                    style={{
                      ...resolveHappierTextStepStyle(
                        HAPPIER_COLLECTION_LIST_TEXT[branch && props.presentation !== 'table' ? 'rowTitleSelected' : 'rowTitle'],
                        typography,
                      ),
                      flexShrink: 1,
                      minWidth: 0,
                      color: theme.colors.text,
                    }}
                  >
                    {props.title}
                  </HappierText>
                  {props.titleAccessory ?? null}
                </View>
                {typeof props.meta === 'string' || typeof props.meta === 'number' ? (
                  <HappierText
                    variant="caption"
                    numberOfLines={1}
                    tabularNumbers
                    style={{ flexShrink: 0, color: theme.colors.mutedText }}
                  >
                    {props.meta}
                  </HappierText>
                ) : props.meta ?? null}
                {props.trailing || props.renderActions ? (
                  <View style={{ position: 'relative', flexDirection: 'row', alignItems: 'center' }}>
                    {props.trailing ?? null}
                    {actions ? (
                      <View style={props.touch
                        ? ROW_ACTIONS_HIDDEN_ANCHOR_STYLE
                        : [ROW_ACTIONS_OVERLAY_STYLE, { backgroundColor: palette?.navigationHover ?? theme.colors.elevatedSurface }]}
                      >
                        {actions}
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </>
            )}
          </>
        );
      }}
    </HappierPressable>
  );
}
