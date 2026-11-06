import { getTemporaryComputerTeamAccessActionChipPlacement } from './agentInputActionChipPlacements';
import * as React from 'react';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import {
    AGENT_INPUT_CHIP_ICON_SIZE_PX,
    AGENT_INPUT_CHIP_ICON_STYLE,
    AGENT_INPUT_MENU_ICON_SIZE_PX,
} from './agentInputChipIconMetrics';

/** One-shot creator consent for the next exact Temporary-computer activation. */
export function createTemporaryComputerTeamAccessActionChip(params: Readonly<{
    authorized: boolean;
    onChange: (authorized: boolean) => void;
}>): AgentInputExtraActionChip {
    const label = params.authorized
        ? t('newSession.temporaryComputer.teamAccess.on')
        : t('newSession.temporaryComputer.teamAccess.off');
    return {
        key: 'new-session-temporary-computer-team-access',
        controlId: 'sessionAccess',
        placement: { ...getTemporaryComputerTeamAccessActionChipPlacement(), pending: params.authorized },
        stabilityKey: params.authorized,
        labelPolicy: 'always',
        collapsedAction: ({ tint, dismiss }) => ({
            id: 'new-session-temporary-computer-team-access',
            label: t('newSession.temporaryComputer.teamAccess.title'),
            subtitle: label,
            accessibilityLabel: t('newSession.temporaryComputer.teamAccess.title'),
            icon: normalizeNodeForView(
                <Icon name="shield-check" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />,
            ),
            onPress: () => {
                dismiss();
                params.onChange(!params.authorized);
            },
        }),
        render: ({ chipStyle, iconColor, showLabel, textStyle, chipAnchorRef }) => (
            <Pressable
                ref={chipAnchorRef}
                testID="new-session-temporary-computer-team-access"
                accessibilityRole="switch"
                accessibilityState={{ checked: params.authorized }}
                accessibilityLabel={t('newSession.temporaryComputer.teamAccess.title')}
                accessibilityHint={t('newSession.temporaryComputer.teamAccess.hint')}
                onPress={() => params.onChange(!params.authorized)}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={({ pressed }) => chipStyle(pressed)}
            >
                {normalizeNodeForView(
                    <Icon
                        name="shield-check"
                        size={AGENT_INPUT_CHIP_ICON_SIZE_PX}
                        color={iconColor}
                        style={AGENT_INPUT_CHIP_ICON_STYLE}
                    />,
                )}
                {showLabel ? <Text numberOfLines={1} style={textStyle}>{label}</Text> : null}
            </Pressable>
        ),
    };
}
