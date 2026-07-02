import { AbortError as AgentSdkAbortError } from '@anthropic-ai/claude-agent-sdk';

import { configuration } from '@/configuration';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import { logger } from '@/ui/logger';
import { recordToolTraceEvent } from '@/agent/tools/trace/toolTrace';
import { createEventShapeLoggerForLog } from '@/diagnostics/eventShapeForLog';

import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';
import {
    buildClaudeCompactionCompletedEvent,
    buildClaudeCompactionLifecycleId,
    buildClaudeCompactionStartedEvent,
} from '@/backends/claude/contextCompactionEvents';
import type { StreamedTranscriptFlushSummary } from '@/api/session/streamedTranscriptWriter';
import { createClaudeAgentSdkCheckpointLedger } from './createClaudeAgentSdkCheckpointLedger';
import { createClaudeAgentSdkTurnOutputRuntime } from './createClaudeAgentSdkTurnOutputRuntime';
import { prepareClaudeAgentSdkLaunchContext } from './prepareClaudeAgentSdkLaunchContext';
import type { RunClaudeRemoteAgentSdkOptions } from './runAgentSdkTypes';
import {
    applyRuntimeSettingsUpdatesIfNeeded,
    resolveDesiredRuntimeSettingsSnapshot,
} from './agentSdk/claudeAgentSdkLaunchConfig';
import { createClaudeAgentSdkSessionController } from './createClaudeAgentSdkSessionController';
import { createClaudeAgentSdkPromptChannel } from './createClaudeAgentSdkPromptChannel';
import { createClaudeAgentSdkMessageEmitter } from './createClaudeAgentSdkMessageEmitter';
import { createClaudeAgentSdkInterruptController } from './createClaudeAgentSdkInterruptController';
import { createClaudeAgentSdkTurnLifecycle } from './createClaudeAgentSdkTurnLifecycle';
import { createClaudeAgentSdkQueuedPromptPump } from './createClaudeAgentSdkQueuedPromptPump';
import { publishClaudeAgentSdkCapabilities } from './publishClaudeAgentSdkCapabilities';
import { runClaudeAgentSdkStreamLoop } from './runClaudeAgentSdkStreamLoop';
import { enrichClaudeAgentSdkErrorArtifacts } from './enrichClaudeAgentSdkErrorArtifacts';
import { finalizeClaudeAgentSdkRun } from './finalizeClaudeAgentSdkRun';

export async function runClaudeRemoteAgentSdk(opts: RunClaudeRemoteAgentSdkOptions) {
    const recordTraceMarker = (params: { kind: string; payload: Record<string, unknown> }) => {
        recordToolTraceEvent({
            direction: 'outbound',
            sessionId: opts.sessionId ?? 'unknown',
            protocol: 'claude',
            provider: 'claude',
            kind: params.kind,
            payload: params.payload,
        });
    };

    const initial = await opts.nextMessage();
    if (!initial) return;

    const specialCommand = parseSpecialCommand(initial.message);
    if (specialCommand.type === 'clear') {
        opts.onCompletionEvent?.('Context was reset');
        opts.onSessionReset?.();
        return;
    }

    let isCompactCommand = false;
    let compactionSequence = 0;
    let activeCompactionLifecycleId: string | null = null;
    const nextCompactionLifecycleId = (sessionId?: string | null) => buildClaudeCompactionLifecycleId({
        sessionId: sessionId ?? opts.sessionId,
        sequence: ++compactionSequence,
    });
    const startCompactCommand = () => {
        const lifecycleId = nextCompactionLifecycleId();
        activeCompactionLifecycleId = lifecycleId;
        isCompactCommand = true;
        opts.onCompletionEvent?.(buildClaudeCompactionStartedEvent({ lifecycleId }));
    };
    const buildCompactionCompletedEvent = (params?: Readonly<{
        providerSessionId?: string | null;
        trigger?: 'manual' | 'auto' | 'threshold' | 'overflow' | 'unknown';
        tokenCountBefore?: number;
        tokenCountSource?: string;
    }>) => {
        const lifecycleId = activeCompactionLifecycleId ?? nextCompactionLifecycleId(params?.providerSessionId);
        activeCompactionLifecycleId = null;
        return buildClaudeCompactionCompletedEvent({
            lifecycleId,
            source: 'provider-event',
            trigger: params?.trigger ?? 'manual',
            ...(params?.providerSessionId ? { providerSessionId: params.providerSessionId } : {}),
            ...(typeof params?.tokenCountBefore === 'number' ? { tokenCountBefore: params.tokenCountBefore } : {}),
            ...(params?.tokenCountSource ? { tokenCountSource: params.tokenCountSource } : {}),
        });
    };

    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemoteAgentSdk] /compact command detected - will process as normal but with compaction behavior');
        startCompactCommand();
    }

    const promptChannel = createClaudeAgentSdkPromptChannel({
        initialMessage: initial.message,
        setUserMessageSender: opts.setUserMessageSender,
    });

    let claudeConfigDir = resolveClaudeConfigDirOverride(process.env);
    let response: any;
    let lastAppliedRuntimeSettings!: ReturnType<typeof resolveDesiredRuntimeSettingsSnapshot>;

    const sessionController = createClaudeAgentSdkSessionController({
        initialMode: initial.mode,
        sessionId: opts.sessionId,
        transcriptPath: opts.transcriptPath,
        workDir: opts.path,
        getClaudeConfigDir: () => claudeConfigDir,
        onSessionFound: opts.onSessionFound,
        onCompletionEvent: opts.onCompletionEvent,
        canCallTool: opts.canCallTool,
        applyPermissionModeTransition: async (nextPermissionMode: string) => {
            await response?.setPermissionMode?.(nextPermissionMode);
        },
        getLastAppliedRuntimeSettings: () => lastAppliedRuntimeSettings,
        setLastAppliedRuntimeSettings: (next) => {
            lastAppliedRuntimeSettings = next;
        },
    });

    const shapeLogger = createEventShapeLoggerForLog({ logger, scope: 'claude-agent-sdk' });

    const launchContext = await prepareClaudeAgentSdkLaunchContext({
        opts,
        initialMode: sessionController.getMode(),
        prompt: promptChannel.messages,
        getMode: sessionController.getMode,
        recordSessionFound: sessionController.recordSessionFound,
        canCallTool: sessionController.canCallToolWithModeTransitions,
    });
    opts = launchContext.normalizedOpts;
    lastAppliedRuntimeSettings = launchContext.lastAppliedRuntimeSettings;
    claudeConfigDir = launchContext.claudeConfigDir;
    sessionController.noteLaunchStartFrom(launchContext.startFrom);

    const {
        abortController,
        abortSignal,
        argOverrides,
        createQuery,
        debugFilePath,
        enableFileCheckpointing,
        queryOptions,
        stderrAppender,
    } = launchContext;

    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            opts.onThinkingChange?.(thinking);
        }
    };

    const resolvePreferredModelId = (): string | null => {
        const mode = sessionController.getMode();
        const candidate = argOverrides.model ?? mode.model;
        return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : null;
    };

    const { emitMessage, emitAssistantTextMessage } = createClaudeAgentSdkMessageEmitter({
        onMessage: opts.onMessage,
        resolvePreferredModelId,
    });

    const streamedTranscriptWriter = opts.streamedTranscriptWriter ?? null;
    const flushStreamedTranscriptWriter = async (
        reason: 'tool-call-boundary' | 'turn-end' | 'abort',
        interruptedReason?: string,
    ): Promise<StreamedTranscriptFlushSummary | null> => {
        if (!streamedTranscriptWriter) return null;
        try {
            return await streamedTranscriptWriter.flushAll({
                reason,
                ...(reason === 'abort' && interruptedReason ? { interruptedReason } : {}),
            });
        } catch (error) {
            logger.debug('[claudeRemoteAgentSdk] Failed flushing streamed transcript writer (non-fatal)', { error, reason });
            return null;
        }
    };

    let turnOutputRuntime: ReturnType<typeof createClaudeAgentSdkTurnOutputRuntime> | null = null;
    let queuedPromptPump: ReturnType<typeof createClaudeAgentSdkQueuedPromptPump> | null = null;
    let interruptController: ReturnType<typeof createClaudeAgentSdkInterruptController> | null = null;

    try {
        response = createQuery({
            prompt: promptChannel.messages,
            options: queryOptions,
        });

        let onTurnStartBoundary = () => {};
        turnOutputRuntime = createClaudeAgentSdkTurnOutputRuntime({
            streamedTranscriptWriter,
            emitMessage,
            emitAssistantTextMessage,
            flushStreamedTranscriptWriter,
            onTurnStartFromStreamEvent: () => onTurnStartBoundary(),
        });
        const checkpointLedger = createClaudeAgentSdkCheckpointLedger();
        interruptController = createClaudeAgentSdkInterruptController({
            getResponse: () => response,
            updateThinking,
            flushStreamedTranscriptWriter,
            clearBufferedAssistantMessages: turnOutputRuntime.flushBufferedAssistantMessages,
            setTurnInterrupt: opts.setTurnInterrupt,
            getSessionId: sessionController.getSessionId,
            getTranscriptPath: sessionController.getTranscriptPath,
            workDir: opts.path,
            claudeConfigDir,
            abortSignal,
        });

        let scheduleNextMessagePump = () => {};
        const turnLifecycle = createClaudeAgentSdkTurnLifecycle({
            flushStreamedTranscriptWriter,
            updateThinking,
            onReady: opts.onReady,
            onSubagentFlush: opts.onSubagentFlush,
            onCompletionEvent: opts.onCompletionEvent,
            noteDurableAssistantFlush: turnOutputRuntime.noteDurableAssistantFlush,
            getTurnDiagnostics: turnOutputRuntime.getTurnDiagnostics,
            getDidPublishAssistantTextThisTurn: turnOutputRuntime.getDidPublishAssistantTextThisTurn,
            scheduleNextMessagePump: () => scheduleNextMessagePump(),
            clearActiveTask: interruptController.clearActiveTask,
            consumeDeferredInterruptedReason: interruptController.consumeDeferredInterruptedReason,
            logTurnSummary: (summary) => {
                logger.debug('[claudeRemoteAgentSdk] Turn summary', summary);
            },
        });
        onTurnStartBoundary = turnLifecycle.onTurnStartBoundary;

        queuedPromptPump = createClaudeAgentSdkQueuedPromptPump({
            abortSignal,
            nextMessage: opts.nextMessage,
            endPrompt: promptChannel.end,
            closeResponse: async () => {
                const maybe = response?.close?.();
                await Promise.resolve(maybe);
            },
            pushUserTextMessage: promptChannel.pushUserTextMessage,
            enableFileCheckpointing,
            checkpointLedger,
            onCompletionEvent: opts.onCompletionEvent,
            onSessionReset: opts.onSessionReset,
            getResponse: () => response,
            emitCheckpointRewindMessage: (checkpointId) => {
                emitMessage({
                    type: 'system',
                    subtype: 'happier',
                    happierTraceMarker: 'checkpoint-rewind',
                    checkpointId,
                } as any);
            },
            recordTraceMarker,
            startCompactCommand,
            setMode: sessionController.setMode,
            updateRuntimeSettingsForMode: async (mode) => {
                lastAppliedRuntimeSettings = await applyRuntimeSettingsUpdatesIfNeeded({
                    response,
                    lastApplied: lastAppliedRuntimeSettings,
                    next: resolveDesiredRuntimeSettingsSnapshot({ resolvedMode: mode, argOverrides }),
                });
            },
            resetTurnOutputState: turnOutputRuntime.resetTurnOutputState,
            prepareForQueuedPrompt: turnLifecycle.prepareForQueuedPrompt,
            updateThinking,
        });
        scheduleNextMessagePump = queuedPromptPump.schedule;

        updateThinking(true);
        publishClaudeAgentSdkCapabilities({
            response,
            onCapabilities: opts.onCapabilities,
        });

        await runClaudeAgentSdkStreamLoop({
            response,
            shapeLogger,
            turnLifecycle,
            turnOutputRuntime,
            emitMessage,
            interruptController,
            recordSessionFound: sessionController.recordSessionFound,
            workDir: opts.path,
            claudeConfigDir,
            enableFileCheckpointing,
            checkpointLedger,
            onCheckpointCaptured: opts.onCheckpointCaptured,
            onRateLimitEvent: opts.onRateLimitEvent,
            onRuntimeAuthFailureEvent: opts.onRuntimeAuthFailureEvent,
            onCompletionEvent: opts.onCompletionEvent,
            buildCompactionCompletedEvent,
            isAborted: opts.isAborted,
            isCompactCommandActive: () => isCompactCommand,
            setCompactCommandActive: (active) => {
                isCompactCommand = active;
            },
        });
    } catch (error) {
        if (error instanceof AgentSdkAbortError) {
            logger.debug('[claudeRemoteAgentSdk] Aborted');
            return;
        }
        await enrichClaudeAgentSdkErrorArtifacts({
            error,
            debugFilePath,
            stderrFilePath: stderrAppender?.path,
            maxBytes: configuration.filesReadMaxBytes,
        });
        throw error;
    } finally {
        await finalizeClaudeAgentSdkRun({
            disposePromptChannel: promptChannel.dispose,
            disposeTurnInterrupt: () => interruptController?.dispose(),
            updateThinking,
            clearBufferedAssistantMessages: turnOutputRuntime?.flushBufferedAssistantMessages ?? (() => {}),
            flushStreamedTranscriptWriter,
            abortController,
            waitForQueuedPromptPump: async () => {
                await queuedPromptPump?.waitForIdle();
            },
            closeResponse: async () => {
                const maybe = response?.close?.();
                await Promise.resolve(maybe);
            },
            repairTranscriptAfterAbort: async () => {
                await interruptController?.repairTranscriptAfterAbort();
            },
            closeStderrAppender: async () => {
                await stderrAppender?.close().catch(() => {});
            },
        });
    }
}
