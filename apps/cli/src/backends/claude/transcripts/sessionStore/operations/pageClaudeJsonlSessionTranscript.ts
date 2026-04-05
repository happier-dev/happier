import { stat } from 'node:fs/promises';

import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { readJsonlFileBackwardPage } from '@/api/session/fileBackedTranscripts/jsonl/pageJsonlBackward';

import { projectClaudeJsonlLineToDirectMessages } from '../../projection/projectClaudeJsonlLineToDirectMessages';
import { encodeClaudeJsonlTranscriptForwardCursor } from './claudeJsonlTranscriptForwardCursor';
import { resolveClaudeJsonlSessionFile } from './resolveClaudeJsonlSessionFile';

type ClaudeJsonlBackwardCursorV1 = Readonly<{
    v: 1;
    kind: 'claudeBackward';
    fileRelPath: string;
    endOffsetBytes: number;
}>;

function encodeBackwardCursor(value: ClaudeJsonlBackwardCursorV1): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeBackwardCursor(raw: string | undefined): ClaudeJsonlBackwardCursorV1 | null {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    try {
        const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object') return null;
        const record = parsed as Record<string, unknown>;
        if (record.v !== 1 || record.kind !== 'claudeBackward') return null;
        const fileRelPath = typeof record.fileRelPath === 'string' ? record.fileRelPath : '';
        const endOffsetBytes =
            typeof record.endOffsetBytes === 'number' && Number.isFinite(record.endOffsetBytes)
                ? Math.trunc(record.endOffsetBytes)
                : Number.NaN;
        if (!fileRelPath.trim()) return null;
        if (!Number.isFinite(endOffsetBytes) || endOffsetBytes < 0) return null;
        return { v: 1, kind: 'claudeBackward', fileRelPath, endOffsetBytes };
    } catch {
        return null;
    }
}

export async function pageClaudeJsonlSessionTranscript(params: Readonly<{
    source: DirectSessionsSource;
    env?: NodeJS.ProcessEnv;
    remoteSessionId: string;
    cursor?: string;
    maxBytes: number;
    maxItems: number;
}>): Promise<
    Readonly<{
        items: DirectTranscriptRawMessageV1[];
        nextCursor: string | null;
        tailCursor: string | null;
        hasMore: boolean;
        truncated?: boolean;
    }>
> {
    const resolved = await resolveClaudeJsonlSessionFile({
        source: params.source,
        env: params.env,
        remoteSessionId: params.remoteSessionId,
    });
    if (!resolved) {
        return { items: [], nextCursor: null, tailCursor: null, hasMore: false };
    }

    const cursor = decodeBackwardCursor(params.cursor);
    const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
    const maxItems = Math.max(1, Math.trunc(params.maxItems));

    const fileStat = await stat(resolved.filePath).catch(() => null);
    const fileSize = fileStat ? fileStat.size : 0;
    const tailCursor = encodeClaudeJsonlTranscriptForwardCursor({
        v: 1,
        kind: 'claudeForward',
        fileRelPath: resolved.fileRelPath,
        offsetBytes: fileSize,
    });

    let truncated = false;
    let endOffsetBytes: number | null = null;
    if (cursor) {
        if (cursor.fileRelPath !== resolved.fileRelPath) {
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
        filePath: resolved.filePath,
        endOffsetBytes: resolvedEnd,
        maxBytes,
        maxItems,
    });

    const items: DirectTranscriptRawMessageV1[] = [];
    for (const line of page.items) {
        if (items.length >= maxItems) break;
        const mapped = projectClaudeJsonlLineToDirectMessages({
            fileRelPath: resolved.fileRelPath,
            lineStartOffsetBytes: line.startOffsetBytes,
            lineValue: line.value,
        });
        for (const item of mapped) {
            if (items.length >= maxItems) break;
            items.push(item);
        }
    }

    const hasMore = !page.reachedStart;
    const nextCursor = hasMore
        ? encodeBackwardCursor({
              v: 1,
              kind: 'claudeBackward',
              fileRelPath: resolved.fileRelPath,
              endOffsetBytes: page.nextEndOffsetBytes,
          })
        : null;

    return { items, nextCursor, tailCursor, hasMore, ...(truncated ? { truncated } : {}) };
}
