import type { ApiEphemeralUpdate } from '@/sync/api/types/apiTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionEncryption } from '@/sync/encryption/sessionEncryption';
import { readStoredSessionMessage } from '@/sync/runtime/readStoredSessionContent';
import { markStreamingMessagesAppliedForSessionUiTelemetry } from '@/sync/runtime/performance/sessionUiTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import type { NormalizedMessage, RawMessageNormalizationSequenceState } from '@/sync/typesRaw';
import { normalizeRawMessage, normalizeRawMessageInSequence } from '@/sync/typesRaw';
import { isLegacyMemoryArtifactTranscriptRow } from './legacyMemoryArtifactTranscriptRows';
import {
    applyTranscriptStreamSegmentDelta,
    evictTranscriptStreamSegmentAssembly,
    isTranscriptStreamSegmentAssemblyReady,
    noteTranscriptStreamSegmentSnapshot,
    readTranscriptStreamSegmentText,
    withTranscriptStreamSegmentText,
} from './transcriptStreamSegmentAssembly';

export type TranscriptStreamSegmentEphemeralUpdate = Extract<ApiEphemeralUpdate, { type: 'transcript-stream-segment' }>;
export type TranscriptStreamSegmentDeltaEphemeralUpdate = Extract<ApiEphemeralUpdate, { type: 'transcript-stream-segment-delta' }>;
export type AnyTranscriptStreamSegmentEphemeralUpdate =
    | TranscriptStreamSegmentEphemeralUpdate
    | TranscriptStreamSegmentDeltaEphemeralUpdate;

export type TranscriptStreamSegmentSessionMessageEncryption = Pick<SessionEncryption, 'decryptMessage'>;

type TranscriptStreamSegmentTelemetryFields = Readonly<{
    encrypted: number;
    plain: number;
    activeViewingSession: number;
    backgroundSession: number;
}>;

type HandleTranscriptStreamSegmentEphemeralUpdateParams = Readonly<{
    update: AnyTranscriptStreamSegmentEphemeralUpdate;
    getSessionEncryption: (sessionId: string) => TranscriptStreamSegmentSessionMessageEncryption | null;
    getSession: (sessionId: string) => Session | undefined;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    rawMessageNormalizationState?: RawMessageNormalizationSequenceState;
    isSessionActivelyViewed?: (sessionId: string) => boolean;
    skipWhenHidden?: boolean;
}>;

async function applyTranscriptStreamSegmentEphemeralUpdate(
    params: HandleTranscriptStreamSegmentEphemeralUpdateParams,
    telemetryFields?: TranscriptStreamSegmentTelemetryFields,
): Promise<void> {
    const { update, getSessionEncryption, getSession, applyMessages } = params;
    const sessionId = update.sessionId;
    const isDelta = update.type === 'transcript-stream-segment-delta';
    const session = getSession(sessionId);
    if (!session) {
        return;
    }

    // Deltas can only be chained onto known, in-sync assembly state. Check before decrypting so
    // undecodable deltas cost nothing; the next full-snapshot checkpoint resyncs the segment.
    if (isDelta && !isTranscriptStreamSegmentAssemblyReady(sessionId, update.message.localId)) {
        if (telemetryFields) {
            syncPerformanceTelemetry.count('sync.sessions.socket.transcriptStreamSegmentDelta.droppedUnchained', telemetryFields);
        }
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
            messageRole: update.message.messageRole ?? undefined,
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
    if (isLegacyMemoryArtifactTranscriptRow(decrypted)) {
        return;
    }

    let contentForNormalize = decrypted.content;
    if (update.type === 'transcript-stream-segment-delta') {
        const deltaText = readTranscriptStreamSegmentText(decrypted.content);
        if (deltaText === null) {
            // A delta that does not carry chainable text cannot be reconstructed; wait for the
            // next full snapshot instead of guessing.
            evictTranscriptStreamSegmentAssembly(sessionId, update.message.localId);
            return;
        }
        const assembledText = applyTranscriptStreamSegmentDelta({
            sessionId,
            localId: update.message.localId,
            deltaText,
            tick: update.message.tick,
            baseLength: update.message.baseLength,
        });
        if (assembledText === null) {
            if (telemetryFields) {
                syncPerformanceTelemetry.count('sync.sessions.socket.transcriptStreamSegmentDelta.droppedUnchained', telemetryFields);
            }
            return;
        }
        const patched = decrypted.content
            ? withTranscriptStreamSegmentText(decrypted.content, assembledText)
            : null;
        if (!patched) {
            evictTranscriptStreamSegmentAssembly(sessionId, update.message.localId);
            return;
        }
        contentForNormalize = patched;
    } else {
        noteTranscriptStreamSegmentSnapshot({
            sessionId,
            localId: update.message.localId,
            record: decrypted.content,
            tick: typeof update.message.tick === 'number' ? update.message.tick : null,
        });
    }

    const normalizeMessage = () => params.rawMessageNormalizationState
        ? normalizeRawMessageInSequence({
            id: update.message.localId,
            localId: decrypted.localId,
            createdAt: decrypted.createdAt,
            raw: contentForNormalize,
            messageRole: decrypted.messageRole ?? undefined,
        }, params.rawMessageNormalizationState)
        : normalizeRawMessage(
            update.message.localId,
            decrypted.localId,
            decrypted.createdAt,
            contentForNormalize,
            { messageRole: decrypted.messageRole ?? undefined },
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
    const hasVisibilitySignal = typeof params.isSessionActivelyViewed === 'function';
    const sessionActivelyViewed = params.isSessionActivelyViewed?.(update.sessionId) === true;
    const shouldSkipHidden = params.skipWhenHidden === true && hasVisibilitySignal && !sessionActivelyViewed;
    if (!syncPerformanceTelemetry.isEnabled()) {
        if (shouldSkipHidden) {
            return;
        }
        return applyTranscriptStreamSegmentEphemeralUpdate(params);
    }

    const telemetryFields = {
        encrypted: update.message.content?.t === 'encrypted' ? 1 : 0,
        plain: update.message.content?.t === 'plain' ? 1 : 0,
        activeViewingSession: sessionActivelyViewed ? 1 : 0,
        backgroundSession: hasVisibilitySignal && !sessionActivelyViewed ? 1 : 0,
    };

    if (shouldSkipHidden) {
        return syncPerformanceTelemetry.measureAsync(
            'sync.sessions.socket.transcriptStreamSegment',
            { ...telemetryFields, skippedHidden: 1 },
            async () => {},
        );
    }

    return syncPerformanceTelemetry.measureAsync(
        'sync.sessions.socket.transcriptStreamSegment',
        telemetryFields,
        () => applyTranscriptStreamSegmentEphemeralUpdate(params, telemetryFields),
    );
}
