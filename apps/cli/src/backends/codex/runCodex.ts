import { CodexMcpClient } from './codexMcpClient';
import { applyPermissionModeToCodexPermissionHandler } from './utils/applyPermissionModeToHandler';
import { createCodexPermissionHandler, type CodexRuntimePermissionHandler } from './utils/createCodexPermissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { resolveHasTTY } from '@/ui/tty/resolveHasTTY';
import { Credentials } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import os from 'node:os';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { hashObject } from '@/utils/deterministicJson';
import { resolve, join } from 'node:path';
import { createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { trimIdent } from "@/utils/trimIdent";
import type { CodexSessionConfig } from './types';
import { CHANGE_TITLE_INSTRUCTION } from '@/agent/runtime/changeTitleInstruction';
import { registerKillSessionHandler } from '@/rpc/handlers/killSession';
import { delay } from "@/utils/time";
import { stopCaffeinate } from '@/integrations/caffeinate';
import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/runnerTerminationHandlers';
import { waitForMessagesOrPending } from '@/agent/runtime/waitForMessagesOrPending';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { DeferredApiSessionClient } from '@/agent/runtime/startup/DeferredApiSessionClient';
import { configuration } from '@/configuration';
import { isExperimentalCodexAcpEnabled, isExperimentalCodexVendorResumeEnabled } from '@/backends/codex/experiments';
import { maybeUpdatePermissionModeMetadata } from '@/agent/runtime/permission/permissionModeMetadata';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import { pushTextToMessageQueueWithSpecialCommands } from '@/agent/runtime/queueSpecialCommands';
import { normalizePermissionModeToIntent, resolvePermissionModeUpdatedAtFromMessage } from '@/agent/runtime/permission/permissionModeCanonical';
import { publishCodexSessionIdMetadata } from './utils/codexSessionIdMetadata';
import { createCodexAcpRuntime } from './acp/runtime';
import { syncCodexAcpSessionModeFromPermissionMode } from './acp/syncSessionModeFromPermissionMode';
import { publishInFlightSteerCapability } from './utils/publishInFlightSteerCapability';
import { createStartupMetadataOverrides } from '@/agent/runtime/createStartupMetadataOverrides';
import { initializeBackendRunSession } from '@/agent/runtime/initializeBackendRunSession';
import { initializeBackendApiContext } from '@/agent/runtime/initializeBackendApiContext';
import { archiveAndCloseSession } from '@/agent/runtime/archiveAndCloseSession';
import { codexLocalLauncher, type CodexLauncherResult } from './codexLocalLauncher';
import { sendReadyWithPushNotification } from '@/agent/runtime/sendReadyWithPushNotification';
import { applyLocalControlLaunchGating } from '@/agent/localControl/launchGating';
import {
    formatCodexLocalControlLaunchFallbackMessage,
    formatCodexLocalControlSwitchDeniedMessage,
} from './localControl/localControlSupport';
import { createCodexLocalControlSupportResolver } from './localControl/createLocalControlSupportResolver';
import { resolveCodexMcpServerSpawn } from './resume/resolveCodexMcpServer';
import { probeCodexAcpLoadSessionSupport } from './acp/probeLoadSessionSupport';
import { resolveCodexMessageModel } from './utils/resolveCodexMessageModel';
import { buildCodexMcpStartConfigForMessage } from './utils/buildCodexMcpStartConfigForMessage';
import { createModelOverrideSynchronizer } from '@/agent/runtime/modelOverrideSync';
import { resolveCodexAcpResumePreflight } from './utils/codexAcpResumePreflight';
import { resolveCodexMcpPolicyForPermissionMode } from './utils/permissionModePolicy';
import {
    createCodexMcpMessageHandler,
    forwardCodexErrorToUi as forwardCodexErrorToUiShared,
    forwardCodexStatusToUi as forwardCodexStatusToUiShared,
} from './runtime/mcpMessageHandler';
import { runCodexLocalModePass } from './runtime/localModePass';
import { cleanupCodexRunResources } from './runtime/cleanupRunResources';
import {
    emitReadyIfIdle,
    extractCodexToolErrorText,
    nextStoredSessionIdForResumeAfterAttempt,
} from './runtime/sessionTurnLifecycle';
import { createLocalRemoteModeController } from '@/agent/localControl/createLocalRemoteModeController';
import { createCodexRemoteTerminalUi } from './runtime/createCodexRemoteTerminalUi';
import { resolveCodexStartingMode } from './utils/resolveCodexStartingMode';
import { abortAcpRuntimeTurnIfNeeded } from '@/agent/acp/runtime/createAcpRuntime';
import { runMetadataOverridesWatcherLoop } from './utils/metadataOverridesWatcher';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import { createStartupTiming } from '@/agent/runtime/startup/startupTiming';
import { initializeRuntimeOverridesSynchronizer } from '@/agent/runtime/runtimeOverridesSynchronizer';
import {
    readStartupOverridesCacheForBackend,
    writeStartupOverridesCacheForBackend,
} from '@/agent/runtime/startup/startupOverridesCache';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolvePermissionModeSeedForAgentStart } from '@/settings/permissions/permissionModeSeed';
import { runStartupCoordinator } from '@/agent/runtime/startup/startupCoordinator';
import type { BackendStartupSpec, StartupContext } from '@/agent/runtime/startup/startupSpec';

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    terminalRuntime?: import('@/terminal/runtime/terminalRuntimeFlags').TerminalRuntimeFlags | null;
    permissionMode?: import('@/api/types').PermissionMode;
    permissionModeUpdatedAt?: number;
    agentModeId?: string;
    agentModeUpdatedAt?: number;
    modelId?: string;
    modelUpdatedAt?: number;
    existingSessionId?: string;
    resume?: string;
    startingMode?: 'local' | 'remote';
}): Promise<void> {
    // Use shared PermissionMode type for cross-agent compatibility
    type PermissionMode = import('@/api/types').PermissionMode;
    interface EnhancedMode {
        permissionMode: PermissionMode;
        permissionModeUpdatedAt?: number;
        /**
         * Stable id for the originating user message (when provided by the app),
         * used for discard markers and reconciliation on remote↔local switches.
         */
        localId?: string | null;
        model?: string;
    }

    //
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Codex');

    const explicitPermissionMode = opts.permissionMode;
    const hasResumeArg = typeof opts.resume === 'string' && opts.resume.trim().length > 0;
    const accountSettings = hasResumeArg ? null : (getActiveAccountSettingsSnapshot()?.settings ?? null);
    const permissionModeSeed = resolvePermissionModeSeedForAgentStart({
        agentId: 'codex',
        explicitPermissionMode: opts.permissionMode,
        accountSettings,
    });
    let initialPermissionMode = permissionModeSeed.mode;
    let initialPermissionModeUpdatedAt =
        typeof opts.permissionModeUpdatedAt === 'number'
            ? opts.permissionModeUpdatedAt
            : permissionModeSeed.source === 'explicit' || permissionModeSeed.source === 'account_default'
                ? Date.now()
                : 0;
    let initialModelId: string | null = (() => {
        if (typeof opts.modelId !== 'string') return null;
        const normalized = opts.modelId.trim();
        return normalized ? normalized : null;
    })();
    let initialModelUpdatedAt =
        typeof opts.modelUpdatedAt === 'number'
            ? opts.modelUpdatedAt
            : initialModelId
                ? Date.now()
                : 0;

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) =>
        hashObject({
            permissionMode: mode.permissionMode,
            // Intentionally ignore model in the mode hash: Codex cannot reliably switch models mid-session
            // without losing in-memory context.
        }),
    );
    const messageBuffer = new MessageBuffer();

    const nowMs = () => Date.now();
    const timing = createStartupTiming({ enabled: configuration.startupTimingEnabled, nowMs });

    const resumeIdFromArgs = typeof opts.resume === 'string' && opts.resume.trim().length > 0 ? opts.resume.trim() : null;
    let permissionModeSeededFromCache = false;
    if (resumeIdFromArgs && typeof opts.permissionMode !== 'string') {
        const cached = readStartupOverridesCacheForBackend({
            backendId: 'codex',
            nowMs: nowMs(),
            maxAgeMs: configuration.startupOverridesCacheMaxAgeMs,
        });
        if (cached) {
            initialPermissionMode = cached.permissionMode;
            initialPermissionModeUpdatedAt = cached.permissionModeUpdatedAt;
            if (cached.modelId) {
                initialModelId = cached.modelId;
                initialModelUpdatedAt = cached.modelUpdatedAt;
            }
            permissionModeSeededFromCache = true;
        }
    }

    const hasTtyForLocal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const startedByForLocalControl = opts.startedBy === 'daemon' ? 'daemon' : 'cli';
    const experimentalCodexAcpEnabled = isExperimentalCodexAcpEnabled();
    const experimentalCodexResumeEnabled = isExperimentalCodexVendorResumeEnabled();
    const localControlEnabled = experimentalCodexAcpEnabled || experimentalCodexResumeEnabled;

    const resolveLocalControlSupport = createCodexLocalControlSupportResolver({
        startedBy: startedByForLocalControl,
        experimentalCodexAcpEnabled,
        experimentalCodexResumeEnabled,
    });

    let mode: 'local' | 'remote' = resolveCodexStartingMode({
        explicitStartingMode: opts.startingMode,
        startedBy: startedByForLocalControl,
        hasTtyForLocal,
        localControlEnabled,
    });
    let localModeFallbackMessage: string | null = null;

    logger.debug('[codex] Starting mode resolved', {
        explicitStartingMode: opts.startingMode ?? null,
        startedBy: startedByForLocalControl,
        hasTtyForLocal,
        experimentalCodexAcpEnabled,
        experimentalCodexResumeEnabled,
        localControlEnabled,
        mode,
    });

    if (mode === 'local') {
        const support = await resolveLocalControlSupport({ includeAcpProbe: false });
        const gated = applyLocalControlLaunchGating({ startingMode: 'local', support });
        if (gated.mode === 'remote' && gated.fallback) {
            const message = formatCodexLocalControlLaunchFallbackMessage(gated.fallback.reason);
            logger.debug('[codex] Local-control mode is unavailable; falling back to remote.', support);
            localModeFallbackMessage = message;
            mode = 'remote';
        }
    }

    const hasExplicitPermissionMode = typeof opts.permissionMode === 'string' || permissionModeSeededFromCache;
    const shouldFastStartLocal =
        mode === 'local' &&
        startedByForLocalControl === 'cli' &&
        (typeof opts.existingSessionId !== 'string' || !opts.existingSessionId.trim()) &&
        (!resumeIdFromArgs || hasExplicitPermissionMode);

    type CodexFastStartArtifacts = {
        deferredSession: DeferredApiSessionClient;
        localResult: CodexLauncherResult | null;
    };

    let deferredSession: DeferredApiSessionClient | null = null;
    let localLauncherPromise: Promise<CodexLauncherResult> | null = null;
    let fastStartCoordinator: ReturnType<typeof runStartupCoordinator<CodexFastStartArtifacts>> | null = null;
    if (shouldFastStartLocal) {
        const ctx: StartupContext = {
            backendId: 'codex',
            sessionKind: resumeIdFromArgs ? 'resume' : 'fresh',
            startingModeIntent: 'local',
            startedBy: startedByForLocalControl,
            hasTty: hasTtyForLocal,
            workspaceDir: process.cwd(),
            nowMs,
            timing,
        };

        const spec: BackendStartupSpec<CodexFastStartArtifacts> = {
            backendId: 'codex',
            createArtifacts: () => ({
                deferredSession: new DeferredApiSessionClient({
                    placeholderSessionId: `PID-${process.pid}`,
                    limits: {
                        maxEntries: configuration.startupDeferredSessionBufferMaxEntries,
                        maxBytes: configuration.startupDeferredSessionBufferMaxBytes,
                    },
                }),
                localResult: null,
            }),
            tasks: [],
            spawnVendor: async ({ artifacts }) => {
                artifacts.localResult = await codexLocalLauncher<EnhancedMode>({
                    path: process.cwd(),
                    api: null,
                    session: artifacts.deferredSession as unknown as ApiSessionClient,
                    messageQueue,
                    permissionMode: initialPermissionMode,
                    resumeId: resumeIdFromArgs,
                });
            },
        };

        fastStartCoordinator = runStartupCoordinator({ ctx, spec });
        deferredSession = fastStartCoordinator.artifacts.deferredSession;
        localLauncherPromise = fastStartCoordinator.spawnPromise.then(() => {
            const res = fastStartCoordinator?.artifacts.localResult;
            return res ?? { type: 'exit', code: 0 };
        });
    }

    let deferredSessionAttached = false;
    const attachDeferredSessionIfNeeded = async (target: ApiSessionClient): Promise<void> => {
        if (!deferredSession) return;
        if (deferredSessionAttached) return;
        deferredSessionAttached = true;
        await deferredSession.attach(target as any);
    };

    // Attach to existing Happy session (inactive-session-resume) OR create a new one.
    //

    const stopApiContextSpan = timing.startSpan('initialize_backend_api_context');
    const { api, machineId } = await initializeBackendApiContext({
        credentials: opts.credentials,
        machineMetadata: initialMachineMetadata,
        missingMachineIdMessage:
            '[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/happier-dev/happier/issues',
        skipMachineRegistration: opts.startedBy === 'daemon',
    });
    stopApiContextSpan();

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    logger.debug(`Using machineId: ${machineId}`);

    const { state, metadata } = createSessionMetadata({
        flavor: 'codex',
        machineId,
        startedBy: opts.startedBy,
        terminalRuntime: opts.terminalRuntime ?? null,
        permissionMode: initialPermissionMode,
        permissionModeUpdatedAt: initialPermissionModeUpdatedAt,
        agentModeId: opts.agentModeId,
        agentModeUpdatedAt: opts.agentModeUpdatedAt,
        modelId: initialModelId ?? undefined,
        modelUpdatedAt: initialModelUpdatedAt,
    });
    let session: ApiSessionClient;
    let workspaceDirFromMetadata: string | null = null;
    // Permission handler declared here so it can be updated in onSessionSwap callback
    // (assigned later after client setup)
    let permissionHandler: CodexRuntimePermissionHandler;
    // Offline reconnection handle (only relevant when creating a new session and server is unreachable)
    let reconnectionHandle: { cancel: () => void } | null = null;
    const stopRunSessionSpan = timing.startSpan('initialize_backend_run_session');
    const initializedSession = await initializeBackendRunSession({
        api,
        sessionTag,
        metadata,
        state,
        existingSessionId: opts.existingSessionId,
        uiLogPrefix: '[codex]',
        startupMetadataOverrides: createStartupMetadataOverrides(opts),
        startupSideEffectsOrder: 'persist-first',
        allowOfflineStub: true,
        onSessionSwap: (newSession) => {
            session = newSession;
            // Update permission handler with new session to avoid stale reference
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
            void attachDeferredSessionIfNeeded(newSession);
        },
        onAttachMetadataSnapshotReady: (snapshot, attachSession) => {
            const maybeSnapshot = snapshot as { path?: unknown } | null;
            workspaceDirFromMetadata =
                typeof maybeSnapshot?.path === 'string' && maybeSnapshot.path.trim().length > 0
                    ? maybeSnapshot.path
                    : null;

            // If we are attaching using the MCP engine, strip any stale ACP session *state* metadata.
            // This prevents the UI from mis-detecting ACP capabilities based on previous runs.
            // Note: we intentionally keep user-configured overrides (permissionMode/modelOverride/acpSessionModeOverride).
            if (!isExperimentalCodexAcpEnabled()) {
                updateMetadataBestEffort(
                    attachSession,
                    (current) => {
                        const meta = current as any;
                        if (
                            meta.acpSessionModesV1 === undefined &&
                            meta.acpSessionModelsV1 === undefined &&
                            meta.acpConfigOptionsV1 === undefined
                        ) {
                            return current;
                        }
                        const { acpSessionModesV1, acpSessionModelsV1, acpConfigOptionsV1, ...rest } = meta;
                        return rest as any;
                    },
                    '[codex]',
                    'strip_stale_acp_metadata_on_attach',
                );
            }
        },
        onAttachMetadataSnapshotMissing: (error) => {
            logger.debug(
                '[codex] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)',
                error ?? undefined,
            );
        },
    });
    stopRunSessionSpan();
    session = initializedSession.session;
    reconnectionHandle = initializedSession.reconnectionHandle;
    // Do not attach the deferred session to an offline stub; wait for the reconnection swap.
    if (initializedSession.attachedToExistingSession || initializedSession.reportedSessionId) {
        await attachDeferredSessionIfNeeded(session);
    }
    if (!initializedSession.attachedToExistingSession) {
        workspaceDirFromMetadata = typeof metadata.path === 'string' && metadata.path.trim().length > 0 ? metadata.path : null;
    }

    if (timing.enabled) {
        logger.debug(
            timing.formatSummaryLine({
                prefix: '[codex-startup]',
                includeIds: [
                    'vendor_spawn_invoked',
                    'initialize_backend_api_context',
                    'initialize_backend_run_session',
                ],
            }),
        );
    }

    // Late-initialized when Codex ACP is enabled; referenced by the user-message binding for in-flight steering.
    let codexAcpRuntime: ReturnType<typeof createCodexAcpRuntime> | null = null;

    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    let currentPermissionMode: import('@/api/types').PermissionMode | undefined = initialPermissionMode;
    let currentPermissionModeUpdatedAt: number = initialPermissionModeUpdatedAt;
    let currentModelId: string | null = initialModelId;
    let currentModelUpdatedAt: number = initialModelUpdatedAt;

    const runtimePermissionModeRef = { current: currentPermissionMode ?? 'default', updatedAt: currentPermissionModeUpdatedAt };
    const runtimeModelOverrideRef = { current: currentModelId, updatedAt: currentModelUpdatedAt };
    let runtimeOverridesSync: Awaited<ReturnType<typeof initializeRuntimeOverridesSynchronizer>> | null = null;
    const persistStartupOverridesCache = (): void => {
        try {
            writeStartupOverridesCacheForBackend({
                backendId: 'codex',
                permissionMode: runtimePermissionModeRef.current,
                permissionModeUpdatedAt: runtimePermissionModeRef.updatedAt,
                modelId: runtimeModelOverrideRef.current,
                modelUpdatedAt: runtimeModelOverrideRef.updatedAt,
                updatedAt: nowMs(),
            });
        } catch {
            // ignore
        }
    };

    session.onUserMessage((message) => {
        // Resolve permission mode (accept all modes, will be mapped in switch statement)
        let messagePermissionMode = currentPermissionMode;
        let didChangePermissionMode = false;
        if (message.meta?.permissionMode) {
            const nextPermissionMode = normalizePermissionModeToIntent(message.meta.permissionMode);
            if (nextPermissionMode) {
                const updatedAt = resolvePermissionModeUpdatedAtFromMessage(message);
                const res = maybeUpdatePermissionModeMetadata({
                    currentPermissionMode,
                    nextPermissionMode,
                    updateMetadata: (updater) =>
                        updateMetadataBestEffort(session, updater, '[codex]', 'permission_mode_from_user_message'),
                    nowMs: () => updatedAt,
                });
                currentPermissionMode = res.currentPermissionMode;
                messagePermissionMode = currentPermissionMode;
                didChangePermissionMode = res.didChange;
                if (res.didChange) {
                    currentPermissionModeUpdatedAt = updatedAt;
                    runtimePermissionModeRef.current = currentPermissionMode ?? 'default';
                    runtimePermissionModeRef.updatedAt = currentPermissionModeUpdatedAt;
                    logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
                }
            }
        } else {
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
        }

        // Codex MCP model selection is only applied at session (re)start. We still thread model
        // through the mode so that first-message startSession config can honor metadata/message overrides.
        const messageModel = resolveCodexMessageModel({
            currentModelId,
            messageMetaModel: message.meta?.model,
        });

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            permissionModeUpdatedAt: currentPermissionModeUpdatedAt,
            localId: message.localId ?? null,
            model: messageModel,
        };

        const text = message.content.text;
        const special = parseSpecialCommand(text);
        const runtime = codexAcpRuntime;
        if (
            runtime &&
            runtime.supportsInFlightSteer() &&
            runtime.isTurnInFlight() &&
            !didChangePermissionMode &&
            special.type === null
        ) {
            // This message will not go through the main prompt loop queue; display it immediately.
            messageBuffer.addMessage(text, 'user');
            void runtime.steerPrompt(text).catch(() => {
                pushTextToMessageQueueWithSpecialCommands({
                    queue: messageQueue,
                    text,
                    mode: enhancedMode,
                });
            });
            return;
        }

        pushTextToMessageQueueWithSpecialCommands({
            queue: messageQueue,
            text,
            mode: enhancedMode,
        });
    });

    let thinking = false;
    let currentTaskId: string | null = null;
    if (localModeFallbackMessage) {
        session.sendSessionEvent({ type: 'message', message: localModeFallbackMessage });
    }

    session.keepAlive(thinking, mode);
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, mode);
    }, 2000);

    let resumeIdFromLocalControl: string | null = null;
    if (mode === 'local') {
        const localResult = await (localLauncherPromise ??
            codexLocalLauncher<EnhancedMode>({
                path: workspaceDirFromMetadata ?? process.cwd(),
                api,
                session,
                messageQueue,
                permissionMode: initialPermissionMode,
                resumeId: null,
            }));
        if (localResult.type === 'exit') {
            clearInterval(keepAliveInterval);
            return;
        }

        resumeIdFromLocalControl = localResult.resumeId;
        mode = 'remote';
        session.keepAlive(thinking, mode);
    }

    const sendReady = () => {
        sendReadyWithPushNotification({
            session,
            pushSender: api.push(),
            waitingForCommandLabel: 'Codex',
            logPrefix: '[Codex]',
        });
    };

    // Debug helper: log active handles/requests if DEBUG is enabled
    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch { }
    }

    //
    // Abort handling
    // IMPORTANT: There are two different operations:
    // 1. Abort (handleAbort): Stops the current inference/task but keeps the session alive
    //    - Used by the 'abort' RPC from mobile app
    //    - Similar to Claude Code's abort behavior
    //    - Allows continuing with new prompts after aborting
    // 2. Kill (handleKillSession): Terminates the entire process
    //    - Used by the 'killSession' RPC
    //    - Completely exits the CLI process
    //

    let abortController = new AbortController();
    let shouldExit = false;
    let storedSessionIdForResume: string | null = resumeIdFromLocalControl;
    let storedSessionIdFromLocalControl = Boolean(resumeIdFromLocalControl);
    if (typeof opts.resume === 'string' && opts.resume.trim()) {
        storedSessionIdForResume = opts.resume.trim();
        storedSessionIdFromLocalControl = false;
        logger.debug('[Codex] Resume requested via --resume:', storedSessionIdForResume);
    }

    const useCodexAcp = isExperimentalCodexAcpEnabled();
    const shouldLogAcpDebug = Boolean(process.env.DEBUG) || process.env.HAPPIER_E2E_PROVIDERS === '1';
    if (shouldLogAcpDebug) {
        logger.debug(`[Codex] Remote engine selected: ${useCodexAcp ? 'acp' : 'mcp'}`);
    }
    let happierMcpServer: { url: string; stop: () => void } | null = null;
    let client: CodexMcpClient | null = null;
    let remoteTerminalUi: ReturnType<typeof createCodexRemoteTerminalUi> | null = null;
    // codexAcpRuntime is declared above to allow the onUserMessage binding to steer mid-turn.

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            // Store the current session ID before aborting for potential resume
            const mcpClient = client;
            if (mcpClient && mcpClient.hasActiveSession()) {
                storedSessionIdForResume = mcpClient.storeSessionForResume();
                storedSessionIdFromLocalControl = false;
                logger.debug('[Codex] Stored session for resume:', storedSessionIdForResume);
            } else if (useCodexAcp) {
                const currentAcpSessionId = codexAcpRuntime?.getSessionId();
                if (currentAcpSessionId) {
                    storedSessionIdForResume = currentAcpSessionId;
                    storedSessionIdFromLocalControl = false;
                    logger.debug('[CodexACP] Stored session for resume:', storedSessionIdForResume);
                }
            }

            if (useCodexAcp) {
                try {
                    await abortAcpRuntimeTurnIfNeeded(codexAcpRuntime);
                } catch (error) {
                    logger.debug('[CodexACP] Failed to cancel in-flight turn on abort (non-fatal)', error);
                }
            }

            abortController.abort();
            reasoningProcessor.abort();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            abortController = new AbortController();
        }
    }

    /**
     * Handles session termination and process exit.
     * This is called when the session needs to be completely killed (not just aborted).
     * Abort stops the current inference but keeps the session alive.
     * Kill terminates the entire process.
     */
    const terminationHandlers = registerRunnerTerminationHandlers({
        process,
        exit: (code) => process.exit(code),
        onTerminate: async (_event, outcome) => {
            shouldExit = true;
            await handleAbort();

            try {
                if (outcome.archive) {
                    await archiveAndCloseSession(session);
                }
            } catch (e) {
                logger.debug('[Codex] Failed to archive session during termination (non-fatal)', e);
            }

            try {
                await cleanupCodexRunResources({
                    session,
                    reconnectionHandle,
                    client,
                    codexAcpRuntime,
                    stopHappierMcpServer: () => happierMcpServer?.stop(),
                    unmountRemoteUi: async () => {
                        if (!remoteTerminalUi) return;
                        await remoteTerminalUi.unmount();
                    },
                    keepAliveInterval,
                    messageBuffer,
                    logDebug: (message, error) => logger.debug(message, error),
                    logActiveHandles,
                });
            } catch (e) {
                logger.debug('[Codex] Cleanup failure during termination (non-fatal)', e);
            } finally {
                stopCaffeinate();
            }
        },
    });

    const handleKillSession = async () => {
        logger.debug('[Codex] Kill session requested - terminating process');
        terminationHandlers.requestTermination({ kind: 'killSession' });
        await terminationHandlers.whenTerminated;
    };

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', handleAbort);

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    //
    // Initialize Ink UI
    //

    const hasTTY = resolveHasTTY({
        stdoutIsTTY: process.stdout.isTTY,
        stdinIsTTY: process.stdin.isTTY,
        startedBy: opts.startedBy,
    });
    let requestedSwitchToLocal = false;

    const resolveLocalSwitchAvailability = async (): Promise<
        { ok: true } | { ok: false; reason: import('./localControl/localControlSupport').CodexLocalControlUnsupportedReason }
    > => {
        // Daemon-spawned sessions cannot safely switch to an interactive local TUI.
        if (opts.startedBy === 'daemon') return { ok: false, reason: 'started-by-daemon' };
        const support = await resolveLocalControlSupport({ includeAcpProbe: false });
        const gated = applyLocalControlLaunchGating({ startingMode: 'local', support });
        if (gated.mode === 'local') return { ok: true };
        return { ok: false, reason: gated.fallback?.reason ?? 'resume-disabled' };
    };

    const requestSwitchToLocal = async (): Promise<void> => {
        if (requestedSwitchToLocal) return;
        requestedSwitchToLocal = true;
        await handleAbort();
    };

    const requestSwitchToLocalIfSupported = async (): Promise<boolean> => {
        const availability = await resolveLocalSwitchAvailability();
        if (!availability.ok) {
            const message = formatCodexLocalControlSwitchDeniedMessage(availability.reason);
            messageBuffer.addMessage(message, 'status');
            session.sendSessionEvent({
                type: 'message',
                message,
            });
            return false;
        }

        await requestSwitchToLocal();
        return true;
    };

    remoteTerminalUi = createCodexRemoteTerminalUi({
        messageBuffer,
        logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
        hasTTY,
        stdin: process.stdin,
        onExit: async () => {
            logger.debug('[codex]: Exiting agent via Ctrl-C');
            shouldExit = true;
            await handleAbort();
        },
        onSwitchToLocal: async () => {
            await requestSwitchToLocalIfSupported();
        },
    });

    if (localModeFallbackMessage) {
        messageBuffer.addMessage(localModeFallbackMessage, 'status');
    }

    //
    // Start Context 
    //

    if (useCodexAcp) {
        const resumeId = storedSessionIdForResume?.trim();
        if (resumeId) {
            const stopProbeSpan = timing.startSpan('codex_acp_probe');
            const probe = await probeCodexAcpLoadSessionSupport({ signal: abortController.signal });
            stopProbeSpan();
            const preflight = resolveCodexAcpResumePreflight({
                resumeId,
                probe: probe.ok
                    ? { ok: true, loadSessionSupported: probe.loadSession }
                    : { ok: false, errorMessage: probe.error.message },
            });
            if (!preflight.ok) {
                messageBuffer.addMessage(preflight.errorMessage, 'status');
                session.sendSessionEvent({ type: 'message', message: preflight.errorMessage });
                throw new Error(preflight.errorMessage);
            }
        }
    }

    // Start Happier MCP server (HTTP) and prepare STDIO bridge config for Codex
    const happierBridge = await createHappierMcpBridge(session, { commandMode: 'current-process' });
    happierMcpServer = happierBridge.happierMcpServer;
    const directory = workspaceDirFromMetadata ?? process.cwd();
    const mcpServers = happierBridge.mcpServers;

    const localControlSupportedForMcp = !useCodexAcp
        ? (await resolveLocalControlSupport({ includeAcpProbe: false })).ok
        : false;
    const vendorResumeIdForSpawn = typeof storedSessionIdForResume === 'string' && storedSessionIdForResume.trim().length > 0
        ? storedSessionIdForResume.trim()
        : null;

    const codexMcpServer = await resolveCodexMcpServerSpawn({
        useCodexAcp,
        experimentalCodexResumeEnabled,
        vendorResumeId: vendorResumeIdForSpawn,
        localControlSupported: localControlSupportedForMcp,
    });

        client = useCodexAcp ? null : new CodexMcpClient({ mode: codexMcpServer.mode, command: codexMcpServer.command });

            // NOTE: Codex resume support varies by build; forks may seed `codex-reply` with a stored session id.
            permissionHandler = createCodexPermissionHandler({
                session,
                onAbortRequested: handleAbort,
                toolTrace: { protocol: useCodexAcp ? 'acp' : 'codex', provider: 'codex' },
                triggerAbortCallbackOnAbortDecision: useCodexAcp,
            });
            applyPermissionModeToCodexPermissionHandler({
                permissionHandler,
                permissionMode: currentPermissionMode ?? initialPermissionMode,
                permissionModeUpdatedAt: currentPermissionModeUpdatedAt,
            });
        const reasoningProcessor = new ReasoningProcessor((message) => {
            // Callback to send messages directly from the processor
            session.sendCodexMessage(message);
        });
    const diffProcessor = new DiffProcessor((message) => {
        // Callback to send messages directly from the processor
        session.sendCodexMessage(message);
    });
    if (client) client.setPermissionHandler(permissionHandler);

    const forwardCodexStatusToUi = (messageText: string): void => {
        forwardCodexStatusToUiShared({
            messageBuffer,
            session,
            messageText,
        });
    };

    const forwardCodexErrorToUi = (errorText: string): void => {
        forwardCodexErrorToUiShared({
            messageBuffer,
            session,
            errorText,
        });
    };

    const lastCodexThreadIdPublished: { value: string | null } = { value: null };

    const publishCodexThreadIdToMetadata = () => {
        publishCodexSessionIdMetadata({
            session,
            getCodexThreadId: () => (client ? client.getSessionId() : (codexAcpRuntime?.getSessionId() ?? null)),
            lastPublished: lastCodexThreadIdPublished,
        });
    };

    if (useCodexAcp) {
        codexAcpRuntime = createCodexAcpRuntime({
            directory,
            session,
            pushSender: api.push(),
            messageBuffer,
            mcpServers,
            permissionHandler,
            permissionMode: initialPermissionMode,
            getPermissionMode: () => currentPermissionMode ?? initialPermissionMode,
            onThinkingChange: (value) => { thinking = value; },
        });
        try {
            publishInFlightSteerCapability({ session, runtime: codexAcpRuntime });
        } catch (e) {
            logger.debug('[codex] Failed to publish in-flight steer capability (non-fatal)', e);
        }
    }

    if (client) {
        const handleMcpMessage = createCodexMcpMessageHandler({
            logger,
            session,
            messageBuffer,
            sendReady,
            publishCodexThreadIdToMetadata,
            reasoningProcessor,
            diffProcessor,
            getCurrentTaskId: () => currentTaskId,
            setCurrentTaskId: (next) => {
                currentTaskId = next;
            },
            getThinking: () => thinking,
            setThinking: (next) => {
                thinking = next;
            },
        });
        client.setHandler(handleMcpMessage);
    }

    let first = true;

	    try {
	        let wasCreated = false;
	            let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;

	        const codexAcpRuntimeForSync = codexAcpRuntime;
	        const modelSync =
	            useCodexAcp && codexAcpRuntimeForSync
	                ? createModelOverrideSynchronizer({
	                      session: { getMetadataSnapshot: () => session.getMetadataSnapshot() },
	                      runtime: { setSessionModel: (modelId) => codexAcpRuntimeForSync.setSessionModel(modelId) },
	                      isStarted: () => wasCreated,
	                  })
	                : null;

	        runtimeOverridesSync = await initializeRuntimeOverridesSynchronizer({
	            explicitPermissionMode: typeof explicitPermissionMode === 'string'
	                ? normalizePermissionModeToIntent(explicitPermissionMode) ?? undefined
	                : undefined,
	            sessionKind:
	                typeof opts.existingSessionId === 'string' && opts.existingSessionId.trim()
	                    ? 'attach'
	                    : typeof opts.resume === 'string' && opts.resume.trim()
	                      ? 'resume'
	                      : 'fresh',
	            take: configuration.startupPermissionSeedTranscriptTake,
	            session: {
	                getMetadataSnapshot: () => session.getMetadataSnapshot(),
	                fetchLatestUserPermissionIntentFromTranscript: (args) => session.fetchLatestUserPermissionIntentFromTranscript(args),
	            },
	            permissionMode: runtimePermissionModeRef,
	            modelOverride: runtimeModelOverrideRef,
		            onPermissionModeApplied: () => {
		                currentPermissionMode = runtimePermissionModeRef.current;
		                currentPermissionModeUpdatedAt = runtimePermissionModeRef.updatedAt;
		                initialPermissionMode = runtimePermissionModeRef.current;
		                initialPermissionModeUpdatedAt = runtimePermissionModeRef.updatedAt;
                        persistStartupOverridesCache();
		                applyPermissionModeToCodexPermissionHandler({
		                    permissionHandler,
		                    permissionMode: runtimePermissionModeRef.current,
		                    permissionModeUpdatedAt: runtimePermissionModeRef.updatedAt,
		                });
	                if (useCodexAcp && codexAcpRuntime) {
	                    void syncCodexAcpSessionModeFromPermissionMode({
	                        runtime: codexAcpRuntime,
	                        permissionMode: runtimePermissionModeRef.current,
	                        metadata: session.getMetadataSnapshot(),
	                    }).catch((e) => {
	                        logger.debug('[CodexACP] Failed to sync session mode from metadata (non-fatal)', e);
	                    });
	                }
		                logger.debug(`[Codex] Permission mode updated from sync to: ${runtimePermissionModeRef.current}`);
		            },
		            onModelOverrideApplied: () => {
		                currentModelId = runtimeModelOverrideRef.current;
		                currentModelUpdatedAt = runtimeModelOverrideRef.updatedAt;
		                initialModelId = runtimeModelOverrideRef.current;
		                initialModelUpdatedAt = runtimeModelOverrideRef.updatedAt;
                        persistStartupOverridesCache();
		                logger.debug(
		                    `[Codex] Model override updated from sync to: ${runtimeModelOverrideRef.current ?? 'default'}`,
		                );
		            },
		        });

	        const syncOverridesFromMetadata = (): void => {
	            runtimeOverridesSync?.syncFromMetadata();
	            modelSync?.syncFromMetadata();
	        };
	        
	        // Attach flows (and next_prompt apply timing) can result in a stable metadata snapshot
	        // that never changes during this process lifetime. Ensure we adopt the latest persisted
	        // permissionMode immediately, so local-control switches spawn Codex with the correct
	        // sandbox/approval policy even before the next user message.
		        syncOverridesFromMetadata();
                persistStartupOverridesCache();
		        void runtimeOverridesSync.seedFromSession().catch(() => {
		            // Best-effort only.
		        });

	        // Keep metadata-driven overrides current even mid-turn. `waitForMetadataUpdate()` is
	        // responsible for ensuring user-scoped broadcasts are observed (via userSocket), so
	        // we run a lightweight watcher loop in the background.
	        void runMetadataOverridesWatcherLoop({
	            shouldExit: () => shouldExit,
	            getAbortSignal: () => abortController.signal,
	            waitForMetadataUpdate: (signal) => session.waitForMetadataUpdate(signal),
	            onUpdate: () => {
	                syncOverridesFromMetadata();
	            },
	        });

        const localRemoteSwitchController = createLocalRemoteModeController({
            session,
            getThinking: () => thinking,
            resolveLocalSwitchAvailability,
            requestSwitchToLocalIfSupported,
            mountRemoteUi: () => remoteTerminalUi!.mount(),
            unmountRemoteUi: () => remoteTerminalUi!.unmount(),
            setRemoteUiAllowsSwitchToLocal: (allowed) => remoteTerminalUi!.setAllowSwitchToLocal(allowed),
        });

        while (!shouldExit) {
            if (mode === 'local') {
                await localRemoteSwitchController.publishModeState('local');
                const localPass = await runCodexLocalModePass<EnhancedMode>({
                    session,
                    messageQueue,
                    workspaceDir: workspaceDirFromMetadata ?? process.cwd(),
                    api,
                    permissionMode: currentPermissionMode ?? initialPermissionMode,
                    resumeId: storedSessionIdForResume,
                    formatError: formatErrorForUi,
                    launchLocal: codexLocalLauncher,
                });

                if (localPass.type === 'exit') {
                    shouldExit = true;
                    break;
                }

                storedSessionIdForResume = localPass.resumeId;
                storedSessionIdFromLocalControl = true;
                mode = 'remote';
                continue;
            }

            await localRemoteSwitchController.publishModeState('remote');
            requestedSwitchToLocal = false;
            localRemoteSwitchController.registerRemoteSwitchHandler();

        while (!shouldExit && !requestedSwitchToLocal) {
            logActiveHandles('loop-top');
            // Get next batch; respect mode boundaries like Claude
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
                pending = null;
                if (!message) {
                    // Capture the current signal to distinguish idle-abort from queue close
                    const waitSignal = abortController.signal;
                        const batch = await waitForMessagesOrPending({
                            messageQueue,
                            abortSignal: waitSignal,
                            popPendingMessage: () => session.popPendingMessage(),
	                            waitForMetadataUpdate: (signal) => session.waitForMetadataUpdate(signal),
	                            onMetadataUpdate: () => {
	                                syncOverridesFromMetadata();
	                            },
	                        });
                    if (!batch) {
                        // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                        if (waitSignal.aborted && !shouldExit) {
                            logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                            continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
                if (shouldLogAcpDebug) {
                    logger.debug('[codex] waitForMessagesOrPending returned batch');
                }
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }

                // Display user messages in the UI
                messageBuffer.addMessage(message.message, 'user');
                applyPermissionModeToCodexPermissionHandler({
                    permissionHandler,
                    permissionMode: message.mode.permissionMode,
                    permissionModeUpdatedAt: message.mode.permissionModeUpdatedAt,
                });

                const specialCommand = parseSpecialCommand(message.message);
                if (specialCommand.type === 'clear') {
                    logger.debug('[Codex] Handling /clear command - resetting session');
                if (client) {
                    client.clearSession();
                } else {
                    await codexAcpRuntime?.reset();
                }
                wasCreated = false;

                // Reset processors/permissions
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');

                messageBuffer.addMessage('Session reset.', 'status');
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                continue;
            }

            try {
                if (useCodexAcp) {
                    const codexAcp = codexAcpRuntime;
                    if (!codexAcp) {
                        throw new Error('Codex ACP runtime was not initialized');
                    }
                    codexAcp.beginTurn();
                    if (shouldLogAcpDebug) {
                        logger.debug('[CodexACP] beginTurn');
                    }

                    if (!wasCreated) {
                        if (shouldLogAcpDebug) {
                            logger.debug('[CodexACP] startOrLoad begin');
                        }
                        const resumeId = storedSessionIdForResume?.trim();
                        if (resumeId) {
                            messageBuffer.addMessage('Resuming previous context…', 'status');
                            try {
                                await codexAcp.startOrLoad({ resumeId, importHistory: storedSessionIdFromLocalControl !== true });
                                storedSessionIdForResume = nextStoredSessionIdForResumeAfterAttempt(storedSessionIdForResume, {
                                    attempted: true,
                                    success: true,
                                });
                                storedSessionIdFromLocalControl = false;
                            } catch (e) {
                                logger.debug('[Codex ACP] Resume failed; starting a new session instead', e);
                                messageBuffer.addMessage('Resume failed; starting a new session.', 'status');
                                session.sendSessionEvent({ type: 'message', message: 'Resume failed; starting a new session.' });
                                await codexAcp.startOrLoad({});
                                storedSessionIdForResume = nextStoredSessionIdForResumeAfterAttempt(storedSessionIdForResume, {
                                    attempted: true,
                                    success: false,
                                });
                                storedSessionIdFromLocalControl = false;
                            }
                        } else {
                            await codexAcp.startOrLoad({});
                        }
                        if (shouldLogAcpDebug) {
                            logger.debug('[CodexACP] startOrLoad complete');
                        }
                        try {
                            await syncCodexAcpSessionModeFromPermissionMode({
                                runtime: codexAcp,
                                permissionMode: message.mode.permissionMode,
                                metadata: session.getMetadataSnapshot(),
                            });
                        } catch (e) {
                            logger.debug('[CodexACP] Failed to sync session mode after startOrLoad (non-fatal)', e);
                        }
                        wasCreated = true;
                        first = false;
                        await modelSync?.flushPendingAfterStart();
                    }

                    if (shouldLogAcpDebug) {
                        logger.debug('[CodexACP] sendPrompt begin');
                    }
                    try {
                        await syncCodexAcpSessionModeFromPermissionMode({
                            runtime: codexAcp,
                            permissionMode: message.mode.permissionMode,
                            metadata: session.getMetadataSnapshot(),
                        });
                    } catch (e) {
                        logger.debug('[CodexACP] Failed to sync session mode before prompt (non-fatal)', e);
                    }
                    await codexAcp.sendPrompt(message.message);
                    if (shouldLogAcpDebug) {
                        logger.debug('[CodexACP] sendPrompt complete');
                    }
                } else {
                    const mcpClient = client!;
                    // Lazy-connect: allow remote mode to idle (and even switch to local) without spawning
                    // the Codex MCP backend until the first prompt is actually processed.
                    if (shouldLogAcpDebug) {
                        logger.debug('[CodexMCP] connect begin');
                    }
                    await mcpClient.connect();
                    if (shouldLogAcpDebug) {
                        logger.debug('[CodexMCP] connect complete');
                    }

                    const { approvalPolicy, sandbox } = resolveCodexMcpPolicyForPermissionMode(
                        message.mode.permissionMode,
                    );

                    if (!wasCreated) {
                    const startConfig: CodexSessionConfig = buildCodexMcpStartConfigForMessage({
                        message: message.message,
                        first,
                        sandbox,
                        approvalPolicy,
                        mcpServers,
                        mode: message.mode,
                    });

                    // Resume-by-session-id path (fork): seed codex-reply with the previous session id.
                    if (storedSessionIdForResume) {
                        const resumeId = storedSessionIdForResume;
                        messageBuffer.addMessage('Resuming previous context…', 'status');
                        mcpClient.setSessionIdForResume(resumeId);
                        const resumeResponse = await mcpClient.continueSession(message.message, { signal: abortController.signal });
                        const resumeError = extractCodexToolErrorText(resumeResponse);
                        if (resumeError) {
                            forwardCodexErrorToUi(resumeError);
                            mcpClient.clearSession();
                            wasCreated = false;
                            continue;
                        }
                        storedSessionIdForResume = nextStoredSessionIdForResumeAfterAttempt(storedSessionIdForResume, {
                            attempted: true,
                            success: true,
                        });
                        publishCodexThreadIdToMetadata();
                    } else {
                        const startResponse = await mcpClient.startSession(
                            startConfig,
                            { signal: abortController.signal }
                        );
                        const startError = extractCodexToolErrorText(startResponse);
                        if (startError) {
                            forwardCodexErrorToUi(startError);
                            mcpClient.clearSession();
                            wasCreated = false;
                            continue;
                        }
                        publishCodexThreadIdToMetadata();
                    }

                    wasCreated = true;
                    first = false;
                } else {
                    const response = await mcpClient.continueSession(
                        message.message,
                        { signal: abortController.signal }
                    );
                    logger.debug('[Codex] continueSession response:', response);
                    const continueError = extractCodexToolErrorText(response);
                    if (continueError) {
                        forwardCodexErrorToUi(continueError);
                        mcpClient.clearSession();
                        wasCreated = false;
                        continue;
                    }
                    publishCodexThreadIdToMetadata();
                }
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';

                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    // Abort cancels the current task/inference but keeps the Codex session alive.
                    // Do not clear session state here; the next user message should continue on the
                    // existing session if possible.
                } else {
                    const details = formatErrorForUi(error);
                    const messageText = `Codex process error: ${details}`;
                    messageBuffer.addMessage(messageText, 'status');
                    session.sendSessionEvent({ type: 'message', message: messageText });
                    // For unexpected exits, try to store session for potential recovery
                    const mcpClient = client;
                    if (mcpClient && mcpClient.hasActiveSession()) {
                        storedSessionIdForResume = mcpClient.storeSessionForResume();
                        logger.debug('[Codex] Stored session after unexpected error:', storedSessionIdForResume);
                    }
                }
            } finally {
                if (useCodexAcp) {
                    codexAcpRuntime?.flushTurn();
                    modelSync?.syncFromMetadata();
                }

                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.flushTurn();
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                const popped = !shouldExit ? await session.popPendingMessage() : false;
                if (!popped) {
                    emitReadyIfIdle({
                        pending,
                        queueSize: () => messageQueue.size(),
                        shouldExit,
                        sendReady,
                    });
                }
                logActiveHandles('after-turn');
            }
        }

            if (requestedSwitchToLocal && !shouldExit) {
                // Tear down remote runtimes so the terminal is free for the Codex TUI.
                try {
                    if (client) {
                        await client.disconnect();
                    } else {
                        await codexAcpRuntime?.reset();
                    }
                } catch {
                    // ignore
                }

                // Reset remote state so that when we return to remote mode, we attempt to resume cleanly.
                wasCreated = false;
                pending = null;
                thinking = false;

                mode = 'local';
                continue;
            }

            break;
        }

    } finally {
        terminationHandlers.dispose();
        await cleanupCodexRunResources({
            session,
            reconnectionHandle,
            client,
            codexAcpRuntime,
            stopHappierMcpServer: () => happierMcpServer?.stop(),
            unmountRemoteUi: async () => {
                await remoteTerminalUi?.unmount();
            },
            keepAliveInterval,
            messageBuffer,
            logDebug: (message, error) => logger.debug(message, error),
            logActiveHandles,
        });
    }
}
