import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export const JumpToBottomButton = React.memo(function JumpToBottomButton(props: {
    count: number;
    onPress: () => void;
    testID?: string;
}) {
    const { theme } = useUnistyles();
    const label = t('settingsSession.transcript.jumpToBottomButtonLabel');
    return (
        <Pressable
            testID={props.testID}
            onPress={props.onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={({ pressed }) => [styles.container, pressed && { opacity: 0.92 }]}
        >
            <View style={styles.badge}>
                <Text style={styles.badgeText}>{String(props.count)}</Text>
            </View>
            <Text style={styles.label} numberOfLines={1}>
                {label}
            </Text>
            <Ionicons name="chevron-down" size={16} color={theme.colors.text} />
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
        backgroundColor: theme.colors.surfaceHighest,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 6 },
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
        color: theme.colors.surface,
    },
    label: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
    },
}));
