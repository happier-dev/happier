import {
    saveChangesCursor as saveChangesCursorToPersistence,
    type ChangesCursorScope,
} from '@/sync/domains/state/persistence';

export type ChangesCursorCheckpointStorage = Readonly<{
    saveChangesCursor: (cursor: string, scope?: ChangesCursorScope | null) => void;
}>;

export type ChangesCursorCheckpointResult =
    | Readonly<{ status: 'advanced'; cursor: string }>
    | Readonly<{ status: 'unchanged'; cursor: string | null }>
    | Readonly<{ status: 'refused'; cursor: string | null }>
    | Readonly<{ status: 'storage-write-failed'; cursor: string | null }>;

export function decideChangesCursorCheckpoint(params: {
    currentCursor: string | null;
    approvedCursor: string | null;
    shouldAdvance: boolean;
    scope?: ChangesCursorScope | null;
    storage?: ChangesCursorCheckpointStorage;
}): ChangesCursorCheckpointResult {
    const currentCursor = typeof params.currentCursor === 'string' && params.currentCursor.trim()
        ? params.currentCursor.trim()
        : null;
    const approvedCursor = typeof params.approvedCursor === 'string' && params.approvedCursor.trim()
        ? params.approvedCursor.trim()
        : null;

    if (!params.shouldAdvance || !approvedCursor) {
        return { status: 'refused', cursor: currentCursor };
    }

    if (approvedCursor === currentCursor) {
        return { status: 'unchanged', cursor: currentCursor };
    }

    const storage = params.storage ?? { saveChangesCursor: saveChangesCursorToPersistence };
    try {
        storage.saveChangesCursor(approvedCursor, params.scope);
    } catch {
        return { status: 'storage-write-failed', cursor: currentCursor };
    }

    return { status: 'advanced', cursor: approvedCursor };
}
