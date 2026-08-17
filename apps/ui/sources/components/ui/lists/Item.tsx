import * as React from 'react';
import { View, Pressable, StyleProp, ViewStyle, TextStyle, Platform, type AccessibilityRole, type AccessibilityState, type TextProps } from 'react-native';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ItemGroupSelectionContext } from '@/components/ui/lists/ItemGroup';
import { useItemGroupRowPosition } from '@/components/ui/lists/ItemGroupRowPosition';
import { getItemGroupRowCornerRadii } from '@/components/ui/lists/itemGroupRowCorners';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import {
    WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE,
    WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE,
} from '@/components/ui/text/webStartEllipsisTextStyles';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { FocusRing, WEB_FOCUS_OUTLINE_RESET } from '@/components/ui/interaction/FocusRing';
import { useIsKeyboardModality } from '@/components/ui/interaction/inputModalityStore';
import { usePressFeedback } from '@/components/ui/interaction/usePressFeedback';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
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
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { Icon } from '@/components/ui/icons/Icon';
import { ICON_LABEL_OPTICAL_NUDGE_STYLE } from '@/components/ui/icons/iconOpticalAlignment';

function resizeItemIconForDensity(icon: React.ReactNode, iconSize: number): React.ReactNode {
    if (!React.isValidElement(icon) || icon.type === React.Fragment) {
        return icon;
    }

    return React.cloneElement(icon, {
        size: iconSize,
    } as Record<string, unknown>);
}

function resizeAccessoryIconForDensity(accessory: React.ReactNode, iconSize: number): React.ReactNode {
    if (!React.isValidElement(accessory) || accessory.type === React.Fragment) {
        return accessory;
    }

    const props = (accessory.props ?? {}) as Record<string, unknown>;
    const isIconLikeAccessory =
        typeof props.name === 'string'
        && (typeof props.size === 'number' || typeof props.size === 'string')
        && props.children == null;

    if (!isIconLikeAccessory) {
        return accessory;
    }

    return React.cloneElement(accessory, {
        size: iconSize,
    } as Record<string, unknown>);
}

type ItemTextEllipsizeMode = NonNullable<TextProps['ellipsizeMode']>;

export interface ItemProps {
    testID?: string;
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    subtitleTestID?: string;
    subtitleAccessory?: React.ReactNode;
    subtitleLines?: number; // set 0 or undefined for auto/multiline
    detail?: string;
    detailTestID?: string;
    icon?: React.ReactNode;
    leftElement?: React.ReactNode;
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
    onMouseDownCapture?: (event: unknown) => void;
    onContextMenu?: (event: unknown) => void;
    accessibilityRole?: AccessibilityRole;
    webRole?: React.AriaRole;
    /**
     * Optional disclosure/pass-through a11y props forwarded to the inner
     * Pressable. `accessibilityState` (e.g. `{ expanded }`) also drives a
     * web-only `aria-expanded` attribute (see render) since RN-Web does not
     * derive it from `accessibilityState`. All optional and back-compat.
     */
    accessibilityState?: AccessibilityState;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    disabled?: boolean;
    loading?: boolean;
    selected?: boolean;
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
    showDivider?: boolean;
    dividerInset?: number;
    pressableStyle?: StyleProp<ViewStyle>;
    copy?: boolean | string;
}

/**
 * The menu role's row box, applied over whichever density styles the row would otherwise take.
 *
 * Plain objects rather than stylesheet entries because they carry no theme and must win the cascade
 * wherever they are appended; see {@link MENU_ROW_METRICS} for why a menu ignores density at all.
 */
const MENU_ROW_HEIGHT_STYLE = { minHeight: MENU_ROW_METRICS.minHeightPx } as const;
const MENU_ROW_PADDING_STYLE = { paddingVertical: MENU_ROW_METRICS.paddingVerticalPx } as const;

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
        minHeight: Platform.select({ ios: 38, default: 34 }),
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
        justifyContent: 'center',
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
        marginLeft: 8,
    },
    detail: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
        ...ITEM_TITLE_TEXT_METRICS.comfortable,
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
    divider: {
        height: Platform.select({ ios: 0.33, default: 0 }),
        backgroundColor: theme.colors.border.default,
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
    const copyFeedback = useTemporaryCopyFeedback();
    
    const {
        testID,
        title,
        subtitle,
        subtitleTestID,
        subtitleAccessory,
        subtitleLines,
        detail,
        detailTestID,
        icon,
        leftElement,
        iconBoxSize,
    rowRole,
        rightElement,
        onPress,
        onDoublePress,
        onLongPress,
        onMouseDownCapture,
        onContextMenu,
        accessibilityRole,
        webRole,
        accessibilityState,
        accessibilityLabel,
        accessibilityHint,
        disabled,
        loading,
        selected,
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
        showDivider = true,
        dividerInset = isIOS ? 15 : 16,
        pressableStyle,
        copy
    } = props;
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

    // Handle long press for copy functionality
    const handlePressIn = React.useCallback(() => {
        longPressConsumedRef.current = false;
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

    // Only show the navigation chevron when the row has an actual "tap to do something" affordance.
    // Long-press copy rows (mobile) and long-press-only rows should not look like navigation.
    // A `rightElement` normally claims the right slot and hides the chevron, UNLESS the row opts
    // into `keepChevronWithRightElement` (badge + chevron together).
    const showAccessory = Boolean(
        !isInfoMode
        && showChevron
        && (keepChevronWithRightElement || !rightElement)
        && (onPress || onDoublePress),
    );
    const showSelectedBackground = !!selected && ((selectionContext?.selectableItemCount ?? 2) > 1);
    const groupCornerRadius = Platform.select({ ios: 10, default: 16 });

    const resolvedDensity = useResolvedItemDensity(density);
    const titleColor = destructive ? styles.titleDestructive : (selected ? styles.titleSelected : styles.titleNormal);
    const isCozy = resolvedDensity === 'cozy';
    const isCompact = resolvedDensity === 'compact';
    const isTight = resolvedDensity === 'tight';
    const hasSubtitleContent = Boolean(subtitle || subtitleAccessory);
    const isMenuRow = rowRole === 'menu';
    const containerPadding = isMenuRow
        ? MENU_ROW_PADDING_STYLE
        : hasSubtitleContent
            ? (isTight ? styles.containerWithSubtitleTight : isCompact ? styles.containerWithSubtitleCompact : isCozy ? styles.containerWithSubtitleCozy : styles.containerWithSubtitle)
            : (isTight ? styles.containerWithoutSubtitleTight : isCompact ? styles.containerWithoutSubtitleCompact : isCozy ? styles.containerWithoutSubtitleCozy : styles.containerWithoutSubtitle);
    const containerCore = isTight
        ? [styles.container, styles.containerTight, isMenuRow ? MENU_ROW_HEIGHT_STYLE : null]
        : isCompact
            ? [styles.container, styles.containerCompact, isMenuRow ? MENU_ROW_HEIGHT_STYLE : null]
            : isCozy
                ? [styles.container, styles.containerCozy, isMenuRow ? MENU_ROW_HEIGHT_STYLE : null]
            : [styles.container, isMenuRow ? MENU_ROW_HEIGHT_STYLE : null];
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
    const iconContainerStyle = isTight
        ? [styles.iconContainer, styles.iconContainerTight, menuIconBoxStyle, iconBoxSizeOverride]
        : isCompact
            ? [styles.iconContainer, styles.iconContainerCompact, menuIconBoxStyle, iconBoxSizeOverride]
            : isCozy
                ? [styles.iconContainer, styles.iconContainerCozy, menuIconBoxStyle, iconBoxSizeOverride]
            : [styles.iconContainer, menuIconBoxStyle, iconBoxSizeOverride];

    const resolvedIconMarginRight = isMenuRow
        ? MENU_ROW_METRICS.iconMarginRightPx
        : ITEM_ICON_MARGIN_RIGHT[resolvedIconDensity];
    const sizedIcon = React.useMemo(() => resizeItemIconForDensity(icon, resolvedIconGlyphSize), [icon, resolvedIconGlyphSize]);
    const titleSizeStyle = isTight ? styles.titleTight : isCompact ? styles.titleCompact : isCozy ? styles.titleCozy : null;
    const subtitleSizeStyle = isTight ? styles.subtitleTight : isCompact ? styles.subtitleCompact : isCozy ? styles.subtitleCozy : null;
    const detailSizeStyle = isTight ? styles.detailTight : isCompact ? styles.detailCompact : isCozy ? styles.detailCozy : null;
    const resizedLeftElement = React.useMemo(
        () => resizeAccessoryIconForDensity(leftElement ?? null, resolvedIconGlyphSize),
        [leftElement, resolvedIconGlyphSize],
    );
    const leftAccessory = React.useMemo(() => {
        const candidate = resizedLeftElement ?? sizedIcon ?? null;
        return normalizeNodeForView(candidate);
    }, [resizedLeftElement, sizedIcon]);
    const rightAccessory = React.useMemo(() => normalizeNodeForView(rightElement ?? null), [rightElement]);
    const subtitleAccessoryNode = React.useMemo(() => normalizeNodeForView(subtitleAccessory ?? null), [subtitleAccessory]);
    const chevronAccessory = React.useMemo(() => {
        if (!showAccessory) return null;
        return normalizeNodeForView(
            <Icon
                name="caret-right"
                size={chevronSize}
                color={theme.colors.text.secondary}
                style={{ marginLeft: 4 }}
            />,
        );
    }, [chevronSize, showAccessory, theme.colors.text.secondary]);

    // `loading` already renders a spinner and blocks the press; without `busy`
    // that progress is a sighted-only signal, so it is merged here at the row
    // owner rather than by each caller. An idle row publishes nothing.
    const resolvedAccessibilityState = React.useMemo<AccessibilityState | undefined>(() => {
        if (!loading) return accessibilityState;
        return { ...(accessibilityState ?? {}), busy: true };
    }, [accessibilityState, loading]);

    const [isHovered, setIsHovered] = React.useState(false);
    React.useEffect(() => {
        // Keep hover state coherent with disabled/loading changes.
        if (disabled || loading) setIsHovered(false);
    }, [disabled, loading]);

    // Press/hover/selection fills come from the shared mechanism so a row and a control cannot
    // drift apart, and so nothing here can reach for `opacity` to signal a press.
    const pressFeedback = usePressFeedback({
        tone: 'row',
        disabled: disabled || loading,
        selected: showSelectedBackground,
    });

    // React Native has no `:focus-visible`, so the ring is gated on keyboard modality — otherwise
    // it would flash on every tap.
    const [isFocused, setIsFocused] = React.useState(false);
    const isKeyboardModality = useIsKeyboardModality();
    const handleFocus = React.useCallback(() => setIsFocused(true), []);
    const handleBlur = React.useCallback(() => setIsFocused(false), []);
    const focusRingCornerRadii = React.useMemo(() => getItemGroupRowCornerRadii({
        hasBackground: true,
        position: rowPosition,
        radius: groupCornerRadius,
    }), [groupCornerRadius, rowPosition]);
    // `Item` is imported by 165 modules, and `FocusRing` runs a Reanimated animated style — an
    // always-mounted one would cost a shared value per row app-wide for a ring native can never
    // show (RN surfaces no keypress, so the modality never leaves `pointer` there). `isFocused`
    // keeps it mounted while it fades out after the user drops back to the pointer.
    const isFocusRingMounted = isKeyboardModality || isFocused;

    const dividerNode = showDivider ? (
        <View
            style={[
                styles.divider,
                {
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

    const renderRowContent = React.useCallback(() => (
        <>
            {/* Left Section */}
            {leftAccessory ? (
                <View style={iconContainerStyle}>
                    {leftAccessory}
                </View>
            ) : null}

            {/* Center Section */}
            <View style={styles.centerContent}>
                {typeof title === 'string' || typeof title === 'number' ? (
                    renderPrimitiveText({
                        value: title,
                        style: [styles.title, titleSizeStyle, titleColor, titleStyle],
                        numberOfLines: subtitle ? 1 : 2,
                        ellipsizeMode: titleEllipsizeMode,
                    })
                ) : (
                    normalizeNodeForView(title)
                )}
                {subtitle && (() => {
                    // If subtitle is a ReactNode (not string), render as-is.
                    // This enables richer subtitle layouts (e.g. inline glyphs).
                    if (typeof subtitle !== 'string') {
                        const wrapPrimitive = (value: string | number) => {
                            const asText = String(value);
                            const effectiveLines = subtitleLines !== undefined
                                ? (subtitleLines <= 0 ? undefined : subtitleLines)
                                : (asText.indexOf('\n') !== -1 ? undefined : 1);

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

                    // Allow multiline when requested or when content contains line breaks
                    const effectiveLines = subtitleLines !== undefined
                        ? (subtitleLines <= 0 ? undefined : subtitleLines)
                        : (subtitle.indexOf('\n') !== -1 ? undefined : 1);

                    return renderPrimitiveText({
                        value: subtitle,
                        testID: subtitleTestID,
                        style: [styles.subtitle, subtitleSizeStyle, subtitleStyle],
                        numberOfLines: effectiveLines,
                        ellipsizeMode: subtitleEllipsizeMode,
                    });
                })()}
                {subtitleAccessoryNode ? (
                    <View style={{ marginTop: 0 }}>
                        {subtitleAccessoryNode}
                    </View>
                ) : null}
            </View>

            {/* Right Section */}
            <View style={styles.rightSection}>
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
                        size="small"
                        color={theme.colors.text.secondary}
                        style={{ marginRight: showAccessory ? 6 : 0 }}
                    />
                )}
                {rightAccessory}
                {chevronAccessory}
            </View>
        </>
    ), [
        chevronAccessory,
        copyFeedback,
        detail,
        detailSizeStyle,
        detailStyle,
        iconContainerStyle,
        leftAccessory,
        loading,
        renderPrimitiveText,
        rightAccessory,
        showAccessory,
        subtitle,
        subtitleAccessoryNode,
        subtitleEllipsizeMode,
        subtitleLines,
        subtitleSizeStyle,
        styles.centerContent,
        styles.detail,
        styles.rightSection,
        styles.subtitle,
        style,
        title,
        titleColor,
        titleEllipsizeMode,
        titleSizeStyle,
        titleStyle,
        theme.colors.text.secondary,
    ]);

    const content = React.useMemo(() => (
        <>
            <View style={[containerCore, containerPadding, style]}>
                {renderRowContent()}
            </View>

            {dividerNode}
        </>
    ), [
        containerCore,
        containerPadding,
        dividerNode,
        renderRowContent,
        style,
    ]);

    const resolveInteractiveRowStyle = React.useCallback((pressed: boolean) => {
        // `isHovered` is only ever set on web (the hover handlers are wired there only).
        const backgroundColor = pressFeedback.resolveBackgroundColor({ pressed, hovered: isHovered })
            ?? 'transparent';

        const roundedCornersStyle = getItemGroupRowCornerRadii({
            hasBackground: backgroundColor !== 'transparent',
            position: rowPosition,
            radius: groupCornerRadius,
        });

        return [
            // `opacity` here is the DISABLED treatment only. Press never lowers it — a pressed row
            // keeps its content at full strength and moves the fill behind it instead.
            { backgroundColor, opacity: disabled ? 0.5 : 1 },
            isWeb && (disabled || loading) ? ({ cursor: 'not-allowed' } as any) : null,
            // The platform's own focus outline is replaced by `FocusRing` below, which is
            // theme-driven, contrast-verified, and only appears for keyboard traversal.
            isWeb ? WEB_FOCUS_OUTLINE_RESET : null,
            roundedCornersStyle,
            pressableStyle,
        ];
    }, [
        disabled,
        groupCornerRadius,
        isHovered,
        isWeb,
        loading,
        pressFeedback,
        pressableStyle,
        rowPosition,
    ]);

    if (isInteractive) {
        return (
            <Pressable
                testID={testID}
                {...webTestIdProps}
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
                onFocus={handleFocus}
                onBlur={handleBlur}
                onHoverIn={isWeb && !disabled && !loading ? () => setIsHovered(true) : undefined}
                onHoverOut={isWeb ? () => setIsHovered(false) : undefined}
                onMouseDownCapture={isWeb ? (onMouseDownCapture as any) : undefined}
                onContextMenu={isWeb ? (onContextMenu as any) : undefined}
                {...(isWeb && webRole ? { role: webRole } : undefined)}
                accessibilityRole={accessibilityRole ?? 'button'}
                accessibilityState={resolvedAccessibilityState}
                accessibilityLabel={accessibilityLabel}
                accessibilityHint={accessibilityHint}
                {...(isWeb && accessibilityState != null && accessibilityState.expanded != null
                    // RN-Web (createDOMProps) derives aria-expanded from an explicit
                    // aria-expanded/accessibilityExpanded prop, NOT from
                    // accessibilityState.expanded — bridge it on web only.
                    ? ({ 'aria-expanded': accessibilityState.expanded } as Record<string, unknown>)
                    : undefined)}
                disabled={disabled || loading}
                style={({ pressed }) => resolveInteractiveRowStyle(pressed)}
                android_ripple={(isAndroid || isWeb) ? {
                    color: theme.colors.surface.ripple,
                    borderless: false,
                    foreground: true
                } : undefined}
            >
                {content}
                {isFocusRingMounted ? (
                    <FocusRing
                        testID={testID === undefined ? undefined : `${testID}-focus-ring`}
                        visible={isFocused && isKeyboardModality && !disabled && !loading}
                        // Inside the row bounds: a grouped list clips, so an outside ring would be
                        // cut off at the group edge exactly where the first and last rows need it
                        // most.
                        placement="inside"
                        cornerRadii={focusRingCornerRadii}
                    />
                ) : null}
            </Pressable>
        );
    }

    return (
        <View
            testID={testID}
            {...webTestIdProps}
            style={[{ opacity: disabled ? 0.5 : 1 }, pressableStyle]}
        >
            {content}
        </View>
    );
});
