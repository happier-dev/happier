import * as React from 'react';
import { Octicons } from '@expo/vector-icons';
import { Pressable, type View } from 'react-native';

import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { resolveAutomationAccessibilityLabel } from '@/dev/automation/automationTestId';

export function createAgentSelectionActionChip(params: Readonly<{
    anchorRef: React.RefObject<View | null>;
    tint: string;
    showLabel: boolean;
    label: string;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
    onPress: () => void;
}>): React.ReactNode {
    const testID = 'agent-input-agent-chip';
    const accessibilityLabel = resolveAutomationAccessibilityLabel({ testID, accessibilityLabel: undefined });
    return (
        <Pressable
            ref={params.anchorRef}
            key="agent"
            testID={testID}
            accessibilityLabel={accessibilityLabel}
            onPress={params.onPress}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={(state) => params.chipStyle(state.pressed)}
        >
            {normalizeNodeForView(<Octicons name="cpu" size={16} color={params.tint} />)}
            {params.showLabel ? (
                <Text style={params.textStyle}>{params.label}</Text>
            ) : null}
        </Pressable>
    );
}
