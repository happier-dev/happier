import { getReviewCommentsActionChipPlacement } from './agentInputActionChipPlacements';
import * as React from 'react';
import type { WorkspaceFileOpen } from '@/components/workspaces/files/useWorkspaceFileOpener';
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
import { formatReviewCommentAnchorLines } from '@/sync/domains/input/reviewComments/reviewCommentPresentation';
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
    openFile?: WorkspaceFileOpen;
    reviewScope?: WorkspaceScopeBase | null;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    onUpdateDraft: (draft: ReviewCommentDraft) => void;
    onDeleteDraft: (draftId: string) => void;
}>) {
    Modal.show({
        component: ReviewCommentsDraftsModal,
        props: {
            sessionId: params.sessionId,
            openFile: params.openFile,
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

/**
 * What one selection riding with the message is called (lab Ap: "SettingsModal.tsx 19–24"): the file's
 * name and its lines, so the person sees what goes with the question. Several stay a count.
 */
function describeSingleReviewCommentDraft(draft: ReviewCommentDraft): Readonly<{ name: string; lines: string | null }> {
    const name = draft.filePath.split(/[\\/]/).filter(Boolean).pop() ?? draft.filePath;
    return { name, lines: formatReviewCommentAnchorLines(draft) };
}

export function createReviewCommentsActionChip(params: Readonly<{
    sessionId?: string;
    openFile?: WorkspaceFileOpen;
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
    const single = includedReviewCommentDrafts.length === 1 ? describeSingleReviewCommentDraft(includedReviewCommentDrafts[0]!) : null;
    const label = single
        ? (single.lines ? `${single.name} ${single.lines}` : single.name)
        : t('files.reviewComments.draftsChipLabel', { count: includedReviewCommentDrafts.length });
    const openDraftsModal = () => {
        openReviewCommentsDraftsModal({
            sessionId: params.sessionId,
            openFile: params.openFile,
            reviewScope: params.reviewScope ?? null,
            reviewCommentDrafts: params.reviewCommentDrafts,
            onUpdateDraft: params.onUpdateDraft,
            onDeleteDraft: params.onDeleteDraft,
        });
    };

    const attachmentRowItem = includedReviewCommentDrafts.length > 0 ? {
        kind: 'badge' as const,
        key: 'review-comments',
        label: single ? single.name : label,
        ...(single?.lines ? { detail: single.lines } : {}),
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
        placement: { ...getReviewCommentsActionChipPlacement(), pending: includedReviewCommentDrafts.length > 0 },
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
