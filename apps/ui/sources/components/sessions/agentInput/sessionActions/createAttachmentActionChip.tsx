import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, View, Platform } from 'react-native';

import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { Text } from '@/components/ui/text/Text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { t } from '@/text';
import { blurActiveElementOnWeb } from '@/utils/platform/deferOnWeb';

const WEB_PICKER_DOUBLE_OPEN_COOLDOWN_MS = 500;

export function createAttachmentActionChip(params: Readonly<{
    onPickFile: () => void;
    onPickImage: () => void;
    disabled?: boolean;
}>): AgentInputExtraActionChip {
    const showChooser = Platform.OS === 'ios' || Platform.OS === 'android';
    // Per-chip instance guard (avoid cross-screen/test interference from module-level state).
    let lastWebPickerOpenAtMs = 0;
    const runPickerOpenWithWebCooldown = (action: () => void) => {
        if (Platform.OS !== 'web') {
            action();
            return;
        }

        const now = Date.now();
        // If the system clock moves backwards (or tests use fake timers), don't let a future
        // `lastWebPickerOpenAtMs` value block picker opens indefinitely.
        if (now < lastWebPickerOpenAtMs) {
            lastWebPickerOpenAtMs = 0;
        }
        if (now - lastWebPickerOpenAtMs < WEB_PICKER_DOUBLE_OPEN_COOLDOWN_MS) return;
        lastWebPickerOpenAtMs = now;

        // When the OS file chooser closes, some browsers can dispatch a follow-up "press" (key/mouse)
        // to the previously focused element, which re-opens the picker immediately. Blurring and
        // applying a short cooldown makes the flow deterministic.
        blurActiveElementOnWeb();
        action();
    };

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
                    runPickerOpenWithWebCooldown(params.onPickFile);
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
                        runPickerOpenWithWebCooldown(params.onPickFile);
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
