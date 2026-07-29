import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

type CopiedPillProps = Readonly<{
    visible: boolean;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>;

export function CopiedPill(props: CopiedPillProps) {
    if (!props.visible) return null;

    const label = t('common.copied');

    return (
        <View
            testID={props.testID}
            pointerEvents="none"
            accessibilityRole="text"
            accessibilityLabel={label}
            accessibilityLiveRegion="polite"
            style={[styles.container, props.style]}
        >
            <SafeIonicons name="checkmark-outline" size={14} color={styles.icon.color} />
            <Text style={styles.label}>{label}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        paddingHorizontal: 8,
        paddingVertical: 3,
    },
    icon: {
        color: theme.colors.state.success.foreground,
    },
    label: {
        color: theme.colors.text.primary,
        fontSize: 12,
        lineHeight: 16,
    },
}));
