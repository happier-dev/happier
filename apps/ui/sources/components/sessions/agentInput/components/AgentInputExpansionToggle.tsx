import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

const MINIMUM_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);
const HORIZONTAL_TARGET_INSET = (MINIMUM_TARGET_SIZE - 24) / 2;

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
            hitSlop={{
                top: MINIMUM_TARGET_SIZE - 24,
                right: HORIZONTAL_TARGET_INSET,
                bottom: 0,
                left: HORIZONTAL_TARGET_INSET,
            }}
            testID="agent-input-expand-toggle"
            onPress={onToggle}
            style={({ pressed }) => [
                styles.inputExpansionToggle,
                pressed ? { backgroundColor: theme.colors.surface.pressed } : null,
            ]}
        >
            <Icon
                name={expanded ? 'arrows-in' : 'arrows-out'}
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
