import * as React from 'react';
import { Pressable, View, Platform } from 'react-native';

import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { t } from '@/text';
import { blurActiveElementOnWeb } from '@/utils/platform/deferOnWeb';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import type { ScreenCaptureAttachmentAction } from './screenCaptureAttachmentActions';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE, AGENT_INPUT_MENU_ICON_SIZE_PX } from '../definitions/agentInputChipIconMetrics';

const WEB_PICKER_DOUBLE_OPEN_COOLDOWN_MS = 500;

const SCREEN_CAPTURE_LABELS = {
    'capture-screen': 'screenCapture.attach.capture',
    'record-screen': 'screenCapture.attach.record',
    'attach-recent-capture': 'screenCapture.window.attachRecent',
} as const satisfies Record<ScreenCaptureAttachmentAction['id'], string>;

function buildAttachmentRootStep(params: Readonly<{
    onPickFile: () => void;
    onPickImage: () => void;
    onTakePhoto?: () => void;
    onPasteImage?: () => void;
    disabled?: boolean;
    imageInputDisabledReason?: string;
    screenCapture: readonly ScreenCaptureAttachmentAction[];
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
                            disabled: params.disabled || Boolean(params.imageInputDisabledReason),
                            subtitle: params.imageInputDisabledReason,
                            onSelect: () => { if (!params.imageInputDisabledReason) params.onPasteImage?.(); },
                        }]
                        : []),
                    {
                        id: 'add-image',
                        label: t('common.addImage'),
                        disabled: params.disabled || Boolean(params.imageInputDisabledReason),
                        subtitle: params.imageInputDisabledReason,
                        onSelect: () => { if (!params.imageInputDisabledReason) params.onPickImage(); },
                    },
                    ...(params.onTakePhoto ? [{
                        id: 'take-photo',
                        label: t('common.takePhoto'),
                        disabled: params.disabled || Boolean(params.imageInputDisabledReason),
                        subtitle: params.imageInputDisabledReason,
                        onSelect: () => { if (!params.disabled && !params.imageInputDisabledReason) params.onTakePhoto?.(); },
                    }] : []),
                    {
                        id: 'add-file',
                        label: t('common.addFile'),
                        disabled: params.disabled,
                        onSelect: () => params.onPickFile(),
                    },
                ],
            },
            ...(params.screenCapture.length > 0 ? [{
                kind: 'static' as const,
                id: 'screen-capture',
                options: params.screenCapture.map((action) => ({
                    id: action.id,
                    label: t(SCREEN_CAPTURE_LABELS[action.id]),
                    onSelect: () => { void action.run(); },
                })),
            }] : []),
        ],
    };
}

export function createAttachmentActionChip(params: Readonly<{
    onPickFile: () => void;
    onPickImage: () => void;
    onTakePhoto?: () => void;
    onPasteImage?: () => void;
    disabled?: boolean;
    disabledReason?: string;
    imageInputDisabledReason?: string;
    /** The desktop app's capture entries; a host without a screen to capture passes none. */
    screenCapture?: readonly ScreenCaptureAttachmentAction[];
}>): AgentInputExtraActionChip {
    const screenCapture = params.screenCapture ?? [];
    const mobile = Platform.OS === 'ios' || Platform.OS === 'android';
    const showChooser = mobile || screenCapture.length > 0;
    const disabled = params.disabled === true || Boolean(params.disabledReason);
    // Per-chip instance guard (avoid cross-screen/test interference from module-level state).
    let lastWebPickerOpenAtMs = 0;
    const runPickerOpenWithWebCooldown = (action: () => void) => {
        if (disabled) return;
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
        placement: { id: 'attachments', title: t('common.attach'), icon: 'paperclip', defaultPlacement: 'overflow' },
        labelPolicy: 'auto-hide',
        ...(showChooser && !params.disabledReason ? {
            collapsedOptionsPopover: {
                presentation: 'list',
                title: '',
                label: t('common.attach'),
                icon: (tint: string) =>
                    normalizeNodeForView(<Icon name="paperclip" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
                rootStep: buildAttachmentRootStep({
                    onPickFile: params.onPickFile,
                    onPickImage: params.onPickImage,
                    onTakePhoto: mobile ? params.onTakePhoto : undefined,
                    onPasteImage: params.onPasteImage,
                    disabled,
                    imageInputDisabledReason: params.imageInputDisabledReason,
                    screenCapture,
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
                disabled,
                subtitle: params.disabledReason,
                icon: normalizeNodeForView(<Icon name="paperclip" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
                onPress: () => {
                    if (disabled) return;
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
                accessibilityLabel={t('common.attach')}
                accessibilityHint={params.disabledReason}
                onPress={() => {
                    if (disabled) return;
                    if (showChooser) {
                        ctx.toggleCollapsedPopover?.('attachments-add');
                    } else {
                        runPickerOpenWithWebCooldown(params.onPickFile);
                    }
                }}
                disabled={disabled}
                style={({ pressed }) => ctx.chipStyle(Boolean(pressed))}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {normalizeNodeForView(<Icon name="paperclip" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={ctx.iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
                    <View style={{ flexShrink: 1 }}>
                        {ctx.showLabel ? <Text style={ctx.textStyle}>{t('common.attach')}</Text> : null}
                        {params.disabledReason ? <Text variant="meta" style={{ color: ctx.iconColor }}>{params.disabledReason}</Text> : null}
                    </View>
                </View>
            </Pressable>
        ),
    };
}
