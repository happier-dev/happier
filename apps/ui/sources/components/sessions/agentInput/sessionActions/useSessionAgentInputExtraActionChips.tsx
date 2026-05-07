import * as React from 'react';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { storage } from '@/sync/domains/state/storage';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

import { createLinkedFilesActionChip } from '../definitions/createLinkedFilesActionChip';
import { createReviewCommentsActionChip } from '../definitions/createReviewCommentsActionChip';
import { buildSessionAgentInputActionChips } from './buildSessionAgentInputActionChips';
import { createAttachmentActionChip } from './createAttachmentActionChip';

export function useSessionAgentInputExtraActionChips(params: Readonly<{
    sessionId: string;
    attachmentsUploadsEnabled: boolean;
    isReadOnly: boolean;
    isUploadingAttachments: boolean;
    onPickAttachmentFile: () => void;
    onPickAttachmentImage: () => void;
    onAppendLinkedPath: (path: string) => void;
    reviewCommentsEnabled: boolean;
    reviewScope: WorkspaceScopeBase | null;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    defaultBackendTarget?: BackendTargetRefV1 | null;
    defaultBackendId: string | null;
    instructionsText: string;
}>): ReadonlyArray<AgentInputExtraActionChip> | undefined {
    const reviewWorkspaceCacheKey = React.useMemo(() => (
        params.reviewScope ? tryBuildWorkspaceCacheKey(params.reviewScope) : null
    ), [params.reviewScope]);

    return React.useMemo(() => {
        const chips: AgentInputExtraActionChip[] = [];

        if (params.attachmentsUploadsEnabled && !params.isReadOnly) {
            chips.push(createAttachmentActionChip({
                onPickFile: params.onPickAttachmentFile,
                onPickImage: params.onPickAttachmentImage,
                disabled: params.isUploadingAttachments,
            }));
        }

        if (!params.isReadOnly) {
            chips.push(createLinkedFilesActionChip({
                sessionId: params.sessionId,
                disabled: params.isUploadingAttachments,
                onPickPath: params.onAppendLinkedPath,
            }));
        }

        if (params.reviewCommentsEnabled) {
            const reviewCommentsChip = createReviewCommentsActionChip({
                sessionId: params.sessionId,
                reviewCommentDrafts: params.reviewCommentDrafts,
                onSetDraftIncluded: (draftId, included) => {
                    if (reviewWorkspaceCacheKey) {
                        storage.getState().setWorkspaceReviewCommentDraftIncluded(reviewWorkspaceCacheKey, draftId, included);
                    } else {
                        storage.getState().setSessionReviewCommentDraftIncluded(params.sessionId, draftId, included);
                    }
                },
                onUpdateDraft: (draft) => {
                    if (reviewWorkspaceCacheKey) {
                        storage.getState().upsertWorkspaceReviewCommentDraft(reviewWorkspaceCacheKey, draft);
                    } else {
                        storage.getState().upsertSessionReviewCommentDraft(params.sessionId, draft);
                    }
                },
                onDeleteDraft: (draftId) => {
                    if (reviewWorkspaceCacheKey) {
                        storage.getState().deleteWorkspaceReviewCommentDraft(reviewWorkspaceCacheKey, draftId);
                    } else {
                        storage.getState().deleteSessionReviewCommentDraft(params.sessionId, draftId);
                    }
                },
                onClearDrafts: () => {
                    if (reviewWorkspaceCacheKey) {
                        storage.getState().clearWorkspaceReviewCommentDrafts(reviewWorkspaceCacheKey);
                    } else {
                        storage.getState().clearSessionReviewCommentDrafts(params.sessionId);
                    }
                },
            });
            if (reviewCommentsChip) {
                chips.push(reviewCommentsChip);
            }
        }

        chips.push(...buildSessionAgentInputActionChips({
            sessionId: params.sessionId,
            defaultBackendTarget: params.defaultBackendTarget ?? null,
            defaultBackendId: params.defaultBackendId,
            instructionsText: params.instructionsText,
        }));

        return chips.length > 0 ? chips : undefined;
    }, [
        params.attachmentsUploadsEnabled,
        params.defaultBackendId,
        params.defaultBackendTarget,
        params.instructionsText,
        params.isReadOnly,
        params.isUploadingAttachments,
        params.onAppendLinkedPath,
        params.onPickAttachmentFile,
        params.onPickAttachmentImage,
        params.reviewCommentDrafts,
        params.reviewCommentsEnabled,
        params.reviewScope,
        params.sessionId,
        reviewWorkspaceCacheKey,
    ]);
}
