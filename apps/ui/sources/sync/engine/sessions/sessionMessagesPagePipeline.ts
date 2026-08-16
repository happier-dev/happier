import {
    isRecoveredHistoryTranscriptObservationProvenance,
    type SessionMessageRole,
} from '@happier-dev/protocol';

import type { ApiMessage, ApiSessionMessagesResponse } from '@/sync/api/types/apiTypes';
import { parseSessionMessagesResponseJson, type SessionMessagesPageScope } from '@/sync/api/session/sessionMessagesApi';
import { isLegacyMemoryArtifactTranscriptRow } from './legacyMemoryArtifactTranscriptRows';
import { readStoredSessionMessage } from '@/sync/runtime/readStoredSessionContent';
import { writeSyncDebugLog } from '@/sync/runtime/syncDebugLogging';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { normalizeRawMessage, type NormalizedMessage } from '@/sync/typesRaw';
import { applyTranscriptObservationMetadata } from '@/sync/domains/messages/transcriptObservationProvenance';
import { getTaskLifecycleEventFromRawContent, type TaskLifecycleEvent } from './taskLifecycle';

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
type MessagePageScope = SessionMessagesPageScope;
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
    debugDecryptStats: Readonly<{
        fetched: number;
        toDecrypt: number;
        decryptedEntries: number;
        decryptedWithContent: number;
        normalized: number;
        sample: Readonly<{
            id: string;
            seq: number | null;
            cipherPreview: string | null;
        }> | null;
    }>;
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
    return syncPerformanceTelemetry.measure(
        'sync.sessions.messages.parseResponse',
        requestFields,
        () => parseSessionMessagesResponseJson(json),
    );
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

export async function runSessionMessagesPagePipeline(params: {
    sessionId: string;
    purpose: MessagePagePurpose;
    page: SessionMessagesPageRequest;
    lifecyclePolicy: LifecyclePolicy;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    isSessionKnown?: (sessionId: string) => boolean;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: Map<string, Map<string, number>>;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onTaskLifecycleEvent?: (event: TaskLifecycleEvent) => void;
    onMessagesPage?: (page: ApiSessionMessagesResponse) => void;
    onNormalizedMessages?: (messages: NormalizedMessage[]) => void;
    log: { log: (message: string) => void };
} & SessionMessagesPageOptions): Promise<SessionMessagesPagePipelineResult> {
    if (params.isSessionKnown?.(params.sessionId) === false) {
        writeSyncDebugLog(params.log, `💬 session message page: Session ${params.sessionId} is not known on this server; skipping page fetch`);
        const page = emptyPageForDirection(params.page.direction);
        return {
            applied: 0,
            page,
            appliedMessageIds: [],
            appliedSeqs: [],
            rawSeqs: [],
            normalizedMessages: [],
            skippedMissingSession: true,
            debugDecryptStats: {
                fetched: 0,
                toDecrypt: 0,
                decryptedEntries: 0,
                decryptedWithContent: 0,
                normalized: 0,
                sample: null,
            },
        };
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
    params.onMessagesPage?.(data);
    recordMessagePageTelemetry(params.purpose, data.messages.length);

    let existingMessages = params.sessionReceivedMessages.get(params.sessionId);
    if (!existingMessages) {
        existingMessages = new Map<string, number>();
        params.sessionReceivedMessages.set(params.sessionId, existingMessages);
    }

    const messagesToDecrypt: ApiMessage[] = [];
    for (const msg of orderedMessagesForDirection(data.messages, params.page.direction)) {
        const msgUpdatedAt = typeof msg.updatedAt === 'number' ? msg.updatedAt : msg.createdAt;
        const existingUpdatedAt = existingMessages.get(msg.id);
        if (existingUpdatedAt === undefined || msgUpdatedAt > existingUpdatedAt) {
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

    const normalizedMessages: NormalizedMessage[] = [];
    let decryptedWithContent = 0;
    measureMessageNormalization(params.purpose, decryptedMessages.length, () => {
        for (let i = 0; i < decryptedMessages.length; i++) {
            const decrypted = decryptedMessages[i];
            if (!decrypted) continue;
            if (decrypted.content !== null) {
                decryptedWithContent++;
            }

            const inputMessage = messagesToDecrypt[i];
            const inputWasEncrypted = inputMessage?.content?.t === 'encrypted';
            const inputUpdatedAt = inputMessage
                ? (typeof inputMessage.updatedAt === 'number' ? inputMessage.updatedAt : inputMessage.createdAt)
                : decrypted.createdAt;
            if (decrypted.content !== null || !inputWasEncrypted) {
                existingMessages.set(decrypted.id, inputUpdatedAt);
            }
            if (inputWasEncrypted && decrypted.content === null) {
                continue;
            }
            if (isLegacyMemoryArtifactTranscriptRow(decrypted)) {
                continue;
            }
            if (
                params.lifecyclePolicy === 'emit'
                && !isRecoveredHistoryTranscriptObservationProvenance(inputMessage.transcriptObservationProvenance)
            ) {
                const lifecycleEvent = getTaskLifecycleEventFromRawContent(decrypted.content, decrypted.createdAt);
                if (lifecycleEvent) {
                    params.onTaskLifecycleEvent?.(lifecycleEvent);
                }
            }
            const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content, {
                seq: decrypted.seq ?? undefined,
                messageRole: decrypted.messageRole ?? undefined,
            });
            if (normalized) {
                applyTranscriptObservationMetadata(normalized, inputMessage);
                applySidechainScopeMetadata({
                    normalizedMessage: normalized,
                    inputSidechainId: inputMessage?.sidechainId,
                    scope: params.page.scope,
                    requestedSidechainId: params.page.sidechainId ?? null,
                });
                normalizedMessages.push(normalized);
            }
        }
    });

    params.onNormalizedMessages?.(normalizedMessages);
    recordMessageApplyTelemetry(
        params.purpose,
        decryptedMessages.length,
        params.sessionId,
        normalizedMessages,
        params.applyMessages,
    );

    return {
        applied: normalizedMessages.length,
        page: data,
        appliedMessageIds: normalizedMessages.map((message) => message.id),
        appliedSeqs: normalizedMessages
            .map((message) => message.seq)
            .filter((seq): seq is number => typeof seq === 'number' && Number.isFinite(seq)),
        normalizedMessages,
        rawSeqs: data.messages
            .map((message) => message.seq)
            .filter((seq): seq is number => typeof seq === 'number' && Number.isFinite(seq)),
        skippedMissingSession: false,
        debugDecryptStats: {
            fetched: data.messages.length,
            toDecrypt: messagesToDecrypt.length,
            decryptedEntries: decryptedMessages.length,
            decryptedWithContent,
            normalized: normalizedMessages.length,
            sample: messagesToDecrypt[0]
                ? {
                    id: messagesToDecrypt[0].id,
                    seq: typeof messagesToDecrypt[0].seq === 'number' && Number.isFinite(messagesToDecrypt[0].seq)
                        ? Math.trunc(messagesToDecrypt[0].seq)
                        : null,
                    cipherPreview: messagesToDecrypt[0].content?.t === 'encrypted' && typeof messagesToDecrypt[0].content.c === 'string'
                        ? `${messagesToDecrypt[0].content.c.slice(0, 24)}…(${messagesToDecrypt[0].content.c.length})`
                        : null,
                }
                : null,
        },
    };
}
