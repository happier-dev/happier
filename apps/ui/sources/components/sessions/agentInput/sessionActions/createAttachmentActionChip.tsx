import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { Text } from '@/components/ui/text/Text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { t } from '@/text';

export function createAttachmentActionChip(params: Readonly<{
    onPress: () => void;
    disabled?: boolean;
}>): AgentInputExtraActionChip {
    return {
        key: 'attachments-add',
        controlId: 'attachments',
        labelPolicy: 'auto-hide',
        collapsedAction: ({ tint, dismiss }) => ({
            id: 'attachments',
            label: t('common.attach'),
            icon: normalizeNodeForView(<Ionicons name="attach-outline" size={16} color={tint} />),
            onPress: () => {
                dismiss();
                params.onPress();
            },
        }),
        render: (ctx: AgentInputExtraActionChipRenderContext) => (
            <Pressable
                onPress={params.onPress}
                disabled={params.disabled}
                style={({ pressed }) => ctx.chipStyle(Boolean(pressed))}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {normalizeNodeForView(<Ionicons name="attach-outline" size={18} color={ctx.iconColor} />)}
                    {ctx.showLabel ? <Text style={ctx.textStyle}>{t('common.attach')}</Text> : null}
                </View>
            </Pressable>
        ),
    };
}
