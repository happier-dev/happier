import type { FileBackedTranscriptSessionStore } from './fileBackedTranscripts/store';
import {
    normalizeBoundedInt,
    readOptionalString,
    readRecord,
    type SessionTranscriptActionResult,
} from './sessionTranscriptActionInput';

type PageSessionTranscriptParams<TItem> = Readonly<{
    store: FileBackedTranscriptSessionStore<TItem>;
    input?: unknown;
}>;

export async function pageSessionTranscript<TItem>(
    params: PageSessionTranscriptParams<TItem>,
): Promise<SessionTranscriptActionResult<{
    items: readonly TItem[];
    nextCursor: string | null;
    hasMore: boolean;
    tailCursor: string | null;
    truncated: boolean;
}>> {
    const input = readRecord(params.input);
    const page = await params.store.pageOlder({
        cursor: readOptionalString(input, 'cursor'),
        maxBytes: normalizeBoundedInt(input.maxBytes, 64 * 1024, 1024 * 1024),
        maxItems: normalizeBoundedInt(input.maxItems, 100, 500),
    });
    return {
        ok: true,
        items: page.items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        tailCursor: page.tailCursor,
        truncated: page.truncated,
    };
}
