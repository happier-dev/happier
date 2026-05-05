import { configuration } from '@/configuration';
import { ensureSessionInfoBeforeSwitch } from '@/backends/claude/utils/ensureSessionInfoBeforeSwitch';
import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { logger } from '@/ui/logger';
import { Future } from '@/utils/future';
import { resolveTerminalRemoteSwitchRequestTarget } from '@/agent/runtime/mode/switching/switchTarget';
import { tryReadTextFileTail } from '@/agent/runtime/readTextFileTail';
import { createClaudeRemoteBatchWaiter, type ClaudeRemoteQueuedPromptBatch } from './createBatchWaiter';

import type { RawJSONLines } from '@/backends/claude/contracts/rawJsonLines';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';
import type { Session } from '@/backends/claude/runtime/session/ClaudeSession';
import type { OutgoingMessageQueue } from '@/backends/claude/utils/OutgoingMessageQueue';
import type { PermissionHandler } from '@/backends/claude/utils/permissionHandler';
import type { SDKToLogConverter } from '@/backends/claude/utils/sdkToLogConverter';
import type { SDKMessage } from '@/backends/claude/sdk/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import { dispatchClaudeRemoteSession } from './dispatch';
import { createClaudeRemoteDispatchCallbacks } from './createDispatchCallbacks';
import { createClaudeRemoteQueuedPromptCoordinator } from './createQueuedPromptCoordinator';
import { seedClaudeRemoteTeamInboxFromTranscriptPath } from './seedTeamInboxFromTranscriptPath';
import type { StreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';

type ClaudeRemoteTeamInboxBridge = Readonly<{
    observe: (message: RawJSONLines) => void;
    syncAll: () => Promise<void>;
    cleanup: () => void;
}>;

type ClaudeCodeArtifacts = Readonly<{
    debugFilePath: string | null;
    stderrFilePath: string | null;
}>;

type LaunchErrorInfo = Readonly<{
    asString: string;
    name?: string;
    message?: string;
    code?: string;
    stack?: string;
}>;

function getLaunchErrorInfo(error: unknown): LaunchErrorInfo {
    let asString = '[unprintable error]';
    try {
        asString = typeof error === 'string' ? error : String(error);
    } catch {
        // Ignore
    }

    if (!error || typeof error !== 'object') {
        return { asString };
    }

    const err = error as { name?: unknown; message?: unknown; code?: unknown; stack?: unknown };
    const name = typeof err.name === 'string' ? err.name : undefined;
    const message = typeof err.message === 'string' ? err.message : undefined;
    const code = typeof err.code === 'string' || typeof err.code === 'number' ? String(err.code) : undefined;
    const stack = typeof err.stack === 'string' ? err.stack : undefined;

    return { asString, name, message, code, stack };
}

function isAbortError(error: unknown): boolean {
    if (error instanceof Error && error.name === 'AbortError') return true;
    if (!error || typeof error !== 'object') return false;
    const err = error as { name?: unknown; code?: unknown };
    if (typeof err.name === 'string' && err.name === 'AbortError') return true;
    if (typeof err.code === 'string' && err.code === 'ABORT_ERR') return true;
    return false;
}

function resolveClaudeCodeExitCode(error: unknown): number | null {
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/Claude Code process exited with code (\d+)/);
    if (!match) return null;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function resolveClaudeCodeArtifacts(error: unknown): ClaudeCodeArtifacts | null {
    if (!error || typeof error !== 'object') return null;
    const raw = (error as any).happierClaudeCodeArtifacts as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const debugFilePath = typeof (raw as any).debugFilePath === 'string' ? (raw as any).debugFilePath : null;
    const stderrFilePath = typeof (raw as any).stderrFilePath === 'string' ? (raw as any).stderrFilePath : null;
    if (!debugFilePath && !stderrFilePath) return null;
    return { debugFilePath, stderrFilePath };
}

async function formatClaudeCodeArtifactsTailForUi(artifacts: ClaudeCodeArtifacts): Promise<string> {
    const sections: string[] = [];

    const addTailSection = async (label: string, path: string | null) => {
        if (!path) return;
        const tail = await tryReadTextFileTail(path, { maxBytes: 32_000 });
        if (!tail) return;
        const header = `--- ${label} tail (${path}) ---`;
        const body = tail.tail.trimEnd();
        sections.push([header, body.length > 0 ? body : '[empty]', ''].join('\n'));
    };

    await addTailSection('claude-code-debug', artifacts.debugFilePath);
    await addTailSection('claude-code-stderr', artifacts.stderrFilePath);

    return sections.join('\n');
}

export type ClaudeRemoteLaunchController = Readonly<{
    abort: () => Promise<void>;
    launchOnce: (state: ClaudeRemoteLaunchState) => Promise<ClaudeRemoteLaunchIterationResult>;
    switchToLocal: () => Promise<void>;
}>;

export type ClaudeRemoteLaunchState = Readonly<{
    previousSessionId: string | null | undefined;
    forceNewSession: boolean;
    waitForMessageBeforeNextLaunch: boolean;
    pendingBatch: ClaudeRemoteQueuedPromptBatch | null;
}>;

export type ClaudeRemoteLaunchIterationResult =
    | Readonly<{ type: 'continue'; nextState: ClaudeRemoteLaunchState }>
    | Readonly<{ type: 'exit'; reason: 'switch' | 'exit' }>;

export function createClaudeRemoteLaunchController(params: Readonly<{
    session: Session;
    messageBuffer: MessageBuffer;
    permissionHandler: PermissionHandler;
    messageQueue: OutgoingMessageQueue;
    streamedTranscriptWriter: StreamedTranscriptWriter;
    teamInboxBridge: ClaudeRemoteTeamInboxBridge;
    sdkToLogConverter: SDKToLogConverter;
    seedTeamInboxSessionIds: Set<string>;
    onNewSession: () => void | Promise<void>;
    onLaunchCleanup: () => void | Promise<void>;
    onMessage: (message: SDKMessage) => void;
}>): ClaudeRemoteLaunchController {
    let exitReason: 'switch' | 'exit' | null = null;
    let abortController: AbortController | null = null;
    let abortFuture: Future<void> | null = null;
    let turnInterrupt: (() => Promise<void>) | null = null;
    let didUserAbortThisLaunch = false;

    const abort = async (): Promise<void> => {
        if (abortController && !abortController.signal.aborted) {
            abortController.abort();
        }
        await abortFuture?.promise;
    };

    const interruptThenTeardown = async (label: string): Promise<void> => {
        if (turnInterrupt) {
            try {
                await turnInterrupt();
            } catch (error) {
                logger.debug(`[remote]: turn interrupt failed during ${label}; falling back to process abort`, { error });
            }
        }

        if (!abortFuture) {
            await abort();
            return;
        }

        const graceMs = configuration.claudeRemoteInterruptThenTeardownGraceMs;
        if (!Number.isFinite(graceMs) || graceMs <= 0) {
            await abort();
            return;
        }

        const settled = await Promise.race([
            abortFuture.promise.then(() => true),
            new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => resolve(false), graceMs);
                timer.unref?.();
            }),
        ]);

        if (!settled) {
            await abort();
        }
    };

    const cancelCurrentTurn = async (): Promise<void> => {
        logger.debug('[remote]: cancelCurrentTurn');
        params.session.noteUserAbortRequested();
        didUserAbortThisLaunch = true;

        if (turnInterrupt) {
            try {
                await turnInterrupt();
            } catch (error) {
                logger.debug('[remote]: turn interrupt failed; falling back to process abort', { error });
                await abort();
            }
            return;
        }

        await abort();
    };

    const doSwitch = async (): Promise<void> => {
        logger.debug('[remote]: doSwitch');
        params.session.noteUserAbortRequested();
        if (!exitReason) {
            exitReason = 'switch';
        }
        await ensureSessionInfoBeforeSwitch({ session: params.session });
        await interruptThenTeardown('switch');
    };

    params.session.client.rpcHandlerManager.registerHandler('switch', async (rpcParams: any) => {
        const to = resolveTerminalRemoteSwitchRequestTarget(rpcParams);
        if (to === 'remote') return true;
        await doSwitch();
        return true;
    });
    params.session.setAbortCurrentTurnHandler(cancelCurrentTurn);

    const launchOnce = async (state: ClaudeRemoteLaunchState): Promise<ClaudeRemoteLaunchIterationResult> => {
        if (exitReason) {
            return { type: 'exit', reason: exitReason };
        }

        let previousSessionId = state.previousSessionId;
        let forceNewSession = state.forceNewSession;
        let waitForMessageBeforeNextLaunch = state.waitForMessageBeforeNextLaunch;
        let pendingBatch = state.pendingBatch;

        logger.debug('[remote]: launch');
        params.messageBuffer.addMessage('═'.repeat(40), 'status');

        const isNewSession = forceNewSession || params.session.sessionId !== previousSessionId;
        if (isNewSession) {
            params.messageBuffer.addMessage('Starting new Claude session...', 'status');
            await params.onNewSession();
            logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${params.session.sessionId})`);
            forceNewSession = false;
        } else {
            params.messageBuffer.addMessage('Continuing Claude session...', 'status');
            logger.debug(`[remote]: Continuing existing session: ${params.session.sessionId}`);
        }

        previousSessionId = params.session.sessionId;
        const sessionIdAtLaunchStart = params.session.sessionId;
        const controller = new AbortController();
        abortController = controller;
        abortFuture = new Future<void>();
        didUserAbortThisLaunch = false;

        const waitForNextBatch = createClaudeRemoteBatchWaiter({
            session: params.session,
            permissionHandler: params.permissionHandler,
            abortSignal: controller.signal,
            onPermissionModeUpdated: (permissionMode) => {
                logger.debug(`[remote]: Permission mode updated from metadata to: ${permissionMode}`);
            },
        });

        const queuedPromptCoordinator = createClaudeRemoteQueuedPromptCoordinator({
            sessionClient: params.session.client,
            waitForNextBatch,
            onModeChange: (permissionMode) => {
                params.permissionHandler.handleModeChange(permissionMode);
            },
            logDebug: (message) => logger.debug(message),
        });

        try {
            if (pendingBatch) {
                queuedPromptCoordinator.primePending(pendingBatch);
                pendingBatch = null;
            }

            if (waitForMessageBeforeNextLaunch) {
                waitForMessageBeforeNextLaunch = false;
                params.messageBuffer.addMessage('Claude Code exited unexpectedly. Waiting for the next message to retry...', 'status');
                const msg = await waitForNextBatch();
                if (!msg) {
                    if (params.session.queue.isClosed()) {
                        exitReason = 'exit';
                    } else {
                        waitForMessageBeforeNextLaunch = true;
                    }
                } else {
                    queuedPromptCoordinator.primePending(msg);
                }
            }

            if (!exitReason) {
                const { mcpServers: baseMcpServers, mcpConfigJson: baseMcpConfigJson } = await params.session.getOrCreateHappierMcpBridge();

                await seedClaudeRemoteTeamInboxFromTranscriptPath({
                    sessionId: params.session.sessionId,
                    transcriptPath: params.session.transcriptPath ?? null,
                    sessionPath: params.session.path,
                    claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
                    teamInboxBridge: params.teamInboxBridge,
                    seededSessionIds: params.seedTeamInboxSessionIds,
                });

                const dispatchCallbacks = createClaudeRemoteDispatchCallbacks({
                    session: params.session,
                    messageBuffer: params.messageBuffer,
                    messageQueue: params.messageQueue,
                    getPending: queuedPromptCoordinator.getPending,
                    getQueueSize: () => params.session.queue.size(),
                    getWorkVersion: queuedPromptCoordinator.getWorkVersion,
                    teamInboxBridge: params.teamInboxBridge,
                    seededTeamInboxSessionIds: params.seedTeamInboxSessionIds,
                    sdkToLogConverter: params.sdkToLogConverter,
                });

                await dispatchClaudeRemoteSession({
                    sessionId: params.session.sessionId,
                    transcriptPath: params.session.transcriptPath,
                    path: params.session.path,
                    hookSettingsPath: params.session.hookSettingsPath,
                    jsRuntime: params.session.jsRuntime,
                    happierMcpServers: baseMcpServers,
                    happierMcpConfigJson: baseMcpConfigJson,
                    streamedTranscriptWriter: params.streamedTranscriptWriter,
                    setTurnInterrupt: (handler: (() => Promise<void>) | null) => {
                        turnInterrupt = handler;
                    },
                    canCallTool: params.permissionHandler.handleToolCall,
                    isAborted: (toolCallId: string) => {
                        return params.permissionHandler.isAborted(toolCallId);
                    },
                    nextMessage: queuedPromptCoordinator.nextMessage,
                    onSessionFound: dispatchCallbacks.onSessionFound,
                    onCheckpointCaptured: dispatchCallbacks.onCheckpointCaptured,
                    onCapabilities: dispatchCallbacks.onCapabilities,
                    onThinkingChange: params.session.onThinkingChange,
                    claudeArgs: params.session.claudeArgs,
                    onMessage: params.onMessage,
                    onCompletionEvent: dispatchCallbacks.onCompletionEvent,
                    onSubagentFlush: dispatchCallbacks.onSubagentFlush,
                    onSessionReset: () => {
                        forceNewSession = true;
                        queuedPromptCoordinator.resetForNewSession();
                        dispatchCallbacks.onSessionReset();
                    },
                    onReady: dispatchCallbacks.onReady,
                    signal: abortController.signal,
                });

                params.session.consumeOneTimeFlags();

                if (!exitReason && abortController.signal.aborted) {
                    params.session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                }
                if (!exitReason && params.session.queue.isClosed()) {
                    exitReason = 'exit';
                }
            }
        } catch (error) {
            const abortError = isAbortError(error);
            logger.debug('[remote]: launch error', {
                ...getLaunchErrorInfo(error),
                abortError,
            });

            if (exitReason) {
                // Exit already requested (switch/exit).
            } else if (abortError) {
                if (controller.signal.aborted) {
                    params.session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                }
                if (controller.signal.aborted && didUserAbortThisLaunch && !exitReason) {
                    forceNewSession = true;
                    params.session.clearSessionId();
                }
            } else {
                const exitCode = resolveClaudeCodeExitCode(error);
                if (exitCode === 1) {
                    const artifacts = resolveClaudeCodeArtifacts(error);
                    const tailText = artifacts ? await formatClaudeCodeArtifactsTailForUi(artifacts) : '';
                    const base = formatErrorForUi(error, { maxChars: 12_000 });
                    const message = tailText ? `${base}\n\n${tailText}` : base;
                    params.session.client.sendSessionEvent({ type: 'message', message });
                    if (controller.signal.aborted && didUserAbortThisLaunch && !exitReason) {
                        forceNewSession = true;
                        params.session.clearSessionId();
                    } else if (
                        !controller.signal.aborted &&
                        typeof sessionIdAtLaunchStart === 'string' &&
                        sessionIdAtLaunchStart.trim().length > 0 &&
                        params.session.sessionId === sessionIdAtLaunchStart &&
                        !exitReason
                    ) {
                        forceNewSession = true;
                        params.session.clearSessionId();
                    }
                    waitForMessageBeforeNextLaunch = true;
                } else {
                    params.session.client.sendSessionEvent({
                        type: 'message',
                        message: `Claude process error: ${formatErrorForUi(error)}`,
                    });
                }
            }
        } finally {
            logger.debug('[remote]: launch finally');
            logger.debug('[remote]: flushing message queue');
            await params.messageQueue.flush();
            params.messageQueue.destroy();
            logger.debug('[remote]: message queue flushed');
            abortController = null;
            abortFuture?.resolve(undefined);
            abortFuture = null;
            turnInterrupt = null;
            logger.debug('[remote]: launch done');
            await params.onLaunchCleanup();
            previousSessionId = params.session.sessionId;
        }

        if (exitReason) {
            return { type: 'exit', reason: exitReason };
        }

        return {
            type: 'continue',
            nextState: {
                previousSessionId,
                forceNewSession,
                waitForMessageBeforeNextLaunch,
                pendingBatch: queuedPromptCoordinator.getPending(),
            },
        };
    };

    return {
        abort,
        launchOnce,
        switchToLocal: doSwitch,
    };
}
