import * as React from 'react';
import { View, Pressable, StyleProp, ViewStyle, TextStyle, Platform, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ItemGroupSelectionContext } from '@/components/ui/lists/ItemGroup';
import { useItemGroupRowPosition } from '@/components/ui/lists/ItemGroupRowPosition';
import { getItemGroupRowCornerRadii } from '@/components/ui/lists/itemGroupRowCorners';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import {
    ITEM_CHEVRON_SIZE,
    ITEM_ICON_BOX_SIZE,
    ITEM_ICON_MARGIN_RIGHT,
    ITEM_SUBTITLE_TEXT_METRICS,
    ITEM_TITLE_TEXT_METRICS,
} from '@/components/ui/lists/itemDensityMetrics';

function resizeItemIconForDensity(icon: React.ReactNode, iconSize: number): React.ReactNode {
    if (!React.isValidElement(icon) || icon.type === React.Fragment) {
        return icon;
    }

    return React.cloneElement(icon, {
        size: iconSize,
    } as Record<string, unknown>);
}

export interface ItemProps {
    testID?: string;
    title: string;
    subtitle?: React.ReactNode;
    subtitleAccessory?: React.ReactNode;
    subtitleLines?: number; // set 0 or undefined for auto/multiline
    detail?: string;
    icon?: React.ReactNode;
    leftElement?: React.ReactNode;
    rightElement?: React.ReactNode;
    onPress?: () => void;
    onDoublePress?: () => void;
    onLongPress?: () => void;
    onMouseDownCapture?: (event: unknown) => void;
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
    detailStyle?: StyleProp<TextStyle>;
    showChevron?: boolean;
    showDivider?: boolean;
    dividerInset?: number;
    pressableStyle?: StyleProp<ViewStyle>;
    copy?: boolean | string;
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        minHeight: Platform.select({ ios: 44, default: 56 }),
    },
    containerCompact: {
        paddingHorizontal: 12,
        // Compact rows are used heavily in right rails (files/SCM) and should feel editor-like on web/tablet.
        // Keep iOS slightly taller for touch affordance, but reduce desktop web density.
        minHeight: Platform.select({ ios: 38, default: 34 }),
    },
    containerCozy: {
        paddingHorizontal: 14,
        minHeight: Platform.select({ ios: 42, default: 44 }),
    },
    containerTight: {
        paddingHorizontal: 10,
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
        ...Typography.default('regular'),
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
        color: theme.colors.text,
    },
    titleSelected: {
        color: theme.colors.text,
    },
    titleDestructive: {
        color: theme.colors.textDestructive,
    },
    subtitle: {
        ...Typography.default('regular'),
        color: theme.colors.textSecondary,
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
        color: theme.colors.textSecondary,
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
        backgroundColor: theme.colors.divider,
    },
    pressablePressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
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
    const hoverBackgroundColor = isWeb
        ? (theme.dark ? theme.colors.surfaceHighest : theme.colors.surfaceHigh)
        : theme.colors.surfacePressedOverlay;
    
    // Timer ref for long press copy functionality
    const longPressTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    
    const {
        testID,
        title,
        subtitle,
        subtitleAccessory,
        subtitleLines,
        detail,
        icon,
        leftElement,
        rightElement,
        onPress,
        onDoublePress,
        onLongPress,
        onMouseDownCapture,
        disabled,
        loading,
        selected,
        destructive,
        density,
        mode,
        style,
        titleStyle,
        subtitleStyle,
        detailStyle,
        showChevron = true,
        showDivider = true,
        dividerInset = isIOS ? 15 : 16,
        pressableStyle,
        copy
    } = props;
    const webTestIdProps = isWeb && testID
        ? ({ 'data-testid': testID } as const)
        : undefined;

    // Handle copy functionality
    const handleCopy = React.useCallback(async () => {
        if (!copy || isWeb) return;
        
        let textToCopy: string;
        const subtitleText = typeof subtitle === 'string' ? subtitle : null;
        
        if (typeof copy === 'string') {
            // If copy is a string, use it directly
            textToCopy = copy;
        } else {
            // If copy is true, try to figure out what to copy
            // Priority: detail > subtitle > title
            textToCopy = detail || subtitleText || title;
        }
        
        try {
            await Clipboard.setStringAsync(textToCopy);
            Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: title }));
        } catch (error) {
            console.error('Failed to copy:', error);
        }
    }, [copy, isWeb, title, subtitle, detail]);
    
    // Handle long press for copy functionality
    const handlePressIn = React.useCallback(() => {
        if (copy && !isWeb && !onPress) {
            longPressTimer.current = setTimeout(() => {
                handleCopy();
            }, 500); // 500ms delay for long press
        }
    }, [copy, isWeb, onPress, handleCopy]);
    
    const handlePressOut = React.useCallback(() => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    }, []);
    
    // Clean up timer on unmount
    React.useEffect(() => {
        return () => {
            if (longPressTimer.current) {
                clearTimeout(longPressTimer.current);
            }
        };
    }, []);
    
    const webDoublePressHandledAtMsRef = React.useRef<number>(0);
    const webLastPressAtMsRef = React.useRef<number | null>(null);

    const handlePress = React.useCallback((event?: any) => {
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
        onPress?.();
    }, [isWeb, onDoublePress, onPress]);

    const isInfoMode = mode === 'info';
    const hasPrimaryPressAction = Boolean(onPress || onDoublePress || onLongPress);
    const hasCopyLongPress = Boolean(copy && !isWeb && !onPress);
    const isInteractive = !isInfoMode && (hasPrimaryPressAction || hasCopyLongPress);

    // Only show the navigation chevron when the row has an actual "tap to do something" affordance.
    // Long-press copy rows (mobile) and long-press-only rows should not look like navigation.
    const showAccessory = Boolean(!isInfoMode && showChevron && !rightElement && (onPress || onDoublePress));
    const showSelectedBackground = !!selected && ((selectionContext?.selectableItemCount ?? 2) > 1);
    const groupCornerRadius = Platform.select({ ios: 10, default: 16 });

    const resolvedDensity = useResolvedItemDensity(density);
    const titleColor = destructive ? styles.titleDestructive : (selected ? styles.titleSelected : styles.titleNormal);
    const isCozy = resolvedDensity === 'cozy';
    const isCompact = resolvedDensity === 'compact';
    const isTight = resolvedDensity === 'tight';
    const hasSubtitleContent = Boolean(subtitle || subtitleAccessory);
    const containerPadding = hasSubtitleContent
        ? (isTight ? styles.containerWithSubtitleTight : isCompact ? styles.containerWithSubtitleCompact : isCozy ? styles.containerWithSubtitleCozy : styles.containerWithSubtitle)
        : (isTight ? styles.containerWithoutSubtitleTight : isCompact ? styles.containerWithoutSubtitleCompact : isCozy ? styles.containerWithoutSubtitleCozy : styles.containerWithoutSubtitle);
    const containerCore = isTight
        ? [styles.container, styles.containerTight]
        : isCompact
            ? [styles.container, styles.containerCompact]
            : isCozy
                ? [styles.container, styles.containerCozy]
            : styles.container;
    const iconContainerStyle = isTight
        ? [styles.iconContainer, styles.iconContainerTight]
        : isCompact
            ? [styles.iconContainer, styles.iconContainerCompact]
            : isCozy
                ? [styles.iconContainer, styles.iconContainerCozy]
            : styles.iconContainer;
    const resolvedIconDensity = isTight ? 'tight' : isCompact ? 'compact' : isCozy ? 'cozy' : 'comfortable';
    const chevronSize = ITEM_CHEVRON_SIZE[resolvedIconDensity];
    const resolvedIconBoxSize = ITEM_ICON_BOX_SIZE[resolvedIconDensity];
    const resolvedIconMarginRight = ITEM_ICON_MARGIN_RIGHT[resolvedIconDensity];
    const sizedIcon = React.useMemo(() => resizeItemIconForDensity(icon, resolvedIconBoxSize), [icon, resolvedIconBoxSize]);
    const titleSizeStyle = isTight ? styles.titleTight : isCompact ? styles.titleCompact : isCozy ? styles.titleCozy : null;
    const subtitleSizeStyle = isTight ? styles.subtitleTight : isCompact ? styles.subtitleCompact : isCozy ? styles.subtitleCozy : null;
    const detailSizeStyle = isTight ? styles.detailTight : isCompact ? styles.detailCompact : isCozy ? styles.detailCozy : null;
    const leftAccessory = React.useMemo(() => {
        const candidate = leftElement ?? sizedIcon ?? null;
        return normalizeNodeForView(candidate);
    }, [leftElement, sizedIcon]);
    const rightAccessory = React.useMemo(() => normalizeNodeForView(rightElement ?? null), [rightElement]);
    const subtitleAccessoryNode = React.useMemo(() => normalizeNodeForView(subtitleAccessory ?? null), [subtitleAccessory]);
    const chevronAccessory = React.useMemo(() => {
        if (!showAccessory) return null;
        return normalizeNodeForView(
            <Ionicons
                name="chevron-forward"
                size={chevronSize}
                color={theme.colors.groupped.chevron}
                style={{ marginLeft: 4 }}
            />,
        );
    }, [chevronSize, showAccessory, theme.colors.groupped.chevron]);

    const isSelectableRow = React.useMemo(() => {
        // Only show hover for "selection lists" (where rows participate in a selected-state group).
        // This avoids making all navigation rows hoverable.
        // NOTE: we intentionally do NOT gate on `selectableItemCount > 1` because single-item
        // selection lists should still have hover affordances.
        return typeof selected === 'boolean' && Boolean(selectionContext);
    }, [selected, selectionContext]);

    const [isHovered, setIsHovered] = React.useState(false);
    React.useEffect(() => {
        // Keep hover state coherent with disabled/loading changes.
        if (disabled || loading) setIsHovered(false);
    }, [disabled, loading]);
    
    const content = (
        <>
            <View style={[containerCore, containerPadding, style]}>
                {/* Left Section */}
                {leftAccessory ? (
                    <View style={iconContainerStyle}>
                        {leftAccessory}
                    </View>
                ) : null}

                {/* Center Section */}
                <View style={styles.centerContent}>
                    <Text 
                        style={[styles.title, titleSizeStyle, titleColor, titleStyle]}
                        numberOfLines={subtitle ? 1 : 2}
                    >
                        {title}
                    </Text>
                    {subtitle && (() => {
                        // If subtitle is a ReactNode (not string), render as-is.
                        // This enables richer subtitle layouts (e.g. inline glyphs).
                        if (typeof subtitle !== 'string') {
                            const wrapPrimitive = (value: string | number) => {
                                const asText = String(value);
                                const effectiveLines = subtitleLines !== undefined
                                    ? (subtitleLines <= 0 ? undefined : subtitleLines)
                                    : (asText.indexOf('\n') !== -1 ? undefined : 1);

                                return (
                                    <Text
                                        style={[styles.subtitle, subtitleSizeStyle, subtitleStyle]}
                                        numberOfLines={effectiveLines}
                                    >
                                        {asText}
                                    </Text>
                                );
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

                        return (
                            <Text
                                style={[styles.subtitle, subtitleSizeStyle, subtitleStyle]}
                                numberOfLines={effectiveLines}
                            >
                                {subtitle}
                            </Text>
                        );
                    })()}
                    {subtitleAccessoryNode ? (
                        <View style={{ marginTop: 0 }}>
                            {subtitleAccessoryNode}
                        </View>
                    ) : null}
                </View>

                {/* Right Section */}
                <View style={styles.rightSection}>
                    {detail && (
                        <Text 
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
                    )}
                    {loading && (
                        <ActivityIndicator 
                            size="small" 
                            color={theme.colors.textSecondary}
                            style={{ marginRight: showAccessory ? 6 : 0 }}
                        />
                    )}
                    {rightAccessory}
                    {chevronAccessory}
                </View>
            </View>

            {/* Divider */}
            {showDivider && (
                <View 
                    style={[
                        styles.divider,
                        { 
                            marginLeft: (isAndroid || isWeb)
                                ? 0
                                : (dividerInset + (icon || leftElement ? (16 + resolvedIconBoxSize + resolvedIconMarginRight) : 16))
                        }
                    ]}
                />
            )}
        </>
    );

    if (isInteractive) {
        return (
            <Pressable
                testID={testID}
                {...webTestIdProps}
                onPress={handlePress}
                onLongPress={onLongPress}
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
                onHoverIn={isWeb && isSelectableRow && !disabled && !loading ? () => setIsHovered(true) : undefined}
                onHoverOut={isWeb ? () => setIsHovered(false) : undefined}
                onMouseDownCapture={isWeb ? (onMouseDownCapture as any) : undefined}
                disabled={disabled || loading}
                style={({ pressed }) => {
                    const backgroundColor = (() => {
                        if (pressed && isIOS && !isWeb) return theme.colors.surfacePressedOverlay;
                        if (showSelectedBackground) return theme.colors.surfaceSelected;
                        // Web-only hover affordance for selectable rows (no hover when disabled).
                        if (isWeb && isSelectableRow && isHovered && !disabled && !loading) return hoverBackgroundColor;
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
                }}
                android_ripple={(isAndroid || isWeb) ? {
                    color: theme.colors.surfaceRipple,
                    borderless: false,
                    foreground: true
                } : undefined}
            >
                {content}
            </Pressable>
        );
    }

    return (
        <View testID={testID} {...webTestIdProps} style={[{ opacity: disabled ? 0.5 : 1 }, pressableStyle]}>
            {content}
        </View>
    );
});
