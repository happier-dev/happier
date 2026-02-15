import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { SelectableRow } from './SelectableRow';

export type ActionListItem = Readonly<{
    id: string;
    label: string;
    subtitle?: string;
    icon?: React.ReactNode;
    right?: React.ReactNode;
    selected?: boolean;
    onPress?: () => void;
    disabled?: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    section: {
        paddingTop: 12,
        paddingBottom: 8
    },
    title: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingBottom: 4,
        ...Typography.default('semiBold'),
        textTransform: 'uppercase',
    },
    label: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default(),
    },
}));

export function ActionListSection(props: {
    title?: string;
    actions: ReadonlyArray<ActionListItem | null | undefined>;
}) {
    const styles = stylesheet;
    useUnistyles();

    const actions = React.useMemo(() => {
        return (props.actions ?? []).filter(Boolean) as ActionListItem[];
    }, [props.actions]);

    if (actions.length === 0) return null;

    const renderActionIcon = React.useCallback((icon: React.ReactNode) => {
        // On web, raw strings/numbers cannot be direct children of <View>.
        // Wrap primitives in <Text> to avoid "Unexpected text node" runtime errors.
        if (typeof icon === 'string' || typeof icon === 'number') {
            return <Text>{icon}</Text>;
        }
        return icon;
    }, []);

    return (
        <View style={styles.section}>
            {props.title ? (
                <Text style={styles.title}>
                    {props.title}
                </Text>
            ) : null}

            {actions.map((action) => (
                <SelectableRow
                    key={action.id}
                    disabled={action.disabled}
                    onPress={action.onPress}
                    left={action.icon ? <View>{renderActionIcon(action.icon)}</View> : null}
                    right={action.right ?? null}
                    title={action.label}
                    subtitle={action.subtitle}
                    titleStyle={styles.label}
                    selected={action.selected}
                    variant="slim"
                />
            ))}
        </View>
    );
}
