import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { createReviewCommentsToggleActionChip } from '@/components/sessions/agentInput/definitions/createReviewCommentsToggleActionChip';
import { createAttachmentActionChip } from '@/components/sessions/agentInput/sessionActions/createAttachmentActionChip';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { openAttachmentFilePickerFiles, openAttachmentFilePickerImages } from '@/components/sessions/attachments/attachmentFilePickerActions';
import { attachRecoverableAttachmentDrafts } from '@/components/sessions/attachments/recoverableAttachmentDrafts';
import { useWorkspaceReviewCommentDraftHandlers } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers';
import { useAttachmentDraftManager } from '@/components/sessions/attachments/useAttachmentDraftManager';
import { useAttachmentsUploadConfig } from '@/components/sessions/attachments/useAttachmentsUploadConfig';
import { formatAttachmentsBlock, uploadAttachmentDraftsToSession } from '@/components/sessions/attachments/uploadAttachmentDraftsToSession';
import { blurActiveElementOnWeb, deferOnWeb } from '@/utils/platform/deferOnWeb';
import { followUpSpawnedSessionWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession';
import type { CreatedSessionFollowUpContext } from '@/components/sessions/new/hooks/useCreateNewSession';
import { buildReviewCommentsOutboundMessage } from '@/sync/domains/input/reviewComments/buildReviewCommentsOutboundMessage';
import { useWorkspaceReviewCommentsDrafts } from '@/sync/domains/state/storage';
import { buildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

import {
    clearNewSessionAttachmentDrafts,
    readNewSessionAttachmentDrafts,
    writeNewSessionAttachmentDrafts,
} from './newSessionAttachmentDraftStore';

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
    const normalizedSelectedMachineId = React.useMemo(() => String(params.selectedMachineId ?? '').trim(), [params.selectedMachineId]);
    const normalizedSelectedPath = React.useMemo(() => String(params.selectedPath ?? '').trim(), [params.selectedPath]);
    const normalizedTargetServerId = React.useMemo(() => String(params.targetServerId ?? '').trim(), [params.targetServerId]);
    const discoverableReviewCommentsScope = React.useMemo<WorkspaceScopeBase | null>(() => {
        if (normalizedTargetServerId.length === 0 || normalizedSelectedMachineId.length === 0 || normalizedSelectedPath.length === 0) {
            return null;
        }
        return {
            serverId: normalizedTargetServerId,
            machineId: normalizedSelectedMachineId,
            rootPath: normalizedSelectedPath,
        };
    }, [normalizedSelectedMachineId, normalizedSelectedPath, normalizedTargetServerId]);
    const discoverableReviewCommentDrafts = useWorkspaceReviewCommentsDrafts(discoverableReviewCommentsScope);
    const reviewDraftHandlers = useWorkspaceReviewCommentDraftHandlers(discoverableReviewCommentsScope);
    const discoverableReviewCommentsScopeKey = React.useMemo(() => {
        if (!discoverableReviewCommentsScope) return null;
        try {
            return buildWorkspaceCacheKey(discoverableReviewCommentsScope);
        } catch {
            return null;
        }
    }, [discoverableReviewCommentsScope]);
    const [disabledReviewCommentsScopeKey, setDisabledReviewCommentsScopeKey] = React.useState<string | null>(null);
    const hasDiscoverableReviewCommentDrafts = reviewCommentsFeatureEnabled && discoverableReviewCommentDrafts.length > 0;
    const reviewCommentsEnabledForCurrentPath = hasDiscoverableReviewCommentDrafts
        && discoverableReviewCommentsScopeKey !== disabledReviewCommentsScopeKey;
    const reviewCommentDrafts = reviewCommentsEnabledForCurrentPath ? discoverableReviewCommentDrafts : [];
    const hasReviewCommentDrafts = reviewCommentDrafts.length > 0;

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

    const clearReviewCommentsForFlow = React.useCallback(() => {
        reviewDraftHandlers.clearReviewCommentDrafts();
    }, [reviewDraftHandlers]);

    const toggleReviewCommentsForCurrentPath = React.useCallback(() => {
        if (!discoverableReviewCommentsScopeKey) return;
        setDisabledReviewCommentsScopeKey((current) => (
            current === discoverableReviewCommentsScopeKey
                ? null
                : discoverableReviewCommentsScopeKey
        ));
    }, [discoverableReviewCommentsScopeKey]);

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
            const reviewCommentsChip = createReviewCommentsToggleActionChip({
                reviewCommentDrafts: discoverableReviewCommentDrafts,
                enabled: reviewCommentsEnabledForCurrentPath,
                onToggle: toggleReviewCommentsForCurrentPath,
            });
            if (reviewCommentsChip) {
                chips.push(reviewCommentsChip);
            }
        }

        return [...chips, ...(params.baseActionChips ?? [])] as const;
    }, [
        attachmentsUploadsEnabled,
        discoverableReviewCommentDrafts,
        filePickerRef,
        hasDiscoverableReviewCommentDrafts,
        params.baseActionChips,
        params.isCreating,
        reviewCommentsEnabledForCurrentPath,
        toggleReviewCommentsForCurrentPath,
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
                        drafts: reviewCommentDrafts,
                        additionalMessage: attachmentsBlock
                            ? (trimmed.length > 0 ? `${trimmed}\n\n${attachmentsBlock}` : attachmentsBlock)
                            : trimmed,
                        displayTextSuffix: attachmentsBlock || null,
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
                    if (!hasAttachments) {
                        throw error;
                    }
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
        clearReviewCommentsForFlow,
        clearDraftsForFlow,
        drafts,
        getDraftsSnapshot,
        hasReviewCommentDrafts,
        params.handleCreateSession,
        params.selectedProfileId,
        params.sessionPrompt,
        params.targetServerId,
        reviewCommentDrafts,
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
