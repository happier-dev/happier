import {
    SessionDraftRecipientValueV1Schema,
    type SessionDraftDocumentV1,
} from '@happier-dev/protocol';

import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { AgentInputLocalUiStateV1 } from '@/sync/domains/input/draftValues/agentInputLocalUiStateStore';
import {
    SessionDraftValueFieldSchemas,
    type SessionDraftValueByFieldId,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

export type PendingMessageComposerSemanticDraftSnapshot = Readonly<{
    recipient: SessionDraftValueByFieldId['routing.recipient'] | undefined;
    executionRunDelivery: SessionDraftValueByFieldId['routing.executionRunDelivery'] | undefined;
    structuredInputMentions: SessionDraftValueByFieldId['structuredInput.mentions'] | undefined;
}>;

export type PendingMessageComposerEditState = Readonly<{
    pendingId: string;
    previousDraftText: string;
    previousAttachmentDrafts: readonly AttachmentDraft[];
    previousSemanticDraftSnapshot: PendingMessageComposerSemanticDraftSnapshot;
    previousTransientInputState: AgentInputLocalUiStateV1 | null;
    loadedText: string;
}>;

export function readPendingMessageComposerSemanticDraftSnapshot(
    document: SessionDraftDocumentV1 | null,
): PendingMessageComposerSemanticDraftSnapshot {
    if (!document || document.target.kind !== 'session') {
        return {
            recipient: undefined,
            executionRunDelivery: undefined,
            structuredInputMentions: undefined,
        };
    }
    const recipient = SessionDraftRecipientValueV1Schema.safeParse(document.target.routing.recipient.value);
    const executionRunDelivery = SessionDraftValueFieldSchemas['routing.executionRunDelivery']
        .safeParse(document.target.routing.executionRunDelivery.value);
    const mentions = SessionDraftValueFieldSchemas['structuredInput.mentions']
        .safeParse(document.composer.mentions.value);
    return {
        recipient: recipient.success && recipient.data !== null
            ? recipient.data.recipient
            : undefined,
        executionRunDelivery: executionRunDelivery.success ? executionRunDelivery.data : undefined,
        structuredInputMentions: mentions.success ? mentions.data : undefined,
    };
}

export function isEmptyPendingMessageComposerSemanticDraftSnapshot(
    snapshot: PendingMessageComposerSemanticDraftSnapshot,
): boolean {
    return typeof snapshot.recipient === 'undefined'
        && typeof snapshot.executionRunDelivery === 'undefined'
        && typeof snapshot.structuredInputMentions === 'undefined';
}
