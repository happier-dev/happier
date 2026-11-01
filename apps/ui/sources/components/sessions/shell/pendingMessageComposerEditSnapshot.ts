import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { AgentInputLocalUiStateV1 } from '@/sync/domains/input/draftValues/agentInputLocalUiStateStore';
import type { SessionDraftValueByFieldId } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import type { ExistingSessionDraftSemanticValues } from '@/sync/domains/input/drafts/existingSessionDraftSemanticValues';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

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

/**
 * Reads the composer's semantic draft fields at call time through their canonical owner — the
 * same owner that restores them — so a captured edit snapshot is always the repository's current
 * value rather than whatever document the last render happened to subscribe to.
 */
export function readPendingMessageComposerSemanticDraftSnapshot(
    values: Pick<ExistingSessionDraftSemanticValues, 'read'>,
    scope: ServerAccountScope | null,
    sessionId: string,
): PendingMessageComposerSemanticDraftSnapshot {
    if (!scope) {
        return {
            recipient: undefined,
            executionRunDelivery: undefined,
            structuredInputMentions: undefined,
        };
    }
    return {
        recipient: values.read(scope, sessionId, 'routing.recipient'),
        executionRunDelivery: values.read(scope, sessionId, 'routing.executionRunDelivery'),
        structuredInputMentions: values.read(scope, sessionId, 'structuredInput.mentions'),
    };
}

export function isEmptyPendingMessageComposerSemanticDraftSnapshot(
    snapshot: PendingMessageComposerSemanticDraftSnapshot,
): boolean {
    return (typeof snapshot.recipient === 'undefined' || snapshot.recipient === null)
        && typeof snapshot.executionRunDelivery === 'undefined'
        && (
            typeof snapshot.structuredInputMentions === 'undefined'
            || snapshot.structuredInputMentions.length === 0
        );
}
