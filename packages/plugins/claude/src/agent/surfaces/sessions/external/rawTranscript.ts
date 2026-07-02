import type { ExternalSessionsSource } from '@happier-dev/protocol';

import {
    projectClaudeJsonlLineToRawMessage,
    type RawJSONLines,
} from '../../../transcripts/index.js';

import { resolveClaudeJsonlSessionFile } from './files.js';
import {
    readClaudeJsonlFileBackwardPage,
    readClaudeJsonlFileForward,
    readClaudeJsonlFileSize,
} from './jsonl.js';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_ITEMS = 1000;

type ClaudeRawBackwardCursorV1 = Readonly<{
    v: 1;
    kind: 'claudeRawBackward';
    fileRelPath: string;
    endOffsetBytes: number;
}>;

type ClaudeRawForwardCursorV1 = Readonly<{
    v: 1;
    kind: 'claudeScannerForward';
    sessionFilePath: string;
    offsetBytes: number;
}>;

function encodeCursor(value: ClaudeRawBackwardCursorV1 | ClaudeRawForwardCursorV1): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function asCursorRecord(raw: string | null | undefined): Record<string, unknown> | null {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    try {
        const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function decodeBackwardCursor(raw: string | undefined): ClaudeRawBackwardCursorV1 | null {
    const parsed = asCursorRecord(raw);
    if (!parsed || parsed.v !== 1 || parsed.kind !== 'claudeRawBackward') return null;
    const fileRelPath = typeof parsed.fileRelPath === 'string' ? parsed.fileRelPath : '';
    const endOffsetBytes =
        typeof parsed.endOffsetBytes === 'number' && Number.isFinite(parsed.endOffsetBytes)
            ? Math.trunc(parsed.endOffsetBytes)
            : Number.NaN;
    if (!fileRelPath.trim()) return null;
    if (!Number.isFinite(endOffsetBytes) || endOffsetBytes < 0) return null;
    return { v: 1, kind: 'claudeRawBackward', fileRelPath, endOffsetBytes };
}

function decodeForwardCursor(raw: string | null | undefined): ClaudeRawForwardCursorV1 | null {
    const parsed = asCursorRecord(raw);
    if (!parsed || parsed.v !== 1 || parsed.kind !== 'claudeScannerForward') return null;
    const sessionFilePath = typeof parsed.sessionFilePath === 'string' ? parsed.sessionFilePath : '';
    const offsetBytes =
        typeof parsed.offsetBytes === 'number' && Number.isFinite(parsed.offsetBytes)
            ? Math.trunc(parsed.offsetBytes)
            : Number.NaN;
    if (!sessionFilePath.trim()) return null;
    if (!Number.isFinite(offsetBytes) || offsetBytes < 0) return null;
    return { v: 1, kind: 'claudeScannerForward', sessionFilePath, offsetBytes };
}

function encodeTailCursor(params: Readonly<{
    filePath: string;
    offsetBytes: number;
}>): string {
    return encodeCursor({
        v: 1,
        kind: 'claudeScannerForward',
        sessionFilePath: params.filePath,
        offsetBytes: params.offsetBytes,
    });
}

function projectRawLines(params: Readonly<{
    lines: ReadonlyArray<Readonly<{ value: unknown }>>;
    maxItems: number;
}>): RawJSONLines[] {
    const items: RawJSONLines[] = [];
    for (const line of params.lines) {
        if (items.length >= params.maxItems) break;
        const projected = projectClaudeJsonlLineToRawMessage(line.value);
        if (projected) {
            items.push(projected);
        }
    }
    return items;
}

async function readFullRawHistory(params: Readonly<{
    sessionFilePath: string;
    maxBytes: number;
    maxItems: number;
}>): Promise<Readonly<{
    items: RawJSONLines[];
    nextCursor: string | null;
    initialized: boolean;
}>> {
    const fileSize = await readClaudeJsonlFileSize(params.sessionFilePath);
    if (fileSize <= 0) {
        return { items: [], nextCursor: null, initialized: false };
    }

    const pageBatches: RawJSONLines[][] = [];
    let endOffsetBytes = fileSize;

    while (endOffsetBytes > 0) {
        const page = await readClaudeJsonlFileBackwardPage({
            filePath: params.sessionFilePath,
            endOffsetBytes,
            maxBytes: params.maxBytes,
            maxItems: params.maxItems,
        });
        pageBatches.push(projectRawLines({
            lines: page.items,
            maxItems: params.maxItems,
        }));

        if (page.reachedStart) break;
        endOffsetBytes = page.nextEndOffsetBytes;
    }

    return {
        items: pageBatches.reverse().flatMap((batch) => batch),
        nextCursor: encodeTailCursor({
            filePath: params.sessionFilePath,
            offsetBytes: fileSize,
        }),
        initialized: true,
    };
}

export async function pageClaudeRawExternalSessionTranscript(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
    remoteSessionId: string;
    cursor?: string;
    maxBytes: number;
    maxItems: number;
}>): Promise<Readonly<{
    items: RawJSONLines[];
    nextCursor: string | null;
    tailCursor: string | null;
    hasMore: boolean;
    truncated?: boolean;
}>> {
    const resolved = await resolveClaudeJsonlSessionFile({
        source: params.source,
        env: params.env,
        remoteSessionId: params.remoteSessionId,
    });
    if (!resolved) {
        return { items: [], nextCursor: null, tailCursor: null, hasMore: false };
    }

    const fileSize = await readClaudeJsonlFileSize(resolved.filePath);
    const tailCursor = encodeTailCursor({
        filePath: resolved.filePath,
        offsetBytes: fileSize,
    });
    const decoded = decodeBackwardCursor(params.cursor);
    const cursorMismatch = Boolean(decoded && decoded.fileRelPath !== resolved.fileRelPath);
    const endOffsetBytes = cursorMismatch || !decoded
        ? fileSize
        : Math.min(fileSize, Math.max(0, decoded.endOffsetBytes));
    if (endOffsetBytes <= 0) {
        return { items: [], nextCursor: null, tailCursor, hasMore: false, ...(cursorMismatch ? { truncated: true } : {}) };
    }

    const maxItems = Math.max(1, Math.trunc(params.maxItems));
    const page = await readClaudeJsonlFileBackwardPage({
        filePath: resolved.filePath,
        endOffsetBytes,
        maxBytes: params.maxBytes,
        maxItems,
    });
    const hasMore = !page.reachedStart;
    const nextCursor = hasMore
        ? encodeCursor({
            v: 1,
            kind: 'claudeRawBackward',
            fileRelPath: resolved.fileRelPath,
            endOffsetBytes: page.nextEndOffsetBytes,
        })
        : null;

    return {
        items: projectRawLines({ lines: page.items, maxItems }),
        nextCursor,
        tailCursor,
        hasMore,
        ...(cursorMismatch ? { truncated: true } : {}),
    };
}

export async function readClaudeRawJsonlSessionMessages(params: Readonly<{
    sessionFilePath: string;
    cursor: string | null;
    maxBytes?: number;
    maxItems?: number;
}>): Promise<Readonly<{
    items: RawJSONLines[];
    nextCursor: string | null;
    initialized: boolean;
    truncated: boolean;
}>> {
    const maxBytes = Math.max(1, Math.trunc(params.maxBytes ?? DEFAULT_MAX_BYTES));
    const maxItems = Math.max(1, Math.trunc(params.maxItems ?? DEFAULT_MAX_ITEMS));

    if (params.cursor === 'tail') {
        const fileSize = await readClaudeJsonlFileSize(params.sessionFilePath);
        return {
            items: [],
            nextCursor: encodeTailCursor({
                filePath: params.sessionFilePath,
                offsetBytes: fileSize,
            }),
            initialized: fileSize > 0,
            truncated: false,
        };
    }

    if (!params.cursor) {
        const full = await readFullRawHistory({
            sessionFilePath: params.sessionFilePath,
            maxBytes,
            maxItems,
        });
        return { ...full, truncated: false };
    }

    const decoded = decodeForwardCursor(params.cursor);
    if (!decoded || decoded.sessionFilePath !== params.sessionFilePath) {
        const full = await readFullRawHistory({
            sessionFilePath: params.sessionFilePath,
            maxBytes,
            maxItems,
        });
        return { ...full, truncated: true };
    }

    const read = await readClaudeJsonlFileForward({
        filePath: params.sessionFilePath,
        offsetBytes: decoded.offsetBytes,
        maxBytes,
        maxItems,
    });
    if (read.truncated) {
        const full = await readFullRawHistory({
            sessionFilePath: params.sessionFilePath,
            maxBytes,
            maxItems,
        });
        return { ...full, truncated: true };
    }

    return {
        items: projectRawLines({ lines: read.items, maxItems }),
        nextCursor: encodeTailCursor({
            filePath: params.sessionFilePath,
            offsetBytes: read.nextOffsetBytes,
        }),
        initialized: true,
        truncated: false,
    };
}

export async function readAfterClaudeRawExternalSessionTranscript(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
    remoteSessionId: string;
    cursor: string | null;
    maxBytes?: number;
    maxItems?: number;
}>): Promise<Readonly<{
    items: RawJSONLines[];
    nextCursor: string | null;
    initialized: boolean;
    truncated: boolean;
}>> {
    const resolved = await resolveClaudeJsonlSessionFile({
        source: params.source,
        env: params.env,
        remoteSessionId: params.remoteSessionId,
    });
    if (!resolved) {
        return { items: [], nextCursor: null, initialized: false, truncated: false };
    }
    return readClaudeRawJsonlSessionMessages({
        sessionFilePath: resolved.filePath,
        cursor: params.cursor,
        maxBytes: params.maxBytes,
        maxItems: params.maxItems,
    });
}
