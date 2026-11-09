import type { SessionMessageV1, SessionMessagesPageV1} from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import type { SessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { fetchSessionMessagesPage } from '@happier-dev/sync-client';
import type { DecryptOptions } from '@/sync/encryption/encryptor';
import { createSessionEncryptionUnavailableError } from '@/sync/encryption/sessionEncryptionUnavailableError';
import { applyTranscriptAccountActorMetadata, qualifyTranscriptAccountActor } from "@happier-dev/session-core/messages";
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
    type RawRecord,
} from "@happier-dev/session-core/raw";
import { getTaskLifecycleEventFromRawContent, type TaskLifecycleEvent } from './taskLifecycle';
import { socketTranscriptStreamSegmentAssembler } from '@/sync/engine/socket/socketTranscriptStreamSegmentAssembler';
import {
    applyTranscriptObservationMetadata,
    isRecoveredHistoryTranscriptObservation,
    type TranscriptMessageMetadataUpdate,
} from "@happier-dev/session-core/messages";
import {
    advanceSessionReceivedMessageCurrentness,
    isSessionMessageRowCurrent,
    type SessionReceivedMessages,
} from "@happier-dev/session-core/transcript";

export type SessionMessagesEncryption = {
    decryptMessages: (messages: SessionMessageV1[], options?: DecryptOptions) => Promise<Array<DecryptedSessionMessage | null>>;
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
    applyMessageMetadata?: (sessionId: string, updates: readonly TranscriptMessageMetadataUpdate[]) => void;
    isCurrent?: () => boolean;
    sessionEncryptionMode?: SessionMessagesEncryptionMode;
    onContentAuthenticationFailure?: (encryption: SessionMessagesEncryption) => void;
    serverId?: string | null;
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
    page: SessionMessagesPageV1;
    appliedMessageIds: readonly string[];
    appliedSeqs: readonly number[];
    rawSeqs: readonly number[];
    normalizedMessages: readonly NormalizedMessage[];
    skippedMissingSession: boolean;
    skippedSuperseded?: boolean;
}>;

export class SessionMessagePageDecryptionError extends Error {
    readonly cause?: unknown;

    constructor(sessionId: string, cause?: unknown) {
        super(`Session message page decryption incomplete for ${sessionId}`);
        this.name = 'SessionMessagePageDecryptionError';
        this.cause = cause;
    }
}

export class SessionMessagePageResponseError extends Error {
    readonly code: 'http_error' | 'invalid_response';
    readonly stage: 'response' | 'response_json' | 'parse';
    readonly status?: number;
    readonly cause?: unknown;

    constructor(params: Readonly<{
        code: 'http_error' | 'invalid_response';
        stage: 'response' | 'response_json' | 'parse';
        message: string;
        status?: number;
        cause?: unknown;
    }>) {
        super(params.message);
        this.name = 'SessionMessagePageResponseError';
        this.code = params.code;
        this.stage = params.stage;
        this.status = params.status;
        this.cause = params.cause;
    }
}

const DEFAULT_MESSAGE_DECRYPT_BATCH_SIZE = 8;
const DEFAULT_INITIAL_MESSAGE_DECRYPT_BATCH_SIZE = 64;

const plainSessionMessagesEncryption: SessionMessagesEncryption = {
    decryptMessages: async (messages) => Promise.all(
        messages.map((message) => readStoredSessionMessage({ message, sessionEncryptionMode: 'plain' })),
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
    sessionId: string;
    purpose: MessagePagePurpose;
    request: (path: string) => Promise<Response>;
    page: SessionMessagesPageRequest;
}>): Promise<SessionMessagesPageV1> {
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
    return fetchSessionMessagesPage({
        sessionId: params.sessionId,
        scope: params.page.scope,
        path: params.page.requestPath,
        requestJson: async (path) => {
            const response = await syncPerformanceTelemetry.measureAsync(
                'sync.sessions.messages.request',
                requestFields,
                () => params.request(path),
            );
            if (!response.ok) {
                throw new SessionMessagePageResponseError({
                    code: 'http_error', stage: 'response', status: response.status,
                    message: `Session messages request failed with HTTP ${response.status}`,
                });
            }
            let json: unknown;
            try {
                json = await syncPerformanceTelemetry.measureAsync(
                    'sync.sessions.messages.responseJson',
                    {
                        ...requestFields,
                        status: typeof response.status === 'number' && Number.isFinite(response.status)
                            ? Math.trunc(response.status)
                            : 0,
                    },
                    () => response.json(),
                );
            } catch (cause) {
                throw new SessionMessagePageResponseError({
                    code: 'invalid_response', stage: 'response_json',
                    message: 'Session messages response is not valid JSON', cause,
                });
            }
            return json;
        },
        onParse: (parse) => syncPerformanceTelemetry.measure(
            'sync.sessions.messages.parseResponse',
            requestFields,
            () => {
                try {
                    return parse();
                } catch (cause) {
                    throw new SessionMessagePageResponseError({
                        code: 'invalid_response', stage: 'parse',
                        message: cause instanceof Error ? cause.message : 'Invalid /messages response',
                        cause,
                    });
                }
            },
        ),
    });
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
    messages: SessionMessageV1[],
    options: MessageDecryptBatchOptions & Pick<DecryptOptions, 'onAuthenticationFailure'> & Pick<SessionMessagesPageOptions, 'isCurrent'>,
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
    messages: SessionMessageV1[],
    options: MessageDecryptBatchOptions & Pick<DecryptOptions, 'onAuthenticationFailure'> & Pick<SessionMessagesPageOptions, 'isCurrent'>,
    batchSize: number,
): Promise<Array<DecryptedSessionMessage | null>> {
    if (messages.length === 0 || options.isCurrent?.() === false) return [];

    if (batchSize >= messages.length) {
        return encryption.decryptMessages(messages, { onAuthenticationFailure: options.onAuthenticationFailure });
    }

    const yieldDelayMs = normalizeNonNegativeInteger(options.messageDecryptYieldDelayMs, 0);
    const yieldBetweenBatches = options.yieldToMessageDecryptBatch ?? yieldToMessageDecryptBatch;
    const decryptedMessages: Array<DecryptedSessionMessage | null> = [];

    for (let start = 0; start < messages.length; start += batchSize) {
        if (options.isCurrent?.() === false) break;
        if (start > 0) {
            await yieldBetweenBatches(yieldDelayMs);
        }
        if (options.isCurrent?.() === false) break;
        const batch = messages.slice(start, start + batchSize);
        decryptedMessages.push(...await encryption.decryptMessages(batch, {
            onAuthenticationFailure: (index) => options.onAuthenticationFailure?.(start + index),
        }));
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
    messages: readonly SessionMessageV1[],
    direction: MessagePageDirection,
): SessionMessageV1[] {
    return direction === 'newer' ? [...messages] : [...messages].reverse();
}

function emptyPageForDirection(direction: MessagePageDirection): SessionMessagesPageV1 {
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

function skippedSupersededResult(direction: MessagePageDirection): SessionMessagesPagePipelineResult {
    return { ...skippedMissingSessionResult(direction), skippedMissingSession: false, skippedSuperseded: true };
}

export async function runSessionMessagesPagePipeline(params: {
    sessionId: string;
    purpose: MessagePagePurpose;
    page: SessionMessagesPageRequest;
    lifecyclePolicy: LifecyclePolicy;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    isSessionKnown?: (sessionId: string) => boolean;
    shouldContinue?: () => boolean;
    /** Sparse repair admits named rows and already-materialized neighbors, never unseen spill rows. */
    messageIds?: ReadonlySet<string>;
    isMessageMaterialized?: (messageId: string, localId: string | null) => boolean;
    /** Exact server rows whose hidden message-updated event authorized replacement. */
    authoritativeUpdateMessageIds?: ReadonlySet<string>;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: SessionReceivedMessages;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onTaskLifecycleEvent?: (event: TaskLifecycleEvent) => void;
    onMessagesPage?: (page: SessionMessagesPageV1) => void;
    onNormalizedMessages?: (messages: NormalizedMessage[]) => void;
    log: { log: (message: string) => void };
} & SessionMessagesPageOptions): Promise<SessionMessagesPagePipelineResult> {
    if (params.isSessionKnown?.(params.sessionId) === false) {
        writeSyncDebugLog(params.log, `💬 session message page: Session ${params.sessionId} is not known on this server; skipping page fetch`);
        return skippedMissingSessionResult(params.page.direction);
    }
    if (params.shouldContinue?.() === false) {
        return skippedSupersededResult(params.page.direction);
    }

    const encryption = resolveSessionMessagesEncryption(params);
    if (!encryption) {
        throw createSessionEncryptionUnavailableError(params.sessionId);
    }
    const isCurrent = () => params.isCurrent?.() !== false && params.isSessionKnown?.(params.sessionId) !== false
        && resolveSessionMessagesEncryption(params) === encryption;

    const data = await fetchSessionMessagesPageWithTelemetry({
        sessionId: params.sessionId,
        purpose: params.purpose,
        request: params.request,
        page: params.page,
    });
    recordMessagePageTelemetry(params.purpose, data.messages.length);

    // A held response can arrive after local delete/share-revocation. Do not
    // allocate a currentness owner or spend decrypt work for a session that no
    // longer belongs to this Sync scope; the post-decrypt fence below covers a
    // second retirement race while decryption itself is in flight.
    if (!isCurrent()) {
        writeSyncDebugLog(params.log, `💬 session message page: Session ${params.sessionId} disappeared before page decrypt; dropping response`);
        return skippedMissingSessionResult(params.page.direction);
    }
    if (params.shouldContinue?.() === false) {
        return skippedSupersededResult(params.page.direction);
    }

    // Reading must not allocate the shared row-watermark owner. It is created
    // only after a reducer application below; otherwise a delete during
    // decrypt leaves an orphan empty map behind.
    const existingMessages = params.sessionReceivedMessages.get(params.sessionId);

    const messagesToDecrypt: SessionMessageV1[] = [];
    const metadataOnlyRows: SessionMessageV1[] = [];
    for (const msg of orderedMessagesForDirection(data.messages, params.page.direction)) {
        if (
            params.messageIds
            && !params.messageIds.has(msg.id)
            && !existingMessages?.has(msg.id)
            && params.isMessageMaterialized?.(msg.id, msg.localId ?? null) !== true
        ) {
            continue;
        }
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
        } else if (existingUpdatedAt === msgUpdatedAt) {
            metadataOnlyRows.push(msg);
        }
    }
    recordMessageDedupeTelemetry(params.purpose, data.messages.length, messagesToDecrypt.length);

    const authenticationFailures: SessionMessageV1[] = [];
    let decryptedMessages: Array<DecryptedSessionMessage | null>;
    try {
        decryptedMessages = await decryptMessagesInBatchesWithTelemetry(
            params.purpose,
            params.page.direction,
            encryption,
            messagesToDecrypt,
            {
                ...params,
                isCurrent: () => isCurrent() && params.shouldContinue?.() !== false,
                onAuthenticationFailure: (index) => authenticationFailures.push(messagesToDecrypt[index]),
            },
        );
    } catch (cause) {
        throw new SessionMessagePageDecryptionError(params.sessionId, cause);
    }
    if (!isCurrent()) return skippedMissingSessionResult(params.page.direction);
    if (params.shouldContinue?.() === false) return skippedSupersededResult(params.page.direction);
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
    if (!isCurrent()) {
        writeSyncDebugLog(params.log, `💬 session message page: Session ${params.sessionId} disappeared before page apply; dropping response`);
        return skippedMissingSessionResult(params.page.direction);
    }
    if (params.shouldContinue?.() === false) {
        return skippedSupersededResult(params.page.direction);
    }

    const normalizedMessages: NormalizedMessage[] = [];
    const lifecycleEvents: TaskLifecycleEvent[] = [];
    const appliedRowCurrentness: Array<Readonly<{ messageId: string; updatedAt: number; localId: string | null; record: RawRecord | null }>> = [];
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
                if (inputMessage && currentUpdatedAt === inputUpdatedAt) metadataOnlyRows.push(inputMessage);
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
                    lifecycleEvents.push(lifecycleEvent);
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
                applyTranscriptAccountActorMetadata(normalized, {
                    accountActor: qualifyTranscriptAccountActor(inputMessage?.accountActor, params.serverId),
                });
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
                    localId: decrypted.localId ?? null,
                    record: decrypted.content,
                });
            }
        }
    });

    // Actor/profile and action-reference changes do not change the durable
    // content revision. Refresh only those fields; never decrypt or replay
    // lifecycle/content for an already-applied revision. Recheck after yields
    // so an older page cannot retract a newer socket delivery's metadata.
    const metadataUpdates: TranscriptMessageMetadataUpdate[] = [];
    for (const row of metadataOnlyRows) {
        if (params.sessionReceivedMessages.get(params.sessionId)?.get(row.id) !== (row.updatedAt ?? row.createdAt)) continue;
        const update: TranscriptMessageMetadataUpdate = { id: row.id, localId: row.localId ?? null, seq: row.seq };
        applyTranscriptObservationMetadata(update, row);
        applyTranscriptAccountActorMetadata(update, {
            accountActor: qualifyTranscriptAccountActor(row.accountActor, params.serverId),
        });
        metadataUpdates.push(update);
    }
    if (metadataUpdates.length > 0) params.applyMessageMetadata?.(params.sessionId, metadataUpdates);
    params.onNormalizedMessages?.(normalizedMessages);
    if (normalizedMessages.length > 0 || metadataUpdates.length === 0 || !params.applyMessageMetadata) {
        recordMessageApplyTelemetry(
            params.purpose,
            replayableMessages.length,
            params.sessionId,
            normalizedMessages,
            params.applyMessages,
        );
    }
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
        // A streamed segment's applied revision is the base its next durable append names.
        if (row.localId) {
            socketTranscriptStreamSegmentAssembler.noteTranscriptStreamSegmentDurableRevision({
                sessionId: params.sessionId, localId: row.localId, messageId: row.messageId,
                updatedAt: row.updatedAt, record: row.record,
            });
        }
    }
    for (const event of lifecycleEvents) {
        params.onTaskLifecycleEvent?.(event);
    }

    const isUnresolvedRowCurrent = (message: SessionMessageV1) => isSessionMessageRowCurrent({
        existingUpdatedAt: params.sessionReceivedMessages.get(params.sessionId)?.get(message.id),
        incomingUpdatedAt: message.updatedAt ?? message.createdAt,
        isAuthoritativeUpdate: params.authoritativeUpdateMessageIds?.has(message.id) === true,
    });
    const hasAuthenticationFailure = authenticationFailures.some(isUnresolvedRowCurrent);
    if (hasAuthenticationFailure) {
        params.onContentAuthenticationFailure?.(encryption);
    }
    // Keep successfully applied neighbors, but do not certify pagination coverage
    // across an unreadable row. Authenticated null/unsupported content is not a
    // cryptographic failure and retains the existing normalization semantics.
    if (hasAuthenticationFailure || messagesToDecrypt.some((message, index) => (
        decryptedMessages[index] == null && isUnresolvedRowCurrent(message)
    ))) {
        throw new SessionMessagePageDecryptionError(params.sessionId);
    }
    params.onMessagesPage?.(data);

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
