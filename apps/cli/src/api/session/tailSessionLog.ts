import { open, stat } from 'node:fs/promises';

import { normalizeBoundedInt, readRecord, readOptionalString, type SessionTranscriptActionResult } from './sessionTranscriptActionInput';

type TailSessionLogParams = Readonly<{
    input?: unknown;
    resolvedPath?: string | null;
}>;

export async function tailSessionLog(
    params: TailSessionLogParams,
): Promise<SessionTranscriptActionResult<{
    path: string;
    tail: string;
    offset: number;
    nextOffset: number;
    truncated: boolean;
}>> {
    const input = readRecord(params.input);
    const path = params.resolvedPath ?? readOptionalString(input, 'path');
    if (!path) {
        return { ok: false, errorCode: 'missing_path', message: 'Session log path is required.' };
    }

    const maxBytes = normalizeBoundedInt(input.maxBytes, 64 * 1024, 1_000_000);
    const metadata = await stat(path);
    if (!metadata.isFile()) {
        return { ok: false, errorCode: 'path_not_file', message: 'Session log path must be a file.' };
    }

    const fileSize = metadata.size;
    const requestedOffset = typeof input.offset === 'number' && Number.isFinite(input.offset)
        ? Math.max(0, Math.floor(input.offset))
        : null;
    const offset = requestedOffset === null
        ? Math.max(0, fileSize - maxBytes)
        : Math.min(fileSize, requestedOffset);
    const length = Math.min(maxBytes, Math.max(0, fileSize - offset));
    if (length <= 0) {
        return { ok: true, path, tail: '', offset, nextOffset: offset, truncated: false };
    }

    const file = await open(path, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, offset);
        const nextOffset = offset + bytesRead;
        return {
            ok: true,
            path,
            tail: buffer.subarray(0, bytesRead).toString('utf8'),
            offset,
            nextOffset,
            truncated: nextOffset < fileSize,
        };
    } finally {
        await file.close();
    }
}
