import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { createReviewCommentsActionChip } from '@/components/sessions/agentInput/definitions/createReviewCommentsActionChip';
import { createAttachmentActionChip } from '@/components/sessions/agentInput/sessionActions/createAttachmentActionChip';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { openAttachmentFilePickerFiles, openAttachmentFilePickerImages } from '@/components/sessions/attachments/attachmentFilePickerActions';
import { attachRecoverableAttachmentDrafts } from '@/components/sessions/attachments/recoverableAttachmentDrafts';
import { useWorkspaceReviewCommentDraftHandlers } from '@/components/sessions/reviews/comments/useWorkspaceReviewCommentDraftHandlers';
import { useAttachmentDraftManager } from '@/components/sessions/attachments/useAttachmentDraftManager';
import { useAttachmentsUploadConfig } from '@/components/sessions/attachments/useAttachmentsUploadConfig';
import { formatAttachmentsBlock, uploadAttachmentDraftsToSession } from '@/components/sessions/attachments/uploadAttachmentDraftsToSession';
import { blurActiveElementOnWeb, deferOnWeb } from '@/utils/platform/deferOnWeb';
import { followUpSpawnedSessionWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession';
import type { CreatedSessionFollowUpContext } from '@/components/sessions/new/hooks/useCreateNewSession';
import { buildReviewCommentsOutboundMessage } from '@/sync/domains/input/reviewComments/buildReviewCommentsOutboundMessage';
import {
    filterReviewCommentDraftsIncludedInPrompt,
} from '@/sync/domains/input/reviewComments/reviewCommentPrompt';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { useWorkspaceReviewCommentsDrafts } from '@/sync/domains/state/storage';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

import {
    clearNewSessionAttachmentDrafts,
    readNewSessionAttachmentDrafts,
    writeNewSessionAttachmentDrafts,
} from './newSessionAttachmentDraftStore';
import { resolveNewSessionReviewCommentsScope } from './resolveNewSessionReviewCommentsScope';

type HandleCreateSession = (
    opts?: Readonly<{
        initialMessage?: 'send' | 'skip';
        afterCreated?: (context: CreatedSessionFollowUpContext) => void | Promise<void>;
    }>,
) => void;

export function useNewSessionAttachmentsController(params: Readonly<{
    flowId?: string | null;
    isCreating: boolean;
    sessionPrompt: string;
    handleCreateSession: HandleCreateSession;
    selectedProfileId: string | null;
    targetServerId?: string | null;
    selectedMachineId?: string | null;
    selectedMachineHomeDir?: string | null;
    selectedPath?: string | null;
    baseActionChips?: readonly AgentInputExtraActionChip[];
}>): Readonly<{
    attachmentsUploadsEnabled: boolean;
    filePickerRef: ReturnType<typeof useAttachmentDraftManager>['filePickerRef'];
    drafts: ReturnType<typeof useAttachmentDraftManager>['drafts'];
    hasSendableAttachments: boolean;
    agentInputAttachments: ReturnType<typeof useAttachmentDraftManager>['agentInputAttachments'];
    addWebFiles: ReturnType<typeof useAttachmentDraftManager>['addWebFiles'];
    addPickedAttachments: ReturnType<typeof useAttachmentDraftManager>['addPickedAttachments'];
    extraActionChips: readonly AgentInputExtraActionChip[];
    handleSend: () => void;
}> {
    const attachmentsUploadsEnabled = useFeatureEnabled('attachments.uploads');
    const reviewCommentsFeatureEnabled = useFeatureEnabled('files.reviewComments');
    const attachmentsUploadConfig = useAttachmentsUploadConfig();
    const normalizedFlowId = React.useMemo(() => {
        if (typeof params.flowId !== 'string') return null;
        const trimmed = params.flowId.trim();
        return trimmed.length > 0 ? trimmed : null;
    }, [params.flowId]);
    const initialDraftsRef = React.useRef<readonly AttachmentDraft[]>(
        normalizedFlowId ? readNewSessionAttachmentDrafts(normalizedFlowId) : [],
    );

    const attachmentDraftManager = useAttachmentDraftManager({
        enabled: attachmentsUploadsEnabled,
        maxFileBytes: attachmentsUploadConfig.maxFileBytes,
        initialDrafts: initialDraftsRef.current,
    });
    const {
        filePickerRef,
        drafts,
        hasSendableAttachments,
        agentInputAttachments,
        addWebFiles,
        addPickedAttachments,
        applyDraftPatch,
        clearDrafts,
        getDraftsSnapshot,
    } = attachmentDraftManager;
    const discoverableReviewCommentsScope = React.useMemo<WorkspaceScopeBase | null>(() => {
        return resolveNewSessionReviewCommentsScope({
            targetServerId: params.targetServerId,
            selectedMachineId: params.selectedMachineId,
            selectedMachineHomeDir: params.selectedMachineHomeDir,
            selectedPath: params.selectedPath,
        });
    }, [params.selectedMachineHomeDir, params.selectedMachineId, params.selectedPath, params.targetServerId]);
    const discoverableReviewCommentDrafts = useWorkspaceReviewCommentsDrafts(discoverableReviewCommentsScope);
    const reviewDraftHandlers = useWorkspaceReviewCommentDraftHandlers(discoverableReviewCommentsScope);
    const hasDiscoverableReviewCommentDrafts = reviewCommentsFeatureEnabled && discoverableReviewCommentDrafts.length > 0;
    const includedReviewCommentDrafts = React.useMemo(
        () => filterReviewCommentDraftsIncludedInPrompt(discoverableReviewCommentDrafts),
        [discoverableReviewCommentDrafts],
    );
    const hasReviewCommentDrafts = hasDiscoverableReviewCommentDrafts && includedReviewCommentDrafts.length > 0;

    React.useEffect(() => {
        if (!normalizedFlowId) return;
        if (!attachmentsUploadsEnabled) {
            clearNewSessionAttachmentDrafts(normalizedFlowId);
            return;
        }
        writeNewSessionAttachmentDrafts(normalizedFlowId, drafts);
    }, [attachmentsUploadsEnabled, drafts, normalizedFlowId]);

    const clearDraftsForFlow = React.useCallback(() => {
        clearDrafts();
        if (normalizedFlowId) {
            clearNewSessionAttachmentDrafts(normalizedFlowId);
        }
    }, [clearDrafts, normalizedFlowId]);

    const setReviewCommentDraftIncluded = React.useCallback((draftId: string, included: boolean) => {
        const draft = discoverableReviewCommentDrafts.find((candidate) => candidate.id === draftId);
        if (!draft) return;
        reviewDraftHandlers.onUpsertReviewCommentDraft({
            ...draft,
            includeInPrompt: included,
        });
    }, [discoverableReviewCommentDrafts, reviewDraftHandlers]);

    const updateReviewCommentDraft = React.useCallback((draft: ReviewCommentDraft) => {
        reviewDraftHandlers.onUpsertReviewCommentDraft(draft);
    }, [reviewDraftHandlers]);

    const deleteReviewCommentDraft = React.useCallback((draftId: string) => {
        reviewDraftHandlers.onDeleteReviewCommentDraft(draftId);
    }, [reviewDraftHandlers]);

    const clearReviewCommentsForFlow = React.useCallback(() => {
        for (const draft of includedReviewCommentDrafts) {
            reviewDraftHandlers.onDeleteReviewCommentDraft(draft.id);
        }
    }, [includedReviewCommentDrafts, reviewDraftHandlers]);

    const discardReviewCommentDrafts = React.useCallback(() => {
        reviewDraftHandlers.clearReviewCommentDrafts();
    }, [reviewDraftHandlers]);

    const extraActionChips = React.useMemo(() => {
        const chips: AgentInputExtraActionChip[] = [];

        if (attachmentsUploadsEnabled) {
            chips.push(createAttachmentActionChip({
                onPickFile: () => openAttachmentFilePickerFiles(filePickerRef.current),
                onPickImage: () => openAttachmentFilePickerImages(filePickerRef.current),
                disabled: params.isCreating,
            }));
        }

        if (hasDiscoverableReviewCommentDrafts) {
            const reviewCommentsChip = createReviewCommentsActionChip({
                reviewCommentDrafts: discoverableReviewCommentDrafts,
                onSetDraftIncluded: setReviewCommentDraftIncluded,
                onUpdateDraft: updateReviewCommentDraft,
                onDeleteDraft: deleteReviewCommentDraft,
                onClearDrafts: discardReviewCommentDrafts,
            });
            if (reviewCommentsChip) {
                chips.push(reviewCommentsChip);
            }
        }

        return [...chips, ...(params.baseActionChips ?? [])] as const;
    }, [
        attachmentsUploadsEnabled,
        deleteReviewCommentDraft,
        discoverableReviewCommentDrafts,
        discardReviewCommentDrafts,
        filePickerRef,
        hasDiscoverableReviewCommentDrafts,
        params.baseActionChips,
        params.isCreating,
        setReviewCommentDraftIncluded,
        updateReviewCommentDraft,
    ]);

    const handleSend = React.useCallback(() => {
        const submit = (opts?: Readonly<{ initialMessage?: 'send' | 'skip'; afterCreated?: (context: CreatedSessionFollowUpContext) => void | Promise<void> }>) => {
            blurActiveElementOnWeb();
            deferOnWeb(() => {
                params.handleCreateSession(opts);
            });
        };

        const hasAttachments = attachmentsUploadsEnabled && drafts.length > 0;
        if (!hasAttachments && !hasReviewCommentDrafts) {
            submit();
            return;
        }

        const initialPrompt = String(params.sessionPrompt ?? '');
        submit({
            initialMessage: 'skip',
            afterCreated: async ({ sessionId, effectiveSpawnServerId }) => {
                const trimmed = initialPrompt.trim();
                let attachmentsBlock = '';
                let attachmentsMetaOverrides: Record<string, unknown> | undefined;

                if (hasAttachments) {
                    const { uploaded } = await uploadAttachmentDraftsToSession({
                        sessionId,
                        drafts,
                        config: attachmentsUploadConfig,
                        applyDraftPatch,
                    });
                    attachmentsBlock = formatAttachmentsBlock(uploaded);
                    attachmentsMetaOverrides = {
                        happier: {
                            kind: 'attachments.v1',
                            payload: {
                                attachments: uploaded.map((attachment) => ({
                                    name: attachment.name,
                                    path: attachment.path,
                                    mimeType: attachment.mimeType,
                                    sizeBytes: attachment.sizeBytes,
                                    sha256: attachment.sha256,
                                })),
                            },
                        },
                    };
                }

                const outbound = hasReviewCommentDrafts
                    ? buildReviewCommentsOutboundMessage({
                        sessionId,
                        drafts: discoverableReviewCommentDrafts,
                        additionalMessage: attachmentsBlock
                            ? (trimmed.length > 0 ? `${trimmed}\n\n${attachmentsBlock}` : attachmentsBlock)
                            : trimmed,
                        displayTextSuffix: attachmentsBlock || null,
                        metaOverrides: attachmentsMetaOverrides,
                    })
                    : {
                        text: trimmed.length > 0 ? `${trimmed}\n\n${attachmentsBlock}` : attachmentsBlock,
                        displayText: trimmed || undefined,
                        metaOverrides: attachmentsMetaOverrides,
                    };

                try {
                    await followUpSpawnedSessionWithServerScope({
                        sessionId,
                        targetServerId: effectiveSpawnServerId ?? params.targetServerId,
                        initialMessageText: outbound.text,
                        displayText: outbound.displayText,
                        profileId: params.selectedProfileId,
                        metaOverrides: outbound.metaOverrides,
                    });
                    if (hasAttachments) {
                        clearDraftsForFlow();
                    }
                    if (hasReviewCommentDrafts) {
                        clearReviewCommentsForFlow();
                    }
                } catch (error) {
                    throw attachRecoverableAttachmentDrafts(error, {
                        draftText: outbound.text,
                        displayText: outbound.displayText,
                        profileId: params.selectedProfileId,
                        metaOverrides: outbound.metaOverrides,
                        attachmentDrafts: getDraftsSnapshot(),
                    });
                }
            },
        });
    }, [
        applyDraftPatch,
        attachmentsUploadConfig,
        attachmentsUploadsEnabled,
        clearDraftsForFlow,
        clearReviewCommentsForFlow,
        discoverableReviewCommentDrafts,
        drafts,
        getDraftsSnapshot,
        hasReviewCommentDrafts,
        params.handleCreateSession,
        params.selectedProfileId,
        params.sessionPrompt,
        params.targetServerId,
    ]);

    return {
        attachmentsUploadsEnabled,
        filePickerRef,
        drafts,
        hasSendableAttachments,
        agentInputAttachments,
        addWebFiles,
        addPickedAttachments,
        extraActionChips,
        handleSend,
    };
}
