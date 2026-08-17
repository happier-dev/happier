import * as React from 'react';
import { Pressable, View, Platform } from 'react-native';

import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { t } from '@/text';
import { blurActiveElementOnWeb } from '@/utils/platform/deferOnWeb';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE, AGENT_INPUT_MENU_ICON_SIZE_PX } from '../definitions/agentInputChipIconMetrics';

const WEB_PICKER_DOUBLE_OPEN_COOLDOWN_MS = 500;

function buildAttachmentRootStep(params: Readonly<{
    onPickFile: () => void;
    onPickImage: () => void;
    onPasteImage?: () => void;
}>): SelectionListStep {
    return {
        id: 'attachments-add-root',
        title: '',
        sections: [
            {
                kind: 'static',
                id: 'attachments',
                options: [
                    ...(params.onPasteImage
                        ? [{
                            id: 'paste-image',
                            label: t('common.pasteImage'),
                            onSelect: () => params.onPasteImage?.(),
                        }]
                        : []),
                    {
                        id: 'add-image',
                        label: t('common.addImage'),
                        onSelect: () => params.onPickImage(),
                    },
                    {
                        id: 'add-file',
                        label: t('common.addFile'),
                        onSelect: () => params.onPickFile(),
                    },
                ],
            },
        ],
    };
}

export function createAttachmentActionChip(params: Readonly<{
    onPickFile: () => void;
    onPickImage: () => void;
    onPasteImage?: () => void;
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
            collapsedOptionsPopover: {
                presentation: 'list',
                title: '',
                label: t('common.attach'),
                icon: (tint: string) =>
                    normalizeNodeForView(<Icon name="paperclip" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
                rootStep: buildAttachmentRootStep({
                    onPickFile: params.onPickFile,
                    onPickImage: params.onPickImage,
                    onPasteImage: params.onPasteImage,
                }),
                onSelect: () => {
                    // List-mode option actions live on SelectionListOption.onSelect.
                },
                maxWidthCap: 360,
                maxHeightCap: 260,
            },
        } : {
            collapsedAction: ({ tint, dismiss, blurInput }) => ({
                id: 'attachments',
                label: t('common.attach'),
                icon: normalizeNodeForView(<Icon name="paperclip" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
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
                    {normalizeNodeForView(<Icon name="paperclip" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={ctx.iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
                    {ctx.showLabel ? <Text style={ctx.textStyle}>{t('common.attach')}</Text> : null}
                </View>
            </Pressable>
        ),
    };
}
