import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { TurnDiffEmitter } from '@/agent/tools/diff/turnDiffEmitter';
import {
    collectGeminiToolResultDiffSignals,
    type GeminiToolResultDiffSignal,
} from '@happier-dev/plugins-gemini/agent/diff/toolResult';

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

    private observeGeminiDiffSignal(signal: GeminiToolResultDiffSignal): void {
        if (signal.kind === 'text') {
            this.emitter.observeTextDiff({
                filePath: signal.filePath,
                oldText: signal.oldText,
                newText: signal.newText,
                description: signal.description,
            });
            return;
        }
        this.emitter.observeUnifiedDiff({
            filePath: signal.filePath,
            unifiedDiff: signal.unifiedDiff,
            description: signal.description,
        });
    }

    /**
     * Process a tool result that may contain diff information
     */
    processToolResult(toolName: string, result: unknown, callId: string): void {
        const signals = collectGeminiToolResultDiffSignals(result);
        for (const signal of signals) {
            logger.debug(`[GeminiDiffProcessor] Found ${signal.kind} diff in tool result: ${toolName} (${callId})`);
            this.observeGeminiDiffSignal(signal);
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
