import { createSessionAccessActionChip } from '@/components/sessions/agentInput/definitions/createSessionAccessActionChip';
import * as React from 'react';
import { useWorkspaceFileOpener } from '@/components/workspaces/files/useWorkspaceFileOpener';
import type { BackendTargetRefV2Input } from '@happier-dev/protocol';

import type {
    AgentInputAttachmentsRowItem,
    AgentInputExtraActionChip,
} from '@/components/sessions/agentInput/agentInputContracts';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { BrowserContextState } from '@/sync/domains/browser/context';
import { hasBrowserContextComposerAttachments } from '@/sync/domains/session/input/browserContext';
import { storage } from '@/sync/domains/state/storage';
import type { Settings } from '@/sync/domains/settings/settings';
import { useSettingsSelector } from '@/sync/store/settingsReadHooks';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

import { createLinkedFilesActionChip } from '../definitions/createLinkedFilesActionChip';
import { createBrowserContextActionChip } from '../definitions/createBrowserContextActionChip';
import { createReviewCommentsActionChip } from '../definitions/createReviewCommentsActionChip';
import { buildSessionAgentInputActionChips } from './buildSessionAgentInputActionChips';
import { createAttachmentActionChip } from './createAttachmentActionChip';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

const selectActionChipSettings = (settings: Settings) => [
    settings.actionsSettingsV1, settings.experiments, settings.featureToggles,
] as const;

export function useSessionAgentInputExtraActionChips(params: Readonly<{
    sessionAccess?: Parameters<typeof createSessionAccessActionChip>[0] | null;
    sessionId: string;
    sessionAddress: SessionAddress | null;
    accountScope: ServerAccountScope | null;
    accountScopeIsCurrent?: (() => boolean) | null;
    attachmentsUploadsEnabled: boolean;
    attachmentsUploadsAvailable?: boolean;
    isReadOnly: boolean;
    isUploadingAttachments: boolean;
    onPickAttachmentFile: () => void;
    onPickAttachmentImage: () => void;
    onPasteAttachmentImage?: () => void;
    onAppendLinkedPath: (path: string) => void;
    reviewCommentsEnabled: boolean;
    reviewScope: WorkspaceScopeBase | null;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    defaultBackendTarget?: BackendTargetRefV2Input | null;
    defaultBackendId: string | null;
    /** The composer text, read when an action chip is pressed. */
    readInstructionsText: () => string;
    browserContext?: Readonly<{
        state: BrowserContextState;
        onAttachPageReference?: () => void;
        onRemoveAttachment?: (attachmentId: string) => void;
        disabledReason?: string | null;
    }> | null;
}>): Readonly<{
    actionChips: readonly AgentInputExtraActionChip[];
    attachmentRowItems: readonly AgentInputAttachmentsRowItem[];
}> {
    const { open: openFile, canOpen: canOpenFile } = useWorkspaceFileOpener();
    // These are the inputs read by the canonical Action placement policy. Draft
    // and unrelated settings publications must not rebuild the controls.
    const actionChipSettings = useSettingsSelector(selectActionChipSettings, ['actionsSettingsV1', 'experiments', 'featureToggles']);
    const reviewWorkspaceCacheKey = React.useMemo(() => (
        params.reviewScope ? tryBuildWorkspaceCacheKey(params.reviewScope) : null
    ), [params.reviewScope]);

    const browserContextPresentation = React.useMemo(() => {
        const browserContext = params.browserContext;
        return browserContext && hasBrowserContextComposerAttachments(browserContext.state)
            ? createBrowserContextActionChip(browserContext) : undefined;
    }, [params.browserContext]);
    const reviewCommentsPresentation = React.useMemo(() => {
        if (!params.reviewCommentsEnabled) return undefined;
        return createReviewCommentsActionChip({
            sessionId: params.sessionId,
            openFile: canOpenFile ? openFile : undefined,
            reviewScope: params.reviewScope,
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
    }, [canOpenFile, openFile, params.reviewCommentsEnabled, params.reviewScope,
        params.reviewCommentDrafts, params.sessionId, reviewWorkspaceCacheKey]);
    const attachmentRowItems = React.useMemo(() => {
        const items: AgentInputAttachmentsRowItem[] = [];
        if (browserContextPresentation?.attachmentRowItem) items.push(browserContextPresentation.attachmentRowItem);
        if (reviewCommentsPresentation?.attachmentRowItem) items.push(reviewCommentsPresentation.attachmentRowItem);
        return items;
    }, [browserContextPresentation?.attachmentRowItem, reviewCommentsPresentation?.attachmentRowItem]);
    const actionChips = React.useMemo(() => {
        const chips: AgentInputExtraActionChip[] = [];
        if (params.sessionAccess) chips.push(createSessionAccessActionChip(params.sessionAccess));
        if (params.attachmentsUploadsEnabled && !params.isReadOnly) {
            chips.push(createAttachmentActionChip({
                onPickFile: params.onPickAttachmentFile,
                onPickImage: params.onPickAttachmentImage,
                onPasteImage: params.onPasteAttachmentImage,
                disabled: params.isUploadingAttachments || params.attachmentsUploadsAvailable === false,
            }));
        }
        if (!params.isReadOnly) {
            chips.push(createLinkedFilesActionChip({
                sessionId: params.sessionId,
                serverId: params.sessionAddress?.serverId,
                disabled: params.isUploadingAttachments,
                onPickPath: params.onAppendLinkedPath,
            }));
        }
        if (browserContextPresentation) chips.push(browserContextPresentation.actionChip);
        if (reviewCommentsPresentation) chips.push(reviewCommentsPresentation.actionChip);

        chips.push(...buildSessionAgentInputActionChips({
            address: params.sessionAddress ?? { serverId: '', sessionId: params.sessionId },
            accountScope: params.accountScope,
            accountScopeIsCurrent: params.accountScopeIsCurrent,
            defaultBackendTarget: params.defaultBackendTarget ?? null,
            defaultBackendId: params.defaultBackendId,
            readInstructionsText: params.readInstructionsText,
        }));

        return chips;
    }, [
        actionChipSettings,
        browserContextPresentation,
        reviewCommentsPresentation,
        params.sessionAccess,
        params.attachmentsUploadsEnabled,
        params.attachmentsUploadsAvailable,
        params.defaultBackendId,
        params.defaultBackendTarget,
        params.readInstructionsText,
        params.isReadOnly,
        params.isUploadingAttachments,
        params.onAppendLinkedPath,
        params.onPickAttachmentFile,
        params.onPickAttachmentImage,
        params.onPasteAttachmentImage,
        params.sessionId,
        params.sessionAddress,
        params.accountScope,
        params.accountScopeIsCurrent,
    ]);
    return React.useMemo(() => ({ actionChips, attachmentRowItems }), [actionChips, attachmentRowItems]);
}
