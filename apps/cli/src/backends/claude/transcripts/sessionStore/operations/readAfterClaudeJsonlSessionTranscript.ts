import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { readJsonlFileForward } from '@/api/session/fileBackedTranscripts/jsonl/readJsonlForward';

import { projectClaudeJsonlLineToDirectMessages } from '../../projection/projectClaudeJsonlLineToDirectMessages';
import {
    decodeClaudeJsonlTranscriptForwardCursor,
    encodeClaudeJsonlTranscriptForwardCursor,
} from './claudeJsonlTranscriptForwardCursor';
import { readClaudeJsonlFileSize } from './readClaudeJsonlFileSize';
import { resolveClaudeJsonlSessionFile } from './resolveClaudeJsonlSessionFile';

export async function readAfterClaudeJsonlSessionTranscript(params: Readonly<{
    source: DirectSessionsSource;
    env?: NodeJS.ProcessEnv;
    remoteSessionId: string;
    cursor: string;
    maxBytes: number;
    maxItems: number;
}>): Promise<Readonly<{ items: DirectTranscriptRawMessageV1[]; nextCursor: string | null; truncated: boolean }>> {
    const resolved = await resolveClaudeJsonlSessionFile({
        source: params.source,
        env: params.env,
        remoteSessionId: params.remoteSessionId,
    });
    if (!resolved) {
        return { items: [], nextCursor: null, truncated: false };
    }

    const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
    const maxItems = Math.max(1, Math.trunc(params.maxItems));

    if (params.cursor === 'tail') {
        const fileSize = await readClaudeJsonlFileSize(resolved.filePath);
        return {
            items: [],
            nextCursor: encodeClaudeJsonlTranscriptForwardCursor({
                v: 1,
                kind: 'claudeForward',
                fileRelPath: resolved.fileRelPath,
                offsetBytes: fileSize,
            }),
            truncated: false,
        };
    }

    const decoded = decodeClaudeJsonlTranscriptForwardCursor(params.cursor);
    if (!decoded) {
        return { items: [], nextCursor: null, truncated: true };
    }

    if (decoded.fileRelPath !== resolved.fileRelPath) {
        const fileSize = await readClaudeJsonlFileSize(resolved.filePath);
        return {
            items: [],
            nextCursor: encodeClaudeJsonlTranscriptForwardCursor({
                v: 1,
                kind: 'claudeForward',
                fileRelPath: resolved.fileRelPath,
                offsetBytes: fileSize,
            }),
            truncated: true,
        };
    }

    const read = await readJsonlFileForward({
        filePath: resolved.filePath,
        offsetBytes: Math.max(0, decoded.offsetBytes),
        maxBytes,
        maxItems,
    });
    if (read.truncated) {
        const fileSize = await readClaudeJsonlFileSize(resolved.filePath);
        return {
            items: [],
            nextCursor: encodeClaudeJsonlTranscriptForwardCursor({
                v: 1,
                kind: 'claudeForward',
                fileRelPath: resolved.fileRelPath,
                offsetBytes: fileSize,
            }),
            truncated: true,
        };
    }

    const items: DirectTranscriptRawMessageV1[] = [];
    for (const line of read.items) {
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

    return {
        items,
        nextCursor: encodeClaudeJsonlTranscriptForwardCursor({
            v: 1,
            kind: 'claudeForward',
            fileRelPath: resolved.fileRelPath,
            offsetBytes: read.nextOffsetBytes,
        }),
        truncated: false,
    };
}
