import { applyPermissionModeToCodexPermissionHandler } from './utils/applyPermissionModeToHandler';
import { createCodexPermissionHandler, type CodexRuntimePermissionHandler } from './utils/createCodexPermissionHandler';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { logger } from '@/ui/logger';
import { resolveHasTTY } from '@/ui/tty/resolveHasTTY';
import { Credentials } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import os from 'node:os';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { hashObject } from '@/utils/deterministicJson';
import { resolve, join } from 'node:path';
import { createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { trimIdent } from "@/utils/trimIdent";
import type { CodexSessionConfig } from './types';
import { registerKillSessionHandler } from '@/rpc/handlers/killSession';
import { delay } from "@/utils/time";
import { stopCaffeinate } from '@/integrations/caffeinate';
import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/runnerTerminationHandlers';
import { waitForMessagesOrPending } from '@/agent/runtime/waitForMessagesOrPending';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createCurrentSessionTranscriptPort } from '@/api/session/createCurrentSessionTranscriptPort';
import { DeferredApiSessionClient } from '@/agent/runtime/startup/DeferredApiSessionClient';
import { configuration } from '@/configuration';
import { isExperimentalCodexAcpEnabled } from '@/backends/codex/experiments';
import { maybeUpdatePermissionModeMetadata } from '@/agent/runtime/permission/permissionModeMetadata';
import {
    resolveAppendSystemPromptBaseOverride,
    resolveAppendSystemPromptModeOverride,
    resolveAppendSystemPromptQueueKeyValue,
} from '@/agent/runtime/permission/appendSystemPromptField';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import { pushMessageToQueueWithSpecialCommands } from '@/agent/runtime/queueSpecialCommands';
import { normalizePermissionModeToIntent, resolvePermissionModeUpdatedAtFromMessage } from '@/agent/runtime/permission/permissionModeCanonical';
import { publishCodexSessionIdMetadata } from './utils/codexSessionIdMetadata';
import { createCodexAcpRuntime } from './acp/runtime';
import { createCodexAppServerRuntime } from './appServer/runtime';
import { buildCodexAppServerConfigOverrides } from './appServer/buildCodexAppServerConfigOverrides';
import { seedCodexAppServerPendingSessionOverrides } from './appServer/seedPendingSessionOverrides';
import { SessionRollbackRpcParamsSchema } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { syncCodexAcpSessionModeFromPermissionMode } from './acp/syncSessionModeFromPermissionMode';
import { publishInFlightSteerCapability } from './utils/publishInFlightSteerCapability';
import { createStartupMetadataOverrides } from '@/agent/runtime/createStartupMetadataOverrides';
import { initializeBackendRunSession } from '@/agent/runtime/initializeBackendRunSession';
import { initializeBackendApiContext } from '@/agent/runtime/initializeBackendApiContext';
import { codexLocalLauncher, type CodexLauncherResult } from './codexLocalLauncher';
import { sendReadyWithPushNotification } from '@/agent/runtime/sendReadyWithPushNotification';
import { getSessionNotificationTitle } from '@/agent/runtime/readyNotificationContext';
import { createTurnAssistantPreviewTracker } from '@/agent/runtime/turnAssistantPreviewTracker';
import { applyLocalControlLaunchGating } from '@/agent/localControl/launchGating';
import {
    formatCodexLocalControlLaunchFallbackMessage,
    formatCodexLocalControlSwitchDeniedMessage,
} from './localControl/localControlSupport';
import { createCodexLocalControlSupportResolver } from './localControl/createLocalControlSupportResolver';
import { resolveCodexMcpServerSpawn } from './mcp/resolveCodexMcpServerSpawn';
import { resolveCodexAcpSpawn } from './acp/resolveCommand';
import { validateCodexAcpSpawnAvailability } from './acp/spawnAvailability';
import { resolveCodexMessageModel } from './utils/resolveCodexMessageModel';
import { buildCodexMcpStartConfigForMessage } from './utils/buildCodexMcpStartConfigForMessage';
import { createModelOverrideSynchronizer } from '@/agent/runtime/modelOverrideSync';
import { resolveCodexMcpPolicyForPermissionMode } from './utils/permissionModePolicy';
import {
    createCodexMcpMessageHandler,
    forwardCodexErrorToUi as forwardCodexErrorToUiShared,
    forwardCodexStatusToUi as forwardCodexStatusToUiShared,
} from './runtime/mcpMessageHandler';
import { createCodexRequestUserInputBridge } from './runtime/codexRequestUserInputBridge';
import { runCodexLocalModePass } from './runtime/localModePass';
import { resolveCodexQueuedPromptWithReplaySeed } from './runtime/resolveCodexQueuedPromptWithReplaySeed';
import { cleanupCodexRunResources } from './runtime/cleanupRunResources';
import { resolveTerminationArchiveDecision } from '@/agent/runtime/terminationArchivePolicy';
import {
    emitReadyIfIdle,
    extractCodexToolErrorText,
    nextStoredSessionIdForResumeAfterAttempt,
} from './runtime/sessionTurnLifecycle';
import { createLocalRemoteModeController } from '@/agent/localControl/createLocalRemoteModeController';
import { createCodexRemoteTerminalUi } from './runtime/createCodexRemoteTerminalUi';
import { resolveCodexStartingMode } from './utils/resolveCodexStartingMode';
import { resolveRemoteModeControlSurface } from '@/ui/remoteControl/remoteModeControl';
import { abortAcpRuntimeTurnIfNeeded } from '@/agent/acp/runtime/createAcpRuntime';
import { createSwitchToLocalAbortPromise } from './localControl/createSwitchToLocalAbortPromise';
import { archiveAndCloseRuntimeSession } from '@/session/services/archiveAndCloseRuntimeSession';
import { requestSwitchToLocal as requestCodexSwitchToLocal } from './localControl/requestSwitchToLocal';
import { runMetadataOverridesWatcherLoop } from './utils/metadataOverridesWatcher';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import { createStartupTiming } from '@/agent/runtime/startup/startupTiming';
import { initializeRuntimeOverridesSynchronizer } from '@/agent/runtime/runtimeOverridesSynchronizer';
import { createSessionModeOverrideSynchronizer } from '@/agent/runtime/sessionModeOverrideSync';
import { createSessionConfigOptionOverrideSynchronizer } from '@/agent/runtime/sessionConfigOptionOverrideSync';
import {
    readStartupOverridesCacheForBackend,
    writeStartupOverridesCacheForBackend,
} from '@/agent/runtime/startup/startupOverridesCache';
import { resolvePermissionModeSeedForAgentStart } from '@/settings/permissions/permissionModeSeed';
import { shouldSendReadyPushNotification } from '@/settings/notifications/notificationsPolicy';
import { runStartupCoordinator } from '@/agent/runtime/startup/startupCoordinator';
import type { BackendStartupSpec, StartupContext } from '@/agent/runtime/startup/startupSpec';
import { resolveEffectiveCodingPromptText } from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { buildCodexAcpPromptForFreshSession } from './utils/buildCodexAcpPromptForFreshSession';
import { ensureRuntimeInstallablesForLaunch } from '@/installables/runtime/ensureRuntimeInstallablesForLaunch';
import { requireCatalogEntry } from '@/backends/catalog';
import {
    resolveCodexSessionBackendMode,
    resolveVendorResumeIdFromSessionMetadata,
    SESSION_CONFIG_OPTIONS_STATE_KEY,
    SESSION_MODELS_STATE_KEY,
    SESSION_MODES_STATE_KEY,
    type CodexBackendMode,
} from '@happier-dev/agents';
	import type { CodexMcpClient } from './codexMcpClient';
	import { resolveCodexBackendModeForRun } from './utils/resolveCodexBackendModeForRun';
	import { resolveCodexRequestedDirectory } from './utils/resolveCodexRequestedDirectory';

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    directory?: string;
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
    experimentalCodexAcp?: boolean;
    codexBackendMode?: CodexBackendMode;
    accountSettingsContext?: import('@/settings/accountSettings/bootstrapAccountSettingsContext').AccountSettingsContext | null;
}): Promise<void> {
	    // Use shared PermissionMode type for cross-agent compatibility
	    type PermissionMode = import('@/api/types').PermissionMode;
	    const requestedDirectory = resolveCodexRequestedDirectory({ directory: opts.directory ?? null });
    interface EnhancedMode {
        permissionMode: PermissionMode;
        permissionModeUpdatedAt?: number;
        appendSystemPrompt?: string | null;
        /**
         * Stable id for the originating user message (when provided by the app),
         * used for discard markers and reconciliation on remote↔local switches.
         */
        localId?: string | null;
        model?: string;
    }

    type CodexRemoteRuntime = Readonly<{
        getSessionId: () => string | null;
        supportsInFlightSteer: () => boolean;
        isTurnInFlight: () => boolean;
        beginTurn: () => void;
        cancel: () => Promise<void>;
        reset: () => Promise<void>;
        startOrLoad: (options: { resumeId?: string | null; existingSessionId?: string | null; importHistory?: boolean }) => Promise<unknown>;
        setSessionMode: (mode: string) => Promise<void>;
        setSessionModel: (model: string) => Promise<void>;
        setSessionConfigOption: (key: string, value: string | number | boolean | null) => Promise<void>;
        steerPrompt: (prompt: string) => Promise<void>;
        sendPrompt: (prompt: string) => Promise<void>;
        flushTurn: () => Promise<void>;
        rollbackConversation: (request: import('@happier-dev/protocol').SessionRollbackRpcParams) => Promise<import('@happier-dev/protocol').SessionRollbackRpcResult>;
    }>;

    //
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Codex');

    const makeAbortError = (message: string): Error => {
        const err = new Error(message);
        err.name = 'AbortError';
        return err;
    };

    const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

    const awaitWithAbortSignal = async <T>(
        promise: Promise<T>,
        signal: AbortSignal,
        extraAbort?: Promise<never>,
    ): Promise<T> => {
        let onAbort: (() => void) | null = null;
        const abortPromise = new Promise<never>((_resolve, reject) => {
            const abortError = makeAbortError('Aborted by user');
            if (signal.aborted) {
                reject(abortError);
                return;
            }
            onAbort = () => reject(abortError);
            signal.addEventListener('abort', onAbort, { once: true });
        });

        try {
            return await Promise.race(extraAbort ? [promise, abortPromise, extraAbort] : [promise, abortPromise]);
        } finally {
            if (onAbort) {
                signal.removeEventListener('abort', onAbort);
                onAbort = null;
            }
        }
    };

    const explicitPermissionMode = opts.permissionMode;
    const hasResumeArg = typeof opts.resume === 'string' && opts.resume.trim().length > 0;
    const accountSettings = hasResumeArg ? null : (opts.accountSettingsContext?.settings ?? null);
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
            appendSystemPrompt: resolveAppendSystemPromptQueueKeyValue(mode),
        }),
    );
    const messageBuffer = new MessageBuffer();

    const nowMs = () => Date.now();
    const timing = createStartupTiming({ enabled: configuration.startupTimingEnabled, nowMs });

    const resumeIdFromArgs = typeof opts.resume === 'string' && opts.resume.trim().length > 0 ? opts.resume.trim() : null;
    // If the user explicitly provided --resume, fail closed for that specific resume id.
    // Once the explicit resume succeeds, subsequent best-effort resume attempts (e.g. after abort) may fall back.
    let strictResumeIdForRun: string | null = resumeIdFromArgs;
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
    const codexBackendMode = resolveCodexBackendModeForRun({
        codexBackendMode: opts.codexBackendMode,
        experimentalCodexAcp: opts.experimentalCodexAcp,
        experimentalCodexAcpEnabledByDefault: isExperimentalCodexAcpEnabled(),
    });
    const experimentalCodexAcpEnabled = codexBackendMode === 'acp';
    const localControlBackend = codexBackendMode === 'acp' || codexBackendMode === 'appServer'
        ? codexBackendMode
        : null;
    const localControlEnabled = localControlBackend !== null;

    const localControlState: {
        experimentalCodexAcpEnabled: boolean;
        localControlBackend: import('./localControl/localControlSupport').CodexLocalControlBackend | null;
    } = {
        experimentalCodexAcpEnabled,
        localControlBackend,
    };

    const resolveLocalControlSupport = createCodexLocalControlSupportResolver({
        startedBy: startedByForLocalControl,
        experimentalCodexAcpEnabled: () => localControlState.experimentalCodexAcpEnabled,
        localControlBackend: () => localControlState.localControlBackend,
        hasTtyForLocal,
    });

    let mode: 'local' | 'remote' = resolveCodexStartingMode({
        explicitStartingMode: opts.startingMode,
        startedBy: startedByForLocalControl,
        hasTtyForLocal,
        localControlEnabled,
	    });
	    let localModeFallbackMessage: string | null = null;
	    let codexAcpFallbackToMcpMessage: string | null = (() => {
	        const raw = typeof process.env.HAPPIER_CODEX_ACP_FALLBACK_TO_MCP_MESSAGE === 'string'
	            ? process.env.HAPPIER_CODEX_ACP_FALLBACK_TO_MCP_MESSAGE.trim()
	            : '';
	        return raw ? raw : null;
	    })();
	    if (!codexAcpFallbackToMcpMessage && experimentalCodexAcpEnabled && !resumeIdFromArgs) {
	        const envOverride = typeof process.env.HAPPIER_CODEX_ACP_BIN === 'string'
	            ? process.env.HAPPIER_CODEX_ACP_BIN.trim()
	            : '';
	        const shouldTreatOverrideAsPath = envOverride.startsWith('.') || envOverride.startsWith('/') || envOverride.includes('\\');
	        if (envOverride && shouldTreatOverrideAsPath) {
	            const resolved = resolve(process.cwd(), envOverride);
	            if (!existsSync(resolved)) {
	                const reason = `Codex ACP is enabled but HAPPIER_CODEX_ACP_BIN does not exist: ${resolved}`;
	                codexAcpFallbackToMcpMessage =
	                    codexAcpFallbackToMcpMessage ??
	                    `Codex ACP could not start (${reason}). Falling back to MCP for this new session.`;
	            }
	        }
	    }
	    const initialCodexAcpFallbackToMcpMessage = codexAcpFallbackToMcpMessage;


    logger.debug('[codex] Starting mode resolved', {
        explicitStartingMode: opts.startingMode ?? null,
        startedBy: startedByForLocalControl,
        hasTtyForLocal,
        codexBackendMode,
        experimentalCodexAcpEnabled,
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
            workspaceDir: requestedDirectory,
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
                    path: requestedDirectory,
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
        directory: requestedDirectory,
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
        metadataKeysToUnsetOnAttach: codexBackendMode === 'acp'
            ? undefined
            : [
                'acpSessionModesV1',
                'acpSessionModelsV1',
                'acpConfigOptionsV1',
                SESSION_MODES_STATE_KEY,
                SESSION_MODELS_STATE_KEY,
                SESSION_CONFIG_OPTIONS_STATE_KEY,
            ],
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
        onAttachMetadataSnapshotReady: (snapshot, _attachSession) => {
            const maybeSnapshot = snapshot as { path?: unknown } | null;
            workspaceDirFromMetadata =
                typeof maybeSnapshot?.path === 'string' && maybeSnapshot.path.trim().length > 0
                    ? maybeSnapshot.path
                    : null;
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

    const promptArtifactBodyCache = new Map<string, string | null>();
    // Late-initialized when a remote Codex runtime is enabled; referenced by the user-message binding for in-flight steering.
    let codexAcpRuntime: ReturnType<typeof createCodexAcpRuntime> | null = null;
    let codexAppServerRuntime: ReturnType<typeof createCodexAppServerRuntime> | null = null;
    const getCodexRemoteRuntime = (): CodexRemoteRuntime | null => {
        return codexAcpRuntime ?? codexAppServerRuntime;
    };

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
            ...resolveAppendSystemPromptModeOverride(message.meta),
            localId: message.localId ?? null,
            model: messageModel,
        };

        const text = message.content.text;
        const special = parseSpecialCommand(text);
        const runtime = getCodexRemoteRuntime();
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
                pushMessageToQueueWithSpecialCommands({
                    queue: messageQueue,
                    message: text,
                    text,
                    mode: enhancedMode,
                });
            });
            return;
        }

        pushMessageToQueueWithSpecialCommands({
            queue: messageQueue,
            message: text,
            text,
            mode: enhancedMode,
        });
    });

    let thinking = false;
    let currentTaskId: string | null = null;
    let didReplaySeedBootstrap = false;
    for (const message of [localModeFallbackMessage, codexAcpFallbackToMcpMessage]) {
        if (!message) continue;
        session.sendSessionEvent({ type: 'message', message });
    }

    session.keepAlive(thinking, mode);
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, mode);
    }, 2000);
    const turnAssistantPreviewTracker = createTurnAssistantPreviewTracker();

    let resumeIdFromLocalControl: string | null = null;
    if (mode === 'local') {
        const localResult = await (localLauncherPromise ??
            codexLocalLauncher<EnhancedMode>({
                path: workspaceDirFromMetadata ?? requestedDirectory,
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
            sessionTitle: getSessionNotificationTitle(session.getMetadataSnapshot.bind(session)),
            assistantPreviewText: turnAssistantPreviewTracker.getPreview(),
            accountSettings: opts.accountSettingsContext?.settings ?? null,
            settingsSecretsReadKeys: opts.accountSettingsContext?.settingsSecretsReadKeys ?? [],
            includeAssistantPreviewText:
                opts.accountSettingsContext?.settings?.notificationsSettingsV1?.readyIncludeMessageText !== false,
            shouldSendPush: () => shouldSendReadyPushNotification(opts.accountSettingsContext?.settings ?? null),
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

    let useCodexAcp = codexBackendMode === 'acp';
    const useCodexAppServer = codexBackendMode === 'appServer';
    const remoteResumeBackendLabel = useCodexAppServer ? 'app-server' : 'ACP';
    const resumeRequested = typeof opts.resume === 'string' && opts.resume.trim().length > 0;
    let codexAcpAutoInstallError: string | null = null;
    if (useCodexAcp) {
        const ensureRuntimeInstallablesResult = await ensureRuntimeInstallablesForLaunch({
            installableKeys: requireCatalogEntry('codex').runtimeInstallableKeys ?? [],
            settings: opts.accountSettingsContext?.settings ?? null,
            machineId,
        });
        if (!ensureRuntimeInstallablesResult.ok) {
            codexAcpAutoInstallError = ensureRuntimeInstallablesResult.logPath
                ? `${ensureRuntimeInstallablesResult.errorMessage} (install log: ${ensureRuntimeInstallablesResult.logPath})`
                : ensureRuntimeInstallablesResult.errorMessage;
        }
        try {
            const resolved = resolveCodexAcpSpawn();
            const availability = validateCodexAcpSpawnAvailability(resolved);
            if (!availability.ok) throw new Error(availability.errorMessage);
        } catch (e) {
            const baseReason = formatErrorForUi(e);
            const reason = codexAcpAutoInstallError
                ? `${baseReason}; auto-install failed: ${codexAcpAutoInstallError}`
                : baseReason;
            if (resumeRequested) {
                throw new Error(
                    `Codex ACP is required to resume sessions, but it cannot start on this machine.\n` +
                    `Reason: ${reason}\n` +
                    `Fix: install codex-acp via Happier → Machine Details → Installables, add codex-acp to PATH, or disable ACP for this session.`,
                );
            }
            useCodexAcp = false;
            // Ensure local-control affordances reflect the resolved remote backend (ACP has failed closed).
            localControlState.experimentalCodexAcpEnabled = false;
            localControlState.localControlBackend = null;
            codexAcpFallbackToMcpMessage =
                codexAcpFallbackToMcpMessage ??
                `Codex ACP could not start (${reason}). Falling back to MCP for this new session.`;
        }
    }
    if (!useCodexAcp && !useCodexAppServer && resumeRequested) {
        throw new Error('Codex resume is not available on plain MCP. Use the default app-server backend, or switch Codex to ACP for ACP-based resume.');
    }

	    if (codexAcpFallbackToMcpMessage && codexAcpFallbackToMcpMessage !== initialCodexAcpFallbackToMcpMessage) {
	        session.sendSessionEvent({ type: 'message', message: codexAcpFallbackToMcpMessage });
	        messageBuffer.addMessage(codexAcpFallbackToMcpMessage, 'status');
	    }
    const shouldLogAcpDebug = Boolean(process.env.DEBUG) || process.env.HAPPIER_E2E_PROVIDERS === '1';
    if (shouldLogAcpDebug) {
        logger.debug(`[Codex] Remote engine selected: ${useCodexAcp ? 'acp' : useCodexAppServer ? 'appServer' : 'mcp'}`);
    }
    let happierMcpServer: { url: string; stop: () => void } | null = null;
    let client: CodexMcpClient | null = null;
    let remoteTerminalUi: ReturnType<typeof createCodexRemoteTerminalUi> | null = null;
    // codexAcpRuntime is declared above to allow the onUserMessage binding to steer mid-turn.
    // Codex ACP `startOrLoad` (especially `loadSession`) can be slow and is not cancellable at the protocol
    // level today. Local-control switching and abort must still unblock immediately, so we race `startOrLoad`
    // awaits against this signal.
    let startOrLoadAbortController = new AbortController();

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            await permissionHandler.abortPendingRequestsAndFlush('Aborted by user');
            startOrLoadAbortController.abort();
            // Store the current session ID before aborting for potential resume
            if (useCodexAcp || useCodexAppServer) {
                const currentRemoteSessionId = getCodexRemoteRuntime()?.getSessionId();
                if (currentRemoteSessionId) {
                    storedSessionIdForResume = currentRemoteSessionId;
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
            } else if (useCodexAppServer && codexAppServerRuntime) {
                try {
                    await codexAppServerRuntime.cancel();
                } catch (error) {
                    logger.debug('[CodexAppServer] Failed to cancel in-flight turn on abort (non-fatal)', error);
                }
            }

            abortController.abort();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            abortController = new AbortController();
            startOrLoadAbortController = new AbortController();
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
        onTerminate: async (event, outcome) => {
            shouldExit = true;
            await handleAbort();
            const archiveDecision = resolveTerminationArchiveDecision({
                startedBy: opts.startedBy,
                event,
                outcome,
            });

            try {
                if (archiveDecision.archive) {
                    await archiveAndCloseRuntimeSession(session, opts.credentials, archiveDecision.archiveReason);
                }
            } catch (e) {
                logger.debug('[Codex] Failed to archive session during termination (non-fatal)', e);
            }

            try {
                await cleanupCodexRunResources({
                    session,
                    reconnectionHandle,
                    client,
                    codexRuntime: getCodexRemoteRuntime(),
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
    session.rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_ROLLBACK, async (raw: unknown) => {
        const parsed = SessionRollbackRpcParamsSchema.safeParse(raw);
        if (!parsed.success) {
            return { ok: false, errorCode: 'invalid_request', errorMessage: 'Invalid params' };
        }
        const runtime = getCodexRemoteRuntime();
        if (!runtime || useCodexAcp || !useCodexAppServer) {
            return {
                ok: false,
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                errorMessage: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
            };
        }
        return await runtime.rollbackConversation(parsed.data);
    });

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    //
    // Initialize Ink UI
    //

    const hasTTY = resolveHasTTY({
        stdoutIsTTY: process.stdout.isTTY,
        stdinIsTTY: process.stdin.isTTY,
        startedBy: opts.startedBy,
    });
    const remoteControlSurface = opts.startedBy === 'daemon'
        ? resolveRemoteModeControlSurface({
            stdoutIsTTY: process.stdout.isTTY,
            stdinIsTTY: process.stdin.isTTY,
            startedBy: opts.startedBy,
            terminalMode: opts.terminalRuntime?.mode ?? null,
        })
        : hasTTY
            ? 'ink'
            : 'none';
    let requestedSwitchToLocal = false;
    const createSwitchToLocalBarrier = (): { promise: Promise<void>; resolve: () => void } => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
            resolve = r;
        });
        return { promise, resolve };
    };
    let switchToLocalBarrier = createSwitchToLocalBarrier();

    const resolveLocalSwitchAvailability = async (): Promise<
        { ok: true } | { ok: false; reason: import('./localControl/localControlSupport').CodexLocalControlUnsupportedReason }
    > => {
        const support = await resolveLocalControlSupport({ includeAcpProbe: false });
        const gated = applyLocalControlLaunchGating({ startingMode: 'local', support });
        if (gated.mode === 'local') return { ok: true };
        return { ok: false, reason: gated.fallback?.reason ?? 'resume-disabled' };
    };

    const requestSwitchToLocal = async (): Promise<void> => {
        if (requestedSwitchToLocal) return;
        requestedSwitchToLocal = true;
        switchToLocalBarrier.resolve();
        startOrLoadAbortController.abort();
        await handleAbort();
    };

    const requestSwitchToLocalIfSupported = async (): Promise<boolean> => {
        return await requestCodexSwitchToLocal({
            queue: messageQueue,
            session,
            resolveLocalSwitchAvailability,
            requestSwitch: requestSwitchToLocal,
            formatSwitchDeniedMessage: (reason) => {
                const message = formatCodexLocalControlSwitchDeniedMessage(reason);
                messageBuffer.addMessage(message, 'status');
                return message;
            },
            formatError: formatErrorForUi,
        });
    };

    remoteTerminalUi = createCodexRemoteTerminalUi({
        messageBuffer,
        logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
        hasTTY,
        surface: remoteControlSurface,
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

    for (const message of [localModeFallbackMessage, codexAcpFallbackToMcpMessage]) {
        if (!message) continue;
        messageBuffer.addMessage(message, 'status');
    }

    const localRemoteSwitchController = createLocalRemoteModeController({
        session,
        getThinking: () => thinking,
        resolveLocalSwitchAvailability,
        requestSwitchToLocalIfSupported,
        mountRemoteUi: () => remoteTerminalUi!.mount(),
        unmountRemoteUi: () => remoteTerminalUi!.unmount(),
        setRemoteUiAllowsSwitchToLocal: (allowed) => remoteTerminalUi!.setAllowSwitchToLocal(allowed),
    });

    // Register the remote switch handler before any remote-mode awaits so a session that becomes
    // externally visible during startup can still fail closed instead of returning "method not available".
    localRemoteSwitchController.registerRemoteSwitchHandler();

    //
    // Start Context 
    //

    // Codex ACP session resume intentionally skips a separate capabilities probe.
    // The probe requires spawning an ACP agent and waiting for initialize, which can be slower than
    // just attempting `loadSession` directly (and it duplicates work the runtime must do anyway).
    //
    // We still fail closed: if a resume id is provided and Codex ACP cannot load it, the subsequent
    // session load attempt will throw and we will not silently start a new session.

    // Start Happier MCP server (HTTP) and prepare STDIO bridge config for Codex
    const directory = workspaceDirFromMetadata ?? requestedDirectory;
    let mcpServers: Awaited<ReturnType<typeof resolveRunnerMcpServers>>['mcpServers'] = {};
    let codexAppServerProcessEnv = process.env;
    let codexAppServerConfigOverrides: string[] = [];
    const happierBridge = await resolveRunnerMcpServers({
        session,
        credentials: opts.credentials,
        accountSettings,
        machineId,
        directory,
        sessionMetadata: session.getMetadataSnapshot(),
        commandMode: 'current-process',
    });
    happierMcpServer = happierBridge.happierMcpServer;
    mcpServers = happierBridge.mcpServers;
    if (useCodexAppServer) {
        codexAppServerConfigOverrides = buildCodexAppServerConfigOverrides(mcpServers);
    }
    const resolveFreshSessionSystemPrompt = async (baseOverride?: string | null): Promise<string> =>
        await resolveEffectiveCodingPromptText({
            credentials: opts.credentials,
            settings: opts.accountSettingsContext?.settings ?? null,
            profileId: session.getMetadataSnapshot()?.profileId ?? null,
            baseOverride,
            executionRunsFeatureEnabled: resolveCliFeatureDecision({
                featureId: 'execution.runs',
                env: process.env,
            }).state === 'enabled',
            providerId: 'codex',
            cache: promptArtifactBodyCache,
        });

    if (!useCodexAcp && !useCodexAppServer) {
        const codexMcpServer = await resolveCodexMcpServerSpawn();
        const { CodexMcpClient: CodexMcpClientClass } = await import('./codexMcpClient');
        client = new CodexMcpClientClass({ mode: codexMcpServer.mode, command: codexMcpServer.command });
    }

            // NOTE: Codex resume support varies by build; forks may seed `codex-reply` with a stored session id.
            permissionHandler = createCodexPermissionHandler({
                session,
                pushSender: api.push(),
                getAccountSettings: () => opts.accountSettingsContext?.settings ?? null,
                getAccountSettingsSecretsReadKeys: () => opts.accountSettingsContext?.settingsSecretsReadKeys ?? [],
                onAbortRequested: handleAbort,
                toolTrace: { protocol: useCodexAcp ? 'acp' : 'codex', provider: 'codex' },
                triggerAbortCallbackOnAbortDecision: useCodexAcp,
            });
            applyPermissionModeToCodexPermissionHandler({
                permissionHandler,
                permissionMode: currentPermissionMode ?? initialPermissionMode,
                permissionModeUpdatedAt: currentPermissionModeUpdatedAt,
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
        const publishedBackendMode: CodexBackendMode = useCodexAcp
            ? 'acp'
            : useCodexAppServer
                ? 'appServer'
                : 'mcp';
        publishCodexSessionIdMetadata({
            session,
            getCodexThreadId: () => (client ? client.getSessionId() : (getCodexRemoteRuntime()?.getSessionId() ?? null)),
            backendMode: publishedBackendMode,
            transcriptStorage: process.env.HAPPIER_TRANSCRIPT_STORAGE === 'direct' ? 'direct' : 'persisted',
            codexHome: process.env.CODEX_HOME ?? null,
            activeServerDir: configuration.activeServerDir,
            processEnv: process.env,
            lastPublished: lastCodexThreadIdPublished,
        });
    };

    const readAttachedCodexAppServerThreadId = (): string | null => {
        const metadata = session.getMetadataSnapshot() as Record<string, unknown> | null;
        if (resolveCodexSessionBackendMode({ metadata }) !== 'appServer') {
            return null;
        }
        return resolveVendorResumeIdFromSessionMetadata('codex', metadata);
    };

    if (useCodexAcp) {
        codexAcpRuntime = createCodexAcpRuntime({
            directory,
            session,
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
    } else if (useCodexAppServer) {
        codexAppServerRuntime = createCodexAppServerRuntime({
            directory,
            activeServerDir: configuration.activeServerDir,
            processEnv: codexAppServerProcessEnv,
            configOverrides: codexAppServerConfigOverrides,
            session,
            transcriptSession: createCurrentSessionTranscriptPort(() => session),
            onThinkingChange: (value) => { thinking = value; },
            permissionHandler,
            getPermissionMode: () => runtimePermissionModeRef.current,
        });
        try {
            publishInFlightSteerCapability({ session, runtime: codexAppServerRuntime });
        } catch (e) {
            logger.debug('[codex] Failed to publish in-flight steer capability (non-fatal)', e);
        }
    }

    if (client) {
        const requestUserInputBridge = createCodexRequestUserInputBridge({
            permissionHandler,
            continueSession: async (prompt) => {
                await client.continueSession(prompt);
            },
            logger,
        });

        const handleMcpMessage = createCodexMcpMessageHandler({
            logger,
            session,
            messageBuffer,
            sendReady,
            publishCodexThreadIdToMetadata,
            diffProcessor,
            getCurrentTaskId: () => currentTaskId,
            setCurrentTaskId: (next) => {
                currentTaskId = next;
            },
            getThinking: () => thinking,
            setThinking: (next) => {
                thinking = next;
            },
            turnAssistantPreviewTracker,
        });
        client.setHandler((msg) => {
            handleMcpMessage(msg);
            void requestUserInputBridge.onCodexEvent(msg);
        });
    }

    let first = true;

	    try {
	        let wasCreated = false;
	            let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;

	        const codexRemoteRuntimeForSync = getCodexRemoteRuntime();
	        const modelSync =
	            codexRemoteRuntimeForSync
	                ? createModelOverrideSynchronizer({
	                      session: { getMetadataSnapshot: () => session.getMetadataSnapshot() },
	                      runtime: { setSessionModel: (modelId) => codexRemoteRuntimeForSync.setSessionModel(modelId) },
	                      isStarted: () => wasCreated,
	                  })
	                : null;
	        const sessionModeSync =
	            codexRemoteRuntimeForSync
	                ? createSessionModeOverrideSynchronizer({
	                      session: { getMetadataSnapshot: () => session.getMetadataSnapshot() },
	                      runtime: { setSessionMode: (modeId) => codexRemoteRuntimeForSync.setSessionMode(modeId) },
	                      isStarted: () => wasCreated,
	                  })
	                : null;
	        const configOptionSync =
	            codexRemoteRuntimeForSync
	                ? createSessionConfigOptionOverrideSynchronizer({
	                      session: { getMetadataSnapshot: () => session.getMetadataSnapshot() },
	                      runtime: { setSessionConfigOption: (configId, valueId) => codexRemoteRuntimeForSync.setSessionConfigOption(configId, valueId) },
	                      isStarted: () => wasCreated,
	                  })
	                : null;

            const seedCodexAppServerOverridesBeforeStartOrLoad = async (): Promise<void> => {
                if (!useCodexAppServer || wasCreated) {
                    return;
                }
                const codexRuntime = getCodexRemoteRuntime();
                if (!codexRuntime) {
                    return;
                }
                await seedCodexAppServerPendingSessionOverrides({
                    metadata: session.getMetadataSnapshot(),
                    runtime: codexRuntime,
                });
            };

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
	            sessionModeSync?.syncFromMetadata();
	            configOptionSync?.syncFromMetadata();
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

        while (!shouldExit) {
            if (mode === 'local') {
                await localRemoteSwitchController.publishModeState('local');
                const localPass = await runCodexLocalModePass<EnhancedMode>({
                    session,
                    messageQueue,
                    workspaceDir: workspaceDirFromMetadata ?? requestedDirectory,
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
            startOrLoadAbortController = new AbortController();
            switchToLocalBarrier = createSwitchToLocalBarrier();

            // For strict resume flows, start (or load) the Codex ACP session eagerly. Otherwise, remote mode
            // can remain idle (and even switch back to local) without spawning the Codex backend until the
            // first prompt is processed.
            if ((useCodexAcp || useCodexAppServer) && !wasCreated) {
                const codexRuntime = getCodexRemoteRuntime();
                if (!codexRuntime) {
                    throw new Error('Codex remote runtime was not initialized');
                }

                const resumeId = storedSessionIdForResume?.trim();
                const isStrictExplicit = Boolean(strictResumeIdForRun && resumeId && resumeId === strictResumeIdForRun);
                const isStrictLocalControl = storedSessionIdFromLocalControl === true && Boolean(resumeId);

                if (resumeId && (useCodexAppServer || isStrictExplicit || isStrictLocalControl)) {
                    messageBuffer.addMessage('Resuming previous context…', 'status');
                    const resumeSignal = startOrLoadAbortController.signal;
                    await seedCodexAppServerOverridesBeforeStartOrLoad();
                    const startOrLoadPromise = Promise.resolve(codexRuntime.startOrLoad({
                        resumeId,
                        // Avoid importing ACP replay history into Happier on resume; Happier transcript is the source of truth.
                        importHistory: false,
                    })).then(() => undefined);
                    let resumeAborted = false;
                    try {
                        await awaitWithAbortSignal(
                            startOrLoadPromise,
                            resumeSignal,
                            createSwitchToLocalAbortPromise({
                                barrier: switchToLocalBarrier.promise,
                                createAbortError: () => makeAbortError('Switched to local'),
                            }),
                        );
                    } catch (e) {
                        if (isAbortError(e) || resumeSignal.aborted) {
                            resumeAborted = true;
                            // Ensure any late rejection from the in-flight resume attempt is handled.
                            void startOrLoadPromise.catch(() => undefined);
                        } else {
                            const reason = formatErrorForUi(e);
                            const message = isStrictLocalControl
                                ? `Failed to switch this Codex session from local → remote.\n` +
                                  `Reason: could not resume the remote Codex ${remoteResumeBackendLabel} session (${resumeId}).\n` +
                                  `Details: ${reason}\n` +
                                  `Fix: ensure Codex ${remoteResumeBackendLabel} can run reliably on this machine, then retry switching to remote.\n` +
                                  `Note: Happier refuses to start a new remote Codex session during a local→remote switch, because it would fork the conversation.`
                                : `Failed to resume this Codex ${remoteResumeBackendLabel} session (${resumeId}).\n` +
                                  `Reason: ${reason}\n` +
                                  `Fix: ensure Codex ${remoteResumeBackendLabel} can run on this machine, then retry.\n` +
                                  `Note: Happier refuses to start a new Codex session when --resume was requested.`;
                            messageBuffer.addMessage(message, 'status');
                            session.sendSessionEvent({ type: 'message', message });
                            const err = new Error(message);
                            err.name = 'CodexAcpResumeError';
                            throw err;
                        }
                    }

                        if (!resumeAborted) {
                            if (strictResumeIdForRun && resumeId === strictResumeIdForRun) {
                                strictResumeIdForRun = null;
                            }
                        storedSessionIdForResume = nextStoredSessionIdForResumeAfterAttempt(storedSessionIdForResume, {
                            attempted: true,
                            success: true,
                        });
                        storedSessionIdFromLocalControl = false;

                        if (useCodexAcp) {
                            try {
                                await syncCodexAcpSessionModeFromPermissionMode({
                                    runtime: codexAcpRuntime!,
                                    permissionMode: currentPermissionMode ?? initialPermissionMode,
                                    metadata: session.getMetadataSnapshot(),
                                });
                            } catch (e) {
                                logger.debug('[CodexACP] Failed to sync session mode after startOrLoad (non-fatal)', e);
                            }
                        }

	                        wasCreated = true;
	                        first = false;
	                        await sessionModeSync?.flushPendingAfterStart();
	                        await configOptionSync?.flushPendingAfterStart();
	                        await modelSync?.flushPendingAfterStart();
	                    }
                } else if (useCodexAppServer) {
                    const existingAppServerSessionId = readAttachedCodexAppServerThreadId();
                    if (existingAppServerSessionId) {
                        const startSignal = startOrLoadAbortController.signal;
                        await seedCodexAppServerOverridesBeforeStartOrLoad();
                        const startOrLoadPromise = Promise.resolve(codexRuntime.startOrLoad({
                            existingSessionId: existingAppServerSessionId,
                        })).then(() => undefined);
                        try {
                            await awaitWithAbortSignal(
                                startOrLoadPromise,
                                startSignal,
                                createSwitchToLocalAbortPromise({
                                    barrier: switchToLocalBarrier.promise,
                                    createAbortError: () => makeAbortError('Switched to local'),
                                }),
                            );
                        } catch (e) {
                            if (isAbortError(e) || startSignal.aborted) {
                                void startOrLoadPromise.catch(() => undefined);
                                continue;
                            }
                            throw e;
                        }
                        wasCreated = true;
                        first = false;
                        await sessionModeSync?.flushPendingAfterStart();
                        await configOptionSync?.flushPendingAfterStart();
                        await modelSync?.flushPendingAfterStart();
                    }
                }
            }

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
                    await getCodexRemoteRuntime()?.reset();
                }
                wasCreated = false;

                // Reset processors/permissions
                permissionHandler.reset();
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
                const localId =
                    typeof message.mode.localId === 'string' && message.mode.localId
                        ? message.mode.localId
                        : null;
                const replaySeedResolution = await resolveCodexQueuedPromptWithReplaySeed({
                    sessionClient: session,
                    text: message.message,
                    localId,
                    replaySeedAllowed: specialCommand.type === null,
                    didBootstrap: didReplaySeedBootstrap,
                });
                didReplaySeedBootstrap = replaySeedResolution.didBootstrap;
                const providerPromptText = replaySeedResolution.text;

                if (useCodexAcp || useCodexAppServer) {
                    const codexRuntime = getCodexRemoteRuntime();
                    if (!codexRuntime) {
                        throw new Error('Codex remote runtime was not initialized');
                    }
                    codexRuntime.beginTurn();
                    if (shouldLogAcpDebug) {
                        logger.debug('[CodexACP] beginTurn');
                    }

                    let startedFreshSessionForTurn = false;

                    if (!wasCreated) {
                        if (shouldLogAcpDebug) {
                            logger.debug('[CodexACP] startOrLoad begin');
                        }
                        const resumeId = storedSessionIdForResume?.trim();
                        if (resumeId) {
                            messageBuffer.addMessage('Resuming previous context…', 'status');
                            const resumeSignal = startOrLoadAbortController.signal;
                            await seedCodexAppServerOverridesBeforeStartOrLoad();
                            const startOrLoadPromise = Promise.resolve(codexRuntime.startOrLoad({
                                resumeId,
                                // Avoid importing ACP replay history into Happier on resume; Happier transcript is the source of truth.
                                importHistory: false,
                            })).then(() => undefined);
                            try {
                                await awaitWithAbortSignal(
                                    startOrLoadPromise,
                                    resumeSignal,
                                    createSwitchToLocalAbortPromise({
                                        barrier: switchToLocalBarrier.promise,
                                        createAbortError: () => makeAbortError('Switched to local'),
                                    }),
                                );
                                if (strictResumeIdForRun && resumeId === strictResumeIdForRun) {
                                    strictResumeIdForRun = null;
                                }
                                storedSessionIdForResume = nextStoredSessionIdForResumeAfterAttempt(storedSessionIdForResume, {
                                    attempted: true,
                                    success: true,
                                });
                                storedSessionIdFromLocalControl = false;
                            } catch (e) {
                                if (isAbortError(e) || resumeSignal.aborted) {
                                    // Ensure any late rejection from the in-flight resume attempt is handled.
                                    void startOrLoadPromise.catch(() => undefined);
                                    throw e;
                                }
                                const isStrictExplicit = Boolean(strictResumeIdForRun && resumeId === strictResumeIdForRun);
                                const isStrictLocalControl = storedSessionIdFromLocalControl === true;
                                const isStrict = isStrictExplicit || isStrictLocalControl;
                                if (isStrict) {
                                    const reason = formatErrorForUi(e);
                                    const message = isStrictLocalControl
                                        ? `Failed to switch this Codex session from local → remote.\n` +
                                          `Reason: could not resume the remote Codex ${remoteResumeBackendLabel} session (${resumeId}).\n` +
                                          `Details: ${reason}\n` +
                                          `Fix: ensure Codex ${remoteResumeBackendLabel} can run reliably on this machine, then retry switching to remote.\n` +
                                          `Note: Happier refuses to start a new remote Codex session during a local→remote switch, because it would fork the conversation.`
                                        : `Failed to resume this Codex ${remoteResumeBackendLabel} session (${resumeId}).\n` +
                                          `Reason: ${reason}\n` +
                                          `Fix: ensure Codex ${remoteResumeBackendLabel} can run on this machine, then retry.\n` +
                                          `Note: Happier refuses to start a new Codex session when --resume was requested.`;
                                    messageBuffer.addMessage(message, 'status');
                                    session.sendSessionEvent({ type: 'message', message });
                                    const err = new Error(message);
                                    err.name = 'CodexAcpResumeError';
                                    throw err;
                                }

                                logger.debug('[Codex ACP] Resume failed; starting a new session instead', e);
                                messageBuffer.addMessage('Resume failed; starting a new session.', 'status');
                                session.sendSessionEvent({ type: 'message', message: 'Resume failed; starting a new session.' });
                                const startSignal = startOrLoadAbortController.signal;
                                await seedCodexAppServerOverridesBeforeStartOrLoad();
                                const fallbackPromise = Promise.resolve(codexRuntime.startOrLoad({})).then(() => undefined);
                                try {
                                    await awaitWithAbortSignal(
                                        fallbackPromise,
                                        startSignal,
                                        createSwitchToLocalAbortPromise({
                                            barrier: switchToLocalBarrier.promise,
                                            createAbortError: () => makeAbortError('Switched to local'),
                                        }),
                                    );
                                } catch (fallbackError) {
                                    if (isAbortError(fallbackError) || startSignal.aborted) {
                                        // Ensure any late rejection from the in-flight start attempt is handled.
                                        void fallbackPromise.catch(() => undefined);
                                    }
                                    throw fallbackError;
                                }
                                startedFreshSessionForTurn = true;
                                storedSessionIdForResume = nextStoredSessionIdForResumeAfterAttempt(storedSessionIdForResume, {
                                    attempted: true,
                                    success: false,
                                });
                                storedSessionIdFromLocalControl = false;
                            }
                        } else {
                            const startSignal = startOrLoadAbortController.signal;
                            await seedCodexAppServerOverridesBeforeStartOrLoad();
                            const startOrLoadPromise = Promise.resolve(codexRuntime.startOrLoad({})).then(() => undefined);
                            try {
                                await awaitWithAbortSignal(
                                    startOrLoadPromise,
                                    startSignal,
                                    createSwitchToLocalAbortPromise({
                                        barrier: switchToLocalBarrier.promise,
                                        createAbortError: () => makeAbortError('Switched to local'),
                                    }),
                                );
                            } catch (e) {
                                if (isAbortError(e) || startSignal.aborted) {
                                    // Ensure any late rejection from the in-flight start attempt is handled.
                                    void startOrLoadPromise.catch(() => undefined);
                                }
                                throw e;
                            }
                            startedFreshSessionForTurn = true;
                        }
                        if (shouldLogAcpDebug) {
                            logger.debug('[CodexACP] startOrLoad complete');
                        }
                        if (useCodexAcp) {
                            try {
                                await syncCodexAcpSessionModeFromPermissionMode({
                                    runtime: codexAcpRuntime!,
                                    permissionMode: message.mode.permissionMode,
                                    metadata: session.getMetadataSnapshot(),
                                });
                            } catch (e) {
                                logger.debug('[CodexACP] Failed to sync session mode after startOrLoad (non-fatal)', e);
                            }
                        }
	                        wasCreated = true;
	                        first = false;
	                        await sessionModeSync?.flushPendingAfterStart();
	                        await configOptionSync?.flushPendingAfterStart();
	                        await modelSync?.flushPendingAfterStart();
	                    }

                    if (shouldLogAcpDebug) {
                        logger.debug('[CodexACP] sendPrompt begin');
                    }
                    if (useCodexAcp) {
                        try {
                            await syncCodexAcpSessionModeFromPermissionMode({
                                runtime: codexAcpRuntime!,
                                permissionMode: message.mode.permissionMode,
                                metadata: session.getMetadataSnapshot(),
                            });
                        } catch (e) {
                            logger.debug('[CodexACP] Failed to sync session mode before prompt (non-fatal)', e);
                        }
                    }
                    const systemPromptText = startedFreshSessionForTurn
                        ? await resolveFreshSessionSystemPrompt(
                            resolveAppendSystemPromptBaseOverride(message.mode),
                        )
                        : undefined;
                    await codexRuntime.sendPrompt(
                        buildCodexAcpPromptForFreshSession({
                            prompt: providerPromptText,
                            startedFreshSession: startedFreshSessionForTurn,
                            systemPromptText,
                        }),
                    );
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

                    // For Happier's 'default' mode, omit sandbox/approvalPolicy so the Codex MCP
                    // subprocess honors ~/.codex/config.toml. Non-default modes still override.
                    const mcpPolicy =
                        message.mode.permissionMode === 'default'
                            ? { approvalPolicy: null as null, sandbox: null as null }
                            : resolveCodexMcpPolicyForPermissionMode(message.mode.permissionMode);

                    if (!wasCreated) {
                    const systemPromptText = first
                        ? await resolveFreshSessionSystemPrompt(
                            resolveAppendSystemPromptBaseOverride(message.mode),
                        )
                        : undefined;
                    const startConfig: CodexSessionConfig = buildCodexMcpStartConfigForMessage({
                        message: providerPromptText,
                        first,
                        sandbox: mcpPolicy.sandbox,
                        approvalPolicy: mcpPolicy.approvalPolicy,
                        mcpServers,
                        mode: message.mode,
                        systemPromptText,
                        cwd: directory,
                    });

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

                    wasCreated = true;
                    first = false;
                } else {
                    const response = await mcpClient.continueSession(
                        providerPromptText,
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
                const isResumeError = error instanceof Error && error.name === 'CodexAcpResumeError';

                if (isResumeError) {
                    throw error;
                }

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
                    // For unexpected errors, keep the ACP session id (best-effort) so a subsequent start can attempt resume.
                    if (useCodexAcp || useCodexAppServer) {
                        const currentRemoteSessionId = getCodexRemoteRuntime()?.getSessionId();
                        if (currentRemoteSessionId) {
                            storedSessionIdForResume = currentRemoteSessionId;
                            storedSessionIdFromLocalControl = false;
                            logger.debug('[CodexACP] Stored session after unexpected error:', storedSessionIdForResume);
                        }
                    }
                }
            } finally {
                if (useCodexAcp || useCodexAppServer) {
                    await getCodexRemoteRuntime()?.flushTurn();
                }
                if (useCodexAcp) {
                    modelSync?.syncFromMetadata();
                }

                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
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
                        await getCodexRemoteRuntime()?.reset();
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
            codexRuntime: getCodexRemoteRuntime(),
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
