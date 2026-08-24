import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { createReviewCommentsActionChip } from '@/components/sessions/agentInput/definitions/createReviewCommentsActionChip';
import { createAttachmentActionChip } from '@/components/sessions/agentInput/sessionActions/createAttachmentActionChip';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputSendOptions } from '@/components/sessions/agentInput/agentInputSendOptions';
import { mergeMessageMetaOverrides } from '@/components/sessions/agentInput/structuredInputMentions';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { openAttachmentFilePickerFiles, openAttachmentFilePickerImages } from '@/components/sessions/attachments/attachmentFilePickerActions';
import { attachRecoverableAttachmentDrafts } from '@/components/sessions/attachments/recoverableAttachmentDrafts';
import { resolveReviewCommentDraftAnchorsForPrompt } from '@/components/sessions/reviews/comments/resolveReviewCommentDraftAnchorsForPrompt';
import { useWorkspaceReviewCommentDraftHandlers } from '@/components/sessions/reviews/comments/useWorkspaceReviewCommentDraftHandlers';
import { useAttachmentDraftManager } from '@/components/sessions/attachments/useAttachmentDraftManager';
import { useAttachmentsUploadConfig } from '@/components/sessions/attachments/useAttachmentsUploadConfig';
import { formatAttachmentsBlock, uploadAttachmentDraftsToSession } from '@/components/sessions/attachments/uploadAttachmentDraftsToSession';
import { blurActiveElementOnWeb, deferOnWeb } from '@/utils/platform/deferOnWeb';
import { nativeReadClipboardImageAttachment } from '@/utils/files/nativeClipboardImageAttachment';
import { Modal } from '@/modal';
import { t } from '@/text';
import { followUpSpawnedSessionWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession';
import type { HandleCreateSessionOptions } from '@/components/sessions/new/hooks/useCreateNewSession';
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
import type { NewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';

type NewSessionAgentInputSendOptions = AgentInputSendOptions;

type HandleCreateSession = (opts?: HandleCreateSessionOptions) => void;

export function useNewSessionAttachmentsController(params: Readonly<{
    flowId?: string | null;
    isCreating: boolean;
    promptStore: NewSessionPromptStore;
    handleCreateSession: HandleCreateSession;
    selectedProfileId: string | null;
    targetServerId?: string | null;
    selectedMachineId?: string | null;
    selectedMachineHomeDir?: string | null;
    selectedPath?: string | null;
    baseActionChips?: readonly AgentInputExtraActionChip[];
    resumePersistedLaunchKey?: string | null;
}>): Readonly<{
    attachmentsUploadsEnabled: boolean;
    filePickerRef: ReturnType<typeof useAttachmentDraftManager>['filePickerRef'];
    drafts: ReturnType<typeof useAttachmentDraftManager>['drafts'];
    hasSendableAttachments: boolean;
    agentInputAttachments: ReturnType<typeof useAttachmentDraftManager>['agentInputAttachments'];
    addWebFiles: ReturnType<typeof useAttachmentDraftManager>['addWebFiles'];
    addPickedAttachments: ReturnType<typeof useAttachmentDraftManager>['addPickedAttachments'];
    extraActionChips: readonly AgentInputExtraActionChip[];
    handleSend: (options?: NewSessionAgentInputSendOptions) => void;
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
    const draftsSnapshotRef = React.useRef<readonly AttachmentDraft[]>(initialDraftsRef.current);

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
        draftsSnapshotRef.current = drafts;
        if (!normalizedFlowId) return;
        writeNewSessionAttachmentDrafts(normalizedFlowId, drafts);
    }, [drafts, normalizedFlowId]);

    const applyNewSessionDraftPatch = React.useCallback((
        id: string,
        patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>,
    ) => {
        applyDraftPatch(id, patch);
        const nextDrafts = draftsSnapshotRef.current.map((draft) => (
            draft.id === id ? ({ ...draft, ...patch } as AttachmentDraft) : draft
        ));
        draftsSnapshotRef.current = nextDrafts;
        if (normalizedFlowId) {
            writeNewSessionAttachmentDrafts(normalizedFlowId, nextDrafts);
        }
    }, [applyDraftPatch, normalizedFlowId]);

    const clearDraftsForFlow = React.useCallback(() => {
        draftsSnapshotRef.current = [];
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

    const pasteAttachmentImage = React.useCallback(() => {
        void (async () => {
            try {
                const picked = await nativeReadClipboardImageAttachment();
                if (picked.length === 0) {
                    Modal.alert(t('attachments.alerts.noClipboardImageTitle'), t('attachments.alerts.noClipboardImageBody'));
                    return;
                }
                addPickedAttachments(picked);
            } catch {
                Modal.alert(t('attachments.alerts.noClipboardImageTitle'), t('attachments.alerts.noClipboardImageBody'));
            }
        })();
    }, [addPickedAttachments]);

    const extraActionChips = React.useMemo(() => {
        const chips: AgentInputExtraActionChip[] = [];

        if (attachmentsUploadsEnabled) {
            chips.push(createAttachmentActionChip({
                onPickFile: () => openAttachmentFilePickerFiles(filePickerRef.current),
                onPickImage: () => openAttachmentFilePickerImages(filePickerRef.current),
                onPasteImage: pasteAttachmentImage,
                disabled: params.isCreating,
            }));
        }

        if (hasDiscoverableReviewCommentDrafts) {
            const reviewCommentsChip = createReviewCommentsActionChip({
                reviewScope: discoverableReviewCommentsScope,
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
        pasteAttachmentImage,
        setReviewCommentDraftIncluded,
        updateReviewCommentDraft,
    ]);

    const handleSend = React.useCallback((options?: NewSessionAgentInputSendOptions) => {
        const promptText = options?.inputTextOverride ?? params.promptStore.getPrompt();
        const submit = (opts?: HandleCreateSessionOptions) => {
            blurActiveElementOnWeb();
            deferOnWeb(() => {
                params.handleCreateSession(opts);
            });
        };

        // The composer's `mentions[]` envelope. Both branches below have to carry it: this
        // controller is the only thing between the composer and the first turn, so dropping it
        // here is what made an `@session` reference composed on this screen reach the agent as
        // bare text.
        const structuredInputMetaOverrides = options?.structuredInputMetaOverrides;

        const hasAttachments = attachmentsUploadsEnabled && draftsSnapshotRef.current.length > 0;
        if (!hasAttachments && !hasReviewCommentDrafts) {
            submit(options?.inputTextOverride || structuredInputMetaOverrides
                ? {
                    ...(options?.inputTextOverride ? { inputTextOverride: options.inputTextOverride } : {}),
                    ...(structuredInputMetaOverrides ? { structuredInputMetaOverrides } : {}),
                }
                : undefined);
            return;
        }

        const initialPrompt = promptText;
        submit({
            initialMessage: 'skip',
            afterCreated: async ({ sessionId, effectiveSpawnServerId, launchAttempt }) => {
                const trimmed = initialPrompt.trim();
                let attachmentsBlock = '';
                let attachmentsMetaOverrides: Record<string, unknown> | undefined;
                const messageLocalId = launchAttempt.attachmentMessageLocalId;
                let outbound: {
                    text: string;
                    displayText?: string;
                    metaOverrides?: Record<string, unknown>;
                } | null = null;

                try {
                    if (hasAttachments) {
                        const { uploaded } = await uploadAttachmentDraftsToSession({
                            sessionId,
                            drafts: draftsSnapshotRef.current,
                            messageLocalId,
                            config: attachmentsUploadConfig,
                            applyDraftPatch: applyNewSessionDraftPatch,
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

                    const reviewCommentDraftsForPrompt = hasReviewCommentDrafts
                        ? await resolveReviewCommentDraftAnchorsForPrompt({
                            drafts: includedReviewCommentDrafts,
                            reviewScope: discoverableReviewCommentsScope,
                        })
                        : [];

                    // One envelope per message: `mergeMessageMetaOverrides` folds the composer's
                    // `mentions[]` into the attachments envelope instead of one replacing the other.
                    const outboundMetaOverrides = mergeMessageMetaOverrides(
                        attachmentsMetaOverrides,
                        structuredInputMetaOverrides,
                    );

                    outbound = hasReviewCommentDrafts
                        ? buildReviewCommentsOutboundMessage({
                            sessionId,
                            drafts: reviewCommentDraftsForPrompt,
                            additionalMessage: attachmentsBlock
                                ? (trimmed.length > 0 ? `${trimmed}\n\n${attachmentsBlock}` : attachmentsBlock)
                                : trimmed,
                            displayTextSuffix: attachmentsBlock || null,
                            metaOverrides: outboundMetaOverrides,
                        })
                        : {
                            text: trimmed.length > 0 ? `${trimmed}\n\n${attachmentsBlock}` : attachmentsBlock,
                            displayText: trimmed || undefined,
                            metaOverrides: outboundMetaOverrides,
                        };

                    await followUpSpawnedSessionWithServerScope({
                        sessionId,
                        targetServerId: effectiveSpawnServerId ?? params.targetServerId,
                        initialMessageText: outbound.text,
                        displayText: outbound.displayText,
                        messageLocalId,
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
                        draftText: outbound?.text ?? trimmed,
                        displayText: outbound?.displayText ?? (trimmed || undefined),
                        profileId: params.selectedProfileId,
                        metaOverrides: outbound?.metaOverrides ?? attachmentsMetaOverrides,
                        attachmentDrafts: draftsSnapshotRef.current,
                    });
                }
            },
        });
    }, [
        applyNewSessionDraftPatch,
        attachmentsUploadConfig,
        attachmentsUploadsEnabled,
        clearDraftsForFlow,
        clearReviewCommentsForFlow,
        discoverableReviewCommentsScope,
        hasReviewCommentDrafts,
        includedReviewCommentDrafts,
        params.handleCreateSession,
        params.selectedProfileId,
        params.promptStore,
        params.targetServerId,
    ]);

    const resumedPersistedLaunchKeyRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        const key = typeof params.resumePersistedLaunchKey === 'string'
            ? params.resumePersistedLaunchKey.trim()
            : '';
        if (key.length === 0 || resumedPersistedLaunchKeyRef.current === key) return;
        resumedPersistedLaunchKeyRef.current = key;
        handleSend();
    }, [handleSend, params.resumePersistedLaunchKey]);

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
