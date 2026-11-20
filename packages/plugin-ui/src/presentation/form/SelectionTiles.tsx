import { useCallback, useMemo, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { I18nManager, Platform, Pressable, StyleSheet, View, useWindowDimensions, type ViewStyle } from 'react-native';

import { resolveHappierTypeScale, type HappierTypeEmphasis, type HappierTypeRole } from '../text/typeScale.js';

import { useOptionalHappierUiLocalization, useOptionalHappierUiPalette } from '../../environment/context.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierItemGroup } from '../collection/ItemGroup.js';
import { HappierListItem } from '../collection/List.js';
import { HappierChevron } from '../collection/DisclosureChevron.js';
import { HappierPageSheet, useHappierPageSection, type HappierPageSheetProps } from '../layout/PageSection.js';
import type { HappierPageRowMetrics } from '../layout/pageRowMetrics.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../interaction/pressFeedback.js';
import { HAPPIER_MOTION_V1 } from '../interaction/motion.js';
import { useHappierHitArea } from '../interaction/hitArea.js';
import type { HappierHitReach } from '../../environment/interactiveTarget.js';
import { HAPPIER_PAGE_METRICS, isHappierPageRowNarrow } from '../layout/pageMetrics.js';
import { resolveHappierTabKeySelection } from '../navigation/Tabs.js';
import { HAPPIER_FIELD_BOX_METRICS } from './FieldBox.js';
import { HAPPIER_RADIO_MARK_METRICS, resolveHappierRadioMarkStyle } from './RadioMark.js';
import { HappierMaterialSurface, useContainingHappierMaterialRole, useHappierMaterialColorResolver, type HappierMaterialSurfaceRender } from '../layout/Surface.js';
import { splitForWebMiddleEllipsis, HAPPIER_MIDDLE_ELLIPSIS_STYLE } from '../text/middleEllipsis.js';
import { usePageWindow } from '../collection/pageCollectionVirtualizer.js';
import { useOptionalPluginUiScrollActivityTracker, type PluginUiScrollActivityTracker } from '../../presentationHost/scrollActivity.js';

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
   * Card tiles: a quiet fact about this option right now ("Showing now", "Unreachable"): one quiet line under its
   * description, never a pill beside the name; it is part of the tile's accessible name.
   */
  status?: string;
  /**
   * Card tiles: `middle` keeps the description on one line and gives up its middle (an address, a path or an id has
   * no word to wrap at, so it never breaks mid-word); the tile still announces all of it.
   */
  subtitleTruncation?: 'middle';
  /**
   * Card tiles: what this option's footer (`renderOptionFooter`) says, in words. The tile cannot read a rendered
   * footer, so its facts join the tile's accessible name only through this ("Runs on Cloudflare Pages, Free $0.00 a month").
   */
  footerLabel?: string;
  /**
   * A small rendering of what this option looks like (visual tiles or compact card rows). Pass the real component at
   * static props — not a drawn replica — so the preview cannot drift from the product.
   */
  preview?: ReactNode;
  /** Visual tiles: `dashed` draws the preview's edge dashed, for an empty slot that adds something (Your picture…). */
  previewEdge?: 'solid' | 'dashed';
  /** Overrides the `testIdPrefix:id` test id of this tile. */
  testID?: string;
  /**
   * Card tiles: `row` makes this option take the whole row (the choice a group leads with, such as a chosen or
   * recommended target); the other options keep the grid beneath it. Sheet cells ignore it.
   */
  span?: 'row';
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
  /** An action tile's paper. */
  actionBackground: string;
  /**
   * One ink step above `tileBorder`: an action or card tile's outline under a hovering pointer, and the empty ring an
   * unchosen single-choice card shows where the chosen card's filled check sits.
   */
  actionBorderHovered: string;
  /** The hairline between the cells of a `surface="sheet"` group; the tile outline colour when absent. */
  divider?: string;
}>;

export type HappierSelectionTileTextRole =
  | 'cardTitle'
  | 'cardSubtitle'
  | 'badge'
  | 'visualLabel'
  | 'visualSublabel'
  | 'actionTitle'
  | 'actionSubtitle';

/** A tile text slot as a reference into the canonical type-role table; it holds no numbers of its own. */
export type HappierSelectionTileTextStep = Readonly<{
  role: HappierTypeRole;
  /** Overrides the role's weight. */
  emphasis?: HappierTypeEmphasis;
  /** The chosen tile's emphasis (a visual tile's caption). */
  selectedEmphasis?: HappierTypeEmphasis;
  /** The role a `density="compact"` card group draws this slot with. */
  compactRole?: HappierTypeRole;
}>;

/**
 * The tiles' text slots, one owner for Happier core's tiles and the public plugin tiles. Each slot names
 * a role of `HAPPIER_TYPE_SCALE` (scale roles R1/R4), so a change to the roles reaches every picker; each
 * adapter adds its own face per weight through {@link resolveHappierSelectionTileText}.
 */
export const HAPPIER_SELECTION_TILE_TEXT: Readonly<Record<HappierSelectionTileTextRole, HappierSelectionTileTextStep>> = Object.freeze({
  cardTitle: { role: 'label', compactRole: 'body', emphasis: 'medium' },
  cardSubtitle: { role: 'body', compactRole: 'meta' },
  badge: { role: 'meta' },
  visualLabel: { role: 'meta', selectedEmphasis: 'medium' },
  visualSublabel: { role: 'micro' },
  actionTitle: { role: 'body', emphasis: 'medium' },
  actionSubtitle: { role: 'meta' },
});

/** The role and emphasis a tile text slot draws with in its current state. */
export function resolveHappierSelectionTileText(
  slot: HappierSelectionTileTextRole,
  state: Readonly<{ selected?: boolean; compact?: boolean }> = {},
): Readonly<{ role: HappierTypeRole; emphasis?: HappierTypeEmphasis }> {
  const step = HAPPIER_SELECTION_TILE_TEXT[slot];
  const emphasis = state.selected === true && step.selectedEmphasis !== undefined ? step.selectedEmphasis : step.emphasis;
  const role = state.compact === true && step.compactRole !== undefined ? step.compactRole : step.role;
  return emphasis === undefined ? { role } : { role, emphasis };
}

export type HappierSelectionTilesTextRenderer = (input: Readonly<{
  role: HappierSelectionTileTextRole;
  text: string;
  /** The tile holds the current choice. */
  selected: boolean;
  /** The card group is `density="compact"`. */
  compact: boolean;
  numberOfLines: number;
  /** One line that gives up its middle where the platform draws a middle ellipsis (native); the web draws two runs. */
  ellipsizeMode?: 'middle';
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
  /**
   * Card variant: the adapter's Elements material for a card tile's frame (a plugin host supplies its own through the
   * presentation host). Over an atmosphere it is glass; anywhere else the tile keeps its exact solid paint.
   */
  renderMaterialSurface?: HappierMaterialSurfaceRender;
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
  /**
   * Visual `fill`: the preview's width ÷ height (default a small app window, 2.2). A picture or swatch
   * picker sets its own proportions. A regular card with `descriptionPlacement="below"` uses it for the
   * preview it leads with (default 1.6), and a compact card for the preview beside its text, with `previewWidth`.
   */
  previewAspectRatio?: number;
  /**
   * Compact card variant: the width of the preview beside the text (default a small app window, 112 × 70); its height
   * follows `previewAspectRatio`. A phone option row draws its miniature this way (Themes B3P: 96 square).
   */
  previewWidth?: number;
  /**
   * Visual variant only. `hidden` drops the caption under each preview for pickers whose previews
   * speak for themselves (picture thumbnails); every tile is still announced by its title.
   */
  labels?: 'shown' | 'hidden';
  /**
   * Visual variant only: how many lines a caption may take before it ellipsizes (default 2). A grid of
   * short names keeps one line so its rows stay one height; the tile is announced by its whole title.
   */
  labelLines?: number;
  /** The group's accessible name (the setting it chooses). */
  accessibilityLabel?: string;
  testIdPrefix?: string;
  /**
   * Card variant. `check` (default) marks the chosen card with a check beside its ink outline. `outline` marks it by the
   * outline alone, as a visual tile's ring does, for cards that are pictures of their option (theme slots and options).
   */
  selectionMark?: 'check' | 'outline';
  density?: 'regular' | 'compact';
  minimumColumns?: number;
  maximumColumns?: number;
  /**
   * The narrowest a tile may be before the grid drops a column (a choice inside a narrow panel reads
   * as one per line rather than squeezed pairs). Card variant: absent, the width breakpoints alone
   * decide. Visual `fill`: the measured row keeps up to `maximumColumns` tiles of at least this width
   * (a listing's pictures in a narrow pane stay large).
   */
  minimumTileWidth?: number;
  /**
   * Card variant: how many lines a description may take before it ellipsizes (default 4). The tile
   * is always announced with its whole description.
   */
  subtitleLines?: number;
  /**
   * Card variant. `tiles` (default): each option is its own outlined tile, with a gap between them.
   * `sheet`: the options are cells of the one sheet they sit on (the caller's section sheet), divided
   * by hairlines between columns and rows, at the row inset, with no outline or gap of their own; the
   * chosen cell shows its filled radio. The same column algorithm decides how many share a row.
   */
  surface?: 'tiles' | 'sheet';
  /**
   * Card variant. `beside` (default): the description continues the title column beside the icon. `below`: only
   * the title (and its badge) sits beside the icon; the description is the card's body under that row at the card's
   * full width, and so is the footer (cards that carry a body: a target's facts, its Machine field).
   */
  descriptionPlacement?: 'beside' | 'below';
  renderOptionFooter?: HappierSelectionTileFooterRenderer<T, I>;
  /**
   * Card variant. `below` (default): the footer continues the text column under it. `trailing`: the footer stands at
   * the tile's end, centred on the row, outside the choice (a phone option row's own Try).
   */
  footerPlacement?: 'below' | 'trailing';
  /**
   * Visual variant. A tile's own quiet operations (its "…" menu), drawn over the preview's top-right corner as a
   * sibling of the choice, never inside it. `revealed` is true while the pointer is over the tile or the tile is
   * chosen; touch devices, which have no hover, see it on the chosen tile.
   */
  renderOptionAccessory?: (params: Readonly<{ option: HappierSelectionTileOption<T, I>; selected: boolean; revealed: boolean }>) => ReactNode;
  /**
   * Visual and card variants. `page`: the group scrolls with the page around it and its options scale with the person's
   * data (a theme library, an agent's theme candidates), so it draws only the lines of tiles near the page's window, by
   * the page Collection's one windowing rule. Absent, every tile is drawn. A card group windowed this way keeps every
   * option in its column (no `span`).
   */
  scroll?: 'page';
  /** Card variant: the space between tiles, by role. `regular` (default) or `tight` (phone option rows, Themes B3P). */
  tileGap?: 'regular' | 'tight';
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
    /** A core adapter supplies its list scope; plugin sections inherit the shared page-sheet scope. */
    listPresentation?: 'page' | 'grouped';
    /** Core supplies these existing theme facts when no plugin environment is mounted. */
    theme?: HappierUiTheme;
    pageColors?: HappierPageSheetProps['colors'];
    /** Core injects its in-app scale; plugin text keeps the environment's resolved scale. */
    textScale?: number;
    pageRowMetrics?: HappierPageRowMetrics;
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
  const pendingFocus = useRef<T | null>(null);
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
        if (node) {
          tileRefs.current.set(option.id, node);
          // A page-windowed choice binds only after the controlled selection draws its line.
          if (pendingFocus.current === option.id && node.focus) {
            pendingFocus.current = null;
            node.focus();
          }
        } else tileRefs.current.delete(option.id);
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
        pendingFocus.current = next.id;
        handleToggle(props, next.id);
        const target = tileRefs.current.get(next.id);
        if (target?.focus) {
          pendingFocus.current = null;
          target.focus();
        }
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
  const paintColor = useHappierMaterialColorResolver();
  return useMemo(() => createTileStyles({
    ...colors,
    // A choice tile is a card on its plane, never a field: it keeps its own surface on a floating plane, as native
    // already paints it, so tiles read lighter than a dialog and select by their outline (journey-deploy, owner 11-16).
    tileBackground: colors.tileBackground,
    previewBackground: paintColor(colors.previewBackground),
    actionBackground: paintColor(colors.actionBackground),
  }), [colors, paintColor]);
}

function VisualSelectionTiles<T extends string, I extends string>(props: HappierChoiceSelectionTilesProps<T, I>) {
  const styles = useTileStyles(props.colors);
  const tileKeyboardProps = useChoiceTilesKeyboard(props);
  const selectionAccessibilityRole = props.selectionMode === 'multiple' ? 'checkbox' : 'radio';
  const fill = props.tileSizing === 'fill';
  const [gridWidth, setGridWidth] = useState(0);
  const count = props.options.length;
  const requestedColumns = Math.min(count, Math.max(1, props.maximumColumns ?? count));
  // A filling grid with a minimum tile width drops columns once measured, before its tiles would fall under it.
  const maximumColumns = fill && props.minimumTileWidth !== undefined && gridWidth > 0
    ? Math.min(requestedColumns, Math.max(1, Math.floor((gridWidth + VISUAL_GRID_GAP_PX) / (props.minimumTileWidth + VISUAL_GRID_GAP_PX))))
    : requestedColumns;
  // A filling grid has the requested column count. A natural grid has as many natural-width
  // columns as the measured width fits, and never fewer than three, which a phone row shrinks to fit.
  const columns = fill || gridWidth === 0
    ? maximumColumns
    : Math.min(maximumColumns, Math.max(Math.min(3, count), Math.floor((gridWidth + VISUAL_GRID_GAP_PX) / (VISUAL_TILE_WIDTH_PX + VISUAL_GRID_GAP_PX))));
  // A row cannot fit columns + 1 percentage bases plus the positive shared gap. Flex growth then
  // distributes the remaining row width equally, keeping the same grid on web and native.
  // Once measured, a grid that wraps gives every row the same tile width, so a short last
  // row lines up under the full rows instead of stretching across them.
  const wraps = columns < count && (fill || gridWidth > 0);
  const measured = (gridWidth - VISUAL_GRID_GAP_PX * (columns - 1)) / columns;
  const columnWidth = fill ? measured : Math.min(VISUAL_TILE_WIDTH_PX, measured);
  const columnBasis: ViewStyle | undefined = !wraps ? undefined
    : gridWidth > 0
      ? { width: columnWidth, flexBasis: 'auto', flexGrow: 0, flexShrink: 0 }
      : { flexBasis: `${100 / (columns + 1)}%`, flexShrink: 0 };
  // A fill preview's height comes from its measured column. Before the first measure, `aspectRatio` with the
  // floor stands in; once measured, a definite height replaces it, because native layout widens a box whose
  // aspect-ratio height lost to its min height (a 102 pt phone tile drew a 154 pt preview over its neighbours and
  // past the screen edge, D9), where the web keeps the stretched width.
  const previewWidth = columnWidth - 2 * (VISUAL_RING_GAP_PX + VISUAL_RING_WIDTH_PX);
  const aspectRatio = props.previewAspectRatio ?? VISUAL_FILL_PREVIEW_ASPECT_RATIO;
  // Measured, the fill style (with its aspectRatio) is left out entirely: a later `aspectRatio: undefined` does not
  // clear it on native.
  const measuredPreview = fill && gridWidth > 0 && previewWidth > 0;
  const previewAspect: ViewStyle | null = !fill ? null
    : measuredPreview
      ? {
        minHeight: 0,
        height: props.previewAspectRatio ? previewWidth / aspectRatio : Math.max(VISUAL_PREVIEW_HEIGHT_PX, previewWidth / aspectRatio),
      }
      : props.previewAspectRatio ? { aspectRatio: props.previewAspectRatio, minHeight: 0 } : null;
  const showLabels = props.labels !== 'hidden';
  const renderTile = (option: HappierSelectionTileOption<T, I>, index: number, onHeight?: (key: string, height: number) => void): ReactElement => {
        const selected = isSelected(props, option.id);
        const disabled = option.disabled === true;
        const label = props.renderText({ role: 'visualLabel', text: option.title, selected, compact: false, numberOfLines: props.labelLines ?? 2 });
        const tileFrame = [styles.visualTile, fill ? styles.visualTileFill : null, columnBasis];
        const accessory = props.renderOptionAccessory;
        const tile = (
          <Pressable
            key={option.id}
            {...tileKeyboardProps(index)}
            {...(onHeight === undefined || accessory ? {} : { onLayout: (event: { nativeEvent: { layout: { height: number } } }) => onHeight(option.id, event.nativeEvent.layout.height) })}
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
              ...(accessory ? [styles.visualTileBody] : tileFrame),
              { opacity: pressOpacity(disabled, pressed) },
            ]}
          >
            {/* The ring sits on an outer frame with a gap so it reads as a selection, not a border. */}
            <View style={[styles.visualRing, selected ? styles.visualRingSelected : null]}>
              <View style={[styles.visualPreview, fill && !measuredPreview ? styles.visualPreviewFill : null, previewAspect, option.previewEdge === 'dashed' ? styles.visualPreviewDashed : null]} pointerEvents="none">
                {option.preview ?? null}
              </View>
            </View>
            {/* The caption is one block under the preview: its name and the sublabel stand line on line, each in its
                own line box, so a two-line caption always takes its height and never runs into the next line of tiles. */}
            {!showLabels ? null : (
              <View style={styles.visualCaption}>
                {option.badge ? (
                  <View style={styles.visualLabelRow}>
                    {label}
                    <View style={styles.badge}>
                      {props.renderText({ role: 'badge', text: option.badge, selected, compact: false, numberOfLines: 1 })}
                    </View>
                  </View>
                ) : label}
                {option.subtitle
                  ? props.renderText({ role: 'visualSublabel', text: option.subtitle, selected, compact: false, numberOfLines: 2 })
                  : null}
              </View>
            )}
          </Pressable>
        );
        if (!accessory) return tile;
        return (
          <VisualTileAccessoryFrame key={option.id} style={tileFrame} selected={selected}
            {...(onHeight === undefined ? {} : { onHeight: (height: number) => onHeight(option.id, height) })}
            renderAccessory={(revealed) => accessory({ option, selected, revealed })}>
            {tile}
          </VisualTileAccessoryFrame>
        );
  };
  const onGridLayout = (event: { nativeEvent: { layout: { width: number } } }) => setGridWidth(event.nativeEvent.layout.width);
  const pageTracker = useOptionalPluginUiScrollActivityTracker();
  if (props.scroll === 'page' && pageTracker !== null) {
    const selectedIndex = props.options.findIndex((option) => isSelected(props, option.id));
    // Before a tile is measured, a line stands at its preview, ring and two caption lines.
    const estimate = (measuredPreview ? previewWidth / aspectRatio : VISUAL_PREVIEW_HEIGHT_PX)
      + 2 * (VISUAL_RING_GAP_PX + VISUAL_RING_WIDTH_PX) + VISUAL_CAPTION_ESTIMATE_PX;
    return (
      <PageWindowedTiles tracker={pageTracker} options={props.options} columns={columns} columnWidth={columnWidth}
        gap={VISUAL_GRID_GAP_PX} estimate={estimate} pinnedIndex={selectedIndex} renderTile={renderTile} style={styles.visualGrid}
        onGridLayout={onGridLayout} semantics={choiceGroupSemantics(props)} />
    );
  }
  return (
    <View style={styles.visualGrid} onLayout={onGridLayout} {...choiceGroupSemantics(props)}>
      {props.options.map((option, index) => renderTile(option, index))}
    </View>
  );
}

const NO_TILE_HEIGHTS: ReadonlyMap<string, number> = new Map();

/**
 * A page-scrolled tile group's tiles (visual pickers and card groups), wrapped into its columns and drawn only where their lines are near the page's
 * window (`usePageWindow`, the page Collection's rule): each run of far lines stands as one full-width spacer of their
 * exact height, so the page keeps its length and scroll position. Every drawn tile stays a child of this one wrapped
 * row, so a re-flow never remounts it; the chosen tile's line (the group's tab stop) stays drawn wherever it is.
 */
function PageWindowedTiles<T extends string, I extends string>(props: Readonly<{
  tracker: PluginUiScrollActivityTracker;
  options: readonly HappierSelectionTileOption<T, I>[];
  columns: number;
  /** A tile's measured height belongs to the column width it was drawn at. */
  columnWidth: number;
  /** The space between lines, the group's own gap. */
  gap: number;
  estimate: number;
  pinnedIndex: number;
  renderTile: (option: HappierSelectionTileOption<T, I>, index: number, onHeight: (key: string, height: number) => void) => ReactElement;
  style: ViewStyle | ViewStyle[];
  onGridLayout: (event: { nativeEvent: { layout: { width: number } } }) => void;
  semantics: ReturnType<typeof choiceGroupSemantics>;
}>): ReactElement {
  const { options, columns, columnWidth, estimate, gap } = props;
  const { root, measure, near } = usePageWindow(props.tracker);
  const [measured, setMeasured] = useState<Readonly<{ columnWidth: number; heights: ReadonlyMap<string, number> }>>(
    () => ({ columnWidth, heights: NO_TILE_HEIGHTS }),
  );
  const heights = measured.columnWidth === columnWidth ? measured.heights : NO_TILE_HEIGHTS;
  const onHeight = useCallback((key: string, height: number) => {
    setMeasured((current) => {
      const base = current.columnWidth === columnWidth ? current.heights : NO_TILE_HEIGHTS;
      if (height <= 0 || base.get(key) === height) return current;
      return { columnWidth, heights: new Map(base).set(key, height) };
    });
  }, [columnWidth]);
  const lines = useMemo(() => {
    const perLine = Math.max(1, columns);
    // A line not drawn yet stands at the tallest tile measured so far, else the estimate.
    const fallback = heights.size > 0 ? Math.max(...heights.values()) : estimate;
    const result: Array<Readonly<{ start: number; end: number; offset: number; height: number }>> = [];
    let offset = 0;
    for (let start = 0; start < options.length; start += perLine) {
      const end = Math.min(options.length, start + perLine);
      const height = Math.max(...options.slice(start, end).map((option) => heights.get(option.id) ?? fallback));
      result.push({ start, end, offset, height });
      offset += height + gap;
    }
    return result;
  }, [columns, estimate, gap, heights, options]);
  const pinnedLine = props.pinnedIndex < 0 ? -1 : Math.floor(props.pinnedIndex / Math.max(1, columns));
  const content: ReactNode[] = [];
  let skipFrom = -1;
  const flush = (end: number) => {
    if (skipFrom < 0) return;
    const first = lines[skipFrom]!;
    const last = lines[end - 1]!;
    content.push(
      <View key={`gap:${options[first.start]!.id}`} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={{ width: '100%', height: last.offset + last.height - first.offset }} />,
    );
    skipFrom = -1;
  };
  lines.forEach((line, lineIndex) => {
    if (near(line.offset, line.height) || lineIndex === pinnedLine) {
      flush(lineIndex);
      for (let index = line.start; index < line.end; index += 1) content.push(props.renderTile(options[index]!, index, onHeight));
    } else if (skipFrom < 0) skipFrom = lineIndex;
  });
  flush(lines.length);
  return (
    <View ref={root} style={props.style} {...props.semantics}
      onLayout={(event) => { props.onGridLayout(event); void measure(); }}>
      {content}
    </View>
  );
}

/**
 * A visual tile with its own quiet operations: the choice and its "…" are siblings in one frame (a button never
 * nests in the choice), and the frame tracks the pointer so the operations appear over the tile it is on. The frame
 * reads the pointer's enter and leave itself, like a list row's frame (`ListItemFrame`): React Native Web gives hover
 * only to the innermost hoverable, so a frame waiting for its own hover never hears it while the choice inside
 * claims it (QA-LIVE-3 c6: unselected tiles never revealed their operations).
 */
function VisualTileAccessoryFrame(props: Readonly<{
  style: ComponentProps<typeof View>['style'];
  selected: boolean;
  /** A page-windowed picker reads the drawn tile's height. */
  onHeight?: (height: number) => void;
  renderAccessory: (revealed: boolean) => ReactNode;
  children: ReactNode;
}>) {
  const [hovered, setHovered] = useState(false);
  return (
    <View style={props.style}
      {...(props.onHeight === undefined ? {} : { onLayout: (event: { nativeEvent: { layout: { height: number } } }) => props.onHeight!(event.nativeEvent.layout.height) })}
      {...{ onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }}>
      {props.children}
      <View style={visualAccessoryStyles.slot} pointerEvents="box-none">
        {props.renderAccessory(hovered || props.selected)}
      </View>
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
  const section = useHappierPageSection();
  const page = props.listPresentation === undefined ? section !== null : props.listPresentation === 'page';
  // A page's action tiles become its rows when narrow; cards with footers stay cards.
  return page && !props.renderOptionFooter ? <ResponsiveActionTiles {...props} /> : <ActionSelectionCards {...props} />;
}

/**
 * Action tiles in a page section: cards side by side when wide, the section's rows when narrow (the
 * page row anatomy, on one sheet). Each option is one control across the change, so focus, press and
 * hover state survive a resize; only its anatomy and the sheet's chrome change.
 */
function ResponsiveActionTiles<T extends string, I extends string>(props: HappierActionSelectionTilesProps<T, I>) {
  const styles = useTileStyles(props.colors);
  const localization = useOptionalHappierUiLocalization();
  const rtl = localization ? localization.direction === 'rtl' : I18nManager.isRTL;
  const palette = useOptionalHappierUiPalette(props.theme);
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ width: number }> }> }>) => {
    const next = Math.floor(event.nativeEvent.layout.width);
    setWidth((current) => current === next ? current : next);
  }, []);
  const narrow = width > 0 && isHappierPageRowNarrow(width);
  const trackStyle = useActionTrackStyle(props.options.length, width);
  return (
    <View onLayout={onLayout}>
      <HappierItemGroup accessibilityLabel={props.accessibilityLabel}>
        {/* The containing section already owns the page inset; this sheet adds no second one. */}
        <HappierPageSheet
          colors={props.pageColors ?? palette ?? {
            sheet: props.colors.actionBackground,
            sheetBorder: props.colors.tileBorder,
            rowDivider: props.colors.divider ?? props.colors.tileBorder,
            groupDivider: props.colors.divider ?? props.colors.tileBorder,
          }}
          {...(narrow ? {} : { surface: 'none' as const, rowDividers: false, style: styles.actionGrid })}
        >
          {props.options.map((option) => (
            <ResponsiveActionOption key={option.id} tiles={props} option={option} narrow={narrow} rtl={rtl}
              trackStyle={trackStyle} styles={styles} />
          ))}
        </HappierPageSheet>
      </HappierItemGroup>
    </View>
  );
}

function ResponsiveActionOption<T extends string, I extends string>(props: Readonly<{
  tiles: HappierActionSelectionTilesProps<T, I>;
  option: HappierActionSelectionTilesProps<T, I>['options'][number];
  narrow: boolean;
  rtl: boolean;
  trackStyle: ViewStyle | null;
  styles: ReturnType<typeof useTileStyles>;
  /** Set by the sheet on its rows. */
  showDivider?: boolean;
}>) {
  const { tiles, option, styles } = props;
  const disabled = option.disabled === true;
  return (
    <Pressable
      testID={option.testID ?? (tiles.testIdPrefix ? `${tiles.testIdPrefix}:${option.id}` : undefined)}
      accessibilityRole="button"
      accessibilityLabel={option.subtitle ? `${option.title}, ${option.subtitle}` : option.title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        if (disabled) return;
        tiles.onPress(option.id);
      }}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => props.narrow
        ? { opacity: pressOpacity(disabled, pressed) }
        : [styles.actionTile, props.trackStyle, hovered && !disabled ? styles.actionTileHovered : null, { opacity: pressOpacity(disabled, pressed) }]}
    >
      {props.narrow ? (
        // The page row's anatomy; the option's one control above owns press, focus and its name.
        <HappierListItem
          theme={tiles.theme}
          textScale={tiles.textScale}
          pageRowMetrics={tiles.pageRowMetrics}
          title={option.title}
          subtitle={option.subtitle}
          icon={option.mark ?? (option.icon ? tiles.renderGlyph({
            glyph: { kind: 'icon', name: option.icon }, size: tiles.pageRowMetrics?.iconGlyphPx ?? HAPPIER_PAGE_METRICS.rowIconGlyphPx, color: tiles.colors.glyph,
          }) : undefined)}
          disabled={option.disabled}
          showDivider={props.showDivider}
          // The button above is the item; this anatomy is not a list item outside a list.
          suppressListItemRole
          accessory={<HappierChevron direction={props.rtl ? 'left' : 'right'} color={tiles.colors.glyph} />}
        />
      ) : <ActionCardBody tiles={tiles} option={option} styles={styles} />}
    </Pressable>
  );
}

function ActionCardBody<T extends string, I extends string>(props: Readonly<{
  tiles: HappierActionSelectionTilesProps<T, I>;
  option: HappierActionSelectionTilesProps<T, I>['options'][number];
  styles: ReturnType<typeof useTileStyles>;
}>) {
  const { tiles, option } = props;
  return (
    <>
      {option.mark ?? (option.icon
        ? tiles.renderGlyph({ glyph: { kind: 'icon', name: option.icon }, size: 20, color: tiles.colors.glyph })
        : null)}
      <View style={props.styles.actionText}>
        {tiles.renderText({ role: 'actionTitle', text: option.title, selected: false, compact: false, numberOfLines: 2 })}
        {option.subtitle
          ? tiles.renderText({ role: 'actionSubtitle', text: option.subtitle, selected: false, compact: false, numberOfLines: 2 })
          : null}
      </View>
    </>
  );
}

/**
 * Every tile takes the same track, so a wrapped last row keeps the width of the rows above it
 * (a lone tile never stretches across the grid). Before the first measure the grid reserves the
 * columns a page row fits (up to three, the visual grid's basis trick): a wrapped tile is held to
 * one column instead of spanning the row, so the first layout does not move it.
 */
function useActionTrackStyle(count: number, width: number): ViewStyle | null {
  return useMemo((): ViewStyle | null => {
    if (width <= 0) {
      const columns = Math.max(1, Math.min(count, ACTION_PREMEASURE_COLUMNS));
      return { flexBasis: `${100 / (columns + 1)}%`, maxWidth: `${100 / columns}%` };
    }
    const columns = Math.max(1, Math.min(count, Math.floor((width + ACTION_GRID_GAP_PX) / (ACTION_TILE_MIN_WIDTH_PX + ACTION_GRID_GAP_PX))));
    return { width: Math.floor((width - ACTION_GRID_GAP_PX * (columns - 1)) / columns), flexGrow: 0, flexShrink: 0, flexBasis: 'auto' };
  }, [count, width]);
}

function ActionSelectionCards<T extends string, I extends string>(props: HappierActionSelectionTilesProps<T, I>) {
  const styles = useTileStyles(props.colors);
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ width: number }> }> }>) => {
    const next = Math.floor(event.nativeEvent.layout.width);
    setWidth((current) => current === next ? current : next);
  }, []);
  const trackStyle = useActionTrackStyle(props.options.length, width);
  return (
    <View
      onLayout={onLayout}
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
              style={[styles.actionTile, styles.actionTileWithFooter, trackStyle]}
            >
              <View style={styles.actionHead}>
                {option.mark ?? (option.icon
                  ? props.renderGlyph({ glyph: { kind: 'icon', name: option.icon }, size: 20, color: props.colors.glyph })
                  : null)}
                <View style={styles.actionHeadTitle}>
                  {/* A provider's name tells it apart ("Crabbox coordinator" beside its kind): it wraps, never truncates. */}
                  {props.renderText({ role: 'actionTitle', text: option.title, selected: false, compact: false, numberOfLines: 2 })}
                </View>
                {option.badge
                  ? props.renderText({ role: 'badge', text: option.badge, selected: false, compact: false, numberOfLines: 1 })
                  : null}
              </View>
              {/* The description is what the card offers: it is read whole, never clipped; the row's cards share its height. */}
              {option.subtitle
                ? props.renderText({ role: 'actionSubtitle', text: option.subtitle, selected: false, compact: false, numberOfLines: 0 })
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
              trackStyle,
              hovered && !disabled ? styles.actionTileHovered : null,
              { opacity: pressOpacity(disabled, pressed) },
            ]}
          >
            <ActionCardBody tiles={props} option={option} styles={styles} />
          </Pressable>
        );
      })}
    </View>
  );
}

const CARD_GAP_PX = 10;
/** `tileGap="tight"`: phone option rows (Themes B3P). */
const CARD_GAP_TIGHT_PX = 8;
/** A card line not measured yet (the page window's estimate only): a regular and a compact card's minimum height. */
const CARD_LINE_ESTIMATE_PX = { regular: 92, compact: 48 } as const;
const FILL_TILE_FRAME: ViewStyle = { width: '100%' };

/** A card's outline and its mark settle on the colour step of the motion scale; nothing in the card moves. */
const CARD_PAINT_TRANSITION = Platform.OS === 'web' ? {
  transitionProperty: 'border-color, background-color',
  transitionDuration: `${HAPPIER_MOTION_V1.hoverMs}ms`,
  transitionTimingFunction: HAPPIER_MOTION_V1.standardEasingCss,
} as ViewStyle : null;

type CardTileHoverHandlers = Readonly<{ onHoverIn?: () => void; onHoverOut?: () => void }>;

/**
 * A card tile's frame. Its outline darkens one ink step while a pointer hovers the card's choice (colour only; a
 * finger has no hover, and React Native reports hover for fine pointers alone). The frame holds its own hover so a
 * pointer crossing a large group repaints one card, not the group.
 */
function CardTileFrame(props: Readonly<{
  style: ComponentProps<typeof View>['style'];
  hoverBorderColor: string | null;
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
  /**
   * The frame is an Element on its page (a separate tile, not a sheet's cell): it stands on the Elements material,
   * glass over an atmosphere and its exact solid paint elsewhere. On a floating plane it keeps its own surface
   * (a tile reads lighter than its dialog, journey-deploy, owner 11-16), so it never stacks glass on glass.
   */
  material: boolean;
  renderMaterialSurface?: HappierMaterialSurfaceRender;
  children: (hover: CardTileHoverHandlers) => ReactNode;
}>): ReactElement {
  const [hovered, setHovered] = useState(false);
  const hover = useMemo<CardTileHoverHandlers>(() => ({
    onHoverIn: () => setHovered(true),
    onHoverOut: () => setHovered(false),
  }), []);
  const onFloatingPlane = useContainingHappierMaterialRole() === 'floating';
  const style = [props.style, CARD_PAINT_TRANSITION, hovered && props.hoverBorderColor ? { borderColor: props.hoverBorderColor } : null];
  if (props.material && !onFloatingPlane) {
    return (
      <HappierMaterialSurface materialRole="card" gradient={null} renderMaterialSurface={props.renderMaterialSurface}
        {...(props.onLayout ? { onLayout: props.onLayout } : {})} style={style}>
        {props.children(hover)}
      </HappierMaterialSurface>
    );
  }
  return (
    <View
      {...(props.onLayout ? { onLayout: props.onLayout } : {})}
      style={style}
    >
      {props.children(hover)}
    </View>
  );
}

/** The chosen single-choice card's filled check and an unchosen card's empty ring: one diameter, so nothing shifts. */
function CardChoiceMark<I extends string>(props: Readonly<{
  selected: boolean;
  colors: HappierSelectionTilesColors;
  renderGlyph: HappierSelectionTilesGlyphRenderer<I>;
}>): ReactElement {
  const { size } = HAPPIER_RADIO_MARK_METRICS;
  return (
    <View style={[
      resolveHappierRadioMarkStyle({ selected: false, ink: props.colors.selection, quiet: props.colors.actionBorderHovered, surface: 'transparent' }),
      CARD_PAINT_TRANSITION,
      props.selected ? { borderColor: props.colors.selection, backgroundColor: props.colors.selection } : null,
      { alignItems: 'center', justifyContent: 'center' },
    ]}>
      {props.selected ? props.renderGlyph({ glyph: { kind: 'check' }, size: Math.round(size * 0.625), color: props.colors.tileBackground }) : null}
    </View>
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
  const sheet = props.surface === 'sheet';
  const gap = sheet ? 0 : props.tileGap === 'tight' ? CARD_GAP_TIGHT_PX : CARD_GAP_PX;
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
    // Sheet cells have no gap to leave room for, so the shares are exact.
    if (sheet) return { width: `${100 / fittedColumns}%`, maxWidth: `${100 / fittedColumns}%`, flexGrow: 0, flexShrink: 0 };
    if (fittedColumns === 2) return { width: '48%', maxWidth: '48%', flexGrow: 0, flexShrink: 0 };
    return { width: '31%', maxWidth: '31%', flexGrow: 0, flexShrink: 0 };
  }, [fittedColumns, sheet, width]);
  const dividerColor = props.colors.divider ?? props.colors.tileBorder;
  // When some tiles describe themselves, a tile without a description keeps that line empty, so every tile reads
  // the same shape and choosing one never changes the group's layout.
  const anySubtitle = props.options.some((option) => typeof option.subtitle === 'string' && option.subtitle.trim().length > 0);

  const renderTile = (option: HappierSelectionTileOption<T, I>, index: number, onHeight?: (key: string, height: number) => void): ReactElement => {
        const selected = isSelected(props, option.id);
        const disabled = option.disabled === true;
        const glyph: HappierSelectionTileGlyph<I> | null = option.icon
          ? { kind: 'icon', name: option.icon }
          : null;
        const borderColor = selected ? props.colors.selection : props.colors.tileBorder;
        const glyphColor = props.colors.glyph;
        // A card whose body sits below draws its glyph at the title's size, beside the title alone.
        const below = props.descriptionPlacement === 'below' && !sheet;
        const glyphSize = compact || below ? 16 : 29;
        const hasSubtitle = typeof option.subtitle === 'string' && option.subtitle.trim().length > 0;
        // A reserved description line lays the tile out like its described siblings.
        const subtitleLine = hasSubtitle || anySubtitle;
        const hasPreview = compact && option.preview != null;
        // A regular card whose body sits below leads with its preview at the card's width (an option you try on).
        const leadingPreview = !compact && below && option.preview != null;
        const footer = props.renderOptionFooter?.({ option, selected, disabled });
        // A spanning tile takes the measured row (the whole grid before measurement); the others keep their column.
        const spans = option.span === 'row' && !sheet;
        const ownWidthStyle = spans ? (width > 0 ? { width } : FILL_TILE_FRAME) : tileWidth ? { width: tileWidth } : fallbackTileWidthStyle;
        const tileTestID = option.testID ?? (props.testIdPrefix ? `${props.testIdPrefix}:${option.id}` : undefined);
        // A trailing footer shares the tile's line with the choice, which takes the room the footer leaves.
        const trailing = props.footerPlacement === 'trailing' && !sheet && footer != null && footer !== false;
        // A choice's mark keeps the tile's top end beside a trailing footer (option F): the footer stands under it, so
        // an operation ("…") never pushes the check off the corner.
        const markBeside = trailing && props.selectionMark !== 'outline';
        const selectionMark = sheet && !(selected && props.selectionMode === 'multiple')
          ? <View style={resolveHappierRadioMarkStyle({ selected, ink: props.colors.selection, quiet: props.colors.glyph, surface: 'transparent' })} />
          : props.selectionMark === 'outline' ? null
          // A single choice shows every card's mark: an empty ring that becomes the filled check (option F),
          // one size, so choosing changes only the outline and the mark.
          : props.selectionMode !== 'multiple' ? <CardChoiceMark selected={selected} colors={props.colors} renderGlyph={props.renderGlyph} />
          : selected ? props.renderGlyph({ glyph: { kind: 'check' }, size: 16, color: props.colors.selection }) : null;
        const subtitleText = (role: 'cardSubtitle') => option.subtitleTruncation === 'middle'
          ? renderMiddleTruncatedTileText(props.renderText, { role, text: option.subtitle!, selected, compact })
          : props.renderText({ role, text: option.subtitle!, selected, compact, numberOfLines: props.subtitleLines ?? 4 });
        const previewSize = hasPreview && props.previewWidth !== undefined
          ? { width: props.previewWidth, height: props.previewWidth / (props.previewAspectRatio ?? props.previewWidth / VISUAL_PREVIEW_HEIGHT_PX) }
          : null;

        return (
          <CardTileFrame
            key={option.id}
            onLayout={onHeight === undefined ? undefined : (event) => onHeight(option.id, event.nativeEvent.layout.height)}
            // A sheet's cells have no outline of their own; a chosen card keeps its selection ink under the pointer.
            hoverBorderColor={sheet || selected || disabled ? null : props.colors.actionBorderHovered}
            material={!sheet}
            renderMaterialSurface={props.renderMaterialSurface}
            style={sheet ? [
              styles.sheetCell,
              tileWidth ? { width: tileWidth } : fallbackTileWidthStyle,
              // Hairlines only between cells: before every cell but a row's first, above every row but the first.
              index % fittedColumns !== 0 ? { borderLeftWidth: StyleSheet.hairlineWidth, borderColor: dividerColor } : null,
              index >= fittedColumns ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: dividerColor } : null,
            ] : [
              styles.tile,
              compact ? styles.tileFrameCompact : null,
              ownWidthStyle,
              { borderColor },
              trailing ? styles.tileTrailing : null,
              markBeside ? styles.tileMarkBeside : null,
            ]}
          >
            {(hover) => (<>
            <SelectionTilePressable
              {...tileKeyboardProps(index)}
              {...hover}
              // Sheet cells meet edge to edge; separate tiles reach half the gap between them.
              hitReach={sheet ? 0 : gap / 2}
              testID={tileTestID}
              accessibilityRole={selectionAccessibilityRole}
              // The badge is visible text that qualifies the choice ("Recommended"), so it is part of the name too.
              accessibilityLabel={[option.title, option.badge ?? null, hasSubtitle ? option.subtitle : null, option.status ?? null, option.footerLabel ?? null].filter(Boolean).join(', ')}
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
                compact && subtitleLine ? styles.tileCompactDescribed : null,
                // One tile per line has no row to keep even: each takes its own content's height.
                fittedColumns === 1 && !sheet ? styles.tileSingleColumn : null,
                compact && !subtitleLine ? styles.tileCompactWithoutSubtitle : null,
                below ? styles.tilePressableBelow : null,
                sheet ? styles.sheetCellPressable : null,
                // The frame above owns the column's share before measurement; the press target fills it
                // (a second percentage here would take a share of the share).
                trailing ? styles.tilePressableTrailing : spans ? ownWidthStyle : tileWidth ? { width: tileWidth } : FILL_TILE_FRAME,
                { opacity: pressOpacity(disabled, pressed) },
              ]}
            >
              {leadingPreview ? (
                <View style={[styles.cardLeadingPreview, { aspectRatio: props.previewAspectRatio ?? CARD_LEADING_PREVIEW_ASPECT_RATIO }]}
                  pointerEvents="none" aria-hidden>{option.preview}</View>
              ) : null}
              <View style={[styles.headerRow, sheet || compact && (!subtitleLine || hasPreview) ? styles.headerRowCentered : null]}>
                {hasPreview ? <View style={[styles.cardPreview, previewSize]} pointerEvents="none" aria-hidden>{option.preview}</View> : null}
                <View style={[styles.titleRow, sheet || compact && (!subtitleLine || hasPreview) ? styles.titleRowCentered : null]}>
                  {option.mark || glyph ? <View style={[styles.iconSlot, compact || below ? styles.iconSlotCompact : null]}>
                    {option.mark ?? (glyph ? props.renderGlyph({ glyph, size: glyphSize, color: glyphColor }) : null)}
                  </View> : null}
                  <View style={[styles.textContainer, compact && !subtitleLine ? styles.textContainerCentered : null]}>
                    {/* The name wraps in full (a long service name is never cut) and its badge follows it,
                        dropping to its own line only when the name leaves no room. */}
                    <View style={styles.titleLine}>
                      <View style={styles.titleText}>
                        {props.renderText({ role: 'cardTitle', text: option.title, selected, compact, numberOfLines: 0 })}
                      </View>
                      {option.badge ? (
                        <View style={styles.badgeInline}>
                          {props.renderText({ role: 'badge', text: option.badge, selected, compact, numberOfLines: 1 })}
                        </View>
                      ) : null}
                    </View>
                    {below ? null : hasSubtitle
                      ? subtitleText('cardSubtitle')
                      : anySubtitle ? (
                        // An empty line of the description's height: no text, so the tile's name stays its own.
                        <View pointerEvents="none" aria-hidden style={{ minHeight: resolveHappierTypeScale(
                          resolveHappierSelectionTileText('cardSubtitle', { compact }).role, Platform.OS,
                        ).lineHeight }} />
                      ) : null}
                    {/* A status is one more quiet line of the text block (lab themes A1 "Showing now"), so the
                        name, its description and the status centre together beside the preview. */}
                    {below || !option.status ? null : (
                      <View aria-hidden>{props.renderText({ role: 'badge', text: option.status, selected, compact, numberOfLines: 1 })}</View>
                    )}
                  </View>
                </View>
                {markBeside ? null : (
                  <View style={styles.selectionAccessory} pointerEvents="none" aria-hidden>
                    {/* A tile marks only the chosen card, with a check beside its ink outline (lab f1src), or by the outline
                        alone (`selectionMark="outline"`); a sheet's cells keep the one single-choice mark (`RadioMark`)
                        that a table's or a list's radio draws. */}
                    {selectionMark}
                  </View>
                )}
              </View>
              {below && (hasSubtitle || option.status) ? (
                <View testID={tileTestID ? `${tileTestID}:description` : undefined} style={styles.bodyBelow}>
                  {hasSubtitle ? subtitleText('cardSubtitle') : null}
                  {option.status ? <View aria-hidden>{props.renderText({ role: 'badge', text: option.status, selected, compact, numberOfLines: 1 })}</View> : null}
                </View>
              ) : null}
            </SelectionTilePressable>
            {markBeside ? (
              <View style={[styles.markColumn, compact ? styles.markColumnCompact : null]}>
                {/* The mark is part of the choice: pressing it chooses, as the rest of the card does; the card's own
                    press target carries its name, state and keyboard. */}
                <Pressable {...hover} accessible={false} focusable={false} tabIndex={-1} aria-hidden disabled={disabled}
                  onPress={() => { if (!disabled) handleToggle(props, option.id); }} style={{ opacity: pressOpacity(disabled, false) }}>
                  {selectionMark}
                </Pressable>
                {footer}
              </View>
            ) : footer != null && footer !== false ? (
              <View style={trailing ? [styles.footerTrailing, compact ? styles.footerTrailingCompact : null] : [styles.footer, compact ? styles.footerCompact : null, compact && subtitleLine ? styles.footerCompactDescribed : null,
                below ? (compact ? (subtitleLine ? { paddingLeft: CARD_COMPACT_DESCRIBED_PADDING_PX } : styles.footerBelowCompact) : styles.footerBelow) : null,
                // Beside a preview the text column starts after it: the footer action takes the name's edge.
                !below && hasPreview ? styles.footerBesidePreview : null]}>
                {footer}
              </View>
            ) : null}
            </>)}
          </CardTileFrame>
        );
  };
  const gridStyle: ViewStyle[] = [styles.grid, { flexDirection: 'row', flexWrap: 'wrap', gap }];
  const onGridLayout = (event: { nativeEvent: { layout: { width: number } } }) => setWidth(event.nativeEvent.layout.width);
  const pageTracker = useOptionalPluginUiScrollActivityTracker();
  if (props.scroll === 'page' && pageTracker !== null) {
    return (
      <PageWindowedTiles tracker={pageTracker} options={props.options} columns={fittedColumns} columnWidth={tileWidth ?? 0}
        gap={gap} estimate={CARD_LINE_ESTIMATE_PX[density]} pinnedIndex={props.options.findIndex((option) => isSelected(props, option.id))}
        renderTile={renderTile} style={gridStyle} onGridLayout={onGridLayout} semantics={choiceGroupSemantics(props)} />
    );
  }
  return (
    <View onLayout={onGridLayout} style={gridStyle} {...choiceGroupSemantics(props)}>
      {props.options.map((option, index) => renderTile(option, index))}
    </View>
  );
}

const VISUAL_TILE_WIDTH_PX = 112;
const VISUAL_TILE_MIN_WIDTH_PX = 84;
const VISUAL_PREVIEW_HEIGHT_PX = 70;
const VISUAL_PREVIEW_RADIUS_PX = 10;
const VISUAL_RING_GAP_PX = 2;
const VISUAL_RING_WIDTH_PX = 1.5;
const VISUAL_GRID_GAP_PX = 10;
/** A visual tile's caption and sublabel lines, for a line of tiles not measured yet (the page window's estimate only). */
const VISUAL_CAPTION_ESTIMATE_PX = 40;
/** A filling tile keeps the proportions of a small app window rather than a fixed height. */
const VISUAL_FILL_PREVIEW_ASPECT_RATIO = 2.2;
/** A regular card's leading preview (`descriptionPlacement="below"`): a small app window. */
const CARD_LEADING_PREVIEW_ASPECT_RATIO = 1.6;

const visualAccessoryStyles = StyleSheet.create({
  // Inside the ring's gap, at the preview's top-right corner.
  slot: {
    position: 'absolute',
    top: VISUAL_RING_WIDTH_PX + VISUAL_RING_GAP_PX + 4,
    right: VISUAL_RING_WIDTH_PX + VISUAL_RING_GAP_PX + 4,
  },
});

const ACTION_TILE_MIN_WIDTH_PX = 180;
const ACTION_GRID_GAP_PX = 10;
/** Columns a wide page row fits before its width is known (a phone recomposes these cards as rows). */
const ACTION_PREMEASURE_COLUMNS = 3;

/**
 * A choice tile's press target. Under a finger its hit area reaches past the drawn tile into the gap around
 * it (half the gap, so neighbours never overlap); the tile itself never grows (DESIGN.md → touch targets are
 * hit areas, not drawn sizes).
 */
function SelectionTilePressable({ hitReach, style, children, ...rest }: Omit<ComponentProps<typeof Pressable>, 'children'> & Readonly<{
  hitReach: HappierHitReach;
  children: ReactNode;
}>) {
  const restingState = { pressed: false, hovered: false };
  const hitArea = useHappierHitArea({
    restingStyle: () => (typeof style === 'function' ? style(restingState) : style),
    hitReach,
  });
  return (
    <Pressable {...rest} hitSlop={hitArea.hitSlop} onLayout={hitArea.onLayout} style={style}>
      {hitArea.frame}
      {children}
    </Pressable>
  );
}

/** A described compact card's inset on every side (the lab's option F choices). */
const CARD_COMPACT_DESCRIBED_PADDING_PX = 14;

/**
 * One line that gives up its middle in the tiles' own text renderer. The web draws only a tail ellipsis, so it is two
 * runs there (the head shrinks, the tail stays); native asks the platform for its middle ellipsis.
 */
function renderMiddleTruncatedTileText(
  renderText: HappierSelectionTilesTextRenderer,
  input: Readonly<{ role: HappierSelectionTileTextRole; text: string; selected: boolean; compact: boolean }>,
): ReactNode {
  const split = Platform.OS === 'web' ? splitForWebMiddleEllipsis(input.text) : null;
  if (split === null) return renderText({ ...input, numberOfLines: 1, ellipsizeMode: 'middle' });
  return (
    <View style={HAPPIER_MIDDLE_ELLIPSIS_STYLE.row as ViewStyle}>
      <View style={{ flexShrink: split.headStyle.flexShrink, minWidth: 0 }}>{renderText({ ...input, text: split.head, numberOfLines: 1 })}</View>
      <View style={{ flexShrink: split.tailStyle.flexShrink, minWidth: 0 }}>{renderText({ ...input, text: split.tail, numberOfLines: 1 })}</View>
    </View>
  );
}

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
      gap: ACTION_GRID_GAP_PX,
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
      gap: VISUAL_GRID_GAP_PX,
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
    // The choice inside a frame that also holds the tile's operations: the frame owns the column.
    visualTileBody: {
      alignItems: 'stretch',
      gap: 7,
    },
    visualTileFill: {
      flexBasis: 0,
      minWidth: 0,
      maxWidth: '100%',
    },
    visualCaption: {
      alignItems: 'stretch',
    },
    visualLabelRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 6,
    },
    visualRing: {
      // Concentric: ring radius = preview radius + gap + ring width.
      borderRadius: VISUAL_PREVIEW_RADIUS_PX + VISUAL_RING_GAP_PX + VISUAL_RING_WIDTH_PX,
      borderWidth: VISUAL_RING_WIDTH_PX,
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
    // An empty slot: no ground of its own, an ink edge in dashes (the lab's "Your picture…").
    visualPreviewDashed: {
      backgroundColor: 'transparent',
      borderStyle: 'dashed',
      borderWidth: 1,
      borderColor: colors.actionBorderHovered,
    },
    visualPreviewFill: {
      height: 'auto',
      minHeight: VISUAL_PREVIEW_HEIGHT_PX,
      aspectRatio: VISUAL_FILL_PREVIEW_ASPECT_RATIO,
    },
    // Inside the card's padding, its corners concentric with the tile's.
    cardLeadingPreview: {
      width: '100%',
      marginBottom: 10,
      borderRadius: 6,
      overflow: 'hidden',
      backgroundColor: colors.previewBackground,
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
      // Never clipping: a compact tile is shorter than its press target's hit area, which reaches past
      // the frame into the gap (its preview clips itself).
    },
    // A cell of the sheet it sits on: the sheet owns the ground, the edge and the corners.
    sheetCell: {
      borderWidth: 0,
      borderRadius: 0,
    },
    // At the sheet's row inset and row height, so the cells line up with the rows of the page.
    sheetCellPressable: {
      paddingHorizontal: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
      paddingVertical: HAPPIER_PAGE_METRICS.compactRowPaddingVerticalPx,
      minHeight: HAPPIER_PAGE_METRICS.rowMinHeightPx,
      justifyContent: 'center',
    },
    // Compact cards share the field box's shape (radius, one-pixel outline), so a dense grid reads
    // like the controls around it; the chosen tile keeps the selection colour on that outline.
    tileFrameCompact: {
      borderRadius: HAPPIER_FIELD_BOX_METRICS.radiusPx,
      borderWidth: HAPPIER_FIELD_BOX_METRICS.borderWidthPx,
    },
    // Tiles of one row share its height; the press target takes the slack so a footer (readiness) sits
    // on the same line in every tile of the row however long the descriptions above it run.
    tilePressable: {
      flexGrow: 1,
      paddingHorizontal: 12,
      paddingVertical: 14,
      minHeight: 92,
    },
    tileCompact: {
      paddingHorizontal: 10,
      paddingVertical: 8,
      minHeight: 48,
    },
    // A compact card that describes itself (option F's choices) breathes like the lab's cards: its text clear of the
    // outline on every side rather than packed to a dense grid's field box.
    tileCompactDescribed: {
      paddingHorizontal: CARD_COMPACT_DESCRIBED_PADDING_PX,
      paddingVertical: CARD_COMPACT_DESCRIBED_PADDING_PX,
    },
    tileSingleColumn: {
      minHeight: 0,
    },
    // A one-line compact card is a bordered choice in a dense grid (a popover's scope tiles): the
    // field box's height under every pointer, its title centred. A finger reaches it through the tile's
    // hit area, never a taller tile.
    tileCompactWithoutSubtitle: {
      minHeight: HAPPIER_FIELD_BOX_METRICS.minHeightPx,
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
    // `descriptionPlacement="below"`: the body (description, then the footer) takes the card's full width from its
    // own padding, under the title row.
    bodyBelow: {
      marginTop: 6,
    },
    // Its height is its content: the body and footer follow the title row instead of a card's reserved height, and a
    // shorter card in a row keeps its body at the top, the row's slack under it (journey-deploy stWhere).
    tilePressableBelow: {
      minHeight: 0,
      flexGrow: 0,
    },
    footerCompactDescribed: {
      paddingLeft: CARD_COMPACT_DESCRIBED_PADDING_PX + CARD_ICON_BOX_PX.compact + 10,
      paddingRight: CARD_COMPACT_DESCRIBED_PADDING_PX,
    },
    footerBelow: {
      paddingLeft: 12,
    },
    footerBesidePreview: {
      paddingLeft: 10 + VISUAL_TILE_WIDTH_PX + 12,
    },
    footerBelowCompact: {
      paddingLeft: 10,
    },
    // `footerPlacement="trailing"`: the choice and its operation share one line, the operation centred at the end.
    tileTrailing: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    tilePressableTrailing: {
      flex: 1,
      minWidth: 0,
    },
    // The mark stands at the card's top end and the trailing operation under it, at the card's foot.
    tileMarkBeside: {
      alignItems: 'stretch',
    },
    markColumn: {
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      gap: 6,
      paddingTop: 14,
      paddingRight: 12,
      paddingBottom: 8,
    },
    markColumnCompact: {
      paddingTop: CARD_COMPACT_DESCRIBED_PADDING_PX,
      paddingRight: CARD_COMPACT_DESCRIBED_PADDING_PX,
    },
    footerTrailing: {
      paddingRight: 12,
    },
    footerTrailingCompact: {
      paddingRight: 10,
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
    // A card tile's name and badge share one wrapping line; the badge keeps its whole word.
    titleLine: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      columnGap: 8,
      rowGap: 2,
    },
    titleText: {
      flexShrink: 1,
      minWidth: 0,
    },
    badgeInline: {
      flexShrink: 0,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.tileBorder,
      paddingHorizontal: 8,
      paddingVertical: 0,
    },
  });
}
