import * as React from 'react';
import { Pressable, View } from 'react-native';

import type {
    AgentInputExtraActionChip,
    AgentInputExtraActionChipRenderContext,
    AgentInputExtraActionPresentation,
} from '@/components/sessions/agentInput/agentInputContracts';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import {
    buildReviewCommentsDisplayText,
    filterReviewCommentDraftsIncludedInPrompt,
} from '@/sync/domains/input/reviewComments/reviewCommentPrompt';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';

import { ReviewCommentsDraftsModal } from './ReviewCommentsDraftsModal';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE, AGENT_INPUT_CHIP_OPTION_ICON_SIZE_PX, AGENT_INPUT_MENU_ICON_SIZE_PX } from './agentInputChipIconMetrics';

function detachReviewCommentsFromPrompt(params: Readonly<{
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    onSetDraftIncluded: (draftId: string, included: boolean) => void;
}>) {
    for (const draft of params.reviewCommentDrafts) {
        params.onSetDraftIncluded(draft.id, false);
    }
}

function openReviewCommentsRemovePrompt(params: Readonly<{
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    onSetDraftIncluded: (draftId: string, included: boolean) => void;
    onClearDrafts: () => void;
}>) {
    Modal.alert(
        t('files.reviewComments.detachOrDiscardTitle'),
        t('files.reviewComments.detachOrDiscardBody'),
        [
            {
                text: t('common.cancel'),
                style: 'cancel',
            },
            {
                text: t('files.reviewComments.detachFromPrompt'),
                onPress: () => detachReviewCommentsFromPrompt(params),
            },
            {
                text: t('common.discard'),
                style: 'destructive',
                onPress: params.onClearDrafts,
            },
        ],
    );
}

function openReviewCommentsDraftsModal(params: Readonly<{
    sessionId?: string;
    reviewScope?: WorkspaceScopeBase | null;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    onUpdateDraft: (draft: ReviewCommentDraft) => void;
    onDeleteDraft: (draftId: string) => void;
}>) {
    Modal.show({
        component: ReviewCommentsDraftsModal,
        props: {
            sessionId: params.sessionId,
            reviewScope: params.reviewScope ?? null,
            reviewCommentDrafts: params.reviewCommentDrafts,
            onUpdateDraft: params.onUpdateDraft,
            onDeleteDraft: params.onDeleteDraft,
        },
        chrome: {
            kind: 'card',
            title: buildReviewCommentsDisplayText({ drafts: params.reviewCommentDrafts }),
            subtitle: t('files.reviewComments.modalSubtitle'),
            dimensions: {
                size: 'lg',
                maxHeightRatio: 0.84,
            },
        },
    });
}

export function createReviewCommentsActionChip(params: Readonly<{
    sessionId?: string;
    reviewScope?: WorkspaceScopeBase | null;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    onSetDraftIncluded: (draftId: string, included: boolean) => void;
    onUpdateDraft: (draft: ReviewCommentDraft) => void;
    onDeleteDraft: (draftId: string) => void;
    onClearDrafts: () => void;
}>): AgentInputExtraActionPresentation | undefined {
    const reviewCommentDraftCount = params.reviewCommentDrafts.length;
    if (reviewCommentDraftCount <= 0) return undefined;

    const includedReviewCommentDrafts = filterReviewCommentDraftsIncludedInPrompt(params.reviewCommentDrafts);
    const label = t('files.reviewComments.draftsChipLabel', { count: includedReviewCommentDrafts.length });
    const openDraftsModal = () => {
        openReviewCommentsDraftsModal({
            sessionId: params.sessionId,
            reviewScope: params.reviewScope ?? null,
            reviewCommentDrafts: params.reviewCommentDrafts,
            onUpdateDraft: params.onUpdateDraft,
            onDeleteDraft: params.onDeleteDraft,
        });
    };

    const attachmentRowItem = includedReviewCommentDrafts.length > 0 ? {
        kind: 'badge' as const,
        key: 'review-comments',
        label,
        testID: 'agent-input-review-comments-attachment-badge',
        accessibilityLabel: label,
        icon: (tint: string) => <Icon name="chat-dots" size={AGENT_INPUT_CHIP_OPTION_ICON_SIZE_PX} color={tint} />,
        onPress: openDraftsModal,
        onRemove: () => openReviewCommentsRemovePrompt({
            reviewCommentDrafts: params.reviewCommentDrafts,
            onSetDraftIncluded: params.onSetDraftIncluded,
            onClearDrafts: params.onClearDrafts,
        }),
        removeAccessibilityLabel: t('files.reviewComments.detachOrDiscardTitle'),
    } : undefined;

    const actionChip: AgentInputExtraActionChip = {
        key: 'review-comments',
        controlId: 'reviewComments',
        collapsedAction: ({ tint, dismiss }) => ({
            id: 'review-comments',
            label,
            icon: <Icon name="chat-dots" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />,
            onPress: () => {
                dismiss();
                openDraftsModal();
            },
        }),
        render: (ctx: AgentInputExtraActionChipRenderContext) => (
            <Pressable
                onPress={openDraftsModal}
                style={({ pressed }) => ctx.chipStyle(Boolean(pressed))}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Icon name="chat-dots" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={ctx.iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />
                    {ctx.showLabel ? (
                        <Text style={ctx.textStyle}>{label}</Text>
                    ) : null}
                </View>
            </Pressable>
        ),
    };

    return { actionChip, attachmentRowItem };
}
