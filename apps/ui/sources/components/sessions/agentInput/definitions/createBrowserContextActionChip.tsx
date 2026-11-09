import * as React from 'react';
import { View } from 'react-native';

import type {
    BrowserContextAttachmentV1,
} from '@happier-dev/protocol/browser/context/v1';

import type {
    AgentInputExtraActionPresentation,
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
import { getBrowserContextActionChipPlacement } from './agentInputActionChipPlacements';
export { getBrowserContextActionChipPlacement } from './agentInputActionChipPlacements';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_OPTION_ICON_SIZE_PX, AGENT_INPUT_MENU_ICON_SIZE_PX } from './agentInputChipIconMetrics';
import { AgentInputRailChip } from '@/components/sessions/agentInput/definitions/agentInputChipRowReach';

function resolveContextTitle(item: BrowserContextState['itemsById'][string] | undefined): string {
    if (item?.kind === 'browserAnnotation') {
        if (item.pageTitle) return item.pageTitle;
        if (item.pageUrl) {
            try {
                const origin = new URL(item.pageUrl).origin;
                if (origin !== 'null') return origin;
            } catch {
                // A missing or malformed page address has no presentable origin.
            }
        }
        return t('browserContext.composer.untitledPage');
    }
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

    const item = params.itemsById[attachment.contextId];
    const title = resolveContextTitle(item);
    const stale = attachment.state === 'navigationStale' || attachment.requiresReconfirmBeforeSend;
    if (item?.kind === 'browserAnnotation') {
        const elements = attachment.structuredBlock?.elements ?? [];
        // One element is named ("Checkout · TotalRow"); several, or one without a name, are counted.
        const only = elements.length === 1 ? elements[0] : undefined;
        const element = only?.componentName ?? only?.accessibleName;
        if (element) {
            const named = `${title} · ${element}`;
            return stale ? t('browserContext.composer.attachedPageStale', { title: named }) : named;
        }
        const count = String(elements.length);
        return stale
            ? t('browserContext.composer.attachedAnnotationStale', { title, count })
            : t('browserContext.composer.attachedAnnotation', { title, count });
    }
    if (stale) {
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
}>): AgentInputExtraActionPresentation {
    const attachments = selectBrowserContextComposerAttachments(params.state);
    const disabled = Boolean(params.disabledReason) || !params.onAttachPageReference;
    const label = disabled
        ? t('browserContext.composer.contextUnavailable')
        : t('browserContext.composer.attachPageReference');
    // Honours its own size argument: this helper feeds three surfaces (badge, collapsed menu, and the
    // chip itself), which do not share a size.
    const icon = (tint: string, size: number = AGENT_INPUT_MENU_ICON_SIZE_PX) =>
        normalizeNodeForView(<Icon name="globe" size={size} color={tint} />);

    const attachmentRowItem = attachments.length > 0 ? {
        kind: 'badge' as const,
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
        icon: (tint: string) => icon(tint, AGENT_INPUT_CHIP_OPTION_ICON_SIZE_PX),
        onRemove: params.onRemoveAttachment ? () => {
            for (const attachment of attachments) {
                params.onRemoveAttachment?.(attachment.attachmentId);
            }
        } : undefined,
        removeAccessibilityLabel: t('browserContext.composer.removeAttachedContext'),
    } : undefined;

    const actionChip: AgentInputExtraActionChip = {
        key: 'browser-context',
        controlId: 'shortcuts',
        placement: getBrowserContextActionChipPlacement(),
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
            <AgentInputRailChip
                ref={ctx.chipAnchorRef}
                testID="agent-input-browser-context-chip"
                disabled={disabled}
                onPress={() => runIfEnabled({
                    disabled,
                    onAttachPageReference: params.onAttachPageReference,
                })}
                style={ctx.chipStyle}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {icon(ctx.iconColor, AGENT_INPUT_CHIP_ICON_SIZE_PX)}
                    {ctx.showLabel ? (
                        <Text numberOfLines={1} style={ctx.textStyle}>
                            {label}
                        </Text>
                    ) : null}
                </View>
            </AgentInputRailChip>
        ),
    };

    return { actionChip, attachmentRowItem };
}
