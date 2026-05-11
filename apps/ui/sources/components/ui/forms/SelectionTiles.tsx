import React from 'react';
import { View, Pressable, Platform, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import {
    ITEM_CHEVRON_SIZE,
    ITEM_ICON_BOX_SIZE,
    ITEM_ICON_MARGIN_RIGHT,
    ITEM_SUBTITLE_TEXT_METRICS,
    ITEM_TITLE_TEXT_METRICS,
} from '@/components/ui/lists/itemDensityMetrics';

export interface SelectionTile<T extends string> {
    id: T;
    title: string;
    subtitle?: string;
    icon?: React.ComponentProps<typeof Ionicons>['name'];
    disabled?: boolean;
    badge?: string;
}

export type SelectionTileFooterRenderer<T extends string> = (params: Readonly<{
    option: SelectionTile<T>;
    selected: boolean;
    disabled: boolean;
}>) => React.ReactNode;

type SelectionTilesBaseProps<T extends string> = {
    options: Array<SelectionTile<T>>;
    testIdPrefix?: string;
    density?: 'regular' | 'compact';
    minimumColumns?: number;
    renderOptionFooter?: SelectionTileFooterRenderer<T>;
};

type SingleSelectionTilesProps<T extends string> = SelectionTilesBaseProps<T> & {
    selectionMode?: 'single';
    value: T | null;
    onChange: (next: T | null) => void;
};

type MultipleSelectionTilesProps<T extends string> = SelectionTilesBaseProps<T> & {
    selectionMode: 'multiple';
    value: readonly T[];
    onChange: (next: T[]) => void;
};

export type SelectionTilesProps<T extends string> =
    | SingleSelectionTilesProps<T>
    | MultipleSelectionTilesProps<T>;

function isSelected<T extends string>(props: SelectionTilesProps<T>, id: T): boolean {
    if (props.selectionMode === 'multiple') {
        return props.value.includes(id);
    }
    return props.value === id;
}

function handleToggle<T extends string>(props: SelectionTilesProps<T>, id: T) {
    if (props.selectionMode === 'multiple') {
        const next = props.value.includes(id)
            ? props.value.filter((value) => value !== id)
            : [...props.value, id];
        props.onChange(next);
        return;
    }

    props.onChange(id);
}

export function SelectionTiles<T extends string>(props: SelectionTilesProps<T>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [width, setWidth] = React.useState<number>(0);
    const { width: windowWidth } = useWindowDimensions();
    const webViewportWidth =
        Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.innerWidth === 'number'
            ? window.innerWidth
            : null;
    const fallbackViewportWidth = webViewportWidth ?? windowWidth;
    const selectionAccessibilityRole = props.selectionMode === 'multiple' ? 'checkbox' : 'radio';
    const gap = 10;
    const density = props.density ?? 'regular';
    const compact = density === 'compact';
    const minimumColumns = React.useMemo(
        () => Math.max(1, Math.min(props.minimumColumns ?? 1, Math.max(1, props.options.length))),
        [props.minimumColumns, props.options.length],
    );

    const columns = React.useMemo(() => {
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

    const tileWidth = React.useMemo(() => {
        if (width <= 0) return undefined;
        const totalGap = gap * (columns - 1);
        return Math.floor((width - totalGap) / columns);
    }, [columns, width]);
    const fallbackTileWidthStyle = React.useMemo(() => {
        if (width > 0) return null;
        if (columns <= 1) return { width: '100%' } as const;
        if (columns === 2) return { width: '48%', maxWidth: '48%', flexGrow: 0, flexShrink: 0 } as const;
        return { width: '31%', maxWidth: '31%', flexGrow: 0, flexShrink: 0 } as const;
    }, [columns, width]);

    return (
        <View
            onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
            style={[
                styles.grid,
                { flexDirection: 'row', flexWrap: 'wrap', gap },
            ]}
        >
            {props.options.map((option) => {
                const selected = isSelected(props, option.id);
                const disabled = option.disabled === true;
                const iconName = option.icon ?? (selected ? 'checkmark-circle' : 'ellipse-outline');
                const borderColor = selected
                    ? theme.colors.button.primary.background
                    : theme.colors.border.default;
                const iconColor = selected
                    ? theme.colors.button.primary.background
                    : theme.colors.text.secondary;
                const hasSubtitle = typeof option.subtitle === 'string' && option.subtitle.trim().length > 0;
                const footer = props.renderOptionFooter?.({ option, selected, disabled });

                return (
                    <View
                        key={option.id}
                        style={[
                            styles.tile,
                            tileWidth ? { width: tileWidth } : fallbackTileWidthStyle,
                            { borderColor },
                        ]}
                    >
                        <Pressable
                            testID={props.testIdPrefix ? `${props.testIdPrefix}:${option.id}` : undefined}
                            accessibilityRole={selectionAccessibilityRole}
                            accessibilityState={props.selectionMode === 'multiple'
                                ? { checked: selected, disabled }
                                : { selected, disabled }}
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
                                tileWidth ? { width: tileWidth } : fallbackTileWidthStyle,
                                { opacity: disabled ? 0.5 : (pressed ? 0.85 : 1) },
                            ]}
                        >
                            <View style={[styles.headerRow, compact && !hasSubtitle ? styles.headerRowCentered : null]}>
                                <View style={[styles.titleRow, compact && !hasSubtitle ? styles.titleRowCentered : null]}>
                                    <View style={[styles.iconSlot, compact ? styles.iconSlotCompact : null]}>
                                        <Ionicons
                                            name={iconName}
                                            size={compact ? 16 : 29}
                                            color={iconColor}
                                        />
                                    </View>
                                    <View style={[styles.textContainer, compact && !hasSubtitle ? styles.textContainerCentered : null]}>
                                        <Text style={[styles.title, compact ? styles.titleCompact : null]} numberOfLines={2}>{option.title}</Text>
                                        {option.subtitle ? (
                                            <Text style={[styles.subtitle, compact ? styles.subtitleCompact : null]} numberOfLines={4}>{option.subtitle}</Text>
                                        ) : null}
                                    </View>
                                </View>
                                {option.badge ? (
                                    <View style={styles.badge}>
                                        <Text style={styles.badgeText} numberOfLines={1}>{option.badge}</Text>
                                    </View>
                                ) : null}
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

const stylesheet = StyleSheet.create((theme) => ({
    grid: {
        width: '100%',
        alignSelf: 'stretch',
    },
    tile: {
        backgroundColor: theme.colors.surface.base,
        borderRadius: 12,
        borderWidth: 2,
        overflow: 'hidden',
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
    tileCompactWithoutSubtitle: {
        minHeight: 44,
        paddingTop: 8,
        paddingBottom: 8,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
    },
    headerRowCentered: {
        alignItems: 'center',
    },
    footer: {
        marginTop: 10,
        gap: 8,
    },
    footerCompact: {
        marginTop: 8,
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
        width: ITEM_ICON_BOX_SIZE.comfortable,
        height: ITEM_ICON_BOX_SIZE.comfortable,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 1,
    },
    iconSlotCompact: {
        width: ITEM_ICON_BOX_SIZE.compact,
        height: ITEM_ICON_BOX_SIZE.compact,
        marginTop: 0,
    },
    textContainer: {
        flex: 1,
        gap: 0,
    },
    textContainerCentered: {
        justifyContent: 'center',
    },
    title: {
        ...Typography.default('regular'),
        fontSize: ITEM_TITLE_TEXT_METRICS.comfortable.fontSize,
        color: theme.colors.text.primary,
    },
    titleCompact: {
        fontSize: ITEM_TITLE_TEXT_METRICS.compact.fontSize,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: ITEM_SUBTITLE_TEXT_METRICS.comfortable.fontSize,
        color: theme.colors.text.secondary,
    },
    subtitleCompact: {
        fontSize: ITEM_SUBTITLE_TEXT_METRICS.compact.fontSize,
        marginTop: 2,
    },
    badge: {
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
    badgeText: {
        ...Typography.default('regular'),
        fontSize: Platform.select({ ios: 12, default: 12 }),
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
}));
