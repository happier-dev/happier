import { logger } from '@/ui/logger';
import { TurnChangeSetCollector } from '@/agent/tools/diff/turnChangeSetCollector';
import { emitCanonicalTurnDiffTool } from '@/agent/runtime/emitCanonicalTurnDiffTool';

export interface DiffToolCall {
    type: 'tool-call';
    name: 'Diff';
    callId: string;
    input: Record<string, unknown>;
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
    private readonly collector = new TurnChangeSetCollector({
        provider: 'codex',
        snapshotUnifiedDiff: true,
    });
    private onMessage: ((message: any) => void) | null = null;

    constructor(onMessage?: (message: any) => void) {
        this.onMessage = onMessage || null;
        this.collector.beginTurn();
    }

    /**
     * Capture the latest unified diff snapshot for the current turn.
     */
    processDiff(unifiedDiff: string): void {
        this.collector.observeUnifiedDiffSnapshot({
            unifiedDiff,
            source: 'provider_native',
            confidence: 'exact',
        });
        logger.debug('[DiffProcessor] Captured unified diff snapshot');
    }

    /**
     * Emit the aggregated diff tool call for the current turn (if any).
     */
    flushTurn(): void {
        const turnChangeSet = this.collector.flushTurn({
            sessionId: 'codex-legacy-session',
            turnId: `codex-turn-${Date.now()}`,
            seqRange: { startSeqInclusive: 0, endSeqInclusive: 0 },
            status: 'completed',
        });
        if (!turnChangeSet) return;

        emitCanonicalTurnDiffTool({
            turnChangeSet,
            protocol: 'codex',
            rawToolName: 'CodexDiff',
            sendToolCall: ({ toolName, input, callId }) => {
                const message: DiffToolCall = {
                    type: 'tool-call',
                    name: 'Diff',
                    callId: callId ?? '',
                    input: input as Record<string, unknown>,
                    id: callId ?? '',
                };
                this.onMessage?.(message);
                return message.callId;
            },
            sendToolResult: ({ callId, output }) => {
                const message: DiffToolResult = {
                    type: 'tool-call-result',
                    callId,
                    output: output as { status: 'completed' },
                    id: callId,
                };
                this.onMessage?.(message);
            },
        });
    }

    /**
     * Reset the processor state (called on task_complete or turn_aborted)
     */
    reset(): void {
        logger.debug('[DiffProcessor] Resetting diff state');
        this.collector.beginTurn();
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
