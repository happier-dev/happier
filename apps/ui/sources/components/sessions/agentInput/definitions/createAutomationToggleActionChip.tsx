import * as React from 'react';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import {
    AutomationSettingsPopoverContent,
} from '@/components/sessions/agentInput/components/AutomationSettingsPopoverContent';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE, AGENT_INPUT_MENU_ICON_SIZE_PX } from './agentInputChipIconMetrics';

export function createAutomationToggleActionChip(params: Readonly<{
    enabled: boolean;
    label: string;
    value: NewSessionAutomationDraft;
    onChange: (next: NewSessionAutomationDraft) => void;
    machineId?: string | null;
    targetServerId?: string | null;
}>): AgentInputExtraActionChip {
    const maxWidthCapEnabled = 680;
    const maxWidthCapDisabled = Math.round(maxWidthCapEnabled / 2);

    return {
        key: 'new-session-automate',
        controlId: 'automation',
        collapsedContentPopover: {
            title: params.label,
            label: params.label,
            icon: (tint: string) =>
                normalizeNodeForView(<Icon name="lightning" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
            renderContent: () => (
                <AutomationSettingsPopoverContent
                    value={params.value}
                    onChange={params.onChange}
                    machineId={params.machineId}
                    targetServerId={params.targetServerId}
                />
            ),
            maxHeightCap: 620,
            maxWidthCap: params.enabled ? maxWidthCapEnabled : maxWidthCapDisabled,
            scrollEnabled: true,
        },
        render: ({ chipStyle, iconColor, showLabel, textStyle, chipAnchorRef, toggleCollapsedPopover }) => (
            <Pressable
                ref={chipAnchorRef}
                testID="new-session-automation-chip"
                onPress={() => toggleCollapsedPopover?.('new-session-automate')}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={({ pressed }) => chipStyle(pressed)}
            >
                {normalizeNodeForView(<Icon name="lightning" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
                {showLabel ? (
                    <Text numberOfLines={1} style={textStyle}>
                        {params.label}
                    </Text>
                ) : null}
            </Pressable>
        ),
    };
}
