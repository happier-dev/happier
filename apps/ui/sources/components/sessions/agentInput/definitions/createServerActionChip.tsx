import * as React from 'react';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputPopoverContent } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE, AGENT_INPUT_MENU_ICON_SIZE_PX } from './agentInputChipIconMetrics';
import { AgentInputRailChip } from '@/components/sessions/agentInput/definitions/agentInputChipRowReach';

export function createServerActionChip(params: Readonly<{
    label: string;
    popoverContent: AgentInputPopoverContent;
    maxHeightCap?: number;
    maxWidthCap?: number;
}>): AgentInputExtraActionChip {
    return {
        key: 'new-session-target-server',
        controlId: 'server',
        placement: { id: 'server', title: t('settings.servers'), icon: 'hard-drives', defaultPlacement: 'overflow' },
        collapsedContentPopover: {
            title: params.label,
            label: params.label,
            icon: (tint: string) =>
                normalizeNodeForView(<Icon name="hard-drives" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
            renderContent: params.popoverContent,
            maxHeightCap: params.maxHeightCap,
            maxWidthCap: params.maxWidthCap,
            scrollEnabled: true,
        },
        render: ({ chipStyle, iconColor, showLabel, textStyle, chipAnchorRef, toggleCollapsedPopover }) => (
            <AgentInputRailChip
                ref={chipAnchorRef}
                onPress={() => toggleCollapsedPopover?.('new-session-target-server')}
                style={chipStyle}
            >
                {normalizeNodeForView(<Icon name="hard-drives" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
                {showLabel ? (
                    <Text numberOfLines={1} style={textStyle}>
                        {params.label}
                    </Text>
                ) : null}
            </AgentInputRailChip>
        ),
    };
}
