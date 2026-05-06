import type { FileBackedTranscriptSessionStore } from './fileBackedTranscripts/store';
import {
    normalizeBoundedInt,
    readOptionalString,
    readRecord,
    type SessionTranscriptActionResult,
} from './sessionTranscriptActionInput';

type ReadSessionTranscriptAfterParams<TItem> = Readonly<{
    store: FileBackedTranscriptSessionStore<TItem>;
    input?: unknown;
}>;

export async function readSessionTranscriptAfter<TItem>(
    params: ReadSessionTranscriptAfterParams<TItem>,
): Promise<SessionTranscriptActionResult<{
    items: readonly TItem[];
    nextCursor: string | null;
    truncated: boolean;
}>> {
    const input = readRecord(params.input);
    const cursor = readOptionalString(input, 'cursor');
    if (!cursor) {
        return { ok: false, errorCode: 'missing_cursor', message: 'Transcript cursor is required.' };
    }
    const read = await params.store.readAfter({
        cursor,
        maxBytes: normalizeBoundedInt(input.maxBytes, 64 * 1024, 1024 * 1024),
        maxItems: normalizeBoundedInt(input.maxItems, 100, 500),
    });
    return {
        ok: true,
        items: read.items,
        nextCursor: read.nextCursor,
        truncated: read.truncated,
    };
}
