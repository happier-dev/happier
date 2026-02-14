import { decodeBase64, encodeBase64 } from '@/encryption/base64';

export type EditorBridgeEnvelopeV1 = Readonly<{
    v: 1;
    type: string;
    payload: unknown;
}>;

export type EditorBridgeChunkV1 = Readonly<{
    v: 1;
    type: 'chunk';
    payload: Readonly<{
        messageId: string;
        index: number;
        total: number;
        // Base64 (UTF-8 JSON of an EditorBridgeEnvelopeV1).
        data: string;
    }>;
}>;

export type EditorBridgeMessageV1 = EditorBridgeEnvelopeV1 | EditorBridgeChunkV1;

function decodeUtf8Base64(value: string): string {
    const bytes = decodeBase64(value);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function encodeUtf8Base64(value: string): string {
    const bytes = new TextEncoder().encode(value);
    return encodeBase64(bytes, 'base64');
}

function chunkString(value: string, maxChunkBytes: number): string[] {
    if (maxChunkBytes <= 0) return [value];
    const out: string[] = [];
    for (let i = 0; i < value.length; i += maxChunkBytes) {
        out.push(value.slice(i, i + maxChunkBytes));
    }
    return out;
}

/**
 * Encodes an envelope as either a single message or a sequence of chunk messages.
 *
 * Chunk payloads are base64-encoded JSON to avoid WebView postMessage UTF-16 edge cases.
 */
export function encodeChunkedEnvelope(params: Readonly<{
    envelope: EditorBridgeEnvelopeV1;
    maxChunkBytes: number;
    messageId: string;
}>): EditorBridgeMessageV1[] {
    const encodedJson = JSON.stringify(params.envelope);
    const base64 = encodeUtf8Base64(encodedJson);

    if (base64.length <= params.maxChunkBytes) {
        return [params.envelope];
    }

    const parts = chunkString(base64, params.maxChunkBytes);
    return parts.map((data, index) => ({
        v: 1,
        type: 'chunk',
        payload: {
            messageId: params.messageId,
            index,
            total: parts.length,
            data,
        },
    }));
}

type PendingChunks = {
    total: number;
    parts: Array<string | null>;
    received: number;
};

const pendingByMessageId: Map<string, PendingChunks> = new Map();

function tryFinalize(messageId: string, pending: PendingChunks): EditorBridgeEnvelopeV1 | null {
    if (pending.received !== pending.total) return null;
    const merged = pending.parts.map((p) => p ?? '').join('');
    pendingByMessageId.delete(messageId);

    try {
        const json = decodeUtf8Base64(merged);
        const parsed = JSON.parse(json) as EditorBridgeEnvelopeV1;
        if (!parsed || typeof parsed !== 'object') return null;
        if ((parsed as any).v !== 1) return null;
        if (typeof (parsed as any).type !== 'string') return null;
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Decodes a message that might be chunked. Returns:
 * - the decoded envelope, once all chunks are received
 * - null if more chunks are needed or the message is invalid
 */
export function decodeChunkedEnvelope(params: Readonly<{
    message: EditorBridgeMessageV1;
}>): EditorBridgeEnvelopeV1 | null {
    const message = params.message;

    if (message.type !== 'chunk') {
        return message;
    }

    const payload = (message as any).payload as { messageId?: unknown; index?: unknown; total?: unknown; data?: unknown } | undefined;
    if (!payload || typeof payload !== 'object') return null;

    const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
    if (!messageId) return null;
    const total = typeof payload.total === 'number' ? payload.total : NaN;
    if (!Number.isFinite(total) || total <= 0) return null;
    const index = typeof payload.index === 'number' ? payload.index : NaN;
    if (!Number.isFinite(index) || index < 0 || index >= total) return null;
    const data = typeof payload.data === 'string' ? payload.data : null;
    if (data === null) return null;

    const existing = pendingByMessageId.get(messageId);
    if (!existing) {
        const pending: PendingChunks = {
            total,
            parts: Array.from({ length: total }, () => null),
            received: 0,
        };
        pending.parts[index] = data;
        pending.received = 1;
        pendingByMessageId.set(messageId, pending);
        return tryFinalize(messageId, pending);
    }

    if (existing.total !== total) {
        // Mismatched totals: drop the pending state to avoid memory leaks.
        pendingByMessageId.delete(messageId);
        return null;
    }

    if (existing.parts[index] === null) {
        existing.parts[index] = data;
        existing.received += 1;
    }

    return tryFinalize(messageId, existing);
}
