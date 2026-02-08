import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __resetToolTraceForTests } from '@/agent/tools/trace/toolTrace';

type RecordLike = Record<string, unknown>;

export function createMockSession(overrides: RecordLike = {}) {
    const base = {
        id: 'test-session-id',
        seq: 0,
        metadata: {
            path: '/tmp',
            host: 'localhost',
            homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy',
            happyLibDir: '/home/user/.happy/lib',
            happyToolsDir: '/home/user/.happy/tools',
        },
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy' as const,
    };

    return { ...base, ...overrides };
}

export async function withToolTraceFile(
    prefix: string,
    fn: (filePath: string) => Promise<void> | void,
): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const filePath = join(dir, 'tool-trace.jsonl');

    const prevTrace = process.env.HAPPIER_STACK_TOOL_TRACE;
    const prevTraceFile = process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    const prevTraceDir = process.env.HAPPIER_STACK_TOOL_TRACE_DIR;

    process.env.HAPPIER_STACK_TOOL_TRACE = '1';
    process.env.HAPPIER_STACK_TOOL_TRACE_FILE = filePath;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_DIR;
    __resetToolTraceForTests();

    try {
        await fn(filePath);
    } finally {
        if (prevTrace === undefined) {
            delete process.env.HAPPIER_STACK_TOOL_TRACE;
        } else {
            process.env.HAPPIER_STACK_TOOL_TRACE = prevTrace;
        }

        if (prevTraceFile === undefined) {
            delete process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
        } else {
            process.env.HAPPIER_STACK_TOOL_TRACE_FILE = prevTraceFile;
        }

        if (prevTraceDir === undefined) {
            delete process.env.HAPPIER_STACK_TOOL_TRACE_DIR;
        } else {
            process.env.HAPPIER_STACK_TOOL_TRACE_DIR = prevTraceDir;
        }

        __resetToolTraceForTests();
        rmSync(dir, { recursive: true, force: true });
    }
}
