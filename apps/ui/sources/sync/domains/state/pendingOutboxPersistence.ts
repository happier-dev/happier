import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readPendingLocalId } from '@happier-dev/protocol';
import {
    assertValidPendingMessageId,
    isValidPendingMessageId,
} from '@/sync/domains/pending/pendingMessageId';

import { getPersistenceStorage } from './persistenceStorage';
import { scopedSessionLocalStateKey } from './sessionLocalStateKeys';

export type PersistedPendingEnqueueRequestV1 = Readonly<{
    v: 1;
    body: string;
}>;

export type PendingOutboxQuarantineReason =
    | 'unsupported_persisted_operation'
    | 'invalid_persisted_local_id'
    | 'invalid_persisted_envelope';

export type PersistedPendingOutboxMessage = Readonly<{
    sessionId: string;
    localId: string;
    createdAt: number;
    text: string;
    displayText?: string;
    rawRecord: unknown;
    operation: 'enqueue' | 'cancel' | 'quarantined';
    quarantineReason?: PendingOutboxQuarantineReason;
    request: PersistedPendingEnqueueRequestV1;
}>;

function pendingOutboxKey(scope: ServerAccountScope): string {
    return scopedSessionLocalStateKey('session-pending-outbox-v1', scope);
}

function isValidPendingEnqueueBody(body: string, localId: string): boolean {
    try {
        const parsed = JSON.parse(body) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
        const record = parsed as Record<string, unknown>;
        if (record.localId !== localId || record.messageRole !== 'user') return false;
        const hasCiphertextField = Object.prototype.hasOwnProperty.call(record, 'ciphertext');
        const hasContentField = Object.prototype.hasOwnProperty.call(record, 'content');
        const hasCiphertext = typeof record.ciphertext === 'string' && record.ciphertext.length > 0;
        const content = record.content;
        const hasPlainContent = Boolean(content)
            && typeof content === 'object'
            && !Array.isArray(content)
            && (content as Record<string, unknown>).t === 'plain'
            && Object.prototype.hasOwnProperty.call(content, 'v');
        return (hasCiphertext && !hasContentField) || (hasPlainContent && !hasCiphertextField);
    } catch {
        return false;
    }
}

function parseRow(sessionId: string, value: unknown): PersistedPendingOutboxMessage | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    const localId = readPendingLocalId(input.localId);
    const createdAt = typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)
        ? input.createdAt
        : 0;
    const text = typeof input.text === 'string' ? input.text : '';
    if (localId === null) return null;
    const requestInput = input.request;
    const request = requestInput && typeof requestInput === 'object' && !Array.isArray(requestInput)
        ? requestInput as Record<string, unknown>
        : null;
    const requestBody = typeof request?.body === 'string' ? request.body : '';
    const requestEnvelopeValid = request?.v === 1 && isValidPendingEnqueueBody(requestBody, localId);
    const persistedQuarantineReason = input.quarantineReason === 'unsupported_persisted_operation'
        || input.quarantineReason === 'invalid_persisted_local_id'
        || input.quarantineReason === 'invalid_persisted_envelope'
        ? input.quarantineReason
        : null;
    const quarantineReason: PendingOutboxQuarantineReason | null = !isValidPendingMessageId(localId)
        ? 'invalid_persisted_local_id'
        : !requestEnvelopeValid
            ? 'invalid_persisted_envelope'
            : input.operation === 'quarantined'
                ? persistedQuarantineReason ?? 'unsupported_persisted_operation'
                : input.operation !== undefined && input.operation !== 'enqueue' && input.operation !== 'cancel'
                    ? 'unsupported_persisted_operation'
                    : null;
    return {
        sessionId,
        localId,
        createdAt,
        text,
        ...(typeof input.displayText === 'string' ? { displayText: input.displayText } : {}),
        rawRecord: input.rawRecord,
        operation: quarantineReason ? 'quarantined' : input.operation === 'cancel' ? 'cancel' : 'enqueue',
        ...(quarantineReason ? { quarantineReason } : {}),
        request: { v: 1, body: requestBody },
    };
}

export function loadPendingOutbox(scope: ServerAccountScope): Record<string, PersistedPendingOutboxMessage[]> {
    const raw = getPersistenceStorage().getString(pendingOutboxKey(scope));
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const result: Record<string, PersistedPendingOutboxMessage[]> = {};
        for (const [rawSessionId, rawRows] of Object.entries(parsed as Record<string, unknown>)) {
            const sessionId = rawSessionId.trim();
            if (!sessionId || !Array.isArray(rawRows)) continue;
            const rows = rawRows
                .map((row) => parseRow(sessionId, row))
                .filter((row): row is PersistedPendingOutboxMessage => row !== null);
            if (rows.length > 0) result[sessionId] = rows;
        }
        return result;
    } catch {
        return {};
    }
}

export function listPendingOutboxSessionIds(scope: ServerAccountScope): string[] {
    return Object.keys(loadPendingOutbox(scope)).sort();
}

export function loadPendingOutboxForSession(
    sessionId: string,
    scope: ServerAccountScope,
): PersistedPendingOutboxMessage[] {
    return loadPendingOutbox(scope)[sessionId.trim()] ?? [];
}

export function findPendingOutboxMessage(
    sessionId: string,
    localId: string,
    scope: ServerAccountScope,
): PersistedPendingOutboxMessage | null {
    if (readPendingLocalId(localId) === null) return null;
    return loadPendingOutboxForSession(sessionId, scope)
        .find((row) => row.localId === localId) ?? null;
}

function writePendingOutbox(
    outbox: Record<string, PersistedPendingOutboxMessage[]>,
    scope: ServerAccountScope,
): void {
    const storage = getPersistenceStorage();
    const nonEmpty = Object.fromEntries(Object.entries(outbox).filter(([, rows]) => rows.length > 0));
    if (Object.keys(nonEmpty).length === 0) {
        storage.delete(pendingOutboxKey(scope));
        return;
    }
    storage.set(pendingOutboxKey(scope), JSON.stringify(nonEmpty));
}

export function savePendingOutboxMessage(
    message: Omit<PersistedPendingOutboxMessage, 'operation' | 'quarantineReason'> & Readonly<{ operation?: 'enqueue' | 'cancel' }>,
    scope: ServerAccountScope,
): PersistedPendingOutboxMessage {
    const sessionId = message.sessionId.trim();
    const localId = message.localId;
    if (!sessionId) throw new Error('Pending outbox sessionId and localId are required');
    assertValidPendingMessageId(localId);
    if (!isValidPendingEnqueueBody(message.request.body, localId)) {
        throw new Error('Pending outbox request envelope is invalid');
    }
    const outbox = loadPendingOutbox(scope);
    const rows = outbox[sessionId] ?? [];
    const existing = rows.find((row) => row.localId === localId);
    if (existing) return existing;
    const next = {
        ...message,
        sessionId,
        localId,
        operation: message.operation ?? 'enqueue',
    };
    writePendingOutbox({ ...outbox, [sessionId]: [...rows, next] }, scope);
    return next;
}

export function markPendingOutboxMessageCancelRequested(
    sessionId: string,
    localId: string,
    scope: ServerAccountScope,
): PersistedPendingOutboxMessage | null {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || readPendingLocalId(localId) === null) return null;
    const outbox = loadPendingOutbox(scope);
    const rows = outbox[normalizedSessionId];
    if (!rows) return null;
    const index = rows.findIndex((row) => row.localId === localId);
    if (index < 0) return null;
    const existing = rows[index]!;
    if (existing.operation === 'quarantined') return existing;
    if (existing.operation === 'cancel') return existing;
    const next = { ...existing, operation: 'cancel' as const };
    const nextRows = [...rows];
    nextRows[index] = next;
    writePendingOutbox({ ...outbox, [normalizedSessionId]: nextRows }, scope);
    return next;
}

export function isPendingOutboxMessageQuarantined(
    message: PersistedPendingOutboxMessage,
): message is PersistedPendingOutboxMessage & Readonly<{
    operation: 'quarantined';
    quarantineReason: PendingOutboxQuarantineReason;
}> {
    return message.operation === 'quarantined' && message.quarantineReason !== undefined;
}

export function removePendingOutboxMessage(
    sessionId: string,
    localId: string,
    scope: ServerAccountScope,
): void {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || readPendingLocalId(localId) === null) return;
    const outbox = loadPendingOutbox(scope);
    const rows = outbox[normalizedSessionId];
    if (!rows) return;
    const nextRows = rows.filter((row) => row.localId !== localId);
    if (nextRows.length === rows.length) return;
    writePendingOutbox({ ...outbox, [normalizedSessionId]: nextRows }, scope);
}
