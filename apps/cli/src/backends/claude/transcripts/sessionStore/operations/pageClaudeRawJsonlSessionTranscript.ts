import type { DirectSessionsSource } from '@happier-dev/protocol';

import { readJsonlFileBackwardPage } from '@/api/session/fileBackedTranscripts/jsonl/pageJsonlBackward';

import type { RawJSONLines } from '../../../types';
import { projectClaudeJsonlLineToRawMessage } from '../../projection/projectClaudeJsonlLineToRawMessage';
import { resolveClaudeJsonlSessionFile } from './resolveClaudeJsonlSessionFile';

type ClaudeRawBackwardCursorV1 = Readonly<{
    v: 1;
    kind: 'claudeRawBackward';
    fileRelPath: string;
    endOffsetBytes: number;
}>;

function encodeBackwardCursor(value: ClaudeRawBackwardCursorV1): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeBackwardCursor(raw: string | undefined): ClaudeRawBackwardCursorV1 | null {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    try {
        const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (parsed.v !== 1 || parsed.kind !== 'claudeRawBackward') return null;
        const fileRelPath = typeof parsed.fileRelPath === 'string' ? parsed.fileRelPath : '';
        const endOffsetBytes =
            typeof parsed.endOffsetBytes === 'number' && Number.isFinite(parsed.endOffsetBytes)
                ? Math.trunc(parsed.endOffsetBytes)
                : Number.NaN;
        if (!fileRelPath.trim()) return null;
        if (!Number.isFinite(endOffsetBytes) || endOffsetBytes < 0) return null;
        return { v: 1, kind: 'claudeRawBackward', fileRelPath, endOffsetBytes };
    } catch {
        return null;
    }
}

export async function pageClaudeRawJsonlSessionTranscript(params: Readonly<{
    source: DirectSessionsSource;
    env?: NodeJS.ProcessEnv;
    remoteSessionId: string;
    cursor?: string;
    maxBytes: number;
    maxItems: number;
}>): Promise<
    Readonly<{
        items: RawJSONLines[];
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

    const fileSize = await import('node:fs/promises').then(({ stat }) => stat(resolved.filePath).then((entry) => entry.size).catch(() => 0));
    const tailRead = await import('./readClaudeRawJsonlSessionMessages').then(({ readClaudeRawJsonlSessionMessages }) =>
        readClaudeRawJsonlSessionMessages({
            sessionFilePath: resolved.filePath,
            cursor: 'tail',
            maxBytes: params.maxBytes,
            maxItems: params.maxItems,
        }),
    );

    const resolvedEnd = endOffsetBytes === null ? fileSize : Math.min(fileSize, Math.max(0, Math.trunc(endOffsetBytes)));
    if (resolvedEnd <= 0) {
        return {
            items: [],
            nextCursor: null,
            tailCursor: tailRead.nextCursor,
            hasMore: false,
            ...(truncated ? { truncated } : {}),
        };
    }

    const page = await readJsonlFileBackwardPage({
        filePath: resolved.filePath,
        endOffsetBytes: resolvedEnd,
        maxBytes: Math.max(1, Math.trunc(params.maxBytes)),
        maxItems: Math.max(1, Math.trunc(params.maxItems)),
    });

    const items: RawJSONLines[] = [];
    for (const line of page.items) {
        if (items.length >= params.maxItems) break;
        const projected = projectClaudeJsonlLineToRawMessage(line.value);
        if (projected) {
            items.push(projected);
        }
    }

    return {
        items,
        nextCursor: page.reachedStart
            ? null
            : encodeBackwardCursor({
                  v: 1,
                  kind: 'claudeRawBackward',
                  fileRelPath: resolved.fileRelPath,
                  endOffsetBytes: page.nextEndOffsetBytes,
              }),
        tailCursor: tailRead.nextCursor,
        hasMore: !page.reachedStart,
        ...(truncated ? { truncated } : {}),
    };
}
