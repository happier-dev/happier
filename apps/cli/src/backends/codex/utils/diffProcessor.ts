/**
 * Diff Processor - Handles turn_diff messages and tracks unified_diff changes
 * 
 * This processor tracks the latest unified_diff snapshot for a turn and emits a
 * single CodexDiff tool call at turn completion.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { TurnDiffEmitter } from '@/agent/tools/diff/turnDiffEmitter';

export interface DiffToolCall {
    type: 'tool-call';
    name: 'CodexDiff';
    callId: string;
    input: {
        unified_diff: string;
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

export class DiffProcessor {
    private readonly emitter = new TurnDiffEmitter({ snapshotUnifiedDiff: true });
    private onMessage: ((message: any) => void) | null = null;

    constructor(onMessage?: (message: any) => void) {
        this.onMessage = onMessage || null;
        this.emitter.beginTurn();
    }

    /**
     * Capture the latest unified diff snapshot for the current turn.
     */
    processDiff(unifiedDiff: string): void {
        this.emitter.observeUnifiedDiffSnapshot({ unifiedDiff });
        logger.debug('[DiffProcessor] Captured unified diff snapshot');
    }

    /**
     * Emit the aggregated diff tool call for the current turn (if any).
     */
    flushTurn(): void {
        const input = this.emitter.flushTurn();
        const unifiedDiff = input.unified_diff;
        if (!unifiedDiff) return;

        const callId = randomUUID();
        const toolCall: DiffToolCall = {
            type: 'tool-call',
            name: 'CodexDiff',
            callId,
            input: { unified_diff: unifiedDiff },
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
     * Reset the processor state (called on task_complete or turn_aborted)
     */
    reset(): void {
        logger.debug('[DiffProcessor] Resetting diff state');
        this.emitter.beginTurn();
    }

    /**
     * Set the message callback for sending messages directly
     */
    setMessageCallback(callback: (message: any) => void): void {
        this.onMessage = callback;
    }

    /**
     * Get the current diff value
     */
    // Intentionally no getters for turn state; use tool-tracing fixtures/tests for validation.
}
