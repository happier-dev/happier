import { Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, type PressableStateCallbackType } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { t } from '@/text';

function translateAuggieIndexingLabel(allowIndexing: boolean): string {
    return t(allowIndexing ? 'agentInput.auggieIndexingChip.on' : 'agentInput.auggieIndexingChip.off');
}

function renderAuggieSearchIcon(color: string): React.ReactNode {
    return <Octicons name="search" size={16} color={color} />;
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
            icon: renderAuggieSearchIcon(tint),
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
                    {renderAuggieSearchIcon(iconColor)}
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
