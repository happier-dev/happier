import { t } from '@/text';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputPopoverContent } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE, AGENT_INPUT_MENU_ICON_SIZE_PX } from './agentInputChipIconMetrics';

export function createSessionAccessActionChip(params: Readonly<{
    label: string;
    accessibilityLabel: string;
    onOpen?: (focusReturnRef?: React.RefObject<View | null>) => void;
    /** Renders the grant row's lock glyph so the collapsed chip states the same policy fact. */
    requiredByTeamPolicy?: boolean;
    pending?: boolean;
    popoverContent: AgentInputPopoverContent;
    maxHeightCap?: number;
    maxWidthCap?: number;
}>): AgentInputExtraActionChip {
    return {
        key: 'session-access',
        controlId: 'sessionAccess',
        placement: { id: 'sessionAccess', title: t('session.access.title'), icon: 'users', defaultPlacement: 'overflow', pending: params.pending === true },
        collapsedContentPopover: {
            title: params.label,
            label: params.label,
            accessibilityLabel: params.accessibilityLabel,
            icon: (tint: string) =>
                normalizeNodeForView(<Icon name="users" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
            renderContent: params.popoverContent,
            maxHeightCap: params.maxHeightCap,
            maxWidthCap: params.maxWidthCap,
            scrollEnabled: false,
        },
        ...(params.onOpen ? { collapsedAction: ({ dismiss }: { dismiss: () => void }) => ({
            id: 'sessionAccess', label: params.label, accessibilityLabel: params.accessibilityLabel,
            onPress: () => { dismiss(); params.onOpen?.(); },
        }) } : {}),
        render: ({ chipStyle, iconColor, showLabel, textStyle, chipAnchorRef, toggleCollapsedPopover }) => (
            <Pressable
                ref={chipAnchorRef}
                testID="session-access-chip"
                accessibilityRole="button"
                accessibilityLabel={params.accessibilityLabel}
                onPress={() => params.onOpen ? params.onOpen(chipAnchorRef) : toggleCollapsedPopover?.('session-access')}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={(pressed) => chipStyle(pressed.pressed)}
            >
                {normalizeNodeForView(<Icon name="users" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
                {showLabel ? (
                    <Text numberOfLines={1} style={textStyle}>
                        {params.label}
                    </Text>
                ) : null}
                {params.requiredByTeamPolicy ? (
                    // The accessible name already carries the policy words, so the
                    // glyph only repeats it visually beside the collapsed label.
                    <View testID="session-access-chip:policy-lock">
                        {normalizeNodeForView(<SafeIonicons name="lock-closed-outline" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={iconColor} />)}
                    </View>
                ) : null}
            </Pressable>
        ),
    };
}
