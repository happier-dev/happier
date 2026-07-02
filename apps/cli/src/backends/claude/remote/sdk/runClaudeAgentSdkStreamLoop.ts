import { join } from 'node:path';

import { logger } from '@/ui/logger';
import type { StreamedTranscriptFlushSummary } from '@/api/session/streamedTranscriptWriter';
import { getProjectPath } from '@/backends/claude/utils/path';
import type { SDKMessage, SDKSystemMessage } from '@/backends/claude/sdk';
import {
    hasClaudeAgentSdkRuntimeAuthFailureEvidence,
    isClaudeAgentSdkStopHookWithNoBackgroundTasks,
    isTerminalClaudeAgentSdkProviderTaskStatus,
    readClaudeAgentSdkBackgroundTaskId,
    readClaudeAgentSdkProviderTaskStatus,
    readClaudeAgentSdkResultFailure,
    readClaudeAgentSdkResultText,
} from '@happier-dev/plugins-claude/agent/runtime/remote/sdk';
import type { ClaudeCompletionEvent } from '@/backends/claude/contextCompactionEvents';
import {
    mapClaudeRateLimitEventToUsageDetails,
    type NormalizedClaudeUsageLimitDetails,
} from '@happier-dev/plugins-claude/agent/auth/services/runtime';

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

function readCompactBoundaryMetadata(system: Record<string, unknown>): {
    trigger?: 'manual' | 'auto' | 'threshold' | 'overflow' | 'unknown';
    tokenCountBefore?: number;
    tokenCountSource?: string;
} {
    const metadata = system.compact_metadata;
    if (!metadata || typeof metadata !== 'object') return {};
    const record = metadata as Record<string, unknown>;

    const trigger = (() => {
        const raw = record.trigger;
        if (
            raw === 'manual' ||
            raw === 'auto' ||
            raw === 'threshold' ||
            raw === 'overflow' ||
            raw === 'unknown'
        ) {
            return raw;
        }
        return undefined;
    })();

    const tokenCountBefore = typeof record.pre_tokens === 'number' && Number.isFinite(record.pre_tokens)
        ? record.pre_tokens
        : undefined;

    return {
        ...(trigger ? { trigger } : {}),
        ...(typeof tokenCountBefore === 'number'
            ? {
                tokenCountBefore,
                tokenCountSource: 'claude-compact-metadata.pre_tokens',
            }
            : {}),
    };
}

export async function runClaudeAgentSdkStreamLoop(params: {
    response: AsyncIterable<unknown>;
    shapeLogger: { log: (shape: string, payload: unknown) => void };
    turnLifecycle: {
        noteIncomingMessageBeforeDiagnostics: (message: unknown, inboundType: string) => void;
        recordInboundType: (inboundType: string) => void;
        onTurnStartBoundary: () => void;
        onPreparedIncomingMessage: (incomingMessageType: unknown) => void;
        finalizeCurrentTurn: (options?: { completionEvent?: ClaudeCompletionEvent }) => Promise<void>;
        releaseCurrentTurnForResult: () => Promise<void>;
        finalizeSubagentTurn: () => Promise<void>;
        noteProviderTaskStarted: (taskId: unknown) => void;
        noteProviderTaskProgress: (taskId: unknown) => void;
        noteProviderTaskFinished: (taskId: unknown) => void;
        noteBackgroundProviderTask: (taskId: unknown) => void;
        noteNoActiveBackgroundProviderTasks: () => void;
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
        noteTaskStarted: (taskId: unknown, status?: unknown) => void;
        noteTaskProgress: (taskId: unknown, status?: unknown) => void;
        noteTaskNotification: (taskId: unknown, status: unknown) => boolean;
    };
    recordSessionFound: (sessionId: string, data?: { transcript_path?: string; transcriptPath?: string }) => void;
    workDir: string;
    claudeConfigDir: string | null | undefined;
    enableFileCheckpointing: boolean;
    checkpointLedger: CheckpointLedger;
    onCheckpointCaptured?: ((checkpointId: string) => void) | undefined;
    onRateLimitEvent?: ((details: NormalizedClaudeUsageLimitDetails) => void | Promise<void>) | undefined;
    onRuntimeAuthFailureEvent?: ((error: unknown) => boolean | void | Promise<boolean | void>) | undefined;
    onCompletionEvent?: ((message: ClaudeCompletionEvent) => void) | undefined;
    buildCompactionCompletedEvent: (params?: Readonly<{
        providerSessionId?: string | null;
        trigger?: 'manual' | 'auto' | 'threshold' | 'overflow' | 'unknown';
        tokenCountBefore?: number;
        tokenCountSource?: string;
    }>) => ClaudeCompletionEvent;
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
        if (isClaudeAgentSdkStopHookWithNoBackgroundTasks(message)) {
            params.turnLifecycle.noteNoActiveBackgroundProviderTasks();
        }
        params.turnLifecycle.noteIncomingMessageBeforeDiagnostics(message, inboundType);
        params.turnLifecycle.recordInboundType(inboundType);
        params.turnLifecycle.onTurnStartBoundary();

        if (hasClaudeAgentSdkRuntimeAuthFailureEvidence(message)) {
            const handled = await params.onRuntimeAuthFailureEvent?.(message);
            if (handled !== false) {
                const preparedMessage = params.turnOutputRuntime.prepareIncomingMessage(message as SDKMessage);
                if (preparedMessage) params.emitMessage(preparedMessage);
                return;
            }
        }

        if (inboundType === 'rate_limit_event') {
            const details = mapClaudeRateLimitEventToUsageDetails(message);
            if (details) {
                await params.onRateLimitEvent?.(details);
            }
            continue;
        }

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
            const taskStatus = readClaudeAgentSdkProviderTaskStatus(system);
            const isTerminalTaskStatus = isTerminalClaudeAgentSdkProviderTaskStatus(taskStatus);

            if (subtype === 'task_started') {
                params.turnLifecycle.noteProviderTaskStarted((system as any).task_id);
                params.interruptController.noteTaskStarted(
                    (system as any).task_id,
                    taskStatus,
                );
                if (isTerminalTaskStatus) {
                    params.turnLifecycle.noteProviderTaskFinished((system as any).task_id);
                }
            } else if (subtype === 'task_progress') {
                params.turnLifecycle.noteProviderTaskProgress((system as any).task_id);
                params.interruptController.noteTaskProgress(
                    (system as any).task_id,
                    taskStatus,
                );
                if (isTerminalTaskStatus) {
                    params.turnLifecycle.noteProviderTaskFinished((system as any).task_id);
                }
            } else if (subtype === 'task_notification') {
                const shouldFlushSubagent = params.interruptController.noteTaskNotification(
                    (system as any).task_id,
                    taskStatus,
                );
                if (shouldFlushSubagent) {
                    await params.turnLifecycle.finalizeSubagentTurn();
                    params.turnLifecycle.noteProviderTaskFinished((system as any).task_id);
                }
            }

            if ((subtype === 'init' || subtype === 'compact_boundary') && system.session_id) {
                const transcriptPath = join(
                    getProjectPath(params.workDir, params.claudeConfigDir ?? undefined),
                    `${system.session_id}.jsonl`,
                );
                logger.debug(
                    subtype === 'compact_boundary'
                        ? '[claudeRemoteAgentSdk] Compact boundary'
                        : '[claudeRemoteAgentSdk] Session initialized',
                    {
                        claudeSessionId: system.session_id,
                        transcriptPath,
                    },
                );
                params.recordSessionFound(system.session_id, { transcript_path: transcriptPath, transcriptPath });
                if (subtype === 'compact_boundary') {
                    const completionEvent = params.buildCompactionCompletedEvent({
                        providerSessionId: system.session_id,
                        ...readCompactBoundaryMetadata(system as Record<string, unknown>),
                    });
                    if (params.isCompactCommandActive()) {
                        params.setCompactCommandActive(false);
                        await params.turnLifecycle.finalizeCurrentTurn({ completionEvent });
                    } else {
                        params.onCompletionEvent?.(completionEvent);
                    }
                } else if (params.isCompactCommandActive()) {
                    params.setCompactCommandActive(false);
                    await params.turnLifecycle.finalizeCurrentTurn({
                        completionEvent: params.buildCompactionCompletedEvent({
                            providerSessionId: system.session_id,
                            trigger: 'manual',
                        }),
                    });
                }
            }
        }

        if (message && message.type === 'user') {
            const msg = message as any;
            params.turnLifecycle.noteBackgroundProviderTask(readClaudeAgentSdkBackgroundTaskId(msg));
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
            const failure = readClaudeAgentSdkResultFailure(message);
            if (failure) {
                throw new Error(failure);
            }

            const resultText = readClaudeAgentSdkResultText(message);
            params.turnOutputRuntime.bufferResultAssistantTextIfNeeded(message, resultText);

            if (!params.turnLifecycle.isTurnFinalized()) {
                if (params.isCompactCommandActive()) {
                    params.setCompactCommandActive(false);
                    await params.turnLifecycle.finalizeCurrentTurn({
                        completionEvent: params.buildCompactionCompletedEvent({ trigger: 'manual' }),
                    });
                } else {
                    await params.turnLifecycle.releaseCurrentTurnForResult();
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
