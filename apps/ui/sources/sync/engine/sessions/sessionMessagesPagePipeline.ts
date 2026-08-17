import type { SessionMessageRole } from '@happier-dev/protocol';

import type { ApiMessage, ApiSessionMessagesResponse } from '@/sync/api/types/apiTypes';
import { ApiSessionMessagesResponseSchema } from '@/sync/api/types/apiTypes';
import { isLegacyMemoryArtifactTranscriptRow } from './legacyMemoryArtifactTranscriptRows';
import {
    readStoredSessionMessage,
    readStoredSessionRawRecord,
} from '@/sync/runtime/readStoredSessionContent';
import { writeSyncDebugLog } from '@/sync/runtime/syncDebugLogging';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
    createRawMessageNormalizationSequenceState,
    normalizeRawMessageInSequence,
    type NormalizedMessage,
} from '@/sync/typesRaw';
import { getTaskLifecycleEventFromRawContent, type TaskLifecycleEvent } from './taskLifecycle';
import {
    applyTranscriptObservationMetadata,
    isRecoveredHistoryTranscriptObservation,
} from '@/sync/domains/messages/transcriptObservationProvenance';
import {
    advanceSessionReceivedMessageCurrentness,
    isSessionMessageRowCurrent,
    type SessionReceivedMessages,
} from './sessionMessageCurrentness';

export type SessionMessagesEncryption = {
    decryptMessages: (messages: ApiMessage[]) => Promise<Array<DecryptedSessionMessage | null>>;
};

export type SessionMessagesEncryptionMode = 'e2ee' | 'plain';

export type DecryptedSessionMessage = Readonly<{
    id: string;
    seq?: number | null;
    localId: string | null;
    messageRole?: SessionMessageRole | null;
    content: unknown | null;
    createdAt: number;
}>;

export type MessageDecryptBatchOptions = {
    initialMessageDecryptBatchSize?: number;
    messageDecryptBatchSize?: number;
    messageDecryptYieldDelayMs?: number;
    yieldToMessageDecryptBatch?: (delayMs: number) => Promise<void>;
};

export type SessionMessagesPageOptions = MessageDecryptBatchOptions & {
    sessionEncryptionMode?: SessionMessagesEncryptionMode;
};

type MessagePageTelemetryKind = 'initial' | 'older' | 'newer';
type MessagePagePurpose = MessagePageTelemetryKind | 'target-window';
type MessagePageDirection = MessagePageTelemetryKind;
type MessagePageScope = 'main' | 'sidechain' | 'all';
type LifecyclePolicy = 'emit' | 'suppress';

type SessionMessagesPageRequest = Readonly<{
    direction: MessagePageDirection;
    requestPath: string;
    scope: MessagePageScope;
    sidechainId?: string | null;
    limit?: number;
    beforeSeq?: number;
    afterSeq?: number;
}>;

export type SessionMessagesPagePipelineResult = Readonly<{
    applied: number;
    page: ApiSessionMessagesResponse;
    appliedMessageIds: readonly string[];
    appliedSeqs: readonly number[];
    rawSeqs: readonly number[];
    normalizedMessages: readonly NormalizedMessage[];
    skippedMissingSession: boolean;
}>;

const DEFAULT_MESSAGE_DECRYPT_BATCH_SIZE = 8;
const DEFAULT_INITIAL_MESSAGE_DECRYPT_BATCH_SIZE = 64;

const plainSessionMessagesEncryption: SessionMessagesEncryption = {
    decryptMessages: async (messages) => Promise.all(
        messages.map((message) => readStoredSessionMessage({ message })),
    ),
};

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(1, Math.trunc(value));
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(0, Math.trunc(value));
}

function resolveMessageDecryptBatchSize(kind: MessagePageTelemetryKind, options: MessageDecryptBatchOptions): number {
    if (kind === 'initial') {
        return normalizePositiveInteger(
            options.initialMessageDecryptBatchSize ?? options.messageDecryptBatchSize,
            DEFAULT_INITIAL_MESSAGE_DECRYPT_BATCH_SIZE,
        );
    }
    return normalizePositiveInteger(options.messageDecryptBatchSize, DEFAULT_MESSAGE_DECRYPT_BATCH_SIZE);
}

function yieldToMessageDecryptBatch(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, delayMs);
    });
}

function resolveSessionMessagesEncryption(params: Readonly<{
    sessionId: string;
    sessionEncryptionMode?: SessionMessagesEncryptionMode;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
}>): SessionMessagesEncryption | null {
    if (params.sessionEncryptionMode === 'plain') {
        return plainSessionMessagesEncryption;
    }
    return params.getSessionEncryption(params.sessionId);
}

function messagePageTelemetryFields(
    purpose: MessagePagePurpose,
    fields: Record<string, number>,
): Record<string, number> {
    return {
        initial: purpose === 'initial' ? 1 : 0,
        older: purpose === 'older' ? 1 : 0,
        newer: purpose === 'newer' ? 1 : 0,
        targetWindow: purpose === 'target-window' ? 1 : 0,
        ...fields,
    };
}

function messagePageScopeTelemetryFields(
    purpose: MessagePagePurpose,
    scope: MessagePageScope,
    sidechainId: string | null,
    fields: Record<string, number> = {},
): Record<string, number> {
    return messagePageTelemetryFields(purpose, {
        scopeMain: scope === 'main' ? 1 : 0,
        scopeSidechain: scope === 'sidechain' ? 1 : 0,
        scopeAll: scope === 'all' ? 1 : 0,
        hasSidechainId: sidechainId ? 1 : 0,
        ...fields,
    });
}

async function fetchSessionMessagesPageWithTelemetry(params: Readonly<{
    purpose: MessagePagePurpose;
    request: (path: string) => Promise<Response>;
    page: SessionMessagesPageRequest;
}>): Promise<ApiSessionMessagesResponse> {
    const rangeFields: Record<string, number> = {};
    if (typeof params.page.limit === 'number' && Number.isFinite(params.page.limit)) {
        rangeFields.limit = Math.trunc(params.page.limit);
    }
    if (typeof params.page.beforeSeq === 'number' && Number.isFinite(params.page.beforeSeq)) {
        rangeFields.beforeSeq = Math.trunc(params.page.beforeSeq);
    }
    if (typeof params.page.afterSeq === 'number' && Number.isFinite(params.page.afterSeq)) {
        rangeFields.afterSeq = Math.trunc(params.page.afterSeq);
    }

    const requestFields = messagePageScopeTelemetryFields(
        params.purpose,
        params.page.scope,
        params.page.sidechainId ?? null,
        rangeFields,
    );
    const response = await syncPerformanceTelemetry.measureAsync(
        'sync.sessions.messages.request',
        requestFields,
        () => params.request(params.page.requestPath),
    );
    const json = await syncPerformanceTelemetry.measureAsync(
        'sync.sessions.messages.responseJson',
        {
            ...requestFields,
            status: typeof response.status === 'number' && Number.isFinite(response.status)
                ? Math.trunc(response.status)
                : 0,
        },
        () => response.json(),
    );
    const parsed = syncPerformanceTelemetry.measure(
        'sync.sessions.messages.parseResponse',
        requestFields,
        () => ApiSessionMessagesResponseSchema.safeParse(json),
    );
    if (!parsed.success) {
        throw new Error(`Invalid /messages response: ${parsed.error.message}`);
    }
    return parsed.data;
}

function recordMessagePageTelemetry(purpose: MessagePagePurpose, fetched: number): void {
    syncPerformanceTelemetry.count('sync.sessions.messages.page', messagePageTelemetryFields(purpose, { fetched }));
}

function recordMessageDedupeTelemetry(purpose: MessagePagePurpose, fetched: number, toDecrypt: number): void {
    syncPerformanceTelemetry.count('sync.sessions.messages.dedupe', messagePageTelemetryFields(purpose, {
        fetched,
        toDecrypt,
        skipped: Math.max(0, fetched - toDecrypt),
    }));
}

async function decryptMessagesInBatchesWithTelemetry(
    purpose: MessagePagePurpose,
    direction: MessagePageDirection,
    encryption: SessionMessagesEncryption,
    messages: ApiMessage[],
    options: MessageDecryptBatchOptions,
): Promise<Array<DecryptedSessionMessage | null>> {
    const batchSize = resolveMessageDecryptBatchSize(direction, options);
    return syncPerformanceTelemetry.measureAsync(
        'sync.sessions.messages.decrypt',
        messagePageTelemetryFields(purpose, {
            messages: messages.length,
            batchSize,
            yieldDelayMs: normalizeNonNegativeInteger(options.messageDecryptYieldDelayMs, 0),
        }),
        () => decryptMessagesInBatches(encryption, messages, options, batchSize),
    );
}

function recordMessageApplyTelemetry(
    purpose: MessagePagePurpose,
    decrypted: number,
    sessionId: string,
    normalizedMessages: NormalizedMessage[],
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void,
): void {
    syncPerformanceTelemetry.measure(
        'sync.sessions.messages.apply',
        messagePageTelemetryFields(purpose, {
            decrypted,
            normalized: normalizedMessages.length,
        }),
        () => applyMessages(sessionId, normalizedMessages),
    );
}

function measureMessageNormalization<T>(
    purpose: MessagePagePurpose,
    decrypted: number,
    normalize: () => T,
): T {
    return syncPerformanceTelemetry.measure(
        'sync.sessions.messages.normalize',
        messagePageTelemetryFields(purpose, { decrypted }),
        normalize,
    );
}

async function decryptMessagesInBatches(
    encryption: SessionMessagesEncryption,
    messages: ApiMessage[],
    options: MessageDecryptBatchOptions,
    batchSize: number,
): Promise<Array<DecryptedSessionMessage | null>> {
    if (messages.length === 0) return [];

    if (batchSize >= messages.length) {
        return encryption.decryptMessages(messages);
    }

    const yieldDelayMs = normalizeNonNegativeInteger(options.messageDecryptYieldDelayMs, 0);
    const yieldBetweenBatches = options.yieldToMessageDecryptBatch ?? yieldToMessageDecryptBatch;
    const decryptedMessages: Array<DecryptedSessionMessage | null> = [];

    for (let start = 0; start < messages.length; start += batchSize) {
        if (start > 0) {
            await yieldBetweenBatches(yieldDelayMs);
        }
        const batch = messages.slice(start, start + batchSize);
        decryptedMessages.push(...await encryption.decryptMessages(batch));
    }

    return decryptedMessages;
}

function applySidechainScopeMetadata(params: Readonly<{
    normalizedMessage: NormalizedMessage;
    inputSidechainId: unknown;
    scope?: MessagePageScope;
    requestedSidechainId?: string | null;
}>): void {
    const inputSidechainId = typeof params.inputSidechainId === 'string' && params.inputSidechainId.trim().length > 0
        ? params.inputSidechainId.trim()
        : null;
    const requestedSidechainId = typeof params.requestedSidechainId === 'string' && params.requestedSidechainId.trim().length > 0
        ? params.requestedSidechainId.trim()
        : null;
    const resolvedSidechainId = inputSidechainId ?? (params.scope === 'sidechain' ? requestedSidechainId : null);
    if (!resolvedSidechainId) return;
    params.normalizedMessage.sidechainId = resolvedSidechainId;
    params.normalizedMessage.isSidechain = true;
}

function orderedMessagesForDirection(
    messages: readonly ApiMessage[],
    direction: MessagePageDirection,
): ApiMessage[] {
    return direction === 'newer' ? [...messages] : [...messages].reverse();
}

function emptyPageForDirection(direction: MessagePageDirection): ApiSessionMessagesResponse {
    if (direction === 'newer') {
        return {
            messages: [],
            nextAfterSeq: null,
        };
    }
    return {
        messages: [],
        hasMore: false,
        nextBeforeSeq: null,
    };
}

function skippedMissingSessionResult(direction: MessagePageDirection): SessionMessagesPagePipelineResult {
    return {
        applied: 0,
        page: emptyPageForDirection(direction),
        appliedMessageIds: [],
        appliedSeqs: [],
        rawSeqs: [],
        normalizedMessages: [],
        skippedMissingSession: true,
    };
}

export async function runSessionMessagesPagePipeline(params: {
    sessionId: string;
    purpose: MessagePagePurpose;
    page: SessionMessagesPageRequest;
    lifecyclePolicy: LifecyclePolicy;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    isSessionKnown?: (sessionId: string) => boolean;
    /** Exact server rows whose hidden message-updated event authorized replacement. */
    authoritativeUpdateMessageIds?: ReadonlySet<string>;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: SessionReceivedMessages;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onTaskLifecycleEvent?: (event: TaskLifecycleEvent) => void;
    onMessagesPage?: (page: ApiSessionMessagesResponse) => void;
    onNormalizedMessages?: (messages: NormalizedMessage[]) => void;
    log: { log: (message: string) => void };
} & SessionMessagesPageOptions): Promise<SessionMessagesPagePipelineResult> {
    if (params.isSessionKnown?.(params.sessionId) === false) {
        writeSyncDebugLog(params.log, `💬 session message page: Session ${params.sessionId} is not known on this server; skipping page fetch`);
        return skippedMissingSessionResult(params.page.direction);
    }

    const encryption = resolveSessionMessagesEncryption(params);
    if (!encryption) {
        throw new Error(`Session encryption not ready for ${params.sessionId}`);
    }

    const data = await fetchSessionMessagesPageWithTelemetry({
        purpose: params.purpose,
        request: params.request,
        page: params.page,
    });
    recordMessagePageTelemetry(params.purpose, data.messages.length);

    // A held response can arrive after local delete/share-revocation. Do not
    // allocate a currentness owner or spend decrypt work for a session that no
    // longer belongs to this Sync scope; the post-decrypt fence below covers a
    // second retirement race while decryption itself is in flight.
    if (params.isSessionKnown?.(params.sessionId) === false) {
        writeSyncDebugLog(params.log, `💬 session message page: Session ${params.sessionId} disappeared before page decrypt; dropping response`);
        return skippedMissingSessionResult(params.page.direction);
    }

    // Reading must not allocate the shared row-watermark owner. It is created
    // only after a reducer application below; otherwise a delete during
    // decrypt leaves an orphan empty map behind.
    const existingMessages = params.sessionReceivedMessages.get(params.sessionId);

    const messagesToDecrypt: ApiMessage[] = [];
    for (const msg of orderedMessagesForDirection(data.messages, params.page.direction)) {
        const msgUpdatedAt = typeof msg.updatedAt === 'number' ? msg.updatedAt : msg.createdAt;
        const existingUpdatedAt = existingMessages?.get(msg.id);
        // A hidden `message-updated` event names the exact durable row whose
        // correction must reach the reducer. An earlier background page can
        // already have recorded this timestamp while its unmarked delivery was
        // intentionally inert, so the exact marker narrowly bypasses the
        // timestamp dedupe only for the same revision. It never authorizes an
        // older page row to replace a newer current row.
        const isAuthoritativeUpdate = params.authoritativeUpdateMessageIds?.has(msg.id) === true;
        if (isSessionMessageRowCurrent({
            existingUpdatedAt,
            incomingUpdatedAt: msgUpdatedAt,
            isAuthoritativeUpdate,
        })) {
            messagesToDecrypt.push(msg);
        }
    }
    recordMessageDedupeTelemetry(params.purpose, data.messages.length, messagesToDecrypt.length);

    const decryptedMessages = await decryptMessagesInBatchesWithTelemetry(
        params.purpose,
        params.page.direction,
        encryption,
        messagesToDecrypt,
        params,
    );
    const replayableMessages = await Promise.all(decryptedMessages.map(async (decrypted) => {
        if (!decrypted) return null;
        return {
            ...decrypted,
            content: await readStoredSessionRawRecord({ content: decrypted.content }),
        };
    }));
    // The request can outlive a delete/share-revocation. Recheck after the
    // asynchronous decrypt boundary and before any page or transcript state is
    // published so an old response cannot recreate a deleted session.
    if (params.isSessionKnown?.(params.sessionId) === false) {
        writeSyncDebugLog(params.log, `💬 session message page: Session ${params.sessionId} disappeared before page apply; dropping response`);
        return skippedMissingSessionResult(params.page.direction);
    }
    params.onMessagesPage?.(data);

    const normalizedMessages: NormalizedMessage[] = [];
    const appliedRowCurrentness: Array<Readonly<{ messageId: string; updatedAt: number }>> = [];
    const normalizationState = createRawMessageNormalizationSequenceState();
    measureMessageNormalization(params.purpose, replayableMessages.length, () => {
        for (let i = 0; i < replayableMessages.length; i++) {
            const decrypted = replayableMessages[i];
            if (!decrypted) continue;

            const inputMessage = messagesToDecrypt[i];
            const inputUpdatedAt = inputMessage
                ? (typeof inputMessage.updatedAt === 'number' ? inputMessage.updatedAt : inputMessage.createdAt)
                : decrypted.createdAt;
            const isAuthoritativeUpdate = inputMessage !== undefined
                && params.authoritativeUpdateMessageIds?.has(inputMessage.id) === true;
            const currentUpdatedAt = params.sessionReceivedMessages
                .get(params.sessionId)
                ?.get(decrypted.id);
            // Decryption yields, so a newer same-row socket/page delivery can
            // advance the shared currentness watermark after the first filter.
            // Recheck at the apply boundary; an exact stale marker admits only
            // an equal revision, never a time-travel overwrite.
            if (!isSessionMessageRowCurrent({
                existingUpdatedAt: currentUpdatedAt,
                incomingUpdatedAt: inputUpdatedAt,
                isAuthoritativeUpdate,
            })) {
                continue;
            }
            if (decrypted.content === null) {
                continue;
            }
            if (isLegacyMemoryArtifactTranscriptRow(decrypted)) {
                continue;
            }
            if (params.lifecyclePolicy === 'emit' && !isRecoveredHistoryTranscriptObservation(inputMessage)) {
                const lifecycleEvent = getTaskLifecycleEventFromRawContent(decrypted.content, decrypted.createdAt);
                if (lifecycleEvent) {
                    params.onTaskLifecycleEvent?.(lifecycleEvent);
                }
            }
            const normalized = normalizeRawMessageInSequence({
                id: decrypted.id,
                localId: decrypted.localId,
                createdAt: decrypted.createdAt,
                raw: decrypted.content,
                seq: decrypted.seq ?? undefined,
                messageRole: decrypted.messageRole ?? undefined,
            }, normalizationState);
            if (normalized) {
                applyTranscriptObservationMetadata(normalized, inputMessage);
                if (params.authoritativeUpdateMessageIds?.has(normalized.id)) {
                    normalized.isAuthoritativeUpdate = true;
                }
                applySidechainScopeMetadata({
                    normalizedMessage: normalized,
                    inputSidechainId: inputMessage?.sidechainId,
                    scope: params.page.scope,
                    requestedSidechainId: params.page.sidechainId ?? null,
                });
                normalizedMessages.push(normalized);
                appliedRowCurrentness.push({
                    messageId: normalized.id,
                    updatedAt: inputUpdatedAt,
                });
            }
        }
    });

    params.onNormalizedMessages?.(normalizedMessages);
    recordMessageApplyTelemetry(
        params.purpose,
        replayableMessages.length,
        params.sessionId,
        normalizedMessages,
        params.applyMessages,
    );
    // The watermark represents a reducer-applied transcript row, not a fetched
    // or merely normalized one. Publishing it after the apply keeps a rejected
    // row retryable and prevents legacy/null/normalization skips from poisoning
    // later authoritative delivery.
    for (const row of appliedRowCurrentness) {
        advanceSessionReceivedMessageCurrentness(
            params.sessionReceivedMessages,
            params.sessionId,
            row.messageId,
            row.updatedAt,
        );
    }

    return {
        applied: normalizedMessages.length,
        page: data,
        appliedMessageIds: normalizedMessages.map((message) => message.id),
        appliedSeqs: normalizedMessages
            .map((message) => message.seq)
            .filter((seq): seq is number => typeof seq === 'number' && Number.isFinite(seq)),
        rawSeqs: data.messages
            .map((message) => message.seq)
            .filter((seq): seq is number => typeof seq === 'number' && Number.isFinite(seq)),
        normalizedMessages,
        skippedMissingSession: false,
    };
}
