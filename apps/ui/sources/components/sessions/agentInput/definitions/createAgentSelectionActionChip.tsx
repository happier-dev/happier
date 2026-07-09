import * as React from 'react';
import { Pressable, View, type View as ViewInstance } from 'react-native';

import type { AgentId } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';

const AGENT_CHIP_LOGO_SLOT_SIZE = 16;
const AGENT_CHIP_LOGO_SIZE = 16;
const AGENT_CHIP_LOGO_SLOT_STYLE = {
    width: AGENT_CHIP_LOGO_SLOT_SIZE,
    height: AGENT_CHIP_LOGO_SLOT_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
} as const;

export function createAgentSelectionActionChip(params: Readonly<{
    anchorRef: React.RefObject<ViewInstance | null>;
    agentId: AgentId;
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
            onPress={params.onPress}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={(state) => params.chipStyle(state.pressed)}
        >
            <View style={AGENT_CHIP_LOGO_SLOT_STYLE}>
                {normalizeNodeForView(
                    <AgentIcon
                        agentId={params.agentId}
                        size={AGENT_CHIP_LOGO_SIZE}
                        color={params.tint}
                        style={{ transform: [{ scale: iconScale }] }}
                        testID="agent-input-agent-chip-logo"
                    />,
                )}
            </View>
            {params.showLabel ? (
                <Text style={params.textStyle}>{params.label}</Text>
            ) : null}
        </Pressable>
    );
}
