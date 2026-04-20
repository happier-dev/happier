import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { resolveTerminalRemoteSwitchRequestTarget } from '../../../../agent/runtimeSwitching/switchTarget';
import { ensureSessionInfoBeforeSwitch } from '@/backends/claude/utils/ensureSessionInfoBeforeSwitch';
import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { logger } from '@/ui/logger';
import { Future } from '@/utils/future';

import { createClaudeLocalPermissionModeMetadataSync } from '@/backends/claude/utils/createClaudeLocalPermissionModeMetadataSync';
import { createClaudeLocalSessionScannerBridge } from '@/backends/claude/utils/createClaudeLocalSessionScannerBridge';
import type { createClaudeRawMessageTurnDiffBridge } from '@/backends/claude/utils/createClaudeRawMessageTurnDiffBridge';
import type { EnhancedMode } from '@/backends/claude/runtime/claudeEnhancedMode';
import { resolveClaudeLocalLaunchRequest } from '@/backends/claude/utils/resolveClaudeLocalLaunchRequest';
import { runClaudeLocalSwitchEntryGate } from '@/backends/claude/utils/runClaudeLocalSwitchEntryGate';

import { runClaudeTerminalSession, ExitCodeError } from './runTerminalSession';
import type { LauncherResult } from './launcher';
import type { Session } from '../session/ClaudeSession';

type ClaudeRawMessageTurnDiffBridge = ReturnType<typeof createClaudeRawMessageTurnDiffBridge>;

type LauncherSessionClient = Pick<SessionClientPort, 'getMetadataSnapshot'> &
    Partial<Pick<SessionClientPort, 'on' | 'off'>>;

export function createClaudeTerminalLaunchController(params: Readonly<{
    session: Session;
    entry: 'initial' | 'switch';
    turnDiffBridge: ClaudeRawMessageTurnDiffBridge;
}>): Readonly<{
    run: () => Promise<LauncherResult>;
}> {
    const { session, entry, turnDiffBridge } = params;

    let exitReason: LauncherResult | null = null;
    let abortingForModeSwitch = false;
    const processAbortController = new AbortController();
    const exitFuture = new Future<void>();
    let syncLastPermissionModeFromMetadata: (() => void) | null = null;
    let detachPermissionModeMetadataSync: (() => void) | null = null;
    let scannerBridge: Awaited<ReturnType<typeof createClaudeLocalSessionScannerBridge>> | null = null;

    async function abort(): Promise<void> {
        if (!processAbortController.signal.aborted) {
            processAbortController.abort();
        }

        await exitFuture.promise;
    }

    async function doAbort(): Promise<void> {
        logger.debug('[local]: doAbort');
        session.noteUserAbortRequested();

        if (!exitReason) {
            exitReason = { type: 'switch' };
        }
        abortingForModeSwitch = true;

        session.queue.reset();

        await ensureSessionInfoBeforeSwitch({ session });
        await abort();
    }

    async function doSwitch(): Promise<void> {
        logger.debug('[local]: doSwitch');

        if (!exitReason) {
            exitReason = { type: 'switch' };
        }
        abortingForModeSwitch = true;

        await ensureSessionInfoBeforeSwitch({ session });
        await abort();
    }

    return {
        run: async (): Promise<LauncherResult> => {
            session.setAbortCurrentTurnHandler(doAbort);

            try {
                scannerBridge = await createClaudeLocalSessionScannerBridge({
                    session,
                    onMessage: (message) => {
                        const bridged = turnDiffBridge.observe(message);
                        if (bridged) {
                            session.client.sendClaudeSessionMessage(bridged);
                            turnDiffBridge.flushAfterForwardIfNeeded();
                        }
                    },
                });

                const clientEmitter: LauncherSessionClient = session.client;
                const permissionModeMetadataSync = createClaudeLocalPermissionModeMetadataSync({
                    clientEmitter,
                    currentPermissionModeUpdatedAt: () => session.lastPermissionModeUpdatedAt,
                    adoptFromMetadata: ({ intent, updatedAt }) => {
                        session.adoptLastPermissionModeFromMetadata(intent, updatedAt);
                    },
                });
                syncLastPermissionModeFromMetadata = permissionModeMetadataSync.sync;
                detachPermissionModeMetadataSync = permissionModeMetadataSync.detach;

                syncLastPermissionModeFromMetadata();
                permissionModeMetadataSync.attach();

                session.client.rpcHandlerManager.registerHandler('switch', async (params: unknown) => {
                    const to = resolveTerminalRemoteSwitchRequestTarget(params);
                    if (to === 'local') return true;
                    await doSwitch();
                    return true;
                });
                session.queue.setOnMessage((message: string, mode: EnhancedMode) => {
                    session.setLastPermissionMode(mode.permissionMode);
                    void doSwitch();
                });

                if (exitReason) {
                    return exitReason;
                }

                if (entry === 'switch') {
                    if (!(await runClaudeLocalSwitchEntryGate(session))) {
                        return { type: 'switch' };
                    }
                }

                let errorCount = 0;
                const maxRetries = 5;

                while (true) {
                    if (exitReason) {
                        return exitReason;
                    }

                    const resumeFromSessionId = session.sessionId;
                    const resumeFromTranscriptPath = session.transcriptPath;
                    const expectsFork = resumeFromSessionId !== null;
                    if (expectsFork) {
                        session.clearSessionId();
                    }

                    logger.debug('[local]: launch');
                    try {
                        syncLastPermissionModeFromMetadata?.();

                        const launchRequest = await resolveClaudeLocalLaunchRequest({
                            session,
                            getMetadataSnapshot: () =>
                                typeof clientEmitter.getMetadataSnapshot === 'function'
                                    ? clientEmitter.getMetadataSnapshot()
                                    : null,
                        });
                        session.claudeArgs = launchRequest.claudeArgs;

                        await runClaudeTerminalSession({
                            path: session.path,
                            sessionId: resumeFromSessionId,
                            onSessionFound: scannerBridge.handleSessionStart,
                            onThinkingChange: session.onThinkingChange,
                            abort: processAbortController.signal,
                            claudeArgs: session.claudeArgs,
                            systemPromptText: session.defaultSystemPromptText,
                            envOverlay: launchRequest.envOverlay,
                            happierMcpConfigJson: launchRequest.happierMcpConfigJson,
                            hookSettingsPath: session.hookSettingsPath,
                            hookPluginDir: session.hookPluginDir,
                        });

                        session.consumeOneTimeFlags();
                        errorCount = 0;

                        if (!exitReason) {
                            exitReason = { type: 'exit', code: 0 };
                            break;
                        }
                    } catch (error) {
                        logger.debug('[local]: launch error', error);
                        if (error instanceof ExitCodeError) {
                            if (processAbortController.signal.aborted && abortingForModeSwitch) {
                                logger.debug('[local]: Claude exited due to mode switch abort', { exitCode: error.exitCode });
                                break;
                            }
                            exitReason = { type: 'exit', code: error.exitCode };
                            break;
                        }

                        if (expectsFork && session.sessionId === null) {
                            session.sessionId = resumeFromSessionId;
                            session.transcriptPath = resumeFromTranscriptPath;
                        }

                        if (!exitReason) {
                            turnDiffBridge.reset();
                            errorCount += 1;
                            session.client.sendSessionEvent({
                                type: 'message',
                                message: `Claude process error (${errorCount}/${maxRetries}): ${formatErrorForUi(error)}`,
                            });

                            if (errorCount >= maxRetries) {
                                session.client.sendSessionEvent({
                                    type: 'message',
                                    message: `Claude process failed ${maxRetries} times. Switching back to remote mode.`,
                                });
                                exitReason = { type: 'switch' };
                                break;
                            }

                            await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * errorCount, 5000)));
                            continue;
                        }

                        break;
                    }

                    logger.debug('[local]: launch done');
                }

                return exitReason ?? { type: 'exit', code: 0 };
            } finally {
                detachPermissionModeMetadataSync?.();
                exitFuture.resolve(undefined);
                session.setAbortCurrentTurnHandler(null);
                session.client.rpcHandlerManager.registerHandler('switch', async () => false);
                session.queue.setOnMessage(null);
                await scannerBridge?.cleanup();
            }
        },
    };
}
