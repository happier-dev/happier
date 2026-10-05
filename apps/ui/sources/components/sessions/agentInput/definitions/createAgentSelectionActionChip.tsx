import * as React from 'react';
import { Pressable, StyleSheet, View, type View as ViewInstance } from 'react-native';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { ICON_LABEL_OPTICAL_NUDGE_STYLE } from '@/components/ui/icons/iconOpticalAlignment';

const AGENT_CHIP_LOGO_SLOT_SIZE = 16;
const AGENT_CHIP_LOGO_SIZE = 16;
const AGENT_CHIP_LOGO_SLOT_STYLE = {
    width: AGENT_CHIP_LOGO_SLOT_SIZE,
    height: AGENT_CHIP_LOGO_SLOT_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
} as const;

const styles = StyleSheet.create({
    chip: { minWidth: 0, flexShrink: 1 },
    label: { minWidth: 0, flexShrink: 1 },
});

export function createAgentSelectionActionChip(params: Readonly<{
    anchorRef: React.RefObject<ViewInstance | null>;
    agentId: string;
    agentIdentityIcon?: React.ReactNode;
    tint: string;
    showLabel: boolean;
    label: string;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
    onPress: () => void;
}>): React.ReactNode {
    const testID = 'agent-input-agent-chip';
    const iconScale = getAgentPickerIconScale(params.agentId);
    return (
        <Pressable
            ref={params.anchorRef}
            key="agent"
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={params.label}
            onPress={params.onPress}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={(state) => [params.chipStyle(state.pressed), styles.chip]}
        >
            <View style={AGENT_CHIP_LOGO_SLOT_STYLE}>
                {normalizeNodeForView(
                    params.agentIdentityIcon ?? <AgentIcon
                        agentId={params.agentId}
                        size={AGENT_CHIP_LOGO_SIZE}
                        color={params.tint}
                        // Composed, not replaced: the brand scale is per-agent optical correction,
                        // the translate is the shared text-baseline nudge every chip glyph gets.
                        style={{ transform: [{ scale: iconScale }, ...ICON_LABEL_OPTICAL_NUDGE_STYLE.transform] }}
                        testID="agent-input-agent-chip-logo"
                    />,
                )}
            </View>
            {params.showLabel ? (
                <Text numberOfLines={1} style={[params.textStyle, styles.label]}>{params.label}</Text>
            ) : null}
        </Pressable>
    );
}
