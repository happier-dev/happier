import { logger } from "@/ui/logger";
import { claudeLocal, ExitCodeError } from "./claudeLocal";
import { Session, type SessionFoundInfo } from "./session";
import type { EnhancedMode } from './loop';
import { Future } from "@/utils/future";
import { createSessionScanner } from "./utils/sessionScanner";
import { formatErrorForUi } from '@/ui/formatErrorForUi';
import type { Metadata, PermissionMode } from "@/api/types";
import { resolveClaudeSdkPermissionModeFromEnhancedMode } from "./utils/permissionMode";
import { inferPermissionIntentFromClaudeArgs } from './utils/inferPermissionIntentFromArgs';
import { discardQueuedAndPendingForLocalSwitch } from '@/agent/localControl/discardQueuedAndPendingForLocalSwitch';
import { discardPendingBeforeSwitchToLocal } from '@/agent/localControl/discardPendingBeforeSwitchToLocal';
import { resolveSwitchRequestTarget } from '@/agent/localControl/switchRequestTarget';
import { resolvePermissionIntentFromMetadataSnapshot, resolveSessionModeOverrideFromMetadataSnapshot } from '@/agent/runtime/permission/permissionModeFromMetadata';
import { ensureSessionInfoBeforeSwitch } from '@/backends/claude/utils/ensureSessionInfoBeforeSwitch';
import { configuration } from '@/configuration';
import { resolveClaudeConfigDirOverride } from './utils/resolveClaudeConfigDirOverride';
import { resolveClaudeCodeExperimentalEnvOverlay } from './spawn/resolveClaudeCodeExperimentalEnvOverlay';
import {
    createDeferredRemoteSwitchController,
    createLocalTurnLifecycleController,
    type LocalTurnLifecycleEvent,
    type LocalTurnLifecycleSnapshot,
} from '@/agent/localControl/turnLifecycle';
import { startLocalPendingQueueRemoteSwitchWatcher } from '@/agent/localControl/pendingQueue/startLocalPendingQueueRemoteSwitchWatcher';
import { createClaudeLocalLifecycleTracker } from './localControl/claudeLocalLifecycleTracker';
import type { SessionHookData } from './utils/startHookServer';
import { createClaudeReadyHandler } from './ready/createClaudeReadyHandler';
import {
    mapClaudeStopFailureErrorToUsageDetails,
    type NormalizedProviderUsageLimitDetailsV1,
} from './connectedServices/mapClaudeRateLimitEventToUsageDetails';
import { surfaceClaudeRateLimitRuntimeIssue } from './connectedServices/surfaceClaudeRuntimeIssues';
import {
    createClaudeUnifiedTelemetrySink,
    emitClaudeUnifiedLifecycleGapDetected,
} from './unifiedTerminal/telemetry';
import { createClaudeSessionTranscriptProjector } from './localControl/createClaudeSessionTranscriptProjector';
import { createClaudeWorkflowActivitySourceForSession } from './workflows/createClaudeWorkflowActivitySourceForSession';
import { createWorkflowAgentTranscriptRegistrar } from './remote/sidechains/createWorkflowAgentTranscriptRegistrar';
import type { ClaudeRemoteSubagentFileCollector } from './remote/sidechains/claudeRemoteSubagentFileCollector';
import { loadClaudeJsonlReplayBaseline } from './utils/loadClaudeJsonlReplayBaseline';

function upsertClaudePermissionModeArgs(
    args: string[] | undefined,
    mode: { permissionMode: PermissionMode; agentModeId?: string | null },
): string[] | undefined {
    const filtered: string[] = [];
    const input = args ?? [];
    const inferredPermissionIntent = inferPermissionIntentFromClaudeArgs(input);

    for (let i = 0; i < input.length; i++) {
        const arg = input[i];

        // Remove any existing permission mode flags so we can enforce the session's current mode.
        if (arg === '--permission-mode') {
            // Skip value if present
            if (i + 1 < input.length) {
                i++;
            }
            continue;
        }
        if (arg.startsWith('--permission-mode=')) {
            continue;
        }
        if (arg === '--dangerously-skip-permissions') {
            continue;
        }
        filtered.push(arg);
    }

    const claudeMode = resolveClaudeSdkPermissionModeFromEnhancedMode(
        mode.permissionMode === 'default' && typeof inferredPermissionIntent === 'string'
            ? { ...mode, permissionMode: inferredPermissionIntent }
            : mode,
    );
    if (claudeMode !== 'default') {
        filtered.push('--permission-mode', claudeMode);
    }

    return filtered.length > 0 ? filtered : undefined;
}

export type LauncherResult = { type: 'switch' } | { type: 'exit', code: number };

export async function claudeLocalLauncher(
    session: Session,
    opts?: {
        /**
         * Indicates why we are entering local mode.
         *
         * - `initial`: first local launch for this process (must not block spawn on server pending-queue inspection)
         * - `switch`: switching from remote → local (must enforce discard/pending safety before switching)
         */
        entry?: 'initial' | 'switch';
        /**
         * Enables the legacy local→remote takeover path. Claude unified terminal owns
         * UI input through terminal-host injection and must not enter legacy remote mode.
         */
        remoteSwitchingEnabled?: boolean;
    },
): Promise<LauncherResult> {

        const entry = opts?.entry ?? 'initial';
        const remoteSwitchingEnabled = opts?.remoteSwitchingEnabled !== false;
        // Centralized Claude Dynamic Workflow ACTIVITY source (CWF2/CWF3/CWF4). Built at the launcher
        // (which owns credentials + stored-content encryption) and handed to the projector, which feeds
        // it the SAME raw transcript channel as the goal source and applies its CWF4 owned-id filter at
        // the work-state merge chokepoint. Null when no credentials are available yet — the goal /
        // work-state path is unaffected.
        // The scanner that owns this session's ONE sidechain importer is created further down (it
        // needs the projector this source feeds), so the source reaches the importer through this
        // holder rather than the other way round. A workflow run cannot start before the scanner
        // exists — nothing observes a transcript until then — and the registrar FAILS rather than
        // assuming it, so no agent is ever stamped with an id for an import that did not happen.
        let subagentFileCollectorRef: ClaudeRemoteSubagentFileCollector | null = null;
        const workflowActivitySource = await createClaudeWorkflowActivitySourceForSession({
            session,
            logPrefix: '[local]',
            // Workflow agent transcripts ride the SAME importer as `Task` sub-agent transcripts: one
            // follower budget, one dedupe, one `isSidechain`/`sidechainId` marking rule.
            registerWorkflowAgentTranscript: createWorkflowAgentTranscriptRegistrar({
                getCollector: () => subagentFileCollectorRef,
            }),
            getCurrentClaudeSessionId: () => {
                const claudeSessionId = session.client.getMetadataSnapshot?.()?.claudeSessionId;
                return typeof claudeSessionId === 'string' && claudeSessionId.trim().length > 0 ? claudeSessionId.trim() : null;
            },
        });
        const transcriptProjector = createClaudeSessionTranscriptProjector({ session, logPrefix: '[local]', workflowActivitySource });
        const readyHandler = createClaudeReadyHandler({
            session: session.client,
            pushSender: null,
            waitingForCommandLabel: 'Claude',
            logPrefix: '[local]',
            getPending: () => null,
            getQueueSize: () => session.queue.size(),
            hasOnlyBlockedPendingWork: () => session.client.hasOnlyBlockedPendingWork?.() === true,
        });
        const surfaceRateLimit = (details: NormalizedProviderUsageLimitDetailsV1): void => {
            void surfaceClaudeRateLimitRuntimeIssue(session, details, '[local]').catch((error) => {
                logger.debug('[local]: failed to surface Claude rate-limit runtime issue', error);
            });
        };
        const turnLifecycle = createLocalTurnLifecycleController({
            completionQuiescenceMs: configuration.claudeLocalTurnCompletionQuiescenceMs,
            onStateChange: (snapshot: LocalTurnLifecycleSnapshot, event: LocalTurnLifecycleEvent) => {
                if (snapshot.active && !snapshot.terminal) {
                    session.onThinkingChange(true);
                    return;
                }
                if (!snapshot.terminal) return;
                if (snapshot.lastTerminalReason === 'aborted') {
                    session.abortCurrentTaskTurn();
                } else {
                    session.onThinkingChange(false);
                }
                if (snapshot.lastTerminalReason === 'completed') {
                    readyHandler();
                }
                if (event.type === 'turn_terminal' && event.source === 'claude_hook_stop_failure') {
                    const details = mapClaudeStopFailureErrorToUsageDetails(event.detail);
                    if (details) surfaceRateLimit(details);
                }
            },
        });
        const applyFd3ThinkingFallback = (thinking: boolean): void => {
            const snapshot = turnLifecycle.snapshot();
            // Claude's legacy terminal thinking signal can briefly flip back to busy
            // for post-result task notifications/background output. Once the hook
            // lifecycle has terminalized the foreground turn, only a real hook
            // turn-start should open the next foreground lifecycle.
            if (thinking && snapshot.terminal && !snapshot.active) return;
            if (!thinking && snapshot.active && !snapshot.terminal) return;
            session.onThinkingChange(thinking);
        };
        const lifecycleTracker = createClaudeLocalLifecycleTracker({
            lifecycle: turnLifecycle,
            runtimeActivityAdapter: session.getProviderTaskRuntimeActivityAdapter(),
            providerActivityLedger: session.getProviderTaskActivityLedger() ?? undefined,
        });
        const unifiedTelemetry = createClaudeUnifiedTelemetrySink();

        const resumesKnownClaudeSession = Boolean(session.sessionId || session.transcriptPath);
        const replayBaseline = resumesKnownClaudeSession
            ? await loadClaudeJsonlReplayBaseline({
                loadCommittedBaseline: session.client.fetchCommittedClaudeJsonlMessageBaseline?.bind(session.client),
                resumesKnownClaudeSession: true,
                logPrefix: '[local]',
            })
            : null;

        // Create scanner
            const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        transcriptPath: session.transcriptPath,
        claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
        workingDirectory: session.path,
        initialProcessedMessageKeys: replayBaseline?.initialProcessedMessageKeys,
        replayInitialMessages: resumesKnownClaudeSession,
        replaySuppressRowsBeforeMs: replayBaseline?.replaySuppressRowsBeforeMs ?? null,
        onMessage: async (message, observation) => {
            if (observation?.historicalReplay) {
                await transcriptProjector.observeCommitted(message);
            } else {
                await transcriptProjector.observe(message);
                lifecycleTracker.observeTranscript(message);
            }
        },
        // Native Claude `/goal` source (plan H7): goal_status attachments + the
        // system/init slash_commands are dropped before `onMessage` (F2 gate), so
        // the goal source must observe them on the RAW channel. The projector keeps
        // them out of the visible transcript.
        onRawJsonlValue: (value, observation) => {
            transcriptProjector.observeRaw(value, observation);
        },
        onLiveJsonlValue: ({ sessionId, value }) => {
            lifecycleTracker.observeLiveProviderActivityRow(value, sessionId);
        },
        onLiveJsonlObservationLost: ({ reason }) => {
            lifecycleTracker.handleProviderActivityObservationLoss(reason);
        },
        onTranscriptMissing: () => {
            session.client.sendSessionEvent({
                type: 'message',
                message: 'Claude transcript not available yet — waiting for it to appear…'
            });
        },
        transcriptMissingWarningMs: configuration.claudeTranscriptMissingWarningMs,
    });
    // The scanner owns this session's one sidechain importer; the workflow journal follower can now
    // hand its `agent-<id>.jsonl` sidecars to it.
    subagentFileCollectorRef = scanner.subagentFileCollector;

    // Register callback to notify scanner when session ID is found via hook
    // This is important for --continue/--resume where session ID is not known upfront
    const scannerSessionCallback = (info: SessionFoundInfo) => {
        scanner.onNewSession({ sessionId: info.sessionId, transcriptPath: info.transcriptPath });
    };
    session.addSessionFoundCallback(scannerSessionCallback);
    const lifecycleHookCallback = (data: SessionHookData) => {
        lifecycleTracker.observeHook(data);
    };
    session.addClaudeSessionHookCallback(lifecycleHookCallback);

    // Handle abort
    let exitReason: LauncherResult | null = null;
    let abortingForModeSwitch = false;
    const processAbortController = new AbortController();
    let exitFuture = new Future<void>();
    let syncLastPermissionModeFromMetadata: (() => void) | null = null;
    let deferredRemoteSwitch: { dispose: () => void } | null = null;
    let pendingQueueWatcher: { stop: () => void } | null = null;
    try {
        workflowActivitySource?.armStartupReconciliation();
        await session.getProviderTaskRuntimeActivityAdapter()?.activateObservation(
            'claude-local-provider-observer-installed',
        );
        const clientEmitter = session.client as unknown as {
            getMetadataSnapshot?: () => Metadata | null | undefined;
            on?: (event: string, listener: () => void) => void;
            off?: (event: string, listener: () => void) => void;
        };

        syncLastPermissionModeFromMetadata = () => {
            if (!clientEmitter || typeof clientEmitter.getMetadataSnapshot !== 'function') {
                return;
            }
            const resolved = resolvePermissionIntentFromMetadataSnapshot({
                metadata: clientEmitter.getMetadataSnapshot(),
            });
            if (!resolved) return;
            session.adoptLastPermissionModeFromMetadata(resolved.intent, resolved.updatedAt);
        };

        // Seed from metadata so local Claude spawns always reflect the latest app-selected mode.
        syncLastPermissionModeFromMetadata();

        // While we can't change Claude's local permission mode mid-process, we still adopt updates
        // so that any subsequent spawn (fork/retry/local restart) uses the latest intent.
        if (clientEmitter && typeof clientEmitter.on === 'function') {
            clientEmitter.on('metadata-updated', syncLastPermissionModeFromMetadata);
        }

        async function abort() {

            // Send abort signal
            if (!processAbortController.signal.aborted) {
                processAbortController.abort();
            }

            // Await full exit
            await exitFuture.promise;
        }

        async function doAbort() {
            logger.debug('[local]: doAbort');
            session.noteUserAbortRequested();

            // Legacy local mode aborts by handing off to remote mode. Unified terminal
            // disables that handoff because remote writes are handled by host injection.
            if (!exitReason) {
                exitReason = remoteSwitchingEnabled ? { type: 'switch' } : { type: 'exit', code: 0 };
            }
            abortingForModeSwitch = remoteSwitchingEnabled;

            // Reset sent messages
            session.queue.reset();

            // Abort
            await ensureSessionInfoBeforeSwitch({ session });
            await abort();
            return true;
        }

        async function doSwitch() {
            logger.debug('[local]: doSwitch');
            if (!remoteSwitchingEnabled) {
                return false;
            }

            // Switching to remote mode
            if (!exitReason) {
                exitReason = { type: 'switch' };
            }
            abortingForModeSwitch = true;

            // Abort
            await ensureSessionInfoBeforeSwitch({ session });
            await abort();
            return true;
        }

        const remoteSwitchController = createDeferredRemoteSwitchController<EnhancedMode>({
            lifecycle: turnLifecycle,
            providerLabel: 'Claude',
            requestSwitchToRemote: async () => {
                return await doSwitch();
            },
            onQueuedMessageMode: (mode) => {
                session.setLastPermissionMode(mode.permissionMode);
            },
        });
        deferredRemoteSwitch = remoteSwitchController;

        // When to abort
        session.client.rpcHandlerManager.registerHandler('abort', doAbort); // Abort current process, clean queue and switch to remote mode
        session.client.rpcHandlerManager.registerHandler('switch', async (params: any) => {
            // Newer clients send a target mode. Older clients send no params.
            // Local launcher is already in local mode, so {to:'local'} is a no-op.
            const to = resolveSwitchRequestTarget(params);
            if (to === 'local') return true;
            if (!remoteSwitchingEnabled) return false;
            return await remoteSwitchController.requestRemoteSwitch('rpc_switch');
        }); // When user wants to switch to remote mode
        session.queue.setOnMessage((message: string, mode) => {
            if (!remoteSwitchingEnabled) {
                session.setLastPermissionMode(mode.permissionMode);
                return;
            }
            remoteSwitchController.onQueuedMessage(message, mode);
        }); // When any message is received, wait for a safe local-turn boundary, then switch to remote mode

        if (remoteSwitchingEnabled && entry === 'switch') {
            const autoConfirmDiscardForE2e =
                process.env.HAPPIER_E2E_PROVIDERS === '1' || process.env.HAPPY_E2E_PROVIDERS === '1';
            const pendingGateStartMs = configuration.startupTimingEnabled ? Date.now() : null;
            const discardResult = await discardQueuedAndPendingForLocalSwitch({
                queue: session.queue,
                getServerPendingCount: () => session.client.peekPendingMessageQueueV2Count({ reconcileWhenEmpty: 'force', reason: 'manual-check' }),
                discardServerPending: () =>
                    session.client.discardPendingMessageQueueV2All({ reason: 'switch_to_local' }),
                markQueuedAsDiscarded: (localIds) =>
                    session.client.discardCommittedMessageLocalIds({ localIds: [...localIds], reason: 'switch_to_local' }),
                sendStatusMessage: (message) => {
                    session.client.sendSessionEvent({ type: 'message', message });
                },
                formatError: formatErrorForUi,
                ...(autoConfirmDiscardForE2e
                    ? {
                        discardController: (args) =>
                            discardPendingBeforeSwitchToLocal({
                                ...args,
                                confirmDiscard: async () => true,
                            }),
                    }
                    : {}),
            });
            if (pendingGateStartMs !== null) {
                logger.debug(`[claude-startup] claude_pending_queue_switch_gate=${Math.max(0, Date.now() - pendingGateStartMs)}ms`);
            }

            if (discardResult !== 'proceed') {
                return { type: 'switch' };
            }
        }

        pendingQueueWatcher = remoteSwitchingEnabled ? startLocalPendingQueueRemoteSwitchWatcher({
            peekPendingCount: async () => {
                const lifecycleSnapshot = turnLifecycle.snapshot();
                if (lifecycleSnapshot.active && !lifecycleSnapshot.terminal) {
                    await turnLifecycle.waitForSafeRemoteHandoff();
                }
                return session.client.peekPendingMessageQueueV2Count({ reconcileWhenEmpty: 'skip', reason: 'passive-wait' });
            },
            requestRemoteSwitch: () => remoteSwitchController.requestRemoteSwitch('server_pending_queue'),
            waitForPendingQueueUpdate: (signal) => session.client.waitForPendingEligibilityUpdate(signal),
        }) : null;

        // Handle session start
        const handleSessionStart = (sessionId: string) => {
            session.onSessionFound(sessionId);
            scanner.onNewSession({ sessionId, transcriptPath: session.transcriptPath });
        };

        // Run local mode
        let errorCount = 0;
        const maxRetries = 5;
        while (true) {
            // If we already have an exit reason, return it
            if (exitReason) {
                return exitReason;
            }

            const resumeFromSessionId = session.sessionId;
            const resumeFromTranscriptPath = session.transcriptPath;
            const expectsFork = resumeFromSessionId !== null;
            if (expectsFork) {
                // Starting local mode from an existing session uses `--resume`, which forks
                // to a new Claude session ID and transcript file. Clear the current
                // session info so a fast local→remote switch waits for the new hook data,
                // instead of resuming the stale pre-fork sessionId/transcriptPath.
                session.clearSessionId();
            }

            // Launch
            logger.debug('[local]: launch');
            try {
                syncLastPermissionModeFromMetadata?.();

                // Ensure local Claude Code is spawned with the current session permission mode.
                // This is essential for remote → local switches where the app-selected mode must carry over.
                const metadataSnapshot =
                    typeof clientEmitter?.getMetadataSnapshot === 'function'
                        ? clientEmitter.getMetadataSnapshot()
                        : null;
                const resolvedAgentMode = resolveSessionModeOverrideFromMetadataSnapshot({
                    metadata: metadataSnapshot,
                });
                session.claudeArgs = upsertClaudePermissionModeArgs(session.claudeArgs, {
                    permissionMode: session.lastPermissionMode,
                    agentModeId: resolvedAgentMode ? resolvedAgentMode.modeId : null,
                });

                const { mcpConfigJson: baseMcpConfigJson } = await session.getOrCreateHappierMcpBridge();
                try {
                    await claudeLocal({
                        path: session.path,
                        sessionId: resumeFromSessionId,
                        onSessionFound: handleSessionStart,
                        onThinkingChange: applyFd3ThinkingFallback,
                        onLifecycleGapDetected: (event) => emitClaudeUnifiedLifecycleGapDetected(unifiedTelemetry, event),
                        abort: processAbortController.signal,
                        claudeArgs: session.claudeArgs,
                        happierSessionId: session.client.sessionId,
                        systemPromptText: session.defaultSystemPromptText,
                        envOverlay: {
                            ...resolveClaudeCodeExperimentalEnvOverlay({
                                claudeCodeExperimentalAgentTeamsEnabled: session.claudeCodeExperimentalAgentTeamsEnabled,
                            }),
                        },
                        happierMcpConfigJson: baseMcpConfigJson,
                        hookSettingsPath: session.hookSettingsPath,
                        hookPluginDir: session.hookPluginDir,
                    });
                } finally {
                    lifecycleTracker.observeProcessExit();
                    await Promise.resolve();
                }

                // Consume one-time Claude flags after spawn
                // For example we don't want to pass --resume flag after first spawn
                session.consumeOneTimeFlags();
                errorCount = 0;

                // Normal exit
                if (!exitReason) {
                    exitReason = { type: 'exit', code: 0 };
                    break;
                }
            } catch (e) {
                logger.debug('[local]: launch error', e);
                // If Claude exited with non-zero exit code, propagate it
                if (e instanceof ExitCodeError) {
                    // When switching modes, we abort the local Claude process (SIGTERM → exit code 143).
                    // Treat that termination as expected and keep the switch exit reason intact.
                    if (processAbortController.signal.aborted && abortingForModeSwitch) {
                        logger.debug('[local]: Claude exited due to mode switch abort', { exitCode: e.exitCode });
                        break;
                    }
                    exitReason = { type: 'exit', code: e.exitCode };
                    break;
                }
                if (expectsFork && session.sessionId === null) {
                    // If the local spawn failed before Claude reported the forked session,
                    // restore the previous session info so remote mode can still resume it.
                    session.sessionId = resumeFromSessionId;
                    session.transcriptPath = resumeFromTranscriptPath;
                }
                if (!exitReason) {
                    transcriptProjector.reset();
                    errorCount += 1;
                    session.client.sendSessionEvent({
                        type: 'message',
                        message: `Claude process error (${errorCount}/${maxRetries}): ${formatErrorForUi(e)}`,
                    });

                    if (errorCount >= maxRetries) {
                        session.client.sendSessionEvent({
                            type: 'message',
                            message: remoteSwitchingEnabled
                                ? `Claude process failed ${maxRetries} times. Switching back to remote mode.`
                                : `Claude process failed ${maxRetries} times.`,
                        });
                        exitReason = remoteSwitchingEnabled ? { type: 'switch' } : { type: 'exit', code: 1 };
                        break;
                    }

                    // Backoff to avoid tight retry loops and log spam.
                    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * errorCount, 5000)));
                    continue;
                } else {
                    break;
                }
            }
            logger.debug('[local]: launch done');
	        }
	    } finally {
	        const clientEmitter = session.client as unknown as {
	            off?: (event: string, listener: () => void) => void;
	        };
        if (clientEmitter && typeof clientEmitter.off === 'function' && syncLastPermissionModeFromMetadata) {
            // Best-effort: some test stubs don't implement EventEmitter.
            clientEmitter.off('metadata-updated', syncLastPermissionModeFromMetadata);
        }

        // Resolve future
        exitFuture.resolve(undefined);

        // Set handlers to no-op
        session.client.rpcHandlerManager.registerHandler('abort', async () => { });
        session.client.rpcHandlerManager.registerHandler('switch', async () => false);
        session.queue.setOnMessage(null);
        
        // Remove session found callback
        session.removeSessionFoundCallback(scannerSessionCallback);
        session.removeClaudeSessionHookCallback(lifecycleHookCallback);
        pendingQueueWatcher?.stop();
        deferredRemoteSwitch?.dispose();
        turnLifecycle.dispose();

        // This teardown is the OBSERVATION that the provider process is gone: resolve every
        // shutdown-sensitive source the projector owns before the sources are drained and disposed.
        // G-6 marks an active-but-unmet goal interrupted; RULING-14 resolves live workflow runs and
        // their agents so they stop reading as "Working" forever.
        transcriptProjector.finalizeInterruptedWorkOnShutdown();
        // Drain any pending workflow-activity writes, then stop scheduling (dispose via reset()).
        await transcriptProjector.flushWorkflowActivity();
        transcriptProjector.reset();

        // Cleanup. The importer dies with the scanner, so withdraw it first: a late journal entry
        // must fail to register rather than attach a follower nothing will ever stop.
        subagentFileCollectorRef = null;
        await scanner.cleanup();
    }

    // Return
    return exitReason || { type: 'exit', code: 0 };
}
