import * as React from 'react';
import { Pressable, View, type View as ViewInstance } from 'react-native';

import type { AgentId } from '@/agents/catalog/catalog';
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

export function createAgentSelectionActionChip(params: Readonly<{
    anchorRef: React.RefObject<ViewInstance | null>;
    agentId: AgentId | null;
    tint: string;
    showLabel: boolean;
    label: string;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
    onPress: () => void;
    onIntent?: () => void;
}>): React.ReactNode {
    const testID = 'agent-input-agent-chip';
    const iconScale = params.agentId ? getAgentPickerIconScale(params.agentId) : 1;
    return (
        <Pressable
            ref={params.anchorRef}
            key="agent"
            testID={testID}
            onPress={params.onPress}
            onHoverIn={params.onIntent}
            onPressIn={params.onIntent}
            onFocus={params.onIntent}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={(state) => params.chipStyle(state.pressed)}
        >
            <View style={AGENT_CHIP_LOGO_SLOT_STYLE}>
                {normalizeNodeForView(
                    <AgentIcon
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
                <Text style={params.textStyle}>{params.label}</Text>
            ) : null}
        </Pressable>
    );
}
