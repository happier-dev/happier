import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configuration } from '@/configuration';
import { safeJsonStringify } from '@/utils/safeJson';
import { ensureProtectedLocalStateDirectorySync, ensureProtectedLocalStateFileSync } from '@/utils/fs/protectedLocalState';

import type { ToolTraceEventV2 } from './toolTraceEvent';
export { getToolTraceSourceKey, readToolTraceEvent } from './toolTraceEvent';
export type { ToolTraceDirection, ToolTraceEvent, ToolTraceEventV1, ToolTraceEventV2, ToolTraceProtocol } from './toolTraceEvent';

export class ToolTraceWriter {
    private readonly filePath: string;

    constructor(params: { filePath: string }) {
        this.filePath = params.filePath;
        const directory = dirname(this.filePath);
        if (directory === join(configuration.happyHomeDir, 'tool-traces')) {
            ensureProtectedLocalStateDirectorySync(directory, { authority: 'owned' });
        } else {
            // An explicit trace file can live in a user-selected directory;
            // its writer owns the file, not an existing containing directory.
            mkdirSync(directory, { recursive: true, mode: 0o700 });
        }
        // Touch the file so that "tool trace enabled" is observable even before the first event.
        // appendFileSync creates the file if it does not exist and is a no-op for empty content.
        appendFileSync(this.filePath, '', { encoding: 'utf8', mode: 0o600 });
        ensureProtectedLocalStateFileSync(this.filePath, { authority: 'owned' });
    }

    record(event: ToolTraceEventV2): void {
        let line = '';
        try {
            line = `${safeJsonStringifyToolTraceEvent(event)}\n`;
        } catch {
            // Tool trace must never crash the CLI; drop the event if stringification fails unexpectedly.
            return;
        }

        try {
            appendFileSync(this.filePath, line, 'utf8');
        } catch {
            // Best-effort only; never throw from tracing.
        }
    }
}

function safeJsonStringifyToolTraceEvent(event: ToolTraceEventV2): string {
    try {
        return safeJsonStringify(event);
    } catch (error) {
        const details =
            error instanceof Error
                ? (error.message || String(error))
                : String(error);
        try {
            return safeJsonStringify(
                {
                    ...event,
                    payload: `[unserializable payload: ${details}]`,
                } satisfies ToolTraceEventV2,
            );
        } catch {
            return safeJsonStringify({
                v: event.v,
                ts: event.ts,
                direction: event.direction,
                sessionId: event.sessionId,
                source: event.source,
                kind: event.kind,
                localId: event.localId,
                payload: '[unserializable payload]',
                serializationError: details,
            });
        }
    }
}

function isTruthyEnv(value: string | undefined): boolean {
    if (!value) return false;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function resolveToolTraceFilePath(): string {
    const fileFromEnv =
        process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    if (typeof fileFromEnv === 'string' && fileFromEnv.length > 0) return fileFromEnv;

    const dirFromEnv =
        process.env.HAPPIER_STACK_TOOL_TRACE_DIR;
    const dir =
        typeof dirFromEnv === 'string' && dirFromEnv.length > 0
            ? dirFromEnv
            : join(configuration.happyHomeDir, 'tool-traces');

    if (cachedDefaultTraceFilePath && cachedDefaultTraceDir === dir) return cachedDefaultTraceFilePath;

    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    cachedDefaultTraceDir = dir;
    cachedDefaultTraceFilePath = join(dir, `${stamp}-pid-${process.pid}.jsonl`);
    return cachedDefaultTraceFilePath;
}

export function isToolTraceEnabled(): boolean {
    return isTruthyEnv(process.env.HAPPIER_STACK_TOOL_TRACE);
}

let cachedWriter: ToolTraceWriter | null = null;
let cachedFilePath: string | null = null;
let cachedDefaultTraceFilePath: string | null = null;
let cachedDefaultTraceDir: string | null = null;

/**
 * Initialize the tool trace writer when tracing is enabled.
 *
 * This touches the trace file so test harnesses (and developers) can reliably
 * detect that tracing is enabled even if no tool events have been emitted yet.
 */
export function initToolTraceIfEnabled(): void {
    if (!isToolTraceEnabled()) return;

    const filePath = resolveToolTraceFilePath();
    if (!cachedWriter || cachedFilePath !== filePath) {
        cachedFilePath = filePath;
        cachedWriter = new ToolTraceWriter({ filePath });
    }
}

export function recordToolTraceEvent(params: Omit<ToolTraceEventV2, 'v' | 'ts'> & { ts?: number }): void {
    if (!isToolTraceEnabled()) return;

    const filePath = resolveToolTraceFilePath();
    if (!cachedWriter || cachedFilePath !== filePath) {
        cachedFilePath = filePath;
        cachedWriter = new ToolTraceWriter({ filePath });
    }

    cachedWriter.record({
        v: 2,
        ts: typeof params.ts === 'number' ? params.ts : Date.now(),
        direction: params.direction,
        sessionId: params.sessionId,
        source: params.source,
        kind: params.kind,
        payload: params.payload,
        localId: params.localId,
    });
}

export function __resetToolTraceForTests(): void {
    cachedWriter = null;
    cachedFilePath = null;
    cachedDefaultTraceFilePath = null;
    cachedDefaultTraceDir = null;
}
