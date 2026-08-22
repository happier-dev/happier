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
    let writeResult: Readonly<{ imported: number; cursor: string | null }>;
    try {
        writeResult = await params.writeItems(input.items.slice(0, maxItems) as TItem[]);
    } catch (error) {
        if (
            error !== null
            && typeof error === 'object'
            && !Array.isArray(error)
            && (error as { code?: unknown }).code === 'upgrade_required'
        ) {
            return {
                ok: false,
                errorCode: 'upgrade_required',
                message: 'Server upgrade required before transcript import.',
            };
        }
        throw error;
    }
    return {
        ok: true,
        imported: writeResult.imported,
        cursor: writeResult.cursor,
    };
}
