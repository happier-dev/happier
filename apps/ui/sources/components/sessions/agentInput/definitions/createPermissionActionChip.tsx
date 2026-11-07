import * as React from 'react';
import { type View } from 'react-native';
import { AgentInputRailChip } from './agentInputChipRowReach';

import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE } from './agentInputChipIconMetrics';

export function createPermissionActionChip(params: Readonly<{
    anchorRef: React.RefObject<View | null>;
    tint: string;
    showLabel: boolean;
    label: string | null;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
    onPress: () => void;
}>): React.ReactNode {
    const testID = 'agent-input-permission-chip';
    return (
        <AgentInputRailChip
            ref={params.anchorRef}
            key="permission"
            testID={testID}
            // The glyph alone is drawn when chip labels are off; the mode still names the control.
            accessibilityLabel={params.label || t('newSession.wizardSection.permission')}
            onPress={params.onPress}
            style={params.chipStyle}
        >
            {normalizeNodeForView(<Icon name="shield-check" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={params.tint} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
            {params.showLabel && params.label ? (
                <Text style={params.textStyle}>{params.label}</Text>
            ) : null}
        </AgentInputRailChip>
    );
}
