import { getConnectedServicesAuthActionChipPlacement } from './agentInputActionChipPlacements';
import * as React from 'react';
import { Platform, Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputContentPopoverHeader, AgentInputPopoverContent } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { AgentInputChipLabel } from '@/components/sessions/agentInput/components/AgentInputChipLabel';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Icon } from '@/components/ui/icons/Icon';
import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { t } from '@/text';

import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE, AGENT_INPUT_MENU_ICON_SIZE_PX } from './agentInputChipIconMetrics';

export type ConnectedServicesAuthActionChipSource = 'native' | 'connected' | 'mixed' | 'unknown';

/** The lab's narrow source list (RT1): one column of sources, not a wide sheet. */
const RUNS_THROUGH_POPOVER_MAX_WIDTH_PX = 400;
const RUNS_THROUGH_POPOVER_MAX_HEIGHT_PX = 560;

/** The popover names itself and the Agent it routes (lab RT1/RT1p). */
function resolveRunsThroughPopoverHeader(agentId: string | null | undefined): AgentInputContentPopoverHeader {
    const id = typeof agentId === 'string' ? agentId.trim() : '';
    const displayNameKey = id && isBundledAgentId(id) ? getAgentCore(id)?.displayNameKey ?? null : null;
    const agent = displayNameKey ? t(displayNameKey) : id;
    return {
        title: t('connectedServices.authChip.popoverTitle'),
        ...(agent ? { description: t('connectedServices.authChip.popoverDescription', { agent }) } : {}),
    };
}

/**
 * The composer's "Runs through" chip (D6): it names where the session's models come from — the
 * Agent's own sign-in, a pool, a gateway or a Provider — derived from the route presentation owner,
 * and opens the existing account choice. It never decides the route itself.
 */
export function createConnectedServicesAuthActionChip(params: Readonly<{
    label: string;
    connectedCount: number;
    authSource: ConnectedServicesAuthActionChipSource;
    popoverContent: AgentInputPopoverContent;
    /** The Agent whose models the popover routes; named in its header. */
    agentId?: string | null;
    testID?: string;
    pending?: boolean;
    placementId?: string;
}>): AgentInputExtraActionChip {
    const webAuthSourceProps = Platform.OS === 'web'
        ? { dataSet: { authSource: params.authSource } }
        : {};

    return {
        key: 'new-session-connected-services-auth',
        controlId: 'connectedServices',
        placement: { ...getConnectedServicesAuthActionChipPlacement(), ...(params.placementId ? { id: params.placementId } : {}), pending: params.pending === true },
        collapsedContentPopover: {
            title: params.label,
            label: params.label,
            icon: (tint: string) =>
                normalizeNodeForView(<Icon name="path" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
            renderContent: params.popoverContent,
            header: resolveRunsThroughPopoverHeader(params.agentId),
            // A phone gets the shared sheet (lab RT1p) rather than a card floating over the composer.
            phonePresentation: 'sheet',
            maxHeightCap: RUNS_THROUGH_POPOVER_MAX_HEIGHT_PX,
            maxWidthCap: RUNS_THROUGH_POPOVER_MAX_WIDTH_PX,
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
                {normalizeNodeForView(<Icon name="path" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
                {showLabel ? (
                    <AgentInputChipLabel
                        label={params.label}
                        textStyle={textStyle}
                        countTextStyle={countTextStyle}
                    />
                ) : null}
            </Pressable>
        ),
    };
}
