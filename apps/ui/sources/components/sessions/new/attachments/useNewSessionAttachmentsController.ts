import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { createReviewCommentsActionChip } from '@/components/sessions/agentInput/definitions/createReviewCommentsActionChip';
import { resolveReviewCommentDraftAnchorsForPrompt } from '@/components/sessions/reviews/comments/resolveReviewCommentDraftAnchorsForPrompt';
import { createAttachmentActionChip } from '@/components/sessions/agentInput/sessionActions/createAttachmentActionChip';
import type {
    AgentInputAttachmentsRowItem,
    AgentInputExtraActionChip,
    AgentInputExtraActionPresentation,
} from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputSendOptions } from '@/components/sessions/agentInput/agentInputSendOptions';
import {
    buildStructuredInputMetaOverrides,
    mergeMessageMetaOverrides,
} from '@/components/sessions/agentInput/structuredInputMentions';
import {
    composerAttachmentViewToDraft,
    composerStructuredMentionsFromReferences,
} from '@/components/sessions/composer/composerScopeAdapters';
import {
    submitComposerSnapshot,
    type ComposerSubmissionSnapshot,
} from '@/components/sessions/composer/composerSubmissionCoordinator';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { openAttachmentFilePickerFiles, openAttachmentFilePickerImages } from '@/components/sessions/attachments/attachmentFilePickerActions';
import { attachRecoverableAttachmentDrafts } from '@/components/sessions/attachments/recoverableAttachmentDrafts';
import { useWorkspaceReviewCommentDraftHandlers } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers';
import { useAttachmentDraftManager } from '@/components/sessions/attachments/useAttachmentDraftManager';
import { useAttachmentsUploadConfig } from '@/components/sessions/attachments/useAttachmentsUploadConfig';
import { buildAttachmentMessageMeta, formatAttachmentsBlock, uploadAttachmentDraftsToSession } from '@/components/sessions/attachments/uploadAttachmentDraftsToSession';
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
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    clearNewSessionAttachmentDrafts,
    readNewSessionAttachmentDrafts,
    writeNewSessionAttachmentDrafts,
} from './newSessionAttachmentDraftStore';
import { resolveNewSessionReviewCommentsScope } from './resolveNewSessionReviewCommentsScope';
import type { NewSessionComposerDocument } from '@/components/sessions/new/hooks/screenModel/useNewSessionComposerDocument';
import type { NewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';

type NewSessionAgentInputSendOptions = AgentInputSendOptions;

type HandleCreateSession = (opts?: HandleCreateSessionOptions) => void;

function buildDetachedComposerSnapshotMetaOverrides(input: Readonly<{
    snapshot: ComposerSubmissionSnapshot;
    options?: Record<string, unknown>;
}>): Record<string, unknown> | undefined {
    const snapshotMetaOverrides = buildStructuredInputMetaOverrides({
        mentions: composerStructuredMentionsFromReferences({
            references: input.snapshot.references,
            existing: [],
        }),
        text: input.snapshot.text,
        ...(input.snapshot.attachments.length > 0
            ? { composerAttachments: input.snapshot.attachments.map(composerAttachmentViewToDraft) }
            : {}),
    });
    const {
        // A mounted Composer document is the only authority for generic
        // references and attachments. Retaining this live envelope would
        // duplicate or stale the exact detached submission snapshot.
        happierStructuredInputV1: _liveComposerSemanticMeta,
        ...preservedOptionMetaOverrides
    } = input.options ?? {};
    return mergeMessageMetaOverrides(
        Object.keys(preservedOptionMetaOverrides).length > 0 ? preservedOptionMetaOverrides : undefined,
        Object.keys(snapshotMetaOverrides).length > 0 ? snapshotMetaOverrides : undefined,
    );
}

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
    /**
     * The removable "continue from this Session" chip, when this draft was
     * seeded from another Session. Both halves arrive together so the composer
     * chip and its attachment row never drift apart.
     */
    sourceContextPresentation?: AgentInputExtraActionPresentation | null;
    /** The canonical New Session semantic document and exact-snapshot clear owner. */
    composerDocument?: NewSessionComposerDocument;
}>): Readonly<{
    attachmentsUploadsEnabled: boolean;
    filePickerRef: ReturnType<typeof useAttachmentDraftManager>['filePickerRef'];
    drafts: ReturnType<typeof useAttachmentDraftManager>['drafts'];
    hasSendableAttachments: boolean;
    agentInputAttachments: ReturnType<typeof useAttachmentDraftManager>['agentInputAttachments'];
    addWebFiles: ReturnType<typeof useAttachmentDraftManager>['addWebFiles'];
    addPickedAttachments: ReturnType<typeof useAttachmentDraftManager>['addPickedAttachments'];
    actionChips: readonly AgentInputExtraActionChip[];
    attachmentRowItems: readonly AgentInputAttachmentsRowItem[];
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
        if (!normalizedFlowId || !attachmentsUploadsEnabled) return;
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

    const actionPresentation = React.useMemo(() => {
        const chips: AgentInputExtraActionChip[] = [];
        const attachmentRowItems: AgentInputAttachmentsRowItem[] = [];

        if (attachmentsUploadsEnabled) {
            chips.push(createAttachmentActionChip({
                onPickFile: () => openAttachmentFilePickerFiles(filePickerRef.current),
                onPickImage: () => openAttachmentFilePickerImages(filePickerRef.current),
                onPasteImage: pasteAttachmentImage,
                disabled: params.isCreating,
            }));
        }

        if (hasDiscoverableReviewCommentDrafts) {
            const reviewCommentsPresentation = createReviewCommentsActionChip({
                reviewScope: discoverableReviewCommentsScope,
                reviewCommentDrafts: discoverableReviewCommentDrafts,
                onSetDraftIncluded: setReviewCommentDraftIncluded,
                onUpdateDraft: updateReviewCommentDraft,
                onDeleteDraft: deleteReviewCommentDraft,
                onClearDrafts: discardReviewCommentDrafts,
            });
            if (reviewCommentsPresentation) {
                chips.push(reviewCommentsPresentation.actionChip);
                if (reviewCommentsPresentation.attachmentRowItem) {
                    attachmentRowItems.push(reviewCommentsPresentation.attachmentRowItem);
                }
            }
        }

        const sourceContextPresentation = params.sourceContextPresentation ?? null;
        if (sourceContextPresentation) {
            chips.push(sourceContextPresentation.actionChip);
            if (sourceContextPresentation.attachmentRowItem) {
                attachmentRowItems.push(sourceContextPresentation.attachmentRowItem);
            }
        }

        return {
            actionChips: [...chips, ...(params.baseActionChips ?? [])],
            attachmentRowItems,
        };
    }, [
        attachmentsUploadsEnabled,
        discoverableReviewCommentDrafts,
        filePickerRef,
        hasDiscoverableReviewCommentDrafts,
        params.baseActionChips,
        params.sourceContextPresentation,
        params.isCreating,
        pasteAttachmentImage,
        setReviewCommentDraftIncluded,
        updateReviewCommentDraft,
        deleteReviewCommentDraft,
        discardReviewCommentDrafts,
    ]);

    const handleSend = React.useCallback((options?: NewSessionAgentInputSendOptions) => {
        const promptText = options?.inputTextOverride ?? params.promptStore.getPrompt();
        const submit = (opts?: HandleCreateSessionOptions) => {
            blurActiveElementOnWeb();
            deferOnWeb(() => {
                params.handleCreateSession(opts);
            });
        };

        const draftSnapshot = getDraftsSnapshot();
        const hasAttachments = attachmentsUploadsEnabled && draftSnapshot.length > 0;
        const submitAfterCreated = (input: Readonly<{
            initialPrompt: string;
            structuredInputMetaOverrides?: Record<string, unknown>;
            onAfterCreatedSettled?: HandleCreateSessionOptions['onAfterCreatedSettled'];
            deferAcceptedDraftClearToDocument?: boolean;
            hasComposerAttachments?: boolean;
        }>) => {
            submit({
                initialMessage: 'skip',
                ...(input.onAfterCreatedSettled
                    ? { onAfterCreatedSettled: input.onAfterCreatedSettled }
                    : {}),
                ...(input.deferAcceptedDraftClearToDocument
                    ? { deferAcceptedDraftClearToDocument: true }
                    : {}),
                ...(input.hasComposerAttachments
                    ? { hasComposerAttachments: true }
                    : {}),
                afterCreated: async ({ sessionId, effectiveSpawnServerId, launchAttempt }) => {
                    const attachmentMessageLocalId = launchAttempt.attachmentMessageLocalId;
                    // A coordinator-submitted first turn has no upload/review
                    // envelope to supply a message id. Reuse the launch
                    // attempt's incumbent first-turn identity so a post-create
                    // retry cannot invent a second Message.
                    const messageLocalId = input.deferAcceptedDraftClearToDocument && !hasAttachments && !hasReviewCommentDrafts
                        ? launchAttempt.firstTurnLocalId
                        : (hasAttachments || hasReviewCommentDrafts ? attachmentMessageLocalId : undefined);
                    const trimmed = input.initialPrompt.trim();
                    let attachmentsBlock = '';
                    let attachmentsMetaOverrides: Record<string, unknown> | undefined;

                    if (hasAttachments) {
                        const { uploaded } = await uploadAttachmentDraftsToSession({
                            sessionId,
                            drafts: draftSnapshot,
                            config: attachmentsUploadConfig,
                            applyDraftPatch,
                            messageLocalId: attachmentMessageLocalId,
                        });
                        attachmentsBlock = formatAttachmentsBlock(uploaded);
                        attachmentsMetaOverrides = buildAttachmentMessageMeta(uploaded);
                    }

                    const resolvedReviewCommentDrafts = hasReviewCommentDrafts
                        ? await resolveReviewCommentDraftAnchorsForPrompt({
                            drafts: includedReviewCommentDrafts,
                            reviewScope: discoverableReviewCommentsScope,
                        })
                        : [];

                    const outbound = hasReviewCommentDrafts
                        ? buildReviewCommentsOutboundMessage({
                            sessionId,
                            drafts: resolvedReviewCommentDrafts,
                            additionalMessage: attachmentsBlock
                                ? (trimmed.length > 0 ? `${trimmed}\n\n${attachmentsBlock}` : attachmentsBlock)
                                : trimmed,
                            displayTextSuffix: attachmentsBlock || null,
                            metaOverrides: mergeMessageMetaOverrides(
                                attachmentsMetaOverrides,
                                input.structuredInputMetaOverrides,
                            ),
                        })
                        : {
                            text: attachmentsBlock
                                ? (trimmed.length > 0 ? `${trimmed}\n\n${attachmentsBlock}` : attachmentsBlock)
                                : trimmed,
                            displayText: trimmed || undefined,
                            metaOverrides: mergeMessageMetaOverrides(
                                attachmentsMetaOverrides,
                                input.structuredInputMetaOverrides,
                            ),
                        };

                    try {
                        await followUpSpawnedSessionWithServerScope({
                            sessionId,
                            targetServerId: effectiveSpawnServerId ?? params.targetServerId,
                            initialMessageText: outbound.text,
                            displayText: outbound.displayText,
                            profileId: params.selectedProfileId,
                            metaOverrides: outbound.metaOverrides,
                            ...(messageLocalId
                                ? { messageLocalId }
                                : {}),
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
                            attachmentDrafts: draftSnapshot,
                        });
                    }
                },
            });
        };

        const composerDocument = params.composerDocument;
        if (composerDocument) {
            const composerSnapshot = composerDocument.captureSubmissionSnapshot(options?.inputTextOverride);
            if (!composerSnapshot || composerSnapshot.ref.kind !== 'newSession') {
                // A mounted Composer document is the submission snapshot owner.
                // Do not fall back to the legacy create path when its exact
                // document has already become unavailable.
                return;
            }
            fireAndForget(submitComposerSnapshot({
                snapshot: composerSnapshot,
                route: {
                    kind: 'newSession',
                    ref: composerSnapshot.ref,
                    readCurrentExecutionTarget: () => composerDocument.readCurrentExecutionTarget?.() ?? null,
                    admit: (submittedSnapshot) => new Promise((resolve) => {
                        submitAfterCreated({
                            initialPrompt: submittedSnapshot.text,
                            structuredInputMetaOverrides: buildDetachedComposerSnapshotMetaOverrides({
                                snapshot: submittedSnapshot,
                                options: options?.structuredInputMetaOverrides,
                            }),
                            deferAcceptedDraftClearToDocument: true,
                            hasComposerAttachments: submittedSnapshot.attachments.length > 0,
                            onAfterCreatedSettled: (settlement) => {
                                resolve(settlement.status === 'accepted'
                                    ? { status: 'accepted' }
                                    : { status: 'rejected' });
                            },
                        });
                    }),
                },
                clearAcceptedSnapshot: composerDocument.clearAcceptedSnapshot,
            }).then((result) => {
                if (
                    result.status === 'blocked'
                    && (result.reason === 'attachmentUnavailable' || result.reason === 'mediaContentUnavailable')
                ) {
                    Modal.alert(t('common.error'), t('common.unavailable'));
                }
            }), { tag: 'NewSessionAttachmentsController.submitComposerSnapshot' });
            return;
        }

        const structuredInputMetaOverrides = options?.structuredInputMetaOverrides;
        const hasStructuredInputMetaOverrides = Boolean(
            structuredInputMetaOverrides && Object.keys(structuredInputMetaOverrides).length > 0,
        );
        if (!hasAttachments && !hasReviewCommentDrafts && !hasStructuredInputMetaOverrides) {
            submit(options?.inputTextOverride ? { inputTextOverride: options.inputTextOverride } : undefined);
            return;
        }

        submitAfterCreated({
            initialPrompt: promptText,
            structuredInputMetaOverrides,
        });
    }, [
        applyDraftPatch,
        attachmentsUploadConfig,
        attachmentsUploadsEnabled,
        clearReviewCommentsForFlow,
        clearDraftsForFlow,
        discoverableReviewCommentsScope,
        getDraftsSnapshot,
        hasReviewCommentDrafts,
        includedReviewCommentDrafts,
        params.composerDocument,
        params.handleCreateSession,
        params.selectedProfileId,
        params.promptStore,
        params.selectedMachineId,
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
        actionChips: actionPresentation.actionChips,
        attachmentRowItems: actionPresentation.attachmentRowItems,
        handleSend,
    };
}
