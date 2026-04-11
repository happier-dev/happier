import { readJsonlFileBackwardPage } from '@/api/session/fileBackedTranscripts/jsonl/pageJsonlBackward';

import { readClaudeJsonlFileSize } from './readClaudeJsonlFileSize';

type ClaudeResolvedJsonlSessionFile = Readonly<{
    filePath: string;
    fileRelPath: string;
}>;

type ClaudeBackwardCursorState = Readonly<{
    fileRelPath: string;
    endOffsetBytes: number;
}>;

function projectBackwardPageItems<TItem>(params: Readonly<{
    items: ReadonlyArray<Readonly<{ startOffsetBytes: number; value: unknown }>>;
    fileRelPath: string;
    maxItems: number;
    projectLine: (params: Readonly<{
        fileRelPath: string;
        lineStartOffsetBytes: number;
        lineValue: unknown;
    }>) => ReadonlyArray<TItem>;
}>): TItem[] {
    const projectedItems: TItem[] = [];
    for (const line of params.items) {
        if (projectedItems.length >= params.maxItems) break;
        const mapped = params.projectLine({
            fileRelPath: params.fileRelPath,
            lineStartOffsetBytes: line.startOffsetBytes,
            lineValue: line.value,
        });
        for (const item of mapped) {
            if (projectedItems.length >= params.maxItems) break;
            projectedItems.push(item);
        }
    }
    return projectedItems;
}

export async function pageClaudeProjectedJsonlSessionTranscript<TItem>(params: Readonly<{
    resolved: ClaudeResolvedJsonlSessionFile | null;
    cursor?: string;
    maxBytes: number;
    maxItems: number;
    decodeCursor: (raw: string | undefined) => ClaudeBackwardCursorState | null;
    encodeCursor: (params: Readonly<{
        fileRelPath: string;
        endOffsetBytes: number;
    }>) => string;
    encodeTailCursor: (params: Readonly<{
        filePath: string;
        fileRelPath: string;
        fileSize: number;
    }>) => string | null;
    projectLine: (params: Readonly<{
        fileRelPath: string;
        lineStartOffsetBytes: number;
        lineValue: unknown;
    }>) => ReadonlyArray<TItem>;
}>): Promise<
    Readonly<{
        items: TItem[];
        nextCursor: string | null;
        tailCursor: string | null;
        hasMore: boolean;
        truncated?: boolean;
    }>
> {
    if (!params.resolved) {
        return { items: [], nextCursor: null, tailCursor: null, hasMore: false };
    }

    const cursor = params.decodeCursor(params.cursor);
    const fileSize = await readClaudeJsonlFileSize(params.resolved.filePath);
    const tailCursor = params.encodeTailCursor({
        filePath: params.resolved.filePath,
        fileRelPath: params.resolved.fileRelPath,
        fileSize,
    });

    let truncated = false;
    let endOffsetBytes: number | null = null;
    if (cursor) {
        if (cursor.fileRelPath !== params.resolved.fileRelPath) {
            truncated = true;
            endOffsetBytes = null;
        } else {
            endOffsetBytes = cursor.endOffsetBytes;
        }
    }

    const resolvedEnd = endOffsetBytes === null ? fileSize : Math.min(fileSize, Math.max(0, Math.trunc(endOffsetBytes)));
    if (resolvedEnd <= 0) {
        return { items: [], nextCursor: null, tailCursor, hasMore: false, ...(truncated ? { truncated } : {}) };
    }

    const page = await readJsonlFileBackwardPage({
        filePath: params.resolved.filePath,
        endOffsetBytes: resolvedEnd,
        maxBytes: Math.max(1, Math.trunc(params.maxBytes)),
        maxItems: Math.max(1, Math.trunc(params.maxItems)),
    });

    const items = projectBackwardPageItems({
        items: page.items,
        fileRelPath: params.resolved.fileRelPath,
        maxItems: Math.max(1, Math.trunc(params.maxItems)),
        projectLine: params.projectLine,
    });

    const hasMore = !page.reachedStart;
    const nextCursor = hasMore
        ? params.encodeCursor({
            fileRelPath: params.resolved.fileRelPath,
            endOffsetBytes: page.nextEndOffsetBytes,
        })
        : null;

    return { items, nextCursor, tailCursor, hasMore, ...(truncated ? { truncated } : {}) };
}
