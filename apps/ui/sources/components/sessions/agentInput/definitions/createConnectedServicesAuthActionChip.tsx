import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Platform, Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputPopoverContent } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { AgentInputChipLabel } from '@/components/sessions/agentInput/components/AgentInputChipLabel';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';

export type ConnectedServicesAuthActionChipSource = 'native' | 'connected' | 'mixed';

export function createConnectedServicesAuthActionChip(params: Readonly<{
    label: string;
    connectedCount: number;
    authSource: ConnectedServicesAuthActionChipSource;
    popoverContent: AgentInputPopoverContent;
    maxHeightCap?: number;
    maxWidthCap?: number;
    testID?: string;
}>): AgentInputExtraActionChip {
    const webAuthSourceProps = Platform.OS === 'web'
        ? { dataSet: { authSource: params.authSource } }
        : {};

    return {
        key: 'new-session-connected-services-auth',
        controlId: 'connectedServices',
        collapsedContentPopover: {
            title: params.label,
            label: params.label,
            icon: (tint: string) =>
                normalizeNodeForView(<Ionicons name="key-outline" size={16} color={tint} />),
            renderContent: params.popoverContent,
            maxHeightCap: params.maxHeightCap,
            maxWidthCap: params.maxWidthCap,
            scrollEnabled: false,
        },
        render: ({ chipStyle, iconColor, showLabel, textStyle, countTextStyle, chipAnchorRef, toggleCollapsedPopover }) => (
            <Pressable
                ref={chipAnchorRef}
                testID={params.testID ?? 'new-session-connected-services-auth-chip'}
                {...webAuthSourceProps}
                onPress={() => toggleCollapsedPopover?.('new-session-connected-services-auth')}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={(pressed) => chipStyle(pressed.pressed)}
            >
                {normalizeNodeForView(<Ionicons name="key-outline" size={16} color={iconColor} />)}
                {showLabel ? (
                    <AgentInputChipLabel
                        label={params.label}
                        count={params.connectedCount}
                        textStyle={textStyle}
                        countTextStyle={countTextStyle}
                    />
                ) : null}
            </Pressable>
        ),
    };
}
