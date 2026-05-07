import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';

import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import {
    buildReviewCommentsDisplayText,
    filterReviewCommentDraftsIncludedInPrompt,
} from '@/sync/domains/input/reviewComments/reviewCommentPrompt';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { t } from '@/text';

import { ReviewCommentsDraftsModal } from './ReviewCommentsDraftsModal';

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
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    onUpdateDraft: (draft: ReviewCommentDraft) => void;
    onDeleteDraft: (draftId: string) => void;
}>) {
    Modal.show({
        component: ReviewCommentsDraftsModal,
        props: {
            sessionId: params.sessionId,
            reviewCommentDrafts: params.reviewCommentDrafts,
            onUpdateDraft: params.onUpdateDraft,
            onDeleteDraft: params.onDeleteDraft,
        },
        chrome: {
            kind: 'card',
            title: buildReviewCommentsDisplayText({ drafts: params.reviewCommentDrafts }),
            subtitle: t('files.reviewComments.modalSubtitle'),
            layout: 'fill',
            dimensions: {
                size: 'lg',
                maxHeightRatio: 0.84,
            },
        },
    });
}

export function createReviewCommentsActionChip(params: Readonly<{
    sessionId?: string;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    onSetDraftIncluded: (draftId: string, included: boolean) => void;
    onUpdateDraft: (draft: ReviewCommentDraft) => void;
    onDeleteDraft: (draftId: string) => void;
    onClearDrafts: () => void;
}>): AgentInputExtraActionChip | undefined {
    const reviewCommentDraftCount = params.reviewCommentDrafts.length;
    if (reviewCommentDraftCount <= 0) return undefined;

    const includedReviewCommentDrafts = filterReviewCommentDraftsIncludedInPrompt(params.reviewCommentDrafts);
    const label = t('files.reviewComments.draftsChipLabel', { count: includedReviewCommentDrafts.length });
    const openDraftsAlert = () => {
        openReviewCommentsDraftsModal({
            sessionId: params.sessionId,
            reviewCommentDrafts: params.reviewCommentDrafts,
            onUpdateDraft: params.onUpdateDraft,
            onDeleteDraft: params.onDeleteDraft,
        });
    };

    return {
        key: 'review-comments',
        controlId: 'reviewComments',
        composerAttachmentBadge: includedReviewCommentDrafts.length > 0 ? {
            key: 'review-comments',
            label,
            testID: 'agent-input-review-comments-attachment-badge',
            accessibilityLabel: label,
            icon: (tint) => <Ionicons name="chatbox-ellipses-outline" size={14} color={tint} />,
            onPress: openDraftsAlert,
            onRemove: () => openReviewCommentsRemovePrompt({
                reviewCommentDrafts: params.reviewCommentDrafts,
                onSetDraftIncluded: params.onSetDraftIncluded,
                onClearDrafts: params.onClearDrafts,
            }),
            removeAccessibilityLabel: t('files.reviewComments.detachOrDiscardTitle'),
        } : undefined,
        collapsedAction: ({ tint, dismiss }) => ({
            id: 'review-comments',
            label,
            icon: <Ionicons name="chatbox-ellipses-outline" size={16} color={tint} />,
            onPress: () => {
                dismiss();
                openDraftsAlert();
            },
        }),
        render: (ctx: AgentInputExtraActionChipRenderContext) => (
            <Pressable
                onPress={openDraftsAlert}
                style={({ pressed }) => ctx.chipStyle(Boolean(pressed))}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="chatbox-ellipses-outline" size={14} color={ctx.iconColor} />
                    {ctx.showLabel ? (
                        <Text style={ctx.textStyle}>{label}</Text>
                    ) : null}
                </View>
            </Pressable>
        ),
    };
}
