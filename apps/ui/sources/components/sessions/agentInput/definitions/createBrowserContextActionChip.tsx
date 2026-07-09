import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import type {
    BrowserContextAttachmentV1,
    BrowserContextItemV1,
} from '@happier-dev/protocol';

import type {
    AgentInputExtraActionChip,
    AgentInputExtraActionChipRenderContext,
} from '@/components/sessions/agentInput/agentInputContracts';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import {
    selectBrowserContextComposerAttachments,
    type BrowserContextState,
} from '@/sync/domains/browser/context';
import { t } from '@/text';

function resolveContextTitle(item: BrowserContextItemV1 | undefined): string {
    if (item?.kind !== 'browserPageReference') {
        return t('browserContext.composer.untitledPage');
    }

    return item?.title
        ?? item?.display?.title
        ?? item?.display?.addressLabel
        ?? item?.origin
        ?? item?.targetId
        ?? t('browserContext.composer.untitledPage');
}

function resolveBadgeLabel(params: Readonly<{
    attachments: readonly BrowserContextAttachmentV1[];
    itemsById: BrowserContextState['itemsById'];
}>): string {
    if (params.attachments.length > 1) {
        return t('browserContext.composer.attachedCount', {
            count: String(params.attachments.length),
        });
    }

    const attachment = params.attachments[0];
    if (!attachment) {
        return t('browserContext.composer.attachPageReference');
    }

    const title = resolveContextTitle(params.itemsById[attachment.contextId]);
    if (attachment.state === 'navigationStale' || attachment.requiresReconfirmBeforeSend) {
        return t('browserContext.composer.attachedPageStale', { title });
    }
    return t('browserContext.composer.attachedPage', { title });
}

function runIfEnabled(params: Readonly<{
    disabled: boolean;
    onAttachPageReference?: () => void;
}>): void {
    if (params.disabled) return;
    params.onAttachPageReference?.();
}

export function createBrowserContextActionChip(params: Readonly<{
    state: BrowserContextState;
    onAttachPageReference?: () => void;
    onRemoveAttachment?: (attachmentId: string) => void;
    disabledReason?: string | null;
}>): AgentInputExtraActionChip {
    const attachments = selectBrowserContextComposerAttachments(params.state);
    const disabled = Boolean(params.disabledReason) || !params.onAttachPageReference;
    const label = disabled
        ? t('browserContext.composer.contextUnavailable')
        : t('browserContext.composer.attachPageReference');
    const icon = (tint: string, size = 16) =>
        normalizeNodeForView(<Ionicons name="globe-outline" size={size} color={tint} />);

    return {
        key: 'browser-context',
        controlId: 'shortcuts',
        composerAttachmentBadge: attachments.length > 0 ? {
            key: 'browser-context',
            label: resolveBadgeLabel({
                attachments,
                itemsById: params.state.itemsById,
            }),
            testID: 'agent-input-browser-context-attachment-badge',
            accessibilityLabel: resolveBadgeLabel({
                attachments,
                itemsById: params.state.itemsById,
            }),
            icon: (tint) => icon(tint, 14),
            onRemove: params.onRemoveAttachment ? () => {
                for (const attachment of attachments) {
                    params.onRemoveAttachment?.(attachment.attachmentId);
                }
            } : undefined,
            removeAccessibilityLabel: t('browserContext.composer.removeAttachedContext'),
        } : undefined,
        collapsedAction: ({ tint, dismiss }) => ({
            id: 'browser-context',
            label,
            subtitle: disabled ? t('browserContext.composer.contextUnavailable') : undefined,
            disabled,
            icon: icon(tint),
            onPress: () => {
                if (disabled) return;
                dismiss();
                params.onAttachPageReference?.();
            },
        }),
        render: (ctx: AgentInputExtraActionChipRenderContext) => (
            <Pressable
                ref={ctx.chipAnchorRef}
                testID="agent-input-browser-context-chip"
                disabled={disabled}
                onPress={() => runIfEnabled({
                    disabled,
                    onAttachPageReference: params.onAttachPageReference,
                })}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={({ pressed }) => ctx.chipStyle(Boolean(pressed))}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {icon(ctx.iconColor, 16)}
                    {ctx.showLabel ? (
                        <Text numberOfLines={1} style={ctx.textStyle}>
                            {label}
                        </Text>
                    ) : null}
                </View>
            </Pressable>
        ),
    };
}
