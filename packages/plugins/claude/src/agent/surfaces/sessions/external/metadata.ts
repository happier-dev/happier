import type {
    ExternalSessionActivityV1,
    ExternalSessionsSource,
} from '@happier-dev/protocol';

import { readClaudeJsonlFileForward } from './jsonl.js';
import { resolveClaudeJsonlSessionFile } from './files.js';

const TITLE_SCAN_CHUNK_MAX_BYTES = 128 * 1024;
const TITLE_SCAN_CHUNK_MAX_ITEMS = 64;
const TITLE_SCAN_TOTAL_MAX_BYTES = 1024 * 1024;
const TITLE_SCAN_TOTAL_MAX_ITEMS = 512;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

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
            const record = asRecord(item);
            return typeof record?.text === 'string' ? record.text : '';
        })
        .filter((part) => part.trim().length > 0)
        .join(' ');
    return readTitleCandidate(text);
}

export async function readClaudeJsonlSessionTitle(filePath: string): Promise<string | null> {
    let assistantFallback: string | null = null;
    let offsetBytes = 0;
    let scannedBytes = 0;
    let scannedItems = 0;

    while (scannedBytes < TITLE_SCAN_TOTAL_MAX_BYTES && scannedItems < TITLE_SCAN_TOTAL_MAX_ITEMS) {
        const page = await readClaudeJsonlFileForward({
            filePath,
            offsetBytes,
            maxBytes: Math.min(TITLE_SCAN_CHUNK_MAX_BYTES, TITLE_SCAN_TOTAL_MAX_BYTES - scannedBytes),
            maxItems: Math.min(TITLE_SCAN_CHUNK_MAX_ITEMS, TITLE_SCAN_TOTAL_MAX_ITEMS - scannedItems),
        });

        for (const line of page.items) {
            const record = asRecord(line.value);
            if (!record) continue;
            if (record.type === 'summary' && typeof record.summary === 'string') {
                const summaryTitle = readTitleCandidate(record.summary);
                if (summaryTitle) return summaryTitle;
            }
            if (record.type === 'queue-operation' && record.operation === 'enqueue') {
                const queuedTitle = coerceTextContent(record.content);
                if (queuedTitle) return queuedTitle;
            }

            const message = asRecord(record.message);
            const messageTitle = coerceTextContent(message?.content);
            if (record.type === 'user' && messageTitle) return messageTitle;
            if (record.type === 'assistant' && assistantFallback === null && messageTitle) {
                assistantFallback = messageTitle;
            }
        }

        if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) break;
        scannedBytes += Math.max(0, page.nextOffsetBytes - offsetBytes);
        scannedItems += page.items.length;
        offsetBytes = page.nextOffsetBytes;
    }

    return assistantFallback;
}

export async function readClaudeJsonlSessionWorkingDirectory(params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
    env: NodeJS.ProcessEnv;
}>): Promise<string | null> {
    const resolved = await resolveClaudeJsonlSessionFile(params);
    if (!resolved) return null;
    let offsetBytes = 0;
    while (true) {
        const page = await readClaudeJsonlFileForward({
            filePath: resolved.filePath,
            offsetBytes,
            maxBytes: TITLE_SCAN_CHUNK_MAX_BYTES,
            maxItems: TITLE_SCAN_CHUNK_MAX_ITEMS,
        });
        for (const line of page.items) {
            const record = asRecord(line.value);
            const cwd = typeof record?.cwd === 'string' ? record.cwd.trim() : '';
            if (cwd) return cwd;
        }
        if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) return null;
        offsetBytes = page.nextOffsetBytes;
    }
}

function resolveRecentActivityWindowMs(env: NodeJS.ProcessEnv): number {
    const raw = Number.parseInt(String(env.HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 15_000;
    return Math.max(1000, Math.min(60 * 60 * 1000, configured));
}

export function deriveClaudeExternalSessionActivity(params: Readonly<{
    updatedAtMs: number | null | undefined;
    env: NodeJS.ProcessEnv;
    nowMs?: number;
}>): ExternalSessionActivityV1 {
    const updatedAtMs = typeof params.updatedAtMs === 'number' && Number.isFinite(params.updatedAtMs)
        ? Math.trunc(params.updatedAtMs)
        : null;
    if (updatedAtMs === null || updatedAtMs < 0) return 'unknown';

    const ageMs = (params.nowMs ?? Date.now()) - updatedAtMs;
    if (!Number.isFinite(ageMs) || ageMs < 0) return 'unknown';
    return ageMs <= resolveRecentActivityWindowMs(params.env) ? 'active_recently' : 'idle';
}
