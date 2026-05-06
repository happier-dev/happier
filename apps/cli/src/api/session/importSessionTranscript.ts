import {
    normalizeBoundedInt,
    readRecord,
    type SessionTranscriptActionResult,
} from './sessionTranscriptActionInput';

type ImportSessionTranscriptParams<TItem> = Readonly<{
    input?: unknown;
    writeItems: (items: readonly TItem[]) => Promise<Readonly<{ imported: number; cursor: string | null }>>;
}>;

export async function importSessionTranscript<TItem>(
    params: ImportSessionTranscriptParams<TItem>,
): Promise<SessionTranscriptActionResult<{ imported: number; cursor: string | null }>> {
    const input = readRecord(params.input);
    if (!Array.isArray(input.items)) {
        return { ok: false, errorCode: 'missing_items', message: 'Transcript import items are required.' };
    }
    const maxItems = normalizeBoundedInt(input.maxItems, 500, 500);
    const writeResult = await params.writeItems(input.items.slice(0, maxItems) as TItem[]);
    return {
        ok: true,
        imported: writeResult.imported,
        cursor: writeResult.cursor,
    };
}
