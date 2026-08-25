import {
    isRecord,
} from '@happier-dev/plugin-sdk';
import {
    readJsonlFileForward,
} from '@happier-dev/plugin-sdk/sessions/file-stores';

import {
    resolveClaudeJsonlSessionFile,
} from './files.js';
import type { ClaudeExternalSessionSource } from './source.js';

const TITLE_SCAN_CHUNK_MAX_BYTES = 128 * 1024;
const TITLE_SCAN_CHUNK_MAX_ITEMS = 64;

function readTitleCandidate(value: string): string | null {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized.slice(0, 10_000) : null;
}

function coerceTextContent(content: unknown): string | null {
    if (typeof content === 'string') {
        return readTitleCandidate(content);
    }
    if (!Array.isArray(content)) return null;

    const text = content
        .map((item) => {
            return isRecord(item) && typeof item.text === 'string' ? item.text : '';
        })
        .filter((part) => part.trim().length > 0)
        .join(' ');
    return readTitleCandidate(text);
}

/**
 * Candidate titles are the first meaningful immutable user message. The one
 * bounded head read deliberately excludes mutable custom/history/AI titles and
 * does not walk a transcript corpus when the first user text is absent.
 */
export async function readClaudeJsonlSessionTitle(filePath: string): Promise<string | null> {
    const page = await readJsonlFileForward({
        filePath,
        offsetBytes: 0,
        maxBytes: TITLE_SCAN_CHUNK_MAX_BYTES,
        maxItems: TITLE_SCAN_CHUNK_MAX_ITEMS,
    });
    for (const line of page.items) {
        if (!isRecord(line.value) || line.value.type !== 'user') continue;
        const message = isRecord(line.value.message) ? line.value.message : null;
        const title = coerceTextContent(message?.content);
        if (title) return title;
    }
    return null;
}

export async function readClaudeJsonlSessionWorkingDirectory(params: Readonly<{
    source: ClaudeExternalSessionSource;
    remoteSessionId: string;
    env: NodeJS.ProcessEnv;
}>): Promise<string | null> {
    const resolved = await resolveClaudeJsonlSessionFile(params);
    if (!resolved) return null;
    let offsetBytes = 0;
    while (true) {
        const page = await readJsonlFileForward({
            filePath: resolved.filePath,
            offsetBytes,
            maxBytes: TITLE_SCAN_CHUNK_MAX_BYTES,
            maxItems: TITLE_SCAN_CHUNK_MAX_ITEMS,
        });
        for (const line of page.items) {
            const cwd = isRecord(line.value) && typeof line.value.cwd === 'string'
                ? line.value.cwd.trim()
                : '';
            if (cwd) return cwd;
        }
        if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) return null;
        offsetBytes = page.nextOffsetBytes;
    }
}
