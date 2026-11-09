import type { SessionEncryptionMode} from '@happier-dev/protocol/encryption/storagePolicyDecisions';
import type { SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';

import type { DecryptedMessage } from '@/sync/domains/state/storageTypes';
import type { NormalizedMessage } from "@happier-dev/session-core/raw";
import { normalizeRawMessage } from "@happier-dev/session-core/raw";
import { ingestWorkspaceMutationMessages } from '@/scm/refresh/workspaceMutationIngestionRuntime';
import { readStoredSessionMessage } from '@/sync/runtime/readStoredSessionContent';
import { resolveSessionScmMutationSignal } from '@/sync/runtime/sessionLiveConsumption';

type SessionMessageEncryption = Readonly<{
    decryptMessage: (message: SessionMessageV1) => Promise<DecryptedMessage | null>;
}>;

export type DeliverHiddenSessionScmMutationSignalParams = Readonly<{
    sessionId: string;
    /** Home the realtime update arrived on; the mounted SCM scope must match it. */
    serverId?: string | null;
    rawMessage: SessionMessageV1 | undefined;
    sessionEncryptionMode: SessionEncryptionMode;
    getSessionEncryption: (sessionId: string) => SessionMessageEncryption | null;
    shouldContinue?: () => boolean;
    /** Test seam mirroring the workspace-mutation ingestion; production uses the runtime singleton. */
    ingestMessages?: (sessionId: string, messages: readonly NormalizedMessage[], serverId?: string | null) => void;
}>;

/**
 * SCM workspace-mutation side channel for hidden sessions whose durable socket updates are
 * routed projection-only (no transcript decrypt + reducer + store apply).
 *
 * Mounted SCM consumers (changed-files/git views) still need to know when a hidden same-project
 * session's agent mutates files so the project git snapshot refreshes promptly. Instead of making
 * those sessions full transcript consumers, this reads the single durable message envelope
 * (plain parse, or a targeted single-message decrypt for e2ee sessions), normalizes it with the
 * pure normalizer, and feeds the existing workspace-mutation ingestion (debounce + rate limits
 * unchanged). It never hydrates the hidden session's transcript in the store.
 */
export async function deliverHiddenSessionScmMutationSignal(
    params: DeliverHiddenSessionScmMutationSignalParams,
): Promise<void> {
    if (params.shouldContinue?.() === false) return;
    const rawMessage = params.rawMessage;
    if (!rawMessage) return;

    // Workspace mutations only come from agent tool activity; skip user/event rows before
    // resolving scopes or touching the encryption boundary.
    const messageRole = rawMessage.messageRole ?? null;
    if (messageRole === 'user' || messageRole === 'event') return;

    if (!resolveSessionScmMutationSignal(params.sessionId, params.serverId)) return;

    const encryption = params.getSessionEncryption(params.sessionId);
    const decrypted = await readStoredSessionMessage({
        message: rawMessage,
        sessionEncryptionMode: params.sessionEncryptionMode,
        decryptMessage: encryption ? (message) => encryption.decryptMessage(message) : undefined,
    });
    if (!decrypted || params.shouldContinue?.() === false
        || !resolveSessionScmMutationSignal(params.sessionId, params.serverId)) return;

    const normalized = normalizeRawMessage(
        decrypted.id,
        decrypted.localId,
        decrypted.createdAt,
        decrypted.content,
        {
            seq: typeof decrypted.seq === 'number' && Number.isFinite(decrypted.seq)
                ? Math.trunc(decrypted.seq)
                : (typeof rawMessage.seq === 'number' && Number.isFinite(rawMessage.seq)
                    ? Math.trunc(rawMessage.seq)
                    : undefined),
            messageRole: decrypted.messageRole ?? undefined,
        },
    );
    if (!normalized) return;

    (params.ingestMessages ?? ingestWorkspaceMutationMessages)(params.sessionId, [normalized], params.serverId);
}
