import * as React from 'react';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

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
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    defaultBackendTarget?: BackendTargetRefV1 | null;
    defaultBackendId: string | null;
    instructionsText: string;
}>): ReadonlyArray<AgentInputExtraActionChip> | undefined {
    const reviewCommentDraftCount = params.reviewCommentDrafts.length;

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
        params.sessionId,
    ]);
}
