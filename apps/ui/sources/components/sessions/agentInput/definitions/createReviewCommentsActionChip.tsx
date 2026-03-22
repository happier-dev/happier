import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';

import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { buildReviewCommentsDisplayText } from '@/sync/domains/input/reviewComments/reviewCommentPrompt';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { t } from '@/text';

function openReviewCommentsDraftsAlert(params: Readonly<{
    sessionId: string;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
}>) {
    const preview = params.reviewCommentDrafts
        .slice(0, 12)
        .map((draft, idx) => `${idx + 1}) ${draft.filePath}: ${draft.body}`)
        .join('\n');

    Modal.alert(
        buildReviewCommentsDisplayText({ drafts: params.reviewCommentDrafts }),
        preview.length > 0 ? preview : undefined,
        [
            {
                text: t('common.cancel'),
                style: 'cancel',
            },
            {
                text: t('common.discard'),
                style: 'destructive',
                onPress: () => storage.getState().clearSessionReviewCommentDrafts(params.sessionId),
            },
        ],
    );
}

export function createReviewCommentsActionChip(params: Readonly<{
    sessionId: string;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
}>): AgentInputExtraActionChip | undefined {
    const reviewCommentDraftCount = params.reviewCommentDrafts.length;
    if (reviewCommentDraftCount <= 0) return undefined;

    const label = t('files.reviewComments.draftsChipLabel', { count: reviewCommentDraftCount });
    const openDraftsAlert = () => {
        openReviewCommentsDraftsAlert({
            sessionId: params.sessionId,
            reviewCommentDrafts: params.reviewCommentDrafts,
        });
    };

    return {
        key: 'review-comments',
        controlId: 'reviewComments',
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
