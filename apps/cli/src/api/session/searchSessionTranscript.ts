import type { FileBackedTranscriptSessionStore } from './fileBackedTranscripts/store';
import {
    normalizeBoundedInt,
    readOptionalString,
    readRecord,
    type SessionTranscriptActionResult,
} from './sessionTranscriptActionInput';

type SearchSessionTranscriptParams<TItem> = Readonly<{
    store: FileBackedTranscriptSessionStore<TItem>;
    input?: unknown;
    stringifyItem?: (item: TItem) => string;
}>;

export async function searchSessionTranscript<TItem>(
    params: SearchSessionTranscriptParams<TItem>,
): Promise<SessionTranscriptActionResult<{
    items: readonly TItem[];
    nextCursor: string | null;
    truncated: boolean;
}>> {
    const input = readRecord(params.input);
    const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
    if (!query) {
        return { ok: false, errorCode: 'missing_query', message: 'Transcript search query is required.' };
    }

    const maxItems = normalizeBoundedInt(input.maxItems, 50, 200);
    const maxReads = normalizeBoundedInt(input.maxReads, 8, 32);
    const maxBytes = normalizeBoundedInt(input.maxBytes, 64 * 1024, 1024 * 1024);
    const stringifyItem = params.stringifyItem ?? ((item) => JSON.stringify(item));
    const matches: TItem[] = [];
    let cursor = readOptionalString(input, 'cursor') ?? '0';
    let nextCursor: string | null = cursor;
    let truncated = false;

    for (let readIndex = 0; readIndex < maxReads && matches.length < maxItems; readIndex += 1) {
        const read = await params.store.readAfter({ cursor, maxBytes, maxItems });
        nextCursor = read.nextCursor;
        truncated = read.truncated;
        for (const item of read.items) {
            if (stringifyItem(item).toLowerCase().includes(query)) {
                matches.push(item);
                if (matches.length >= maxItems) break;
            }
        }
        if (!read.nextCursor || read.items.length === 0) break;
        cursor = read.nextCursor;
    }

    return {
        ok: true,
        items: matches,
        nextCursor,
        truncated,
    };
}
