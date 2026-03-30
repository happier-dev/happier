import type { NormalizedToolChangeResult } from '@/agent/tools/diff/normalizedToolChangeTypes';

type ClaudeWriteToolUseResult = Readonly<{
    type?: string;
    filePath?: string;
    originalFile?: string | null;
    content?: string | null;
}>;

function readWriteToolUseResult(value: unknown): ClaudeWriteToolUseResult | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    return {
        type: typeof raw.type === 'string' ? raw.type : undefined,
        filePath: typeof raw.filePath === 'string' ? raw.filePath : undefined,
        originalFile: typeof raw.originalFile === 'string' ? raw.originalFile : raw.originalFile === null ? null : undefined,
        content: typeof raw.content === 'string' ? raw.content : raw.content === null ? null : undefined,
    };
}

export function normalizeClaudeToolUseResultToToolChangeResult(value: unknown): NormalizedToolChangeResult | undefined {
    const writeResult = readWriteToolUseResult(value);
    if (
        !writeResult ||
        (writeResult.type !== 'update' && writeResult.type !== 'create') ||
        typeof writeResult.content !== 'string'
    ) {
        return undefined;
    }

    return {
        fileMutation: {
            kind: writeResult.type,
            filePath: writeResult.filePath,
            oldText: typeof writeResult.originalFile === 'string' ? writeResult.originalFile : '',
            newText: writeResult.content,
        },
    };
}
