import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { TurnDiffEmitter } from '@/agent/tools/diff/turnDiffEmitter';

export interface DiffToolCall {
    type: 'tool-call';
    name: 'Diff';
    callId: string;
    input: {
        unified_diff?: string;
        files?: Array<{
            file_path: string;
            unified_diff?: string;
            oldText?: string;
            newText?: string;
            description?: string;
        }>;
    };
    id: string;
}

export interface DiffToolResult {
    type: 'tool-call-result';
    callId: string;
    output: {
        status: 'completed';
    };
    id: string;
}

function firstNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function extractTextDiffEntries(result: any): Array<{ path: string; oldText: string; newText: string; description?: string }> {
    const candidates: any[] = [];
    if (Array.isArray(result)) candidates.push(result);
    if (result && typeof result === 'object' && Array.isArray((result as any).output)) candidates.push((result as any).output);
    if (result && typeof result === 'object' && Array.isArray((result as any).result)) candidates.push((result as any).result);

    const entries: Array<{ path: string; oldText: string; newText: string; description?: string }> = [];
    for (const candidate of candidates) {
        for (const item of candidate) {
            if (!item || typeof item !== 'object') continue;
            const type = (item as any).type;
            if (type !== 'diff') continue;
            const path = firstNonEmptyString((item as any).path);
            const oldText = typeof (item as any).oldText === 'string' ? (item as any).oldText : null;
            const newText = typeof (item as any).newText === 'string' ? (item as any).newText : null;
            if (!path || oldText == null || newText == null) continue;
            const description = firstNonEmptyString((item as any).description) ?? undefined;
            entries.push({ path, oldText, newText, description });
        }
    }
    return entries;
}

export class GeminiDiffProcessor {
    private readonly emitter = new TurnDiffEmitter();
    private onMessage: ((message: any) => void) | null = null;

    constructor(onMessage?: (message: any) => void) {
        this.onMessage = onMessage || null;
        this.emitter.beginTurn();
    }

    /**
     * Process an fs-edit event and check if it contains diff information
     */
    processFsEdit(path: string, description?: string, diff?: string): void {
        logger.debug(`[GeminiDiffProcessor] Processing fs-edit for path: ${path}`);
        if (!diff || typeof diff !== 'string' || diff.trim().length === 0) return;
        this.emitter.observeUnifiedDiff({ filePath: path, unifiedDiff: diff, description });
    }

    /**
     * Process a tool result that may contain diff information
     */
    processToolResult(toolName: string, result: any, callId: string): void {
        // Prefer structured old/new diffs if present (more reliable than unified diffs for "net" changes).
        const textDiffs = extractTextDiffEntries(result);
        for (const entry of textDiffs) {
            logger.debug(`[GeminiDiffProcessor] Found text diff in tool result: ${toolName} (${callId})`);
            this.emitter.observeTextDiff({
                filePath: entry.path,
                oldText: entry.oldText,
                newText: entry.newText,
                description: entry.description,
            });
        }

        // Check if result contains diff information
        if (result && typeof result === 'object') {
            // Look for common diff fields
            const diff = result.diff || result.unified_diff || result.patch;
            const path = result.path || result.file;
            
            if (typeof diff === 'string' && diff.trim().length > 0 && typeof path === 'string' && path.trim().length > 0) {
                logger.debug(`[GeminiDiffProcessor] Found diff in tool result: ${toolName} (${callId})`);
                this.emitter.observeUnifiedDiff({ filePath: path, unifiedDiff: diff, description: result.description });
            } else if (result.changes && typeof result.changes === 'object') {
                // Handle multiple file changes (like patch operations)
                for (const [filePath, change] of Object.entries(result.changes)) {
                    const changeDiff = (change as any)?.diff || (change as any)?.unified_diff || (change as any)?.patch;
                    if (typeof filePath !== 'string' || filePath.trim().length === 0) continue;
                    if (typeof changeDiff !== 'string' || changeDiff.trim().length === 0) continue;
                    this.emitter.observeUnifiedDiff({
                        filePath,
                        unifiedDiff: changeDiff,
                        description: (change as any)?.description,
                    });
                }
            }
        }
    }

    /**
     * Emit the aggregated diff tool calls for the current turn (if any).
     */
    flushTurn(): void {
        const input: DiffToolCall['input'] = this.emitter.flushTurn();
        if (!input.files && !input.unified_diff) return;

        const callId = randomUUID();
        const toolCall: DiffToolCall = {
            type: 'tool-call',
            name: 'Diff',
            callId,
            input,
            id: randomUUID(),
        };
        this.onMessage?.(toolCall);

        const toolResult: DiffToolResult = {
            type: 'tool-call-result',
            callId,
            output: { status: 'completed' },
            id: randomUUID(),
        };
        this.onMessage?.(toolResult);
    }

    /**
     * Convenience helper for the common "turn finished" path.
     * Emits any buffered diffs, then clears turn state.
     */
    completeTurn(): void {
        this.flushTurn();
        this.reset();
    }

    /**
     * Reset the processor state (called on task_complete or turn_aborted)
     */
    reset(): void {
        logger.debug('[GeminiDiffProcessor] Resetting diff state');
        this.emitter.beginTurn();
    }

    /**
     * Set the message callback for sending messages directly
     */
    setMessageCallback(callback: (message: any) => void): void {
        this.onMessage = callback;
    }

    // Intentionally no getters for turn state; use tool-tracing fixtures/tests for validation.
}
