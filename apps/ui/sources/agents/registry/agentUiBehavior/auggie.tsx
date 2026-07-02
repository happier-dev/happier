import { Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, type PressableStateCallbackType } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { t } from '@/text';
import type { AgentUiBehavior } from '../registryUiBehavior';
import { readString } from '../uiDescriptorDiagnostics';

type AuggieUiBehaviorDescriptor = Readonly<{
    newSessionOptions?: readonly Readonly<{
        id: string;
        stateKey: string;
    }>[];
}>;

function findAllowIndexingStateKey(descriptor: AuggieUiBehaviorDescriptor): string | null {
    for (const option of descriptor.newSessionOptions ?? []) {
        if (readString(option.id) === 'auggie.allowIndexing') {
            return readString(option.stateKey);
        }
    }
    return null;
}

function translateAuggieIndexingLabel(allowIndexing: boolean): string {
    return t(allowIndexing ? 'agentInput.auggieIndexingChip.on' : 'agentInput.auggieIndexingChip.off');
}

function renderAuggieSearchIcon(color: string): React.ReactNode {
    return <Octicons name="search" size={16} color={color} />;
}

function createAuggieAllowIndexingChip(opts: Readonly<{
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
            return (
                <Pressable
                    onPress={() => {
                        hapticsLight();
                        opts.setAllowIndexing(!opts.allowIndexing);
                    }}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(pressableState: PressableStateCallbackType) => chipStyle(pressableState.pressed)}
                >
                    {renderAuggieSearchIcon(iconColor)}
                    {showLabel ? (
                        <Text style={textStyle}>
                            {translateAuggieIndexingLabel(opts.allowIndexing)}
                        </Text>
                    ) : null}
                </Pressable>
            );
        },
    };
}

export function createAuggieUiBehavior(descriptor: AuggieUiBehaviorDescriptor): AgentUiBehavior {
    const allowIndexingStateKey = findAllowIndexingStateKey(descriptor);
    if (!allowIndexingStateKey) return {};

    return {
        newSession: {
            getAgentInputExtraActionChips: ({ agentId, agentOptionState, setAgentOptionState }) => {
                if (agentId !== 'auggie') return undefined;
                const allowIndexing = agentOptionState?.[allowIndexingStateKey] === true;
                return [
                    createAuggieAllowIndexingChip({
                        allowIndexing,
                        setAllowIndexing: (value) => setAgentOptionState(allowIndexingStateKey, value),
                    }),
                ];
            },
        },
    };
}
