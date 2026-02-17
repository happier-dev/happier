import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { getActionSpec } from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/AgentInput';
import { listAgentInputActionChipActionIds } from '@/components/sessions/agentInput/actionChips/listAgentInputActionChipActionIds';
import { buildActionDraftInput } from '@/sync/domains/actions/buildActionDraftInput';

export function buildSessionAgentInputActionChips(params: Readonly<{
    sessionId: string;
    defaultBackendId: string | null;
    instructionsText: string;
}>): ReadonlyArray<AgentInputExtraActionChip> {
    const stateSnapshot = storage.getState() as any;
    const actionIds = listAgentInputActionChipActionIds(stateSnapshot);
    if (actionIds.length === 0) return [];

    const backendId = typeof params.defaultBackendId === 'string' && params.defaultBackendId.trim().length > 0
        ? params.defaultBackendId.trim()
        : null;
    const instructions = String(params.instructionsText ?? '');

    return actionIds.map((actionId) => {
        const spec = getActionSpec(actionId as any);
        const input = buildActionDraftInput({
            actionId: actionId as any,
            sessionId: params.sessionId,
            defaultBackendId: backendId,
            instructions,
        });

        return {
            key: `session-action:${actionId}`,
            render: ({ chipStyle, iconColor, showLabel, textStyle }) => (
                <Pressable
                    onPress={() => {
                        storage.getState().createSessionActionDraft(params.sessionId, {
                            actionId,
                            input,
                        });
                    }}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(p) => chipStyle(p.pressed)}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Ionicons name="flash-outline" size={16} color={iconColor} />
                        {showLabel ? (
                            <Text numberOfLines={1} style={textStyle}>
                                {spec.title}
                            </Text>
                        ) : null}
                    </View>
                </Pressable>
            ),
        };
    });
}
