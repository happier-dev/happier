import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';

export function AgentInputExpansionToggle({
    expanded,
    onToggle,
}: Readonly<{
    expanded: boolean;
    onToggle: () => void;
}>) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            accessibilityLabel={expanded ? t('common.collapse') : t('common.expand')}
            accessibilityRole="button"
            hitSlop={8}
            testID="agent-input-expand-toggle"
            onPress={onToggle}
            style={({ pressed }) => [
                styles.inputExpansionToggle,
                pressed ? { backgroundColor: theme.colors.surface.pressed } : null,
            ]}
        >
            <Ionicons
                name={expanded ? 'contract-outline' : 'expand-outline'}
                size={16}
                color={theme.colors.text.secondary}
            />
        </Pressable>
    );
}

const styles = StyleSheet.create({
    inputExpansionToggle: {
        position: 'absolute',
        top: 6,
        right: 6,
        zIndex: 2,
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
