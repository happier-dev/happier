import type { ApiMessage } from '@/sync/api/types/apiTypes';
import type { DecryptedMessage, Session } from '@/sync/domains/state/storageTypes';
import { readStoredSessionMessage } from '@/sync/runtime/readStoredSessionContent';
import { markStreamingMessagesAppliedForSessionUiTelemetry } from '@/sync/runtime/performance/sessionUiTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { normalizeRawMessage, type NormalizedMessage } from '@/sync/typesRaw';

export type TranscriptStreamSegmentSessionMessageEncryption = {
    decryptMessage: (message: ApiMessage) => Promise<DecryptedMessage | null>;
};

export type TranscriptStreamSegmentEphemeralUpdate = Readonly<{
    type: 'transcript-stream-segment';
    sessionId: string;
    message: Readonly<{
        localId: string;
        sidechainId?: string | null;
        content: ApiMessage['content'];
        createdAt: number;
        updatedAt: number;
    }>;
}>;

type TranscriptStreamSegmentTelemetryFields = Readonly<{
    encrypted: number;
    plain: number;
}>;

type HandleTranscriptStreamSegmentEphemeralUpdateParams = Readonly<{
    update: TranscriptStreamSegmentEphemeralUpdate;
    getSessionEncryption: (sessionId: string) => TranscriptStreamSegmentSessionMessageEncryption | null;
    getSession: (sessionId: string) => Session | undefined;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
}>;

async function applyTranscriptStreamSegmentEphemeralUpdate(
    params: HandleTranscriptStreamSegmentEphemeralUpdateParams,
    telemetryFields?: TranscriptStreamSegmentTelemetryFields,
): Promise<void> {
    const { update, getSessionEncryption, getSession, applyMessages } = params;
    const sessionId = update.sessionId;
    const session = getSession(sessionId);
    if (!session) {
        return;
    }

    const expectsEncryptedMessages = session.encryptionMode !== 'plain';
    const encryption = expectsEncryptedMessages ? getSessionEncryption(sessionId) : null;
    if (!encryption && expectsEncryptedMessages) {
        return;
    }

    const readMessage = () => readStoredSessionMessage({
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

    const decrypted = telemetryFields
        ? await syncPerformanceTelemetry.measureAsync(
            'sync.sessions.socket.transcriptStreamSegment.readMessage',
            telemetryFields,
            readMessage,
        )
        : await readMessage();
    if (!decrypted) {
        return;
    }
    if (!getSession(sessionId)) {
        return;
    }

    const normalizeMessage = () => normalizeRawMessage(
        update.message.localId,
        decrypted.localId,
        decrypted.createdAt,
        decrypted.content,
    );

    const normalized = telemetryFields
        ? syncPerformanceTelemetry.measure(
            'sync.sessions.socket.transcriptStreamSegment.normalize',
            telemetryFields,
            normalizeMessage,
        )
        : normalizeMessage();
    if (!normalized) {
        return;
    }

    applyMessages(sessionId, [normalized]);
    markStreamingMessagesAppliedForSessionUiTelemetry({
        sessionId,
        messages: [normalized],
        source: 'transcriptStreamSegment',
    });
    if (telemetryFields) {
        syncPerformanceTelemetry.count('sync.sessions.socket.transcriptStreamSegment.apply', {
            ...telemetryFields,
            normalized: 1,
        });
    }
}

export async function handleTranscriptStreamSegmentEphemeralUpdate(
    params: HandleTranscriptStreamSegmentEphemeralUpdateParams,
): Promise<void> {
    const { update } = params;
    if (!syncPerformanceTelemetry.isEnabled()) {
        return applyTranscriptStreamSegmentEphemeralUpdate(params);
    }

    const telemetryFields = {
        encrypted: update.message.content?.t === 'encrypted' ? 1 : 0,
        plain: update.message.content?.t === 'plain' ? 1 : 0,
    };

    return syncPerformanceTelemetry.measureAsync(
        'sync.sessions.socket.transcriptStreamSegment',
        telemetryFields,
        () => applyTranscriptStreamSegmentEphemeralUpdate(params, telemetryFields),
    );
}
