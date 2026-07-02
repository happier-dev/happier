import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import { logger } from '@/ui/logger';
import type { EnhancedMode } from '@/backends/claude/runtime/claudeEnhancedMode';
import type { ClaudeCompletionEvent } from '@/backends/claude/contextCompactionEvents';

import { parseCheckpointsCommand, parseRewindCommand } from './agentSdk/claudeAgentSdkSlashCommands';

type CheckpointLedger = {
    getCheckpointIds: () => string[];
    getLastCheckpointId: () => string | null;
};

export function createClaudeAgentSdkQueuedPromptPump(params: {
    abortSignal: AbortSignal;
    nextMessage: () => Promise<{ message: string; mode: EnhancedMode } | null>;
    endPrompt: () => void;
    closeResponse: () => void | Promise<void>;
    pushUserTextMessage: (message: string) => void;
    enableFileCheckpointing: boolean;
    checkpointLedger: CheckpointLedger;
    onCompletionEvent?: ((message: ClaudeCompletionEvent) => void) | undefined;
    onSessionReset?: (() => void) | undefined;
    getResponse: () => any;
    emitCheckpointRewindMessage: (checkpointId: string) => void;
    recordTraceMarker: (params: { kind: string; payload: Record<string, unknown> }) => void;
    startCompactCommand: () => void;
    setMode: (mode: EnhancedMode) => void;
    updateRuntimeSettingsForMode: (mode: EnhancedMode) => Promise<void>;
    resetTurnOutputState: () => void;
    prepareForQueuedPrompt: () => void;
    updateThinking: (thinking: boolean) => void;
}) {
    const ABORTED = Symbol('aborted');
    let nextMessagePump: Promise<void> | null = null;

    const waitForAbort = (signal: AbortSignal): Promise<typeof ABORTED> =>
        new Promise((resolve) => {
            if (signal.aborted) {
                resolve(ABORTED);
                return;
            }
            signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
        });

    const closePromptAndResponse = async () => {
        params.endPrompt();
        try {
            await params.closeResponse();
        } catch {
            // ignore
        }
    };

    return {
        schedule: () => {
            if (nextMessagePump) return;

            nextMessagePump = (async () => {
                try {
                    while (!params.abortSignal.aborted) {
                        const nextOrAbort = await Promise.race([params.nextMessage(), waitForAbort(params.abortSignal)]);
                        if (nextOrAbort === ABORTED) {
                            return;
                        }

                        const next = nextOrAbort as { message: string; mode: EnhancedMode } | null;
                        if (!next) {
                            await closePromptAndResponse();
                            return;
                        }

                        const checkpointsCommand = parseCheckpointsCommand(next.message);
                        if (checkpointsCommand) {
                            if (!params.enableFileCheckpointing) {
                                params.onCompletionEvent?.('No checkpoints are available unless file checkpointing is enabled.');
                                continue;
                            }

                            const checkpointIds = params.checkpointLedger.getCheckpointIds();
                            if (checkpointIds.length === 0) {
                                params.onCompletionEvent?.('No checkpoints have been captured yet.');
                                continue;
                            }

                            params.onCompletionEvent?.(
                                [
                                    'Available checkpoints (newest first):',
                                    ...checkpointIds
                                        .slice()
                                        .reverse()
                                        .map((id) => `- ${id}`),
                                    '',
                                    'Note: Agent SDK rewind restores files only; it does not rewind the conversation.',
                                    'To rewind: /rewind <checkpoint-id> --confirm',
                                ].join('\n'),
                            );
                            continue;
                        }

                        const rewindCommand = parseRewindCommand(next.message);
                        if (rewindCommand) {
                            if (!params.enableFileCheckpointing) {
                                params.onCompletionEvent?.('Rewind is not available unless file checkpointing is enabled.');
                                continue;
                            }

                            const checkpointId = rewindCommand.checkpointId ?? params.checkpointLedger.getLastCheckpointId();
                            if (!checkpointId) {
                                params.onCompletionEvent?.(
                                    'No checkpoint id is available yet. Send a normal message first, then try /rewind again.',
                                );
                                continue;
                            }

                            if (!rewindCommand.confirmed) {
                                params.onCompletionEvent?.(
                                    [
                                        'Rewind is a destructive filesystem operation.',
                                        'It restores files to a previous checkpoint and may discard your local file edits.',
                                        '',
                                        'Important: Agent SDK rewind restores files only; it does not rewind the conversation.',
                                        '',
                                        `To confirm, re-run: /rewind ${checkpointId} --confirm`,
                                    ].join('\n'),
                                );
                                continue;
                            }

                            const result = await params.getResponse()?.rewindFiles?.(checkpointId, undefined);
                            if (result && typeof result === 'object' && (result as any).canRewind === false) {
                                const error =
                                    typeof (result as any).error === 'string' ? (result as any).error : 'Rewind failed';
                                params.onCompletionEvent?.(error);
                                continue;
                            }

                            params.emitCheckpointRewindMessage(checkpointId);
                            params.recordTraceMarker({
                                kind: 'checkpoint-rewind',
                                payload: { marker: 'checkpoint-rewind', checkpointId },
                            });
                            params.onCompletionEvent?.(`Rewound files to checkpoint ${checkpointId}`);
                            continue;
                        }

                        const nextSpecial = parseSpecialCommand(next.message);
                        if (nextSpecial.type === 'clear') {
                            params.onCompletionEvent?.('Context was reset');
                            params.onSessionReset?.();
                            await closePromptAndResponse();
                            return;
                        }

                        if (nextSpecial.type === 'compact') {
                            params.startCompactCommand();
                        }

                        params.setMode(next.mode);
                        try {
                            await params.updateRuntimeSettingsForMode(next.mode);
                        } catch (error) {
                            logger.debug('[claudeRemoteAgentSdk] Failed to update runtime settings (non-fatal)', error);
                            params.onCompletionEvent?.('Failed to update runtime settings (non-fatal); continuing.');
                        }

                        params.resetTurnOutputState();
                        params.prepareForQueuedPrompt();
                        params.pushUserTextMessage(next.message);
                        params.updateThinking(true);
                        return;
                    }
                } finally {
                    nextMessagePump = null;
                }
            })();
        },
        waitForIdle: async () => {
            if (!nextMessagePump) return;
            await nextMessagePump.catch(() => {});
        },
    };
}
