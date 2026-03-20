import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export function createTranscriptStorageActionChip(params: Readonly<{
    transcriptStorage: 'direct' | 'persisted';
    onPress: () => void;
}>): AgentInputExtraActionChip {
    const isDirect = params.transcriptStorage === 'direct';
    return {
        key: 'new-session-storage',
        controlId: 'storage',
        collapsedAction: ({ dismiss }) => ({
            id: 'storage',
            label: isDirect
                ? 'sessionsList.storageDirectTab'
                : 'sessionsList.storagePersistedTab',
            icon: null,
            onPress: () => {
                dismiss();
                params.onPress();
            },
        }),
        render: ({ chipStyle, iconColor, showLabel, textStyle }) => (
            <Pressable
                onPress={params.onPress}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={(pressed) => chipStyle(pressed.pressed)}
            >
                {normalizeNodeForView(
                    <Ionicons
                        name={isDirect ? 'radio-outline' : 'save-outline'}
                        size={16}
                        color={iconColor}
                    />,
                )}
                {showLabel ? (
                    <Text numberOfLines={1} style={textStyle}>
                        {isDirect
                            ? t('sessionsList.storageDirectTab')
                            : t('sessionsList.storagePersistedTab')}
                    </Text>
                ) : null}
            </Pressable>
        ),
    };
}
