import * as React from 'react';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { Pressable, type View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { resolveAutomationAccessibilityLabel } from '@/dev/automation/automationTestId';

export function createSessionModeActionChip(params: Readonly<{
    anchorRef: React.RefObject<View | null>;
    tint: string;
    showLabel: boolean;
    label: string;
    accessibilityLabel: string;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
    iconKind?: 'ionicon' | 'octicon';
    iconName?: string;
    onPress: () => void;
}>): React.ReactNode {
    const testID = 'agent-input-session-mode-chip';
    const accessibilityLabel = resolveAutomationAccessibilityLabel({
        testID,
        accessibilityLabel: params.accessibilityLabel,
    });
    return (
        <Pressable
            ref={params.anchorRef}
            testID={testID}
            key="mode"
            onPress={params.onPress}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={(state) => params.chipStyle(state.pressed)}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
        >
            {params.iconKind === 'octicon' ? (
                <Octicons name={params.iconName as never} size={16} color={params.tint} />
            ) : (
                <Ionicons name={(params.iconName ?? 'list-outline') as never} size={18} color={params.tint} />
            )}
            {params.showLabel ? (
                <Text style={params.textStyle}>{params.label}</Text>
            ) : null}
        </Pressable>
    );
}
