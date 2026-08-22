import * as React from 'react';
import { Pressable, View, type View as ViewInstance } from 'react-native';

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
    agentId: string;
    tint: string;
    showLabel: boolean;
    label: string;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
    onPress: () => void;
    /**
     * The reader is reaching for this chip.
     *
     * Hover, focus and press-in all mean the same thing here, and all three are
     * wired because no single one covers every host: a pointer hovers, a keyboard
     * focuses, and a finger only ever presses. Opening the picker asks the Session's
     * machine what it can continue with, and that question is worth starting while
     * the pointer is still travelling.
     */
    onIntent?: () => void;
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
