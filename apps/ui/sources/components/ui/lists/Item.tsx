import * as React from 'react';
import { View, Pressable, StyleProp, ViewStyle, TextStyle, Platform, StyleSheet as RNStyleSheet, type AccessibilityRole, type TextProps, type ViewProps, type LayoutChangeEvent } from 'react-native';
import { Typography } from '@/constants/Typography';
import { ListOptionPressable } from './listOptionSetPosition';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    ItemGroupSelectionContext,
} from '@/components/ui/lists/ItemGroup';
import { useItemGroupRowPosition } from '@/components/ui/lists/ItemGroupRowPosition';
import { ItemRowAccessibleNameProvider, ItemRowOwnsSwitchProvider, readItemRowSwitch } from '@/components/ui/lists/ItemRowAccessibleName';
import { ItemRowHoverProvider } from '@/components/ui/lists/ItemRowHover';
import { ItemSubtitleTextStyleProvider } from '@/components/ui/lists/ItemSubtitleText';
import { getItemGroupRowCornerRadii } from '@/components/ui/lists/itemGroupRowCorners';
import {
    resolveItemSubtitleMaxLines,
    resolveItemTitleMaxLines,
} from '@/components/ui/lists/itemTextClamp';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { metaFigureStyle } from '@/components/ui/text/metaFigures';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { queryRanges } from '@/components/ui/text/queryRanges';
import { MiddleEllipsisText, splitForWebMiddleEllipsis } from '@/components/ui/text/MiddleEllipsisText';
import {
    WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE,
    WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE,
} from '@/components/ui/text/webStartEllipsisTextStyles';
import { useItemDensityInputs, useSectionRowRole } from '@/components/ui/lists/useResolvedItemDensity';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, resolveHappierFocusRingVisible, resolveHappierRowEndFadeStyle, useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import {
    ITEM_CHEVRON_SIZE,
    ITEM_ICON_BOX_SIZE,
    ITEM_ICON_GLYPH_SIZE,
    MENU_ROW_METRICS, MENU_ROW_SHAPE, MENU_ROW_TRAILING,
    ITEM_ICON_MARGIN_RIGHT,
    ITEM_ROW_PADDING_HORIZONTAL,
    ITEM_ROW_WITH_SUBTITLE_PADDING_VERTICAL_PX,
    ITEM_SUBTITLE_TEXT_METRICS,
    ITEM_TITLE_TEXT_METRICS,
} from '@/components/ui/lists/itemDensityMetrics';
import {
    resolvePageRowDensityInput,
    resolvePageRowMetrics,
    type PageRowMetrics,
} from './pageRowMetrics';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { buildActionRowAccessibilityLabel } from './actionRowAccessibility';
import { Icon } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from './DisclosureCaret';
import { ICON_LABEL_OPTICAL_NUDGE_STYLE } from '@/components/ui/icons/iconOpticalAlignment';
import { SectionRowBleedContext, useSectionRowBleedStyle } from './bareRowBleed';
import { BareSectionRowsContext, MenuSectionRowsContext, PageDirectoryRowsContext, useListPresentation, useSidePaneTextEdge, useWidgetBodyRowEdge } from './listPresentation';
import { PANE_TEXT_INSET_PX } from '@/components/ui/layout/headerBand';
import { GROUPED_SURFACE_RADIUS_PX, PAGE_LIST_METRICS } from './pageListMetrics';
import { HAPPIER_RADIUS_V1 } from '@happier-dev/plugin-ui/environment';
import { resolveHappierRowTitleMetaPlacement } from '@happier-dev/plugin-ui/advanced';
import { useSectionLeadingColumn } from './sectionLeadingColumn';
import {
    HAPPIER_COLLECTION_LIST_METRICS,
    type HappierCollectionRowRole,
    HappierPageRowFieldLayoutContext,
    HAPPIER_META_COLUMN_STYLE,
    resolveHappierItemBehavior,
    resolveHappierPageRowFieldMaxWidth,
    HappierDivider,
    happierPageRowDividerInset,
    happierPageRowDividerWidth,
    isHappierPageRowNarrow,
    resolveHappierPageRowDetailLayout,
    isHappierPageRowAccessoryStacked,
    useHappierItemGroupItemBehavior,
    useHappierPageSection,
    useHappierCollectionListRow,
    useHappierMaterialColorResolver,
    HAPPIER_ROW_TITLE_META_GAP_PX,
    HappierListRowFollowedContext,
    HappierListRowPrecedesSelectedContext,
    HappierListRowRule,
    resolveHappierListRowRuleShown,
    resolveHappierCatalogDirectoryRowEdges,
} from '@happier-dev/plugin-ui/presentation';

const NO_MARGINS = Object.freeze({ start: 0, end: 0 });

/** A press target's horizontal margins (a column row's fill gutter), when its style states them. */
function readHorizontalMargins(style: StyleProp<ViewStyle>): Readonly<{ start: number; end: number }> {
    const flat = RNStyleSheet.flatten(style) as ViewStyle | undefined;
    const read = (value: unknown) => (typeof value === 'number' ? value : null);
    const both = read(flat?.marginHorizontal) ?? read(flat?.margin) ?? 0;
    return {
        start: read(flat?.marginLeft) ?? read(flat?.marginStart) ?? both,
        end: read(flat?.marginRight) ?? read(flat?.marginEnd) ?? both,
    };
}

/** A row's own leading padding, when its style states one (a collection column row's gutter and indent). */
function readLeadingPadding(style: StyleProp<ViewStyle>): number | null {
    const flat = RNStyleSheet.flatten(style) as ViewStyle | undefined;
    const value = flat?.paddingLeft ?? flat?.paddingStart ?? flat?.paddingHorizontal ?? flat?.padding;
    return typeof value === 'number' ? value : null;
}

/** A title that carries a search match is the content of its row, so it wraps to this many lines rather than clipping the match. */
const HIGHLIGHTED_TITLE_MAX_LINES = 2;

/** The title keeps this much of the line before a title meta moves beneath it. */
const ITEM_TITLE_META_TITLE_MIN_PX = 120;

function resizeItemIconForDensity(icon: React.ReactNode, iconSize: number, color?: string): React.ReactNode {
    if (!React.isValidElement<Record<string, unknown>>(icon) || icon.type === React.Fragment) {
        return icon;
    }
    // Numeric glyphs opt into the row scale; named glyphs may omit their default size.
    // Semantic size modes and composed marks keep the layout owned by their component.
    const props = icon.props;
    if (props.children != null || !(typeof props.size === 'number'
        || (typeof props.name === 'string' && props.size === undefined))) {
        return icon;
    }
    // Semantic marks own their named size; density only resizes numeric glyphs.
    if (typeof (icon.props as { size?: unknown }).size === 'string') return icon;

    return React.cloneElement(icon, {
        size: iconSize,
        ...(color ? { color } : null),
    } as Record<string, unknown>);
}

type ItemTextEllipsizeMode = NonNullable<TextProps['ellipsizeMode']>;

/** The share of a wide row an adaptive control may take beside its label (the accessory slot's cap). */

export interface ItemProps {
    testID?: string;
    /** A decorative layer beneath the row's content and independent controls. */
    underlay?: React.ReactNode;
    /** Native/web metadata on the primary row host, never on secondary controls. */
    /** RN Web metadata; native ViewProps intentionally omit this web-only carrier. */
    dataSet?: Readonly<Record<string, unknown>>;
    /** Imperative focus target for list owners that restore focus after row removal. */
    pressableRef?: React.Ref<React.ComponentRef<typeof Pressable>>;
    /** Where a string title is drawn, for a caller that measures it (the row a page header grows from). */
    titleRef?: React.Ref<React.ComponentRef<typeof Text>>;
    /** Semantic metadata on the title's existing text owner, including highlighted titles. */
    titleDataSet?: Readonly<Record<string, unknown>>;
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    subtitleTestID?: string;
    subtitleAccessory?: React.ReactNode;
    /** Full-width row content below identity and controls, before this row's divider. */
    bottomElement?: React.ReactNode;
    /**
     * `row` (default): the bottom content spans the row. `text`: it starts on the title's edge, past the
     * leading glyph or mark, so a row's own figures (a bar, a verdict) read as part of its text.
     */
    bottomElementInset?: 'row' | 'text';
    /**
     * Render `bottomElement` below the row's Pressable instead of inside it. Use this when the bottom
     * content holds its own controls (a repair button, a link): each keeps its own activation and the
     * row never nests one button inside another on React Native Web.
     */
    bottomElementOutsidePressable?: boolean;
    /** An inline mark after a string title, such as a "Beta" badge. */
    titleAccessory?: React.ReactNode;
    /**
     * A quiet qualifier on the title's line, after a string title (a project's Team, the suffix that tells two
     * same-named machines apart). It stays whole while the title shortens.
     */
    titleQualifier?: string | null;
    /**
     * The title line's end-aligned meta (a where-summary, a count): tabular, never truncated. The title gives way
     * first; when the two cannot share the line (`resolveHappierRowTitleMetaPlacement`) the meta wraps under the
     * title, end-aligned. Unlike `titleQualifier`, it is a column, not part of the title's identity.
     */
    titleMeta?: React.ReactNode;
    /**
     * Where the leading mark and the trailing accessory sit against a multi-line row: `center` (default, a
     * settings row's glyph spans its two lines) or `start`, level with the title's first line (a search hit
     * whose snippet runs beneath it and whose mark and status belong to the title).
     */
    contentAlign?: 'center' | 'start';
    /** An inline mark before a string subtitle, such as a status dot that flags trouble. */
    subtitleLeading?: React.ReactNode;
    /** Override the primitive title allowance; page labels grow, grouped labels keep their compact allowance. */
    titleLines?: number;
    /** Tints this query's matches in a string title: a search hit whose title is the very text that matched. */
    titleHighlightQuery?: string;
    /** Override the primitive subtitle allowance; 0 permits multiline, page descriptions grow by default. */
    subtitleLines?: number;
    detail?: string;
    /** Let the detail wrap in its trailing column, including on narrow rows. */
    wrapDetail?: boolean;
    detailTestID?: string;
    icon?: React.ReactNode;
    leftElement?: React.ReactNode;
    leftElementWhenHovered?: React.ReactNode;
    /**
     * Override the leading-element box size (width/height). Use when a custom
     * `leftElement` (e.g. a capacity gauge) is larger than the default icon box,
     * so the fixed slot doesn't clip its left edge or eat the title gap.
     */
    iconBoxSize?: number;
    /**
     * A picture of the thing itself (a window's or a screen's thumbnail, a file's preview) in place of
     * a glyph: drawn in the landscape leading-media box (`HAPPIER_PAGE_METRICS.rowLeadingMediaPx`),
     * clipped to the small radius with an ink hairline. The child fills the box (`width/height: 100%`).
     */
    leadingMedia?: React.ReactNode;
    /**
     * Which surface this row belongs to.
     *
     * A menu row is a transient list of choices, not a destination with room to breathe, so it takes
     * the flat {@link MENU_ROW_METRICS} — a smaller glyph on a shorter row — and ignores the list
     * density setting entirely. See that constant for why density has no business reaching a menu.
     */
    rowRole?: HappierCollectionRowRole;
    rightElement?: React.ReactNode;
    /**
     * The right element is facts (telemetry, a quiet word), not a control: when the title would fall below
     * its floor (the one a title meta keeps), the facts step aside whole and the name keeps the line. A
     * resizable collection rail narrowed to its minimum shows the name, not "NLD…" beside sparklines.
     */
    rightElementYields?: boolean;
    onPress?: (event?: import('react-native').GestureResponderEvent) => void;
    onDoublePress?: () => void;
    onLongPress?: () => void;
    onPressIn?: () => void;
    onMouseDownCapture?: (event: unknown) => void;
    onContextMenu?: (event: unknown) => void;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
    accessibilityRole?: AccessibilityRole;
    /** Overrides the checked state without changing the visual keyboard highlight. */
    accessibilityChecked?: boolean;
    /** Announces the active navigation destination without changing the row role. */
    accessibilityCurrent?: React.AriaAttributes['aria-current'];
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityLiveRegion?: ViewProps['accessibilityLiveRegion'];
    /**
     * Platform screen-reader actions on the row itself. Use when a row owns a
     * secondary action that must not become its own focus stop on touch.
     */
    accessibilityActions?: ViewProps['accessibilityActions'];
    onAccessibilityAction?: ViewProps['onAccessibilityAction'];
    /** Standard disclosure header state; other accessibility facts keep their existing owners. */
    accessibilityState?: Pick<NonNullable<ViewProps['accessibilityState']>, 'expanded'>;
    accessibilityExpanded?: boolean;
    webRole?: ViewProps['role'];
    /** Explicit web Tab-order override for a parent-owned composite widget. */
    webTabIndex?: 0 | -1;
    accessibilityLevel?: number;
    webKeyShortcuts?: string;
    onFocus?: () => void;
    /** The row (or a control inside it) lost focus: pairs with `onFocus` for focus-within reveals. */
    onBlur?: () => void;
    onKeyDown?: (event: { key?: string; nativeEvent?: { key?: string }; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; preventDefault?: () => void; target?: unknown; currentTarget?: unknown; defaultPrevented?: boolean }) => void;
    /** Web DOM id used by composite widgets such as listbox/aria-activedescendant. */
    webId?: string;
    /** Web ARIA position metadata for option-like rows. */
    accessibilityPositionInSet?: number;
    accessibilitySetSize?: number;
    disabled?: boolean;
    loading?: boolean;
    selected?: boolean;
    /** Visual keyboard focus state, intentionally separate from selected semantics. */
    focused?: boolean;
    /**
     * Whether the pointer resting on the row paints the hover fill (default true). A list that keeps one
     * highlight (SelectionList) turns it off: the pointer moves that highlight, so a second fill under a
     * stationary pointer would read as a second selected row.
     */
    hoverFill?: boolean;
    /**
     * Whether a selected row paints the selected fill (default true). A multiple-choice list marks its choices with a
     * check and keeps the fill for its one focused row, so several chosen rows never read as several highlights. The
     * row stays `selected` for its semantics either way.
     */
    selectedFill?: boolean;
    destructive?: boolean;
    /**
     * A row that is there but not active (turned off, offline, expired). Its title, subtitle and meta
     * step down one ink level together, so the subtitle never reads stronger than the title; its
     * controls keep their full strength. Orthogonal to `disabled`, which also stops interaction.
     */
    dimmed?: boolean;
    density?: 'comfortable' | 'cozy' | 'compact' | 'tight';
    /** Display mode: 'interactive' (default) enables press/hover feedback and chevron;
     *  'info' renders as a plain View with no press affordances (chevron is always hidden).
     *  Orthogonal to `disabled` — an info item stays at full opacity. */
    mode?: 'interactive' | 'info';
    style?: StyleProp<ViewStyle>;
    titleStyle?: StyleProp<TextStyle>;
    subtitleStyle?: StyleProp<TextStyle>;
    titleEllipsizeMode?: ItemTextEllipsizeMode;
    subtitleEllipsizeMode?: ItemTextEllipsizeMode;
    detailStyle?: StyleProp<TextStyle>;
    showChevron?: boolean;
    /**
     * Keep the navigation chevron visible even when `rightElement` is present.
     * By default a `rightElement` suppresses the chevron (the accessory owns the
     * right slot). Opt in for rows that BOTH carry a status accessory AND
     * navigate (e.g. a branch row with a "Worktree" badge that drills into a
     * reuse-or-create step), so the further-step affordance stays visible.
     */
    keepChevronWithRightElement?: boolean;
    /**
     * Render `rightElement` as a sibling of the row Pressable. Use this
     * when the right accessory contains its own Pressable/Switch/menu controls;
     * this keeps one activation owner per control on every platform and avoids
     * invalid nested-button markup on React Native Web.
     */
    rightElementOutsidePressable?: boolean;
    /**
     * The right accessory only draws (meters, a count, a status mark) and is part of the row's press, so the row
     * stays one named button on React Native Web ("name. subtitle") rather than an unnamed clickable group.
     */
    rightElementPassive?: boolean;
    /**
     * With `rightElementOutsidePressable`, on the web: the press target fades out over its last N px, where the
     * row's engaged actions stand over its title's tail (`resolveHappierRowEndFadeStyle`, the Session rows' fade).
     */
    pressTargetEndFadePx?: number;
    /**
     * Render `leftElement` as a sibling of the row Pressable, before it. Use this when the leading
     * slot holds its own controls (a reorder handle, a radio): each keeps its own activation and
     * the row never nests one button inside another on React Native Web.
     */
    leftElementOutsidePressable?: boolean;
    /**
     * Where the right accessory sits. `inline` (default) keeps it beside the
     * label; `stacked` always places it under the label at full width (visual pickers, text areas);
     * `adaptive` moves it under the label only when the row is too narrow for both (segmented controls,
     * field selects), using the row's own width in pages, grouped sections and popovers.
     */
    accessoryLayout?: 'inline' | 'stacked' | 'adaptive';
    /**
     * Whether this row's leading glyph makes its page section reserve the leading column for every row
     * (default). An add row's plus keeps to its own column: the rows it adds to keep their own edge.
     */
    reservesSectionLeadingColumn?: boolean;
    /**
     * How much of the row an inline accessory may take. `half` (default) holds it to half the row so a
     * long value never squeezes the label. `row` is for trailing facts and marks that must never be cut
     * (a picker row's free space, CLI glyphs, star and selected check): the accessory takes what it needs
     * and the label gives way with an ellipsis.
     */
    accessoryMaxWidth?: 'half' | 'row';
    /**
     * The adaptive accessory is a page select field. In a narrow pane column where the label's column
     * and the field's narrowest trigger still fit, the field drops to its content width and stays
     * trailing its label instead of moving beneath it; on a phone it moves beneath (the phone rule).
     */
    fieldAccessory?: boolean;
    /** With `fieldAccessory`: width of sibling controls sharing the accessory slot (a glyph and its gap), kept out of the field's room. */
    fieldAccessorySiblingPx?: number;
    showDivider?: boolean;
    dividerInset?: number;
    pressableStyle?: StyleProp<ViewStyle>;
    copy?: boolean | string;
    /** @internal Assigned by ItemGroup for named radio-group keyboard navigation. */
    itemGroupRadioIndex?: number;
}

/**
 * The menu role's row box, applied over whichever density styles the row would otherwise take.
 *
 * Plain objects rather than stylesheet entries because they carry no theme and must win the cascade
 * wherever they are appended; see {@link MENU_ROW_METRICS} for why a menu ignores density at all.
 */
const MENU_ROW_HEIGHT_STYLE = { minHeight: MENU_ROW_METRICS.minHeightPx } as const;
/** A page directory row's edges (`PageDirectoryRowsContext`): its section title stands the heading's optical inset in from the rows' box. */
const DIRECTORY_ROW_EDGES = resolveHappierCatalogDirectoryRowEdges(PAGE_LIST_METRICS.headingOpticalInsetPx);
const DIRECTORY_ROW_CONTENT_STYLE = { paddingHorizontal: DIRECTORY_ROW_EDGES.contentInsetPx } as const;
const DIRECTORY_ROW_FILL_STYLE = { marginHorizontal: DIRECTORY_ROW_EDGES.fillInsetPx } as const;
/** A directory row's mark leads its column, so whatever its width it starts on the section title's edge. */
const DIRECTORY_ROW_LEADING_STYLE = { alignItems: 'flex-start' } as const;
const EMPTY_TRAILING_CELL_STYLE = { marginLeft: 0 } as const;
/** A catalog row's air above and below its text block (`HAPPIER_COLLECTION_LIST_METRICS.catalogRow`). */
const CATALOG_ROW_PADDING_STYLE = { paddingVertical: HAPPIER_COLLECTION_LIST_METRICS.catalogRow.paddingVertical } as const;
// A compact row in a side pane starts on the pane's text edge, the inset its header title and section labels use.
const PANE_ROW_INSET_STYLE = { paddingHorizontal: PANE_TEXT_INSET_PX } as const;
// A list row in a widget body stands on the body's edge: the frame's inset is the only one, so its glyph sits under
// the frame's mark and its meta on the frame's edge (lab `rw` C).
const BODY_EDGE_ROW_INSET_STYLE = { paddingHorizontal: 0 } as const;
// The inset too: a host menu row and a plugin menu row (and the state line among them) start on one edge. The
// highlight is the menu's edge-to-edge fill (MENU_ROW_SHAPE), so the words keep the menu's text edge inside it.
const MENU_ROW_PADDING_STYLE = {
    paddingVertical: MENU_ROW_METRICS.paddingVerticalPx,
    paddingHorizontal: MENU_ROW_SHAPE.paddingHorizontal,
} as const;
const MENU_ROW_HIGHLIGHT_SHAPE = { marginHorizontal: MENU_ROW_SHAPE.marginHorizontal, borderRadius: MENU_ROW_SHAPE.borderRadius } as const;

type PageRowStyles = Readonly<{
    box: Readonly<{ minHeight: number }>;
    padding: Readonly<{ paddingVertical: number }>;
    title: Readonly<Record<string, unknown>>;
    subtitle: Readonly<Record<string, unknown>>;
    detail: Readonly<Record<string, unknown>>;
    accessoryBleed: Readonly<{ marginVertical: number }>;
}>;

/** A hyphen between two characters: a name, id or date rather than a quantity. */
/**
 * A page row's `leftElement` box: as wide as an identity mark, set half the overhang into the row padding and half
 * into the gap, so a 20 glyph or a 24 avatar leaves the title on the column's edge, and a wider facepile grows it.
 */
const PAGE_IDENTITY_MARK_OVERHANG_PX = (PAGE_LIST_METRICS.rowIdentityMarkPx - PAGE_LIST_METRICS.rowLeadingColumnPx) / 2;
const PAGE_IDENTITY_MARK_STYLE = {
    width: 'auto',
    minWidth: PAGE_LIST_METRICS.rowIdentityMarkPx,
    height: 'auto',
    minHeight: PAGE_LIST_METRICS.rowLeadingColumnPx,
    marginLeft: -PAGE_IDENTITY_MARK_OVERHANG_PX,
    marginRight: PAGE_LIST_METRICS.rowLeadingGapPx - PAGE_IDENTITY_MARK_OVERHANG_PX,
} as const;
/** In a side pane the mark stands on the pane's text edge, so all of its overhang goes into the gap. */
const PAGE_IDENTITY_MARK_SIDE_PANE_STYLE = {
    ...PAGE_IDENTITY_MARK_STYLE,
    marginLeft: 0,
    marginRight: PAGE_LIST_METRICS.rowLeadingGapPx - 2 * PAGE_IDENTITY_MARK_OVERHANG_PX,
} as const;

const pageRowStylesByMetrics = new WeakMap<PageRowMetrics, PageRowStyles>();

const sheetRowInsetStyles = new Map<number, Readonly<{ paddingHorizontal: number }>>();

/** A sheet row's horizontal inset, one stable style object per inset. */
function resolveSheetRowInsetStyle(insetPx: number): Readonly<{ paddingHorizontal: number }> {
    const cached = sheetRowInsetStyles.get(insetPx);
    if (cached) return cached;
    const style = { paddingHorizontal: insetPx };
    sheetRowInsetStyles.set(insetPx, style);
    return style;
}

/** A page row's density styles, built once per resolved metrics object so style arrays stay stable. */
function resolvePageRowStyles(metrics: PageRowMetrics): PageRowStyles {
    const cached = pageRowStylesByMetrics.get(metrics);
    if (cached) return cached;
    const styles: PageRowStyles = {
        box: { minHeight: metrics.minHeightPx },
        padding: { paddingVertical: metrics.paddingVerticalPx },
        title: { ...metrics.title, ...Typography.default(metrics.titleWeight) },
        subtitle: { ...metrics.subtitle },
        // A value summary reads at the title's size, in the regular face.
        detail: { ...metrics.title },
        // A trailing control's box may use the row's padding band: a switch's 44px focus and hit box
        // around its 22px track then no longer adds to the row, which keeps the height its text sets.
        // A control taller than text plus padding still grows the row; nothing is clipped.
        accessoryBleed: { marginVertical: -metrics.paddingVerticalPx },
    };
    pageRowStylesByMetrics.set(metrics, styles);
    return styles;
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: ITEM_ROW_PADDING_HORIZONTAL.comfortable,
        minHeight: Platform.select({ ios: 44, default: 56 }),
    },
    containerAlignStart: {
        alignItems: 'flex-start',
    },
    containerCompact: {
        paddingHorizontal: ITEM_ROW_PADDING_HORIZONTAL.compact,
        // Compact rows are used heavily in right rails (files/SCM) and should feel editor-like on web/tablet.
        // Keep iOS slightly taller for touch affordance, but reduce desktop web density.
        // The dense row of the spacing rhythm on pointer platforms (`HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight`).
        minHeight: Platform.select({ ios: 38, default: HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight }),
    },
    containerCozy: {
        paddingHorizontal: ITEM_ROW_PADDING_HORIZONTAL.cozy,
        minHeight: Platform.select({ ios: 42, default: 44 }),
    },
    containerTight: {
        paddingHorizontal: ITEM_ROW_PADDING_HORIZONTAL.tight,
        // Tight density is reserved for file trees / editor-like lists where users expect high information density.
        // Keep iOS sufficiently tall for touch affordance.
        minHeight: Platform.select({ ios: 36, default: 24 }),
    },
    containerWithSubtitle: {
        paddingVertical: ITEM_ROW_WITH_SUBTITLE_PADDING_VERTICAL_PX.comfortable,
    },
    containerWithSubtitleCompact: {
        paddingVertical: ITEM_ROW_WITH_SUBTITLE_PADDING_VERTICAL_PX.compact,
    },
    containerWithSubtitleCozy: {
        paddingVertical: ITEM_ROW_WITH_SUBTITLE_PADDING_VERTICAL_PX.cozy,
    },
    containerWithSubtitleTight: {
        paddingVertical: ITEM_ROW_WITH_SUBTITLE_PADDING_VERTICAL_PX.tight,
    },
    containerWithoutSubtitle: {
        paddingVertical: Platform.select({ ios: 12, default: 16 }),
    },
    containerWithoutSubtitleCompact: {
        paddingVertical: Platform.select({ ios: 8, default: 5 }),
    },
    containerWithoutSubtitleCozy: {
        paddingVertical: Platform.select({ ios: 10, default: 10 }),
    },
    containerWithoutSubtitleTight: {
        paddingVertical: Platform.select({ ios: 8, default: 2 }),
    },
    leadingMedia: {
        overflow: 'hidden',
        borderRadius: HAPPIER_RADIUS_V1.sm,
        borderCurve: 'continuous',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.subtle,
        backgroundColor: theme.colors.surface.inset,
    },
    iconContainer: {
        marginRight: theme.space.s12,
        width: ITEM_ICON_BOX_SIZE.comfortable,
        height: ITEM_ICON_BOX_SIZE.comfortable,
        alignItems: 'center',
        justifyContent: 'center',
        // Optical, not geometric — see ICON_LABEL_OPTICAL_NUDGE_STYLE.
        ...ICON_LABEL_OPTICAL_NUDGE_STYLE,
    },
    iconContainerCompact: {
        // The list's row gap (the gap owner the text and divider insets read), never a second number.
        marginRight: ITEM_ICON_MARGIN_RIGHT.compact,
        width: ITEM_ICON_BOX_SIZE.compact,
        height: ITEM_ICON_BOX_SIZE.compact,
    },
    iconContainerCozy: {
        marginRight: theme.space.s12,
        width: ITEM_ICON_BOX_SIZE.cozy,
        height: ITEM_ICON_BOX_SIZE.cozy,
    },
    iconContainerTight: {
        marginRight: theme.space.s8,
        width: ITEM_ICON_BOX_SIZE.tight,
        height: ITEM_ICON_BOX_SIZE.tight,
    },
    centerContent: {
        flex: 1,
        minWidth: 0,
        justifyContent: 'center',
    },
    labelBand: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        minWidth: 0,
    },
    labelBandStacked: {
        flex: undefined,
        alignSelf: 'stretch',
    },
    title: {
        ...ITEM_TITLE_TEXT_METRICS.comfortable,
    },
    titleCompact: {
        ...ITEM_TITLE_TEXT_METRICS.compact,
    },
    // A catalog row's name is its one anchor over the description (lab y:list: label, a weight up).
    titleCatalog: {
        ...ITEM_TITLE_TEXT_METRICS.cozy,
        ...Typography.default('medium'),
    },
    titleCozy: {
        ...ITEM_TITLE_TEXT_METRICS.cozy,
    },
    titleTight: {
        ...ITEM_TITLE_TEXT_METRICS.tight,
    },
    titleNormal: {
        color: theme.colors.text.primary,
    },
    // A fact's label (an inspector row, a `facts` section) steps back and its value leads (`PageRowMetrics.valueLeads`).
    titleFact: {
        color: theme.colors.text.secondary,
    },
    detailFact: {
        color: theme.colors.text.primary,
    },
    titleSelected: {
        color: theme.colors.text.primary,
    },
    titleSelectedInColumn: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    titleDestructive: {
        color: theme.colors.state.danger.textForeground,
    },
    // A dimmed row (`dimmed`) steps every text line down one ink level, keeping title over subtitle.
    titleDimmed: {
        color: theme.colors.text.secondary,
    },
    subtitleDimmed: {
        color: theme.colors.text.tertiary,
    },
    // The composed subtitle's container already carries the subtitle's offset.
    subtitleComposedText: {
        marginTop: 0,
    },
    inlineMarkRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        minWidth: 0,
    },
    subtitleMarkRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s6,
        minWidth: 0,
    },
    subtitleMarkSlot: {
        justifyContent: 'center',
    },
    inlineMarkText: {
        flexShrink: 1,
        minWidth: 0,
    },
    // The title's accessory keeps its natural width so its measure is what the label really needs.
    titleTrailingMeasure: {
        flexShrink: 0,
    },
    titleMeta: {
        flexShrink: 0,
        marginLeft: 'auto',
        paddingLeft: HAPPIER_ROW_TITLE_META_GAP_PX,
        alignItems: 'flex-end',
    },
    // A meta that no longer fits beside the name reads as the row's next line, on the text edge like a
    // description, never as a right-aligned orphan under the name (PHONE-ROWS-HUNT-1113, QA-RERUN F4/F13).
    titleMetaBeneath: {
        alignItems: 'flex-start',
    },
    // Beneath the name the meta has the row's width and no more: a long Machine list ellipsizes, never runs past
    // the screen (QA-45 F5).
    titleMetaBeneathCell: {
        maxWidth: '100%',
        flexShrink: 1,
        marginLeft: 0,
        paddingLeft: 0,
        alignItems: 'flex-start',
    },
    titleMetaContent: {
        maxWidth: '100%',
        flexShrink: 1,
    },
    titleMetaText: {
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    // A column's described row: its title meta joins the description line, which yields first.
    columnMetaLine: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
    },
    // The description line (a speaking status and its fact) keeps its words; the joined quiet meta yields
    // first, so a narrow rail reads "Unreachable · API key · 0 sa…", never "Unreachable… · 0 saved models".
    columnMetaLead: {
        flexShrink: 0,
        maxWidth: '100%',
        minWidth: 0,
    },
    columnMetaText: {
        flexShrink: 1,
        minWidth: 0,
        fontVariant: ['tabular-nums'],
    },
    // The qualifier as a run inside a wrapping title: the meta face and ink, flowing after the name's last word.
    titleQualifierInline: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    // Measured whole: the out-of-flow measure has no line to take half of.
    titleQualifierMeasure: {
        maxWidth: undefined,
    },
    titleQualifier: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        // The title keeps its whole name up to the title floor first (`ITEM_TITLE_META_TITLE_MIN_PX`, owner choice
        // "floor" 2026-11-18); the qualifier then shows what fits, never more than half the line.
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '50%',
    },
    subtitle: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
        ...ITEM_SUBTITLE_TEXT_METRICS.comfortable,
        marginTop: Platform.select({ ios: 2, default: 0 }),
    },
    subtitleCompact: {
        ...ITEM_SUBTITLE_TEXT_METRICS.compact,
        marginTop: Platform.select({ ios: 1, default: 0 }),
    },
    subtitleCatalog: {
        ...ITEM_SUBTITLE_TEXT_METRICS.comfortable,
        marginTop: HAPPIER_COLLECTION_LIST_METRICS.catalogRow.rowGap,
    },
    subtitleCozy: {
        ...ITEM_SUBTITLE_TEXT_METRICS.cozy,
        marginTop: Platform.select({ ios: 1, default: 0 }),
    },
    subtitleTight: {
        ...ITEM_SUBTITLE_TEXT_METRICS.tight,
        marginTop: Platform.select({ ios: 1, default: 0 }),
    },
    rightSection: {
        flexDirection: 'row',
        alignItems: 'center',
        maxWidth: '50%',
        minWidth: 0,
        flexShrink: 1,
        marginLeft: theme.space.s8,
    },
    splitPressable: {
        flex: 1,
        alignSelf: 'stretch',
        justifyContent: 'center',
    },
    splitPressableInner: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    // Stacked split row: the label pressable and the control below it share the row's vertical
    // padding (top on the label, bottom on the control) and the page gap between them.
    splitPressableStacked: {
        flexGrow: 0,
        flexShrink: 0,
        flexBasis: 'auto',
    },
    splitPressableInnerStacked: {
        flexGrow: 0,
        flexBasis: 'auto',
        paddingBottom: 0,
    },
    splitRightSectionStacked: {
        paddingTop: 0,
    },
    // The row's meta (a time, a count, a value summary) in the shared right-aligned tabular column.
    detail: {
        ...Typography.default('regular'),
        ...HAPPIER_META_COLUMN_STYLE,
        color: theme.colors.text.secondary,
        ...ITEM_TITLE_TEXT_METRICS.comfortable,
        flexShrink: 1,
    },
    detailWrapped: Platform.OS === 'web' ? ({ overflowWrap: 'anywhere' } as TextStyle) : {},
    detailCozy: {
        ...ITEM_TITLE_TEXT_METRICS.cozy,
    },
    detailCompact: {
        ...ITEM_TITLE_TEXT_METRICS.compact,
    },
    detailTight: {
        ...ITEM_TITLE_TEXT_METRICS.tight,
    },
    // The colour is the divider's own prop (`HappierDivider`): a background here would override it.
    divider: {
        height: Platform.select({ ios: 0.33, default: 0 }),
    },
    // Configuration-page anatomy (see listPresentation.tsx / pageListMetrics.ts). The row's box and
    // type come from its density (`resolvePageRowMetrics`); only what does not vary lives here.
    pageContainer: {
        paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    },
    pageContainerStacked: {
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: theme.space.s10,
    },
    accessoryMeasure: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
    },
    accessoryYielded: {
        display: 'none',
    },
    accessoryInline: {
        // Bound the accessory's root to its slot. Its internal flexible content can then
        // shrink around controls instead of painting past the row's trailing edge.
        minWidth: 0,
        maxWidth: '100%',
        flexShrink: 1,
    },
    // The detail's natural one-line width, measured against the whole row and never seen.
    detailMeasure: {
        position: 'absolute',
        left: 0,
        top: 0,
        opacity: 0,
        pointerEvents: 'none',
    },
    accessoryMeasureStacked: {
        alignSelf: 'stretch',
    },
    rightSectionField: {
        maxWidth: '100%',
    },
    rightSectionStacked: {
        maxWidth: '100%',
        marginLeft: 0,
        alignSelf: 'stretch',
        // A stacked control spans the row: in a horizontal section it would shrink to its narrowest
        // width, and a wrapping tile row would then break onto one tile per line.
        flexDirection: 'column',
        alignItems: 'stretch',
    },
}));

function ItemRow(props: ItemProps & Readonly<{
    /** How far this row reaches past its bare section's content (the `Item` wrapper's bleed); its hairline stops there. */
    rowBleedPx?: number;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const selectionContext = React.useContext(ItemGroupSelectionContext);
    const rowPosition = useItemGroupRowPosition();

    // Platform-specific measurements
    const isIOS = Platform.OS === 'ios';
    const isAndroid = Platform.OS === 'android';
    const isWeb = Platform.OS === 'web';
    const hoverBackgroundColor = theme.colors.surface.hover;
    const copyFeedback = useHappierCopyFeedback();
    
    const {
        testID,
        underlay,
        dataSet,
        pressableRef,
        titleRef,
        titleDataSet,
        title,
        subtitle,
        subtitleTestID,
        subtitleAccessory,
        bottomElement,
        bottomElementInset,
        bottomElementOutsidePressable = false,
        titleAccessory,
        titleQualifier,
        titleMeta,
        contentAlign,
        subtitleLeading,
        titleLines,
        titleHighlightQuery,
        subtitleLines,
        detail,
        wrapDetail = false,
        detailTestID,
        icon,
        leftElement: leftElementProp,
        leftElementWhenHovered,
        iconBoxSize: iconBoxSizeProp,
        leadingMedia,
    rowRole: rowRoleProp,
        rightElement: rightElementProp,
        onPress: onPressProp,
        onDoublePress,
        onLongPress,
        onPressIn,
        onMouseDownCapture,
        onContextMenu,
        onHoverIn,
        onHoverOut,
        accessibilityRole: accessibilityRoleProp,
        accessibilityChecked: accessibilityCheckedProp,
        accessibilityCurrent,
        accessibilityLabel: accessibilityLabelProp,
        accessibilityHint,
        accessibilityLiveRegion,
        accessibilityActions,
        onAccessibilityAction,
        accessibilityExpanded: explicitAccessibilityExpanded,
        accessibilityState,
        webRole: webRoleProp,
        webTabIndex,
        accessibilityLevel,
        webKeyShortcuts,
        onFocus,
        onBlur,
        onKeyDown,
        webId,
        accessibilityPositionInSet,
        accessibilitySetSize,
        disabled: disabledProp,
        loading,
        selected,
        focused,
        hoverFill = true,
        selectedFill = true,
        destructive,
        dimmed = false,
        density,
        mode,
        style,
        titleStyle,
        subtitleStyle,
        titleEllipsizeMode,
        subtitleEllipsizeMode,
        detailStyle,
        showChevron = true,
        keepChevronWithRightElement = false,
        rightElementOutsidePressable = false,
        rightElementPassive = false,
        pressTargetEndFadePx,
        leftElementOutsidePressable = false,
        rightElementYields = false,
        accessoryLayout = 'inline',
        accessoryMaxWidth = 'half',
        reservesSectionLeadingColumn = true,
        fieldAccessory = false,
        fieldAccessorySiblingPx,
        showDivider: showDividerProp,
        dividerInset = isIOS ? 15 : 16,
        pressableStyle,
        copy,
        itemGroupRadioIndex,
    } = props;
    // A row of a grouped section laid out as a menu section (a popover's section) is a menu row, with
    // no hairline between rows, unless it says otherwise.
    const menuSectionRow = React.useContext(MenuSectionRowsContext);
    const rowRole = rowRoleProp ?? (menuSectionRow ? 'menu' : undefined);
    const showDivider = showDividerProp ?? !menuSectionRow;
    // Leading media is a sized identity mark: it takes the media box in every row style, and the
    // row's leading column (titles, dividers, stacked controls) follows the box's width.
    const leadingMediaBox = leadingMedia != null ? PAGE_LIST_METRICS.rowLeadingMediaPx : null;
    const leftElement = leadingMediaBox ? (
        <View style={[styles.leadingMedia, { width: leadingMediaBox.width, height: leadingMediaBox.height }]}>{leadingMedia}</View>
    ) : leftElementProp;
    const iconBoxSize = leadingMediaBox ? leadingMediaBox.width : iconBoxSizeProp;
    // A switch row (owner ruling 2026-10-12): with no press of its own, a row whose accessory is a
    // switch toggles it from anywhere and is itself the one `switch` control; the switch only draws.
    const rowSwitch = !onPressProp && !props.onDoublePress && !rightElementOutsidePressable && mode !== 'info'
        ? readItemRowSwitch(rightElementProp)
        : null;
    const toggleRowSwitch = React.useCallback(() => {
        if (!rowSwitch || rowSwitch.disabled) return;
        // Returned, so an async toggle puts the row through the pressable's pending lifecycle.
        return rowSwitch.onValueChange?.(!rowSwitch.value);
    }, [rowSwitch]);
    const onPress = rowSwitch ? toggleRowSwitch : onPressProp;
    const disabled = rowSwitch ? disabledProp === true || rowSwitch.disabled : disabledProp;
    const accessibilityRole = rowSwitch ? 'switch' as AccessibilityRole : accessibilityRoleProp;
    const webRole = rowSwitch ? 'switch' : webRoleProp;
    const accessibilityChecked = rowSwitch ? rowSwitch.value : accessibilityCheckedProp;
    const accessibilityLabel = rowSwitch
        ? accessibilityLabelProp ?? rowSwitch.label ?? buildActionRowAccessibilityLabel([title])
        : accessibilityLabelProp;
    const rightElement = rowSwitch
        ? <ItemRowOwnsSwitchProvider value>{rightElementProp}</ItemRowOwnsSwitchProvider>
        : rightElementProp;
    const accessibilityExpanded = explicitAccessibilityExpanded ?? accessibilityState?.expanded;
    const webTestIdProps = isWeb && testID
        ? ({ 'data-testid': testID } as const)
        : undefined;
    const titleLabel = typeof title === 'string' || typeof title === 'number' ? String(title) : '';

    // Handle copy functionality
    const writeClipboard = useClipboardWrite(undefined, { enabled: Boolean(copy) });
    const handleCopy = React.useCallback(async () => {
        if (!copy) return false;
        
        let textToCopy: string;
        const subtitleText = typeof subtitle === 'string' ? subtitle : null;
        
        if (typeof copy === 'string') {
            // If copy is a string, use it directly
            textToCopy = copy;
        } else {
            // If copy is true, try to figure out what to copy
            // Priority: detail > subtitle > title
            textToCopy = detail || subtitleText || titleLabel;
        }
        
        const copied = await writeClipboard(textToCopy);
        if (!copied) {
            Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
            return false;
        }
        copyFeedback.markCopied();
        return true;
    }, [copy, copyFeedback, detail, subtitle, titleLabel, writeClipboard]);
    
    const longPressConsumedRef = React.useRef(false);
    const [isSplitPrimaryPressed, setIsSplitPrimaryPressed] = React.useState(false);

    // Handle long press for copy functionality
    const handlePressIn = React.useCallback(() => {
        longPressConsumedRef.current = false;
        if ((rightElementOutsidePressable && rightElement) || (leftElementOutsidePressable && leftElement)) setIsSplitPrimaryPressed(true);
        onPressIn?.();
    }, [leftElement, leftElementOutsidePressable, onPressIn, rightElement, rightElementOutsidePressable]);
    const handlePressOut = React.useCallback(() => {
        setIsSplitPrimaryPressed(false);
    }, []);
    // A split row's activation is only part of the row: its keyboard ring is drawn on the whole row (with
    // the trailing control inside it), so the row hears the activation's focus rather than ringing it alone.
    const [isSplitPrimaryFocused, setIsSplitPrimaryFocused] = React.useState(false);
    const handleSplitFocus = React.useCallback(() => {
        setIsSplitPrimaryFocused(true);
        onFocus?.();
    }, [onFocus]);
    const handleSplitBlur = React.useCallback(() => {
        setIsSplitPrimaryFocused(false);
        onBlur?.();
    }, [onBlur]);
    
    const webDoublePressHandledAtMsRef = React.useRef<number>(0);
    const webLastPressAtMsRef = React.useRef<number | null>(null);

    const handlePress = React.useCallback((event?: any) => {
        if (longPressConsumedRef.current) {
            longPressConsumedRef.current = false;
            return;
        }
        if (isWeb && onDoublePress) {
            const nowMs = Date.now();
            if (webDoublePressHandledAtMsRef.current > 0 && nowMs - webDoublePressHandledAtMsRef.current < 240) {
                event?.preventDefault?.();
                event?.stopPropagation?.();
                return;
            }
            const lastMs = webLastPressAtMsRef.current;
            webLastPressAtMsRef.current = nowMs;

            const detail = event?.nativeEvent?.detail ?? event?.detail;
            if (detail === 2) {
                webDoublePressHandledAtMsRef.current = Date.now();
                webLastPressAtMsRef.current = null;
                event?.preventDefault?.();
                event?.stopPropagation?.();
                onDoublePress();
                return;
            }

            if (lastMs != null && nowMs - lastMs < 320) {
                webDoublePressHandledAtMsRef.current = nowMs;
                webLastPressAtMsRef.current = null;
                event?.preventDefault?.();
                event?.stopPropagation?.();
                onDoublePress();
                return;
            }
        }
        if (copy && isWeb && !onPress) {
            void handleCopy();
            return;
        }

        onPress?.(event);
    }, [copy, handleCopy, isWeb, onDoublePress, onPress]);

    const handleLongPress = React.useCallback(() => {
        longPressConsumedRef.current = true;
        if (onLongPress) {
            onLongPress();
            return;
        }
        void handleCopy();
    }, [handleCopy, onLongPress]);

    const isInfoMode = mode === 'info';
    const hasPrimaryPressAction = Boolean(onPress || onDoublePress || onLongPress);
    const hasCopyLongPress = Boolean(copy && !isWeb && !onPress);
    const hasCopyPress = Boolean(copy && isWeb && !onPress);
    const isInteractive = !isInfoMode && (hasPrimaryPressAction || hasCopyLongPress || hasCopyPress);
    const isRadioRole = accessibilityRole === 'radio' || webRole === 'radio';
    // A switch row shares the checkbox path: a checked state, Space/Enter, one press.
    const isCheckboxRole = accessibilityRole === 'checkbox' || webRole === 'checkbox' || rowSwitch !== null;
    // A row is one named button on the web unless an accessory inside its press may hold controls of its own.
    const inferredInteractiveWebRole = isWeb
        ? (webRole ?? (isRadioRole ? 'radio' : isCheckboxRole ? 'checkbox' : (accessibilityRole === 'button' || !rightElement || rightElementOutsidePressable || rightElementPassive ? 'button' : undefined)))
        : undefined;
    const passiveWebRole = isWeb
        ? (webRole ?? (isRadioRole ? 'radio' : isCheckboxRole ? 'checkbox' : undefined))
        : undefined;
    const groupItem = useHappierItemGroupItemBehavior({
        role: isRadioRole ? 'radio' : inferredInteractiveWebRole === 'option' ? 'option' : 'button',
        itemGroupRadioIndex,
        disabled,
        busy: loading,
    });
    const isGroupedRadio = groupItem.grouped;
    const assignPressableRef = React.useCallback((target: React.ComponentRef<typeof Pressable> | null) => {
        const refs = [isGroupedRadio ? groupItem.targetRef : null, pressableRef];
        for (const ref of refs) {
            if (typeof ref === 'function') ref(target);
            else if (ref && 'current' in ref) (ref as React.MutableRefObject<typeof target>).current = target;
        }
    }, [groupItem.targetRef, isGroupedRadio, pressableRef]);
    const isKeyboardActivatableRole = isRadioRole
        || isCheckboxRole
        || inferredInteractiveWebRole === 'option'
        || inferredInteractiveWebRole === 'button';
    const handleSemanticKeyDown = React.useCallback((event: any) => {
        if (!isWeb || !isKeyboardActivatableRole || disabled || loading) return;
        const key = event?.nativeEvent?.key ?? event?.key;
        if (groupItem.onKeyDown(key)) {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            return;
        }
        if (isGroupedRadio && key === 'Enter') return;
        if (key !== ' ' && key !== 'Spacebar' && key !== 'Enter') return;
        event?.preventDefault?.();
        handlePress(event);
    }, [
        disabled,
        handlePress,
        isGroupedRadio,
        isKeyboardActivatableRole,
        isCheckboxRole,
        isWeb,
        loading,
        groupItem,
    ]);

    const densityInputs = useItemDensityInputs(density);
    const sectionRowRole = useSectionRowRole();
    const isCatalogRow = rowRole === 'catalogRow';
    // A catalog row draws the catalog geometry on a page. In a column (a rail, a phone's collection page) it
    // keeps its content on the column's compact row instead: the column's glyph box, one line each, the
    // described floor, so every row of the column shares one glyph axis, one title edge and one pitch.
    const inCollectionColumn = useHappierCollectionListRow();
    const catalogGeometry = isCatalogRow && !inCollectionColumn;
    const columnDescribedRow = isCatalogRow && inCollectionColumn;
    const requestedDensity = densityInputs.resolved;
    const hasSubtitleContent = Boolean(subtitle || subtitleAccessory);
    const sharedItemBehavior = resolveHappierItemBehavior({
        role: isRadioRole ? 'radio' : inferredInteractiveWebRole === 'option' ? 'option' : 'button',
        selected,
        focused,
        selectableItemCount: selectionContext?.selectableItemCount,
        disabled,
        busy: loading,
        expanded: accessibilityExpanded,
        groupedIndex: isGroupedRadio ? itemGroupRadioIndex : undefined,
        tabStopIndex: groupItem.tabStopIndex,
        density: requestedDensity,
        hasPrimaryAction: isInteractive,
        hasAccessory: Boolean(rightElement),
        accessoryOutsidePressable: rightElementOutsidePressable,
        showNavigationAccessory: showChevron,
        keepNavigationAccessoryWithAccessory: keepChevronWithRightElement,
        // A section's last row never draws a hairline, even when a wrapping row component did not
        // forward the `showDivider` its group injected (the row's position is the group's fact).
        showDivider: !isCatalogRow && showDivider && rowPosition?.isLast !== true,
        // A sheet row is ruled only when it has two or more lines (the one list-row rule).
        multiline: hasSubtitleContent,
    });
    const resolvedDensity = sharedItemBehavior.density;

    // Only show the navigation chevron when the row has an actual "tap to do something" affordance.
    // Long-press copy rows (mobile) and long-press-only rows should not look like navigation.
    // A `rightElement` normally claims the right slot and hides the chevron, UNLESS the row opts
    // into `keepChevronWithRightElement` (badge + chevron together).
    const showAccessory = !isInfoMode
        && Boolean(onPress || onDoublePress)
        && sharedItemBehavior.navigationAccessoryVisible;
    const showSelectedBackground = sharedItemBehavior.selectionVisible && (selectedFill || focused === true);

    // A selected column row carries its state in its title's weight too, as the column's navigation rows do.
    const titleColorBase = destructive ? styles.titleDestructive
        : selected ? (inCollectionColumn ? styles.titleSelectedInColumn : styles.titleSelected)
        : styles.titleNormal;
    const isCozy = resolvedDensity === 'cozy';
    const isCompact = resolvedDensity === 'compact';
    const isTight = resolvedDensity === 'tight';
    const resolvedIconDensity = isTight ? 'tight' : isCompact ? 'compact' : isCozy ? 'cozy' : 'comfortable';
    const isMenuRow = rowRole === 'menu';
    const listPresentation = useListPresentation();
    const sidePaneTextEdge = useSidePaneTextEdge();
    const isPageRow = listPresentation === 'page' && !isMenuRow && !isCatalogRow;
    const bodyEdgeRow = useWidgetBodyRowEdge() && !isPageRow && !isMenuRow && !isCatalogRow;
    const paneRow = sidePaneTextEdge && !bodyEdgeRow && isCompact && !isPageRow && !isMenuRow && !isCatalogRow;
    // A page row is drawn at the user's density; a section's `compact` asks for its list shape.
    const pageRowMetrics = isPageRow
        ? resolvePageRowMetrics({
            ...resolvePageRowDensityInput({
                preferred: densityInputs.preferred,
                requested: resolvedDensity,
                requestedExplicitly: densityInputs.requested,
            }),
            role: sectionRowRole,
        })
        : null;
    const pageRowStyles = pageRowMetrics ? resolvePageRowStyles(pageRowMetrics) : null;
    const factRow = pageRowMetrics?.valueLeads === true && !destructive;
    const titleColor = dimmed && !destructive ? styles.titleDimmed : factRow ? styles.titleFact : titleColorBase;
    // Subtitle and meta step down with the title, so a dimmed row keeps its title over its quiet line.
    const subtitleInkStyle = dimmed ? styles.subtitleDimmed : null;
    const [isNarrowRow, setIsNarrowRow] = React.useState(false);
    const [rowWidthPx, setRowWidthPx] = React.useState<number | null>(null);
    const [accessoryWidthPx, setAccessoryWidthPx] = React.useState<number | null>(null);
    const pageSheetContext = useHappierPageSection();
    const pageSheet = isMenuRow || isCatalogRow ? null : pageSheetContext;
    // A row on a drawn sheet rounds its fill with the sheet's corners; a row laid flat on a page or a pane is
    // full-bleed, so its hover, press and selection fills are square and span the whole row.
    const bareSectionRow = React.useContext(BareSectionRowsContext) && !isMenuRow && !isCatalogRow;
    // A page directory's row (Store Installed), described or title-only, stands on its section's edges by the one
    // catalog-directory rule the Collection directory's rows take.
    const directoryEdges = React.useContext(PageDirectoryRowsContext) && !isMenuRow ? DIRECTORY_ROW_EDGES : null;
    const flatRow = pageSheet?.framed === false || bareSectionRow;
    const groupCornerRadius = flatRow ? 0 : GROUPED_SURFACE_RADIUS_PX;
    const pageRowInsetPx = pageSheet?.rowInsetPx;
    // An independently activated page operation follows the phone rule even when a caller asks
    // for inline placement. Grouped controls retain their explicitly chosen composition. A catalog row's
    // trailing (count, menu, fix) never leaves its line: its description yields instead (S10 ST-5).
    const pageOperation = isPageRow && rightElementOutsidePressable && accessoryLayout === 'inline';
    const adaptiveAccessory = accessoryLayout === 'adaptive' || pageOperation;
    const hasAdaptiveDetail = isPageRow && Boolean(detail) && !wrapDetail;
    const measuresRowWidth = adaptiveAccessory || hasAdaptiveDetail;
    const handleRowLayout = React.useCallback((event: LayoutChangeEvent) => {
        const widthPx = event.nativeEvent.layout.width;
        if (!Number.isFinite(widthPx) || widthPx <= 0) return;
        // The shared row rule: narrower than the label's column beside an inline field (a phone sheet).
        const next = isHappierPageRowNarrow(widthPx);
        setIsNarrowRow((current) => (current === next ? current : next));
        setRowWidthPx((current) => (current === widthPx ? current : widthPx));
    }, []);
    // The one row-accessory rule (`isHappierPageRowAccessoryStacked`): an operation (a button) stays on
    // its label's line while the label keeps its column; an adaptive control moves beneath on a narrow
    // row (never in a menu); either moves beneath when wider than its share of a wide row.
    // A page row's detail is the phone rule's "short value": it stays on its label's line while the
    // label keeps its column, and moves beneath the title (unclamped, where a description sits) once
    // its natural width would squeeze the label below that column. Only a narrow row measures it: on
    // a wider row the label always keeps its column beside a detail held to half the row.
    // The label's column is the smaller of the shared column and what a short text label really
    // needs (its natural width plus the trailing chevron), so "Role · Orchestrator" stays on one line
    // in a narrow pane instead of stacking beside 160px of empty label column.
    const [detailWidthPx, setDetailWidthPx] = React.useState<number | null>(null);
    const [titleNaturalWidthPx, setTitleNaturalWidthPx] = React.useState<number | null>(null);
    // A title holds min(its natural width, the title floor) before its qualifier or a quiet end fact ellipsizes
    // (owner choice "floor", UI refinements 2026-11-18 14:58Z); layout reports whole pixels, so the name needs one pixel
    // more than its measured width not to clip.
    const [titleFloorPx, setTitleFloorPx] = React.useState<number | null>(null);
    // A repeated layout of the same name (a recycled row, a resize) publishes nothing: an unchanged floor never sets state.
    const titleFloorRef = React.useRef<number | null>(null);
    const handleTitleFloorMeasureLayout = React.useCallback((event: LayoutChangeEvent) => {
        const widthPx = event.nativeEvent.layout.width;
        if (!Number.isFinite(widthPx) || widthPx <= 0) return;
        const floorPx = Math.min(Math.ceil(widthPx) + 1, ITEM_TITLE_META_TITLE_MIN_PX);
        if (titleFloorRef.current === floorPx) return;
        titleFloorRef.current = floorPx;
        setTitleFloorPx(floorPx);
    }, []);
    const titleFloorStyle = React.useMemo(
        () => (titleFloorPx === null ? null : { minWidth: titleFloorPx }),
        [titleFloorPx],
    );
    // A passive end (facts that only draw: a folded Project's "2 environments", a state word) gives way to the name:
    // the content column holds the title floor, so the end facts ellipsize first. Controls never yield this way.
    const passiveFactsFloor = rightElementPassive && rightElement != null && (typeof title === 'string' || typeof title === 'number');
    const centerContentStyle = React.useMemo(
        () => (passiveFactsFloor && titleFloorStyle !== null ? [styles.centerContent, titleFloorStyle] : styles.centerContent),
        [passiveFactsFloor, styles.centerContent, titleFloorStyle],
    );
    const measuresDetail = hasAdaptiveDetail && isNarrowRow;
    // A field beside a short name needs only that name's room (see `resolveHappierPageRowFieldMaxWidth`).
    const measuresFieldLabel = isPageRow && fieldAccessory && isNarrowRow;
    const measuresTitle = (measuresDetail || measuresFieldLabel) && (typeof title === 'string' || typeof title === 'number');
    const [titleTrailingWidthPx, setTitleTrailingWidthPx] = React.useState<number | null>(null);
    // The room at which the field's value last filled its box (see `resolveHappierPageRowFieldMaxWidth`).
    const [fieldSaturatedAtPx, setFieldSaturatedAtPx] = React.useState<number | null>(null);
    const handleFieldSaturated = React.useCallback((maxWidthPx: number) => {
        setFieldSaturatedAtPx((current) => (current !== null && current >= maxWidthPx ? current : maxWidthPx));
    }, []);
    // A description under the name shares the label's column (see `resolveHappierPageRowFieldMaxWidth`).
    const described = subtitle != null && subtitle !== false && subtitle !== '';
    const fieldMaxWidthPx = React.useMemo(() => {
        if (!isPageRow || !fieldAccessory) return null;
        return resolveHappierPageRowFieldMaxWidth({
            rowWidthPx,
            rowInsetPx: pageRowInsetPx,
            titleNaturalWidthPx: measuresFieldLabel && measuresTitle ? titleNaturalWidthPx : null,
            described,
            ...(titleAccessory == null ? {} : { titleAccessoryWidthPx: titleTrailingWidthPx, titleAccessoryGapPx: theme.space.s8 }),
            ...(fieldAccessorySiblingPx === undefined ? {} : { siblingPx: fieldAccessorySiblingPx }),
            fieldSaturatedAtPx,
        });
    }, [fieldAccessory, fieldAccessorySiblingPx, fieldSaturatedAtPx, isPageRow, measuresFieldLabel, measuresTitle, pageRowInsetPx, rowWidthPx, described, theme.space.s8, titleAccessory, titleNaturalWidthPx, titleTrailingWidthPx]);
    const detailTrailingPx = theme.space.s8 + (rightElement != null || showAccessory ? 8 : 0)
        + (showAccessory ? ITEM_CHEVRON_SIZE[resolvedIconDensity] + theme.space.s4 : 0);
    // A page section reserves the leading column for all its rows when any row has an icon or mark.
    const reservesLeadingColumn = useSectionLeadingColumn(isPageRow && reservesSectionLeadingColumn && (icon != null || leftElement != null));
    const { beneath: detailBeneath, inlineMaxWidthPx: detailInlineMaxWidthPx } = resolveHappierPageRowDetailLayout({
        rowWidthPx: measuresDetail ? rowWidthPx : null,
        detailWidthPx,
        titleNaturalWidthPx: measuresTitle ? titleNaturalWidthPx : null,
        rowInsetPx: pageRowInsetPx ?? PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        leadingColumnWidthPx: reservesLeadingColumn || (isPageRow && (icon != null || leftElement != null))
            ? iconBoxSize ?? PAGE_LIST_METRICS.rowLeadingColumnPx : 0,
        trailingWidthPx: detailTrailingPx,
        detailGapPx: theme.space.s8,
    });
    const handleDetailLayout = React.useCallback((event: LayoutChangeEvent) => {
        const widthPx = event.nativeEvent.layout.width;
        if (!Number.isFinite(widthPx) || widthPx <= 0) return;
        setDetailWidthPx((current) => (current === widthPx ? current : widthPx));
    }, []);
    const handleTitleTrailingLayout = React.useCallback((event: LayoutChangeEvent) => {
        const widthPx = event.nativeEvent.layout.width;
        if (!Number.isFinite(widthPx) || widthPx <= 0) return;
        setTitleTrailingWidthPx((current) => (current === widthPx ? current : widthPx));
    }, []);
    const handleTitleMeasureLayout = React.useCallback((event: LayoutChangeEvent) => {
        const widthPx = event.nativeEvent.layout.width;
        if (!Number.isFinite(widthPx) || widthPx <= 0) return;
        setTitleNaturalWidthPx((current) => (current === widthPx ? current : widthPx));
    }, []);
    const stackAccessory = rightElement != null
        // A field held beside its label at its content width is capped below half the row, so neither
        // narrow-row rule applies to it.
        && (accessoryLayout === 'stacked' || (adaptiveAccessory && !isCatalogRow && fieldMaxWidthPx === null && (
            isHappierPageRowAccessoryStacked({
                kind: pageOperation ? 'operation' : 'adaptive',
                rowWidthPx,
                accessoryWidthPx,
                // Trailing facts and marks that are never cut (a picker row's check, glyphs, star) move by their
                // measured width alone, as in a menu: a lone check keeps its line on a phone.
                menuRow: isMenuRow || accessoryMaxWidth === 'row',
            }))));
    const stackAccessoryRef = React.useRef(stackAccessory);
    const fieldLayout = React.useMemo(() => ({
        maxWidthPx: fieldMaxWidthPx,
        stacked: stackAccessory,
        onFieldSaturated: handleFieldSaturated,
    }), [fieldMaxWidthPx, handleFieldSaturated, stackAccessory]);
    stackAccessoryRef.current = stackAccessory;
    // Yielding facts: the title's column and the facts' natural width decide, with the title-meta floor.
    const factsMeasure = React.useRef({ title: 0, titleNatural: Number.NaN, facts: 0, yielded: false });
    // A text title is measured out of flow; the rule waits for that width instead of assuming the floor.
    const titleMeasuredForFacts = React.useRef(false);
    titleMeasuredForFacts.current = rightElementYields && (typeof title === 'string' || typeof title === 'number');
    const [factsYielded, setFactsYielded] = React.useState(false);
    const placeFacts = React.useCallback((next: Partial<{ title: number; titleNatural: number; facts: number }>) => {
        const measure = factsMeasure.current;
        Object.assign(measure, next);
        if (measure.title <= 0 || measure.facts <= 0) return;
        if (titleMeasuredForFacts.current && Number.isNaN(measure.titleNatural)) return;
        // The name needs its whole width up to the floor a title meta keeps. Shown facts yield once the name's
        // column falls short of that; yielded facts return once the column holds them, and the name.
        // Layout reports whole pixels, so a column equal to the measured name can still clip a fraction of it
        // into an ellipsis: the name needs one pixel more than its measured width.
        const titleNeeds = Math.min(Number.isNaN(measure.titleNatural) ? Number.POSITIVE_INFINITY : measure.titleNatural + 1, ITEM_TITLE_META_TITLE_MIN_PX);
        // The facts' laid-out box already carries the gap the right slot keeps before them.
        const yielded = measure.yielded ? measure.title - measure.facts < titleNeeds : measure.title < titleNeeds;
        measure.yielded = yielded;
        setFactsYielded(yielded);
    }, []);
    const handleFactsLayout = React.useCallback((event: LayoutChangeEvent) => {
        const widthPx = event.nativeEvent.layout.width;
        if (!Number.isFinite(widthPx) || widthPx <= 0) return;
        placeFacts({ facts: widthPx });
    }, [placeFacts]);
    const handleAccessoryLayout = React.useCallback((event: LayoutChangeEvent) => {
        // Only the inline position reports the control's natural width; a stacked control spans the row.
        if (stackAccessoryRef.current) return;
        const widthPx = event.nativeEvent.layout.width;
        if (!Number.isFinite(widthPx) || widthPx <= 0) return;
        setAccessoryWidthPx((current) => (current === widthPx ? current : widthPx));
    }, []);
    // On a shared page-section sheet (`HappierPageSheet`: a page section, or a flat section in a pane)
    // the row follows the sheet's policy: its row inset, so its text lines up with the sheet's
    // sub-headings and the list around it, and its hairline. A menu row keeps the menu anatomy.
    // A catalog row keeps its own anatomy (no hairline, its fill and floor), but inside a drawn sheet its text
    // still starts on the sheet's row inset, the edge the sheet's title and every neighbouring sheet's rows use.
    const catalogSheetInsetPx = isCatalogRow && pageSheetContext?.framed === true ? pageSheetContext.rowInsetPx : null;
    const pageSheetInsetStyle = pageSheet
        ? resolveSheetRowInsetStyle(pageSheet.rowInsetPx)
        : catalogSheetInsetPx !== null ? resolveSheetRowInsetStyle(catalogSheetInsetPx) : null;
    const pageContainerStyle = pageRowStyles || pageSheetInsetStyle
        ? [pageRowStyles ? styles.pageContainer : null, pageRowStyles?.box ?? null, pageSheetInsetStyle]
        : null;
    const stackedContainerStyle = stackAccessory ? styles.pageContainerStacked : null;
    const containerPadding = pageRowStyles
        ? pageRowStyles.padding
        : isMenuRow
        ? MENU_ROW_PADDING_STYLE
        : catalogGeometry
        ? CATALOG_ROW_PADDING_STYLE
        : hasSubtitleContent
            ? (isTight ? styles.containerWithSubtitleTight : isCompact ? styles.containerWithSubtitleCompact : isCozy ? styles.containerWithSubtitleCozy : styles.containerWithSubtitle)
            : (isTight ? styles.containerWithoutSubtitleTight : isCompact ? styles.containerWithoutSubtitleCompact : isCozy ? styles.containerWithoutSubtitleCozy : styles.containerWithoutSubtitle);
    const rowEdgeStyle = bodyEdgeRow ? BODY_EDGE_ROW_INSET_STYLE : paneRow ? PANE_ROW_INSET_STYLE : null;
    const containerBase = isTight
        ? [styles.container, styles.containerTight, rowEdgeStyle, isMenuRow ? MENU_ROW_HEIGHT_STYLE : null, pageContainerStyle, stackedContainerStyle]
        : isCompact
            ? [styles.container, styles.containerCompact, rowEdgeStyle, isMenuRow ? MENU_ROW_HEIGHT_STYLE : null, pageContainerStyle, stackedContainerStyle]
            : isCozy
                ? [styles.container, styles.containerCozy, rowEdgeStyle, isMenuRow ? MENU_ROW_HEIGHT_STYLE : null, pageContainerStyle, stackedContainerStyle]
            : [styles.container, rowEdgeStyle, isMenuRow ? MENU_ROW_HEIGHT_STYLE : null, pageContainerStyle, stackedContainerStyle];
    const alignsToFirstLine = contentAlign === 'start';
    const containerCore = [alignsToFirstLine ? [containerBase, styles.containerAlignStart] : containerBase,
        directoryEdges ? DIRECTORY_ROW_CONTENT_STYLE : null,
        catalogGeometry ? { minHeight: HAPPIER_COLLECTION_LIST_METRICS.catalogRow.minHeight }
            // The described floor holds only a row that has its line beneath: an undescribed one (a column's Defaults,
            // a machine without its summary) keeps the one-line pitch, so its height follows its content (A5, B2).
            : columnDescribedRow && hasSubtitleContent ? { minHeight: HAPPIER_COLLECTION_LIST_METRICS.describedRowMinHeight } : null];
    const iconBoxSizeOverride = leadingMediaBox
        ? { width: leadingMediaBox.width, height: leadingMediaBox.height }
        : iconBoxSize != null
            ? { width: iconBoxSize, height: iconBoxSize }
            : null;
    const chevronSize = ITEM_CHEVRON_SIZE[resolvedIconDensity];
    // One glyph size for every row in a list, whether or not that row happens to carry a subtitle.
    // Branching on the subtitle is tempting — it is what makes the icon span exactly two lines — but
    // a settings list mixes one- and two-line rows freely, and sizing each row to its own content
    // produces a column of icons that step up and down. Uniform beats locally-perfect here.
    const resolvedIconGlyphSize = isMenuRow
        ? MENU_ROW_METRICS.iconGlyphSizePx
        : pageRowMetrics
            ? pageRowMetrics.iconGlyphPx
            : ITEM_ICON_GLYPH_SIZE[resolvedIconDensity];
    // The container must not clip a glyph that is now taller than the nominal box.
    const resolvedIconBoxSize = isMenuRow
        ? MENU_ROW_METRICS.iconBoxSizePx
        : Math.max(ITEM_ICON_BOX_SIZE[resolvedIconDensity], resolvedIconGlyphSize);
    const menuIconBoxStyle = isMenuRow
        ? {
            width: MENU_ROW_METRICS.iconBoxSizePx,
            height: MENU_ROW_METRICS.iconBoxSizePx,
            marginRight: MENU_ROW_METRICS.iconMarginRightPx,
        }
        : null;
    // `iconBoxSizeOverride` stays last: a call site that reserved room for an oversized leading
    // element (a capacity gauge, an avatar) means it whatever surface the row belongs to.
    // A leading mark (avatar, brand identity, facepile) is often larger than
    // the density's glyph box. Off a page, centred in the fixed box it would overhang toward the edge and
    // crowd the title, so the box grows to the mark instead; the density size stays its minimum.
    // Every page row's leading column is one fixed width: a glyph sits centred in it and an identity mark
    // (drawn at `rowIdentityMarkPx`) overhangs it evenly on the same axis, so the titles of every sheet
    // share one edge (PHONE-GEOMETRY-1110: 77 and 80 beside avatars, 64 elsewhere). Only a leading element
    // wider than an identity mark (a facepile) still widens it.
    // In a side pane the glyph stands on the pane's text edge (start of the column), the line the pane's title
    // and section headings start on; on a page sheet it sits centred in the column.
    const pageLeadingColumnStyle = isPageRow
        ? {
            width: PAGE_LIST_METRICS.rowLeadingColumnPx,
            height: 'auto',
            minHeight: PAGE_LIST_METRICS.rowLeadingColumnPx,
            marginRight: PAGE_LIST_METRICS.rowLeadingGapPx,
            ...(sidePaneTextEdge ? { alignItems: 'flex-start' as const } : null),
        } as const
        : null;
    const catalogLeadingColumnStyle = catalogGeometry ? {
        width: HAPPIER_COLLECTION_LIST_METRICS.catalogRow.markBox,
        height: HAPPIER_COLLECTION_LIST_METRICS.catalogRow.markBox,
        marginRight: HAPPIER_COLLECTION_LIST_METRICS.catalogRow.markGap,
    }
        // In a column the leading column starts on the text edge and fits its mark: the glyph box for a glyph,
        // wider for an avatar, never overhanging the edge or crowding the title.
        : columnDescribedRow ? { width: 'auto', minWidth: resolvedIconBoxSize } as const
        : null;
    // A catalog record's mark box is fixed too: its identity mark is drawn at `catalogRow.identityMarkPx`.
    const leadingMarkFitStyle = leftElement == null || iconBoxSize != null || isMenuRow || catalogGeometry
        ? null
        : isPageRow
            ? sidePaneTextEdge ? PAGE_IDENTITY_MARK_SIDE_PANE_STYLE : PAGE_IDENTITY_MARK_STYLE
            // A list row's leading element wider than the glyph box (a tree row's disclosure + glyph) takes its
            // width instead of overhanging the title; the density box stays its minimum, so glyph rows align.
            : { width: 'auto', minWidth: resolvedIconBoxSize } as const;
    const titleSizeStyle = pageRowStyles
        ? pageRowStyles.title
        : catalogGeometry ? styles.titleCatalog
        : isTight ? styles.titleTight : isCompact ? styles.titleCompact : isCozy ? styles.titleCozy : null;
    // Top-aligned content gives the leading mark and the trailing accessory the title's first line as their
    // box, so each centres on that line (the mark may overhang the box; only its centre matters).
    const titleLineHeightPx = alignsToFirstLine
        ? RNStyleSheet.flatten<TextStyle>([styles.title, titleSizeStyle])?.lineHeight
        : undefined;
    const firstLineLeadingStyle = titleLineHeightPx === undefined ? null : { height: titleLineHeightPx };
    const firstLineTrailingStyle = titleLineHeightPx === undefined ? null : { minHeight: titleLineHeightPx };
    const iconContainerStyle = isTight
        ? [styles.iconContainer, styles.iconContainerTight, menuIconBoxStyle, pageLeadingColumnStyle, catalogLeadingColumnStyle, leadingMarkFitStyle, iconBoxSizeOverride, firstLineLeadingStyle, directoryEdges ? DIRECTORY_ROW_LEADING_STYLE : null]
        : isCompact
            ? [styles.iconContainer, styles.iconContainerCompact, menuIconBoxStyle, pageLeadingColumnStyle, catalogLeadingColumnStyle, leadingMarkFitStyle, iconBoxSizeOverride, firstLineLeadingStyle, directoryEdges ? DIRECTORY_ROW_LEADING_STYLE : null]
            : isCozy
                ? [styles.iconContainer, styles.iconContainerCozy, menuIconBoxStyle, pageLeadingColumnStyle, catalogLeadingColumnStyle, leadingMarkFitStyle, iconBoxSizeOverride, firstLineLeadingStyle, directoryEdges ? DIRECTORY_ROW_LEADING_STYLE : null]
            : [styles.iconContainer, menuIconBoxStyle, pageLeadingColumnStyle, catalogLeadingColumnStyle, leadingMarkFitStyle, iconBoxSizeOverride, firstLineLeadingStyle, directoryEdges ? DIRECTORY_ROW_LEADING_STYLE : null];
    const resolvedIconMarginRight = isMenuRow
        ? MENU_ROW_METRICS.iconMarginRightPx
        : catalogGeometry ? HAPPIER_COLLECTION_LIST_METRICS.catalogRow.markGap
        : ITEM_ICON_MARGIN_RIGHT[resolvedIconDensity];
    // A page navigation row's glyph is a landmark, not a status: one family, one size and the
    // secondary text colour, whatever tint the call site passed. Identity marks (`leftElement`) and
    // status glyphs on non-navigation rows keep their own colour.
    const pageNavigationIconColor = isPageRow && showAccessory ? theme.colors.text.secondary : undefined;
    const sizedIcon = React.useMemo(
        () => resizeItemIconForDensity(icon, resolvedIconGlyphSize, pageNavigationIconColor),
        [icon, pageNavigationIconColor, resolvedIconGlyphSize],
    );
    const subtitleSizeStyle = pageRowStyles
        ? pageRowStyles.subtitle
        : catalogGeometry ? styles.subtitleCatalog
        : isTight ? styles.subtitleTight : isCompact ? styles.subtitleCompact : isCozy ? styles.subtitleCozy : null;
    // A composed subtitle's text takes the row's subtitle role and ink (the element path below).
    const composedSubtitleTextStyle = React.useMemo(
        () => [styles.subtitle, subtitleSizeStyle, subtitleInkStyle, styles.subtitleComposedText],
        [styles.subtitle, subtitleSizeStyle, subtitleInkStyle, styles.subtitleComposedText],
    );
    const factDetailStyle = React.useMemo(
        () => (factRow && pageRowStyles ? [pageRowStyles.detail, styles.detailFact] : null),
        [factRow, pageRowStyles, styles.detailFact],
    );
    const detailSizeStyle = pageRowStyles
        ? (factDetailStyle ?? pageRowStyles.detail)
        : isTight ? styles.detailTight : isCompact ? styles.detailCompact : isCozy ? styles.detailCozy : null;
    const detailFigures = metaFigureStyle(detail);

    const [isHovered, setIsHovered] = React.useState(false);
    // The pointer over an accessory that sits beside the press target (a row's own menu) still engages the row.
    const [isAccessoryHovered, setIsAccessoryHovered] = React.useState(false);
    React.useEffect(() => {
        // Keep hover state coherent with disabled/loading changes.
        if (disabled || loading) setIsHovered(false);
    }, [disabled, loading]);

    const leftAccessory = React.useMemo(() => {
        const candidate = (isHovered ? leftElementWhenHovered : null) ?? leftElement ?? sizedIcon ?? null;
        return normalizeNodeForView(candidate);
    }, [isHovered, leftElement, leftElementWhenHovered, sizedIcon]);
    // A control placed under its label begins at the label's leading edge, after the section's shared
    // mark column, whether the row is one pressable or a split operation. Auto-fit identity marks
    // have no fixed width here; they retain their anatomy.
    const stackedLabelEdgeStyle = React.useMemo(() => (
        stackAccessory && isPageRow && leadingMarkFitStyle === null && (leftAccessory || reservesLeadingColumn)
            ? { marginLeft: (iconBoxSize ?? PAGE_LIST_METRICS.rowLeadingColumnPx) + PAGE_LIST_METRICS.rowLeadingGapPx }
            : null
    ), [iconBoxSize, isPageRow, leadingMarkFitStyle, leftAccessory, reservesLeadingColumn, stackAccessory]);
    /**
     * The name this row lends to an accessory control that has none of its own.
     *
     * The title alone — not the row's full `title. subtitle. detail` label — because a
     * control announces its own state next to it, and because that is already the
     * convention at every call site that names its switch by hand.
     */
    const accessoryAccessibleName = React.useMemo(
        () => accessibilityLabel ?? buildActionRowAccessibilityLabel([title]),
        [accessibilityLabel, title],
    );
    const rightAccessory = React.useMemo(() => {
        const normalized = normalizeNodeForView(rightElement ?? null);
        if (normalized == null) return null;
        const named = (
            <ItemRowAccessibleNameProvider value={accessoryAccessibleName}>
                <ItemRowHoverProvider value={isHovered || isAccessoryHovered}>
                    {isPageRow ? <RoundButtonSizeScope size="small">{normalized}</RoundButtonSizeScope> : normalized}
                </ItemRowHoverProvider>
            </ItemRowAccessibleNameProvider>
        );
        if (rightElementYields && !measuresRowWidth && !stackAccessory) return (
            // Laid out as shrinkable as any inline accessory: its drawn width, not its widest, is what it gives back.
            <View onLayout={handleFactsLayout} style={[styles.accessoryInline, factsYielded ? styles.accessoryYielded : null]}
                {...(factsYielded ? { 'aria-hidden': true, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const } : {})}>
                {named}
            </View>
        );
        // A stacked control is never measured, but its field still needs to know it spans the row.
        if (!measuresRowWidth) return (
            <View style={stackAccessory ? styles.accessoryMeasureStacked : styles.accessoryInline}>
                <HappierPageRowFieldLayoutContext.Provider value={fieldLayout}>{named}</HappierPageRowFieldLayoutContext.Provider>
            </View>
        );
        return (
            <View onLayout={handleAccessoryLayout} style={stackAccessory ? styles.accessoryMeasureStacked : styles.accessoryMeasure}>
                <HappierPageRowFieldLayoutContext.Provider value={fieldLayout}>{named}</HappierPageRowFieldLayoutContext.Provider>
            </View>
        );
    }, [accessoryAccessibleName, factsYielded, handleAccessoryLayout, handleFactsLayout, isAccessoryHovered, isHovered, isPageRow, measuresRowWidth, rightElement, rightElementYields, fieldLayout, stackAccessory]);
    const subtitleAccessoryNode = React.useMemo(() => normalizeNodeForView(subtitleAccessory ?? null), [subtitleAccessory]);
    // A plain count or scope reads as the row's quiet tabular meta (S10 §5.2), never in the default text face.
    const titleMetaNode = typeof titleMeta === 'string' || typeof titleMeta === 'number'
        ? <Text variant="meta" numberOfLines={1} style={[styles.titleMetaText, subtitleInkStyle,
            metaFigureStyle(String(titleMeta))]}>{titleMeta}</Text>
        : normalizeNodeForView(titleMeta ?? null);
    const [titleMetaPlacement, setTitleMetaPlacement] = React.useState<'inline' | 'beneath'>('inline');
    // A text title is measured out of flow, so a short name keeps its meta on its line where the two fit; until
    // that width arrives the name counts at the floor a title meta keeps.
    const titleMetaMeasure = React.useRef({ row: 0, meta: 0, titleNatural: Number.NaN });
    const placeTitleMeta = React.useCallback((next: Partial<{ row: number; meta: number; titleNatural: number }>) => {
        titleMetaMeasure.current = { ...titleMetaMeasure.current, ...next };
        const { titleNatural } = titleMetaMeasure.current;
        setTitleMetaPlacement(resolveHappierRowTitleMetaPlacement({
            rowContentWidthPx: titleMetaMeasure.current.row,
            // Layout reports whole pixels: the name needs one more than its measured width not to clip.
            titleNaturalWidthPx: Number.isNaN(titleNatural) ? Number.POSITIVE_INFINITY : titleNatural + 1,
            metaNaturalWidthPx: titleMetaMeasure.current.meta,
            titleMinWidthPx: ITEM_TITLE_META_TITLE_MIN_PX,
        }));
    }, []);
    // In a column the meta never shares the name's line: it joins the description line (`renderColumnMetaLine`),
    // so the name keeps the width and nothing is measured or moved.
    const columnTitleMeta = columnDescribedRow ? titleMeta ?? null : null;
    const titleMetaCell = titleMetaNode == null || columnDescribedRow ? null : (
        <View style={[styles.titleMeta, titleMetaPlacement === 'beneath' ? styles.titleMetaBeneathCell : null]}>
            {/* Placement changes the outer gap, never the content width that decides placement. */}
            <View style={styles.titleMetaContent} onLayout={(event) => placeTitleMeta({ meta: event.nativeEvent.layout.width })}>
                {titleMetaNode}
            </View>
        </View>
    );
    // A title allowed to wrap carries its qualifier inline after its last word ("N1-QA · QA20 plugin / review  Plugin"),
    // never floated to the line's end beside a wrapped name.
    const inlineQualifier = titleQualifier
        ? <Text style={styles.titleQualifierInline}>{`\u00A0\u00A0${titleQualifier}`}</Text> : null;
    const qualifiedTitleLines = titleLines ?? (titleQualifier ? 1 : catalogGeometry ? undefined : columnDescribedRow ? 1 : titleHighlightQuery ? HIGHLIGHTED_TITLE_MAX_LINES : resolveItemTitleMaxLines(Boolean(subtitle), { page: isPageRow, hasAccessory: true })) ?? undefined;
    const titleTrailing = titleQualifier ? (
        <>
            <Text numberOfLines={1} style={styles.titleQualifier}>{titleQualifier}</Text>
            {titleAccessory}
        </>
    ) : measuresFieldLabel && titleAccessory != null ? (
        // Keyed so the measured wrapper mounts fresh: a host that gains `onLayout` in place is never observed.
        <View key="title-trailing-measure" style={styles.titleTrailingMeasure} onLayout={handleTitleTrailingLayout}>{titleAccessory}</View>
    ) : titleAccessory;
    const chevronAccessory = React.useMemo(() => {
        if (!showAccessory) return null;
        // A disclosure header's caret turns to show whether the row is open; a destination's points onward.
        if (accessibilityExpanded !== undefined) {
            return (
                <View style={{ marginLeft: theme.space.s4 }}>
                    <DisclosureCaret expanded={accessibilityExpanded} size={chevronSize} />
                </View>
            );
        }
        return normalizeNodeForView(
            <Icon
                name="caret-right"
                size={chevronSize}
                color={theme.colors.text.secondary}
                style={{ marginLeft: theme.space.s4 }}
            />,
        );
    }, [accessibilityExpanded, chevronSize, showAccessory, theme.colors.text.secondary, theme.space.s4]);

    // A sheet row's hairline is the sheet's: its divider colour, from the row's text to the sheet's trailing edge
    // (`happierPageRowDividerInset`). A page row outside a sheet (a bare or columned section) draws the same
    // page hairline in the page divider colour.
    const flatDividerColor = pageSheet?.rowDividerColor ?? (isPageRow ? theme.colors.border.subtle : null);
    const hasLeading = icon != null || leftElement != null;
    const flatDividerInsetBase = flatDividerColor === null ? null : happierPageRowDividerInset({
        rowInsetPx: pageRowInsetPx ?? PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        leadingPx: isPageRow
            ? (reservesLeadingColumn || hasLeading ? (iconBoxSize ?? PAGE_LIST_METRICS.rowLeadingColumnPx) + PAGE_LIST_METRICS.rowLeadingGapPx : 0)
            : (hasLeading ? (iconBoxSize ?? resolvedIconBoxSize) + resolvedIconMarginRight : 0),
        framed: pageSheet?.framed,
    });
    // A bare section's row reaches into the margin by its bleed; its hairline stops on the content's trailing edge,
    // as a flat sheet's does (`happierPageRowDividerInset`, unframed), never in the margin (LABPARITY-ACCEPT-B fix 7).
    const rowBleedPx = props.rowBleedPx ?? 0;
    const flatDividerInset = flatDividerInsetBase !== null && rowBleedPx > flatDividerInsetBase.marginEnd
        ? { ...flatDividerInsetBase, marginEnd: rowBleedPx } : flatDividerInsetBase;
    const rowFollowed = React.useContext(HappierListRowFollowedContext);
    const rowPrecedesSelected = React.useContext(HappierListRowPrecedesSelectedContext);
    // The one list-row rule, for a row whose list states its order (a column, a flat page list, a selection list's
    // rows, menu-shaped ones included; never a sheet's rows, which their group divides): drawn while another row
    // follows, from the row's text column (a page row's text inset; a column row's own leading padding, then its
    // glyph column), never over its own fill. A floating surface states no order for the rows it opened over.
    const listRuleRow = rowFollowed !== null && (inCollectionColumn || pageSheet === null);
    const listRuleShown = listRuleRow && resolveHappierListRowRuleShown({
        followed: rowFollowed,
        // A row with a line under its title; one-line rows part by spacing alone (owner 2026-11-17 23:52Z, DESIGN.md 2026-11-15).
        multiline: hasSubtitleContent,
        // The row's fill: a choice that marks itself with the check alone (`selectedFill={false}`) is not filled.
        selected: (selected === true && selectedFill) || focused === true,
        precedesSelected: rowPrecedesSelected,
        hovered: isHovered,
    });
    // Where the row's text starts: its own leading padding, then its glyph column.
    const rowTextStartPx = (readLeadingPadding(style) ?? ITEM_ROW_PADDING_HORIZONTAL[resolvedIconDensity])
        + (hasLeading ? (iconBoxSize ?? resolvedIconBoxSize) + resolvedIconMarginRight : 0);
    const listRuleStartPx = !listRuleShown ? 0
        : isPageRow && flatDividerInset !== null ? flatDividerInset.marginStart
        : rowTextStartPx;
    // In a split row the press target and the end facts are the siblings that share the line, so the title floor
    // holds there: the press target keeps the text start plus the floor before the passive end gives way.
    const splitPressFloorStyle = React.useMemo(
        () => (passiveFactsFloor && titleFloorPx !== null ? { minWidth: rowTextStartPx + titleFloorPx } : null),
        [passiveFactsFloor, rowTextStartPx, titleFloorPx],
    );
    // A row whose control stands outside its press target draws its rule outside the press target's fill too (beside it,
    // not inside it): the rule then steps in by that fill's own margins, so every row's line starts and ends alike.
    const ruleOutsideFill = listRuleShown && isInteractive && (
        (sharedItemBehavior.accessoryPlacement === 'outside' && Boolean(rightAccessory))
        || (leftElementOutsidePressable && Boolean(leftAccessory))
        || (Boolean(bottomElement) && bottomElementOutsidePressable));
    const fillMargins = ruleOutsideFill ? readHorizontalMargins(pressableStyle) : NO_MARGINS;
    const listRule = listRuleShown ? <HappierListRowRule startPx={listRuleStartPx + fillMargins.start}
        endPx={fillMargins.end} color={theme.colors.border.divider} /> : null;
    const dividerNode = listRuleRow ? listRule : (sharedItemBehavior.dividerVisible ? (
        <HappierDivider
            color={flatDividerColor ?? theme.colors.border.default}
            style={[
                styles.divider,
                // One portable literal, as the public list row composes it: the page hairline and its inset.
                flatDividerInset !== null ? { height: happierPageRowDividerWidth(), ...flatDividerInset } : {
                    marginLeft: (isAndroid || isWeb)
                        ? 0
                        : (dividerInset + (icon || leftElement ? (16 + (iconBoxSize ?? resolvedIconBoxSize) + resolvedIconMarginRight) : 16))
                }
            ]}
        />
    ) : null);
    
    const renderPrimitiveText = React.useCallback((params: Readonly<{
        value: string | number;
        style: StyleProp<TextStyle>;
        numberOfLines?: number;
        ellipsizeMode?: ItemTextEllipsizeMode;
        testID?: string;
        highlightQuery?: string;
        dataSet?: ItemProps['titleDataSet'];
        ref?: React.Ref<React.ComponentRef<typeof Text>>;
        /** Inline text that flows after the value's last word (a wrapping title's qualifier). */
        trailing?: React.ReactNode;
    }>) => {
        const value = String(params.value);
        const highlightRanges = params.highlightQuery ? queryRanges(value, params.highlightQuery) : undefined;
        const useWebStartEllipsis = isWeb && params.ellipsizeMode === 'head';
        // The web draws only a tail ellipsis, so a one-line middle ellipsis is two runs: the head
        // shrinks with its own ellipsis and the end (a path's last segment) stays whole.
        const webMiddle = isWeb && params.ellipsizeMode === 'middle' && params.numberOfLines === 1
            ? splitForWebMiddleEllipsis(value)
            : null;
        if (webMiddle) return <MiddleEllipsisText testID={params.testID} dataSet={params.dataSet} style={params.style} value={value} />;
        const content = highlightRanges?.length ? <FindHighlightedText text={value} ranges={highlightRanges} /> : useWebStartEllipsis ? (
            <Text style={WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE}>{value}</Text>
        ) : value;
        return (
            <Text
                ref={params.ref}
                testID={params.testID}
                {...{ dataSet: params.dataSet }}
                style={[
                    params.style,
                    useWebStartEllipsis ? WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE : null,
                ]}
                numberOfLines={params.numberOfLines}
                ellipsizeMode={params.ellipsizeMode}
            >
                {params.trailing == null ? content : [content, <React.Fragment key="trailing">{params.trailing}</React.Fragment>]}
            </Text>
        );
    }, [isWeb]);

    const renderRowContent = React.useCallback((options?: Readonly<{ includeRightAccessory?: boolean; includeLeftAccessory?: boolean }>) => {
        const includeRightAccessory = options?.includeRightAccessory ?? true;
        const includeLeftAccessory = options?.includeLeftAccessory ?? true;
        // A split primary remains a bounded horizontal label/value band. Its independent
        // operation stacks outside this band, so only content containing that operation stacks.
        const stackContentAccessory = stackAccessory && includeRightAccessory;
        const detailBeneathNode = detailBeneath && detail ? renderPrimitiveText({
            value: detail,
            testID: detailTestID,
            style: [styles.subtitle, subtitleSizeStyle, subtitleInkStyle],
        }) : null;
        const renderColumnMetaLine = (line: React.ReactNode) => columnTitleMeta == null ? line : (
            <View style={styles.columnMetaLine}>
                {line == null ? null : <View style={styles.columnMetaLead}>{line}</View>}
                {typeof columnTitleMeta === 'string' || typeof columnTitleMeta === 'number' ? (
                    <Text numberOfLines={1} style={[styles.subtitle, subtitleSizeStyle, subtitleInkStyle, styles.columnMetaText, metaFigureStyle(String(columnTitleMeta))]}>
                        {/* A no-break space: a leading plain space collapses at the start of its own text box. */}
                        {line == null ? String(columnTitleMeta) : `\u00A0· ${columnTitleMeta}`}
                    </Text>
                ) : columnTitleMeta}
            </View>
        );
        return (
        <>
            <View style={[styles.labelBand, alignsToFirstLine ? styles.containerAlignStart : null, stackContentAccessory ? styles.labelBandStacked : null]}>
            {/* Left Section */}
            {includeLeftAccessory && (leftAccessory || (isPageRow && reservesLeadingColumn)) ? (
                <View
                    style={iconContainerStyle}
                    // An empty reserved column is layout only.
                    {...(leftAccessory ? null : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const })}
                >
                    {leftAccessory}
                </View>
            ) : null}

            {/* Center Section */}
            <View
                style={centerContentStyle}
                {...(titleMetaCell === null && !rightElementYields ? {} : { onLayout: (event: LayoutChangeEvent) => {
                    const widthPx = event.nativeEvent.layout.width;
                    if (titleMetaCell !== null) placeTitleMeta({ row: widthPx });
                    if (rightElementYields && Number.isFinite(widthPx) && widthPx > 0) placeFacts({ title: widthPx });
                } })}
            >
                {title === '' && titleMetaCell === null && !titleTrailing ? null : (typeof title === 'string' || typeof title === 'number') && titleMetaCell !== null ? (
                    <>
                        <View style={styles.inlineMarkRow}>
                            <View style={styles.inlineMarkText}>
                                {renderPrimitiveText({
                                    value: title,
                                    ref: titleRef,
                                    dataSet: titleDataSet,
                                    style: [styles.title, titleSizeStyle, titleColor, titleStyle],
                                    // A title that may wrap (`titleLines` 0) wraps beside its meta, as a catalog row's does,
                                    // instead of being cut to the readable minimum the meta leaves it.
                                    numberOfLines: catalogGeometry || titleLines === 0 ? undefined : 1,
                                    ellipsizeMode: titleEllipsizeMode,
                                    highlightQuery: titleHighlightQuery,
                                    ...(catalogGeometry && inlineQualifier ? { trailing: inlineQualifier } : {}),
                                })}
                            </View>
                            {catalogGeometry && inlineQualifier ? titleAccessory : titleTrailing}
                            {titleMetaPlacement === 'inline' ? titleMetaCell : null}
                        </View>
                        {titleMetaPlacement === 'beneath' ? <View style={styles.titleMetaBeneath}>{titleMetaCell}</View> : null}
                        {/* The name's natural line includes its qualifier ("docs-mcp  MCP server"): the meta yields beneath
                            before either is squeezed, so a name never breaks mid-word beside it (TASTE-S4060 D18). */}
                        <View style={[styles.inlineMarkRow, styles.detailMeasure]}
                            onLayout={(event: LayoutChangeEvent) => {
                                const widthPx = event.nativeEvent.layout.width;
                                if (Number.isFinite(widthPx) && widthPx > 0) placeTitleMeta({ titleNatural: widthPx });
                            }}
                            aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                            <Text style={[styles.title, titleSizeStyle, titleStyle]} numberOfLines={1}>{title}</Text>
                            {titleQualifier ? <Text numberOfLines={1} style={[styles.titleQualifier, styles.titleQualifierMeasure]}>{titleQualifier}</Text> : null}
                        </View>
                    </>
                ) : (typeof title === 'string' || typeof title === 'number') && titleTrailing ? (
                    <View style={styles.inlineMarkRow}>
                        <View style={[styles.inlineMarkText, titleQualifier && qualifiedTitleLines === 1 ? titleFloorStyle : null]}>
                            {renderPrimitiveText({
                                value: title,
                                ref: titleRef,
                                dataSet: titleDataSet,
                                style: [styles.title, titleSizeStyle, titleColor, titleStyle],
                                // A qualified title (a same-named machine's telling suffix) is one line in every row role: the
                                // name holds the title floor, then the qualifier shows what fits, never beside half a wrapped name.
                                numberOfLines: qualifiedTitleLines,
                                ellipsizeMode: titleEllipsizeMode,
                                highlightQuery: titleHighlightQuery,
                                ...(qualifiedTitleLines !== 1 && inlineQualifier ? { trailing: inlineQualifier } : {}),
                            })}
                        </View>
                        {qualifiedTitleLines !== 1 && inlineQualifier ? titleAccessory : titleTrailing}
                    </View>
                ) : typeof title === 'string' || typeof title === 'number' ? (
                    renderPrimitiveText({
                        value: title,
                        ref: titleRef,
                        dataSet: titleDataSet,
                        style: [styles.title, titleSizeStyle, titleColor, titleStyle],
                        numberOfLines: titleLines ?? (catalogGeometry ? undefined : columnDescribedRow ? 1 : titleHighlightQuery ? HIGHLIGHTED_TITLE_MAX_LINES : resolveItemTitleMaxLines(Boolean(subtitle), { page: isPageRow, menu: isMenuRow })) ?? undefined,
                        ellipsizeMode: titleEllipsizeMode,
                        highlightQuery: titleHighlightQuery,
                    })
                ) : (
                    normalizeNodeForView(title)
                )}
                {/* A row's own facts stay under its name; a moved short value (a time) follows them, last. */}
                {detailBeneath && detail && !subtitle ? detailBeneathNode : null}
                {renderColumnMetaLine(subtitle || subtitleLeading ? (() => {
                    // A status mark carries its own word ("● Failed"): it stands on its own when the line has no text.
                    if (!subtitle) {
                        const markSlotHeight = pageRowMetrics?.subtitle.lineHeight ?? ITEM_SUBTITLE_TEXT_METRICS[resolvedIconDensity].lineHeight;
                        return <View style={[styles.subtitleMarkSlot, { height: markSlotHeight }]}>{subtitleLeading}</View>;
                    }
                    // If subtitle is a ReactNode (not string), render as-is.
                    // This enables richer subtitle layouts (e.g. inline glyphs).
                    if (typeof subtitle !== 'string') {
                        const wrapPrimitive = (value: string | number) => {
                            const asText = String(value);
                            const effectiveLines = resolveItemSubtitleMaxLines({ text: asText, subtitleLines, page: isPageRow, menu: isMenuRow }) ?? undefined;

                            return renderPrimitiveText({
                                value: asText,
                                style: [styles.subtitle, subtitleSizeStyle, subtitleInkStyle, subtitleStyle],
                                numberOfLines: effectiveLines,
                                ellipsizeMode: subtitleEllipsizeMode,
                            });
                        };

                        const normalizeNode = (node: any): any => {
                            if (node == null || typeof node === 'boolean') return null;
                            if (typeof node === 'string' || typeof node === 'number') return wrapPrimitive(node);
                            if (Array.isArray(node)) return node.map(normalizeNode);
                            if (React.isValidElement(node) && node.type === React.Fragment) {
                                return <>{React.Children.map((node as any).props?.children, normalizeNode)}</>;
                            }
                            return node;
                        };

                        const normalized = normalizeNode(subtitle);

                        return (
                            <View style={{ marginTop: Platform.select({ ios: 2, default: 0 }) }}>
                                <ItemSubtitleTextStyleProvider value={composedSubtitleTextStyle}>
                                    {normalized}
                                </ItemSubtitleTextStyleProvider>
                            </View>
                        );
                    }

                    // Page descriptions grow; grouped rows keep their compact allowance unless overridden.
                    const effectiveLines = resolveItemSubtitleMaxLines({
                        text: subtitle,
                        subtitleLines,
                        status: subtitleLeading != null,
                        page: isPageRow,
                        menu: isMenuRow,
                    }) ?? undefined;

                    if (subtitleLeading) {
                        // The mark sits in a slot one subtitle line tall at the top of the text, so a
                        // status that wraps keeps its dot beside the first line.
                        const markSlotHeight = pageRowMetrics?.subtitle.lineHeight ?? ITEM_SUBTITLE_TEXT_METRICS[resolvedIconDensity].lineHeight;
                        return (
                            <View style={styles.subtitleMarkRow}>
                                <View style={[styles.subtitleMarkSlot, { height: markSlotHeight }]}>
                                    {subtitleLeading}
                                </View>
                                <View style={styles.inlineMarkText}>
                                    {renderPrimitiveText({
                                        value: subtitle,
                                        testID: subtitleTestID,
                                        style: [styles.subtitle, subtitleSizeStyle, subtitleInkStyle, subtitleStyle],
                                        numberOfLines: effectiveLines,
                                        ellipsizeMode: subtitleEllipsizeMode,
                                    })}
                                </View>
                            </View>
                        );
                    }

                    return renderPrimitiveText({
                        value: subtitle,
                        testID: subtitleTestID,
                        style: [styles.subtitle, subtitleSizeStyle, subtitleInkStyle, subtitleStyle],
                        numberOfLines: effectiveLines,
                        ellipsizeMode: subtitleEllipsizeMode,
                    });
                })() : null)}
                {detailBeneath && detail && subtitle ? detailBeneathNode : null}
                {subtitleAccessoryNode ? (
                    <View style={{ marginTop: 0 }}>
                        {subtitleAccessoryNode}
                    </View>
                ) : null}
            </View>
            {/* A control moved beneath the label spans the row; the way onward stays at this line's end. */}
            {stackContentAccessory ? chevronAccessory : null}

            </View>
            {/* Right Section */}
            <View style={[styles.rightSection, stackContentAccessory ? [styles.rightSectionStacked, stackedLabelEdgeStyle] : pageRowStyles?.accessoryBleed,
                // An adaptive control that measured inline already fits beside the label's column (the
                // narrow-row and half-row rules decided that), so the box is not held to half the
                // content width as well: that second cap clipped a 240px field in a ~490px dialog row
                // past the sheet's trailing inset.
                !stackContentAccessory && (adaptiveAccessory || fieldMaxWidthPx !== null || accessoryMaxWidth === 'row') ? styles.rightSectionField : null,
                detailInlineMaxWidthPx !== null ? { maxWidth: detailInlineMaxWidthPx } : null,
                isMenuRow && !stackContentAccessory ? MENU_ROW_TRAILING : null,
                // An empty trailing cell takes no gap, so a directory row's own end stands on its section's edge.
                directoryEdges && !(detail && !detailBeneath) && !loading && !(includeRightAccessory && rightAccessory != null)
                    && chevronAccessory == null ? EMPTY_TRAILING_CELL_STYLE : null,
                firstLineTrailingStyle]}>
                {copyFeedback.isCopied() ? (
                    <CopiedPill visible testID="item-copy-feedback" />
                ) : detail && !detailBeneath ? (
                    <Text
                        testID={detailTestID}
                        style={[
                            styles.detail,
                            detailSizeStyle,
                            detailFigures,
                            { marginRight: rightElement || showAccessory ? 8 : 0 },
                            subtitleInkStyle,
                            detailStyle,
                            wrapDetail ? styles.detailWrapped : null,
                        ]}
                        numberOfLines={wrapDetail ? undefined : 1}
                    >
                        {detail}
                    </Text>
                ) : null}
                {loading && (
                    <ActivitySpinner
                        aria-hidden
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                        size="small"
                        color={theme.colors.text.secondary}
                        style={{ marginRight: showAccessory ? 6 : 0 }}
                    />
                )}
                {includeRightAccessory ? rightAccessory : null}
                {stackContentAccessory ? null : chevronAccessory}
            </View>
            {measuresDetail && detail ? (
                <Text style={[styles.detail, detailSizeStyle, detailFigures, styles.detailMeasure]} numberOfLines={1} onLayout={handleDetailLayout}
                    aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{detail}</Text>
            ) : null}
            {/* The label's natural line includes its qualifier ("NLDW3-5-36-33  3ca2"), so a detail beside it
                never cuts the part that tells two same-named rows apart. */}
            {measuresTitle && titleQualifier ? (
                <View style={[styles.inlineMarkRow, styles.detailMeasure]} onLayout={handleTitleMeasureLayout}
                    aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <Text style={[styles.title, titleSizeStyle, titleStyle]} numberOfLines={1}>{title as string | number}</Text>
                    <Text numberOfLines={1} style={[styles.titleQualifier, styles.titleQualifierMeasure]}>{titleQualifier}</Text>
                </View>
            ) : measuresTitle ? (
                <Text style={[styles.title, titleSizeStyle, titleStyle, styles.detailMeasure]} numberOfLines={1} onLayout={handleTitleMeasureLayout}
                    aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{title as string | number}</Text>
            ) : null}
            {(titleQualifier || passiveFactsFloor) && (typeof title === 'string' || typeof title === 'number') ? (
                <Text style={[styles.title, titleSizeStyle, titleStyle, styles.detailMeasure]} numberOfLines={1}
                    onLayout={handleTitleFloorMeasureLayout}
                    aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{title}</Text>
            ) : null}
            {rightElementYields && (typeof title === 'string' || typeof title === 'number') ? (
                <Text style={[styles.title, titleSizeStyle, titleStyle, styles.detailMeasure]} numberOfLines={1}
                    onLayout={(event: LayoutChangeEvent) => {
                        const widthPx = event.nativeEvent.layout.width;
                        if (Number.isFinite(widthPx) && widthPx > 0) placeFacts({ titleNatural: widthPx });
                    }}
                    aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{title}</Text>
            ) : null}
        </>
    );
    }, [
        chevronAccessory,
        directoryEdges,
        placeFacts,
        rightElementYields,
        detailBeneath,
        measuresDetail,
        measuresTitle,
        detailInlineMaxWidthPx,
        handleDetailLayout,
        handleTitleMeasureLayout,
        handleTitleTrailingLayout,
        measuresFieldLabel,
        styles.titleTrailingMeasure,
        styles.detailMeasure,
        copyFeedback,
        adaptiveAccessory,
        fieldMaxWidthPx,
        stackAccessory,
        stackedLabelEdgeStyle,
        detail,
        wrapDetail,
        detailTestID,
        detailSizeStyle,
        detailFigures,
        detailStyle,
        iconContainerStyle,
        isMenuRow,
        isPageRow,
        isCatalogRow,
        catalogGeometry,
        columnDescribedRow,
        columnTitleMeta,
        styles.columnMetaLine,
        styles.columnMetaLead,
        styles.columnMetaText,
        leftAccessory,
        loading,
        pageRowMetrics,
        pageRowStyles,
        renderPrimitiveText,
        resolvedIconDensity,
        reservesLeadingColumn,
        rightAccessory,
        showAccessory,
        subtitle,
        subtitleAccessoryNode,
        subtitleLeading,
        titleAccessory,
        inlineQualifier,
        qualifiedTitleLines,
        titleFloorStyle,
        handleTitleFloorMeasureLayout,
        passiveFactsFloor,
        centerContentStyle,
        subtitleEllipsizeMode,
        subtitleLines,
        subtitleSizeStyle,
        subtitleInkStyle,
        subtitleStyle,
        composedSubtitleTextStyle,
        styles.centerContent,
        styles.detail,
        styles.detailWrapped,
        styles.inlineMarkRow,
        styles.inlineMarkText,
        styles.rightSection,
        styles.containerAlignStart,
        alignsToFirstLine,
        firstLineTrailingStyle,
        styles.subtitle,
        style,
        title,
        titleColor,
        titleDataSet,
        titleEllipsizeMode,
        titleHighlightQuery,
        titleLines,
        titleSizeStyle,
        titleStyle,
        theme.colors.text.secondary,
    ]);

    // `text` starts on the title's edge, also when the row has no glyph of its own but its section reserves the column.
    // A menu row's title edge is its own padding plus the menu glyph box, not the page row's.
    const menuBottomText = bottomElementInset === 'text' && isMenuRow && (icon != null || leftElement != null);
    // A list row (a collection rail) with a glyph: the title's edge is the row's own padding, the glyph box and its gap.
    const listBottomTextStart = bottomElementInset === 'text' && !isPageRow && !isMenuRow && icon != null && leftElement == null
        ? (bodyEdgeRow ? 0 : paneRow ? PANE_TEXT_INSET_PX : ITEM_ROW_PADDING_HORIZONTAL[resolvedIconDensity]) + (iconBoxSize ?? resolvedIconBoxSize) + resolvedIconMarginRight
        : null;
    const bottomTextInset = bottomElementInset === 'text' && isPageRow && (icon != null || leftElement != null || reservesLeadingColumn)
        ? PAGE_LIST_METRICS.rowLeadingColumnPx + resolvedIconMarginRight
        : 0;
    const bottomPaddingLeft = menuBottomText
        ? MENU_ROW_SHAPE.paddingHorizontal + MENU_ROW_METRICS.iconBoxSizePx + MENU_ROW_METRICS.iconMarginRightPx
        : listBottomTextStart ?? PAGE_LIST_METRICS.rowPaddingHorizontalPx + bottomTextInset;
    const bottom = bottomElement ? <View style={{ paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx, paddingLeft: bottomPaddingLeft, paddingBottom: PAGE_LIST_METRICS.rowPaddingVerticalPx }}>{bottomElement}</View> : null;
    // The row's own activation covers the row alone; its bottom content and divider follow it as siblings.
    const bottomBelowPressable = Boolean(bottom && bottomElementOutsidePressable && isInteractive);
    const content = React.useMemo(() => (
        <>
            <View style={[containerCore, containerPadding, style]} onLayout={measuresRowWidth ? handleRowLayout : undefined}>
                {underlay}
                {renderRowContent()}
            </View>

            {bottomBelowPressable ? null : bottom}
            {bottomBelowPressable ? null : dividerNode}
        </>
    ), [
        containerCore,
        bottom,
        bottomBelowPressable,
        containerPadding,
        dividerNode,
        handleRowLayout,
        measuresRowWidth,
        renderRowContent,
        style,
        underlay,
    ]);
    const splitRightElementOutsidePressable = Boolean(
        isInteractive
        && sharedItemBehavior.accessoryPlacement === 'outside'
        && rightAccessory,
    );
    const splitLeftElementOutsidePressable = Boolean(isInteractive && leftElementOutsidePressable && leftAccessory);
    const splitRow = splitRightElementOutsidePressable || splitLeftElementOutsidePressable;

    const paintColor = useHappierMaterialColorResolver();
    const pressableBackground = RNStyleSheet.flatten(pressableStyle)?.backgroundColor;
    const resolveInteractiveRowStyle = React.useCallback((pressed: boolean, focused?: boolean) => {
        // A row on a drawn sheet draws its keyboard ring inside its own box, on the sheet's corners: an outset
        // ring would overhang the rounded sheet and its neighbours. A row of a sheetless section has nothing to
        // clip it, so it takes the one ring everywhere: outset, with a gap in the page colour.
        const focusRing = isWeb ? focusRingStyle({ focused: resolveHappierFocusRingVisible(focused), color: theme.colors.border.focus,
            placement: bareSectionRow ? 'outset' : 'inset' }) : null;
        const backgroundColor = (() => {
            if (pressed && isIOS && !isWeb) return theme.colors.surface.pressedOverlay;
            if (pressed && splitRow) return theme.colors.surface.pressed;
            if (showSelectedBackground) return theme.colors.surface.selected;
            // Web-only hover affordance for interactive rows (no hover when disabled).
            if (isWeb && hoverFill && isHovered && !disabled && !loading) return hoverBackgroundColor;
            return 'transparent';
        })();

        const roundedCornersStyle = getItemGroupRowCornerRadii({
            hasBackground: backgroundColor !== 'transparent' || typeof pressableBackground === 'string' || focusRing !== null,
            position: rowPosition,
            radius: groupCornerRadius,
        });

        return [
            { backgroundColor: paintColor(backgroundColor), opacity: disabled ? isCatalogRow ? HAPPIER_COLLECTION_LIST_METRICS.dimmedOpacity : 0.5 : 1 },
            isWeb && (disabled || loading) ? ({ cursor: 'not-allowed' } as any) : null,
            roundedCornersStyle,
            isMenuRow ? MENU_ROW_HIGHLIGHT_SHAPE : null,
            directoryEdges ? DIRECTORY_ROW_FILL_STYLE : null,
            pressableStyle,
            typeof pressableBackground === 'string' ? { backgroundColor: paintColor(pressableBackground) } : null,
            focusRing,
        ];
    }, [
        theme.colors.border.focus,
        disabled,
        isCatalogRow,
        isMenuRow,
        directoryEdges,
        paintColor,
        groupCornerRadius,
        bareSectionRow,
        hoverBackgroundColor,
        hoverFill,
        isHovered,
        isIOS,
        isWeb,
        loading,
        pressableStyle,
        pressableBackground,
        rowPosition,
        showSelectedBackground,
        splitRow,
        theme.colors.surface.pressed,
        theme.colors.surface.pressedOverlay,
        theme.colors.surface.selected,
    ]);

    const interactiveAccessibilityRole = isWeb ? undefined : (accessibilityRole ?? 'button');
    const interactiveWebRole = inferredInteractiveWebRole;
    const generatedAccessibilityLabel = React.useMemo(() => (
        buildActionRowAccessibilityLabel([title, subtitle, detail])
    ), [detail, subtitle, title]);
    const resolvedAccessibilityLabel = accessibilityLabel ?? (
        interactiveWebRole ? generatedAccessibilityLabel : undefined
    );
    const interactiveTabIndex = isWeb ? (webTabIndex ?? sharedItemBehavior.tabIndex) : undefined;
    const supportsSelectedAccessibilityState = isRadioRole || isCheckboxRole || interactiveWebRole === 'option';
    // React Native Web maps `accessibilityState.selected` to `aria-selected`.
    // That attribute is valid for option/radio-style composite choices, but not
    // for ordinary buttons or passive rows (for example settings destinations
    // and model-pack status rows). Keep `selected` as the visual owner while
    // omitting the invalid web semantic everywhere that has no selection role.
    const interactiveAccessibilityState = isCheckboxRole
        ? { ...sharedItemBehavior.accessibilityState, selected: undefined, checked: accessibilityChecked ?? selected === true }
        : isWeb && !supportsSelectedAccessibilityState
            ? { ...sharedItemBehavior.accessibilityState, selected: undefined }
            : sharedItemBehavior.accessibilityState;
    const webDisabledProps = isWeb && (disabled || loading)
        ? ({
            'data-disabled': 'true',
        } as const)
        : null;
    // An option without caller-supplied numbers takes the ones its list publishes (see listOptionSetPosition).
    const readsListOptionSetSize = interactiveWebRole === 'option' && accessibilitySetSize === undefined;
    const readsListOptionPosition = interactiveWebRole === 'option' && accessibilityPositionInSet === undefined;
    const webOptionIdentityProps = isWeb
        ? {
            ...(webId ? { id: webId } : {}),
            ...(accessibilityPositionInSet !== undefined
                ? { 'aria-posinset': accessibilityPositionInSet }
                : {}),
            ...(accessibilitySetSize !== undefined
                ? { 'aria-setsize': accessibilitySetSize }
                : {}),
        }
        : null;

    if (splitRow) {
        // Leading controls outside the row's own activation: they sit before it in one label band.
        const withOutsideLeading = (primary: React.ReactElement) => splitLeftElementOutsidePressable ? (
            <View style={[styles.labelBand, alignsToFirstLine ? styles.containerAlignStart : null, stackAccessory ? styles.labelBandStacked : null]}>
                <View style={[iconContainerStyle, alignsToFirstLine ? containerPadding : null]}>{leftAccessory}</View>
                {primary}
            </View>
        ) : primary;
        return (
            <>
                <View style={[containerCore, style, resolveInteractiveRowStyle(isSplitPrimaryPressed, isSplitPrimaryFocused)]} onLayout={measuresRowWidth ? handleRowLayout : undefined}>
                    {underlay}
                    {withOutsideLeading(<ListOptionPressable
                        readsListOptionSetSize={readsListOptionSetSize}
                        readsListOptionPosition={readsListOptionPosition}
                        ref={assignPressableRef}
                        testID={testID}
                        {...{ dataSet }}
                        {...webTestIdProps}
                        {...webDisabledProps}
                        {...webOptionIdentityProps}
                        onPress={handlePress}
                        onLongPress={handleLongPress}
                        // @ts-expect-error - react-native types do not model web-only double click props; RN Web supports onDoubleClick.
                        onDoubleClick={isWeb && onDoublePress ? (event: any) => {
                            if (Date.now() - webDoublePressHandledAtMsRef.current < 600) {
                                return;
                            }
                            webDoublePressHandledAtMsRef.current = Date.now();
                            webLastPressAtMsRef.current = null;
                            event?.preventDefault?.();
                            event?.stopPropagation?.();
                            onDoublePress();
                        } : undefined}
                        onPressIn={handlePressIn}
                        onPressOut={handlePressOut}
                        onHoverIn={isWeb && !disabled && !loading ? () => {
                            setIsHovered(true);
                            onHoverIn?.();
                        } : undefined}
                        onHoverOut={isWeb ? () => {
                            setIsHovered(false);
                            onHoverOut?.();
                        } : undefined}
                        onMouseDownCapture={isWeb ? (onMouseDownCapture as any) : undefined}
                        onContextMenu={isWeb ? (onContextMenu as any) : undefined}
                        onFocus={handleSplitFocus}
                        onBlur={handleSplitBlur}
                        {...(isWeb ? { 'aria-level': accessibilityLevel, 'aria-keyshortcuts': webKeyShortcuts } : undefined)}
                        onKeyDown={isWeb ? (event: Parameters<NonNullable<ItemProps['onKeyDown']>>[0]) => {
                            onKeyDown?.(event);
                            if (!event.defaultPrevented && isKeyboardActivatableRole) handleSemanticKeyDown(event);
                        } : undefined}
                        {...(interactiveWebRole ? { role: interactiveWebRole } : undefined)}
                        accessibilityRole={interactiveAccessibilityRole}
                        accessibilityLabel={resolvedAccessibilityLabel}
                        accessibilityHint={accessibilityHint}
                        accessibilityLiveRegion={accessibilityLiveRegion}
                        accessibilityActions={accessibilityActions}
                        onAccessibilityAction={onAccessibilityAction}
                        aria-label={resolvedAccessibilityLabel}
                        aria-live={accessibilityLiveRegion === 'none' ? 'off' : accessibilityLiveRegion}
                        accessibilityState={interactiveAccessibilityState}
                        aria-current={isWeb ? accessibilityCurrent : undefined}
                        aria-selected={interactiveWebRole === 'option' && selected !== undefined ? selected : undefined}
                        aria-checked={isRadioRole || isCheckboxRole ? accessibilityChecked ?? selected === true : undefined}
                        aria-expanded={accessibilityExpanded}
                        aria-disabled={disabled || loading ? true : undefined}
                        tabIndex={interactiveTabIndex as 0 | -1 | undefined}
                        disabled={disabled || loading}
                        style={[styles.splitPressable, stackAccessory ? styles.splitPressableStacked : null, splitPressFloorStyle, HAPPIER_FOCUS_RING_DELEGATED_STYLE,
                            isWeb && pressTargetEndFadePx !== undefined ? resolveHappierRowEndFadeStyle(pressTargetEndFadePx) as ViewStyle : null]}
                        android_ripple={(isAndroid || isWeb) ? {
                            color: theme.colors.surface.ripple,
                            borderless: false,
                            foreground: true
                        } : undefined}
                    >
                        <View style={[styles.splitPressableInner, containerPadding, stackAccessory ? styles.splitPressableInnerStacked : null]}>
                            {renderRowContent({
                                includeRightAccessory: !splitRightElementOutsidePressable,
                                includeLeftAccessory: !splitLeftElementOutsidePressable,
                            })}
                        </View>
                    </ListOptionPressable>)}
                    {splitRightElementOutsidePressable ? <View
                        style={[
                            styles.rightSection,
                            // A stacked page operation sits above the row's bottom padding.
                            stackAccessory ? [styles.rightSectionStacked, containerPadding, styles.splitRightSectionStacked] : null,
                            // The same rule as the row's own right section: measured inline, not halved again.
                            !stackAccessory && (adaptiveAccessory || accessoryMaxWidth === 'row') ? styles.rightSectionField : null,
                            isMenuRow && !stackAccessory ? MENU_ROW_TRAILING : null,
                            stackedLabelEdgeStyle,
                        ]}
                        // Outside controls own their activation, independently of the primary row.
                        {...(isWeb ? { onPointerEnter: () => setIsAccessoryHovered(true), onPointerLeave: () => setIsAccessoryHovered(false) } : {})}
                    >
                        {rightAccessory}
                    </View> : null}
                </View>
                {bottom}
                {dividerNode}
            </>
        );
    }

    if (isInteractive) {
        const pressable = (
            <ListOptionPressable
                readsListOptionSetSize={readsListOptionSetSize}
                readsListOptionPosition={readsListOptionPosition}
                ref={assignPressableRef}
                testID={testID}
                {...{ dataSet }}
                {...webTestIdProps}
                {...webDisabledProps}
                {...webOptionIdentityProps}
                onPress={handlePress}
                onLongPress={handleLongPress}
                // @ts-expect-error - react-native types do not model web-only double click props; RN Web supports onDoubleClick.
                onDoubleClick={isWeb && onDoublePress ? (event: any) => {
                    if (Date.now() - webDoublePressHandledAtMsRef.current < 600) {
                        return;
                    }
                    webDoublePressHandledAtMsRef.current = Date.now();
                    webLastPressAtMsRef.current = null;
                    event?.preventDefault?.();
                    event?.stopPropagation?.();
                    onDoublePress();
                } : undefined}
                onPressIn={handlePressIn}
                onHoverIn={isWeb && !disabled && !loading ? () => {
                    setIsHovered(true);
                    onHoverIn?.();
                } : undefined}
                onHoverOut={isWeb ? () => {
                    setIsHovered(false);
                    onHoverOut?.();
                } : undefined}
                onMouseDownCapture={isWeb ? (onMouseDownCapture as any) : undefined}
                onContextMenu={isWeb ? (onContextMenu as any) : undefined}
                onFocus={onFocus}
                onBlur={onBlur}
                        {...(isWeb ? { 'aria-level': accessibilityLevel, 'aria-keyshortcuts': webKeyShortcuts } : undefined)}
                        onKeyDown={isWeb ? (event: Parameters<NonNullable<ItemProps['onKeyDown']>>[0]) => {
                            onKeyDown?.(event);
                            if (!event.defaultPrevented && isKeyboardActivatableRole) handleSemanticKeyDown(event);
                        } : undefined}
                {...(interactiveWebRole ? { role: interactiveWebRole } : undefined)}
                accessibilityRole={interactiveAccessibilityRole}
                accessibilityLabel={resolvedAccessibilityLabel}
                accessibilityHint={accessibilityHint}
                accessibilityLiveRegion={accessibilityLiveRegion}
                accessibilityActions={accessibilityActions}
                onAccessibilityAction={onAccessibilityAction}
                aria-label={resolvedAccessibilityLabel}
                aria-live={accessibilityLiveRegion === 'none' ? 'off' : accessibilityLiveRegion}
                accessibilityState={interactiveAccessibilityState}
                aria-current={isWeb ? accessibilityCurrent : undefined}
                aria-selected={interactiveWebRole === 'option' && selected !== undefined ? selected : undefined}
                aria-checked={isRadioRole || isCheckboxRole ? accessibilityChecked ?? selected === true : undefined}
                aria-expanded={accessibilityExpanded}
                aria-disabled={disabled || loading ? true : undefined}
                tabIndex={interactiveTabIndex as 0 | -1 | undefined}
                disabled={disabled || loading}
                style={(state) => resolveInteractiveRowStyle(state.pressed, (state as typeof state & { focused?: boolean }).focused)}
                android_ripple={(isAndroid || isWeb) ? {
                    color: theme.colors.surface.ripple,
                    borderless: false,
                    foreground: true
                } : undefined}
            >
                {content}
            </ListOptionPressable>
        );
        return bottomBelowPressable ? <>{pressable}{bottom}{dividerNode}</> : pressable;
    }

    return (
        <View
            testID={testID}
            {...{ dataSet }}
            {...webTestIdProps}
            {...webOptionIdentityProps}
            {...(isWeb && !disabled && !loading ? { onContextMenu, onKeyDown, onFocus, onBlur } : {})}
            // A row with no press of its own still tells its owner when the pointer is over it (a reveal slot
            // such as Reset); it paints no hover of its own, which belongs to pressable rows.
            {...(isWeb && !disabled && !loading && (onHoverIn || onHoverOut)
                ? { onPointerEnter: () => onHoverIn?.(), onPointerLeave: () => onHoverOut?.() }
                : {})}
            {...(passiveWebRole ? { role: passiveWebRole } : undefined)}
            accessibilityRole={isWeb ? undefined : accessibilityRole}
            accessibilityLabel={accessibilityLabel ?? (passiveWebRole ? generatedAccessibilityLabel : undefined)}
            accessibilityHint={accessibilityHint}
            accessibilityLiveRegion={accessibilityLiveRegion}
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
            aria-label={accessibilityLabel ?? (passiveWebRole ? generatedAccessibilityLabel : undefined)}
            aria-live={accessibilityLiveRegion === 'none' ? 'off' : accessibilityLiveRegion}
            accessibilityState={interactiveAccessibilityState}
            aria-current={isWeb ? accessibilityCurrent : undefined}
            aria-selected={interactiveWebRole === 'option' && selected !== undefined ? selected : undefined}
            aria-checked={isRadioRole || isCheckboxRole ? accessibilityChecked ?? selected === true : undefined}
            aria-expanded={accessibilityExpanded}
            aria-disabled={disabled || loading ? true : undefined}
            tabIndex={isWeb && (webRole || onKeyDown || onContextMenu || webTabIndex !== undefined)
                ? disabled || loading ? -1 : webTabIndex ?? (onKeyDown || onContextMenu ? 0 : undefined)
                : undefined}
            // A selected choice keeps its mark while it cannot be pressed (read-only, or its owner is
            // unavailable), exactly as the pressable row draws it.
            style={showSelectedBackground
                ? [
                    { backgroundColor: paintColor(theme.colors.surface.selected), opacity: disabled ? 0.5 : 1 },
                    getItemGroupRowCornerRadii({ hasBackground: true, position: rowPosition, radius: groupCornerRadius }),
                    pressableStyle,
                ]
                : [{ opacity: disabled ? 0.5 : 1 }, pressableStyle]}
        >
            {content}
        </View>
    );
}

/**
 * A list row. In a bare section (`SectionRowBleedContext`) it reaches past the section's content by its bleed, so its
 * mark and text keep the section's edge while its fills and dividers reach into the margin.
 */
export const Item = React.memo<ItemProps>((props) => {
    const sectionBleed = useSectionRowBleedStyle();
    // A page directory row draws the same edges on its own fill (`DIRECTORY_ROW_EDGES`): its cells may stand in
    // columns, where a bleeding box would cross the gap.
    const directoryRow = React.useContext(PageDirectoryRowsContext);
    if (!sectionBleed) return <ItemRow {...props} />;
    // Only the section's own rows bleed: a row drawn inside this one (an accessory, an expanded body) does not.
    const row = <SectionRowBleedContext.Provider value={0}><ItemRow {...props} rowBleedPx={-sectionBleed.marginHorizontal} /></SectionRowBleedContext.Provider>;
    return directoryRow ? row : <View style={sectionBleed}>{row}</View>;
});
