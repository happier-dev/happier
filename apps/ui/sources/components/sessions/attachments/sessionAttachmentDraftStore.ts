import type { AttachmentDraft } from './attachmentDraftModel';
import {
    clearAttachmentDraftsForKey,
    readAttachmentDraftsForKey,
    writeAttachmentDraftsForKey,
} from './attachmentDraftMemoryStore';

function sessionAttachmentDraftKey(sessionId: string): string {
    return `session:${sessionId}`;
}

export function readSessionAttachmentDrafts(sessionId: string): AttachmentDraft[] {
    return readAttachmentDraftsForKey(sessionAttachmentDraftKey(sessionId));
}

export function writeSessionAttachmentDrafts(sessionId: string, drafts: readonly AttachmentDraft[]): void {
    writeAttachmentDraftsForKey(sessionAttachmentDraftKey(sessionId), drafts);
}

export function clearSessionAttachmentDrafts(sessionId: string): void {
    clearAttachmentDraftsForKey(sessionAttachmentDraftKey(sessionId));
}
