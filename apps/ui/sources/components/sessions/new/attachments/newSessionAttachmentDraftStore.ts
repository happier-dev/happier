import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import {
    clearAttachmentDraftsForKey,
    clearAttachmentDraftsForKeyPrefix,
    readAttachmentDraftsForKey,
    writeAttachmentDraftsForKey,
} from '@/components/sessions/attachments/attachmentDraftMemoryStore';

const NEW_SESSION_ATTACHMENT_DRAFT_KEY_PREFIX = 'new-session:';

function normalizeFlowId(flowId: string | null | undefined): string | null {
    if (typeof flowId !== 'string') return null;
    const trimmed = flowId.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function newSessionAttachmentDraftKey(flowId: string): string {
    return `${NEW_SESSION_ATTACHMENT_DRAFT_KEY_PREFIX}${flowId}`;
}

export function readNewSessionAttachmentDrafts(flowId: string | null | undefined): readonly AttachmentDraft[] {
    const normalizedFlowId = normalizeFlowId(flowId);
    if (!normalizedFlowId) return [];

    return readAttachmentDraftsForKey(newSessionAttachmentDraftKey(normalizedFlowId));
}

export function writeNewSessionAttachmentDrafts(
    flowId: string | null | undefined,
    drafts: readonly AttachmentDraft[],
): void {
    const normalizedFlowId = normalizeFlowId(flowId);
    if (!normalizedFlowId) return;

    writeAttachmentDraftsForKey(newSessionAttachmentDraftKey(normalizedFlowId), drafts);
}

export function clearNewSessionAttachmentDrafts(flowId: string | null | undefined): void {
    const normalizedFlowId = normalizeFlowId(flowId);
    if (!normalizedFlowId) return;
    clearAttachmentDraftsForKey(newSessionAttachmentDraftKey(normalizedFlowId));
}

export function clearAllNewSessionAttachmentDrafts(): void {
    clearAttachmentDraftsForKeyPrefix(NEW_SESSION_ATTACHMENT_DRAFT_KEY_PREFIX);
}
