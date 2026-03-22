import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { createAttachmentActionChip } from '@/components/sessions/agentInput/sessionActions/createAttachmentActionChip';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { attachRecoverableAttachmentDrafts } from '@/components/sessions/attachments/recoverableAttachmentDrafts';
import { useAttachmentDraftManager } from '@/components/sessions/attachments/useAttachmentDraftManager';
import { useAttachmentsUploadConfig } from '@/components/sessions/attachments/useAttachmentsUploadConfig';
import { formatAttachmentsBlock, uploadAttachmentDraftsToSession } from '@/components/sessions/attachments/uploadAttachmentDraftsToSession';
import { blurActiveElementOnWeb, deferOnWeb } from '@/utils/platform/deferOnWeb';
import { followUpSpawnedSessionWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession';
import type { CreatedSessionFollowUpContext } from '@/components/sessions/new/hooks/useCreateNewSession';

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

    const extraActionChips = React.useMemo(() => {
        const base = params.baseActionChips ?? [];
        if (!attachmentsUploadsEnabled) return base;
        return [
            createAttachmentActionChip({
                onPress: () => filePickerRef.current?.open(),
                disabled: params.isCreating,
            }),
            ...base,
        ] as const;
    }, [attachmentsUploadsEnabled, filePickerRef, params.baseActionChips, params.isCreating]);

    const handleSend = React.useCallback(() => {
        const submit = (opts?: Readonly<{ initialMessage?: 'send' | 'skip'; afterCreated?: (context: CreatedSessionFollowUpContext) => void | Promise<void> }>) => {
            blurActiveElementOnWeb();
            deferOnWeb(() => {
                params.handleCreateSession(opts);
            });
        };

        if (!attachmentsUploadsEnabled || drafts.length === 0) {
            submit();
            return;
        }

        const initialPrompt = String(params.sessionPrompt ?? '');
        submit({
            initialMessage: 'skip',
            afterCreated: async ({ sessionId, effectiveSpawnServerId }) => {
                const { uploaded } = await uploadAttachmentDraftsToSession({
                    sessionId,
                    drafts,
                    config: attachmentsUploadConfig,
                    applyDraftPatch,
                });
                const attachmentsBlock = formatAttachmentsBlock(uploaded);
                const trimmed = initialPrompt.trim();
                const text = trimmed.length > 0 ? `${trimmed}\n\n${attachmentsBlock}` : attachmentsBlock;
                const metaOverrides = {
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

                try {
                    await followUpSpawnedSessionWithServerScope({
                        sessionId,
                        targetServerId: effectiveSpawnServerId ?? params.targetServerId,
                        initialMessageText: text,
                        displayText: trimmed || undefined,
                        profileId: params.selectedProfileId,
                        metaOverrides,
                    });
                    clearDraftsForFlow();
                } catch (error) {
                    throw attachRecoverableAttachmentDrafts(error, {
                        draftText: text,
                        displayText: trimmed || undefined,
                        profileId: params.selectedProfileId,
                        metaOverrides,
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
        drafts,
        getDraftsSnapshot,
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
