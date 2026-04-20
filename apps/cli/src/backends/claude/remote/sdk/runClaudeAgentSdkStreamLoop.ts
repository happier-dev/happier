import { join } from 'node:path';

import { logger } from '@/ui/logger';
import type { StreamedTranscriptFlushSummary } from '@/api/session/streamedTranscriptWriter';
import { getProjectPath } from '@/backends/claude/utils/path';
import type { SDKMessage, SDKSystemMessage } from '@/backends/claude/sdk';

type CheckpointLedger = {
    captureUserTextCheckpoint: (params: {
        enabled: boolean;
        isUserTextMessage: boolean;
        uuid: string | null;
        onCheckpointCaptured?: ((checkpointId: string) => void) | undefined;
    }) => void;
};

function isUserTextMessage(message: unknown): boolean {
    const msg = message as any;
    return (
        msg?.message?.role === 'user' &&
        ((typeof msg.message.content === 'string' && msg.message.content.trim().length > 0) ||
            (Array.isArray(msg.message.content) &&
                msg.message.content.some(
                    (content: any) => content?.type === 'text' && typeof content.text === 'string' && content.text.trim().length > 0,
                )))
    );
}

function extractResultText(message: unknown): string | null {
    const msg: any = message;
    if (!msg || typeof msg !== 'object') return null;
    if (msg.type !== 'result') return null;
    return typeof msg.result === 'string' && msg.result.trim().length > 0 ? msg.result : null;
}

export async function runClaudeAgentSdkStreamLoop(params: {
    response: AsyncIterable<unknown>;
    shapeLogger: { log: (shape: string, payload: unknown) => void };
    turnLifecycle: {
        recordInboundType: (inboundType: string) => void;
        onTurnStartBoundary: () => void;
        onPreparedIncomingMessage: (incomingMessageType: unknown) => void;
        finalizeCurrentTurn: (options?: { completionEvent?: string }) => Promise<void>;
        isTurnFinalized: () => boolean;
        getLastTurnFlushSummary: () => StreamedTranscriptFlushSummary | null;
    };
    turnOutputRuntime: {
        handleStreamEvent: (message: unknown) => Promise<boolean>;
        prepareIncomingMessage: (message: SDKMessage) => SDKMessage | null;
        bufferResultAssistantTextIfNeeded: (message: unknown, resultText: string | null) => void;
        maybeEmitResultAssistantFallback: (
            message: unknown,
            resultText: string | null,
            lastTurnFlushSummary: StreamedTranscriptFlushSummary | null,
        ) => void;
    };
    emitMessage: (message: SDKMessage, hints?: { defaultUuid?: string | null }) => void;
    interruptController: {
        noteTaskStarted: (taskId: unknown) => void;
        noteTaskProgress: (taskId: unknown) => void;
        noteTaskNotification: (taskId: unknown, status: unknown) => boolean;
    };
    recordSessionFound: (sessionId: string, data?: { transcript_path?: string; transcriptPath?: string }) => void;
    workDir: string;
    claudeConfigDir: string | null | undefined;
    enableFileCheckpointing: boolean;
    checkpointLedger: CheckpointLedger;
    onCheckpointCaptured?: ((checkpointId: string) => void) | undefined;
    isAborted: (toolCallId: string) => boolean;
    isCompactCommandActive: () => boolean;
    setCompactCommandActive: (active: boolean) => void;
}) {
    for await (const message of params.response as any) {
        const inboundType = (() => {
            if (!message || typeof message !== 'object') return 'unknown';
            const raw = (message as any).type;
            return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : 'unknown';
        })();
        params.shapeLogger.log(`inbound:${inboundType}`, message);
        params.turnLifecycle.recordInboundType(inboundType);
        params.turnLifecycle.onTurnStartBoundary();

        if (await params.turnOutputRuntime.handleStreamEvent(message)) {
            continue;
        }

        const incomingMessageType = (message as any)?.type;
        const preparedMessage = params.turnOutputRuntime.prepareIncomingMessage(message as SDKMessage);
        if (!preparedMessage) continue;
        params.emitMessage(preparedMessage);
        params.turnLifecycle.onPreparedIncomingMessage(incomingMessageType);

        if (message && message.type === 'system') {
            const system = message as SDKSystemMessage;
            const subtype = (system as any).subtype;

            if (subtype === 'task_started') {
                params.interruptController.noteTaskStarted((system as any).task_id);
            } else if (subtype === 'task_progress') {
                params.interruptController.noteTaskProgress((system as any).task_id);
            } else if (subtype === 'task_notification') {
                const shouldFinalize = params.interruptController.noteTaskNotification(
                    (system as any).task_id,
                    (system as any).status,
                );
                if (shouldFinalize) {
                    await params.turnLifecycle.finalizeCurrentTurn();
                }
            }

            if (subtype === 'init' && system.session_id) {
                const transcriptPath = join(
                    getProjectPath(params.workDir, params.claudeConfigDir ?? undefined),
                    `${system.session_id}.jsonl`,
                );
                logger.debug('[claudeRemoteAgentSdk] Session initialized', {
                    claudeSessionId: system.session_id,
                    transcriptPath,
                });
                params.recordSessionFound(system.session_id, { transcript_path: transcriptPath, transcriptPath });
                if (params.isCompactCommandActive()) {
                    params.setCompactCommandActive(false);
                    await params.turnLifecycle.finalizeCurrentTurn({ completionEvent: 'Compaction completed' });
                }
            }
        }

        if (message && message.type === 'user') {
            const msg = message as any;
            params.checkpointLedger.captureUserTextCheckpoint({
                enabled: params.enableFileCheckpointing,
                isUserTextMessage: isUserTextMessage(msg),
                uuid: typeof msg.uuid === 'string' && msg.uuid.length > 0 ? msg.uuid : null,
                onCheckpointCaptured: params.onCheckpointCaptured,
            });
            if (msg.message?.role === 'user' && Array.isArray(msg.message.content)) {
                for (const content of msg.message.content) {
                    if (content.type === 'tool_result' && content.tool_use_id && params.isAborted(content.tool_use_id)) {
                        logger.debug('[claudeRemoteAgentSdk] Tool aborted, exiting claudeRemoteAgentSdk');
                        return;
                    }
                }
            }
        }

        if (message && message.type === 'result') {
            const resultText = extractResultText(message);
            params.turnOutputRuntime.bufferResultAssistantTextIfNeeded(message, resultText);

            if (!params.turnLifecycle.isTurnFinalized()) {
                if (params.isCompactCommandActive()) {
                    params.setCompactCommandActive(false);
                    await params.turnLifecycle.finalizeCurrentTurn({ completionEvent: 'Compaction completed' });
                } else {
                    await params.turnLifecycle.finalizeCurrentTurn();
                }
            }

            params.turnOutputRuntime.maybeEmitResultAssistantFallback(
                message,
                resultText,
                params.turnLifecycle.getLastTurnFlushSummary(),
            );

            if (params.turnLifecycle.isTurnFinalized()) {
                continue;
            }
        }
    }
}
