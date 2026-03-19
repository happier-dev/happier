import React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export interface SelectionTile<T extends string> {
    id: T;
    title: string;
    subtitle?: string;
    icon?: React.ComponentProps<typeof Ionicons>['name'];
    disabled?: boolean;
    badge?: string;
}

type SelectionTilesBaseProps<T extends string> = {
    options: Array<SelectionTile<T>>;
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
    const selectionAccessibilityRole = props.selectionMode === 'multiple' ? 'checkbox' : 'radio';

    const columns = React.useMemo(() => {
        if (props.options.length === 3) {
            return width >= 560 ? 3 : 1;
        }
        if (width >= 640) return Math.min(3, props.options.length);
        if (width >= 420) return Math.min(2, props.options.length);
        return 1;
    }, [props.options.length, width]);

    const gap = 10;
    const tileWidth = React.useMemo(() => {
        if (width <= 0) return undefined;
        const totalGap = gap * (columns - 1);
        return Math.floor((width - totalGap) / columns);
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
                    : theme.colors.divider;
                const iconColor = selected
                    ? theme.colors.button.primary.background
                    : theme.colors.textSecondary;

                return (
                    <Pressable
                        key={option.id}
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
                            styles.tile,
                            tileWidth ? { width: tileWidth } : null,
                            {
                                borderColor,
                                opacity: disabled ? 0.5 : (pressed ? 0.85 : 1),
                            },
                        ]}
                    >
                        <View style={styles.headerRow}>
                            <View style={styles.titleRow}>
                                <View style={styles.iconSlot}>
                                    <Ionicons name={iconName} size={29} color={iconColor} />
                                </View>
                                <View style={styles.textContainer}>
                                    <Text style={styles.title} numberOfLines={2}>{option.title}</Text>
                                    {option.subtitle ? (
                                        <Text style={styles.subtitle} numberOfLines={4}>{option.subtitle}</Text>
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
                );
            })}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    grid: {},
    tile: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        borderWidth: 2,
        paddingHorizontal: 12,
        paddingVertical: 14,
        minHeight: 92,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        flex: 1,
        gap: 14,
    },
    iconSlot: {
        width: 29,
        height: 29,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 1,
    },
    textContainer: {
        flex: 1,
        gap: 2,
    },
    title: {
        ...Typography.default('regular'),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.text,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: Platform.select({ ios: 14, default: 14 }),
        lineHeight: 20,
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
        color: theme.colors.textSecondary,
    },
    badge: {
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
    badgeText: {
        ...Typography.default('regular'),
        fontSize: Platform.select({ ios: 12, default: 12 }),
        lineHeight: 16,
        color: theme.colors.textSecondary,
    },
}));
