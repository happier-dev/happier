import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput';
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, Text } from 'react-native';

export function getVoiceMediatorExtraActionChips(opts: {
    voiceProviderId: string | null | undefined;
    voiceLocalConversationMode: 'direct_session' | 'mediator';
    onCommitPress: () => Promise<void> | void;
    label?: string;
    accessibilityLabel?: string;
}): ReadonlyArray<AgentInputExtraActionChip> {
    if (opts.voiceProviderId !== 'local_openai_stt_tts') return [];
    if (opts.voiceLocalConversationMode !== 'mediator') return [];

    return [{
        key: 'voice_mediator_commit',
        render: (ctx) => (
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={opts.accessibilityLabel ?? opts.label ?? 'Commit'}
                onPress={opts.onCommitPress}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={(p) => ctx.chipStyle(p.pressed)}
            >
                <Ionicons name="checkmark-done-outline" size={16} color={ctx.iconColor} />
                {ctx.showLabel && opts.label ? (
                    <Text style={ctx.textStyle}>{opts.label}</Text>
                ) : null}
            </Pressable>
        ),
    }];
}
