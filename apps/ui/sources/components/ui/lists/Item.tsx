import * as React from 'react';
import { View, Pressable, StyleProp, ViewStyle, TextStyle, Platform, type AccessibilityRole, type TextProps, type ViewProps, type LayoutChangeEvent } from 'react-native';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    ItemGroupSelectionContext,
} from '@/components/ui/lists/ItemGroup';
import { useItemGroupRowPosition } from '@/components/ui/lists/ItemGroupRowPosition';
import { ItemRowAccessibleNameProvider } from '@/components/ui/lists/ItemRowAccessibleName';
import { getItemGroupRowCornerRadii } from '@/components/ui/lists/itemGroupRowCorners';
import {
    resolveItemSubtitleMaxLines,
    resolveItemTitleMaxLines,
} from '@/components/ui/lists/itemTextClamp';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import {
    WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE,
    WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE,
} from '@/components/ui/text/webStartEllipsisTextStyles';
import { useItemDensityInputs } from '@/components/ui/lists/useResolvedItemDensity';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import {
    ITEM_CHEVRON_SIZE,
    ITEM_ICON_BOX_SIZE,
    ITEM_ICON_GLYPH_SIZE,
    MENU_ROW_METRICS,
    ITEM_ICON_MARGIN_RIGHT,
    ITEM_ROW_PADDING_HORIZONTAL,
    ITEM_SUBTITLE_TEXT_METRICS,
    ITEM_TITLE_TEXT_METRICS,
} from '@/components/ui/lists/itemDensityMetrics';
import {
    isTouchPrimaryPointer,
    resolvePageRowDensityInput,
    resolvePageRowMetrics,
    type PageRowMetrics,
} from './pageRowMetrics';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { buildActionRowAccessibilityLabel } from './actionRowAccessibility';
import { Icon } from '@/components/ui/icons/Icon';
import { ICON_LABEL_OPTICAL_NUDGE_STYLE } from '@/components/ui/icons/iconOpticalAlignment';
import { useListPresentation } from './listPresentation';
import { GROUPED_SURFACE_RADIUS_PX, PAGE_LIST_METRICS } from './pageListMetrics';
import { useSectionLeadingColumn } from './sectionLeadingColumn';
import {
    HAPPIER_COLLECTION_LIST_METRICS,
    HAPPIER_META_COLUMN_STYLE,
    resolveHappierItemBehavior,
    HappierDivider,
    useHappierItemGroupItemBehavior,
    useHappierPageSection,
} from '@happier-dev/plugin-ui/presentation';

function resizeItemIconForDensity(icon: React.ReactNode, iconSize: number, color?: string): React.ReactNode {
    if (!React.isValidElement(icon) || icon.type === React.Fragment) {
        return icon;
    }

    return React.cloneElement(icon, {
        size: iconSize,
        ...(color ? { color } : null),
    } as Record<string, unknown>);
}

type ItemTextEllipsizeMode = NonNullable<TextProps['ellipsizeMode']>;

const WEB_MIDDLE_ELLIPSIS_ROW_STYLE = { display: 'flex', flexDirection: 'row', overflow: 'hidden', minWidth: 0 } as const;
const WEB_MIDDLE_ELLIPSIS_HEAD_STYLE = { flexShrink: 1, minWidth: 0 } as const;
const WEB_MIDDLE_ELLIPSIS_TAIL_STYLE = { flexShrink: 0 } as const;

/** Where a middle ellipsis keeps the end: a path's last segment, otherwise the last two fifths. */
function splitForWebMiddleEllipsis(value: string): Readonly<{ head: string; tail: string }> | null {
    const slash = value.lastIndexOf('/');
    if (slash > 0 && slash < value.length - 1) return { head: value.slice(0, slash), tail: value.slice(slash) };
    if (value.length < 8) return null;
    const cut = Math.ceil(value.length * 0.6);
    return { head: value.slice(0, cut), tail: value.slice(cut) };
}

/** The share of a wide row an adaptive control may take beside its label (the accessory slot's cap). */
const ADAPTIVE_ACCESSORY_MAX_ROW_SHARE = 0.5;

export interface ItemProps {
    testID?: string;
    /** Native/web metadata on the primary row host, never on secondary controls. */
    /** RN Web metadata; native ViewProps intentionally omit this web-only carrier. */
    dataSet?: Readonly<Record<string, unknown>>;
    /** Imperative focus target for list owners that restore focus after row removal. */
    pressableRef?: React.Ref<React.ComponentRef<typeof Pressable>>;
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    subtitleTestID?: string;
    subtitleAccessory?: React.ReactNode;
    /** Full-width row content below identity and controls, before this row's divider. */
    bottomElement?: React.ReactNode;
    /** An inline mark after a string title, such as a "Beta" badge. */
    titleAccessory?: React.ReactNode;
    /** An inline mark before a string subtitle, such as a status dot that flags trouble. */
    subtitleLeading?: React.ReactNode;
    /** Override the primitive title allowance; page labels grow, grouped labels keep their compact allowance. */
    titleLines?: number;
    /** Override the primitive subtitle allowance; 0 permits multiline, page descriptions grow by default. */
    subtitleLines?: number;
    detail?: string;
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
     * Which surface this row belongs to.
     *
     * A menu row is a transient list of choices, not a destination with room to breathe, so it takes
     * the flat {@link MENU_ROW_METRICS} — a smaller glyph on a shorter row — and ignores the list
     * density setting entirely. See that constant for why density has no business reaching a menu.
     */
    rowRole?: 'item' | 'menu';
    rightElement?: React.ReactNode;
    onPress?: () => void;
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
    destructive?: boolean;
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
     * Where the right accessory sits. `inline` (default) keeps it beside the
     * label; `stacked` always places it under the label at full width (visual pickers, text areas);
     * `adaptive` moves it under the label only when the row is too narrow for both (segmented controls,
     * field selects), using the row's own width in pages, grouped sections and popovers.
     */
    accessoryLayout?: 'inline' | 'stacked' | 'adaptive';
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
const MENU_ROW_PADDING_STYLE = { paddingVertical: MENU_ROW_METRICS.paddingVerticalPx } as const;

type PageRowStyles = Readonly<{
    box: Readonly<{ minHeight: number }>;
    padding: Readonly<{ paddingVertical: number }>;
    title: Readonly<Record<string, unknown>>;
    subtitle: Readonly<Record<string, unknown>>;
    detail: Readonly<Record<string, unknown>>;
    accessoryBleed: Readonly<{ marginVertical: number }>;
}>;

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
        title: { ...metrics.title, ...Typography.default('medium') },
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
        paddingVertical: Platform.select({ ios: 11, default: 16 }),
    },
    containerWithSubtitleCompact: {
        paddingVertical: Platform.select({ ios: 7, default: 6 }),
    },
    containerWithSubtitleCozy: {
        paddingVertical: Platform.select({ ios: 9, default: 10 }),
    },
    containerWithSubtitleTight: {
        paddingVertical: Platform.select({ ios: 7, default: 2 }),
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
    iconContainer: {
        marginRight: 12,
        width: ITEM_ICON_BOX_SIZE.comfortable,
        height: ITEM_ICON_BOX_SIZE.comfortable,
        alignItems: 'center',
        justifyContent: 'center',
        // Optical, not geometric — see ICON_LABEL_OPTICAL_NUDGE_STYLE.
        ...ICON_LABEL_OPTICAL_NUDGE_STYLE,
    },
    iconContainerCompact: {
        marginRight: 10,
        width: ITEM_ICON_BOX_SIZE.compact,
        height: ITEM_ICON_BOX_SIZE.compact,
    },
    iconContainerCozy: {
        marginRight: 14,
        width: ITEM_ICON_BOX_SIZE.cozy,
        height: ITEM_ICON_BOX_SIZE.cozy,
    },
    iconContainerTight: {
        marginRight: 8,
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
    titleCozy: {
        ...ITEM_TITLE_TEXT_METRICS.cozy,
    },
    titleTight: {
        ...ITEM_TITLE_TEXT_METRICS.tight,
    },
    titleNormal: {
        color: theme.colors.text.primary,
    },
    titleSelected: {
        color: theme.colors.text.primary,
    },
    titleDestructive: {
        color: theme.colors.state.danger.foreground,
    },
    inlineMarkRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
    },
    subtitleMarkRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 6,
        minWidth: 0,
    },
    subtitleMarkSlot: {
        justifyContent: 'center',
    },
    inlineMarkText: {
        flexShrink: 1,
        minWidth: 0,
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
        marginLeft: 8,
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
        gap: 10,
    },
    pageDivider: {
        height: StyleSheet.hairlineWidth,
    },
    accessoryMeasure: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
    },
    accessoryInline: {
        // Bound the accessory's root to its slot. Its internal flexible content can then
        // shrink around controls instead of painting past the row's trailing edge.
        minWidth: 0,
        maxWidth: '100%',
        flexShrink: 1,
    },
    accessoryMeasureStacked: {
        alignSelf: 'stretch',
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
    pressablePressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
}));

export const Item = React.memo<ItemProps>((props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const selectionContext = React.useContext(ItemGroupSelectionContext);
    const rowPosition = useItemGroupRowPosition();

    // Platform-specific measurements
    const isIOS = Platform.OS === 'ios';
    const isAndroid = Platform.OS === 'android';
    const isWeb = Platform.OS === 'web';
    const hoverBackgroundColor = theme.colors.surface.pressed;
    const copyFeedback = useTemporaryCopyFeedback();
    
    const {
        testID,
        dataSet,
        pressableRef,
        title,
        subtitle,
        subtitleTestID,
        subtitleAccessory,
        bottomElement,
        titleAccessory,
        subtitleLeading,
        titleLines,
        subtitleLines,
        detail,
        detailTestID,
        icon,
        leftElement,
        leftElementWhenHovered,
        iconBoxSize,
    rowRole,
        rightElement,
        onPress,
        onDoublePress,
        onLongPress,
        onPressIn,
        onMouseDownCapture,
        onContextMenu,
        onHoverIn,
        onHoverOut,
        accessibilityRole,
        accessibilityChecked,
        accessibilityCurrent,
        accessibilityLabel,
        accessibilityHint,
        accessibilityLiveRegion,
        accessibilityActions,
        onAccessibilityAction,
        accessibilityExpanded: explicitAccessibilityExpanded,
        accessibilityState,
        webRole,
        webTabIndex,
        accessibilityLevel,
        webKeyShortcuts,
        onFocus,
        onBlur,
        onKeyDown,
        webId,
        accessibilityPositionInSet,
        accessibilitySetSize,
        disabled,
        loading,
        selected,
        focused,
        destructive,
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
        accessoryLayout = 'inline',
        showDivider = true,
        dividerInset = isIOS ? 15 : 16,
        pressableStyle,
        copy,
        itemGroupRadioIndex,
    } = props;
    const accessibilityExpanded = explicitAccessibilityExpanded ?? accessibilityState?.expanded;
    const webTestIdProps = isWeb && testID
        ? ({ 'data-testid': testID } as const)
        : undefined;
    const titleLabel = typeof title === 'string' || typeof title === 'number' ? String(title) : '';

    // Handle copy functionality
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
        
        const copied = await setClipboardStringSafe(textToCopy);
        if (!copied) {
            Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
            return false;
        }
        copyFeedback.markCopied();
        return true;
    }, [copy, copyFeedback, detail, subtitle, titleLabel]);
    
    const longPressConsumedRef = React.useRef(false);
    const [isSplitPrimaryPressed, setIsSplitPrimaryPressed] = React.useState(false);

    // Handle long press for copy functionality
    const handlePressIn = React.useCallback(() => {
        longPressConsumedRef.current = false;
        if (rightElementOutsidePressable && rightElement) setIsSplitPrimaryPressed(true);
        onPressIn?.();
    }, [onPressIn, rightElement, rightElementOutsidePressable]);
    const handlePressOut = React.useCallback(() => {
        setIsSplitPrimaryPressed(false);
    }, []);
    
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

        onPress?.();
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
    const isCheckboxRole = accessibilityRole === 'checkbox' || webRole === 'checkbox';
    const inferredInteractiveWebRole = isWeb
        ? (webRole ?? (isRadioRole ? 'radio' : isCheckboxRole ? 'checkbox' : (accessibilityRole === 'button' || !rightElement || rightElementOutsidePressable ? 'button' : undefined)))
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
    const requestedDensity = densityInputs.resolved;
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
        hasSecondaryActions: Boolean(rightElement && rightElementOutsidePressable),
        hasAccessory: Boolean(rightElement),
        accessoryOutsidePressable: rightElementOutsidePressable,
        showNavigationAccessory: showChevron,
        keepNavigationAccessoryWithAccessory: keepChevronWithRightElement,
        showDivider,
    });
    const resolvedDensity = sharedItemBehavior.density;

    // Only show the navigation chevron when the row has an actual "tap to do something" affordance.
    // Long-press copy rows (mobile) and long-press-only rows should not look like navigation.
    // A `rightElement` normally claims the right slot and hides the chevron, UNLESS the row opts
    // into `keepChevronWithRightElement` (badge + chevron together).
    const showAccessory = !isInfoMode
        && Boolean(onPress || onDoublePress)
        && sharedItemBehavior.navigationAccessoryVisible;
    const showSelectedBackground = sharedItemBehavior.selectionVisible;
    const groupCornerRadius = GROUPED_SURFACE_RADIUS_PX;

    const titleColor = destructive ? styles.titleDestructive : (selected ? styles.titleSelected : styles.titleNormal);
    const isCozy = resolvedDensity === 'cozy';
    const isCompact = resolvedDensity === 'compact';
    const isTight = resolvedDensity === 'tight';
    const hasSubtitleContent = Boolean(subtitle || subtitleAccessory);
    const isMenuRow = rowRole === 'menu';
    const listPresentation = useListPresentation();
    const isPageRow = listPresentation === 'page' && !isMenuRow;
    // A page row is drawn at the user's density; a section's `compact` asks for its list shape.
    const pageRowMetrics = isPageRow
        ? resolvePageRowMetrics({
            ...resolvePageRowDensityInput({
                preferred: densityInputs.preferred,
                requested: resolvedDensity,
                requestedExplicitly: densityInputs.requested,
            }),
            touch: isTouchPrimaryPointer(),
        })
        : null;
    const pageRowStyles = pageRowMetrics ? resolvePageRowStyles(pageRowMetrics) : null;
    const [isNarrowRow, setIsNarrowRow] = React.useState(false);
    const [rowWidthPx, setRowWidthPx] = React.useState<number | null>(null);
    const [accessoryWidthPx, setAccessoryWidthPx] = React.useState<number | null>(null);
    // An independently activated page operation follows the phone rule even when a caller asks
    // for inline placement. Grouped controls retain their explicitly chosen composition.
    const adaptiveAccessory = accessoryLayout === 'adaptive'
        || (isPageRow && rightElementOutsidePressable && accessoryLayout === 'inline');
    const measuresRowWidth = adaptiveAccessory;
    const handleRowLayout = React.useCallback((event: LayoutChangeEvent) => {
        const widthPx = event.nativeEvent.layout.width;
        if (!Number.isFinite(widthPx) || widthPx <= 0) return;
        const next = widthPx < PAGE_LIST_METRICS.rowStackBelowWidthPx;
        setIsNarrowRow((current) => (current === next ? current : next));
        setRowWidthPx((current) => (current === widthPx ? current : widthPx));
    }, []);
    // An adaptive control also moves beneath the label when its natural width does not fit its half of
    // a wide row (a segmented bar of long labels), instead of overflowing the sheet.
    const accessoryOverflows = rowWidthPx !== null && accessoryWidthPx !== null
        && accessoryWidthPx > rowWidthPx * ADAPTIVE_ACCESSORY_MAX_ROW_SHARE;
    // A menu is narrow by design: its adaptive control (a segmented choice) stays beside the label and
    // moves beneath it only when it would take more than its share of the row.
    const stackAccessory = rightElement != null
        && (accessoryLayout === 'stacked' || (adaptiveAccessory && ((isNarrowRow && !isMenuRow) || accessoryOverflows)));
    const stackAccessoryRef = React.useRef(stackAccessory);
    stackAccessoryRef.current = stackAccessory;
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
    const pageSheetContext = useHappierPageSection();
    const pageSheet = isMenuRow ? null : pageSheetContext;
    const pageSheetInsetStyle = pageSheet ? resolveSheetRowInsetStyle(pageSheet.rowInsetPx) : null;
    const pageContainerStyle = pageRowStyles || pageSheetInsetStyle
        ? [pageRowStyles ? styles.pageContainer : null, pageRowStyles?.box ?? null, pageSheetInsetStyle]
        : null;
    const stackedContainerStyle = stackAccessory ? styles.pageContainerStacked : null;
    const containerPadding = pageRowStyles
        ? pageRowStyles.padding
        : isMenuRow
        ? MENU_ROW_PADDING_STYLE
        : hasSubtitleContent
            ? (isTight ? styles.containerWithSubtitleTight : isCompact ? styles.containerWithSubtitleCompact : isCozy ? styles.containerWithSubtitleCozy : styles.containerWithSubtitle)
            : (isTight ? styles.containerWithoutSubtitleTight : isCompact ? styles.containerWithoutSubtitleCompact : isCozy ? styles.containerWithoutSubtitleCozy : styles.containerWithoutSubtitle);
    const containerCore = isTight
        ? [styles.container, styles.containerTight, isMenuRow ? MENU_ROW_HEIGHT_STYLE : null, pageContainerStyle, stackedContainerStyle]
        : isCompact
            ? [styles.container, styles.containerCompact, isMenuRow ? MENU_ROW_HEIGHT_STYLE : null, pageContainerStyle, stackedContainerStyle]
            : isCozy
                ? [styles.container, styles.containerCozy, isMenuRow ? MENU_ROW_HEIGHT_STYLE : null, pageContainerStyle, stackedContainerStyle]
            : [styles.container, isMenuRow ? MENU_ROW_HEIGHT_STYLE : null, pageContainerStyle, stackedContainerStyle];
    const iconBoxSizeOverride = iconBoxSize != null
        ? { width: iconBoxSize, height: iconBoxSize }
        : null;
    const resolvedIconDensity = isTight ? 'tight' : isCompact ? 'compact' : isCozy ? 'cozy' : 'comfortable';
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
    // the density's glyph box. Centred in the fixed box it would overhang toward the sheet edge and
    // crowd the title, so the box grows to the mark instead; the density size stays its minimum.
    // Every page row's leading column is one fixed width (a glyph sits centred in it; a larger identity
    // mark grows it), so the titles of a section share one edge.
    const pageLeadingColumnStyle = isPageRow
        ? {
            width: PAGE_LIST_METRICS.rowLeadingColumnPx,
            height: 'auto',
            minHeight: PAGE_LIST_METRICS.rowLeadingColumnPx,
            marginRight: PAGE_LIST_METRICS.rowLeadingGapPx,
        } as const
        : null;
    const leadingMarkFitStyle = isPageRow && leftElement != null && iconBoxSize == null
        ? { width: 'auto', height: 'auto', minWidth: PAGE_LIST_METRICS.rowLeadingColumnPx, minHeight: PAGE_LIST_METRICS.rowLeadingColumnPx } as const
        : null;
    const iconContainerStyle = isTight
        ? [styles.iconContainer, styles.iconContainerTight, menuIconBoxStyle, pageLeadingColumnStyle, leadingMarkFitStyle, iconBoxSizeOverride]
        : isCompact
            ? [styles.iconContainer, styles.iconContainerCompact, menuIconBoxStyle, pageLeadingColumnStyle, leadingMarkFitStyle, iconBoxSizeOverride]
            : isCozy
                ? [styles.iconContainer, styles.iconContainerCozy, menuIconBoxStyle, pageLeadingColumnStyle, leadingMarkFitStyle, iconBoxSizeOverride]
            : [styles.iconContainer, menuIconBoxStyle, pageLeadingColumnStyle, leadingMarkFitStyle, iconBoxSizeOverride];
    const resolvedIconMarginRight = isMenuRow
        ? MENU_ROW_METRICS.iconMarginRightPx
        : ITEM_ICON_MARGIN_RIGHT[resolvedIconDensity];
    // A page navigation row's glyph is a landmark, not a status: one family, one size and the
    // secondary text colour, whatever tint the call site passed. Identity marks (`leftElement`) and
    // status glyphs on non-navigation rows keep their own colour.
    const pageNavigationIconColor = isPageRow && showAccessory ? theme.colors.text.secondary : undefined;
    const sizedIcon = React.useMemo(
        () => resizeItemIconForDensity(icon, resolvedIconGlyphSize, pageNavigationIconColor),
        [icon, pageNavigationIconColor, resolvedIconGlyphSize],
    );
    const titleSizeStyle = pageRowStyles
        ? pageRowStyles.title
        : isTight ? styles.titleTight : isCompact ? styles.titleCompact : isCozy ? styles.titleCozy : null;
    const subtitleSizeStyle = pageRowStyles
        ? pageRowStyles.subtitle
        : isTight ? styles.subtitleTight : isCompact ? styles.subtitleCompact : isCozy ? styles.subtitleCozy : null;
    const detailSizeStyle = pageRowStyles ? pageRowStyles.detail : isTight ? styles.detailTight : isCompact ? styles.detailCompact : isCozy ? styles.detailCozy : null;

    const [isHovered, setIsHovered] = React.useState(false);
    React.useEffect(() => {
        // Keep hover state coherent with disabled/loading changes.
        if (disabled || loading) setIsHovered(false);
    }, [disabled, loading]);

    // A page section reserves the leading column for all its rows when any row has an icon or mark.
    const reservesLeadingColumn = useSectionLeadingColumn(isPageRow && (icon != null || leftElement != null));
    const leftAccessory = React.useMemo(() => {
        const candidate = (isHovered ? leftElementWhenHovered : null) ?? leftElement ?? sizedIcon ?? null;
        return normalizeNodeForView(candidate);
    }, [isHovered, leftElement, leftElementWhenHovered, sizedIcon]);
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
                {isPageRow ? <RoundButtonSizeScope size="small">{normalized}</RoundButtonSizeScope> : normalized}
            </ItemRowAccessibleNameProvider>
        );
        if (!measuresRowWidth) return <View style={stackAccessory ? styles.accessoryMeasureStacked : styles.accessoryInline}>{named}</View>;
        return (
            <View onLayout={handleAccessoryLayout} style={stackAccessory ? styles.accessoryMeasureStacked : styles.accessoryMeasure}>
                {named}
            </View>
        );
    }, [accessoryAccessibleName, handleAccessoryLayout, isPageRow, measuresRowWidth, rightElement, stackAccessory]);
    const subtitleAccessoryNode = React.useMemo(() => normalizeNodeForView(subtitleAccessory ?? null), [subtitleAccessory]);
    const chevronAccessory = React.useMemo(() => {
        if (!showAccessory) return null;
        // A disclosure header's chevron shows whether the row is open; a destination's points onward.
        const name = accessibilityExpanded === undefined ? 'caret-right' : accessibilityExpanded ? 'caret-up' : 'caret-down';
        return normalizeNodeForView(
            <Icon
                name={name}
                size={chevronSize}
                color={theme.colors.text.secondary}
                style={{ marginLeft: 4 }}
            />,
        );
    }, [accessibilityExpanded, chevronSize, showAccessory, theme.colors.text.secondary]);

    // A sheet row's hairline is the sheet's: its divider colour, full width. A page row outside a sheet
    // (a bare or columned section) draws the same page hairline in the page divider colour.
    const flatDividerColor = pageSheet?.rowDividerColor ?? (isPageRow ? theme.colors.border.subtle : null);
    const dividerNode = sharedItemBehavior.dividerVisible ? (
        <HappierDivider
            color={flatDividerColor ?? theme.colors.border.default}
            style={[
                styles.divider,
                flatDividerColor !== null ? styles.pageDivider : null,
                flatDividerColor !== null ? { marginLeft: 0 } : {
                    marginLeft: (isAndroid || isWeb)
                        ? 0
                        : (dividerInset + (icon || leftElement ? (16 + (iconBoxSize ?? resolvedIconBoxSize) + resolvedIconMarginRight) : 16))
                }
            ]}
        />
    ) : null;
    
    const renderPrimitiveText = React.useCallback((params: Readonly<{
        value: string | number;
        style: StyleProp<TextStyle>;
        numberOfLines?: number;
        ellipsizeMode?: ItemTextEllipsizeMode;
        testID?: string;
    }>) => {
        const value = String(params.value);
        const useWebStartEllipsis = isWeb && params.ellipsizeMode === 'head';
        // The web draws only a tail ellipsis, so a one-line middle ellipsis is two runs: the head
        // shrinks with its own ellipsis and the end (a path's last segment) stays whole.
        const webMiddle = isWeb && params.ellipsizeMode === 'middle' && params.numberOfLines === 1
            ? splitForWebMiddleEllipsis(value)
            : null;
        if (webMiddle) {
            return (
                <Text testID={params.testID} style={[params.style, WEB_MIDDLE_ELLIPSIS_ROW_STYLE]}>
                    <Text style={WEB_MIDDLE_ELLIPSIS_HEAD_STYLE} numberOfLines={1} ellipsizeMode="tail">{webMiddle.head}</Text>
                    <Text style={WEB_MIDDLE_ELLIPSIS_TAIL_STYLE} numberOfLines={1}>{webMiddle.tail}</Text>
                </Text>
            );
        }
        return (
            <Text
                testID={params.testID}
                style={[
                    params.style,
                    useWebStartEllipsis ? WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE : null,
                ]}
                numberOfLines={params.numberOfLines}
                ellipsizeMode={params.ellipsizeMode}
            >
                {useWebStartEllipsis ? (
                    <Text style={WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE}>{value}</Text>
                ) : value}
            </Text>
        );
    }, [isWeb]);

    const renderRowContent = React.useCallback((options?: Readonly<{ includeRightAccessory?: boolean }>) => {
        const includeRightAccessory = options?.includeRightAccessory ?? true;
        // A split primary remains a bounded horizontal label/value band. Its independent
        // operation stacks outside this band, so only content containing that operation stacks.
        const stackContentAccessory = stackAccessory && includeRightAccessory;
        return (
        <>
            <View style={[styles.labelBand, stackContentAccessory ? styles.labelBandStacked : null]}>
            {/* Left Section */}
            {leftAccessory || (isPageRow && reservesLeadingColumn) ? (
                <View
                    style={iconContainerStyle}
                    // An empty reserved column is layout only.
                    {...(leftAccessory ? null : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const })}
                >
                    {leftAccessory}
                </View>
            ) : null}

            {/* Center Section */}
            <View style={styles.centerContent}>
                {(typeof title === 'string' || typeof title === 'number') && titleAccessory ? (
                    <View style={styles.inlineMarkRow}>
                        <View style={styles.inlineMarkText}>
                            {renderPrimitiveText({
                                value: title,
                                style: [styles.title, titleSizeStyle, titleColor, titleStyle],
                                numberOfLines: titleLines ?? resolveItemTitleMaxLines(Boolean(subtitle), { page: isPageRow, hasAccessory: true }) ?? undefined,
                                ellipsizeMode: titleEllipsizeMode,
                            })}
                        </View>
                        {titleAccessory}
                    </View>
                ) : typeof title === 'string' || typeof title === 'number' ? (
                    renderPrimitiveText({
                        value: title,
                        style: [styles.title, titleSizeStyle, titleColor, titleStyle],
                        numberOfLines: titleLines ?? resolveItemTitleMaxLines(Boolean(subtitle), { page: isPageRow }) ?? undefined,
                        ellipsizeMode: titleEllipsizeMode,
                    })
                ) : (
                    normalizeNodeForView(title)
                )}
                {subtitle ? (() => {
                    // If subtitle is a ReactNode (not string), render as-is.
                    // This enables richer subtitle layouts (e.g. inline glyphs).
                    if (typeof subtitle !== 'string') {
                        const wrapPrimitive = (value: string | number) => {
                            const asText = String(value);
                            const effectiveLines = resolveItemSubtitleMaxLines({ text: asText, subtitleLines, page: isPageRow }) ?? undefined;

                            return renderPrimitiveText({
                                value: asText,
                                style: [styles.subtitle, subtitleSizeStyle, subtitleStyle],
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
                                {normalized}
                            </View>
                        );
                    }

                    // Page descriptions grow; grouped rows keep their compact allowance unless overridden.
                    const effectiveLines = resolveItemSubtitleMaxLines({
                        text: subtitle,
                        subtitleLines,
                        status: subtitleLeading != null,
                        page: isPageRow,
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
                                        style: [styles.subtitle, subtitleSizeStyle, subtitleStyle],
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
                        style: [styles.subtitle, subtitleSizeStyle, subtitleStyle],
                        numberOfLines: effectiveLines,
                        ellipsizeMode: subtitleEllipsizeMode,
                    });
                })() : null}
                {subtitleAccessoryNode ? (
                    <View style={{ marginTop: 0 }}>
                        {subtitleAccessoryNode}
                    </View>
                ) : null}
            </View>

            </View>
            {/* Right Section */}
            <View style={[styles.rightSection, stackContentAccessory ? styles.rightSectionStacked : pageRowStyles?.accessoryBleed]}>
                {copyFeedback.isCopied() ? (
                    <CopiedPill visible testID="item-copy-feedback" />
                ) : detail ? (
                    <Text
                        testID={detailTestID}
                        style={[
                            styles.detail,
                            detailSizeStyle,
                            { marginRight: rightElement || showAccessory ? 8 : 0 },
                            detailStyle
                        ]}
                        numberOfLines={1}
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
                {chevronAccessory}
            </View>
        </>
    );
    }, [
        chevronAccessory,
        copyFeedback,
        stackAccessory,
        detail,
        detailTestID,
        detailSizeStyle,
        detailStyle,
        iconContainerStyle,
        isPageRow,
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
        subtitleEllipsizeMode,
        subtitleLines,
        subtitleSizeStyle,
        styles.centerContent,
        styles.detail,
        styles.inlineMarkRow,
        styles.inlineMarkText,
        styles.rightSection,
        styles.subtitle,
        style,
        title,
        titleColor,
        titleEllipsizeMode,
        titleLines,
        titleSizeStyle,
        titleStyle,
        theme.colors.text.secondary,
    ]);

    const bottom = bottomElement ? <View style={{ paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx, paddingBottom: PAGE_LIST_METRICS.rowPaddingVerticalPx }}>{bottomElement}</View> : null;
    const content = React.useMemo(() => (
        <>
            <View style={[containerCore, containerPadding, style]} onLayout={measuresRowWidth ? handleRowLayout : undefined}>
                {renderRowContent()}
            </View>

            {bottom}
            {dividerNode}
        </>
    ), [
        containerCore,
        bottom,
        containerPadding,
        dividerNode,
        handleRowLayout,
        measuresRowWidth,
        renderRowContent,
        style,
    ]);
    const splitRightElementOutsidePressable = Boolean(
        isInteractive
        && sharedItemBehavior.accessoryPlacement === 'outside'
        && rightAccessory,
    );

    const resolveInteractiveRowStyle = React.useCallback((pressed: boolean) => {
        const backgroundColor = (() => {
            if (pressed && isIOS && !isWeb) return theme.colors.surface.pressedOverlay;
            if (pressed && splitRightElementOutsidePressable) return theme.colors.surface.pressed;
            if (showSelectedBackground) return theme.colors.surface.selected;
            // Web-only hover affordance for interactive rows (no hover when disabled).
            if (isWeb && isHovered && !disabled && !loading) return hoverBackgroundColor;
            return 'transparent';
        })();

        const roundedCornersStyle = getItemGroupRowCornerRadii({
            hasBackground: backgroundColor !== 'transparent',
            position: rowPosition,
            radius: groupCornerRadius,
        });

        return [
            { backgroundColor, opacity: disabled ? 0.5 : 1 },
            isWeb && (disabled || loading) ? ({ cursor: 'not-allowed' } as any) : null,
            roundedCornersStyle,
            pressableStyle,
        ];
    }, [
        disabled,
        groupCornerRadius,
        hoverBackgroundColor,
        isHovered,
        isIOS,
        isWeb,
        loading,
        pressableStyle,
        rowPosition,
        showSelectedBackground,
        splitRightElementOutsidePressable,
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

    if (splitRightElementOutsidePressable) {
        return (
            <>
                <View style={[containerCore, style, resolveInteractiveRowStyle(isSplitPrimaryPressed)]} onLayout={measuresRowWidth ? handleRowLayout : undefined}>
                    <Pressable
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
                        style={[styles.splitPressable, stackAccessory ? styles.splitPressableStacked : null]}
                        android_ripple={(isAndroid || isWeb) ? {
                            color: theme.colors.surface.ripple,
                            borderless: false,
                            foreground: true
                        } : undefined}
                    >
                        <View style={[styles.splitPressableInner, containerPadding, stackAccessory ? styles.splitPressableInnerStacked : null]}>
                            {renderRowContent({ includeRightAccessory: false })}
                        </View>
                    </Pressable>
                    <View
                        style={[
                            styles.rightSection,
                            // A stacked page operation begins at its label's leading edge, after
                            // the shared mark column, and above the row's bottom padding.
                            stackAccessory ? [styles.rightSectionStacked, containerPadding, styles.splitRightSectionStacked] : null,
                            // Auto-fit identity marks have no fixed width here; retain their anatomy.
                            stackAccessory && isPageRow && leadingMarkFitStyle === null && (leftAccessory || reservesLeadingColumn) ? {
                                marginLeft: (iconBoxSize ?? PAGE_LIST_METRICS.rowLeadingColumnPx) + PAGE_LIST_METRICS.rowLeadingGapPx,
                            } : null,
                        ]}
                        pointerEvents={sharedItemBehavior.secondaryActionsEnabled ? 'auto' : 'none'}
                        accessibilityElementsHidden={!sharedItemBehavior.secondaryActionsEnabled}
                        importantForAccessibility={sharedItemBehavior.secondaryActionsEnabled ? 'auto' : 'no-hide-descendants'}
                    >
                        {rightAccessory}
                    </View>
                </View>
                {bottom}
                {dividerNode}
            </>
        );
    }

    if (isInteractive) {
        return (
            <Pressable
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
                style={({ pressed }) => resolveInteractiveRowStyle(pressed)}
                android_ripple={(isAndroid || isWeb) ? {
                    color: theme.colors.surface.ripple,
                    borderless: false,
                    foreground: true
                } : undefined}
            >
                {content}
            </Pressable>
        );
    }

    return (
        <View
            testID={testID}
            {...{ dataSet }}
            {...webTestIdProps}
            {...webOptionIdentityProps}
            {...(isWeb && !disabled && !loading ? { onContextMenu, onKeyDown, onFocus, onBlur } : {})}
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
                    { backgroundColor: theme.colors.surface.selected, opacity: disabled ? 0.5 : 1 },
                    getItemGroupRowCornerRadii({ hasBackground: true, position: rowPosition, radius: groupCornerRadius }),
                    pressableStyle,
                ]
                : [{ opacity: disabled ? 0.5 : 1 }, pressableStyle]}
        >
            {content}
        </View>
    );
});
