import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { AgentInputLocalUiStateV1 } from '@/sync/domains/input/draftValues/agentInputLocalUiStateStore';
import type { SessionDraftValueByFieldId } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

export type PendingMessageComposerSemanticDraftSnapshot = Readonly<{
    recipient: SessionDraftValueByFieldId['routing.recipient'] | undefined;
    executionRunDelivery: SessionDraftValueByFieldId['routing.executionRunDelivery'] | undefined;
    structuredInputMentions: SessionDraftValueByFieldId['structuredInput.mentions'] | undefined;
}>;

export type PendingMessageComposerEditState = Readonly<{
    pendingId: string;
    holdId: string;
    previousDraftText: string;
    previousAttachmentDrafts: readonly AttachmentDraft[];
    previousSemanticDraftSnapshot: PendingMessageComposerSemanticDraftSnapshot;
    previousTransientInputState: AgentInputLocalUiStateV1 | null;
    loadedText: string;
}>;

export function isEmptyPendingMessageComposerSemanticDraftSnapshot(
    snapshot: PendingMessageComposerSemanticDraftSnapshot,
): boolean {
    return typeof snapshot.recipient === 'undefined'
        && typeof snapshot.executionRunDelivery === 'undefined'
        && typeof snapshot.structuredInputMentions === 'undefined';
}
