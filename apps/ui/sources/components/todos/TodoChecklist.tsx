import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type TodoChecklistItemStatus =
    | 'pending'
    | 'active'
    | 'in_progress'
    | 'paused'
    | 'blocked'
    | 'complete'
    | 'completed'
    | 'cancelled'
    | 'unknown';

export type TodoChecklistItem = Readonly<{
    id?: string;
    title: string;
    status: TodoChecklistItemStatus;
    selected?: boolean;
    testID?: string;
}>;

function isCompletedStatus(status: TodoChecklistItemStatus): boolean {
    return status === 'complete' || status === 'completed' || status === 'cancelled';
}

function isActiveStatus(status: TodoChecklistItemStatus): boolean {
    return status === 'active' || status === 'in_progress';
}

export function TodoChecklist(props: Readonly<{
    items: readonly TodoChecklistItem[];
    maxItems?: number;
    numberOfLines?: number;
    surface?: 'inset' | 'plain';
    size?: 'compact' | 'default';
}>) {
    const { theme } = useUnistyles();
    const maxItems = props.maxItems ?? props.items.length;
    const shown = props.items.slice(0, maxItems);
    const more = props.items.length - shown.length;
    const surface = props.surface ?? 'plain';
    const size = props.size ?? 'default';

    if (shown.length === 0) return null;

    return (
        <View style={[
            styles.root,
            surface === 'inset' && {
                backgroundColor: theme.colors.surface.inset,
            },
            surface === 'inset' && styles.insetSurface,
        ]}>
            {shown.map((item, index) => {
                const completed = isCompletedStatus(item.status);
                const active = item.selected === true || isActiveStatus(item.status);
                return (
                    <View
                        key={item.id ?? `todo-${index}`}
                        testID={item.testID}
                        accessibilityState={{ checked: completed, selected: active }}
                        style={styles.item}
                    >
                        <Text
                            numberOfLines={props.numberOfLines ?? 2}
                            style={[
                                styles.itemText,
                                size === 'compact' && styles.compactItemText,
                                { color: theme.colors.text.secondary },
                                completed && {
                                    color: theme.colors.state.success.foreground,
                                    textDecorationLine: 'line-through',
                                },
                                active && {
                                    color: theme.colors.text.primary,
                                    fontWeight: '700',
                                },
                            ]}
                        >
                            {`${completed ? '☑' : '☐'} ${item.title}`}
                        </Text>
                    </View>
                );
            })}
            {more > 0 ? (
                <Text style={[styles.more, { color: theme.colors.text.secondary }]}>
                    {t('tools.structuredResult.more', { count: more })}
                </Text>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    root: {
        gap: 6,
    },
    insetSurface: {
        padding: 12,
        borderRadius: 8,
    },
    item: {
        paddingVertical: 2,
    },
    itemText: {
        fontSize: 14,
    },
    compactItemText: {
        fontSize: 13,
    },
    more: {
        fontSize: 12,
        fontFamily: 'Menlo',
    },
}));
