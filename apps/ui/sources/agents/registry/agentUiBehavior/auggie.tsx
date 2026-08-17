import * as React from 'react';
import { Pressable, type PressableStateCallbackType } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_MENU_ICON_SIZE_PX } from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';

function translateAuggieIndexingLabel(allowIndexing: boolean): string {
    return t(allowIndexing ? 'agentInput.auggieIndexingChip.on' : 'agentInput.auggieIndexingChip.off');
}

/**
 * One helper, two surfaces: the chip draws this glyph on itself in the composer chip row, and also
 * hands it to the collapsed action menu. Those size differently, so the caller says which.
 */
function renderAuggieSearchIcon(color: string, size: number): React.ReactNode {
    return <Icon name="magnifying-glass" size={size} color={color} />;
}

export function createAuggieAllowIndexingChip(opts: Readonly<{
    allowIndexing: boolean;
    setAllowIndexing: (value: boolean) => void;
}>): AgentInputExtraActionChip {
    return {
        key: 'auggie-allow-indexing',
        controlId: 'providerOption',
        collapsedAction: ({ tint, dismiss }) => ({
            id: 'auggie-allow-indexing',
            label: translateAuggieIndexingLabel(opts.allowIndexing),
            icon: renderAuggieSearchIcon(tint, AGENT_INPUT_MENU_ICON_SIZE_PX),
            onPress: () => {
                dismiss();
                hapticsLight();
                opts.setAllowIndexing(!opts.allowIndexing);
            },
        }),
        render: ({ chipStyle, showLabel, iconColor, textStyle }) => {
            const { Text } = require('@/components/ui/text/Text') as typeof import('@/components/ui/text/Text');
            const label = translateAuggieIndexingLabel(opts.allowIndexing);
            return (
                <Pressable
                    onPress={() => {
                        hapticsLight();
                        opts.setAllowIndexing(!opts.allowIndexing);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(pressableState: PressableStateCallbackType) => chipStyle(pressableState.pressed)}
                >
                    {renderAuggieSearchIcon(iconColor, AGENT_INPUT_CHIP_ICON_SIZE_PX)}
                    {showLabel ? (
                        <Text style={textStyle}>
                            {label}
                        </Text>
                    ) : null}
                </Pressable>
            );
        },
    };
}
