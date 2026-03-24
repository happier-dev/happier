import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, View, Platform } from 'react-native';

import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { Text } from '@/components/ui/text/Text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { t } from '@/text';

export function createAttachmentActionChip(params: Readonly<{
    onPickFile: () => void;
    onPickImage: () => void;
    disabled?: boolean;
}>): AgentInputExtraActionChip {
    const showChooser = Platform.OS === 'ios' || Platform.OS === 'android';

    return {
        key: 'attachments-add',
        controlId: 'attachments',
        labelPolicy: 'auto-hide',
        ...(showChooser ? {
            collapsedContentPopover: {
                title: t('common.attach'),
                label: t('common.attach'),
                icon: (tint: string) =>
                    normalizeNodeForView(<Ionicons name="attach-outline" size={16} color={tint} />),
                renderContent: ({ requestClose }) => (
                    <ActionListSection
                        actions={[
                            {
                                id: 'add-image',
                                testID: 'attachments-action-add-image',
                                label: t('common.addImage'),
                                onPress: () => {
                                    requestClose();
                                    params.onPickImage();
                                },
                            },
                            {
                                id: 'add-file',
                                testID: 'attachments-action-add-file',
                                label: t('common.addFile'),
                                onPress: () => {
                                    requestClose();
                                    params.onPickFile();
                                },
                            },
                        ]}
                    />
                ),
                maxWidthCap: 360,
                maxHeightCap: 260,
                scrollEnabled: false,
            },
        } : {
            collapsedAction: ({ tint, dismiss, blurInput }) => ({
                id: 'attachments',
                label: t('common.attach'),
                icon: normalizeNodeForView(<Ionicons name="attach-outline" size={16} color={tint} />),
                onPress: () => {
                    blurInput();
                    params.onPickFile();
                    dismiss();
                },
            }),
        }),
        render: (ctx: AgentInputExtraActionChipRenderContext) => (
            <Pressable
                ref={ctx.chipAnchorRef}
                testID="agent-input-attachments-chip"
                onPress={() => {
                    if (showChooser) {
                        ctx.toggleCollapsedPopover?.('attachments-add');
                    } else {
                        params.onPickFile();
                    }
                }}
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
