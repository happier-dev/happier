import type {
    ExternalSessionsSource,
    ExternalSessionTranscriptRawMessageV1,
} from '@happier-dev/protocol';
import { projectClaudeJsonlLineToDirectMessages } from '../../../transcripts/projection.js';

import { resolveClaudeJsonlSessionFile } from './files.js';
import {
    readClaudeJsonlFileBackwardPage,
    readClaudeJsonlFileForward,
    readClaudeJsonlFileSize,
} from './jsonl.js';

type ClaudeBackwardCursorV1 = Readonly<{
    v: 1;
    kind: 'claudeBackward';
    fileRelPath: string;
    endOffsetBytes: number;
}>;

type ClaudeForwardCursorV1 = Readonly<{
    v: 1;
    kind: 'claudeForward';
    fileRelPath: string;
    offsetBytes: number;
}>;

function encodeCursor(value: ClaudeBackwardCursorV1 | ClaudeForwardCursorV1): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function asCursorRecord(raw: string | undefined): Record<string, unknown> | null {
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

function decodeBackwardCursor(raw: string | undefined): ClaudeBackwardCursorV1 | null {
    const record = asCursorRecord(raw);
    if (!record || record.v !== 1 || record.kind !== 'claudeBackward') return null;
    const fileRelPath = typeof record.fileRelPath === 'string' ? record.fileRelPath : '';
    const endOffsetBytes = typeof record.endOffsetBytes === 'number' && Number.isFinite(record.endOffsetBytes)
        ? Math.trunc(record.endOffsetBytes)
        : Number.NaN;
    return fileRelPath.trim() && endOffsetBytes >= 0
        ? { v: 1, kind: 'claudeBackward', fileRelPath, endOffsetBytes }
        : null;
}

function decodeForwardCursor(raw: string): ClaudeForwardCursorV1 | null {
    const record = asCursorRecord(raw);
    if (!record || record.v !== 1 || record.kind !== 'claudeForward') return null;
    const fileRelPath = typeof record.fileRelPath === 'string' ? record.fileRelPath : '';
    const offsetBytes = typeof record.offsetBytes === 'number' && Number.isFinite(record.offsetBytes)
        ? Math.trunc(record.offsetBytes)
        : Number.NaN;
    return fileRelPath.trim() && offsetBytes >= 0
        ? { v: 1, kind: 'claudeForward', fileRelPath, offsetBytes }
        : null;
}

function projectLines(params: Readonly<{
    lines: ReadonlyArray<Readonly<{ startOffsetBytes: number; value: unknown }>>;
    fileRelPath: string;
    maxItems: number;
}>): ExternalSessionTranscriptRawMessageV1[] {
    const items: ExternalSessionTranscriptRawMessageV1[] = [];
    for (const line of params.lines) {
        if (items.length >= params.maxItems) break;
        const mapped = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: params.fileRelPath,
            lineStartOffsetBytes: line.startOffsetBytes,
            lineValue: line.value,
        });
        for (const item of mapped) {
            if (items.length >= params.maxItems) break;
            items.push(item);
        }
    }
    return items;
}

export async function pageClaudeExternalSessionTranscript(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
    providerSessionId: string;
    direction: 'older' | 'newer';
    cursor?: string;
    maxBytes: number;
    maxItems: number;
}>): Promise<Readonly<{
    items: ExternalSessionTranscriptRawMessageV1[];
    nextCursor: string | null;
    tailCursor: string | null;
    hasMore: boolean;
    truncated?: boolean;
}>> {
    if (params.direction !== 'older') {
        return { items: [], nextCursor: null, tailCursor: null, hasMore: false };
    }

    const resolved = await resolveClaudeJsonlSessionFile({
        source: params.source,
        env: params.env,
        remoteSessionId: params.providerSessionId,
    });
    if (!resolved) {
        return { items: [], nextCursor: null, tailCursor: null, hasMore: false };
    }

    const fileSize = await readClaudeJsonlFileSize(resolved.filePath);
    const tailCursor = encodeCursor({
        v: 1,
        kind: 'claudeForward',
        fileRelPath: resolved.fileRelPath,
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

    const page = await readClaudeJsonlFileBackwardPage({
        filePath: resolved.filePath,
        endOffsetBytes,
        maxBytes: params.maxBytes,
        maxItems: params.maxItems,
    });
    const maxItems = Math.max(1, Math.trunc(params.maxItems));
    const items = projectLines({
        lines: page.items,
        fileRelPath: resolved.fileRelPath,
        maxItems,
    });
    const hasMore = !page.reachedStart;
    const nextCursor = hasMore
        ? encodeCursor({
            v: 1,
            kind: 'claudeBackward',
            fileRelPath: resolved.fileRelPath,
            endOffsetBytes: page.nextEndOffsetBytes,
        })
        : null;
    return { items, nextCursor, tailCursor, hasMore, ...(cursorMismatch ? { truncated: true } : {}) };
}

export async function readAfterClaudeExternalSessionTranscript(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
    providerSessionId: string;
    cursor: string;
    maxBytes: number;
    maxItems: number;
}>): Promise<Readonly<{
    items: ExternalSessionTranscriptRawMessageV1[];
    nextCursor: string | null;
    truncated: boolean;
}>> {
    const resolved = await resolveClaudeJsonlSessionFile({
        source: params.source,
        env: params.env,
        remoteSessionId: params.providerSessionId,
    });
    if (!resolved) {
        return { items: [], nextCursor: null, truncated: false };
    }

    const fileSize = await readClaudeJsonlFileSize(resolved.filePath);
    if (params.cursor === 'tail') {
        return {
            items: [],
            nextCursor: encodeCursor({
                v: 1,
                kind: 'claudeForward',
                fileRelPath: resolved.fileRelPath,
                offsetBytes: fileSize,
            }),
            truncated: false,
        };
    }

    const decoded = decodeForwardCursor(params.cursor);
    if (!decoded) {
        return { items: [], nextCursor: null, truncated: true };
    }
    if (decoded.fileRelPath !== resolved.fileRelPath) {
        return {
            items: [],
            nextCursor: encodeCursor({
                v: 1,
                kind: 'claudeForward',
                fileRelPath: resolved.fileRelPath,
                offsetBytes: fileSize,
            }),
            truncated: true,
        };
    }

    const read = await readClaudeJsonlFileForward({
        filePath: resolved.filePath,
        offsetBytes: Math.max(0, decoded.offsetBytes),
        maxBytes: params.maxBytes,
        maxItems: params.maxItems,
    });
    if (read.truncated) {
        return {
            items: [],
            nextCursor: encodeCursor({
                v: 1,
                kind: 'claudeForward',
                fileRelPath: resolved.fileRelPath,
                offsetBytes: fileSize,
            }),
            truncated: true,
        };
    }

    return {
        items: projectLines({
            lines: read.items,
            fileRelPath: resolved.fileRelPath,
            maxItems: Math.max(1, Math.trunc(params.maxItems)),
        }),
        nextCursor: encodeCursor({
            v: 1,
            kind: 'claudeForward',
            fileRelPath: resolved.fileRelPath,
            offsetBytes: read.nextOffsetBytes,
        }),
        truncated: false,
    };
}
