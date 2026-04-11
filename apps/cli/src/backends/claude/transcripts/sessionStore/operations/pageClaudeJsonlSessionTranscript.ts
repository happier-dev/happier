import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { projectClaudeJsonlLineToDirectMessages } from '../../projection/projectClaudeJsonlLineToDirectMessages';
import { encodeClaudeJsonlTranscriptForwardCursor } from './claudeJsonlTranscriptForwardCursor';
import { pageClaudeProjectedJsonlSessionTranscript } from './pageClaudeProjectedJsonlSessionTranscript';
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
    return await pageClaudeProjectedJsonlSessionTranscript({
        resolved: await resolveClaudeJsonlSessionFile({
        source: params.source,
        env: params.env,
        remoteSessionId: params.remoteSessionId,
        }),
        cursor: params.cursor,
        maxBytes: params.maxBytes,
        maxItems: params.maxItems,
        decodeCursor: decodeBackwardCursor,
        encodeCursor: ({ fileRelPath, endOffsetBytes }) => encodeBackwardCursor({
            v: 1,
            kind: 'claudeBackward',
            fileRelPath,
            endOffsetBytes,
        }),
        encodeTailCursor: ({ fileRelPath, fileSize }) => encodeClaudeJsonlTranscriptForwardCursor({
            v: 1,
            kind: 'claudeForward',
            fileRelPath,
            offsetBytes: fileSize,
        }),
        projectLine: ({ fileRelPath, lineStartOffsetBytes, lineValue }) => projectClaudeJsonlLineToDirectMessages({
            fileRelPath,
            lineStartOffsetBytes,
            lineValue,
        }),
    });
}
