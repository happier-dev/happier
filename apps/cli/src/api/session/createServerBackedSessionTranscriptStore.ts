import type {
    FileBackedTranscriptPageResult,
    FileBackedTranscriptReadAfterResult,
    FileBackedTranscriptSessionStore,
    FileBackedTranscriptSubscriptionListener,
} from './fileBackedTranscripts/store';
import { readRecord, normalizeBoundedInt, type SessionTranscriptActionItem } from './sessionTranscriptActionInput';
import { fetchEncryptedTranscriptMessagesPage, type RawTranscriptRow } from '@/session/replay/fetchEncryptedTranscriptMessages';
import {
    createTranscriptHistoryNormalizationSequenceState,
    extractCompactRow,
    isMemoryArtifactDecryptedRow,
    shouldSuppressTranscriptItemForEmptyCanonicalTurnDiff,
    tryResolveDecryptedTranscriptPayload,
    type TranscriptHistoryNormalizationSequenceState,
} from '@/session/services/transcript/transcriptHistoryRows';

type ServerBackedSessionTranscriptStoreParams = Readonly<{
    token: string;
    sessionId: string;
    ctx: Readonly<{ encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }>;
}>;

function parseSeqCursor(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.floor(value));
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
        return undefined;
    }
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

function isTailCursor(value: unknown): boolean {
    return typeof value === 'string' && value.trim() === 'tail';
}

function rowToTranscriptItem(
    row: RawTranscriptRow,
    index: number,
    ctx: ServerBackedSessionTranscriptStoreParams['ctx'],
    sequenceState: TranscriptHistoryNormalizationSequenceState,
): SessionTranscriptActionItem | null {
    const seq = typeof row.seq === 'number' && Number.isFinite(row.seq) ? Math.floor(row.seq) : undefined;
    const decrypted = tryResolveDecryptedTranscriptPayload({ content: row.content, ctx });
    if (decrypted && shouldSuppressTranscriptItemForEmptyCanonicalTurnDiff(decrypted, sequenceState)) {
        return null;
    }
    const compact = decrypted && !isMemoryArtifactDecryptedRow(decrypted)
        ? extractCompactRow({
            decrypted,
            createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
            fallbackId: typeof seq === 'number' ? String(seq) : String(index),
        })
        : null;
    return {
        id: typeof seq === 'number' ? String(seq) : String(index),
        ...(typeof seq === 'number' ? { seq } : {}),
        ...(typeof row.createdAt === 'number' ? { createdAt: row.createdAt } : {}),
        ...(compact?.text ? { text: compact.text } : {}),
        content: row.content,
    };
}

function limitItemsByEncodedBytes(
    items: readonly SessionTranscriptActionItem[],
    maxBytes: number,
): Readonly<{ items: readonly SessionTranscriptActionItem[]; truncated: boolean }> {
    const limited: SessionTranscriptActionItem[] = [];
    let bytes = 0;
    for (const item of items) {
        const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
        if (limited.length > 0 && bytes + itemBytes > maxBytes) {
            return { items: limited, truncated: true };
        }
        limited.push(item);
        bytes += itemBytes;
        if (bytes >= maxBytes) {
            return { items: limited, truncated: items.length > limited.length };
        }
    }
    return { items: limited, truncated: false };
}

export function createServerBackedSessionTranscriptStore(
    params: ServerBackedSessionTranscriptStoreParams,
): FileBackedTranscriptSessionStore<SessionTranscriptActionItem> {
    let tailCursor: string | null = null;
    const sequenceState = createTranscriptHistoryNormalizationSequenceState();

    const rowsToTranscriptItems = (
        rows: readonly RawTranscriptRow[],
    ): SessionTranscriptActionItem[] => rows.flatMap((row, index) => {
        const item = rowToTranscriptItem(row, index, params.ctx, sequenceState);
        return item ? [item] : [];
    });

    return {
        warm: async () => undefined,
        dispose: async () => undefined,
        setLifecycleState: async () => undefined,
        async pageOlder(rawParams?: unknown): Promise<FileBackedTranscriptPageResult<SessionTranscriptActionItem>> {
            const input = readRecord(rawParams);
            const maxItems = normalizeBoundedInt(input.maxItems, 100, 500);
            const maxBytes = normalizeBoundedInt(input.maxBytes, 64 * 1024, 1_000_000);
            const page = await fetchEncryptedTranscriptMessagesPage({
                token: params.token,
                sessionId: params.sessionId,
                limit: maxItems,
                ...(parseSeqCursor(input.cursor) !== undefined ? { beforeSeq: parseSeqCursor(input.cursor) } : {}),
            });
            tailCursor = typeof page.nextAfterSeq === 'number' ? String(page.nextAfterSeq) : tailCursor;
            const limited = limitItemsByEncodedBytes(
                rowsToTranscriptItems(page.messages),
                maxBytes,
            );
            return {
                items: limited.items,
                nextCursor: typeof page.nextBeforeSeq === 'number' ? String(page.nextBeforeSeq) : null,
                hasMore: page.hasMore,
                tailCursor,
                truncated: page.hasMore || limited.truncated,
            };
        },
        async readAfter(rawParams?: unknown): Promise<FileBackedTranscriptReadAfterResult<SessionTranscriptActionItem>> {
            const input = readRecord(rawParams);
            const maxItems = normalizeBoundedInt(input.maxItems, 100, 500);
            const maxBytes = normalizeBoundedInt(input.maxBytes, 64 * 1024, 1_000_000);
            if (isTailCursor(input.cursor)) {
                const page = await fetchEncryptedTranscriptMessagesPage({
                    token: params.token,
                    sessionId: params.sessionId,
                    limit: 1,
                });
                tailCursor = typeof page.nextAfterSeq === 'number' ? String(page.nextAfterSeq) : tailCursor;
                return {
                    items: [],
                    nextCursor: tailCursor,
                    truncated: false,
                };
            }
            const afterSeq = parseSeqCursor(input.cursor);
            const page = await fetchEncryptedTranscriptMessagesPage({
                token: params.token,
                sessionId: params.sessionId,
                limit: maxItems,
                ...(afterSeq !== undefined ? { afterSeq } : {}),
            });
            tailCursor = typeof page.nextAfterSeq === 'number' ? String(page.nextAfterSeq) : tailCursor;
            const limited = limitItemsByEncodedBytes(
                rowsToTranscriptItems(page.messages),
                maxBytes,
            );
            return {
                items: limited.items,
                nextCursor: typeof page.nextAfterSeq === 'number' ? String(page.nextAfterSeq) : null,
                truncated: page.hasMore || limited.truncated,
            };
        },
        getTailCursor: () => tailCursor,
        subscribe: (_listener?: FileBackedTranscriptSubscriptionListener<SessionTranscriptActionItem>) => () => undefined,
        getTitle: async () => null,
        getWorkingDirectory: async () => null,
        getActivity: async () => null,
        getPreview: async () => null,
    };
}
