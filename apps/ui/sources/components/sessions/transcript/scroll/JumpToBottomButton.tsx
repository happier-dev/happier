import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { shadowLevelStyle } from '@/shadowElevation';
import { t } from '@/text';

export const JumpToBottomButton = React.memo(function JumpToBottomButton(props: {
    count: number;
    onPress: () => void;
    testID?: string;
}) {
    const { theme, rt } = useUnistyles();
    const label = t('settingsSession.transcript.jumpToBottomButtonLabel');
    const compact = rt.breakpoint === 'xs' || rt.breakpoint === 'sm' || rt.breakpoint === 'md';
    return (
        <Pressable
            testID={props.testID}
            onPress={props.onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={({ pressed }) => [styles.container, compact && styles.compactContainer, pressed && { opacity: 0.92 }]}
        >
            {props.count > 0 ? (
                <View style={styles.badge}>
                    <Text style={styles.badgeText}>{String(props.count)}</Text>
                </View>
            ) : null}
            {!compact ? (
                <Text style={styles.label} numberOfLines={1}>
                    {label}
                </Text>
            ) : null}
            <Ionicons name="chevron-down" size={16} color={theme.colors.text.primary} />
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.elevated,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
    },
    compactContainer: {
        minWidth: 40,
        height: 40,
        paddingHorizontal: 8,
        paddingVertical: 0,
        justifyContent: 'center',
        gap: 6,
    },
    badge: {
        minWidth: 18,
        height: 18,
        paddingHorizontal: 6,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.accent.blue,
    },
    badgeText: {
        fontSize: 11,
        fontWeight: '700',
        color: theme.colors.surface.base,
    },
    label: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text.primary,
    },
}));
