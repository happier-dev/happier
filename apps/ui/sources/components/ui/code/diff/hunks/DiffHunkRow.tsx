import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TactilePressable } from '@/components/ui/interactions/TactilePressable';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { resolveCodeMonoFontFamily } from '@/components/ui/code/codeTypography';
import { resolveCodeEditorGutterMetrics } from '@/components/ui/code/editor/codeEditorFontMetrics';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import type { KeyboardCommandId } from '@/keyboard/types';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';
import type {
  DiffHunkAction,
  DiffHunkInfo,
  DiffViewerHunks,
} from '../diffViewerTypes';
import { DiffHunkRowRegistryContext } from './diffHunkReadingLine';
import { HunkContextMenu } from './HunkContextMenu';
import { presentDiffHunkKeep } from './diffHunkKeepLabels';
import { useDiffHunkNumber } from './diffHunkNumbering';

/** The row label begins where the code text begins: past the two number columns of a diff gutter. */
const ROW_TEXT_INSET = resolveCodeEditorGutterMetrics({
  lineNumberDigits: 1,
  digitWidth: 0,
  columns: 2,
}).textOffset;

/**
 * Where code text begins inside the row's own box. A renderer that places the row in its code column
 * (Pierre's annotation slot, past its gutter) supplies its own text inset; the default spans the gutter.
 */
/** Below this the row drops its range and key hints so the change name and both buttons fit. */
const NARROW_ROW_WIDTH = 320;

/** The visible width of an unwrapped code column that scrolls sideways (Happier renderer); null when it wraps. */
export type DiffHunkRowViewport = Readonly<{ width: number; offsetX: number }>;
export const DiffHunkRowViewportContext = React.createContext<DiffHunkRowViewport | null>(null);

/** A px inset, or a CSS length on web (Pierre's code column measures its text inset in `ch`). */
export const DiffHunkRowTextInsetContext = React.createContext<number | `${number}ch`>(ROW_TEXT_INSET);

const HoverView = View as unknown as React.ComponentType<
  React.ComponentPropsWithRef<typeof View> & {
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
  }
>;

export function describeDiffHunkRange(
  hunk: Pick<DiffHunkInfo, 'rangeStart' | 'rangeEnd'>,
): string {
  return hunk.rangeStart === hunk.rangeEnd
    ? t('hunkReview.line', { line: hunk.rangeStart })
    : t('hunkReview.lines', { start: hunk.rangeStart, end: hunk.rangeEnd });
}

function ShortcutHint(
  props: Readonly<{ commandId: KeyboardCommandId; color: string }>,
) {
  const label = useKeyboardShortcutLabel(props.commandId);
  if (!label) return null;
  return (
    <Text
      variant="micro"
      style={{ fontFamily: resolveCodeMonoFontFamily(), color: props.color }}
    >
      {label}
    </Text>
  );
}

/**
 * The one drawing of a change's header row (lab ade-shell RV2): "Change n · lines", Kept state,
 * and Discard / Keep. Quiet until hover or focus, except the current change, which always shows its
 * buttons and the ink edge. Phones show the label only: the review bar and long-press carry actions.
 */
export const DiffHunkRow = React.memo(function DiffHunkRow(
  props: Readonly<{ hunk: DiffHunkInfo; review: DiffViewerHunks }>,
) {
  const { hunk, review } = props;
  const { theme } = useUnistyles();
  const phone = useDeviceType() === 'phone';
  const [revealed, setRevealed] = React.useState(false);
  // A narrow column (a side pane's code column) keeps the change name and both buttons; the range and
  // key hints step aside (the keys still work, and their tooltips say them).
  const [narrow, setNarrow] = React.useState(false);
  const onRowLayout = React.useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
    const next = event.nativeEvent.layout.width < NARROW_ROW_WIDTH;
    setNarrow((previous) => (previous === next ? previous : next));
  }, []);
  const state = review.stateOf?.(hunk) ?? 'open';
  const current = review.currentIndex === hunk.index;
  const { n, total } = useDiffHunkNumber(review.numbering, hunk.index);
  const range = describeDiffHunkRange(hunk);
  const reason = (action: DiffHunkAction) =>
    review.disabledReason?.(hunk, action) ?? null;
  const keep = review.actions?.keep;
  const discard = review.actions?.discard;
  const kept = state === 'kept';
  const keepWords = presentDiffHunkKeep(review, kept);
  const busy = state === 'discarding';
  const showActions = !phone && (keep || discard) && (current || revealed);
  const discardReason = discard ? reason('discard') : null;
  const keepReason = keep ? reason('keep') : null;
  // The reason speaks wherever its buttons show: the current change, and any change hovered or focused.
  const shownReason = current || showActions ? (discardReason ?? keepReason) : null;
  const textInset = React.useContext(DiffHunkRowTextInsetContext);
  // In a sideways-scrolling column the row spans the visible width and stays pinned to its left edge,
  // so its actions sit at the pane edge, not past the longest line.
  const viewport = React.useContext(DiffHunkRowViewportContext);
  // The surface follows which change crosses its reading line from the mounted rows (phone review).
  const registry = React.useContext(DiffHunkRowRegistryContext);
  const rowRef = React.useRef<View | null>(null);
  React.useEffect(() => (registry && rowRef.current ? registry.register(hunk, rowRef.current) : undefined), [registry, hunk]);
  // Phones: the row is a quiet label; a long press opens the change's menu (lab ade-shell RV3 P3).
  const [menuOpen, setMenuOpen] = React.useState(false);
  const hasMenu = phone && Boolean(keep || discard || review.actions?.ask || review.actions?.copy || review.actions?.comment);
  const openMenu = React.useCallback(() => {
    void hapticsLight();
    setMenuOpen(true);
  }, []);
  const reveal = React.useCallback(() => setRevealed(true), []);
  const conceal = React.useCallback(() => setRevealed(false), []);
  const hoverHandlers =
    Platform.OS === 'web' && !phone
      ? {
          onMouseEnter: reveal,
          onMouseLeave: conceal,
          onFocus: reveal,
          onBlur: conceal,
        }
      : null;

  const row = (
    <HoverView
      ref={rowRef}
      testID={`diff-hunk-row-${hunk.index}`}
      onLayout={onRowLayout}
      accessibilityState={{ busy }}
      {...(current ? { 'aria-current': true } : {})}
      style={[
        styles.row,
        // RN's DimensionValue has no `ch`; only the web Pierre adapter supplies one, and RNW passes CSS lengths through.
        { paddingLeft: textInset as number },
        viewport
          ? { width: viewport.width, transform: [{ translateX: viewport.offsetX }] }
          : null,
        current
          ? [
              styles.rowCurrent,
              { borderLeftColor: theme.colors.text.secondary },
            ]
          : null,
        busy ? styles.rowBusy : null,
      ]}
      {...(hoverHandlers ?? {})}
    >
      {kept ? (
        <View style={styles.label}>
          <Icon
            name="check"
            size={ICON_SIZE.xs}
            color={theme.colors.state.success.foreground}
          />
          <Text variant="micro" style={{ color: theme.colors.text.tertiary }}>
            {keepWords.title}
          </Text>
          <Text
            variant="micro"
            numberOfLines={1}
            style={{
              color: theme.colors.text.tertiary,
              fontVariant: ['tabular-nums'],
            }}
          >{narrow ? '' : `· ${range}`}</Text>
        </View>
      ) : (
        <View style={[styles.label, narrow || shownReason ? styles.labelNarrow : null]}>
          <Text
            variant="micro"
            emphasis="semiBold"
            numberOfLines={1}
            style={{
              flexShrink: 0,
              color: current
                ? theme.colors.text.primary
                : theme.colors.text.secondary,
              fontVariant: ['tabular-nums'],
            }}
          >
            {t('hunkReview.change', { n })}
          </Text>
          {/* While a reason speaks, the range (the gutter already numbers the lines) steps aside for it. */}
          <Text
            variant="micro"
            numberOfLines={1}
            style={{
              color: theme.colors.text.tertiary,
              fontVariant: ['tabular-nums'],
            }}
          >{narrow || shownReason ? '' : `· ${range}`}</Text>
        </View>
      )}
      <View style={styles.grow} />
      {shownReason ? (
        <Text
          variant="micro"
          numberOfLines={1}
          style={[styles.reason, { color: theme.colors.text.secondary }]}
        >
          {shownReason}
        </Text>
      ) : null}
      {!phone && (keep || discard) ? (
        <View
          style={[styles.actions, showActions ? null : styles.actionsQuiet]}
          pointerEvents={showActions ? 'auto' : 'box-none'}
        >
          {discard && !kept ? (
            <RoundButton
              testID={`diff-hunk-discard-${hunk.index}`}
              size="mini"
              display="inverted"
              title={t('hunkReview.discard')}
              // An unavailable Discard does not advertise a key that does nothing; its reason sits beside it.
              trailing={narrow || discardReason !== null ? undefined :
                <ShortcutHint
                  commandId="review.change.discard"
                  color={theme.colors.text.tertiary}
                />
              }
              disabled={busy || discardReason !== null}
              accessibilityLabel={t('hunkReview.discardA11y', {
                n,
                total,
                range,
              })}
              accessibilityHint={discardReason ?? undefined}
              onPress={() => discard(hunk)}
            />
          ) : null}
          {keep ? (
            <RoundButton
              testID={`diff-hunk-keep-${hunk.index}`}
              size="mini"
              display={kept ? 'inverted' : 'secondary'}
              title={keepWords.title}
              trailing={narrow ? undefined :
                <ShortcutHint
                  commandId="review.change.keep"
                  color={theme.colors.text.tertiary}
                />
              }
              disabled={busy || keepReason !== null}
              accessibilityLabel={keepWords.accessibilityLabel({ n, total, range })}
              accessibilityHint={keepReason ?? undefined}
              onPress={() => keep(hunk)}
            />
          ) : null}
        </View>
      ) : null}
    </HoverView>
  );
  if (!hasMenu) return row;
  return (
    <>
      <TactilePressable
        testID={`diff-hunk-row-press-${hunk.index}`}
        accessibilityLabel={t('hunkReview.change', { n }) + ' · ' + range}
        onLongPress={openMenu}
        static
        containerStyle={styles.pressFill}
      >
        {row}
      </TactilePressable>
      <HunkContextMenu hunk={hunk} review={review} anchorRef={rowRef} open={menuOpen} onOpenChange={setMenuOpen} />
    </>
  );
});

/** Module-scope renderer handed to `useDiffHunkSlots`, so the slot identity stays stable. */
export function renderDiffHunkRow(
  hunk: DiffHunkInfo,
  review: DiffViewerHunks,
): React.ReactNode {
  if (!review.actions?.keep && !review.actions?.discard && !review.stateOf)
    return null;
  return <DiffHunkRow key={hunk.key} hunk={hunk} review={review} />;
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingLeft: ROW_TEXT_INSET,
    paddingRight: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  rowCurrent: {
    backgroundColor: theme.colors.surface.selected,
  },
  // A web <button> shrinks to its content inside Pierre's block slot; the row spans its column.
  pressFill: {
    alignSelf: 'stretch',
    width: '100%',
  },
  rowBusy: {
    opacity: 0.6,
  },
  // The change's name never gives way to the reason: in a narrow column the reason ellipsizes first.
  label: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    flexShrink: 1,
    minWidth: 0,
  },
  labelNarrow: {
    flexShrink: 0,
  },
  grow: {
    flex: 1,
  },
  reason: {
    flexShrink: 1,
    minWidth: 0,
  },
  actions: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  actionsQuiet: {
    opacity: 0,
  },
}));
