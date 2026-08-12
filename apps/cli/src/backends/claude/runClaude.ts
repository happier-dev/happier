import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import { restoreStdinBestEffort } from '@/ui/ink/restoreStdinBestEffort';
import { loop } from '@/backends/claude/loop';
import { AgentState, Metadata, Session as ApiSession } from '@/api/types';
import packageJson from '../../../package.json';
import { readSettings, type Credentials } from '@/persistence';
import { EnhancedMode, PermissionMode } from './loop';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { startCaffeinate, stopCaffeinate } from '@/integrations/caffeinate';
import { extractSDKMetadataAsync } from '@/backends/claude/sdk/metadataExtractor';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import { resolveClaudeStructuredUserMessageRouting } from '@/backends/claude/utils/structuredMessages/resolveClaudeStructuredUserMessageRouting';
import { getEnvironmentInfo } from '@/ui/doctor';
import { configuration } from '@/configuration';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import {
    buildClaudeEndpointState,
    hasClaudeEndpointRecoveryRequest,
    parsePortFromUrl,
    persistClaudeEndpointStateBestEffort,
    resolveClaudeAdoptEndpointRecovery,
} from '@/backends/claude/endpointRecovery/claudeEndpointRecovery';
import { startHookServer, type PermissionHookData, type SessionHookData } from '@/backends/claude/utils/startHookServer';
import { createClaudeStatuslineApplier } from '@/backends/claude/statusline/applyClaudeStatuslineUpdate';
import { cleanupHookPluginDir, cleanupHookSettingsFile } from '@/backends/claude/utils/generateHookSettings';
import {
    generateHookPluginDirWithEnsuredRuntime,
    generateHookSettingsFileWithEnsuredRuntime,
} from '@/backends/claude/utils/generateHookSettingsFileWithEnsuredRuntime';
import { registerKillSessionHandler } from '@/rpc/handlers/killSession';
import { projectPath } from '../../projectPath';
import { resolve } from 'node:path';
import { startOfflineReconnection, connectionState } from '@/api/offline/serverConnectionErrors';
import { claudeLocal } from '@/backends/claude/claudeLocal';
import { createSessionScanner } from '@/backends/claude/utils/sessionScanner';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import { buildTerminalMetadataFromRuntimeFlags } from '@/terminal/runtime/terminalMetadata';
import { persistTerminalAttachmentInfoIfNeeded, reportSessionToDaemonIfRunning, sendTerminalFallbackMessageIfNeeded } from '@/agent/runtime/startupSideEffects';
import { applyStartupMetadataUpdateToSession, buildModelOverride, buildPermissionModeOverride } from '@/agent/runtime/startupMetadataUpdate';
import { initializeRuntimeOverridesSynchronizer } from '@/agent/runtime/runtimeOverridesSynchronizer';
import { createBaseSessionForAttach } from '@/agent/runtime/createBaseSessionForAttach';
import { createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { readSessionAttachMetadataIdentityPolicyFromEnv } from '@/agent/runtime/readSessionAttachMetadataIdentityPolicyFromEnv';
import { hashClaudeEnhancedModeForQueue } from '@/backends/claude/remote/modeHash';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { applyClaudeRemoteMetaState } from '@/backends/claude/remote/claudeRemoteMetaState';
import { resolveInitialClaudeRemoteMetaState } from '@/backends/claude/remote/resolveInitialClaudeRemoteMetaState';
import {
    normalizeClaudeRemoteMode,
    pinClaudeRemoteModeToActiveRuntime,
} from '@/backends/claude/remote/normalizeClaudeRemoteMode';
import { inferPermissionIntentFromClaudeArgs } from './utils/inferPermissionIntentFromArgs';
import { adoptModelOverrideFromMetadata } from './utils/adoptModelOverrideFromMetadata';
import { adoptReasoningEffortOverrideFromMessageMeta } from './utils/adoptReasoningEffortOverrideFromMessageMeta';
import { adoptReasoningEffortOverrideFromMetadata } from './utils/adoptReasoningEffortOverrideFromMetadata';
import { adoptUltracodeOverrideFromMessageMeta, adoptUltracodeOverrideFromMetadata } from './utils/adoptUltracodeOverride';
import { resolveSessionModeOverrideFromMetadataSnapshot } from '@/agent/runtime/permission/permissionModeFromMetadata';
import { initializeBackendApiContext } from '@/agent/runtime/initializeBackendApiContext';
import { ClaudeLocalPermissionBridge, DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE } from '@/backends/claude/localPermissions/localPermissionBridge';
import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { computeRunnerTerminationOutcome, type RunnerTerminationEvent } from '@/agent/runtime/runnerTerminationOutcome';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/runnerTerminationHandlers';
import { createClaudeShouldTerminateOnUnhandledRejection } from './claudeUnhandledRejectionPolicy';
import { requestClaudeExplicitRunnerStop } from './claudeExplicitRunnerStop';
import { updateAgentStateBestEffort, updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import { resolvePermissionModeSeedForAgentStart } from '@/settings/permissions/permissionModeSeed';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';
import { runStartupCoordinator } from '@/agent/runtime/startup/startupCoordinator';
import { createStartupTiming } from '@/agent/runtime/startup/startupTiming';
import { writeStartupOverridesCacheForBackend } from '@/agent/runtime/startup/startupOverridesCache';
import { createClaudeStartupSpec, type ClaudeStartupArtifacts } from '@/backends/claude/startup/createClaudeStartupSpec';
import type { DeferredApiSessionTarget } from '@/agent/runtime/startup/DeferredApiSessionClient';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import {
    createBackendRunRuntimeActivityLifecycle,
    initializeBackendRunSession,
    type BackendRunRuntimeActivityLifecycle,
} from '@/agent/runtime/initializeBackendRunSession';
import { createStartupMetadataOverrides } from '@/agent/runtime/createStartupMetadataOverrides';
import type { PushNotificationClient } from '@/api/pushNotifications';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { resolveEffectiveCodingPromptText } from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID } from './unifiedTerminal/tuiControls';
import { createClaudeUnifiedUserMessageHandler } from './startup/createClaudeUnifiedUserMessageHandler';
import { resolveInitialClaudeSystemPromptText } from './utils/resolveInitialClaudeSystemPromptText';
import { shouldStartClaudeSessionCaffeinate } from './sessionCaffeinatePolicy';
import { ensureManagedJavaScriptRuntimeCommand } from '@/runtime/js/managedJavaScriptRuntime';
import { createClaudeRawMessageTurnDiffBridge } from './utils/createClaudeRawMessageTurnDiffBridge';
import { archiveAndCloseRuntimeSession } from '@/session/services/archiveAndCloseRuntimeSession';
import { createSessionMetadataShutdownDeadline } from '@/session/services/sessionMetadataShutdownDeadline';
import { resolveRequestedSessionDirectory } from '@/agent/runtime/resolveRequestedSessionDirectory';
import { publishClaudeSessionModelsMetadataBestEffort } from '@/backends/claude/sessionControls/publishClaudeSessionModelsMetadataBestEffort';
import {
    probeClaudeInstalledRuntimeCapabilities,
    resolveClaudeInstalledRuntimeSessionMode,
} from '@/backends/claude/sessionControls/probeClaudeInstalledRuntimeCapabilities';
import {
    createClaudeModelEffortLevelsTracker,
    type ClaudeModelEffortLevelsTracker,
} from '@/backends/claude/models/claudeModelEffortLevelsTracker';
import { resolveTerminationArchiveDecision } from '@/agent/runtime/terminationArchivePolicy';
import { buildClaudeAgentState } from '@/backends/claude/localControl/buildClaudeAgentState';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import type { SessionRuntimeActivityContributionHandle } from '@/session/runtimeActivity/types';
import type { RuntimeActivityApplicability } from '@/session/runtimeActivity/types';
import { createClaudeProviderRuntimeActivityBindingOwner } from './providerActivity/createClaudeProviderRuntimeActivityAdapter';

type ClaudePermissionLifecycleHookEventName = 'PermissionRequest' | 'PermissionRequestCompleted';

async function refreshClaudeInitialModeModelEffortEvidence(params: Readonly<{
    initialMode: EnhancedMode;
    modelEffortTracker: ClaudeModelEffortLevelsTracker;
    modelId: unknown;
}>): Promise<string> {
    const currentModelId = typeof params.modelId === 'string' ? params.modelId.trim() : '';
    await params.modelEffortTracker.refresh(currentModelId);
    params.initialMode.model = currentModelId || undefined;
    params.initialMode.modelEffortLevels = params.modelEffortTracker.getLevels();
    params.initialMode.modelEffortLevelsModelId = params.modelEffortTracker.getModelId();
    return currentModelId;
}

function buildPermissionLifecycleSessionHook(
    data: PermissionHookData,
    hookEventName: ClaudePermissionLifecycleHookEventName,
): SessionHookData {
    return {
        ...data,
        hook_event_name: hookEventName,
        hookEventName,
    };
}

function routeClaudeSessionHookAtCallerBoundary(params: Readonly<{
    session: Pick<import('./session').Session, 'onSessionFound' | 'onClaudeSessionHook'>;
    sessionId: string;
    data: SessionHookData;
    unifiedTerminalEnabled: boolean;
}>): void {
    // Unified installs a replayable hook subscription before launching Claude. Its transcript/runtime
    // owner validates explicit resume identity before persisting it; global ingress only publishes the
    // hook. Legacy launchers retain their historical direct discovery behavior.
    if (!params.unifiedTerminalEnabled) {
        params.session.onSessionFound(params.sessionId, params.data);
    }
    params.session.onClaudeSessionHook(params.data);
}

/** JavaScript runtime to use for spawning Claude Code */
export type JsRuntime = 'node' | 'bun'

export interface StartOptions {
    model?: string
    modelId?: string
    modelUpdatedAt?: number
    permissionMode?: PermissionMode
    agentModeId?: string
    agentModeUpdatedAt?: number
        startingMode?: 'local' | 'remote'
        shouldStartDaemon?: boolean
        claudeArgs?: string[]
        startedBy?: 'daemon' | 'terminal'
        /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
        jsRuntime?: JsRuntime
        /** Internal terminal runtime flags passed by the spawner (daemon/tmux wrapper). */
    terminalRuntime?: TerminalRuntimeFlags | null
    /** Seed defaults for Claude remote-mode settings forwarded via message meta. */
    claudeRemoteMetaDefaults?: Record<string, unknown> | null
    /**
     * Optional timestamp for permissionMode (ms). Used to order explicit UI selections across devices.
     * When omitted, the runner falls back to local time when publishing a mode.
     */
    permissionModeUpdatedAt?: number
    /**
     * Existing Happy session ID to reconnect to.
     * When set, the CLI will connect to this session instead of creating a new one.
     * Used for resuming inactive sessions.
     */
    existingSessionId?: string
    /** Account settings snapshot for this runner (used for notification policy + seeds). */
    accountSettings?: import('@happier-dev/protocol').AccountSettings | null
}

type ClaudeStartupPhase =
    | 'runtime_overrides_init'
    | 'runtime_overrides_seed'
    | 'runtime_overrides_sync'
    | 'terminal_side_effects'
    | 'sdk_metadata_probe'
    | 'hook_server_start'
    | 'hook_settings_generate'
    | 'hook_plugin_generate';

type ClaudeStartupPhaseContext = Readonly<{
    sessionId: string;
    startedBy: StartOptions['startedBy'];
    startingMode: StartOptions['startingMode'];
    metadataVersion: number;
    terminalMode: string | null;
    terminalRequested: string | null;
}>;

async function runClaudeStartupPhase<T>(
    phase: ClaudeStartupPhase,
    context: ClaudeStartupPhaseContext,
    fn: () => T | Promise<T>,
): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        logger.debug('[START] Claude startup phase failed', {
            phase,
            ...context,
            cause: serializeAxiosErrorForLog(error),
        });
        throw error;
    }
}

type ClaudeBackendRunRuntimeActivityLifecycle = Readonly<{
    lifecycle: BackendRunRuntimeActivityLifecycle;
    activateProviderRuntime: (() => Promise<Readonly<{
        providerTasks: SessionRuntimeActivityContributionHandle;
        isCurrentRuntime: () => boolean;
    }>>) | null;
}>;

async function createClaudeBackendRunRuntimeActivityLifecycle(
    runtimeActivityApplicability: RuntimeActivityApplicability,
): Promise<ClaudeBackendRunRuntimeActivityLifecycle> {
    let providerTasks: SessionRuntimeActivityContributionHandle | null = null;
    const baseLifecycle = await createBackendRunRuntimeActivityLifecycle({
        runtimeActivityApplicability,
        ...(runtimeActivityApplicability === 'supported'
            ? {
                configureAgentRuntime: (contributionHandle: SessionRuntimeActivityContributionHandle) => {
                    providerTasks = contributionHandle;
                },
            }
            : {}),
        resolvePublisher: (sessionClient) => sessionClient.getRuntimeActivitySnapshotPublisher?.() ?? null,
    });
    if (runtimeActivityApplicability === 'supported' && !providerTasks) {
        await baseLifecycle.dispose();
        throw new Error('Claude runtime Activity contributors were not configured before sealing');
    }
    const bindingOwner = providerTasks
        ? createClaudeProviderRuntimeActivityBindingOwner(providerTasks)
        : null;
    const lifecycle: BackendRunRuntimeActivityLifecycle = Object.freeze({
        clientConfig: baseLifecycle.clientConfig,
        attachSession: baseLifecycle.attachSession,
        dispose: async () => {
            bindingOwner?.invalidate();
            await baseLifecycle.dispose();
        },
    });
    return {
        lifecycle,
        activateProviderRuntime: bindingOwner ? bindingOwner.activate : null,
    };
}

export async function runClaude(credentials: Credentials, options: StartOptions = {}): Promise<void> {
    const accountSettingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(credentials);
    logger.debug(`[CLAUDE] ===== CLAUDE MODE STARTING =====`);
    logger.debug(`[CLAUDE] This is the Claude agent, NOT Gemini`);
    
    const workingDirectory = resolveRequestedSessionDirectory();
    const sessionTag = randomUUID();

    // Log environment info at startup
    logger.debugLargeJson('[START] Happier process started', getEnvironmentInfo());
    logger.debug(`[START] Options: startedBy=${options.startedBy}, startingMode=${options.startingMode}`);

    // Validate daemon spawn requirements - fail fast on invalid config
    if (options.startedBy === 'daemon' && options.startingMode === 'local') {
        throw new Error('Daemon-spawned sessions cannot use local/interactive mode. Use --happy-starting-mode remote or spawn sessions directly from terminal.');
    }

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Claude');

    // Lane Q: resolve once; published as the `inFlightConfigApplySupported` capability so the UI
    // can offer "Apply setting & steer now" only when the unified runtime can own in-turn deltas.
    const claudeTuiRuntimeControlEnabled = resolveCliFeatureDecision({
        featureId: CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID,
        env: process.env,
    }).state === 'enabled';

    const startedBy = options.startedBy ?? 'terminal';
    const startingMode = options.startingMode ?? 'local';
    const initialClaudeRemoteMetaState = resolveInitialClaudeRemoteMetaState({ metaDefaults: options.claudeRemoteMetaDefaults });
    const existingSessionId =
        typeof options.existingSessionId === 'string' && options.existingSessionId.trim().length > 0
            ? options.existingSessionId.trim()
            : null;
    const attachEnvPath =
        typeof process.env.HAPPIER_SESSION_ATTACH_FILE === 'string' && process.env.HAPPIER_SESSION_ATTACH_FILE.trim().length > 0
            ? process.env.HAPPIER_SESSION_ATTACH_FILE.trim()
            : null;
    const inferredPermissionMode = inferPermissionIntentFromClaudeArgs(options.claudeArgs);
    const canFastStartAttach = Boolean(
        existingSessionId &&
        attachEnvPath &&
        (typeof options.permissionMode === 'string' || inferredPermissionMode !== null),
    );
    const shouldUseFastStart =
        startedBy === 'terminal'
        && startingMode === 'local'
        && initialClaudeRemoteMetaState.claudeUnifiedTerminalEnabled !== true
        && (!existingSessionId || canFastStartAttach);

    if (typeof process.versions.bun === 'string') {
        await ensureManagedJavaScriptRuntimeCommand(process.env);
    }

    if (shouldUseFastStart) {
        await runClaudeLocalFastStart(credentials, options);
        return;
    }

    const { api, machineId } = await initializeBackendApiContext({
        credentials,
        machineMetadata: initialMachineMetadata,
        missingMachineIdMessage:
            '[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/happier-dev/happier/issues',
        // Daemon-spawned sessions must skip registration; terminal sessions should also skip
        // when a daemon is already alive to avoid duplicate /v1/machines contention.
        skipMachineRegistration: options.startedBy === 'daemon',
    });
    logger.debug(`Using machineId: ${machineId}`);
    const attachMetadataIdentityPolicy =
        existingSessionId
            ? readSessionAttachMetadataIdentityPolicyFromEnv()
            : null;

    const terminal = buildTerminalMetadataFromRuntimeFlags(options.terminalRuntime ?? null);
    // Resolve initial permission mode for sessions that start in terminal local mode.
    // This is important because there may be no app-sent user messages yet (no meta.permissionMode to infer from).
    const explicitPermissionMode = options.permissionMode;
    const explicitPermissionModeUpdatedAt = options.permissionModeUpdatedAt;
    const accountSettings = options.accountSettings ?? null;
    const permissionModeSeed = resolvePermissionModeSeedForAgentStart({
        agentId: 'claude',
        explicitPermissionMode,
        inferredPermissionMode: inferPermissionIntentFromClaudeArgs(options.claudeArgs),
        accountSettings,
    });
    const initialPermissionMode = permissionModeSeed.mode;
    options.permissionMode = initialPermissionMode;

    const explicitModelId = typeof options.modelId === 'string' ? options.modelId.trim() : (typeof options.model === 'string' ? options.model.trim() : '');
    const initialModelId = explicitModelId ? explicitModelId : undefined;
    const initialModelUpdatedAt =
        typeof options.modelUpdatedAt === 'number'
            ? options.modelUpdatedAt
            : initialModelId
                ? Date.now()
                : 0;
    if (initialModelId) {
        options.model = initialModelId;
        options.modelId = initialModelId;
        options.modelUpdatedAt = initialModelUpdatedAt;
    }

    const { state, metadata } = createSessionMetadata({
        flavor: 'claude',
        machineId,
        directory: workingDirectory,
        startedBy: options.startedBy,
        terminalRuntime: options.terminalRuntime ?? null,
        permissionMode: initialPermissionMode,
        permissionModeUpdatedAt: typeof explicitPermissionModeUpdatedAt === 'number' ? explicitPermissionModeUpdatedAt : Date.now(),
        agentModeId: options.agentModeId,
        agentModeUpdatedAt: options.agentModeUpdatedAt,
        modelId: initialModelId,
        modelUpdatedAt: initialModelUpdatedAt,
    });

    // Let the daemon track externally started terminal sessions immediately, even if
    // upstream session creation is delayed. A later report with the real session id
    // will reconcile the tracked session record.
    if (options.startedBy === 'terminal') {
        void reportSessionToDaemonIfRunning({ sessionId: `PID-${process.pid}`, metadata }).catch((error) => {
            logger.debug('[claude] Initial terminal PID daemon report failed (non-fatal)', error);
        });
    }

    // Handle existing session (for inactive session resume) vs new session.
    let baseSession: ApiSession;
    if (options.existingSessionId) {
        logger.debug(`[START] Resuming existing session: ${options.existingSessionId}`);
        baseSession = await createBaseSessionForAttach({
            existingSessionId: options.existingSessionId,
            metadata,
            state,
        });
    } else {
        const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

        // Handle server unreachable case - run Claude locally with hot reconnection
        // Note: connectionState.notifyOffline() was already called by api.ts with error details
            if (!response) {
            if (initialClaudeRemoteMetaState.claudeUnifiedTerminalEnabled === true) {
                await runClaudeLocalFastStart(credentials, options);
                return;
                }

            const runtimeActivity = await createClaudeBackendRunRuntimeActivityLifecycle('unavailable');
            let offlineSessionId: string | null = null;

            const reconnection = startOfflineReconnection({
                serverUrl: configuration.serverUrl,
                onReconnected: async () => {
                    const resp = await api.getOrCreateSession({ tag: randomUUID(), metadata, state });
                    if (!resp) throw new Error('Server unavailable');
                    const session = api.sessionSyncClient(resp, runtimeActivity.lifecycle.clientConfig());
                    await runtimeActivity.lifecycle.attachSession(session);
                    const turnDiffBridge = createClaudeRawMessageTurnDiffBridge({
                        getSessionId: () => session.sessionId ?? 'unknown',
                        sendMessage: (message) => {
                            session.sendClaudeSessionMessage(message);
                        },
                    });
                    const scanner = await createSessionScanner({
                        sessionId: null,
                        workingDirectory,
                        onMessage: (msg) => {
                            const bridged = turnDiffBridge.observe(msg);
                            if (bridged) {
                                session.sendClaudeSessionMessage(bridged);
                                turnDiffBridge.flushAfterForwardIfNeeded();
                            }
                        },
                    });
                    if (offlineSessionId) scanner.onNewSession(offlineSessionId);
                    return { session, scanner };
                },
                onNotify: console.log,
                onCleanup: () => {
                    // Scanner cleanup handled automatically when process exits
                }
            });

            const abortController = new AbortController();
            const abortOnSignal = () => abortController.abort();
            process.once('SIGINT', abortOnSignal);
            process.once('SIGTERM', abortOnSignal);

            try {
                            const offlineSystemPromptText = await resolveEffectiveCodingPromptText({
                                credentials,
                                settings: options.accountSettings ?? null,
                                profileId: null,
                                executionRunsFeatureEnabled: resolveCliFeatureDecision({
                                    featureId: 'execution.runs',
                                    env: process.env,
                                }).state === 'enabled',
                                providerId: 'claude',
                            });
                            await claudeLocal({
                                path: workingDirectory,
                                sessionId: null,
                                onSessionFound: (id) => { offlineSessionId = id; },
                                onThinkingChange: () => {},
                                abort: abortController.signal,
                                claudeArgs: options.claudeArgs,
                                systemPromptText: offlineSystemPromptText,
                            });
                    } finally {
                process.removeListener('SIGINT', abortOnSignal);
                process.removeListener('SIGTERM', abortOnSignal);
                reconnection.cancel();
                await runtimeActivity.lifecycle.dispose();
                stopCaffeinate();
            }
            process.exit(0);
        }

        baseSession = response;
        logger.debug(`Session created: ${baseSession.id}`);
    }

    // Create realtime session
    const runtimeActivity = await createClaudeBackendRunRuntimeActivityLifecycle('supported');
    try {
    const activateProviderTaskRuntimeActivity = runtimeActivity.activateProviderRuntime;
    if (!activateProviderTaskRuntimeActivity) {
        throw new Error('Claude runtime Activity producer binding was not configured');
    }
    const session = api.sessionSyncClient(baseSession, runtimeActivity.lifecycle.clientConfig());
    await runtimeActivity.lifecycle.attachSession(session);
    const defaultSystemPromptText = await resolveEffectiveCodingPromptText({
        credentials,
        settings: options.accountSettings ?? null,
        profileId: session.getMetadataSnapshot()?.profileId ?? null,
        executionRunsFeatureEnabled: resolveCliFeatureDecision({
            featureId: 'execution.runs',
            env: process.env,
        }).state === 'enabled',
        providerId: 'claude',
    });
    // A terminal-started runner needs early daemon discovery because the daemon did
    // not launch or track it. A daemon-started runner is already tracked by PID and
    // reports exactly once through the strict readiness boundary after its runtime
    // controls exist; an earlier best-effort report would create a competing retry
    // loop with incomplete application capability.
    if (options.startedBy !== 'daemon') {
        void reportSessionToDaemonIfRunning({ sessionId: baseSession.id, metadata }).catch((error) => {
            logger.debug('[claude] Initial daemon session report failed (non-fatal)', error);
        });
    }

    // Mark the session as active and refresh metadata on startup.
    // For attach flows, wait for the persisted metadata snapshot before writing startup updates
    // to avoid overwriting the session's canonical workspace path with local defaults.
    if (baseSession.metadataVersion < 0) {
        let snapshot: unknown = null;
        let snapshotError: unknown = null;
        try {
            snapshot = await session.ensureMetadataSnapshot({ timeoutMs: 30_000 });
        } catch (error) {
            snapshotError = error;
        }
        if (!snapshot) {
            logger.debug(
                '[claude] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)',
                snapshotError ?? undefined,
            );
        } else {
            await applyStartupMetadataUpdateToSession({
                session,
                next: metadata,
                nowMs: Date.now(),
                permissionModeOverride: buildPermissionModeOverride({
                    permissionMode: explicitPermissionMode,
                    permissionModeUpdatedAt: explicitPermissionModeUpdatedAt,
                }),
                modelOverride: buildModelOverride({
                    modelId: initialModelId,
                    modelUpdatedAt: initialModelUpdatedAt,
                }),
                attachMetadataIdentityPolicy,
                mode: 'attach',
            });
        }
    } else {
        await applyStartupMetadataUpdateToSession({
            session,
            next: metadata,
            nowMs: Date.now(),
            permissionModeOverride: buildPermissionModeOverride({
                permissionMode: explicitPermissionMode,
                permissionModeUpdatedAt: explicitPermissionModeUpdatedAt,
            }),
            modelOverride: buildModelOverride({
                modelId: initialModelId,
                modelUpdatedAt: initialModelUpdatedAt,
            }),
            mode: 'start',
        });
    }

    let currentPermissionMode: PermissionMode = options.permissionMode ?? 'default';
    let currentModel = options.model; // Track current model state
    let currentModelUpdatedAt = typeof options.modelUpdatedAt === 'number' ? options.modelUpdatedAt : 0;
    const startupPhaseContext: ClaudeStartupPhaseContext = {
        sessionId: baseSession.id,
        startedBy: options.startedBy,
        startingMode: options.startingMode,
        metadataVersion: baseSession.metadataVersion,
        terminalMode: terminal?.mode ?? null,
        terminalRequested: terminal?.requested ?? null,
    };

    {
        const permissionModeRef = {
            current: options.permissionMode ?? 'default',
            updatedAt: typeof options.permissionModeUpdatedAt === 'number' ? options.permissionModeUpdatedAt : 0,
        };
        const modelOverrideRef = { current: initialModelId ?? null, updatedAt: initialModelUpdatedAt };

        const overridesSync = await runClaudeStartupPhase('runtime_overrides_init', startupPhaseContext, () =>
            initializeRuntimeOverridesSynchronizer({
                explicitPermissionMode: typeof explicitPermissionMode === 'string' ? (explicitPermissionMode as PermissionMode) : undefined,
                sessionKind:
                    typeof options.existingSessionId === 'string' && options.existingSessionId.trim().length > 0 ? 'attach' : 'fresh',
                take: configuration.startupPermissionSeedTranscriptTake,
                session: {
                    getMetadataSnapshot: () => session.getMetadataSnapshot(),
                    fetchLatestUserPermissionIntentFromTranscript: (args) => session.fetchLatestUserPermissionIntentFromTranscript(args),
                },
                permissionMode: permissionModeRef,
                modelOverride: modelOverrideRef,
                onPermissionModeApplied: () => {
                    options.permissionMode = permissionModeRef.current;
                    options.permissionModeUpdatedAt = permissionModeRef.updatedAt;
                    currentPermissionMode = permissionModeRef.current;
                },
                onModelOverrideApplied: () => {
                    if (initialModelId) return;
                    options.modelId = modelOverrideRef.current ?? undefined;
                    options.model = modelOverrideRef.current ?? undefined;
                    options.modelUpdatedAt = modelOverrideRef.updatedAt;
                    currentModel = modelOverrideRef.current ?? undefined;
                    currentModelUpdatedAt = modelOverrideRef.updatedAt;
                },
            }),
        );

        // If the user did not explicitly choose a permission mode for this CLI process, prefer the canonical
        // session metadata snapshot (and, for attach flows, transcript-derived recovery). This is essential for:
        // - UI apply timing = next_prompt (metadata already set, message meta absent)
        // - local ↔ remote switching without losing the selected permission policy
        await runClaudeStartupPhase('runtime_overrides_seed', startupPhaseContext, () => overridesSync.seedFromSession());
        await runClaudeStartupPhase('runtime_overrides_sync', startupPhaseContext, () => {
            overridesSync.syncFromMetadata();
        });
        try {
            const snapshot = overridesSync.getSnapshot();
            writeStartupOverridesCacheForBackend({
                backendId: 'claude',
                permissionMode: snapshot.permissionMode.current,
                permissionModeUpdatedAt: snapshot.permissionMode.updatedAt,
                modelId: snapshot.modelOverride.current,
                modelUpdatedAt: snapshot.modelOverride.updatedAt,
                updatedAt: Date.now(),
            });
        } catch {
            // ignore
        }
        }

    let currentClaudeRemoteMetaState = resolveInitialClaudeRemoteMetaState({ metaDefaults: options.claudeRemoteMetaDefaults });
    const sessionRuntimeModeKind = normalizeClaudeRemoteMode(currentClaudeRemoteMetaState).kind;
    const unifiedTerminalRuntimeActive = sessionRuntimeModeKind === 'unifiedTerminal';
    const adoptEndpointRecovery = unifiedTerminalRuntimeActive
        ? await resolveClaudeAdoptEndpointRecovery({
            ...(currentClaudeRemoteMetaState.claudeLocalPermissionBridgeWaitIndefinitely === true
                ? {}
                : { permissionHookTimeoutSeconds: currentClaudeRemoteMetaState.claudeLocalPermissionBridgeTimeoutSeconds }),
        })
        : null;
    if (
        unifiedTerminalRuntimeActive
        && hasClaudeEndpointRecoveryRequest()
        && !adoptEndpointRecovery
    ) {
        throw Object.assign(
            new Error('Claude exact terminal attachment recovery proof is invalid; retained hook artifacts were not replaced'),
            { code: 'claude_endpoint_recovery_invalid' as const },
        );
    }

    await runClaudeStartupPhase('terminal_side_effects', startupPhaseContext, async () => {
        await persistTerminalAttachmentInfoIfNeeded({ sessionId: baseSession.id, terminal });
        sendTerminalFallbackMessageIfNeeded({ session, terminal });
    });

    // Extract SDK metadata in background and update session when ready
    await runClaudeStartupPhase('sdk_metadata_probe', startupPhaseContext, () => {
        extractSDKMetadataAsync(async (sdkMetadata) => {
            logger.debug('[start] SDK metadata extracted, updating session:', sdkMetadata);
            updateMetadataBestEffort(
                session,
                (currentMetadata) => ({
                    ...currentMetadata,
                    tools: sdkMetadata.tools,
                    slashCommands: sdkMetadata.slashCommands,
                }),
                '[claude]',
                'sdk_metadata',
            );
        });
    });

    // Variable to track current session instance (updated via onSessionReady callback)
    // Used by hook server to notify Session when Claude changes session ID
    let currentSession: import('./session').Session | null = null;
    let didPublishSessionModelsMetadata = false;
    const resolveClaudeHelpProbeTimeoutMs = (): number => {
        const raw = process.env.HAPPIER_CLAUDE_HELP_PROBE_TIMEOUT_MS;
        const parsed = typeof raw === 'string' ? Number(raw) : Number.NaN;
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
        return process.env.CI ? 3_000 : 1_500;
    };
    const installedRuntimeCapabilities = await probeClaudeInstalledRuntimeCapabilities({
        cwd: workingDirectory,
        timeoutMs: resolveClaudeHelpProbeTimeoutMs(),
    });
    let localPermissionBridgeEnabled = currentClaudeRemoteMetaState.claudeLocalPermissionBridgeEnabled === true;
    let localPermissionBridgeWaitIndefinitely = currentClaudeRemoteMetaState.claudeLocalPermissionBridgeWaitIndefinitely === true;
    let localPermissionBridgeTimeoutMs = localPermissionBridgeWaitIndefinitely
        ? null
        : currentClaudeRemoteMetaState.claudeLocalPermissionBridgeTimeoutSeconds * 1000;
    const permissionHookSecret = adoptEndpointRecovery?.permissionHookSecret ?? randomUUID();
    let localPermissionBridge: ClaudeLocalPermissionBridge | null = null;
    const disposeLocalPermissionBridge = () => {
        const bridge: ClaudeLocalPermissionBridge | null = localPermissionBridge;
        bridge?.dispose();
    };
    const rebuildLocalPermissionBridge = () => {
        if (!currentSession) {
            return;
        }
        disposeLocalPermissionBridge();
        if (!localPermissionBridgeEnabled) {
            localPermissionBridge = null;
            return;
        }
        localPermissionBridge = new ClaudeLocalPermissionBridge(currentSession, { responseTimeoutMs: localPermissionBridgeTimeoutMs });
        localPermissionBridge.activate();
    };
    const publishPermissionLifecycleHook = (
        data: PermissionHookData,
        hookEventName: ClaudePermissionLifecycleHookEventName,
    ) => {
        currentSession?.onClaudeSessionHook(buildPermissionLifecycleSessionHook(data, hookEventName));
    };

    // Start Hook server for receiving Claude session notifications
    const statuslineApplier = createClaudeStatuslineApplier({ logPrefix: '[claude]' });
    const hookServerOptions: Parameters<typeof startHookServer>[0] = {
        onStatuslineUpdate: (payload) => {
            if (currentSession) {
                statuslineApplier.apply(currentSession, payload);
            }
        },
        onSessionHook: (sessionId, data) => {
            logger.debug(`[START] Session hook received: ${sessionId}`, data);
            
            // Update session ID in the Session instance
            if (currentSession) {
                const previousSessionId = currentSession.sessionId;
                if (previousSessionId !== sessionId) {
                    logger.debug(`[START] Claude session ID changed: ${previousSessionId} -> ${sessionId}`);
                }
                routeClaudeSessionHookAtCallerBoundary({
                    session: currentSession,
                    sessionId,
                    data,
                    unifiedTerminalEnabled: unifiedTerminalRuntimeActive,
                });
                localPermissionBridge?.handleSessionHook(data);
            }
        },
        onPermissionHook: async (data) => {
            const hookTool = typeof (data as any)?.tool_name === 'string'
                ? (data as any).tool_name
                : (typeof (data as any)?.toolName === 'string' ? (data as any).toolName : 'unknown_tool');
            const hookId = typeof (data as any)?.tool_use_id === 'string'
                ? (data as any).tool_use_id
                : (typeof (data as any)?.toolUseId === 'string' ? (data as any).toolUseId : '');
            logger.debug(
                `[START] Permission hook received: tool=${hookTool} id=${hookId || 'unknown'} bridge=${localPermissionBridgeEnabled ? 'enabled' : 'disabled'}`,
            );
            publishPermissionLifecycleHook(data, 'PermissionRequest');
            try {
                if (!localPermissionBridgeEnabled || !localPermissionBridge) {
                    return DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE;
                }
                return localPermissionBridge.handlePermissionHook(data);
            } finally {
                publishPermissionLifecycleHook(data, 'PermissionRequestCompleted');
            }
        },
        permissionHookSecret,
        permissionRequestTimeoutMs: localPermissionBridgeWaitIndefinitely ? null : localPermissionBridgeTimeoutMs,
        ...(adoptEndpointRecovery ? { requestedPort: adoptEndpointRecovery.state.hookServerPort } : {}),
    };
    const hookServer = await runClaudeStartupPhase('hook_server_start', startupPhaseContext, () =>
        startHookServer(hookServerOptions),
    );
    logger.debug(`[START] Hook server started on port ${hookServer.port}`);

    // Generate hook artifacts for Claude:
    //  - settings file carries non-hook config (permissions.allow for mcp__happier__change_title*)
    //  - plugin dir carries SessionStart + PermissionRequest hooks via --plugin-dir
    // Split because Claude Code's --settings is non-composable for hooks (first --settings wins
    // when multiple wrappers inject their own), whereas --plugin-dir is additive.
    const hookSettingsPath = adoptEndpointRecovery?.state.hookSettingsPath
        ?? await runClaudeStartupPhase('hook_settings_generate', startupPhaseContext, () =>
            generateHookSettingsFileWithEnsuredRuntime(hookServer.port, {
                enableLocalPermissionBridge: true,
                permissionHookSecret,
            }),
        );
    logger.debug(`[START] Generated hook settings file: ${hookSettingsPath}`);
    const hookPluginDir = adoptEndpointRecovery?.state.hookPluginDir
        ?? await runClaudeStartupPhase('hook_plugin_generate', startupPhaseContext, () =>
            generateHookPluginDirWithEnsuredRuntime(hookServer.port, {
                enableLocalPermissionBridge: true,
                permissionHookSecret,
                sessionHookPluginId: baseSession.id,
                // Keep the provider-side permission hook ceiling aligned with the local permission bridge's
                // own response timeout source so non-default configured timeouts do not silently fall back to
                // Claude's undocumented default. Wait-indefinitely mode keeps the generateHookSettings default.
                ...(localPermissionBridgeWaitIndefinitely
                    ? {}
                    : { permissionHookTimeoutSeconds: currentClaudeRemoteMetaState.claudeLocalPermissionBridgeTimeoutSeconds }),
            }),
        );
    if (hookPluginDir) {
        logger.debug(`[START] Generated hook plugin dir: ${hookPluginDir}`);
    } else {
        logger.debug('[START] Hook plugin dir generation skipped (HAPPIER_CLAUDE_HOOKS_DISABLED)');
    }
    let userMessageHandlerReady = false;

    // Print log file path
    const logPath = logger.logFilePath;
    logger.infoDeveloper(`Session: ${baseSession.id}`);
    logger.infoDeveloper(`Logs: ${logPath}`);

    // Set initial agent state (best-effort; failure is non-fatal).
    updateAgentStateBestEffort(
        session,
        (currentState) => buildClaudeAgentState({
            currentState,
            mode: startingMode === 'remote' ? 'remote' : 'local',
            claudeUnifiedTerminalEnabled: unifiedTerminalRuntimeActive,
            tuiRuntimeControlEnabled: claudeTuiRuntimeControlEnabled,
            localPermissionBridgeEnabled,
            userMessageHandlerReady,
        }),
        '[claude]',
        'initial_agent_state',
    );

    // Start caffeinate to prevent sleep on macOS
    const caffeinateStarted = shouldStartClaudeSessionCaffeinate(options.startedBy) ? startCaffeinate() : false;
    if (caffeinateStarted) {
        logger.infoDeveloper('Sleep prevention enabled (macOS)');
    }

    // Import MessageQueue2 and create message queue
    const messageQueue = new MessageQueue2<EnhancedMode>(hashClaudeEnhancedModeForQueue);

    // Forward messages to the queue
    // Permission modes: Use the unified 7-mode type, mapping happens at SDK boundary in claudeRemote.ts
    let currentAgentModeId: string | null =
        typeof options.agentModeId === 'string' && options.agentModeId.trim().length > 0 ? options.agentModeId.trim() : null;
    let currentAgentModeUpdatedAt = typeof options.agentModeUpdatedAt === 'number' ? options.agentModeUpdatedAt : 0;
        let currentReasoningEffort: string | undefined = undefined;
        let currentReasoningEffortUpdatedAt = 0;
        // Effort tiers the selected model reports. Resolved from the shared Claude model catalog
        // (cached, best-effort) and carried on the mode so spawn-time resolution and launch-option
        // hashing both see the same value instead of reading a cache at hash time.
        const modelEffortTracker = createClaudeModelEffortLevelsTracker({
            resolveTimeoutMs: () => resolveClaudeHelpProbeTimeoutMs(),
        });
        let currentUltracode: boolean | undefined = undefined;
        let currentUltracodeUpdatedAt = 0;
        let currentFallbackModel: string | undefined = undefined; // Track current fallback model
        let currentCustomSystemPrompt: string | undefined = undefined; // Track current custom system prompt
        let currentAppendSystemPrompt: string | undefined = resolveInitialClaudeSystemPromptText({
            existingSessionId,
            defaultSystemPromptText,
        }); // Track current append system prompt
        session.onUserMessage(async (message, deliveryInfo) => {
        const adoptedModel = adoptModelOverrideFromMetadata({
            currentModelId: currentModel,
            currentUpdatedAt: currentModelUpdatedAt,
            metadata: session.getMetadataSnapshot(),
        });
        if (adoptedModel.didChange) {
            currentModel = adoptedModel.modelId;
            currentModelUpdatedAt = adoptedModel.updatedAt;
            logger.debug(`[loop] Model updated from session metadata: ${adoptedModel.modelId || 'reset to default'}`);
        }

        const resolvedAgentModeOverride = resolveSessionModeOverrideFromMetadataSnapshot({
            metadata: session.getMetadataSnapshot(),
        });
        if (resolvedAgentModeOverride && resolvedAgentModeOverride.updatedAt > currentAgentModeUpdatedAt) {
            currentAgentModeUpdatedAt = resolvedAgentModeOverride.updatedAt;
            const normalizedModeId = resolvedAgentModeOverride.modeId.trim();
            currentAgentModeId = normalizedModeId.length > 0 ? normalizedModeId : null;
            logger.debug(`[loop] Agent mode updated from session metadata: ${currentAgentModeId ?? 'default'}`);
        }

        const adoptedReasoningEffort = adoptReasoningEffortOverrideFromMetadata({
            currentValueId: currentReasoningEffort ?? null,
            currentUpdatedAt: currentReasoningEffortUpdatedAt,
            metadata: session.getMetadataSnapshot(),
        });
        if (adoptedReasoningEffort.didChange) {
            currentReasoningEffort = adoptedReasoningEffort.valueId ?? undefined;
            currentReasoningEffortUpdatedAt = adoptedReasoningEffort.updatedAt;
            logger.debug(`[loop] Thinking updated from session metadata: ${currentReasoningEffort || 'default'}`);
        }

        const adoptedReasoningEffortFromMessage = adoptReasoningEffortOverrideFromMessageMeta({
            currentValueId: currentReasoningEffort ?? null,
            currentUpdatedAt: currentReasoningEffortUpdatedAt,
            messageMeta: message.meta as Record<string, unknown> | null | undefined,
            updatedAt:
                typeof message.createdAt === 'number' && Number.isFinite(message.createdAt) && message.createdAt > 0
                    ? message.createdAt
                    : Date.now(),
        });
        if (adoptedReasoningEffortFromMessage.didChange) {
            currentReasoningEffort = adoptedReasoningEffortFromMessage.valueId ?? undefined;
            currentReasoningEffortUpdatedAt = adoptedReasoningEffortFromMessage.updatedAt;
            logger.debug(`[loop] Thinking updated from user message: ${currentReasoningEffort || 'default'}`);
        }

        const adoptedUltracode = adoptUltracodeOverrideFromMetadata({
            currentValue: currentUltracode ?? null,
            currentUpdatedAt: currentUltracodeUpdatedAt,
            metadata: session.getMetadataSnapshot(),
        });
        if (adoptedUltracode.didChange) {
            currentUltracode = adoptedUltracode.value ?? undefined;
            currentUltracodeUpdatedAt = adoptedUltracode.updatedAt;
            logger.debug(`[loop] Ultracode updated from session metadata: ${currentUltracode === true ? 'on' : 'off'}`);
        }

        const adoptedUltracodeFromMessage = adoptUltracodeOverrideFromMessageMeta({
            currentValue: currentUltracode ?? null,
            currentUpdatedAt: currentUltracodeUpdatedAt,
            messageMeta: message.meta as Record<string, unknown> | null | undefined,
            updatedAt:
                typeof message.createdAt === 'number' && Number.isFinite(message.createdAt) && message.createdAt > 0
                    ? message.createdAt
                    : Date.now(),
        });
        if (adoptedUltracodeFromMessage.didChange) {
            currentUltracode = adoptedUltracodeFromMessage.value ?? undefined;
            currentUltracodeUpdatedAt = adoptedUltracodeFromMessage.updatedAt;
            logger.debug(`[loop] Ultracode updated from user message: ${currentUltracode === true ? 'on' : 'off'}`);
        }

        // Resolve permission mode from meta - pass through as-is, mapping happens at SDK boundary
        let messagePermissionMode: PermissionMode | undefined = currentPermissionMode;
        if (message.meta?.permissionMode) {
            messagePermissionMode = message.meta.permissionMode;
            currentPermissionMode = messagePermissionMode;
            logger.debug(`[loop] Permission mode updated from user message to: ${currentPermissionMode}`);
        } else {
            logger.debug(`[loop] User message received with no permission mode override, using current: ${currentPermissionMode}`);
        }

        // Resolve model - use message.meta.model if provided, otherwise use current model
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined; // null becomes undefined
            currentModel = messageModel;
            currentModelUpdatedAt =
                typeof message.createdAt === 'number' && Number.isFinite(message.createdAt) && message.createdAt > 0
                    ? message.createdAt
                    : Date.now();
            logger.debug(`[loop] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[loop] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        // Resolve custom system prompt - use message.meta.customSystemPrompt if provided, otherwise use current
        let messageCustomSystemPrompt = currentCustomSystemPrompt;
        if (message.meta?.hasOwnProperty('customSystemPrompt')) {
            messageCustomSystemPrompt = message.meta.customSystemPrompt || undefined; // null becomes undefined
            currentCustomSystemPrompt = messageCustomSystemPrompt;
            logger.debug(`[loop] Custom system prompt updated from user message: ${messageCustomSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no custom system prompt override, using current: ${currentCustomSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve fallback model - use message.meta.fallbackModel if provided, otherwise use current fallback model
        let messageFallbackModel = currentFallbackModel;
        if (message.meta?.hasOwnProperty('fallbackModel')) {
            messageFallbackModel = message.meta.fallbackModel || undefined; // null becomes undefined
            currentFallbackModel = messageFallbackModel;
            logger.debug(`[loop] Fallback model updated from user message: ${messageFallbackModel || 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no fallback model override, using current: ${currentFallbackModel || 'none'}`);
        }

        // Resolve append system prompt - use message.meta.appendSystemPrompt if provided, otherwise use current
        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        if (message.meta?.hasOwnProperty('appendSystemPrompt')) {
            messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined; // null becomes undefined
            currentAppendSystemPrompt = messageAppendSystemPrompt;
            logger.debug(`[loop] Append system prompt updated from user message: ${messageAppendSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
        }

            currentClaudeRemoteMetaState = applyClaudeRemoteMetaState(currentClaudeRemoteMetaState, message.meta);
        const nextLocalPermissionBridgeEnabled = currentClaudeRemoteMetaState.claudeLocalPermissionBridgeEnabled === true;
        const nextLocalPermissionBridgeWaitIndefinitely = currentClaudeRemoteMetaState.claudeLocalPermissionBridgeWaitIndefinitely === true;
        const nextLocalPermissionBridgeTimeoutMs = nextLocalPermissionBridgeWaitIndefinitely
            ? null
            : currentClaudeRemoteMetaState.claudeLocalPermissionBridgeTimeoutSeconds * 1000;

        if (
            nextLocalPermissionBridgeEnabled !== localPermissionBridgeEnabled
            || nextLocalPermissionBridgeWaitIndefinitely !== localPermissionBridgeWaitIndefinitely
            || nextLocalPermissionBridgeTimeoutMs !== localPermissionBridgeTimeoutMs
        ) {
            localPermissionBridgeEnabled = nextLocalPermissionBridgeEnabled;
            localPermissionBridgeWaitIndefinitely = nextLocalPermissionBridgeWaitIndefinitely;
            localPermissionBridgeTimeoutMs = nextLocalPermissionBridgeTimeoutMs;
            hookServerOptions.permissionRequestTimeoutMs = localPermissionBridgeWaitIndefinitely ? null : localPermissionBridgeTimeoutMs;
            logger.debug(`[loop] Local permission bridge updated from user message: enabled=${localPermissionBridgeEnabled ? 'yes' : 'no'} timeoutMs=${localPermissionBridgeTimeoutMs === null ? 'infinite' : String(localPermissionBridgeTimeoutMs)}`);
            rebuildLocalPermissionBridge();
            updateAgentStateBestEffort(
                session,
                (currentState) => buildClaudeAgentState({
                    currentState,
                    mode: currentState.controlledByUser === true ? 'local' : 'remote',
                    claudeUnifiedTerminalEnabled: unifiedTerminalRuntimeActive,
                    tuiRuntimeControlEnabled: claudeTuiRuntimeControlEnabled,
                    localPermissionBridgeEnabled,
                    userMessageHandlerReady,
                }),
                '[claude]',
                'local_permission_bridge_mode_change',
            );
        }

        const structuredRouting = resolveClaudeStructuredUserMessageRouting({
            text: message.content.text,
            meta: message.meta,
        });

        // Resolve the selected model's effort tiers before the mode is built. Leaving this to a
        // fire-and-forget refresh dropped `--effort` and ultracode for the first turn after any
        // model change. Bounded, because SessionClient awaits this callback as part of the pending
        // queue handoff: a cold catalog must not hold the queue behind a network fetch.
        await modelEffortTracker.refreshWithin(currentModel);

        // Push with resolved permission mode, model, system prompts, and tools
        const enhancedMode: EnhancedMode = resolveClaudeInstalledRuntimeSessionMode({
            permissionMode: messagePermissionMode || 'default',
            agentModeId: currentAgentModeId,
            replaySeedAllowed: structuredRouting ? true : parseSpecialCommand(message.content.text).type === null,
            localId: message.localId ?? null,
            model: messageModel,
            fallbackModel: messageFallbackModel,
            customSystemPrompt: messageCustomSystemPrompt,
            appendSystemPrompt: messageAppendSystemPrompt,
            modelEffortLevels: modelEffortTracker.getLevels(),
            modelEffortLevelsModelId: modelEffortTracker.getModelId(),
            reasoningEffort: currentReasoningEffort,
            ultracode: currentUltracode,
            ...currentClaudeRemoteMetaState,
        }, installedRuntimeCapabilities);

        const baseQueuedText = structuredRouting?.queuedText ?? message.content.text;
        const deliveryAttribution = {
            userMessageSeq: deliveryInfo?.seq ?? null,
            userMessageLocalId: message.localId ?? null,
            providerAcceptancePending: deliveryInfo?.providerAcceptancePending === true,
            ...(deliveryInfo?.pendingProviderAction ? { pendingProviderAction: deliveryInfo.pendingProviderAction } : {}),
        };

        // Structured Happier user messages must be treated as plain text (no special command parsing).
        if (!structuredRouting) {
            const specialCommand = parseSpecialCommand(message.content.text);

            if (specialCommand.type === 'compact') {
                logger.debug('[start] Detected /compact command');
                messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, enhancedMode, deliveryAttribution);
                logger.debugLargeJson('[start] /compact command pushed to queue:', message);
                return;
            }

            if (specialCommand.type === 'clear') {
                logger.debug('[start] Detected /clear command');
                messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, enhancedMode, deliveryAttribution);
                logger.debugLargeJson('[start] /clear command pushed to queue:', message);
                return;
            }
        }

        if (deliveryInfo?.pendingProviderAction) {
            messageQueue.unshift(baseQueuedText, enhancedMode, deliveryAttribution);
        } else {
            messageQueue.push(baseQueuedText, enhancedMode, deliveryAttribution);
        }
        logger.debugLargeJson('User message pushed to queue:', message)
    });
    userMessageHandlerReady = true;
    updateAgentStateBestEffort(
        session,
        (currentState) => buildClaudeAgentState({
            currentState,
            mode: currentState.controlledByUser === true ? 'local' : 'remote',
            claudeUnifiedTerminalEnabled: unifiedTerminalRuntimeActive,
            tuiRuntimeControlEnabled: claudeTuiRuntimeControlEnabled,
            localPermissionBridgeEnabled,
            userMessageHandlerReady,
        }),
        '[claude]',
        'user_message_handler_ready',
    );

    let activeLoopAbortController: AbortController | null = null;
    let activeLoopPromise: Promise<number> | null = null;
    let activeLoopShouldWaitOnTermination = false;
    let endpointArtifactsOwnedByAttachment = adoptEndpointRecovery !== null;
    let destroyOwnedHostForExplicitStop: (() => Promise<void>) | null = null;

    // Setup signal handlers for graceful shutdown and crash reporting.
    const cleanup = async (event: RunnerTerminationEvent, outcome: ReturnType<typeof computeRunnerTerminationOutcome>) => {
        const archiveDecision = resolveTerminationArchiveDecision({
            startedBy: options.startedBy,
            event,
            outcome,
        });
        restoreStdinBestEffort({ stdin: process.stdin as any });
        logger.debug('[START] Cleanup initiated', {
            kind: event.kind,
            ...(event.kind === 'signal' ? { signal: event.signal } : {}),
            exitCode: outcome.exitCode,
            archive: archiveDecision.archive,
            archiveReason: archiveDecision.archiveReason,
            ...(event.kind === 'unhandledRejection' ? { cause: formatErrorForUi(event.reason) } : {}),
            ...(event.kind === 'uncaughtException' ? { cause: formatErrorForUi(event.error) } : {}),
        });

        try {
            if (activeLoopShouldWaitOnTermination && activeLoopPromise) {
                if (activeLoopAbortController && !activeLoopAbortController.signal.aborted) {
                    activeLoopAbortController.abort('claude-runner-termination');
                }
                await activeLoopPromise.catch((error) => {
                    logger.debug('[START] Active Claude loop ended during termination cleanup', {
                        cause: formatErrorForUi(error),
                    });
                });
            }

            if (session) {
                try {
                    await currentSession?.closeProviderInputAdmissionAndWaitForDispatches();
                    // Dispose the local permission bridge while the session transport is still alive so it can
                    // cancel and persist any outstanding local-mode permission requests.
                    disposeLocalPermissionBridge();
                    // Share one metadata budget across drain -> archive so shutdown cannot stack waits.
                    const metadataDeadline = createSessionMetadataShutdownDeadline();
                    await currentSession?.drainCriticalMetadataWrites({ timeoutMs: metadataDeadline.remainingMs() });
                    if (archiveDecision.archive) {
                        await archiveAndCloseRuntimeSession(session, credentials, archiveDecision.archiveReason, {
                            metadataTimeoutMs: metadataDeadline.remainingMs(),
                        });
                    }

                    // Cleanup session resources (intervals, callbacks)
                    currentSession?.cleanup();

                    if (!archiveDecision.archive) {
                        // Send session death message
                        session.sendSessionDeath();
                        await session.flush();
                        await session.close();
                    }
                } finally {
                    await runtimeActivity.lifecycle.dispose();
                }
            }

            // Stop caffeinate
            stopCaffeinate();

            // Stop Hook server and cleanup settings file + plugin dir
            hookServer.stop();
            if (!endpointArtifactsOwnedByAttachment) {
                cleanupHookSettingsFile(hookSettingsPath);
                cleanupHookPluginDir(hookPluginDir);
            }

            logger.debug('[START] Cleanup complete');
        } catch (error) {
            logger.debug('[START] Error during cleanup (non-fatal):', error);
        }
    };

        const terminationHandlers = registerRunnerTerminationHandlers({
            process,
            exit: (code) => process.exit(code),
            sessionExitReport: { sessionId: session.sessionId },
            onTerminationRequested: () => {
                session.beginRuntimeTermination?.();
                void currentSession?.closeProviderInputAdmissionAndWaitForDispatches();
            },
            onTerminate: cleanup,
            shouldTerminateOnUnhandledRejection: createClaudeShouldTerminateOnUnhandledRejection({
                abortWasRequestedRecently: (withinMs) => currentSession?.wasUserAbortRequestedRecently(withinMs) ?? false,
                ignoreWindowMs: configuration.claudeAbortUnhandledRejectionIgnoreWindowMs,
            }),
        });

    registerKillSessionHandler(session.rpcHandlerManager, async () => {
        await requestClaudeExplicitRunnerStop({
            unifiedTerminalEnabled: unifiedTerminalRuntimeActive,
            destroyOwnedHostForExplicitStop,
            requestTermination: terminationHandlers.requestTermination,
            whenTerminated: terminationHandlers.whenTerminated,
        });
    });

    // Create claude loop
    const resolvedMcp = await (async () => {
        try {
            const mcpSession = applyRunnerMcpSessionContext(session, {
                getPermissionMode: () => currentPermissionMode,
                getBackendTarget: () => ({ kind: 'builtInAgent', agentId: 'claude' }),
                getCurrentSessionLocation: () => ({
                    path: workingDirectory,
                    host: initialMachineMetadata.host,
                    machineId,
                }),
            });
            return await resolveRunnerMcpServers({
                session: mcpSession,
                credentials,
                accountSettings,
                machineId,
                directory: workingDirectory,
                sessionMetadata: mcpSession.getMetadataSnapshot?.() ?? null,
                ...(adoptEndpointRecovery ? { requestedBuiltInMcpPort: adoptEndpointRecovery.state.mcpPort } : {}),
            });
        } catch (error) {
            logger.debug('[START] Failed to resolve runner MCP servers', serializeAxiosErrorForLog(error));
            session.sendSessionEvent({
                type: 'message',
                message: `Failed to prepare MCP servers: ${formatErrorForUi(error)}`,
            });
            throw error;
        }
    })();
    const resolvedMcpPort = parsePortFromUrl(resolvedMcp.happierMcpServer.url);
    const initialClaudeUnifiedTerminalMode = pinClaudeRemoteModeToActiveRuntime(resolveClaudeInstalledRuntimeSessionMode({
        permissionMode: options.permissionMode ?? 'default',
        agentModeId: currentAgentModeId,
        model: currentModel,
        fallbackModel: currentFallbackModel,
        customSystemPrompt: currentCustomSystemPrompt,
        appendSystemPrompt: currentAppendSystemPrompt,
        modelEffortLevels: modelEffortTracker.getLevels(),
        modelEffortLevelsModelId: modelEffortTracker.getModelId(),
        reasoningEffort: currentReasoningEffort,
        ultracode: currentUltracode,
        ...currentClaudeRemoteMetaState,
    }, installedRuntimeCapabilities), sessionRuntimeModeKind);
    let exitCode = 0;
    let loopError: unknown = null;
    try {
        activeLoopAbortController = new AbortController();
        activeLoopShouldWaitOnTermination = unifiedTerminalRuntimeActive;
        activeLoopPromise = loop({
            path: workingDirectory,
            model: options.model,
            permissionMode: options.permissionMode,
            permissionModeUpdatedAt: options.permissionModeUpdatedAt,
            startingMode: options.startingMode,
            claudeUnifiedTerminalEnabled: unifiedTerminalRuntimeActive,
            initialClaudeUnifiedTerminalMode,
            claudeCodeExperimentalAgentTeamsEnabled: currentClaudeRemoteMetaState.claudeCodeExperimentalAgentTeamsEnabled,
            startedBy: options.startedBy,
            messageQueue,
            session,
            pushSender: api.push(),
            accountSettings,
            runtimeActivityContributions: {
                activateProviderTasks: activateProviderTaskRuntimeActivity,
            },
            precomputedMcpBridge: { mcpServers: resolvedMcp.mcpServers, stop: resolvedMcp.happierMcpServer.stop },
            reportSessionMetadataToDaemon: async ({ sessionId, metadata }) => {
                await reportSessionToDaemonIfRunning({ sessionId, metadata });
            },
            onModeChange: (newMode) => {
                session.sendSessionEvent({ type: 'switch', mode: newMode });
                updateAgentStateBestEffort(
                    session,
                    (currentState) => buildClaudeAgentState({
                        currentState,
                        mode: newMode,
                        claudeUnifiedTerminalEnabled: unifiedTerminalRuntimeActive,
                        tuiRuntimeControlEnabled: claudeTuiRuntimeControlEnabled,
                        localPermissionBridgeEnabled,
                        userMessageHandlerReady,
                    }),
                    '[claude]',
                    'mode_change',
                );
                if (newMode === 'local') {
                    localPermissionBridge?.activate();
                }
            },
            onSessionReady: async (sessionInstance) => {
                // Store reference for hook server callback
                currentSession = sessionInstance;
                const currentModelId = await refreshClaudeInitialModeModelEffortEvidence({
                    initialMode: initialClaudeUnifiedTerminalMode,
                    modelEffortTracker,
                    modelId: typeof options.modelId === 'string' ? options.modelId : options.model,
                });
                if (!didPublishSessionModelsMetadata) {
                    didPublishSessionModelsMetadata = true;
                    void publishClaudeSessionModelsMetadataBestEffort({
                        cwd: workingDirectory,
                        timeoutMs: resolveClaudeHelpProbeTimeoutMs(),
                        currentModelId,
                        session,
                        probeInstalledRuntimeCapabilities: async () => installedRuntimeCapabilities,
                    });
                }
                const readinessReport = reportSessionToDaemonIfRunning({
                    sessionId: baseSession.id,
                    metadata,
                    requireDaemonAck: options.startedBy === 'daemon',
                });
                if (options.startedBy === 'daemon') {
                    await readinessReport;
                } else {
                    void readinessReport.catch((error) => {
                        logger.debug('[claude] Daemon session readiness report failed (non-fatal)', error);
                    });
                }
                if (!localPermissionBridge) {
                    localPermissionBridge = new ClaudeLocalPermissionBridge(sessionInstance, { responseTimeoutMs: localPermissionBridgeTimeoutMs });
                    localPermissionBridge.activate();
                } else if (localPermissionBridgeEnabled) {
                    rebuildLocalPermissionBridge();
                }
            },
            claudeArgs: options.claudeArgs,
            hookSettingsPath,
            hookPluginDir,
            statuslineForwarder: {
                port: hookServer.port,
                secret: adoptEndpointRecovery?.statuslineSecret ?? permissionHookSecret,
            },
            jsRuntime: options.jsRuntime,
            defaultSystemPromptText,
            signal: activeLoopShouldWaitOnTermination ? activeLoopAbortController.signal : undefined,
            expectedExistingTerminalHostAttachmentId: adoptEndpointRecovery?.state.attachmentId,
            onTerminalHostReady: async ({
                handle,
                destroyOwnedHostForExplicitStop: destroyOwnedHost,
            }) => {
                destroyOwnedHostForExplicitStop = destroyOwnedHost;
                const attachmentId = handle.attachmentId;
                if (!attachmentId || resolvedMcpPort === null) return;
                endpointArtifactsOwnedByAttachment = await persistClaudeEndpointStateBestEffort({
                    happyHomeDir: configuration.happyHomeDir,
                    sessionId: baseSession.id,
                    state: buildClaudeEndpointState({
                        attachmentId,
                        hookServerPort: hookServer.port,
                        hookPluginDir,
                        hookSettingsPath,
                        mcpUrl: resolvedMcp.happierMcpServer.url,
                        mcpPort: resolvedMcpPort,
                    }),
                });
            },
        });
        exitCode = await activeLoopPromise;
    } catch (error) {
        loopError = error;
    } finally {
        activeLoopAbortController = null;
        activeLoopPromise = null;
        activeLoopShouldWaitOnTermination = false;
    }

    terminationHandlers.dispose();

    // Cleanup session resources (intervals, callbacks) - prevents memory leak
    // Note: currentSession is set by onSessionReady callback during loop()
    await (currentSession as import('./session').Session | null)?.drainCriticalMetadataWrites();
    (currentSession as import('./session').Session | null)?.cleanup();

    // Dispose the local permission bridge while the session transport is still alive so it can
    // cancel and persist any outstanding local-mode permission requests.
    disposeLocalPermissionBridge();

    // Send session death message
    session.sendSessionDeath();

    // Wait for socket to flush
    logger.debug('Waiting for socket to flush...');
    await session.flush();

    // Close session
    logger.debug('Closing session...');
    await session.close();
    await runtimeActivity.lifecycle.dispose();

    // Stop caffeinate before exiting
    stopCaffeinate();
    logger.debug('Stopped sleep prevention');

    // Stop Hook server and cleanup settings file + plugin dir
    hookServer.stop();
    if (!endpointArtifactsOwnedByAttachment) {
        cleanupHookSettingsFile(hookSettingsPath);
        cleanupHookPluginDir(hookPluginDir);
    }
    logger.debug('Stopped Hook server and cleaned up settings file + plugin dir');

    if (loopError) {
        throw loopError;
    }

    // Exit with the code from Claude
    process.exit(exitCode);
    } finally {
        await runtimeActivity.lifecycle.dispose().catch((error) => {
            logger.debug('[START] Error disposing Claude runtime Activity lifecycle:', error);
        });
    }
}

function cleanupClaudeSessionBestEffort(session: unknown): void {
    if (!session) return;
    const cleanup = (session as { cleanup?: unknown }).cleanup;
    if (typeof cleanup === 'function') {
        (cleanup as () => void)();
    }
}

async function runClaudeLocalFastStart(credentials: Credentials, options: StartOptions): Promise<void> {
    const workingDirectory = resolveRequestedSessionDirectory();
    const sessionTag = randomUUID();

    const startedBy: 'terminal' | 'daemon' = options.startedBy ?? 'terminal';
    const startingMode: 'local' | 'remote' = options.startingMode ?? 'local';
    const existingSessionId =
        typeof options.existingSessionId === 'string' && options.existingSessionId.trim().length > 0
            ? options.existingSessionId.trim()
            : undefined;
    const attachMetadataIdentityPolicy =
        existingSessionId
            ? readSessionAttachMetadataIdentityPolicyFromEnv()
            : null;

    const nowMs = () => Date.now();
    const timing = createStartupTiming({ enabled: configuration.startupTimingEnabled, nowMs });

    // Lane Q: same capability resolution as runClaude (see comment there).
    const claudeTuiRuntimeControlEnabled = resolveCliFeatureDecision({
        featureId: CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID,
        env: process.env,
    }).state === 'enabled';

    // Resolve initial permission mode for local starts without blocking on server-derived seeds.
    const explicitPermissionMode = options.permissionMode;
    const explicitPermissionModeUpdatedAt = options.permissionModeUpdatedAt;
    const accountSettings = options.accountSettings ?? null;
    const permissionModeSeed = resolvePermissionModeSeedForAgentStart({
        agentId: 'claude',
        explicitPermissionMode,
        inferredPermissionMode: inferPermissionIntentFromClaudeArgs(options.claudeArgs),
        accountSettings,
    });
    const initialPermissionMode = permissionModeSeed.mode;
    options.permissionMode = initialPermissionMode;

    const explicitModelId = typeof options.modelId === 'string'
        ? options.modelId.trim()
        : (typeof options.model === 'string' ? options.model.trim() : '');
    const initialModelId = explicitModelId ? explicitModelId : undefined;
    const initialModelUpdatedAt =
        typeof options.modelUpdatedAt === 'number'
            ? options.modelUpdatedAt
            : initialModelId
                ? Date.now()
                : 0;
    if (initialModelId) {
        options.model = initialModelId;
        options.modelId = initialModelId;
        options.modelUpdatedAt = initialModelUpdatedAt;
    }

    // Fast-start uses a deferred session client so we can spawn Claude before the server session exists.
    const messageQueue = new MessageQueue2<EnhancedMode>(hashClaudeEnhancedModeForQueue);

    let currentSession: import('./session').Session | null = null;
    const runtimeActivity = await createClaudeBackendRunRuntimeActivityLifecycle('supported');
    const activateProviderTaskRuntimeActivity = runtimeActivity.activateProviderRuntime;
    if (!activateProviderTaskRuntimeActivity) {
        throw new Error('Claude runtime Activity producer binding was not configured');
    }
    const runtimeActivityDisposal: { current: (() => Promise<void>) | null } = {
        current: runtimeActivity.lifecycle.dispose,
    };
    try {
    let endpointArtifactsOwnedByAttachment = false;
    let destroyOwnedHostForExplicitStop: (() => Promise<void>) | null = null;
    let didPublishSessionModelsMetadata = false;
    let userMessageHandlerReady = false;
    let currentPermissionMode: PermissionMode = options.permissionMode ?? 'default';
    let currentAgentModeId: string | null =
        typeof options.agentModeId === 'string' && options.agentModeId.trim().length > 0 ? options.agentModeId.trim() : null;
    let currentAgentModeUpdatedAt = typeof options.agentModeUpdatedAt === 'number' ? options.agentModeUpdatedAt : 0;
    let currentModel = options.model;
    let currentModelUpdatedAt = typeof options.modelUpdatedAt === 'number' ? options.modelUpdatedAt : 0;
    let currentReasoningEffort: string | undefined = undefined;
    let currentReasoningEffortUpdatedAt = 0;
    // See the sibling runtime path above: tiers travel on the mode so hashing stays pure.
    const modelEffortTracker = createClaudeModelEffortLevelsTracker({
        resolveTimeoutMs: () => resolveClaudeHelpProbeTimeoutMs(),
    });
    let currentUltracode: boolean | undefined = undefined;
    let currentUltracodeUpdatedAt = 0;
    let currentFallbackModel: string | undefined = undefined;
    let currentCustomSystemPrompt: string | undefined = undefined;
    let currentAppendSystemPrompt: string | undefined = undefined;
    let currentAppendSystemPromptSeeded = false;
    const seedInitialAppendSystemPrompt = (defaultSystemPromptText?: string | null): void => {
        if (currentAppendSystemPromptSeeded) return;
        currentAppendSystemPrompt = resolveInitialClaudeSystemPromptText({
            existingSessionId,
            defaultSystemPromptText,
        });
        currentAppendSystemPromptSeeded = true;
    };
    const resolveClaudeHelpProbeTimeoutMs = (): number => {
        const raw = process.env.HAPPIER_CLAUDE_HELP_PROBE_TIMEOUT_MS;
        const parsed = typeof raw === 'string' ? Number(raw) : Number.NaN;
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
        return process.env.CI ? 3_000 : 1_500;
    };
    const installedRuntimeCapabilities = await probeClaudeInstalledRuntimeCapabilities({
        cwd: workingDirectory,
        timeoutMs: resolveClaudeHelpProbeTimeoutMs(),
    });
    let pushSender: PushNotificationClient | null = null;
    let currentClaudeRemoteMetaState = resolveInitialClaudeRemoteMetaState({ metaDefaults: options.claudeRemoteMetaDefaults });
    const sessionRuntimeModeKind = normalizeClaudeRemoteMode(currentClaudeRemoteMetaState).kind;
    const unifiedTerminalRuntimeActive = sessionRuntimeModeKind === 'unifiedTerminal';
    let localPermissionBridgeEnabled = currentClaudeRemoteMetaState.claudeLocalPermissionBridgeEnabled === true;
    let localPermissionBridgeWaitIndefinitely = currentClaudeRemoteMetaState.claudeLocalPermissionBridgeWaitIndefinitely === true;
    let localPermissionBridgeTimeoutMs = localPermissionBridgeWaitIndefinitely
        ? null
        : currentClaudeRemoteMetaState.claudeLocalPermissionBridgeTimeoutSeconds * 1000;
    const permissionHookSecret = randomUUID();
    let localPermissionBridge: ClaudeLocalPermissionBridge | null = null;

    const disposeLocalPermissionBridge = () => {
        const bridge: ClaudeLocalPermissionBridge | null = localPermissionBridge;
        bridge?.dispose();
    };
    const rebuildLocalPermissionBridge = () => {
        if (!currentSession) return;
        disposeLocalPermissionBridge();
        if (!localPermissionBridgeEnabled) {
            localPermissionBridge = null;
            return;
        }
        localPermissionBridge = new ClaudeLocalPermissionBridge(currentSession, { responseTimeoutMs: localPermissionBridgeTimeoutMs });
        localPermissionBridge.activate();
    };
    const publishPermissionLifecycleHook = (
        data: PermissionHookData,
        hookEventName: ClaudePermissionLifecycleHookEventName,
    ) => {
        currentSession?.onClaudeSessionHook(buildPermissionLifecycleSessionHook(data, hookEventName));
    };

    const statuslineApplier = createClaudeStatuslineApplier({ logPrefix: '[claude]' });
    const hookServerOptions: Parameters<typeof startHookServer>[0] = {
        onStatuslineUpdate: (payload) => {
            if (currentSession) {
                statuslineApplier.apply(currentSession, payload);
            }
        },
        onSessionHook: (sessionId, data) => {
            if (currentSession) {
                routeClaudeSessionHookAtCallerBoundary({
                    session: currentSession,
                    sessionId,
                    data,
                    unifiedTerminalEnabled: unifiedTerminalRuntimeActive,
                });
                localPermissionBridge?.handleSessionHook(data);
            }
        },
        onPermissionHook: async (data) => {
            publishPermissionLifecycleHook(data, 'PermissionRequest');
            try {
                if (!localPermissionBridgeEnabled || !localPermissionBridge) {
                    return DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE;
                }
                return localPermissionBridge.handlePermissionHook(data);
            } finally {
                publishPermissionLifecycleHook(data, 'PermissionRequestCompleted');
            }
        },
        permissionHookSecret,
        permissionRequestTimeoutMs: localPermissionBridgeWaitIndefinitely ? null : localPermissionBridgeTimeoutMs,
    };

    const startupSpec = createClaudeStartupSpec({
        deps: {
            registerRpcHandlers: ({ artifacts }) => {
                registerSessionHandlers(artifacts.deferredSession.rpcHandlerManager, workingDirectory, {
                    sessionRuntimeControls: {
                        // K5:passive_apply session RPC applies current auth in place; it never restarts or spawns
                        applyConnectedServiceAuthGeneration: async (request) => {
                            if (!currentSession) {
                                return {
                                    ok: false,
                                    errorCode: 'claude_runtime_not_ready',
                                    error: 'claude_runtime_not_ready',
                                };
                            }
                            return await currentSession.applyConnectedServiceAuthGeneration(request);
                        },
                        handleUserMessage: createClaudeUnifiedUserMessageHandler({
                            enqueueSessionUserMessage: (request) =>
                                artifacts.deferredSession.enqueueSessionUserMessage(request),
                        }),
                        wakePendingMaterialization: () => artifacts.deferredSession.wakePendingMaterialization(),
                    },
                });
                userMessageHandlerReady = true;
            },
                startHookServer: async () => {
                    return await startHookServer(hookServerOptions);
                },
                generateHookSettingsFile: async (port) => {
                    return await generateHookSettingsFileWithEnsuredRuntime(port, {
                        enableLocalPermissionBridge: true,
                        permissionHookSecret,
                    });
                },
                generateHookPluginDir: async (port) => {
                    return await generateHookPluginDirWithEnsuredRuntime(port, {
                        enableLocalPermissionBridge: true,
                        permissionHookSecret,
                        ...(existingSessionId ? { sessionHookPluginId: existingSessionId } : {}),
                    });
                },
            cleanupHookSettingsFile,
            cleanupHookPluginDir,
            initializeSessionInBackground: async ({ artifacts, signal }) => {
                if (signal.aborted) return;

                const stopSpan = timing.startSpan('initialize_backend_api_context');
                const { api, machineId } = await initializeBackendApiContext({
                    credentials,
                    machineMetadata: initialMachineMetadata,
                    missingMachineIdMessage:
                        '[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/happier-dev/happier/issues',
                    skipMachineRegistration: startedBy === 'daemon',
                });
                stopSpan();
                pushSender = api.push();

                if (signal.aborted) return;

                const { state, metadata } = createSessionMetadata({
                    flavor: 'claude',
                    machineId,
                    directory: workingDirectory,
                    startedBy: options.startedBy,
                    terminalRuntime: options.terminalRuntime ?? null,
                    permissionMode: initialPermissionMode,
                    permissionModeUpdatedAt: typeof explicitPermissionModeUpdatedAt === 'number' ? explicitPermissionModeUpdatedAt : Date.now(),
                    agentModeId: options.agentModeId,
                    agentModeUpdatedAt: options.agentModeUpdatedAt,
                    modelId: initialModelId,
                    modelUpdatedAt: initialModelUpdatedAt,
                });

                // Let the daemon track externally started terminal sessions immediately, even if
                // upstream session creation is delayed. A later report with the real session id
                // will reconcile the tracked session record.
                if (startedBy === 'terminal') {
                    await reportSessionToDaemonIfRunning({ sessionId: `PID-${process.pid}`, metadata });
                }

                if (signal.aborted) return;

                let wiredServerSession = false;
                const wireServerSession = async (session: ApiSessionClient): Promise<void> => {
                    if (wiredServerSession) return;
                    wiredServerSession = true;

                    await artifacts.deferredSession.attach(session as unknown as DeferredApiSessionTarget);

                    if (currentSession && pushSender) {
                        currentSession.setPushSender(pushSender);
                    }

                        {
                            const permissionModeRef = {
                                current: options.permissionMode ?? 'default',
                                updatedAt: typeof options.permissionModeUpdatedAt === 'number' ? options.permissionModeUpdatedAt : 0,
                            };
                            const modelOverrideRef = { current: initialModelId ?? null, updatedAt: initialModelUpdatedAt };

                            const overridesSync = await initializeRuntimeOverridesSynchronizer({
                                explicitPermissionMode:
                                    typeof explicitPermissionMode === 'string' ? (explicitPermissionMode as PermissionMode) : undefined,
                                    sessionKind: existingSessionId ? 'attach' : 'fresh',
                                    take: configuration.startupPermissionSeedTranscriptTake,
                                    session: {
                                        getMetadataSnapshot: () => session.getMetadataSnapshot(),
                                        fetchLatestUserPermissionIntentFromTranscript: (args) =>
                                        session.fetchLatestUserPermissionIntentFromTranscript(args),
                                },
                                permissionMode: permissionModeRef,
                                modelOverride: modelOverrideRef,
                                onPermissionModeApplied: () => {
                                    options.permissionMode = permissionModeRef.current;
                                    options.permissionModeUpdatedAt = permissionModeRef.updatedAt;
                                },
                                onModelOverrideApplied: () => {
                                    if (initialModelId) return;
                                    options.modelId = modelOverrideRef.current ?? undefined;
                                    options.model = modelOverrideRef.current ?? undefined;
                                    options.modelUpdatedAt = modelOverrideRef.updatedAt;
                                    currentModel = modelOverrideRef.current ?? undefined;
                                    currentModelUpdatedAt = modelOverrideRef.updatedAt;
                                },
                            });

                                const stopSeedSpan = timing.startSpan('resolve_startup_permission_mode');
                                await overridesSync.seedFromSession();
                                stopSeedSpan();
                                overridesSync.syncFromMetadata();
                                try {
                                    const snapshot = overridesSync.getSnapshot();
                                    writeStartupOverridesCacheForBackend({
                                        backendId: 'claude',
                                        permissionMode: snapshot.permissionMode.current,
                                        permissionModeUpdatedAt: snapshot.permissionMode.updatedAt,
                                        modelId: snapshot.modelOverride.current,
                                        modelUpdatedAt: snapshot.modelOverride.updatedAt,
                                        updatedAt: Date.now(),
                                    });
                                } catch {
                                    // ignore
                                }
                            }

                // Extract SDK metadata in background and update session when ready
                extractSDKMetadataAsync(async (sdkMetadata) => {
                    updateMetadataBestEffort(
                        session,
                        (currentMetadata) => ({
                            ...currentMetadata,
                            tools: sdkMetadata.tools,
                            slashCommands: sdkMetadata.slashCommands,
                        }),
                        '[claude]',
                        'sdk_metadata',
                    );
                });

                // Set initial agent state (best-effort; failure is non-fatal).
                updateAgentStateBestEffort(
                    session,
                    (currentState) => buildClaudeAgentState({
                        currentState,
                        mode: startingMode === 'remote' ? 'remote' : 'local',
                        claudeUnifiedTerminalEnabled: unifiedTerminalRuntimeActive,
                        tuiRuntimeControlEnabled: claudeTuiRuntimeControlEnabled,
                        localPermissionBridgeEnabled,
                        userMessageHandlerReady,
                    }),
                    '[claude]',
                    'initial_agent_state',
                );

                const defaultSystemPromptText = await resolveEffectiveCodingPromptText({
                    credentials,
                    settings: options.accountSettings ?? null,
                    profileId: session.getMetadataSnapshot()?.profileId ?? null,
                    executionRunsFeatureEnabled: resolveCliFeatureDecision({
                        featureId: 'execution.runs',
                        env: process.env,
                    }).state === 'enabled',
	                    providerId: 'claude',
	                });
	                seedInitialAppendSystemPrompt(defaultSystemPromptText);

	                // Forward messages from server to the local queue.
	                session.onUserMessage(async (message, deliveryInfo) => {
                    const adoptedModel = adoptModelOverrideFromMetadata({
                        currentModelId: currentModel,
                        currentUpdatedAt: currentModelUpdatedAt,
                        metadata: session.getMetadataSnapshot(),
                    });
                    if (adoptedModel.didChange) {
                        currentModel = adoptedModel.modelId;
                        currentModelUpdatedAt = adoptedModel.updatedAt;
                    }

                    const resolvedAgentModeOverride = resolveSessionModeOverrideFromMetadataSnapshot({
                        metadata: session.getMetadataSnapshot(),
                    });
                    if (resolvedAgentModeOverride && resolvedAgentModeOverride.updatedAt > currentAgentModeUpdatedAt) {
                        currentAgentModeUpdatedAt = resolvedAgentModeOverride.updatedAt;
                        const normalizedModeId = resolvedAgentModeOverride.modeId.trim();
                        currentAgentModeId = normalizedModeId.length > 0 ? normalizedModeId : null;
                    }

                    const adoptedReasoningEffort = adoptReasoningEffortOverrideFromMetadata({
                        currentValueId: currentReasoningEffort ?? null,
                        currentUpdatedAt: currentReasoningEffortUpdatedAt,
                        metadata: session.getMetadataSnapshot(),
                    });
                    if (adoptedReasoningEffort.didChange) {
                        currentReasoningEffort = adoptedReasoningEffort.valueId ?? undefined;
                        currentReasoningEffortUpdatedAt = adoptedReasoningEffort.updatedAt;
                    }

                    const adoptedReasoningEffortFromMessage = adoptReasoningEffortOverrideFromMessageMeta({
                        currentValueId: currentReasoningEffort ?? null,
                        currentUpdatedAt: currentReasoningEffortUpdatedAt,
                        messageMeta: message.meta as Record<string, unknown> | null | undefined,
                        updatedAt:
                            typeof message.createdAt === 'number' && Number.isFinite(message.createdAt) && message.createdAt > 0
                                ? message.createdAt
                                : Date.now(),
                    });
                    if (adoptedReasoningEffortFromMessage.didChange) {
                        currentReasoningEffort = adoptedReasoningEffortFromMessage.valueId ?? undefined;
                        currentReasoningEffortUpdatedAt = adoptedReasoningEffortFromMessage.updatedAt;
                    }

                    const adoptedUltracode = adoptUltracodeOverrideFromMetadata({
                        currentValue: currentUltracode ?? null,
                        currentUpdatedAt: currentUltracodeUpdatedAt,
                        metadata: session.getMetadataSnapshot(),
                    });
                    if (adoptedUltracode.didChange) {
                        currentUltracode = adoptedUltracode.value ?? undefined;
                        currentUltracodeUpdatedAt = adoptedUltracode.updatedAt;
                    }

                    const adoptedUltracodeFromMessage = adoptUltracodeOverrideFromMessageMeta({
                        currentValue: currentUltracode ?? null,
                        currentUpdatedAt: currentUltracodeUpdatedAt,
                        messageMeta: message.meta as Record<string, unknown> | null | undefined,
                        updatedAt:
                            typeof message.createdAt === 'number' && Number.isFinite(message.createdAt) && message.createdAt > 0
                                ? message.createdAt
                                : Date.now(),
                    });
                    if (adoptedUltracodeFromMessage.didChange) {
                        currentUltracode = adoptedUltracodeFromMessage.value ?? undefined;
                        currentUltracodeUpdatedAt = adoptedUltracodeFromMessage.updatedAt;
                    }

                    let messagePermissionMode: PermissionMode = currentPermissionMode;
                    const metaPermissionMode = message.meta?.permissionMode;
                    if (metaPermissionMode) {
                        messagePermissionMode = metaPermissionMode;
                        currentPermissionMode = metaPermissionMode;
                    }

                    let messageModel = currentModel;
                    if (message.meta?.hasOwnProperty('model')) {
                        messageModel = message.meta.model || undefined;
                        currentModel = messageModel;
                        currentModelUpdatedAt =
                            typeof message.createdAt === 'number' && Number.isFinite(message.createdAt) && message.createdAt > 0
                                ? message.createdAt
                                : Date.now();
                    }

                    let messageCustomSystemPrompt = currentCustomSystemPrompt;
                    if (message.meta?.hasOwnProperty('customSystemPrompt')) {
                        messageCustomSystemPrompt = message.meta.customSystemPrompt || undefined;
                        currentCustomSystemPrompt = messageCustomSystemPrompt;
                    }

                    let messageFallbackModel = currentFallbackModel;
                    if (message.meta?.hasOwnProperty('fallbackModel')) {
                        messageFallbackModel = message.meta.fallbackModel || undefined;
                        currentFallbackModel = messageFallbackModel;
                    }

                    let messageAppendSystemPrompt = currentAppendSystemPrompt;
                    if (message.meta?.hasOwnProperty('appendSystemPrompt')) {
                        messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined;
                        currentAppendSystemPrompt = messageAppendSystemPrompt;
                        currentAppendSystemPromptSeeded = true;
                    }

                        currentClaudeRemoteMetaState = applyClaudeRemoteMetaState(currentClaudeRemoteMetaState, message.meta);
                    const nextLocalPermissionBridgeEnabled = currentClaudeRemoteMetaState.claudeLocalPermissionBridgeEnabled === true;
                    const nextLocalPermissionBridgeWaitIndefinitely = currentClaudeRemoteMetaState.claudeLocalPermissionBridgeWaitIndefinitely === true;
                    const nextLocalPermissionBridgeTimeoutMs = nextLocalPermissionBridgeWaitIndefinitely
                        ? null
                        : currentClaudeRemoteMetaState.claudeLocalPermissionBridgeTimeoutSeconds * 1000;

                    if (
                        nextLocalPermissionBridgeEnabled !== localPermissionBridgeEnabled
                        || nextLocalPermissionBridgeWaitIndefinitely !== localPermissionBridgeWaitIndefinitely
                        || nextLocalPermissionBridgeTimeoutMs !== localPermissionBridgeTimeoutMs
                    ) {
                        localPermissionBridgeEnabled = nextLocalPermissionBridgeEnabled;
                        localPermissionBridgeWaitIndefinitely = nextLocalPermissionBridgeWaitIndefinitely;
                        localPermissionBridgeTimeoutMs = nextLocalPermissionBridgeTimeoutMs;
                        hookServerOptions.permissionRequestTimeoutMs = localPermissionBridgeWaitIndefinitely ? null : localPermissionBridgeTimeoutMs;
                        rebuildLocalPermissionBridge();
                        updateAgentStateBestEffort(
                            session,
                            (currentState) => buildClaudeAgentState({
                                currentState,
                                mode: currentState.controlledByUser === true ? 'local' : 'remote',
                                claudeUnifiedTerminalEnabled: unifiedTerminalRuntimeActive,
                                tuiRuntimeControlEnabled: claudeTuiRuntimeControlEnabled,
                                localPermissionBridgeEnabled,
                                userMessageHandlerReady,
                            }),
                            '[claude]',
                            'local_permission_bridge_mode_change',
                        );
                    }

                    const structuredRouting = resolveClaudeStructuredUserMessageRouting({
                        text: message.content.text,
                        meta: message.meta,
                    });
                    // See the sibling path: bounded resolve before the mode is built, not after.
                    await modelEffortTracker.refreshWithin(currentModel);
                    const enhancedMode: EnhancedMode = resolveClaudeInstalledRuntimeSessionMode({
                        permissionMode: messagePermissionMode || 'default',
                        agentModeId: currentAgentModeId,
                        replaySeedAllowed: structuredRouting ? true : parseSpecialCommand(message.content.text).type === null,
                        localId: message.localId ?? null,
                        model: messageModel,
                        fallbackModel: messageFallbackModel,
                        customSystemPrompt: messageCustomSystemPrompt,
                        appendSystemPrompt: messageAppendSystemPrompt,
                        modelEffortLevels: modelEffortTracker.getLevels(),
                        modelEffortLevelsModelId: modelEffortTracker.getModelId(),
                        reasoningEffort: currentReasoningEffort,
                        ultracode: currentUltracode,
                        ...currentClaudeRemoteMetaState,
                    }, installedRuntimeCapabilities);
                    const baseQueuedText = structuredRouting?.queuedText ?? message.content.text;
                    const deliveryAttribution = {
                        userMessageSeq: deliveryInfo?.seq ?? null,
                        userMessageLocalId: message.localId ?? null,
                        providerAcceptancePending: deliveryInfo?.providerAcceptancePending === true,
                        ...(deliveryInfo?.pendingProviderAction ? { pendingProviderAction: deliveryInfo.pendingProviderAction } : {}),
                    };

                    if (!structuredRouting) {
                        const specialCommand = parseSpecialCommand(message.content.text);
                        if (specialCommand.type === 'compact' || specialCommand.type === 'clear') {
                            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, enhancedMode, deliveryAttribution);
                            return;
                        }
                    }

                    if (deliveryInfo?.pendingProviderAction) {
                        messageQueue.unshift(baseQueuedText, enhancedMode, deliveryAttribution);
                    } else {
                        messageQueue.push(baseQueuedText, enhancedMode, deliveryAttribution);
                    }
                });

                if (timing.enabled) {
                    logger.debug(
                        timing.formatSummaryLine({
                            prefix: '[claude-startup]',
                            includeIds: [
                                'vendor_spawn_invoked',
                                'initialize_backend_api_context',
                                'initialize_backend_run_session',
                            ],
                        }),
                    );
                }
                };

                const stopCreateSpan = timing.startSpan('initialize_backend_run_session');
                    const initialized = await initializeBackendRunSession({
                        api,
                        sessionTag,
                        metadata,
                        state,
                        existingSessionId,
                        attachMetadataIdentityPolicy,
                            uiLogPrefix: '[claude]',
                            offlineNotify: (message: string) => {
                                artifacts.deferredSession.sendSessionEvent({ type: 'message', message });
                            },
                        startupMetadataOverrides: createStartupMetadataOverrides({
                            permissionMode: explicitPermissionMode,
                            permissionModeUpdatedAt: explicitPermissionModeUpdatedAt,
                            modelId: initialModelId ?? undefined,
                        modelUpdatedAt: initialModelUpdatedAt,
                    }),
                    allowOfflineStub: true,
                    startupSideEffectsOrder: 'persist-first',
                    runtimeActivityLifecycle: runtimeActivity.lifecycle,
                    onSessionSwap: (newSession) => {
                        void wireServerSession(newSession);
                    },
                });
                stopCreateSpan();
                runtimeActivityDisposal.current = initialized.disposeRuntimeActivity ?? null;

                if (signal.aborted) {
                    initialized.reconnectionHandle?.cancel();
                    return;
                }

                if (!initialized.reportedSessionId) {
                    artifacts.deferredSession.sendSessionEvent({
                        type: 'message',
                        message: 'Server unreachable — continuing in local-only mode.',
                    });
                    if (initialized.reconnectionHandle) {
                        signal.addEventListener('abort', () => initialized.reconnectionHandle?.cancel(), { once: true });
                    }
                    return;
                }

                await wireServerSession(initialized.session);
            },
            spawnLoop: async ({ artifacts, signal }) => {
                if (signal.aborted) return 0;

                const hookSettingsPath = artifacts.hookSettingsPath;
                if (!hookSettingsPath) {
                    throw new Error('Claude startup prerequisites missing');
                }
                const hookPluginDir = artifacts.hookPluginDir;

                    const localSettings = await readSettings();
                    const mcpSession = applyRunnerMcpSessionContext(artifacts.deferredSession as object, {
                        getPermissionMode: () => currentPermissionMode,
                        getBackendTarget: () => ({ kind: 'builtInAgent', agentId: 'claude' }),
                        getCurrentSessionLocation: () => ({
                            path: workingDirectory,
                            host: initialMachineMetadata.host,
                            machineId: typeof localSettings.machineId === 'string' && localSettings.machineId.trim() ? localSettings.machineId.trim() : 'unknown',
                        }),
                    });
                    const resolvedMcp = await resolveRunnerMcpServers({
                        session: mcpSession as any,
                        credentials,
                        accountSettings: options.accountSettings ?? null,
                        machineId: typeof localSettings.machineId === 'string' && localSettings.machineId.trim() ? localSettings.machineId.trim() : 'unknown',
                        directory: workingDirectory,
                        sessionMetadata: mcpSession.getMetadataSnapshot?.() ?? null,
                    });
                    const resolvedMcpPort = parsePortFromUrl(resolvedMcp.happierMcpServer.url);
                    const defaultSystemPromptText = await resolveEffectiveCodingPromptText({
                        credentials,
                        settings: options.accountSettings ?? null,
                        profileId: artifacts.deferredSession.getMetadataSnapshot?.()?.profileId ?? null,
                        executionRunsFeatureEnabled: resolveCliFeatureDecision({
                            featureId: 'execution.runs',
                            env: process.env,
                        }).state === 'enabled',
                        providerId: 'claude',
                    });
                    seedInitialAppendSystemPrompt(defaultSystemPromptText);

                    const initialClaudeUnifiedTerminalMode = pinClaudeRemoteModeToActiveRuntime(resolveClaudeInstalledRuntimeSessionMode({
                        permissionMode: options.permissionMode ?? 'default',
                        agentModeId: currentAgentModeId,
                        model: currentModel,
                        fallbackModel: currentFallbackModel,
                        customSystemPrompt: currentCustomSystemPrompt,
                        appendSystemPrompt: currentAppendSystemPrompt,
                        modelEffortLevels: modelEffortTracker.getLevels(),
                        modelEffortLevelsModelId: modelEffortTracker.getModelId(),
                        reasoningEffort: currentReasoningEffort,
                        ultracode: currentUltracode,
                        ...currentClaudeRemoteMetaState,
                    }, installedRuntimeCapabilities), sessionRuntimeModeKind);

                    const exitCode = await loop({
                        path: workingDirectory,
                        model: options.model,
                        permissionMode: options.permissionMode,
                        permissionModeUpdatedAt: options.permissionModeUpdatedAt,
                        startingMode: options.startingMode,
                        claudeUnifiedTerminalEnabled: unifiedTerminalRuntimeActive,
                        initialClaudeUnifiedTerminalMode,
                        claudeCodeExperimentalAgentTeamsEnabled: currentClaudeRemoteMetaState.claudeCodeExperimentalAgentTeamsEnabled,
                        startedBy: options.startedBy,
                        terminalRuntime: options.terminalRuntime ?? null,
                        messageQueue,
                        onModeChange: (newMode) => {
                            artifacts.deferredSession.sendSessionEvent({ type: 'switch', mode: newMode });
                            updateAgentStateBestEffort(
                                artifacts.deferredSession,
                                (currentState) => buildClaudeAgentState({
                                    currentState,
                                    mode: newMode,
                                    claudeUnifiedTerminalEnabled: unifiedTerminalRuntimeActive,
                                    tuiRuntimeControlEnabled: claudeTuiRuntimeControlEnabled,
                                    localPermissionBridgeEnabled,
                                    userMessageHandlerReady,
                                }),
                                '[claude]',
                                'mode_change',
                            );
                            if (newMode === 'local') {
                                localPermissionBridge?.activate();
                            }
                        },
                        onSessionReady: async (sessionInstance) => {
                            currentSession = sessionInstance;
                            const currentModelId = await refreshClaudeInitialModeModelEffortEvidence({
                                initialMode: initialClaudeUnifiedTerminalMode,
                                modelEffortTracker,
                                modelId: currentModel,
                            });
                            if (!didPublishSessionModelsMetadata) {
                                didPublishSessionModelsMetadata = true;
                                void publishClaudeSessionModelsMetadataBestEffort({
                                    cwd: workingDirectory,
                                    timeoutMs: resolveClaudeHelpProbeTimeoutMs(),
                                    currentModelId,
                                    session: artifacts.deferredSession as unknown as {
                                        ensureMetadataSnapshot: (opts: Readonly<{ timeoutMs: number }>) => Promise<unknown>;
                                        updateMetadata: (updater: (prev: Metadata) => Metadata) => Promise<void>;
                                    },
                                    probeInstalledRuntimeCapabilities: async () => installedRuntimeCapabilities,
                                });
                            }
                            const readySessionId = artifacts.deferredSession.sessionId;
                            const readyMetadata = artifacts.deferredSession.getMetadataSnapshot?.() as Metadata | null | undefined;
                            if (readySessionId && readyMetadata) {
                                await reportSessionToDaemonIfRunning({
                                    sessionId: readySessionId,
                                    metadata: readyMetadata,
                                });
                            }
                            if (!localPermissionBridge) {
                                localPermissionBridge = new ClaudeLocalPermissionBridge(sessionInstance, { responseTimeoutMs: localPermissionBridgeTimeoutMs });
                                if (localPermissionBridgeEnabled) {
                                    localPermissionBridge.activate();
                                }
                            } else if (localPermissionBridgeEnabled) {
                                rebuildLocalPermissionBridge();
                            }
                            if (pushSender) {
                                sessionInstance.setPushSender(pushSender);
                            }
                        },
                        session: artifacts.deferredSession,
                        claudeArgs: options.claudeArgs,
                        hookSettingsPath,
                        hookPluginDir,
                        statuslineForwarder: artifacts.hookServer
                            ? { port: artifacts.hookServer.port, secret: permissionHookSecret }
                            : null,
                        jsRuntime: options.jsRuntime,
                        defaultSystemPromptText,
                        pushSender: null,
                        accountSettings: options.accountSettings ?? null,
                        accountSettingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(credentials),
                        precomputedMcpBridge: { mcpServers: resolvedMcp.mcpServers, stop: resolvedMcp.happierMcpServer.stop },
                        reportSessionMetadataToDaemon: async ({ sessionId, metadata }) => {
                            await reportSessionToDaemonIfRunning({ sessionId, metadata });
                        },
                        runtimeActivityContributions: {
                            activateProviderTasks: activateProviderTaskRuntimeActivity,
                        },
                        onTerminalHostReady: async ({
                            handle,
                            destroyOwnedHostForExplicitStop: destroyOwnedHost,
                        }) => {
                            destroyOwnedHostForExplicitStop = destroyOwnedHost;
                            const attachmentId = handle.attachmentId;
                            if (!attachmentId || resolvedMcpPort === null || !artifacts.hookServer) return;
                            const sessionId = artifacts.deferredSession.sessionId;
                            if (!sessionId) return;
                            endpointArtifactsOwnedByAttachment = await persistClaudeEndpointStateBestEffort({
                                happyHomeDir: configuration.happyHomeDir,
                                sessionId,
                                state: buildClaudeEndpointState({
                                    attachmentId,
                                    hookServerPort: artifacts.hookServer.port,
                                    hookPluginDir,
                                    hookSettingsPath,
                                    mcpUrl: resolvedMcp.happierMcpServer.url,
                                    mcpPort: resolvedMcpPort,
                                }),
                            });
                        },
                    });

                return exitCode;
            },
        },
    });

        const coordinator = runStartupCoordinator({
            ctx: {
                backendId: 'claude',
                sessionKind: existingSessionId ? 'attach' : 'fresh',
                startingModeIntent: 'local',
                startedBy: 'terminal',
                hasTty: Boolean(process.stdout.isTTY && process.stdin.isTTY),
                workspaceDir: workingDirectory,
            nowMs,
            timing,
        },
        spec: startupSpec,
    });

        const terminationHandlers = registerRunnerTerminationHandlers({
            process,
            exit: (code) => process.exit(code),
            sessionExitReport: { sessionId: coordinator.artifacts.deferredSession.sessionId },
            onTerminationRequested: () => {
                coordinator.artifacts.deferredSession.beginRuntimeTermination?.();
                void currentSession?.closeProviderInputAdmissionAndWaitForDispatches();
            },
            onTerminate: async (event, outcome) => {
            restoreStdinBestEffort({ stdin: process.stdin as any });
            try {
                try {
                    coordinator.cancel();
                    coordinator.artifacts.deferredSession.cancel();
                    await currentSession?.closeProviderInputAdmissionAndWaitForDispatches();
                    await currentSession?.drainCriticalMetadataWrites();
                    cleanupClaudeSessionBestEffort(currentSession);
                    // Dispose the local permission bridge while the session transport is still alive so it can
                    // cancel and persist any outstanding local-mode permission requests.
                    disposeLocalPermissionBridge();
                    coordinator.artifacts.deferredSession.sendSessionDeath();
                    await coordinator.artifacts.deferredSession.flush();
                    await coordinator.artifacts.deferredSession.close();
                } finally {
                    await runtimeActivityDisposal.current?.();
                }
            } catch {
                // ignore
            }

            try {
                stopCaffeinate();
                coordinator.artifacts.hookServer?.stop();
                if (!endpointArtifactsOwnedByAttachment && coordinator.artifacts.hookSettingsPath) {
                    cleanupHookSettingsFile(coordinator.artifacts.hookSettingsPath);
                }
                if (!endpointArtifactsOwnedByAttachment) {
                    cleanupHookPluginDir(coordinator.artifacts.hookPluginDir);
                }
            } catch {
                // ignore
            }

            // Preserve existing termination semantics
                void event;
                void outcome;
            },
            shouldTerminateOnUnhandledRejection: createClaudeShouldTerminateOnUnhandledRejection({
                abortWasRequestedRecently: (withinMs) => currentSession?.wasUserAbortRequestedRecently(withinMs) ?? false,
                ignoreWindowMs: configuration.claudeAbortUnhandledRejectionIgnoreWindowMs,
            }),
        });

    registerKillSessionHandler(coordinator.artifacts.deferredSession.rpcHandlerManager, async () => {
        await requestClaudeExplicitRunnerStop({
            unifiedTerminalEnabled: unifiedTerminalRuntimeActive,
            destroyOwnedHostForExplicitStop,
            requestTermination: terminationHandlers.requestTermination,
            whenTerminated: terminationHandlers.whenTerminated,
        });
    });

    // Start caffeinate to prevent sleep on macOS
    if (shouldStartClaudeSessionCaffeinate(startedBy)) {
        startCaffeinate();
    }

    // Run until the vendor loop exits. Startup failures must still close the
    // materialized Happier session so the UI does not keep a dead runner active.
    let exitCode = 0;
    let spawnError: unknown = null;
    try {
        await coordinator.spawnPromise;
        exitCode = coordinator.artifacts.exitCode ?? 0;
    } catch (error) {
        spawnError = error;
    }
    try {
        await coordinator.backgroundPromise;
    } catch {
        // Background startup tasks already degrade their own failures into buffered
        // session events; cleanup still needs to proceed.
    }
    coordinator.cancel();
    terminationHandlers.dispose();

    // Best-effort cleanup for normal exits (signals handled via terminationHandlers).
    try {
        try {
            await (currentSession as import('./session').Session | null)?.closeProviderInputAdmissionAndWaitForDispatches();
            await (currentSession as import('./session').Session | null)?.drainCriticalMetadataWrites();
            cleanupClaudeSessionBestEffort(currentSession);
            // Dispose the local permission bridge while the session transport is still alive so it can
            // cancel and persist any outstanding local-mode permission requests.
            disposeLocalPermissionBridge();
            coordinator.artifacts.deferredSession.sendSessionDeath();
            await coordinator.artifacts.deferredSession.flush();
            await coordinator.artifacts.deferredSession.close();
        } finally {
            await runtimeActivityDisposal.current?.();
        }
    } catch {
        // ignore
    }
    try {
        stopCaffeinate();
        coordinator.artifacts.hookServer?.stop();
        if (!endpointArtifactsOwnedByAttachment && coordinator.artifacts.hookSettingsPath) {
            cleanupHookSettingsFile(coordinator.artifacts.hookSettingsPath);
        }
        if (!endpointArtifactsOwnedByAttachment) {
            cleanupHookPluginDir(coordinator.artifacts.hookPluginDir);
        }
    } catch {
        // ignore
    }

    if (spawnError) {
        throw spawnError;
    }

    process.exit(exitCode);
    } finally {
        try {
            await runtimeActivityDisposal.current?.();
        } catch {
            // Best effort: preserve the original startup or transport failure.
        }
    }
}
