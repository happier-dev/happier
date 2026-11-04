import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    clearAttachmentDraftsForKey,
    clearAttachmentDraftsForKeyPrefix,
    readAttachmentDraftsForKey,
    writeAttachmentDraftsForKey,
    settleAttachmentDraftsForKey,
    subscribeAttachmentDraftsForKey,
    bindAttachmentDraftPersistence,
} from '@/components/sessions/attachments/attachmentDraftMemoryStore';

const NEW_SESSION_ATTACHMENT_DRAFT_KEY_PREFIX = 'new-session:';

function normalizeFlowId(flowId: string | null | undefined): string | null {
    if (typeof flowId !== 'string') return null;
    const trimmed = flowId.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function newSessionAttachmentDraftKey(flowId: string, scope: ServerAccountScope | null = getActiveServerAccountScope()): string {
    const key = `${NEW_SESSION_ATTACHMENT_DRAFT_KEY_PREFIX}${scope ? `${serverAccountScopeKeySuffix(scope)}:` : ''}${flowId}`;
    if (scope) bindAttachmentDraftPersistence(key, scope);
    return key;
}

export function readNewSessionAttachmentDrafts(
    flowId: string | null | undefined,
    scope: ServerAccountScope | null = getActiveServerAccountScope(),
): readonly AttachmentDraft[] {
    const normalizedFlowId = normalizeFlowId(flowId);
    if (!normalizedFlowId) return [];

    return readAttachmentDraftsForKey(newSessionAttachmentDraftKey(normalizedFlowId, scope));
}

export function writeNewSessionAttachmentDrafts(
    flowId: string | null | undefined,
    drafts: readonly AttachmentDraft[],
    scope: ServerAccountScope | null = getActiveServerAccountScope(),
): void {
    const normalizedFlowId = normalizeFlowId(flowId);
    if (!normalizedFlowId) return;

    writeAttachmentDraftsForKey(newSessionAttachmentDraftKey(normalizedFlowId, scope), drafts);
}

export function clearNewSessionAttachmentDrafts(
    flowId: string | null | undefined,
    scope: ServerAccountScope | null = getActiveServerAccountScope(),
): void {
    const normalizedFlowId = normalizeFlowId(flowId);
    if (!normalizedFlowId) return;
    clearAttachmentDraftsForKey(newSessionAttachmentDraftKey(normalizedFlowId, scope));
}

/** Mounted composers release their own sources when the draft owner removes the flow. */
export function subscribeNewSessionAttachmentDraftRemoval(
    flowId: string,
    onRemoved: () => void,
    scope: ServerAccountScope | null = getActiveServerAccountScope(),
): () => void {
    const normalizedFlowId = normalizeFlowId(flowId);
    if (!normalizedFlowId) return () => {};
    return subscribeAttachmentDraftsForKey(newSessionAttachmentDraftKey(normalizedFlowId, scope), event => {
        if (event === 'cleared') onRemoved();
    });
}

/** Accepted custody settles the detached Send, not files added to its successor draft. */
export function clearAcceptedNewSessionAttachmentDrafts(
    flowId: string | null | undefined,
    acceptedDrafts: readonly AttachmentDraft[],
    scope: ServerAccountScope | null = getActiveServerAccountScope(),
): readonly AttachmentDraft[] {
    const normalizedFlowId = normalizeFlowId(flowId);
    if (!normalizedFlowId) return [];
    const key = newSessionAttachmentDraftKey(normalizedFlowId, scope);
    return settleAttachmentDraftsForKey(key, acceptedDrafts);
}

export function clearAllNewSessionAttachmentDrafts(): void {
    clearAttachmentDraftsForKeyPrefix(NEW_SESSION_ATTACHMENT_DRAFT_KEY_PREFIX);
}
