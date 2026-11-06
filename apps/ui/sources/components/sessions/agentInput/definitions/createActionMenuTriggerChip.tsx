import * as React from 'react';
import { type View } from 'react-native';

import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE } from '../components/agentInputChromeStyles';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE } from './agentInputChipIconMetrics';
import { AgentInputRailChip } from '@/components/sessions/agentInput/definitions/agentInputChipRowReach';

/**
 * The composer's leading +: the less frequent controls and "Customize composer…" (calm-shell C2plus).
 * Always the bare glyph, whatever the chip-label density, so the row starts at the same place; its name
 * is spoken and shown as a tooltip. While its menu is open it holds the selection fill.
 */
export function createActionMenuTriggerChip(params: Readonly<{
    anchorRef: React.RefObject<View | null>;
    tint: string;
    chipStyle: (pressed: boolean) => any;
    open: boolean;
    openStyle: import('react-native').ViewProps['style'];
    onPress: () => void;
}>): React.ReactNode {
    return (
        <AgentInputRailChip
            ref={params.anchorRef}
            key="action-menu"
            testID="agent-input-action-menu-button"
            accessibilityRole="button"
            accessibilityLabel={t('agentInput.actionMenu.title')}
            accessibilityState={{ expanded: params.open }}
            webAttributes={{ title: t('agentInput.actionMenu.title') }}
            onPress={params.onPress}
            style={(pressed) => [params.chipStyle(pressed), AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE, params.open ? params.openStyle : null]}
        >
            <Icon name="plus" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={params.tint} style={AGENT_INPUT_CHIP_ICON_STYLE} />
        </AgentInputRailChip>
    );
}
