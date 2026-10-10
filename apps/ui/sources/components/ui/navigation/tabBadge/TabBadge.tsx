import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { formatBadgeCount } from './tabBadgeModel';

const styles = StyleSheet.create((theme) => ({
    countBadge: {
        position: 'absolute',
        top: -3,
        right: -8,
        // A count that waits on the person (a request, a sign-in): the one attention amber.
        backgroundColor: theme.colors.state.attention.foreground,
        borderRadius: 6.5,
        minWidth: 13,
        height: 13,
        paddingHorizontal: 3,
        justifyContent: 'center',
        alignItems: 'center',
    },
    countBadgeCompact: {
        minWidth: 8,
        height: 8,
        borderRadius: 4,
        paddingHorizontal: 2,
        right: -6,
    },
    compactText: {
        fontSize: 7,
        lineHeight: 8,
    },
    diffChipCompact: {
        height: 8,
        paddingHorizontal: 2,
        gap: 1,
    },
    countBadgeNeutral: {
        backgroundColor: theme.colors.text.secondary,
    },
    countBadgeNeutralCompact: {
        backgroundColor: theme.colors.surface.elevated,
    },
    countTextNeutralCompact: {
        color: theme.colors.text.secondary,
    },
    countText: {
        // Knocked out of the fill in the surface colour (the attention amber is asserted AA under it).
        color: theme.colors.surface.base,
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
    /** Needs you: the one colour a tab dot may carry, the same amber as every waiting-for-you signal. */
    dotAttention: {
        backgroundColor: theme.colors.state.attention.foreground,
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
    | Readonly<{ variant: 'dot'; tone?: 'neutral' | 'attention'; style?: StyleProp<ViewStyle>; testID?: string }>
    | Readonly<{
        variant: 'count';
        size?: 'default' | 'compact';
        value: number;
        max?: number;
        tone?: 'attention' | 'neutral';
        style?: StyleProp<ViewStyle>;
        testID?: string;
    }>
    | Readonly<{
        variant: 'diff';
        size?: 'default' | 'compact';
        added: number;
        removed: number;
        changedFileCount: number;
        max?: number;
        style?: StyleProp<ViewStyle>;
        testID?: string;
    }>;

/**
 * Unified tab-bar badge. Replaces the per-bar inline badge/indicator markup so
 * counts, dots, and git diff chips share spacing, capping, and theme tokens.
 */
export function TabBadge(props: TabBadgeProps): React.ReactElement {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    if (props.variant === 'dot') {
        return (
            <View
                testID={props.testID}
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[styles.dot, props.tone === 'attention' ? styles.dotAttention : null, props.style]}
            />
        );
    }

    if (props.variant === 'count') {
        return (
            <View
                testID={props.testID}
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[
                    styles.countBadge,
                    props.size === 'compact' ? styles.countBadgeCompact : null,
                    props.tone === 'neutral' ? (props.size === 'compact' ? styles.countBadgeNeutralCompact : styles.countBadgeNeutral) : null,
                    props.size === 'compact' && props.tone === 'neutral' ? { backgroundColor: paintColor(theme.colors.surface.elevated) } : null,
                    props.style ?? null,
                ]}
            >
                <Text style={[styles.countText, props.size === 'compact' ? styles.compactText : null, props.size === 'compact' && props.tone === 'neutral' ? styles.countTextNeutralCompact : null]}>{formatBadgeCount(props.value, props.max)}</Text>
            </View>
        );
    }

    const max = props.max ?? 999;
    const showLines = props.added > 0 || props.removed > 0;
    return (
        <View
            testID={props.testID}
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.diffChip, props.size === 'compact' ? styles.diffChipCompact : null, { backgroundColor: paintColor(theme.colors.surface.base) }, props.style]}
        >
            {showLines ? (
                <>
                    {props.added > 0 ? (
                        <Text style={[styles.diffAdded, props.size === 'compact' ? styles.compactText : null]}>{`+${formatBadgeCount(props.added, max)}`}</Text>
                    ) : null}
                    {props.removed > 0 ? (
                        <Text style={[styles.diffRemoved, props.size === 'compact' ? styles.compactText : null]}>{`−${formatBadgeCount(props.removed, max)}`}</Text>
                    ) : null}
                </>
            ) : (
                <Text style={[styles.diffModified, props.size === 'compact' ? styles.compactText : null]}>{formatBadgeCount(props.changedFileCount, max)}</Text>
            )}
        </View>
    );
}
