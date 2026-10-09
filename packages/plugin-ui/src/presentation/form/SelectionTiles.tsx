import { useMemo, useRef, useState, type ReactNode } from 'react';
import { I18nManager, Platform, Pressable, StyleSheet, View, useWindowDimensions, type ViewStyle } from 'react-native';

import type { HappierPageTextStep } from '../layout/pageText.js';

import { useOptionalHappierUiLocalization } from '../../environment/context.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../interaction/pressFeedback.js';
import { resolveHappierTabKeySelection } from '../navigation/Tabs.js';
import { HAPPIER_FIELD_BOX_METRICS } from './FieldBox.js';

/**
 * The one tile owner for Happier core and plugin surfaces: text choice tiles
 * (`card`), visual pickers whose tiles are the option's preview (`visual`) and
 * tiles that each start an operation (`action`).
 *
 * This module owns everything that decides how a tile group behaves and is laid
 * out: single / multiple selection, radio and checkbox semantics, the roving
 * keyboard (the same rule as the segmented control, through
 * {@link resolveHappierTabKeySelection}), the disabled rule, the press dip, the
 * card column algorithm, the visual tile sizing and the selection ring.
 *
 * **Colours, typography and glyphs stay with their owners.** An adapter passes
 * resolved {@link HappierSelectionTilesColors}, renders each text slot through
 * {@link HappierSelectionTilesTextRenderer} (Happier core with its Unistyles
 * `Text`, which keeps the in-app font scale; a plugin with the shared text
 * owner) and draws each glyph through {@link HappierSelectionTilesGlyphRenderer}
 * from its own icon pack. Nothing here imports either side.
 */

export type HappierSelectionTileOption<T extends string, I extends string = string> = Readonly<{
  id: T;
  title: string;
  subtitle?: string;
  icon?: I;
  /** Bare identity art in the icon slot; no synthetic glyph vocabulary. */
  mark?: ReactNode;
  disabled?: boolean;
  badge?: string;
  /**
   * A small rendering of what this option looks like (visual tiles or compact card rows). Pass the real component at
   * static props — not a drawn replica — so the preview cannot drift from the product.
   */
  preview?: ReactNode;
  /** Overrides the `testIdPrefix:id` test id of this tile. */
  testID?: string;
}>;

/** The resolved colours of a tile group. */
export type HappierSelectionTilesColors = Readonly<{
  /** The ground of a text (card) tile. */
  tileBackground: string;
  /** An unselected card tile, a preview frame, a badge and an action tile outline. */
  tileBorder: string;
  /** The chosen card tile's outline and glyph. */
  selection: string;
  /** An unselected card glyph and an action tile's icon. */
  glyph: string;
  /** The ring around the chosen visual tile. */
  ring: string;
  /** The ground behind a visual preview. */
  previewBackground: string;
  /** An action tile's paper and its hovered outline. */
  actionBackground: string;
  actionBorderHovered: string;
}>;

export type HappierSelectionTileTextRole =
  | 'cardTitle'
  | 'cardSubtitle'
  | 'badge'
  | 'visualLabel'
  | 'visualSublabel'
  | 'actionTitle'
  | 'actionSubtitle';

const tileIos = Platform.OS === 'ios';

/**
 * The tiles' type scale, one owner for Happier core's tiles and the public
 * plugin tiles (each adds its own face per weight). `selectedWeight` is the
 * visual label of the chosen tile; `compactFontSize` a compact card group.
 */
export const HAPPIER_SELECTION_TILE_TEXT: Readonly<Record<HappierSelectionTileTextRole, HappierPageTextStep & Readonly<{
  selectedWeight?: HappierPageTextStep['weight'];
  compactFontSize?: number;
}>>> = Object.freeze({
  cardTitle: { weight: 'regular', fontSize: tileIos ? 17 : 16, lineHeight: tileIos ? 22 : 24, compactFontSize: tileIos ? 14 : 13 },
  cardSubtitle: { weight: 'regular', fontSize: tileIos ? 15 : 14, lineHeight: 20, compactFontSize: tileIos ? 13 : 12 },
  badge: { weight: 'regular', fontSize: 12, lineHeight: 16 },
  visualLabel: { weight: 'regular', selectedWeight: 'medium', fontSize: 12.5, lineHeight: 16 },
  visualSublabel: { weight: 'regular', fontSize: 11, lineHeight: 14 },
  actionTitle: { weight: 'medium', fontSize: 13.5, lineHeight: 18 },
  actionSubtitle: { weight: 'regular', fontSize: 12.5, lineHeight: 17 },
});

export type HappierSelectionTilesTextRenderer = (input: Readonly<{
  role: HappierSelectionTileTextRole;
  text: string;
  /** The tile holds the current choice. */
  selected: boolean;
  /** The card group is `density="compact"`. */
  compact: boolean;
  numberOfLines: number;
  /** Detailed visual captions align together; short standalone choice captions stay centered. */
  alignment?: 'left' | 'center';
}>) => ReactNode;

/**
 * A tile glyph: the option's own icon, or the check that marks a chosen card
 * tile without one. The unchosen mark (an empty ring) is drawn here, so it is
 * the same on every side; only the check comes from the adapter's icon pack.
 */
export type HappierSelectionTileGlyph<I extends string> =
  | Readonly<{ kind: 'icon'; name: I }>
  | Readonly<{ kind: 'check' }>;

export type HappierSelectionTilesGlyphRenderer<I extends string> = (input: Readonly<{
  glyph: HappierSelectionTileGlyph<I>;
  size: number;
  color: string;
}>) => ReactNode;

export type HappierSelectionTileFooterRenderer<T extends string, I extends string = string> = (params: Readonly<{
  option: HappierSelectionTileOption<T, I>;
  selected: boolean;
  disabled: boolean;
}>) => ReactNode;

type HappierSelectionTilesRendering<I extends string> = Readonly<{
  colors: HappierSelectionTilesColors;
  renderText: HappierSelectionTilesTextRenderer;
  renderGlyph: HappierSelectionTilesGlyphRenderer<I>;
}>;

type HappierChoiceTilesBaseProps<T extends string, I extends string> = HappierSelectionTilesRendering<I> & Readonly<{
  options: readonly HappierSelectionTileOption<T, I>[];
  /**
   * `card` (default): text tiles with an icon, title and subtitle. `visual`: a picker for options that
   * change what you see — each tile is the option's preview with its label underneath.
   */
  variant?: 'card' | 'visual';
  /**
   * Visual variant only. `natural` (default) keeps each tile at its natural size, left-aligned under
   * the row label. `fill` shares the full width equally, for a picker that is the section's main
   * decision (theme mode).
   */
  tileSizing?: 'natural' | 'fill';
  /** The group's accessible name (the setting it chooses). */
  accessibilityLabel?: string;
  testIdPrefix?: string;
  density?: 'regular' | 'compact';
  minimumColumns?: number;
  maximumColumns?: number;
  /**
   * Card variant: the narrowest a tile may be before the grid drops a column (a choice inside a
   * narrow panel reads as one per line rather than squeezed pairs). Absent, the width breakpoints
   * alone decide.
   */
  minimumTileWidth?: number;
  /**
   * Card variant: how many lines a description may take before it ellipsizes (default 4). The tile
   * is always announced with its whole description.
   */
  subtitleLines?: number;
  renderOptionFooter?: HappierSelectionTileFooterRenderer<T, I>;
}>;

export type HappierSingleSelectionTilesProps<T extends string, I extends string = string> =
  HappierChoiceTilesBaseProps<T, I> & Readonly<{
    selectionMode?: 'single';
    value: T | null;
    onChange: (next: T | null) => void;
  }>;

export type HappierMultipleSelectionTilesProps<T extends string, I extends string = string> =
  HappierChoiceTilesBaseProps<T, I> & Readonly<{
    selectionMode: 'multiple';
    value: readonly T[];
    onChange: (next: T[]) => void;
  }>;

type HappierChoiceSelectionTilesProps<T extends string, I extends string> =
  | HappierSingleSelectionTilesProps<T, I>
  | HappierMultipleSelectionTilesProps<T, I>;

/**
 * `action`: tiles that each start an operation (add a device, open a flow). They are buttons, not a
 * choice: no value, no selected state. Each tile shows its icon, title and a one-line description.
 */
export type HappierActionSelectionTilesProps<T extends string, I extends string = string> =
  HappierSelectionTilesRendering<I> & Readonly<{
    variant: 'action';
    options: readonly HappierSelectionTileOption<T, I>[];
    onPress: (id: T) => void;
    /** Action tiles hold no choice; declared so `selectionMode` keeps discriminating the choice variants. */
    selectionMode?: undefined;
    value?: undefined;
    onChange?: undefined;
    /** The group's accessible name. */
    accessibilityLabel?: string;
    testIdPrefix?: string;
    /**
     * A tile whose operation depends on its own state (a provisioner that is ready, needs setup or
     * needs an account) carries that state and its operation in a footer instead of being one
     * button: the tile becomes a named group, the footer owns the controls, and `onPress` is unused
     * for it. Its badge names the option's kind beside the title.
     */
    renderOptionFooter?: HappierSelectionTileFooterRenderer<T, I>;
  }>;

export type HappierSelectionTilesProps<T extends string, I extends string = string> =
  | HappierChoiceSelectionTilesProps<T, I>
  | HappierActionSelectionTilesProps<T, I>;

function isSelected<T extends string, I extends string>(props: HappierChoiceSelectionTilesProps<T, I>, id: T): boolean {
  if (props.selectionMode === 'multiple') {
    return props.value.includes(id);
  }
  return props.value === id;
}

function handleToggle<T extends string, I extends string>(props: HappierChoiceSelectionTilesProps<T, I>, id: T) {
  if (props.selectionMode === 'multiple') {
    const next = props.value.includes(id)
      ? props.value.filter((value) => value !== id)
      : [...props.value, id];
    props.onChange(next);
    return;
  }

  props.onChange(id);
}

function pressOpacity(disabled: boolean, pressed: boolean): number {
  return disabled ? 0.5 : (pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle : 1);
}

type TileFocusHandle = { focus?: () => void } | null;

/**
 * Keyboard for a choice group on web. A single-choice group is one radio group: one tab stop (the
 * selected tile, else the first enabled one), the arrow keys move the selection (skipping disabled
 * tiles, the same roving rule as the segmented control), Home/End jump, and Space selects. A
 * multiple-choice group keeps every checkbox tile in the tab order and Space toggles it. Enter is
 * handled by the pressable itself.
 */
function useChoiceTilesKeyboard<T extends string, I extends string>(props: HappierChoiceSelectionTilesProps<T, I>) {
  const tileRefs = useRef(new Map<T, TileFocusHandle>());
  const localization = useOptionalHappierUiLocalization();
  const rtl = localization ? localization.direction === 'rtl' : I18nManager.isRTL;
  const single = props.selectionMode !== 'multiple';
  const selectedEnabledIndex = single
    ? props.options.findIndex((option) => option.disabled !== true && option.id === props.value)
    : -1;
  const focusableIndex = selectedEnabledIndex >= 0
    ? selectedEnabledIndex
    : props.options.findIndex((option) => option.disabled !== true);

  return (index: number): Record<string, unknown> | null => {
    if (Platform.OS !== 'web') return null;
    const option = props.options[index];
    if (!option) return null;
    return {
      ref: (node: TileFocusHandle) => {
        if (node) tileRefs.current.set(option.id, node);
        else tileRefs.current.delete(option.id);
      },
      tabIndex: single ? (index === focusableIndex ? 0 : -1) : undefined,
      onKeyDown: (event: { key?: string; nativeEvent?: { key?: string }; preventDefault?: () => void }) => {
        if (option.disabled === true) return;
        const key = event?.nativeEvent?.key ?? event?.key ?? '';
        if (key === ' ' || key === 'Spacebar') {
          event.preventDefault?.();
          handleToggle(props, option.id);
          return;
        }
        if (!single) return;
        const vertical = key === 'ArrowDown' || key === 'ArrowUp';
        const rovingKey = key === 'ArrowDown' ? 'ArrowRight' : key === 'ArrowUp' ? 'ArrowLeft' : key;
        if (rovingKey !== 'ArrowRight' && rovingKey !== 'ArrowLeft' && rovingKey !== 'Home' && rovingKey !== 'End') return;
        const nextIndex = resolveHappierTabKeySelection({
          tabs: props.options,
          currentIndex: index,
          key: rovingKey,
          rtl: vertical ? false : rtl,
        });
        const next = nextIndex === null ? null : props.options[nextIndex];
        if (!next) return;
        event.preventDefault?.();
        handleToggle(props, next.id);
        tileRefs.current.get(next.id)?.focus?.();
      },
    };
  };
}

/** A single-choice group is one radio group; a multiple-choice group is a set of checkboxes. */
function choiceGroupSemantics(props: Readonly<{ selectionMode?: 'single' | 'multiple'; accessibilityLabel?: string }>) {
  const radioGroup = props.selectionMode !== 'multiple';
  return {
    accessibilityRole: Platform.OS === 'web' ? undefined : (radioGroup ? 'radiogroup' as const : undefined),
    role: Platform.OS === 'web' && radioGroup ? 'radiogroup' as const : undefined,
    accessibilityLabel: props.accessibilityLabel,
    'aria-label': Platform.OS === 'web' ? props.accessibilityLabel : undefined,
  };
}

function useTileStyles(colors: HappierSelectionTilesColors) {
  return useMemo(() => createTileStyles(colors), [colors]);
}

function VisualSelectionTiles<T extends string, I extends string>(props: HappierChoiceSelectionTilesProps<T, I>) {
  const styles = useTileStyles(props.colors);
  const tileKeyboardProps = useChoiceTilesKeyboard(props);
  const selectionAccessibilityRole = props.selectionMode === 'multiple' ? 'checkbox' : 'radio';
  const fill = props.tileSizing === 'fill';
  const columns = Math.min(props.options.length, Math.max(1, props.maximumColumns ?? props.options.length));
  // A row cannot fit columns + 1 percentage bases plus the positive shared gap. Flex growth then
  // distributes the remaining row width equally, keeping the same grid on web and native.
  const columnBasis: ViewStyle | undefined = fill && columns < props.options.length
    ? { flexBasis: `${100 / (columns + 1)}%`, flexShrink: 0 }
    : undefined;
  return (
    <View style={styles.visualGrid} {...choiceGroupSemantics(props)}>
      {props.options.map((option, index) => {
        const selected = isSelected(props, option.id);
        const disabled = option.disabled === true;
        const alignment = option.subtitle || option.badge ? 'left' : 'center';
        const label = props.renderText({ role: 'visualLabel', text: option.title, selected, compact: false, numberOfLines: 2, alignment });
        return (
          <Pressable
            key={option.id}
            {...tileKeyboardProps(index)}
            testID={option.testID ?? (props.testIdPrefix ? `${props.testIdPrefix}:${option.id}` : undefined)}
            accessibilityRole={selectionAccessibilityRole}
            accessibilityLabel={option.title}
            accessibilityState={props.selectionMode === 'multiple'
              ? { checked: selected, disabled }
              : { checked: selected, selected, disabled }}
            // React Native Web drops `accessibilityState`; the ARIA alias carries the
            // radio/checkbox state to the browser.
            aria-checked={selected}
            disabled={disabled}
            onPress={() => {
              if (disabled) return;
              handleToggle(props, option.id);
            }}
            style={({ pressed }) => [
              styles.visualTile,
              fill ? styles.visualTileFill : null,
              columnBasis,
              { opacity: pressOpacity(disabled, pressed) },
            ]}
          >
            {/* The ring sits on an outer frame with a gap so it reads as a selection, not a border. */}
            <View style={[styles.visualRing, selected ? styles.visualRingSelected : null]}>
              <View style={[styles.visualPreview, fill ? styles.visualPreviewFill : null]} pointerEvents="none">
                {option.preview ?? null}
              </View>
            </View>
            {option.badge ? (
              <View style={styles.visualLabelRow}>
                {label}
                <View style={styles.badge}>
                  {props.renderText({ role: 'badge', text: option.badge, selected, compact: false, numberOfLines: 1 })}
                </View>
              </View>
            ) : label}
            {option.subtitle
              ? props.renderText({ role: 'visualSublabel', text: option.subtitle, selected, compact: false, numberOfLines: 2, alignment })
              : null}
          </Pressable>
        );
      })}
    </View>
  );
}

export function HappierSelectionTiles<T extends string, I extends string = string>(props: HappierSelectionTilesProps<T, I>) {
  if (props.variant === 'action') {
    return <ActionSelectionTiles {...props} />;
  }
  if (props.variant === 'visual') {
    return <VisualSelectionTiles {...props} />;
  }
  return <CardSelectionTiles {...props} />;
}

function ActionSelectionTiles<T extends string, I extends string>(props: HappierActionSelectionTilesProps<T, I>) {
  const styles = useTileStyles(props.colors);
  return (
    <View
      style={styles.actionGrid}
      accessibilityLabel={props.accessibilityLabel}
      aria-label={Platform.OS === 'web' ? props.accessibilityLabel : undefined}
    >
      {props.options.map((option) => {
        const disabled = option.disabled === true;
        const footer = props.renderOptionFooter?.({ option, selected: false, disabled });
        if (footer != null && footer !== false) {
          return (
            <View
              key={option.id}
              testID={option.testID ?? (props.testIdPrefix ? `${props.testIdPrefix}:${option.id}` : undefined)}
              role="group"
              accessibilityLabel={option.title}
              aria-label={Platform.OS === 'web' ? option.title : undefined}
              style={[styles.actionTile, styles.actionTileWithFooter]}
            >
              <View style={styles.actionHead}>
                {option.mark ?? (option.icon
                  ? props.renderGlyph({ glyph: { kind: 'icon', name: option.icon }, size: 20, color: props.colors.glyph })
                  : null)}
                <View style={styles.actionHeadTitle}>
                  {props.renderText({ role: 'actionTitle', text: option.title, selected: false, compact: false, numberOfLines: 1 })}
                </View>
                {option.badge
                  ? props.renderText({ role: 'badge', text: option.badge, selected: false, compact: false, numberOfLines: 1 })
                  : null}
              </View>
              {option.subtitle
                ? props.renderText({ role: 'actionSubtitle', text: option.subtitle, selected: false, compact: false, numberOfLines: 3 })
                : null}
              <View style={styles.actionFooter}>{footer}</View>
            </View>
          );
        }
        return (
          <Pressable
            key={option.id}
            testID={option.testID ?? (props.testIdPrefix ? `${props.testIdPrefix}:${option.id}` : undefined)}
            accessibilityRole="button"
            accessibilityLabel={option.subtitle ? `${option.title}, ${option.subtitle}` : option.title}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => {
              if (disabled) return;
              props.onPress(option.id);
            }}
            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
              styles.actionTile,
              hovered && !disabled ? styles.actionTileHovered : null,
              { opacity: pressOpacity(disabled, pressed) },
            ]}
          >
            {option.mark ?? (option.icon
              ? props.renderGlyph({ glyph: { kind: 'icon', name: option.icon }, size: 20, color: props.colors.glyph })
              : null)}
            <View style={styles.actionText}>
              {props.renderText({ role: 'actionTitle', text: option.title, selected: false, compact: false, numberOfLines: 2 })}
              {option.subtitle
                ? props.renderText({ role: 'actionSubtitle', text: option.subtitle, selected: false, compact: false, numberOfLines: 2 })
                : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const CARD_GAP_PX = 10;
const FILL_TILE_FRAME: ViewStyle = { width: '100%' };

/** The unchosen mark of a card tile without its own icon: an empty ring the size of the check it becomes. */
function SelectionRing(props: Readonly<{ size: number; color: string }>) {
  const diameter = Math.round(props.size * (20 / 24));
  return (
    <View
      aria-hidden
      style={{ width: diameter, height: diameter, borderRadius: diameter / 2, borderWidth: 2, borderColor: props.color }}
    />
  );
}

function CardSelectionTiles<T extends string, I extends string>(props: HappierChoiceSelectionTilesProps<T, I>) {
  const styles = useTileStyles(props.colors);
  const [width, setWidth] = useState<number>(0);
  const { width: windowWidth } = useWindowDimensions();
  const webViewportWidth =
    Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.innerWidth === 'number'
      ? window.innerWidth
      : null;
  const fallbackViewportWidth = webViewportWidth ?? windowWidth;
  const selectionAccessibilityRole = props.selectionMode === 'multiple' ? 'checkbox' : 'radio';
  const tileKeyboardProps = useChoiceTilesKeyboard(props);
  const gap = CARD_GAP_PX;
  const density = props.density ?? 'regular';
  const compact = density === 'compact';
  const minimumColumns = useMemo(
    () => Math.max(1, Math.min(props.minimumColumns ?? 1, Math.max(1, props.options.length))),
    [props.minimumColumns, props.options.length],
  );

  const columns = useMemo(() => {
    const ensureMinimumColumns = (computed: number, availableWidth: number): number => {
      if (minimumColumns <= 1) {
        return computed;
      }
      const enforcedColumns = Math.min(minimumColumns, props.options.length);
      const minimumTileWidth = compact ? 108 : 144;
      const minimumRequiredWidth =
        enforcedColumns * minimumTileWidth + gap * Math.max(0, enforcedColumns - 1);
      if (availableWidth < minimumRequiredWidth) {
        return computed;
      }
      return Math.max(computed, enforcedColumns);
    };

    if (width <= 0) {
      if (fallbackViewportWidth >= 1100) {
        const computed = props.options.length === 3
          ? Math.min(3, props.options.length)
          : Math.min(2, props.options.length);
        return ensureMinimumColumns(computed, fallbackViewportWidth);
      }
      if (fallbackViewportWidth >= 720) {
        return ensureMinimumColumns(Math.min(2, props.options.length), fallbackViewportWidth);
      }
      return 1;
    }
    if (props.options.length === 3) {
      if (width >= 520) return ensureMinimumColumns(3, width);
      return width >= 260 ? ensureMinimumColumns(2, width) : 1;
    }
    if (width >= 520) return ensureMinimumColumns(Math.min(3, props.options.length), width);
    if (width >= 260) return ensureMinimumColumns(Math.min(2, props.options.length), width);
    return ensureMinimumColumns(1, width);
  }, [compact, fallbackViewportWidth, gap, minimumColumns, props.options.length, width]);

  const minimumTileWidth = props.minimumTileWidth;
  const fittedColumns = useMemo(() => {
    let next = Math.min(columns, Math.max(1, props.maximumColumns ?? columns));
    if (!minimumTileWidth || width <= 0) return next;
    while (next > 1 && (width - gap * (next - 1)) / next < minimumTileWidth) next -= 1;
    return next;
  }, [columns, gap, minimumTileWidth, props.maximumColumns, width]);
  const tileWidth = useMemo(() => {
    if (width <= 0) return undefined;
    const totalGap = gap * (fittedColumns - 1);
    return Math.floor((width - totalGap) / fittedColumns);
  }, [fittedColumns, gap, width]);
  const fallbackTileWidthStyle = useMemo((): ViewStyle | null => {
    if (width > 0) return null;
    if (fittedColumns <= 1) return { width: '100%' };
    if (fittedColumns === 2) return { width: '48%', maxWidth: '48%', flexGrow: 0, flexShrink: 0 };
    return { width: '31%', maxWidth: '31%', flexGrow: 0, flexShrink: 0 };
  }, [fittedColumns, width]);

  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[
        styles.grid,
        { flexDirection: 'row', flexWrap: 'wrap', gap },
      ]}
      {...choiceGroupSemantics(props)}
    >
      {props.options.map((option, index) => {
        const selected = isSelected(props, option.id);
        const disabled = option.disabled === true;
        const glyph: HappierSelectionTileGlyph<I> | null = option.icon
          ? { kind: 'icon', name: option.icon }
          : null;
        const borderColor = selected ? props.colors.selection : props.colors.tileBorder;
        const glyphColor = props.colors.glyph;
        const glyphSize = compact ? 16 : 29;
        const hasSubtitle = typeof option.subtitle === 'string' && option.subtitle.trim().length > 0;
        const hasPreview = compact && option.preview != null;
        const footer = props.renderOptionFooter?.({ option, selected, disabled });

        return (
          <View
            key={option.id}
            style={[
              styles.tile,
              compact ? styles.tileFrameCompact : null,
              tileWidth ? { width: tileWidth } : fallbackTileWidthStyle,
              { borderColor },
            ]}
          >
            <Pressable
              {...tileKeyboardProps(index)}
              testID={option.testID ?? (props.testIdPrefix ? `${props.testIdPrefix}:${option.id}` : undefined)}
              accessibilityRole={selectionAccessibilityRole}
              accessibilityLabel={hasSubtitle ? `${option.title}, ${option.subtitle}` : option.title}
              accessibilityState={props.selectionMode === 'multiple'
                ? { checked: selected, disabled }
                : { checked: selected, selected, disabled }}
              aria-checked={selected}
              disabled={disabled}
              onPress={() => {
                if (disabled) {
                  return;
                }
                handleToggle(props, option.id);
              }}
              style={({ pressed }) => [
                styles.tilePressable,
                compact ? styles.tileCompact : null,
                compact && !hasSubtitle ? styles.tileCompactWithoutSubtitle : null,
                // The frame above owns the column's share before measurement; the press target fills it
                // (a second percentage here would take a share of the share).
                tileWidth ? { width: tileWidth } : FILL_TILE_FRAME,
                { opacity: pressOpacity(disabled, pressed) },
              ]}
            >
              <View style={[styles.headerRow, compact && (!hasSubtitle || hasPreview) ? styles.headerRowCentered : null]}>
                {hasPreview ? <View style={styles.cardPreview} pointerEvents="none" aria-hidden>{option.preview}</View> : null}
                <View style={[styles.titleRow, compact && (!hasSubtitle || hasPreview) ? styles.titleRowCentered : null]}>
                  {option.mark || glyph ? <View style={[styles.iconSlot, compact ? styles.iconSlotCompact : null]}>
                    {option.mark ?? (glyph ? props.renderGlyph({ glyph, size: glyphSize, color: glyphColor }) : null)}
                  </View> : null}
                  <View style={[styles.textContainer, compact && !hasSubtitle ? styles.textContainerCentered : null]}>
                    {props.renderText({ role: 'cardTitle', text: option.title, selected, compact, numberOfLines: 2 })}
                    {option.subtitle
                      ? props.renderText({ role: 'cardSubtitle', text: option.subtitle, selected, compact, numberOfLines: props.subtitleLines ?? 4 })
                      : null}
                    {option.badge ? (
                      <View style={styles.badge}>
                        {props.renderText({ role: 'badge', text: option.badge, selected, compact, numberOfLines: 1 })}
                      </View>
                    ) : null}
                  </View>
                </View>
                <View style={styles.selectionAccessory} pointerEvents="none" aria-hidden>
                  {selected
                    ? props.renderGlyph({ glyph: { kind: 'check' }, size: 16, color: props.colors.selection })
                    : <SelectionRing size={16} color={props.colors.glyph} />}
                </View>
              </View>
            </Pressable>
            {footer != null && footer !== false ? (
              <View style={[styles.footer, compact ? styles.footerCompact : null]}>
                {footer}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const VISUAL_TILE_WIDTH_PX = 112;
const VISUAL_TILE_MIN_WIDTH_PX = 84;
const VISUAL_PREVIEW_HEIGHT_PX = 70;
const VISUAL_PREVIEW_RADIUS_PX = 10;
const VISUAL_RING_GAP_PX = 2;
/** A filling tile keeps the proportions of a small app window rather than a fixed height. */
const VISUAL_FILL_PREVIEW_ASPECT_RATIO = 2.2;

const ACTION_TILE_MIN_WIDTH_PX = 180;

/** Card icon slot: the list row's icon box, so a tile glyph lines up with a row glyph. */
const CARD_ICON_BOX_PX = {
  comfortable: 32,
  compact: Platform.OS === 'ios' ? 18 : 20,
} as const;

function createTileStyles(colors: HappierSelectionTilesColors) {
  return StyleSheet.create({
    // Tiles share the row equally; below two minimum widths they wrap to one per line (phones).
    actionGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
    },
    actionTile: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: ACTION_TILE_MIN_WIDTH_PX,
      minWidth: 0,
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 13,
      borderRadius: 12,
      // The same paper as a page sheet, so a tile reads as a small sheet of its own.
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.tileBorder,
      backgroundColor: colors.actionBackground,
    },
    actionTileHovered: {
      borderColor: colors.actionBorderHovered,
    },
    actionText: {
      gap: 2,
    },
    actionTileWithFooter: {
      gap: 6,
    },
    actionHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    actionHeadTitle: {
      flex: 1,
      minWidth: 0,
    },
    // The footer sits on the tile's floor, so a row of tiles keeps its status lines aligned.
    actionFooter: {
      marginTop: 'auto',
      paddingTop: 6,
    },
    visualGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
    },
    // Tiles share the row up to their natural width, so three always fit a phone row and a desktop
    // row keeps them at their natural size instead of stretching them across the sheet.
    visualTile: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: VISUAL_TILE_MIN_WIDTH_PX,
      maxWidth: VISUAL_TILE_WIDTH_PX,
      alignItems: 'stretch',
      gap: 7,
    },
    visualTileFill: {
      flexBasis: 0,
      minWidth: 0,
      maxWidth: '100%',
    },
    visualLabelRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 6,
    },
    visualRing: {
      // Concentric: ring radius = preview radius + gap + ring width.
      borderRadius: VISUAL_PREVIEW_RADIUS_PX + VISUAL_RING_GAP_PX + 1.5,
      borderWidth: 1.5,
      borderColor: 'transparent',
      padding: VISUAL_RING_GAP_PX,
    },
    visualRingSelected: {
      borderColor: colors.ring,
    },
    visualPreview: {
      height: VISUAL_PREVIEW_HEIGHT_PX,
      borderRadius: VISUAL_PREVIEW_RADIUS_PX,
      overflow: 'hidden',
      backgroundColor: colors.previewBackground,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.tileBorder,
    },
    visualPreviewFill: {
      height: 'auto',
      minHeight: VISUAL_PREVIEW_HEIGHT_PX,
      aspectRatio: VISUAL_FILL_PREVIEW_ASPECT_RATIO,
    },
    cardPreview: {
      width: VISUAL_TILE_WIDTH_PX,
      height: VISUAL_PREVIEW_HEIGHT_PX,
      flexShrink: 0,
      borderRadius: VISUAL_PREVIEW_RADIUS_PX,
      overflow: 'hidden',
      backgroundColor: colors.previewBackground,
    },
    grid: {
      width: '100%',
      alignSelf: 'stretch',
    },
    tile: {
      backgroundColor: colors.tileBackground,
      borderRadius: 12,
      borderWidth: 1,
      overflow: 'hidden',
    },
    // Compact cards share the field box's shape (radius, one-pixel outline), so a dense grid reads
    // like the controls around it; the chosen tile keeps the selection colour on that outline.
    tileFrameCompact: {
      borderRadius: HAPPIER_FIELD_BOX_METRICS.radiusPx,
      borderWidth: HAPPIER_FIELD_BOX_METRICS.borderWidthPx,
    },
    tilePressable: {
      paddingHorizontal: 12,
      paddingVertical: 14,
      minHeight: 92,
    },
    tileCompact: {
      paddingHorizontal: 10,
      paddingVertical: 8,
      minHeight: 48,
    },
    // A one-line compact card is a bordered choice in a dense grid (a popover's scope tiles): the
    // field box's height on pointer platforms, the touch target elsewhere, its title centred.
    tileCompactWithoutSubtitle: {
      minHeight: Platform.OS === 'web' ? HAPPIER_FIELD_BOX_METRICS.minHeightPx : 44,
      paddingTop: 6,
      paddingBottom: 6,
      justifyContent: 'center',
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 12,
    },
    selectionAccessory: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    headerRowCentered: {
      alignItems: 'center',
    },
    // The footer continues the tile's text column (inside its padding, under the title), never
    // flush against the outline.
    footer: {
      marginTop: -4,
      paddingLeft: 12 + CARD_ICON_BOX_PX.comfortable + 10,
      paddingRight: 12,
      paddingBottom: 14,
      gap: 8,
    },
    footerCompact: {
      marginTop: -2,
      paddingLeft: 10 + CARD_ICON_BOX_PX.compact + 10,
      paddingRight: 10,
      paddingBottom: 8,
      gap: 6,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      flex: 1,
      gap: 10,
    },
    titleRowCentered: {
      alignItems: 'center',
    },
    iconSlot: {
      width: CARD_ICON_BOX_PX.comfortable,
      height: CARD_ICON_BOX_PX.comfortable,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1,
    },
    iconSlotCompact: {
      width: CARD_ICON_BOX_PX.compact,
      height: CARD_ICON_BOX_PX.compact,
      marginTop: 0,
    },
    textContainer: {
      flex: 1,
      gap: 0,
    },
    textContainerCentered: {
      justifyContent: 'center',
    },
    badge: {
      alignSelf: 'flex-start',
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.tileBorder,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
  });
}
