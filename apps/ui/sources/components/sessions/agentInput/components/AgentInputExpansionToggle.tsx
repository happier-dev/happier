import * as React from 'react';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_EXPANSION_TOGGLE_HIT_REACH } from './agentInputChromeStyles';

export function AgentInputExpansionToggle({
    expanded,
    onToggle,
    placement = 'corner',
}: Readonly<{
    expanded: boolean;
    onToggle: () => void;
    /** `inline`: in an embedded composer's tool line, beside the other tools, not over the field's corner. */
    placement?: 'corner' | 'inline';
}>) {
    const { theme } = useUnistyles();
    return (
        <HappierPressable
            accessibilityLabel={expanded ? t('common.collapse') : t('common.expand')}
            accessibilityRole="button"
            testID="agent-input-expand-toggle"
            hitReach={AGENT_INPUT_EXPANSION_TOGGLE_HIT_REACH}
            onPress={onToggle}
            style={({ pressed }) => [
                styles.inputExpansionToggle,
                placement === 'inline' ? styles.inline : null,
                pressed ? { backgroundColor: theme.colors.surface.pressed } : null,
            ]}
        >
            <Icon
                name={expanded ? 'arrows-in' : 'arrows-out'}
                size={16}
                color={theme.colors.text.secondary}
            />
        </HappierPressable>
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
    inline: {
        position: 'relative',
        top: 0,
        right: 0,
    },
});
