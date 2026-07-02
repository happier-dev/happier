import { repairClaudeTranscriptAfterInterrupt } from './agentSdk/repairClaudeTranscriptAfterInterrupt';
import {
    isTerminalClaudeAgentSdkProviderTaskStatus,
    normalizeClaudeAgentSdkProviderTaskId,
} from '@happier-dev/plugins-claude/agent/runtime/remote/sdk';

type FlushReason = 'tool-call-boundary' | 'turn-end' | 'abort';

export function createClaudeAgentSdkInterruptController(params: {
    getResponse: () => any;
    updateThinking: (thinking: boolean) => void;
    flushStreamedTranscriptWriter: (reason: FlushReason, interruptedReason?: string) => Promise<unknown>;
    clearBufferedAssistantMessages: (incoming: unknown) => void;
    setTurnInterrupt?: ((handler: (() => Promise<void>) | null) => void) | null;
    getSessionId: () => string | null;
    getTranscriptPath: () => string | null;
    workDir: string;
    claudeConfigDir: string | null | undefined;
    abortSignal: AbortSignal;
}) {
    let activeTaskId: string | null = null;
    let deferredInterruptedReason: string | null = null;
    let didRequestTurnInterrupt = false;

    const interruptTurn = async (): Promise<void> => {
        let stopTaskSucceeded = false;
        try {
            const response = params.getResponse();
            const stopTask = response?.stopTask;
            if (typeof stopTask === 'function') {
                const taskId = activeTaskId;
                if (typeof taskId === 'string' && taskId.trim().length > 0) {
                    didRequestTurnInterrupt = true;
                    deferredInterruptedReason = deferredInterruptedReason ?? 'turn-interrupt';
                    try {
                        await stopTask.call(response, taskId);
                        stopTaskSucceeded = true;
                        return;
                    } catch {
                        // Best-effort: if stopTask fails, fall back to interrupt().
                    }
                }
            }

            const interrupt = response?.interrupt;
            if (typeof interrupt === 'function') {
                didRequestTurnInterrupt = true;
                deferredInterruptedReason = deferredInterruptedReason ?? 'turn-interrupt';
                await interrupt.call(response);
            }
        } catch {
            // Best-effort: interrupt is optional and should not crash cancellation.
        } finally {
            params.updateThinking(false);
            if (!stopTaskSucceeded) {
                try {
                    params.clearBufferedAssistantMessages(null);
                } catch {
                    // ignore
                }
                await params.flushStreamedTranscriptWriter('abort', 'turn-interrupt');
            }
        }
    };

    params.setTurnInterrupt?.(interruptTurn);

    return {
        noteTaskStarted: (taskId: unknown, status?: unknown) => {
            const normalizedTaskId = normalizeClaudeAgentSdkProviderTaskId(taskId);
            const isTerminalTaskStatus = isTerminalClaudeAgentSdkProviderTaskStatus(status);
            if (normalizedTaskId && !isTerminalTaskStatus) {
                activeTaskId = normalizedTaskId;
            }
            if (normalizedTaskId && isTerminalTaskStatus && normalizedTaskId === activeTaskId) {
                activeTaskId = null;
            }
        },
        noteTaskProgress: (taskId: unknown, status?: unknown) => {
            const normalizedTaskId = normalizeClaudeAgentSdkProviderTaskId(taskId);
            const isTerminalTaskStatus = isTerminalClaudeAgentSdkProviderTaskStatus(status);
            if (!activeTaskId && normalizedTaskId && !isTerminalTaskStatus) {
                activeTaskId = normalizedTaskId;
            }
            if (normalizedTaskId && isTerminalTaskStatus && normalizedTaskId === activeTaskId) {
                activeTaskId = null;
            }
        },
        noteTaskNotification: (taskId: unknown, status: unknown) => {
            const normalizedTaskId = normalizeClaudeAgentSdkProviderTaskId(taskId);
            const isTerminalTaskStatus = isTerminalClaudeAgentSdkProviderTaskStatus(status);
            if (normalizedTaskId && normalizedTaskId === activeTaskId && isTerminalTaskStatus) {
                activeTaskId = null;
            }
            return isTerminalTaskStatus;
        },
        clearActiveTask: () => {
            activeTaskId = null;
        },
        consumeDeferredInterruptedReason: () => {
            const interruptedReason = deferredInterruptedReason;
            deferredInterruptedReason = null;
            return interruptedReason;
        },
        repairTranscriptAfterAbort: async () => {
            if (!didRequestTurnInterrupt && !params.abortSignal.aborted) return;
            try {
                await repairClaudeTranscriptAfterInterrupt({
                    sessionId: params.getSessionId(),
                    transcriptPath: params.getTranscriptPath(),
                    workDir: params.workDir,
                    claudeConfigDir: params.claudeConfigDir ?? null,
                });
            } catch {
                // Best-effort: transcript repair should never crash the runner.
            }
        },
        dispose: () => {
            params.setTurnInterrupt?.(null);
        },
    };
}
