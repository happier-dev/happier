import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputPopoverContent } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { AgentInputChipLabel } from '@/components/sessions/agentInput/components/AgentInputChipLabel';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';

export function createMcpActionChip(params: Readonly<{
    label: string;
    selectedCount: number;
    popoverContent: AgentInputPopoverContent;
    maxHeightCap?: number;
    maxWidthCap?: number;
}>): AgentInputExtraActionChip {
    return {
        key: 'new-session-mcp',
        controlId: 'mcp',
        collapsedContentPopover: {
            title: params.label,
            label: params.label,
            icon: (tint: string) =>
                normalizeNodeForView(<Ionicons name="server-outline" size={16} color={tint} />),
            renderContent: params.popoverContent,
            maxHeightCap: params.maxHeightCap,
            maxWidthCap: params.maxWidthCap,
        },
        render: ({ chipStyle, iconColor, showLabel, textStyle, countTextStyle, chipAnchorRef, toggleCollapsedPopover }) => (
            <Pressable
                ref={chipAnchorRef}
                testID="new-session-mcp-chip"
                onPress={() => toggleCollapsedPopover?.('new-session-mcp')}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={(pressed) => chipStyle(pressed.pressed)}
            >
                {normalizeNodeForView(<Ionicons name="server-outline" size={16} color={iconColor} />)}
                {showLabel ? (
                    <AgentInputChipLabel
                        label={params.label}
                        count={params.selectedCount}
                        textStyle={textStyle}
                        countTextStyle={countTextStyle}
                    />
                ) : null}
            </Pressable>
        ),
    };
}
