import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { formatBadgeCount } from './tabBadgeModel';

const styles = StyleSheet.create((theme) => ({
    countBadge: {
        position: 'absolute',
        top: -3,
        right: -8,
        backgroundColor: theme.colors.status.error,
        borderRadius: 6.5,
        minWidth: 13,
        height: 13,
        paddingHorizontal: 3,
        justifyContent: 'center',
        alignItems: 'center',
    },
    countText: {
        color: theme.colors.button.primary.tint,
        fontSize: 8,
        fontVariant: ['tabular-nums'],
        ...Typography.default('semiBold'),
    },
    dot: {
        position: 'absolute',
        top: 0,
        right: -2,
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.text.primary,
    },
    diffChip: {
        position: 'absolute',
        top: -4,
        right: -11,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        height: 12,
        paddingHorizontal: 3,
        borderRadius: 6,
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    diffAdded: {
        color: theme.colors.versionControl.added.foreground,
        fontSize: 8,
        lineHeight: 11,
        fontVariant: ['tabular-nums'],
        ...Typography.default('semiBold'),
    },
    diffRemoved: {
        color: theme.colors.versionControl.removed.foreground,
        fontSize: 8,
        lineHeight: 11,
        fontVariant: ['tabular-nums'],
        ...Typography.default('semiBold'),
    },
    diffModified: {
        color: theme.colors.text.secondary,
        fontSize: 8,
        lineHeight: 11,
        fontVariant: ['tabular-nums'],
        ...Typography.default('semiBold'),
    },
}));

type TabBadgeProps =
    | Readonly<{ variant: 'dot'; style?: StyleProp<ViewStyle>; testID?: string }>
    | Readonly<{ variant: 'count'; value: number; max?: number; style?: StyleProp<ViewStyle>; testID?: string }>
    | Readonly<{
        variant: 'diff';
        added: number;
        removed: number;
        modifiedCount: number;
        max?: number;
        style?: StyleProp<ViewStyle>;
        testID?: string;
    }>;

/**
 * Unified tab-bar badge. Replaces the per-bar inline badge/indicator markup so
 * counts, dots, and git diff chips share spacing, capping, and theme tokens.
 */
export function TabBadge(props: TabBadgeProps): React.ReactElement {
    if (props.variant === 'dot') {
        return <View testID={props.testID} style={props.style ? [styles.dot, props.style] : styles.dot} />;
    }

    if (props.variant === 'count') {
        return (
            <View testID={props.testID} style={props.style ? [styles.countBadge, props.style] : styles.countBadge}>
                <Text style={styles.countText}>{formatBadgeCount(props.value, props.max)}</Text>
            </View>
        );
    }

    const max = props.max ?? 999;
    const showLines = props.added > 0 || props.removed > 0;
    return (
        <View testID={props.testID} style={props.style ? [styles.diffChip, props.style] : styles.diffChip}>
            {showLines ? (
                <>
                    {props.added > 0 ? (
                        <Text style={styles.diffAdded}>{`+${formatBadgeCount(props.added, max)}`}</Text>
                    ) : null}
                    {props.removed > 0 ? (
                        <Text style={styles.diffRemoved}>{`−${formatBadgeCount(props.removed, max)}`}</Text>
                    ) : null}
                </>
            ) : (
                <Text style={styles.diffModified}>{formatBadgeCount(props.modifiedCount, max)}</Text>
            )}
        </View>
    );
}
