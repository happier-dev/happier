import type { ApiEphemeralUpdate } from '@/sync/api/types/apiTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionEncryption } from '@/sync/encryption/sessionEncryption';
import { readStoredSessionMessage } from '@/sync/runtime/readStoredSessionContent';
import type { NormalizedMessage } from '@/sync/typesRaw';
import { normalizeRawMessage } from '@/sync/typesRaw';

type TranscriptStreamSegmentEphemeralUpdate = Extract<ApiEphemeralUpdate, { type: 'transcript-stream-segment' }>;

type SessionMessageEncryption = Pick<SessionEncryption, 'decryptMessage'>;

export async function handleTranscriptStreamSegmentEphemeralUpdate(params: Readonly<{
    update: TranscriptStreamSegmentEphemeralUpdate;
    getSessionEncryption: (sessionId: string) => SessionMessageEncryption | null;
    getSession: (sessionId: string) => Session | undefined;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
}>): Promise<void> {
    const { update, getSessionEncryption, getSession, applyMessages } = params;
    const sessionId = update.sessionId;
    const session = getSession(sessionId);
    if (!session) {
        return;
    }

    const encryption = getSessionEncryption(sessionId);
    const expectsEncryptedMessages = session.encryptionMode !== 'plain';
    if (!encryption && expectsEncryptedMessages) {
        return;
    }

    const decrypted = await readStoredSessionMessage({
        message: {
            id: update.message.localId,
            seq: 0,
            localId: update.message.localId,
            ...(typeof update.message.sidechainId === 'string' ? { sidechainId: update.message.sidechainId } : {}),
            content: update.message.content,
            createdAt: update.message.createdAt,
            updatedAt: update.message.updatedAt,
        },
        decryptMessage: encryption ? (message) => encryption.decryptMessage(message) : undefined,
    });
    if (!decrypted) {
        return;
    }

    const normalized = normalizeRawMessage(
        update.message.localId,
        decrypted.localId,
        decrypted.createdAt,
        decrypted.content,
    );
    if (!normalized) {
        return;
    }

    applyMessages(sessionId, [normalized]);
}
