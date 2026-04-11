import type { DirectSessionsSource } from '@happier-dev/protocol';

import type { RawJSONLines } from '../../../types';
import { encodeClaudeRawJsonlTranscriptForwardCursor } from './claudeRawJsonlTranscriptForwardCursor';
import { pageClaudeProjectedJsonlSessionTranscript } from './pageClaudeProjectedJsonlSessionTranscript';
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
            kind: 'claudeRawBackward',
            fileRelPath,
            endOffsetBytes,
        }),
        encodeTailCursor: ({ filePath, fileSize }) => encodeClaudeRawJsonlTranscriptForwardCursor({
            v: 1,
            kind: 'claudeScannerForward',
            sessionFilePath: filePath,
            offsetBytes: fileSize,
        }),
        projectLine: ({ lineValue }) => {
            const projected = projectClaudeJsonlLineToRawMessage(lineValue);
            return projected ? [projected] : [];
        },
    });
}
