import { stat } from 'node:fs/promises';

import { readJsonlFileBackwardPage } from '@/api/session/fileBackedTranscripts/jsonl/pageJsonlBackward';
import { readJsonlFileForward } from '@/api/session/fileBackedTranscripts/jsonl/readJsonlForward';

import type { RawJSONLines } from '../../../types';
import { projectClaudeJsonlLineToRawMessage } from '../../projection/projectClaudeJsonlLineToRawMessage';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_ITEMS = 1000;

type ClaudeRawScannerForwardCursor = Readonly<{
    v: 1;
    kind: 'claudeScannerForward';
    sessionFilePath: string;
    offsetBytes: number;
}>;

function encodeForwardCursor(value: ClaudeRawScannerForwardCursor): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeForwardCursor(raw: string | null | undefined): ClaudeRawScannerForwardCursor | null {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    try {
        const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<ClaudeRawScannerForwardCursor>;
        if (parsed.v !== 1 || parsed.kind !== 'claudeScannerForward') return null;
        if (typeof parsed.sessionFilePath !== 'string' || parsed.sessionFilePath.trim().length === 0) return null;
        if (typeof parsed.offsetBytes !== 'number' || !Number.isFinite(parsed.offsetBytes) || parsed.offsetBytes < 0) return null;
        return {
            v: 1,
            kind: 'claudeScannerForward',
            sessionFilePath: parsed.sessionFilePath,
            offsetBytes: Math.trunc(parsed.offsetBytes),
        };
    } catch {
        return null;
    }
}

async function readFileSize(sessionFilePath: string): Promise<number> {
    return stat(sessionFilePath).then((entry) => entry.size).catch(() => 0);
}

async function readFullHistory(sessionFilePath: string, maxBytes: number, maxItems: number): Promise<{
    items: RawJSONLines[];
    nextCursor: string | null;
    initialized: boolean;
}> {
    const fileSize = await readFileSize(sessionFilePath);
    if (fileSize <= 0) {
        return { items: [], nextCursor: null, initialized: false };
    }

    const pageBatches: RawJSONLines[][] = [];
    let endOffsetBytes = fileSize;

    while (endOffsetBytes > 0) {
        const page = await readJsonlFileBackwardPage({
            filePath: sessionFilePath,
            endOffsetBytes,
            maxBytes,
            maxItems,
        });

        const batch: RawJSONLines[] = [];
        for (const line of page.items) {
            const projected = projectClaudeJsonlLineToRawMessage(line.value);
            if (projected) {
                batch.push(projected);
            }
        }
        pageBatches.push(batch);

        if (page.reachedStart) {
            break;
        }
        endOffsetBytes = page.nextEndOffsetBytes;
    }

    return {
        items: pageBatches.reverse().flatMap((batch) => batch),
        nextCursor: encodeForwardCursor({
            v: 1,
            kind: 'claudeScannerForward',
            sessionFilePath,
            offsetBytes: fileSize,
        }),
        initialized: true,
    };
}

export async function readClaudeRawJsonlSessionMessages(params: Readonly<{
    sessionFilePath: string;
    cursor: string | null;
    maxBytes?: number;
    maxItems?: number;
}>): Promise<{
    items: RawJSONLines[];
    nextCursor: string | null;
    initialized: boolean;
    truncated: boolean;
}> {
    const maxBytes = Math.max(1, Math.trunc(params.maxBytes ?? DEFAULT_MAX_BYTES));
    const maxItems = Math.max(1, Math.trunc(params.maxItems ?? DEFAULT_MAX_ITEMS));

    if (params.cursor === 'tail') {
        const fileSize = await readFileSize(params.sessionFilePath);
        return {
            items: [],
            nextCursor: encodeForwardCursor({
                v: 1,
                kind: 'claudeScannerForward',
                sessionFilePath: params.sessionFilePath,
                offsetBytes: fileSize,
            }),
            initialized: fileSize > 0,
            truncated: false,
        };
    }

    if (!params.cursor) {
        const full = await readFullHistory(params.sessionFilePath, maxBytes, maxItems);
        return { ...full, truncated: false };
    }

    const decoded = decodeForwardCursor(params.cursor);
    if (!decoded || decoded.sessionFilePath !== params.sessionFilePath) {
        const full = await readFullHistory(params.sessionFilePath, maxBytes, maxItems);
        return { ...full, truncated: true };
    }

    const read = await readJsonlFileForward({
        filePath: params.sessionFilePath,
        offsetBytes: decoded.offsetBytes,
        maxBytes,
        maxItems,
    });
    if (read.truncated) {
        const full = await readFullHistory(params.sessionFilePath, maxBytes, maxItems);
        return { ...full, truncated: true };
    }

    const items: RawJSONLines[] = [];
    for (const line of read.items) {
        const projected = projectClaudeJsonlLineToRawMessage(line.value);
        if (projected) {
            items.push(projected);
        }
    }

    return {
        items,
        nextCursor: encodeForwardCursor({
            v: 1,
            kind: 'claudeScannerForward',
            sessionFilePath: params.sessionFilePath,
            offsetBytes: read.nextOffsetBytes,
        }),
        initialized: true,
        truncated: false,
    };
}
