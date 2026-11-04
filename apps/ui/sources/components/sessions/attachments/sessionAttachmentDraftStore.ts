import type { AttachmentDraft } from './attachmentDraftModel';
import {
    clearAttachmentDraftsForKey,
    readAttachmentDraftsForKey,
    writeAttachmentDraftsForKey,
    bindAttachmentDraftPersistence,
} from './attachmentDraftMemoryStore';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { composerRefV1Key } from '@happier-dev/protocol/plugins/ui/composerRef';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';

export type SessionAttachmentDraftScope = Readonly<{
    serverId: string;
    /** Exact signed-in Account that owns these device-local attachment sources. */
    accountId: string;
    sessionId: string;
    /** Exact Run id or rowless/first-send occurrence that owns these local bytes. */
    occurrenceId: string;
}>;

/** The existing Session composer occurrence is deterministic even while unmounted. */
export function resolveSessionAttachmentDraftScope(sessionTarget: ExactSessionMachineTargetIdentity): SessionAttachmentDraftScope {
    return { ...sessionTarget, occurrenceId: composerRefV1Key({ kind: 'session', sessionId: sessionTarget.sessionId }) };
}

export function sessionAttachmentDraftKey(scope: SessionAttachmentDraftScope): string {
    // Reuse the canonical Account and Session identity encoders. The occurrence
    // is an opaque Run/first-send identity, never parsed back out. File bytes
    // must never cross an Account switch even when Home, Session, and Run ids
    // happen to be identical.
    const key = `session-target:${JSON.stringify([
        serverAccountScopeKeySuffix(scope),
        sessionAddressKey(scope),
        scope.occurrenceId,
    ])}`;
    bindAttachmentDraftPersistence(key, scope);
    return key;
}

export function readSessionAttachmentDrafts(scope: SessionAttachmentDraftScope): AttachmentDraft[] {
    return readAttachmentDraftsForKey(sessionAttachmentDraftKey(scope));
}

export function writeSessionAttachmentDrafts(scope: SessionAttachmentDraftScope, drafts: readonly AttachmentDraft[]): void {
    writeAttachmentDraftsForKey(sessionAttachmentDraftKey(scope), drafts);
}

export function clearSessionAttachmentDrafts(scope: SessionAttachmentDraftScope): void {
    clearAttachmentDraftsForKey(sessionAttachmentDraftKey(scope));
}
