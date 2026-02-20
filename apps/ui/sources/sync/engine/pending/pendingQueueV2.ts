import { storage } from '@/sync/domains/state/storage';
import type { Encryption } from '@/sync/encryption/encryption';
import { nowServerMs } from '@/sync/runtime/time';
import { RawRecordSchema, type RawRecord } from '@/sync/typesRaw';
import { randomUUID } from '@/platform/randomUUID';
import { buildSessionAppendSystemPrompt } from '@/agents/prompt/buildSessionAppendSystemPrompt';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { resolveSentFrom } from '@/sync/domains/messages/sentFrom';
import { buildSendMessageMeta } from '@/sync/domains/messages/buildSendMessageMeta';
import { SessionStoredMessageContentSchema, type SessionStoredMessageContent } from '@happier-dev/protocol';

type PendingStatus = 'queued' | 'discarded';

type PendingRow = {
    localId: string;
    content: SessionStoredMessageContent;
    status: PendingStatus;
    position: number;
    createdAt: number;
    updatedAt: number;
    discardedAt: number | null;
    discardedReason: string | null;
    authorAccountId: string | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePendingRows(raw: unknown): PendingRow[] | null {
    if (!isPlainObject(raw)) return null;
    const pending = raw.pending;
    if (!Array.isArray(pending)) return null;

    const out: PendingRow[] = [];
    for (const item of pending) {
        if (!isPlainObject(item)) continue;
        const localId = item.localId;
        const content = item.content;
        const status = item.status;
        const position = item.position;
        const createdAt = item.createdAt;
        const updatedAt = item.updatedAt;
        const discardedAt = item.discardedAt;
        const discardedReason = item.discardedReason;
        const authorAccountId = item.authorAccountId;

        if (typeof localId !== 'string' || localId.length === 0) continue;
        if (!isPlainObject(content)) continue;
        const contentParsed = SessionStoredMessageContentSchema.safeParse(content);
        if (!contentParsed.success) continue;
        if (status !== 'queued' && status !== 'discarded') continue;
        if (typeof position !== 'number' || !Number.isFinite(position)) continue;
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue;
        if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) continue;

        out.push({
            localId,
            content: contentParsed.data,
            status,
            position,
            createdAt,
            updatedAt,
            discardedAt: typeof discardedAt === 'number' && Number.isFinite(discardedAt) ? discardedAt : null,
            discardedReason: typeof discardedReason === 'string' && discardedReason.length > 0 ? discardedReason : null,
            authorAccountId: typeof authorAccountId === 'string' && authorAccountId.length > 0 ? authorAccountId : null,
        });
    }
    return out;
}

function coerceDiscardReason(value: string | null): 'switch_to_local' | 'manual' {
    if (value === 'switch_to_local') return 'switch_to_local';
    return 'manual';
}

function coercePendingUserTextRecord(decrypted: unknown): { rawRecord: RawRecord; text: string; displayText?: string } | null {
    const parsed = RawRecordSchema.safeParse(decrypted);
    if (!parsed.success) return null;
    const record = parsed.data;
    if (record.role !== 'user') return null;

    const text = record.content.text;
    if (typeof text !== 'string' || text.trim().length === 0) return null;

    const displayTextRaw = record.meta?.displayText;
    const displayText = typeof displayTextRaw === 'string' && displayTextRaw.trim().length > 0 ? displayTextRaw : undefined;

    return { rawRecord: record, text, displayText };
}

export async function fetchAndApplyPendingMessagesV2(params: {
    sessionId: string;
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, encryption, request } = params;

    const session = storage.getState().sessions[sessionId] ?? null;
    const sessionEncryptionMode: 'e2ee' | 'plain' = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const sessionEncryption = sessionEncryptionMode === 'plain' ? null : encryption.getSessionEncryption(sessionId);
    if (sessionEncryptionMode === 'e2ee' && !sessionEncryption) {
        storage.getState().applyPendingLoaded(sessionId);
        storage.getState().applyDiscardedPendingMessages(sessionId, []);
        return;
    }

    const response = await request(`/v2/sessions/${sessionId}/pending?includeDiscarded=1`, { method: 'GET' });
    if (!response.ok) {
        storage.getState().applyPendingLoaded(sessionId);
        storage.getState().applyDiscardedPendingMessages(sessionId, []);
        return;
    }

    const json = await response.json().catch(() => null);
    const rows = parsePendingRows(json);
    if (!rows) {
        storage.getState().applyPendingLoaded(sessionId);
        storage.getState().applyDiscardedPendingMessages(sessionId, []);
        return;
    }

    const queued = rows.filter((r) => r.status === 'queued').sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
    const discarded = rows.filter((r) => r.status === 'discarded').sort((a, b) => (a.discardedAt ?? a.updatedAt) - (b.discardedAt ?? b.updatedAt));

    const pendingMessages = [];
    for (const r of queued) {
        const decrypted =
            r.content.t === 'encrypted'
                ? sessionEncryption
                    ? await sessionEncryption.decryptRaw(r.content.c).catch(() => null)
                    : null
                : r.content.v;
        const coerced = coercePendingUserTextRecord(decrypted);
        if (!coerced) continue;
        pendingMessages.push({
            id: r.localId,
            localId: r.localId,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            text: coerced.text,
            displayText: coerced.displayText,
            rawRecord: coerced.rawRecord,
        });
    }

    const discardedMessages = [];
    for (const r of discarded) {
        const decrypted =
            r.content.t === 'encrypted'
                ? sessionEncryption
                    ? await sessionEncryption.decryptRaw(r.content.c).catch(() => null)
                    : null
                : r.content.v;
        const coerced = coercePendingUserTextRecord(decrypted);
        if (!coerced) continue;
        discardedMessages.push({
            id: r.localId,
            localId: r.localId,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            text: coerced.text,
            displayText: coerced.displayText,
            rawRecord: coerced.rawRecord,
            discardedAt: r.discardedAt ?? r.updatedAt,
            discardedReason: coerceDiscardReason(r.discardedReason),
        });
    }

    storage.getState().applyPendingMessages(sessionId, pendingMessages);
    storage.getState().applyDiscardedPendingMessages(sessionId, discardedMessages);
}

export async function enqueuePendingMessageV2(params: {
    sessionId: string;
    text: string;
    displayText?: string;
    encryption: Encryption;
    metaOverrides?: Record<string, unknown>;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, text, displayText, encryption, request, metaOverrides } = params;

    storage.getState().markSessionOptimisticThinking(sessionId);

    const session = storage.getState().sessions[sessionId];
    if (!session) {
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw new Error(`Session ${sessionId} not found in storage`);
    }
    const sessionEncryptionMode: 'e2ee' | 'plain' = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const sessionEncryption = sessionEncryptionMode === 'plain' ? null : encryption.getSessionEncryption(sessionId);
    if (sessionEncryptionMode === 'e2ee' && !sessionEncryption) {
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw new Error(`Session ${sessionId} not found`);
    }

    const permissionMode = session.permissionMode || 'default';
    const flavor = session.metadata?.flavor;
    const agentId = resolveAgentIdFromFlavor(flavor);
    const modelMode = session.modelMode || (agentId ? getAgentCore(agentId).model.defaultMode : 'default');
    const model = agentId && getAgentCore(agentId).model.supportsSelection && modelMode !== 'default' ? modelMode : undefined;
    const appendSystemPrompt = buildSessionAppendSystemPrompt({ settings: storage.getState().settings });

    const localId = randomUUID();
    const rawRecord: RawRecord = {
        role: 'user',
        content: { type: 'text', text },
        meta: buildSendMessageMeta({
            sentFrom: resolveSentFrom(),
            permissionMode: permissionMode || 'default',
            model,
            appendSystemPrompt,
            displayText,
            agentId,
            settings: storage.getState().settings,
            session,
            metaOverrides: metaOverrides as any,
        }),
    };

    const createdAt = nowServerMs();
    const updatedAt = createdAt;
    let writeBody: Record<string, unknown>;
    if (sessionEncryptionMode === 'plain') {
        writeBody = { localId, content: { t: 'plain', v: rawRecord } };
    } else {
        let ciphertext: string;
        try {
            ciphertext = await sessionEncryption!.encryptRawRecord(rawRecord);
        } catch (e) {
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw e;
        }
        writeBody = { localId, ciphertext };
    }

    storage.getState().upsertPendingMessage(sessionId, {
        id: localId,
        localId,
        createdAt,
        updatedAt,
        text,
        displayText,
        rawRecord,
    });

    try {
        const response = await request(`/v2/sessions/${sessionId}/pending`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(writeBody),
        });
        if (!response.ok) {
            throw new Error(`Failed to enqueue pending message (${response.status})`);
        }
        storage.getState().clearSessionOptimisticThinking(sessionId);
    } catch (e) {
        storage.getState().removePendingMessage(sessionId, localId);
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw e;
    }
}

export async function updatePendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    text: string;
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, pendingId, text, encryption, request } = params;

    const session = storage.getState().sessions[sessionId] ?? null;
    const sessionEncryptionMode: 'e2ee' | 'plain' = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const sessionEncryption = sessionEncryptionMode === 'plain' ? null : encryption.getSessionEncryption(sessionId);
    if (sessionEncryptionMode === 'e2ee' && !sessionEncryption) {
        throw new Error(`Session ${sessionId} not found`);
    }

    const existing = storage.getState().sessionPending[sessionId]?.messages?.find((m) => m.id === pendingId);
    if (!existing) {
        throw new Error('Pending message not found');
    }

    const appendSystemPrompt = buildSessionAppendSystemPrompt({ settings: storage.getState().settings });

    const rawRecord: RawRecord = (() => {
        if (existing.rawRecord) {
            const record = existing.rawRecord as any;
            const existingMeta = isPlainObject(record?.meta) ? record.meta : {};
            return {
                ...record,
                content: { type: 'text', text },
                meta: { ...existingMeta, appendSystemPrompt },
            };
        }

        const session = storage.getState().sessions[sessionId] ?? null;
        const permissionMode = session?.permissionMode || 'default';
        const flavor = session?.metadata?.flavor;
        const agentId = resolveAgentIdFromFlavor(flavor);
        const modelMode = session?.modelMode || (agentId ? getAgentCore(agentId).model.defaultMode : 'default');
        const model = agentId && getAgentCore(agentId).model.supportsSelection && modelMode !== 'default' ? modelMode : undefined;

        return {
            role: 'user',
            content: { type: 'text', text },
            meta: buildSendMessageMeta({
                sentFrom: resolveSentFrom(),
                permissionMode: permissionMode || 'default',
                model,
                appendSystemPrompt,
                displayText: typeof existing.displayText === 'string' ? existing.displayText : undefined,
                agentId,
                settings: storage.getState().settings,
                session,
            }),
        };
    })();

    const writeBody =
        sessionEncryptionMode === 'plain'
            ? { content: { t: 'plain', v: rawRecord } }
            : { ciphertext: await sessionEncryption!.encryptRawRecord(rawRecord) };
    const updatedAt = nowServerMs();

    const response = await request(`/v2/sessions/${sessionId}/pending/${pendingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(writeBody),
    });
    if (!response.ok) {
        throw new Error(`Failed to update pending message (${response.status})`);
    }

    storage.getState().upsertPendingMessage(sessionId, { ...existing, text, updatedAt, rawRecord });
}

export async function deletePendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, pendingId, request } = params;

    const response = await request(`/v2/sessions/${sessionId}/pending/${pendingId}`, { method: 'DELETE' });
    if (!response.ok) {
        throw new Error(`Failed to delete pending message (${response.status})`);
    }
    storage.getState().removePendingMessage(sessionId, pendingId);
}

export async function discardPendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    reason?: 'switch_to_local' | 'manual';
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, pendingId, reason, encryption, request } = params;

    const response = await request(`/v2/sessions/${sessionId}/pending/${pendingId}/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
    });
    if (!response.ok) {
        throw new Error(`Failed to discard pending message (${response.status})`);
    }
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });
}

export async function restoreDiscardedPendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, pendingId, encryption, request } = params;

    const response = await request(`/v2/sessions/${sessionId}/pending/${pendingId}/restore`, { method: 'POST' });
    if (!response.ok) {
        throw new Error(`Failed to restore discarded message (${response.status})`);
    }
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });
}

export async function deleteDiscardedPendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, pendingId, encryption, request } = params;

    const response = await request(`/v2/sessions/${sessionId}/pending/${pendingId}`, { method: 'DELETE' });
    if (!response.ok) {
        throw new Error(`Failed to delete discarded message (${response.status})`);
    }
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });
}

export async function reorderPendingMessagesV2(params: {
    sessionId: string;
    orderedLocalIds: string[];
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, orderedLocalIds, encryption, request } = params;

    const response = await request(`/v2/sessions/${sessionId}/pending/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedLocalIds }),
    });
    if (!response.ok) {
        throw new Error(`Failed to reorder pending messages (${response.status})`);
    }
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });
}
