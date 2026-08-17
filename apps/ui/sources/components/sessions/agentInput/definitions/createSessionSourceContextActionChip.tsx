import * as React from 'react';
import { Pressable, View } from 'react-native';

import type {
    AgentInputExtraActionChip,
    AgentInputExtraActionChipRenderContext,
    AgentInputExtraActionPresentation,
} from '@/components/sessions/agentInput/agentInputContracts';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';

import {
    AGENT_INPUT_CHIP_ICON_SIZE_PX,
    AGENT_INPUT_CHIP_ICON_STYLE,
    AGENT_INPUT_CHIP_OPTION_ICON_SIZE_PX,
    AGENT_INPUT_MENU_ICON_SIZE_PX,
} from './agentInputChipIconMetrics';

export const SESSION_SOURCE_CONTEXT_CHIP_KEY = 'session-source-context';
export const SESSION_SOURCE_CONTEXT_CHIP_TEST_ID = 'agent-input-source-context-attachment-badge';

/**
 * The removable "continue from this Session" chip on the New Session composer.
 *
 * It reuses the review-comment attachment-row presentation, but it is NOT a
 * Session mention: a mention says "this Session is available to inspect", while
 * this says "create this Session as a continuation, with bounded Replay through
 * the cutoff". Removing it turns the draft back into an ordinary new Session and
 * touches nothing else the user configured.
 */
export function createSessionSourceContextActionChip(params: Readonly<{
    /** Display name of the source Session, or null when it is not hydrated here. */
    sourceSessionTitle: string | null;
    /** Whether the cutoff is an exact message rather than the whole conversation. */
    isMessageCutoff: boolean;
    /**
     * The selected target server is not the source Session's server. V1 requires
     * them to match, so the chip says so and submission stays blocked instead of
     * the recipe being dropped on the way out.
     */
    serverMismatch?: boolean;
    onRemove: () => void;
}>): AgentInputExtraActionPresentation {
    const sessionLabel = params.sourceSessionTitle ?? t('session.sourceContext.unknownSession');
    const label = t('session.sourceContext.chipLabel', { session: sessionLabel });
    const removeLabel = t('session.sourceContext.removeA11y');

    const openDetail = () => {
        Modal.alert(
            t('session.sourceContext.detailTitle'),
            params.serverMismatch === true
                ? t('session.sourceContext.serverMismatch')
                : params.isMessageCutoff
                    ? t('session.sourceContext.detailBodyAtMessage', { session: sessionLabel })
                    : t('session.sourceContext.detailBodyLatest', { session: sessionLabel }),
            [
                { text: t('session.sourceContext.keepAction'), style: 'cancel' },
                {
                    text: t('session.sourceContext.removeAction'),
                    style: 'destructive',
                    onPress: params.onRemove,
                },
            ],
        );
    };

    const attachmentRowItem = {
        kind: 'badge' as const,
        key: SESSION_SOURCE_CONTEXT_CHIP_KEY,
        label,
        testID: SESSION_SOURCE_CONTEXT_CHIP_TEST_ID,
        accessibilityLabel: params.serverMismatch === true
            ? `${label}. ${t('session.sourceContext.serverMismatch')}`
            : `${label}. ${t('session.sourceContext.carriedOver')}`,
        ...(params.serverMismatch === true
            ? {
                availability: 'invalid' as const,
                error: t('session.sourceContext.serverMismatch'),
            }
            : null),
        icon: (tint: string) => (
            <Icon name="git-branch" size={AGENT_INPUT_CHIP_OPTION_ICON_SIZE_PX} color={tint} />
        ),
        onPress: openDetail,
        onRemove: params.onRemove,
        removeAccessibilityLabel: removeLabel,
    };

    const actionChip: AgentInputExtraActionChip = {
        key: SESSION_SOURCE_CONTEXT_CHIP_KEY,
        collapsedAction: ({ tint, dismiss }) => ({
            id: SESSION_SOURCE_CONTEXT_CHIP_KEY,
            label,
            icon: <Icon name="git-branch" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />,
            onPress: () => {
                dismiss();
                openDetail();
            },
        }),
        render: (ctx: AgentInputExtraActionChipRenderContext) => (
            <Pressable
                testID="agent-input-source-context-chip"
                accessibilityRole="button"
                accessibilityLabel={label}
                onPress={openDetail}
                style={({ pressed }) => ctx.chipStyle(Boolean(pressed))}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Icon
                        name="git-branch"
                        size={AGENT_INPUT_CHIP_ICON_SIZE_PX}
                        color={ctx.iconColor}
                        style={AGENT_INPUT_CHIP_ICON_STYLE}
                    />
                    {ctx.showLabel ? <Text style={ctx.textStyle}>{label}</Text> : null}
                </View>
            </Pressable>
        ),
    };

    return { actionChip, attachmentRowItem };
}
