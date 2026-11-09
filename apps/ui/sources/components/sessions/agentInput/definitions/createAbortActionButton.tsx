import * as React from 'react';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { Shaker, type ShakeInstance } from '@/components/ui/feedback/Shaker';
import { t } from '@/text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE } from './agentInputChipIconMetrics';
import { useAgentInputChipRowReach } from './agentInputChipRowReach';

type AbortActionButtonParams = Readonly<{
    shakerRef: React.RefObject<ShakeInstance | null>;
    isAborting: boolean;
    tint: string;
    buttonStyle: any;
    buttonPressedStyle: any;
    onPress: () => void;
}>;

/** Stop sits in the chip rail beside the chips, so it takes the rail's reach like they do. */
function AbortActionButton(props: Readonly<{ params: AbortActionButtonParams }>) {
    const { params } = props;
    const railReach = useAgentInputChipRowReach();
    return (
        <Shaker ref={params.shakerRef}>
            <HappierPressable
                testID="agent-input-abort"
                accessibilityRole="button"
                accessibilityLabel={t('agentInput.stopCodingTurn')}
                hitReach={railReach}
                style={(state) => [
                    params.buttonStyle,
                    state.pressed ? params.buttonPressedStyle : null,
                ]}
                onPress={params.onPress}
                disabled={params.isAborting}
            >
                {params.isAborting ? (
                    <ActivitySpinner size="small" color={params.tint} />
                ) : (
                    <Icon name="octagon-x" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={params.tint} style={AGENT_INPUT_CHIP_ICON_STYLE} />
                )}
            </HappierPressable>
        </Shaker>
    );
}

export function createAbortActionButton(params: AbortActionButtonParams): React.ReactNode {
    return <AbortActionButton key="abort" params={params} />;
}
