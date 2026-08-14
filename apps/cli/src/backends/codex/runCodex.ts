import { applyPermissionModeToCodexPermissionHandler } from './utils/applyPermissionModeToHandler';
import { createCodexPermissionHandler, type CodexRuntimePermissionHandler } from './utils/createCodexPermissionHandler';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { logger } from '@/ui/logger';
import { resolveHasTTY } from '@/ui/tty/resolveHasTTY';
import { Credentials } from '@/persistence';
import type { Metadata } from '@/api/types';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import {
    refreshDaemonOpenAiCodexChatGptAuthTokensForBridge,
    type OpenAiCodexDaemonRefreshSelection,
} from '@/daemon/controlClient';
import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { projectConnectedServiceRuntimeAuthRecoveryReport } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoverySessionEvent';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import {
    createCodexQuotaSnapshotDeliveryOutboxForNotify,
    flushPendingCodexQuotaSnapshotsToDaemon,
    reportCodexRateLimitSnapshotToDaemon,
} from './connectedServices/reportCodexRateLimitSnapshotToDaemon';
import {
    createOpenAiCodexBridgeRefreshFailureClassification,
    resolveOpenAiCodexDaemonRefreshSelection,
} from './connectedServices/resolveOpenAiCodexDaemonRefreshSelection';
import { resolveCodexInitialConnectedServiceRuntimeIdentity } from './connectedServices/resolveCodexInitialConnectedServiceRuntimeIdentity';
import os from 'node:os';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { hashObject } from '@/utils/deterministicJson';
import { resolve, join } from 'node:path';
import { createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { trimIdent } from "@/utils/trimIdent";
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { readPendingLocalId } from '@happier-dev/protocol';
import { readNewestSessionModelsMetadataStateV1 } from '@happier-dev/agents';
import type { CodexSessionConfig } from './types';
import { registerKillSessionHandler } from '@/rpc/handlers/killSession';
import { delay } from "@/utils/time";
import { stopCaffeinate } from '@/integrations/caffeinate';
import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/runnerTerminationHandlers';
import {
    createSessionProviderInputConsumer,
    type SessionProviderInputConsumerSession,
} from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';
import {
    resolveRuntimeAwarePendingForegroundSteerability,
    resolveSessionPendingQueueDeliveryTiming,
    resolveSessionPendingQueueMaxPopPerWake,
} from '@/agent/runtime/sessionInput/pendingQueueDrainPolicy';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createCurrentSessionTranscriptPort } from '@/api/session/createCurrentSessionTranscriptPort';
import {
    DeferredApiSessionClient,
    type DeferredApiSessionTarget,
} from '@/agent/runtime/startup/DeferredApiSessionClient';
import { configuration } from '@/configuration';
import type { PendingQueueDeliveryBlockedReason } from '@/api/session/pendingQueueV2Transport';
import { createAgentSessionMediaPersister } from '@/session/sessionMedia/createAgentSessionMediaPersister';
import { createSessionMediaAccessPolicy } from '@/session/sessionMedia/createSessionMediaAccessPolicy';
import { isExperimentalCodexAcpEnabled } from '@/backends/codex/experiments';
import { maybeUpdatePermissionModeMetadata } from '@/agent/runtime/permission/permissionModeMetadata';
import {
    resolveAppendSystemPromptBaseOverride,
    resolveAppendSystemPromptModeOverride,
    resolveAppendSystemPromptQueueKeyValue,
} from '@/agent/runtime/permission/appendSystemPromptField';
import {
    isNonSteerablePromptPayload,
    parseSpecialCommand,
    type SpecialCommandResult,
} from '@/cli/parsers/specialCommands';
import { pushMessageToQueueWithSpecialCommands } from '@/agent/runtime/queueSpecialCommands';
import { normalizePermissionModeToIntent, resolvePermissionModeUpdatedAtFromMessage } from '@/agent/runtime/permission/permissionModeCanonical';
import { publishCodexSessionIdMetadata } from './utils/codexSessionIdMetadata';
import { createCodexAcpRuntime } from './acp/runtime';
import { createCodexAppServerRuntime } from './appServer/runtime';
import {
    createCodexAcpProviderInputOutcomeBridge,
    createCodexAppServerProviderInputOutcomeBridge,
    type CodexAcpProviderInputOutcomeBridge,
    type CodexAppServerProviderInputOutcomeBridge,
} from './appServer/codexAppServerProviderInputOutcome';
import { reportSessionToDaemonIfRunning } from '@/agent/runtime/startupSideEffects';
import { isCodexAppServerNoActiveTurnToSteerError } from './appServer/appServerCompatibility';
import { rememberCodexUsageLimitRecoveryPreference } from './appServer/rememberCodexUsageLimitRecoveryPreference';
import { resolveConfiguredCodexHome } from './utils/resolveConfiguredCodexHome';
import { buildCodexAppServerConfigOverrides } from './appServer/buildCodexAppServerConfigOverrides';
import { reconcileCodexAppServerOverridesBeforeTurn } from './appServer/reconcileCodexAppServerOverridesBeforeTurn';
import { seedCodexAppServerPendingSessionOverrides } from './appServer/seedPendingSessionOverrides';
import { SessionRollbackRpcParamsSchema } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { syncCodexAcpSessionModeFromPermissionMode } from './acp/syncSessionModeFromPermissionMode';
import { publishInFlightSteerCapability } from './utils/publishInFlightSteerCapability';
import { shouldUseInFlightSteer } from './runtime/shouldUseInFlightSteer';
import { createStartupMetadataOverrides } from '@/agent/runtime/createStartupMetadataOverrides';
import { initializeBackendRunSession } from '@/agent/runtime/initializeBackendRunSession';
import { initializeBackendApiContext } from '@/agent/runtime/initializeBackendApiContext';
import { codexLocalLauncher, type CodexLauncherResult } from './codexLocalLauncher';
import { sendReadyWithPushNotification } from '@/agent/runtime/sendReadyWithPushNotification';
import { resolveProviderPromptFailureDeliveryReason } from '@/agent/runtime/providerPromptSubmission';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { getSessionNotificationTitle } from '@/agent/runtime/readyNotificationContext';
import { resolveReadyNotificationAssistantText } from '@/agent/runtime/readyNotificationAssistantText';
import type { ReadyNotificationTurnContext } from '@/agent/runtime/runPermissionModePromptLoop';
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
import { resolveCodexQueuedPromptForDispatch } from './runtime/resolveCodexQueuedPromptForDispatch';
import type { StructuredInputCatalogReaders } from '@/agent/runtime/prompt/resolveStructuredInputProviderContext';
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
import { startSessionHeartbeatLoop } from '@/agent/runtime/session/startSessionHeartbeatLoop';
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
import { readDaemonInitialGoalFromEnv } from '@/agent/runtime/sessionInitialGoal';

function isRuntimeAuthFailureClassification(value: unknown): value is ConnectedServiceRuntimeFailureClassification {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (typeof record.kind !== 'string') return false;
    if (typeof record.serviceId !== 'string') return false;
    if (typeof record.profileId !== 'string' && record.profileId !== null) return false;
    if (typeof record.groupId !== 'string' && record.groupId !== null) return false;
    if (typeof record.resetsAtMs !== 'number' && record.resetsAtMs !== null) return false;
    if (typeof record.planType !== 'string' && record.planType !== null) return false;
    if (
        record.source !== 'structured_provider_error'
        && record.source !== 'stable_provider_message'
        && record.source !== 'provider_runtime_marker'
    ) {
        return false;
    }
    return true;
}

function readRuntimeAuthClassification(error: unknown): ConnectedServiceRuntimeFailureClassification | null {
    if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
    const record = error as Record<string, unknown>;
    const classification = record.runtimeAuthClassification ?? null;
    return isRuntimeAuthFailureClassification(classification) ? classification : null;
}

function readRuntimeAuthClassificationLogField(
    classification: Record<string, unknown>,
    field: string,
): string | null {
    const value = classification[field];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function summarizeRuntimeAuthClassificationForLog(classification: unknown): Readonly<Record<string, string | null>> {
    if (!classification || typeof classification !== 'object' || Array.isArray(classification)) return {};
    const record = classification as Record<string, unknown>;
    return {
        kind: readRuntimeAuthClassificationLogField(record, 'kind'),
        serviceId: readRuntimeAuthClassificationLogField(record, 'serviceId'),
        profileId: readRuntimeAuthClassificationLogField(record, 'profileId'),
        groupId: readRuntimeAuthClassificationLogField(record, 'groupId'),
    };
}

function readChatGptPlanType(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = (value as Record<string, unknown>).chatgptPlanType;
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function attachRuntimeAuthClassificationToError(
    error: unknown,
    classification: ConnectedServiceRuntimeFailureClassification,
): Error {
    const nextError = error instanceof Error ? error : new Error('connected_service_chatgpt_refresh_unavailable');
    return Object.assign(nextError, { runtimeAuthClassification: classification });
}

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
    codexArgs?: string[];
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
        promptMetadata?: unknown;
        suppressUserEcho?: boolean;
        providerPromptAlreadyResolved?: boolean;
        pendingProviderAction?: import('@/agent/runtime/modeMessageQueue').PendingProviderAction;
    }

    type CodexRemoteRuntime = Readonly<{
        getSessionId: () => string | null;
        supportsInFlightSteer: () => boolean;
        supportsInFlightConfigApply?: () => boolean;
        isTurnInFlight: () => boolean;
        hasActiveProviderTurn?: () => boolean;
        canSteerPrompt?: () => boolean;
        beginTurn: () => void;
        cancel: () => Promise<void>;
        reset: () => Promise<void>;
        startOrLoad: (options: {
            resumeId?: string | null;
            existingSessionId?: string | null;
            importHistory?: boolean;
            initialGoal?: import('@happier-dev/protocol').SessionInitialGoalRequestV1;
        }) => Promise<unknown>;
        setSessionMode: (mode: string) => Promise<void>;
        setSessionModel: (model: string) => Promise<void>;
        setSessionConfigOption: (key: string, value: string | number | boolean | null) => Promise<void>;
        steerPrompt: (prompt: string, options?: { metadata?: unknown; localId?: string | null; localIds?: readonly string[]; userMessageSeq?: number | null }) => Promise<void>;
        sendPrompt: (prompt: string, options?: { metadata?: unknown; localId?: string | null; localIds?: readonly string[]; userMessageSeq?: number | null; appliedModelId?: string | null }) => Promise<void>;
        sendPromptWithMeta?: (params: {
            text: string;
            localId?: string | null;
            meta?: Record<string, unknown>;
            onProviderPromptAccepted?: () => void;
        }) => Promise<void>;
        setOnPromptAcceptedByProvider?: (callback: ((input: Readonly<{
            localIds?: readonly string[] | null;
            userMessageSeq: number | null;
            providerTurnId: string;
            appliedModelId?: string;
        }>) => void) | null) => void;
        setOnUndeliverablePrompts?: (callback: ((prompts: ReadonlyArray<Readonly<{ localIds?: readonly string[] | null; text: string; userMessageSeq: number | null }>>) => void) | null) => void;
        compactContext: (command: string) => Promise<void>;
        refreshGoal?: () => Promise<unknown>;
        setGoal?: (
            objective: string | undefined,
            options?: Readonly<{ status?: string; tokenBudget?: number | null }>,
        ) => Promise<unknown>;
        clearGoal?: () => Promise<unknown>;
        listVendorPlugins?: () => Promise<unknown>;
        listSkills?: () => Promise<unknown>;
        flushTurn: () => Promise<void>;
        rollbackConversation: (request: import('@happier-dev/protocol').SessionRollbackRpcParams) => Promise<import('@happier-dev/protocol').SessionRollbackRpcResult>;
    }>;
    //
    // Define session
    //

    const sessionTag = randomUUID();
    let initialGoalForStartOrLoad = readDaemonInitialGoalFromEnv();
    const consumeInitialGoalForStartOrLoad = () => {
        const goal = initialGoalForStartOrLoad;
        initialGoalForStartOrLoad = null;
        return goal ? { initialGoal: goal } : {};
    };

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
    const pendingQueueDrainMaxPopPerWake = resolveSessionPendingQueueMaxPopPerWake(opts.accountSettingsContext?.settings ?? null);
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
    const normalizeProviderPromptLocalIds = (
        values: readonly (string | null | undefined)[] | null | undefined,
    ): string[] => {
        const seen = new Set<string>();
        const localIds: string[] = [];
        for (const value of values ?? []) {
            const localId = readPendingLocalId(value) ?? '';
            if (!localId || seen.has(localId)) continue;
            seen.add(localId);
            localIds.push(localId);
        }
        return localIds;
    };
    const providerPromptIdentityOption = (
        localIds: readonly string[],
    ): { localId?: string; localIds?: readonly string[] } => {
        if (localIds.length === 1) {
            return { localId: localIds[0] };
        }
        return localIds.length > 1 ? { localIds } : {};
    };
    const confirmProviderAcceptedPrompt = (message: Readonly<{
        userMessageLocalIds?: readonly string[] | null;
        mode?: Readonly<{ localId?: string | null }> | null;
    }>, appliedModelId?: string | null): void => {
        const localIds = normalizeProviderPromptLocalIds([
            ...(message.userMessageLocalIds ?? []),
            message.mode?.localId ?? null,
        ]);
        if (useCodexAppServer) {
            codexAppServerProviderInputOutcomes?.observeAcceptedLocalInput({ localIds });
            return;
        }
        codexAcpProviderInputOutcomes?.observeAccepted({ localIds, appliedModelId });
    };
    const blockProviderPromptDeliveryBeforeAcceptance = async (input: Readonly<{
        localIds: readonly string[];
        reason: PendingQueueDeliveryBlockedReason;
        userMessageSeq: number | null;
    }>): Promise<void> => {
        const localIds = normalizeProviderPromptLocalIds(input.localIds);
        if (localIds.length === 0 || typeof session.blockPendingMessageDelivery !== 'function') {
            return;
        }

        await session.blockPendingMessageDelivery({
            localIds,
            reason: input.reason,
        });
    };
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
    const startedInLocalMode = mode === 'local';

    const shouldFastStartLocal =
        mode === 'local' &&
        startedByForLocalControl === 'cli' &&
        (typeof opts.existingSessionId !== 'string' || !opts.existingSessionId.trim()) &&
        !resumeIdFromArgs;

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
                    codexArgs: opts.codexArgs ?? [],
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
        await deferredSession.attach(target as unknown as DeferredApiSessionTarget);
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

    // Resolve the remote provider before the session is reported to the daemon. Once reported,
    // pending delivery is reachable, so the session must already know whether provider custody is
    // retained until an ACP/app-server acknowledgement.
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
    const codexAppServerDaemonReportReadiness: {
        promise: Promise<void> | null;
        resolve: (() => void) | null;
    } = { promise: null, resolve: null };
    codexAppServerDaemonReportReadiness.promise = useCodexAppServer
        ? startedInLocalMode
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                codexAppServerDaemonReportReadiness.resolve = resolve;
            })
        : null;
    const startupMetadata: Metadata = useCodexAppServer
        ? {
            ...metadata,
            connectedServiceAccessTokenRefreshV1: {
                v: 1,
                mode: startedInLocalMode ? 'unavailable' : 'daemon_callback',
                serviceIds: ['openai-codex'],
            },
        }
        : metadata;
    let session: ApiSessionClient;
    let codexAppServerProviderInputOutcomes: CodexAppServerProviderInputOutcomeBridge | null = null;
    let codexAcpProviderInputOutcomes: CodexAcpProviderInputOutcomeBridge | null = null;
    let workspaceDirFromMetadata: string | null = null;
    // Permission handler declared here so it can be updated in onSessionSwap callback
    // (assigned later after client setup)
    let permissionHandler: CodexRuntimePermissionHandler;
    let permissionHandlerApplyGeneration = 0;
    const applyPermissionModeToActiveCodexPermissionHandler = (params: Readonly<{
        permissionMode: PermissionMode | null | undefined;
        permissionModeUpdatedAt?: number | null | undefined;
    }>): number => {
        permissionHandlerApplyGeneration += 1;
        applyPermissionModeToCodexPermissionHandler({
            permissionHandler,
            permissionMode: params.permissionMode,
            permissionModeUpdatedAt: params.permissionModeUpdatedAt,
        });
        return permissionHandlerApplyGeneration;
    };
    const restorePermissionModeForActiveCodexTurnIfUnchanged = (
        generation: number,
        params: Readonly<{
            permissionMode: PermissionMode | null | undefined;
            permissionModeUpdatedAt?: number | null | undefined;
        }>,
    ): void => {
        if (permissionHandlerApplyGeneration !== generation) return;
        permissionHandlerApplyGeneration += 1;
        applyPermissionModeToCodexPermissionHandler({
            permissionHandler,
            permissionMode: params.permissionMode,
            permissionModeUpdatedAt: params.permissionModeUpdatedAt,
        });
    };
    // CS-FIX-3: no hand-rolled notify closure here — delivery routes through the ONE shared
    // full-payload daemon deliver helper (inside the factory when no notify is supplied), so
    // `sourceProviderAccountId` is always forwarded like the claude + codex-default paths.
    const quotaSnapshotDeliveryOutbox = createCodexQuotaSnapshotDeliveryOutboxForNotify({
        onDiagnostic: (diagnostic) => {
            logger.debug('[Codex] Connected-service quota snapshot delivery diagnostic', diagnostic);
        },
    });
    const flushQuotaSnapshotsAfterDaemonSessionReport = async (sessionId: string): Promise<void> => {
        const result = await flushPendingCodexQuotaSnapshotsToDaemon({
            deliveryOutbox: quotaSnapshotDeliveryOutbox,
            sessionId,
            reason: 'session_report',
        });
        if (result.attempted > 0 || result.dropped > 0) {
            logger.debug('[Codex] Flushed pending connected-service quota snapshots after daemon session report', result);
        }
    };
    // Offline reconnection handle (only relevant when creating a new session and server is unreachable)
    let reconnectionHandle: { cancel: () => void } | null = null;
    const stopRunSessionSpan = timing.startSpan('initialize_backend_run_session');
    const initializedSession = await initializeBackendRunSession({
        api,
        sessionTag,
        metadata: startupMetadata,
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
            if (useCodexAppServer) {
                codexAppServerProviderInputOutcomes = createCodexAppServerProviderInputOutcomeBridge(newSession, {
                    isCurrentRuntimeMode: () => useCodexAppServer,
                });
            } else {
                codexAcpProviderInputOutcomes = createCodexAcpProviderInputOutcomeBridge(
                    newSession,
                    useCodexAcp ? 'acp' : 'mcp',
                );
            }
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
        onDaemonSessionReported: async ({ sessionId }) => {
            await flushQuotaSnapshotsAfterDaemonSessionReport(sessionId);
        },
        ...(codexAppServerDaemonReportReadiness.promise
            ? {
                waitForDaemonReportReadiness: async () => {
                    await codexAppServerDaemonReportReadiness.promise;
                },
            }
            : {}),
    });
    stopRunSessionSpan();
    session = initializedSession.session;
    if (useCodexAppServer) {
        codexAppServerProviderInputOutcomes = createCodexAppServerProviderInputOutcomeBridge(session, {
            isCurrentRuntimeMode: () => useCodexAppServer,
        });
    } else {
        codexAcpProviderInputOutcomes = createCodexAcpProviderInputOutcomeBridge(
            session,
            useCodexAcp ? 'acp' : 'mcp',
        );
    }
    reconnectionHandle = initializedSession.reconnectionHandle;
    // Do not attach the deferred session to an offline stub; wait for the reconnection swap.
    if (initializedSession.attachedToExistingSession || initializedSession.reportedSessionId) {
        await attachDeferredSessionIfNeeded(session);
    }
    if (!initializedSession.attachedToExistingSession) {
        workspaceDirFromMetadata = typeof metadata.path === 'string' && metadata.path.trim().length > 0 ? metadata.path : null;
    }

    const createCodexInputConsumerSession = (): SessionProviderInputConsumerSession => {
        const materializeNextPendingMessageSafely: NonNullable<SessionProviderInputConsumerSession['materializeNextPendingMessageSafely']> =
            async (materializeOpts) => {
                const materialize = session.materializeNextPendingMessageSafely;
                if (typeof materialize !== 'function') {
                    return { type: 'retryable_transport' };
                }
                return await materialize.call(session, materializeOpts);
            };

        return {
            materializeNextPendingMessageSafely,
            shouldAttemptPendingMaterialization: () => session.shouldAttemptPendingMaterialization?.() ?? true,
            reconcilePendingQueueState: (opts) => session.reconcilePendingQueueState?.(opts),
            waitForPendingEligibilityUpdate: (signal) => session.waitForPendingEligibilityUpdate(signal),
            ...(typeof session.readRuntimeActivitySnapshotTail === 'function'
                ? {
                    readRuntimeActivitySnapshotTail: session.readRuntimeActivitySnapshotTail.bind(session),
                }
                : {}),
            ...(typeof session.waitForRuntimeActivitySnapshotTailChange === 'function'
                ? {
                    waitForRuntimeActivitySnapshotTailChange:
                        session.waitForRuntimeActivitySnapshotTailChange.bind(session),
                }
                : {}),
        };
    };

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
    let providerInputConsumer: SessionProviderInputConsumer<EnhancedMode, string> | null = null;
    let syncOverridesFromMetadata: () => void = () => {};
    let providerInputAdmissionClosed = false;
    let providerInputDispatchDrain: Promise<void> = Promise.resolve();
    const closeProviderInputAdmission = (): Promise<void> => {
        providerInputAdmissionClosed = true;
        if (providerInputConsumer) {
            providerInputDispatchDrain = providerInputConsumer.closeProviderInputAdmissionAndWaitForDispatches();
        }
        return providerInputDispatchDrain;
    };
    const runProviderInputDispatch = async <Value>(dispatch: () => Promise<Value>) => {
        if (providerInputAdmissionClosed || !providerInputConsumer) {
            return { status: 'cancelled' as const };
        }
        return await providerInputConsumer.runProviderInputDispatch({
            abortSignal: abortController.signal,
            dispatch,
        });
    };
    const dispatchProviderInputOrThrow = async <Value>(dispatch: () => Promise<Value>): Promise<Value> => {
        const outcome = await runProviderInputDispatch(dispatch);
        if (outcome.status === 'cancelled') {
            const error = new Error('Provider input admission closed');
            error.name = 'AbortError';
            throw error;
        }
        return outcome.value;
    };
    let liveAppliedCodexRefreshSelection: OpenAiCodexDaemonRefreshSelection | null = null;
    const getCodexRemoteRuntime = (): CodexRemoteRuntime | null => {
        return codexAcpRuntime ?? codexAppServerRuntime;
    };
    /**
     * The live session catalogs the send-time resolver reads to reconstruct provider context
     * (INV-9). They are read lazily per dispatch — the resolver calls them only when the
     * message actually carries composer references, so an ordinary message costs no RPC.
     */
    const codexDispatchCatalogReaders = (): StructuredInputCatalogReaders => ({
        listSkills: async () => await getCodexRemoteRuntime()?.listSkills?.(),
        listVendorPlugins: async () => await getCodexRemoteRuntime()?.listVendorPlugins?.(),
    });
    const resolvePendingForegroundSteerability = () => {
        const runtime = getCodexRemoteRuntime();
        const hasActiveProviderTurn = runtime
            ? (runtime.hasActiveProviderTurn?.() ?? runtime.isTurnInFlight())
            : false;
        const canSteerPrompt = runtime
            ? (runtime.canSteerPrompt?.() ?? runtime.isTurnInFlight())
            : false;
        return resolveRuntimeAwarePendingForegroundSteerability({
            hasActiveProviderTurn,
            canSteerPrompt,
        });
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
    let didReplaySeedBootstrap = false;
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

    session.onUserMessage(async (message, info) => {
        const userMessageSeq = info?.seq ?? null;
        // Resolve permission mode (accept all modes, will be mapped in switch statement)
        const activeTurnPermissionModeBeforeMessage = currentPermissionMode ?? initialPermissionMode;
        const activeTurnPermissionModeUpdatedAtBeforeMessage = currentPermissionModeUpdatedAt;
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
            promptMetadata: message.meta,
            ...(info?.pendingProviderAction ? { pendingProviderAction: info.pendingProviderAction } : {}),
        };

        const text = message.content.text;
        const special = parseSpecialCommand(text);
        const runtime = getCodexRemoteRuntime();
        const pendingProviderAction = info?.pendingProviderAction;
        const hasActiveProviderTurn = runtime
            ? (runtime.hasActiveProviderTurn?.() ?? runtime.isTurnInFlight())
            : false;
        if (pendingProviderAction === 'interrupt_and_send' && runtime && hasActiveProviderTurn) {
            const localIds = normalizeProviderPromptLocalIds([message.localId ?? null]);
            await (async () => {
                try {
                    await runtime.cancel();
                    pushMessageToQueueWithSpecialCommands({
                        queue: messageQueue,
                        message: text,
                        text,
                        mode: enhancedMode,
                        userMessageSeq,
                        userMessageLocalIds: localIds,
                        providerAcceptancePending: info?.providerAcceptancePending === true,
                        pendingProviderAction,
                        prioritize: true,
                    });
                } catch (error) {
                    logger.debug('[Codex] interrupt-and-send cancellation failed before provider input', {
                        localIds,
                        errorName: error instanceof Error ? error.name : typeof error,
                        errorMessage: error instanceof Error ? error.message : formatErrorForUi(error),
                    });
                    await blockProviderPromptDeliveryBeforeAcceptance({
                        localIds,
                        reason: 'provider_rejected_before_acceptance',
                        userMessageSeq,
                    });
                }
            })();
            return;
        }
        const mayAttemptLiveSteer = pendingProviderAction === 'steer' || pendingProviderAction === undefined;
        if (runtime && mayAttemptLiveSteer && shouldUseInFlightSteer({
            runtime,
            didChangePermissionMode,
            isPromptNonSteerable: isNonSteerablePromptPayload(text),
        })) {
            // This message will not go through the main prompt loop queue; display it immediately.
            messageBuffer.addMessage(text, 'user');
            await (async () => {
                let providerPromptText = text;
                let providerPromptMetadata: unknown = message.meta;
                let permissionHandlerApplyGenerationForSteer: number | null = null;
                const resolvedMode: EnhancedMode = {
                    ...enhancedMode,
                    suppressUserEcho: true,
                    providerPromptAlreadyResolved: true,
                };
                try {
                    const inputConsumer = providerInputConsumer;
                    if (!inputConsumer) {
                        return;
                    }
                    const localIds = normalizeProviderPromptLocalIds([message.localId ?? null]);
                    const dispatchResolution = await resolveCodexQueuedPromptForDispatch({
                        sessionClient: session,
                        text,
                        localId: message.localId ?? null,
                        replaySeedAllowed: special.type === null,
                        didBootstrap: didReplaySeedBootstrap,
                        metadata: message.meta,
                        catalogs: codexDispatchCatalogReaders(),
                    });
                    didReplaySeedBootstrap = dispatchResolution.didBootstrap;
                    providerPromptText = dispatchResolution.text;
                    providerPromptMetadata = dispatchResolution.metadata;
                    permissionHandlerApplyGenerationForSteer = didChangePermissionMode
                        ? applyPermissionModeToActiveCodexPermissionHandler({
                            permissionMode: resolvedMode.permissionMode,
                            permissionModeUpdatedAt: resolvedMode.permissionModeUpdatedAt,
                        })
                        : null;
                    await dispatchProviderInputOrThrow(async () => {
                        await runtime.steerPrompt(providerPromptText, {
                            ...providerPromptIdentityOption(localIds),
                            metadata: providerPromptMetadata,
                            userMessageSeq,
                        });
                    });
                } catch (error) {
                    const localIds = normalizeProviderPromptLocalIds([message.localId ?? null]);
                    if (didChangePermissionMode && permissionHandlerApplyGenerationForSteer !== null) {
                        restorePermissionModeForActiveCodexTurnIfUnchanged(permissionHandlerApplyGenerationForSteer, {
                            permissionMode: activeTurnPermissionModeBeforeMessage,
                            permissionModeUpdatedAt: activeTurnPermissionModeUpdatedAtBeforeMessage,
                        });
                    }
                    if (!isCodexAppServerNoActiveTurnToSteerError(error)) {
                        await blockProviderPromptDeliveryBeforeAcceptance({
                            localIds,
                            reason: resolveProviderPromptFailureDeliveryReason(error, true),
                            userMessageSeq,
                        });
                        return;
                    }
                    if (pendingProviderAction === 'steer') {
                        await blockProviderPromptDeliveryBeforeAcceptance({
                            localIds,
                            reason: 'steering_unavailable',
                            userMessageSeq,
                        });
                        return;
                    }
                    pushMessageToQueueWithSpecialCommands({
                        queue: messageQueue,
                        message: providerPromptText,
                        text: providerPromptText,
                        mode: resolvedMode,
                        userMessageSeq,
                        userMessageLocalIds: localIds,
                        providerAcceptancePending: info?.providerAcceptancePending === true,
                    });
                }
            })();
            return;
        }

        if (
            pendingProviderAction === 'steer'
        ) {
            const localIds = normalizeProviderPromptLocalIds([message.localId ?? null]);
            await blockProviderPromptDeliveryBeforeAcceptance({
                localIds,
                reason: 'steering_unavailable',
                userMessageSeq,
            });
            return;
        }

        pushMessageToQueueWithSpecialCommands({
            queue: messageQueue,
            message: text,
            text,
            mode: enhancedMode,
            userMessageSeq,
            userMessageLocalIds: normalizeProviderPromptLocalIds([message.localId ?? null]),
            providerAcceptancePending: info?.providerAcceptancePending === true,
            pendingProviderAction,
            prioritize: pendingProviderAction !== undefined,
        });
    });

    let thinking = false;
    let currentTaskId: string | null = null;
    for (const message of [localModeFallbackMessage, codexAcpFallbackToMcpMessage]) {
        if (!message) continue;
        session.sendSessionEvent({ type: 'message', message });
    }

    const keepAliveInterval = startSessionHeartbeatLoop({
        getThinking: () => thinking,
        getMode: () => mode,
        keepAlive: (nextThinking, nextMode) => session.keepAlive(nextThinking, nextMode),
    });
    const turnAssistantPreviewTracker = createTurnAssistantPreviewTracker();
    let happierMcpServer: { url: string; stop: () => void } | null = null;
    let client: CodexMcpClient | null = null;
    let remoteTerminalUi: ReturnType<typeof createCodexRemoteTerminalUi> | null = null;
    let cleanupRunResourcesPromise: Promise<void> | null = null;
    const cleanupRunResourcesOnce = (): Promise<void> => {
        cleanupRunResourcesPromise ??= (async () => {
            quotaSnapshotDeliveryOutbox.clearSession(session.sessionId);
            await closeProviderInputAdmission();
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
        })();
        return cleanupRunResourcesPromise;
    };

    let resumeIdFromLocalControl: string | null = null;
    if (mode === 'local') {
        const localResult = await (localLauncherPromise ??
            codexLocalLauncher<EnhancedMode>({
                path: workspaceDirFromMetadata ?? requestedDirectory,
                api,
                session,
                messageQueue,
                permissionMode: initialPermissionMode,
                resumeId: resumeIdFromArgs,
                codexArgs: opts.codexArgs ?? [],
            }));
        if (localResult.type === 'exit') {
            await cleanupRunResourcesOnce();
            return;
        }

        resumeIdFromLocalControl = localResult.resumeId;
        mode = 'remote';
        session.keepAlive(thinking, mode);
    }

    const sendReady = (context?: ReadyNotificationTurnContext) => {
        const includeAssistantPreviewText =
            opts.accountSettingsContext?.settings?.notificationsSettingsV1?.readyIncludeMessageText !== false;
        sendReadyWithPushNotification({
            session,
            pushSender: api.push(),
            waitingForCommandLabel: 'Codex',
            logPrefix: '[Codex]',
            sessionTitle: getSessionNotificationTitle(session.getMetadataSnapshot.bind(session)),
            assistantPreviewText: resolveReadyNotificationAssistantText({
                includeMessageText: includeAssistantPreviewText,
                explicitAssistantText: turnAssistantPreviewTracker.getPreview(),
                session,
                turnToken: context?.turnToken ?? null,
                startSeqExclusive: context?.startSeqExclusive ?? null,
            }),
            accountSettings: opts.accountSettingsContext?.settings ?? null,
            settingsSecretsReadKeys: opts.accountSettingsContext?.settingsSecretsReadKeys ?? [],
            includeAssistantPreviewText,
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

	    if (codexAcpFallbackToMcpMessage && codexAcpFallbackToMcpMessage !== initialCodexAcpFallbackToMcpMessage) {
	        session.sendSessionEvent({ type: 'message', message: codexAcpFallbackToMcpMessage });
	        messageBuffer.addMessage(codexAcpFallbackToMcpMessage, 'status');
	    }
    const shouldLogAcpDebug = Boolean(process.env.DEBUG) || process.env.HAPPIER_E2E_PROVIDERS === '1';
    if (shouldLogAcpDebug) {
        logger.debug(`[Codex] Remote engine selected: ${useCodexAcp ? 'acp' : useCodexAppServer ? 'appServer' : 'mcp'}`);
    }
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
        sessionExitReport: { sessionId: session.sessionId },
        onTerminationRequested: () => {
            session.beginRuntimeTermination?.();
            void closeProviderInputAdmission();
        },
        onTerminate: async (event, outcome) => {
            logger.debug('[Codex] Runner termination requested', {
                kind: event.kind,
                outcome,
                ...(event.kind === 'signal' ? { signal: event.signal } : {}),
                ...(event.kind === 'exit' ? { code: event.code } : {}),
                ...(event.kind === 'unhandledRejection'
                    ? {
                        reasonName: event.reason instanceof Error ? event.reason.name : typeof event.reason,
                        reasonMessage: formatErrorForUi(event.reason),
                    }
                    : {}),
                ...(event.kind === 'uncaughtException'
                    ? {
                        errorName: event.error instanceof Error ? event.error.name : typeof event.error,
                        errorMessage: formatErrorForUi(event.error),
                    }
                    : {}),
            });
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
                await cleanupRunResourcesOnce();
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
    const mcpSession = applyRunnerMcpSessionContext(session, {
        getPermissionMode: () => currentPermissionMode ?? initialPermissionMode,
        getBackendTarget: () => ({ kind: 'builtInAgent', agentId: 'codex' }),
        getCurrentSessionLocation: () => ({
            path: directory,
            host: initialMachineMetadata.host,
            machineId,
        }),
    });
    const happierBridge = await resolveRunnerMcpServers({
        session: mcpSession,
        credentials: opts.credentials,
        accountSettings,
        machineId,
        directory,
        sessionMetadata: mcpSession.getMetadataSnapshot?.() ?? null,
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
            applyPermissionModeToActiveCodexPermissionHandler({
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
        void publishCodexSessionIdMetadata({
            session,
            getCodexThreadId: () => (client ? client.getSessionId() : (getCodexRemoteRuntime()?.getSessionId() ?? null)),
            backendMode: publishedBackendMode,
            transcriptStorage: process.env.HAPPIER_TRANSCRIPT_STORAGE === 'direct' ? 'direct' : 'persisted',
            codexHome: process.env.CODEX_HOME ?? null,
            activeServerDir: configuration.activeServerDir,
            processEnv: process.env,
            lastPublished: lastCodexThreadIdPublished,
        }).catch(() => undefined);
    };

    const readAttachedCodexAppServerThreadId = (): string | null => {
        const metadata = session.getMetadataSnapshot() as Record<string, unknown> | null;
        if (resolveCodexSessionBackendMode({ metadata }) !== 'appServer') {
            return null;
        }
        return resolveVendorResumeIdFromSessionMetadata('codex', metadata);
    };

    const inputConsumer = createSessionProviderInputConsumer<EnhancedMode, string>({
        messageQueue,
        session: createCodexInputConsumerSession(),
        pendingDrainMaxPopPerWake: pendingQueueDrainMaxPopPerWake,
        resolveActiveTurnSteerability: resolvePendingForegroundSteerability,
        resolvePendingQueueDeliveryTiming: () => resolveSessionPendingQueueDeliveryTiming(
            getActiveAccountSettingsSnapshot()?.settings
            ?? opts.accountSettingsContext?.settings
            ?? null,
        ),
        onMetadataUpdate: () => syncOverridesFromMetadata(),
    });
    providerInputConsumer = inputConsumer;
    if (providerInputAdmissionClosed) {
        providerInputDispatchDrain = inputConsumer.closeProviderInputAdmissionAndWaitForDispatches();
    }

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
            pendingQueueDrainMaxPopPerWake,
            providerInputConsumer: inputConsumer as SessionProviderInputConsumer<unknown, unknown>,
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
            daemonStatePath: configuration.daemonStateFile,
            processEnv: codexAppServerProcessEnv,
            configOverrides: codexAppServerConfigOverrides,
            initialConnectedServiceRuntimeIdentity: resolveCodexInitialConnectedServiceRuntimeIdentity(codexAppServerProcessEnv, session),
            session,
            transcriptSession: createCurrentSessionTranscriptPort(() => session),
            onThinkingChange: (value) => { thinking = value; },
            permissionHandler,
            getPermissionMode: () => runtimePermissionModeRef.current,
            pendingQueue: {
                drainPending: (drainOpts) => inputConsumer.drainPending(drainOpts),
                pumpPendingWhileActive: (pumpOpts) => inputConsumer.pumpPendingWhileActive(pumpOpts),
                drainAfterStartOrLoad: true,
                maxPopPerWake: pendingQueueDrainMaxPopPerWake,
            },
            onInFlightSteerAvailabilityChange: () => {
                const runtime = codexAppServerRuntime;
                if (!runtime) return;
                publishInFlightSteerCapability({ session, runtime });
            },
            onRateLimitSnapshot: async (rawSnapshot, context) => {
                await reportCodexRateLimitSnapshotToDaemon({
                    env: codexAppServerProcessEnv,
                    session,
                    sessionId: session.sessionId,
                    rawSnapshot,
                    appliedIdentity: context?.appliedIdentity ?? null,
                    activeAccountId: context?.activeAccountId ?? null,
                    accountLabel: context?.accountLabel ?? null,
                    rawResetCredits: context?.rawResetCredits ?? null,
                    ...(context?.policyDisposition ? { policyDisposition: context.policyDisposition } : {}),
                    deliveryOutbox: quotaSnapshotDeliveryOutbox,
                });
            },
            onUsageLimitGroupRecovery: async ({ classification }) => {
                const recoveryReport = await reportConnectedServiceRuntimeAuthFailureToDaemon({
                    sessionId: session.sessionId,
                    switchesThisTurn: 0,
                    classification,
                    logPrefix: '[Codex]',
                });
                projectConnectedServiceRuntimeAuthRecoveryReport({
                    report: recoveryReport,
                    classification,
                    addStatusMessage: (message) => {
                        messageBuffer.addMessage(message, 'status');
                    },
                    sendGenericStatusMessage: (message) => {
                        session.sendSessionEvent({ type: 'message', message });
                    },
                    commitTypedProjection: (projection) => {
                        if (projection.transcriptEvent) {
                            session.sendSessionEvent(projection.transcriptEvent);
                            return true;
                        }
                        return false;
                    },
                });
                return recoveryReport;
            },
            onConnectedServiceAuthGenerationApplied: ({ selection }) => {
                const previousSelection = liveAppliedCodexRefreshSelection;
                liveAppliedCodexRefreshSelection = selection.kind === 'group'
                    ? {
                        kind: 'group',
                        serviceId: 'openai-codex',
                        groupId: selection.groupId,
                        activeProfileId: selection.activeProfileId,
                        fallbackProfileId: selection.fallbackProfileId ?? selection.activeProfileId,
                        generation: selection.generation,
                    }
                    : selection;
                return () => {
                    liveAppliedCodexRefreshSelection = previousSelection;
                };
            },
            onChatGptAuthTokensRefresh: async (requestParams) => {
                const resolvedRefreshSelection = resolveOpenAiCodexDaemonRefreshSelection(codexAppServerProcessEnv, session);
                const refreshSelection = liveAppliedCodexRefreshSelection
                    ? {
                        selection: liveAppliedCodexRefreshSelection,
                        recoveryGroupId: liveAppliedCodexRefreshSelection.kind === 'group'
                            ? liveAppliedCodexRefreshSelection.groupId
                            : resolvedRefreshSelection?.recoveryGroupId ?? null,
                    }
                    : resolvedRefreshSelection;
                if (!refreshSelection) {
                    throw new Error('connected_service_chatgpt_refresh_selection_unavailable');
                }
                try {
                    return await refreshDaemonOpenAiCodexChatGptAuthTokensForBridge({
                        sessionId: session.sessionId,
                        selection: refreshSelection.selection,
                        chatgptPlanType: readChatGptPlanType(requestParams),
                    });
                } catch (error) {
                    const classification = createOpenAiCodexBridgeRefreshFailureClassification(
                        refreshSelection,
                        error && typeof error === 'object' ? error as Readonly<{
                            errorCode?: string;
                            credentialHealthStatus?: string;
                        }> : undefined,
                    );
                    const recoveryReport = await reportConnectedServiceRuntimeAuthFailureToDaemon({
                        sessionId: session.sessionId,
                        switchesThisTurn: 0,
                        classification,
                        logPrefix: '[Codex]',
                    });
                    projectConnectedServiceRuntimeAuthRecoveryReport({
                        report: recoveryReport,
                        classification,
                        addStatusMessage: (message) => {
                            messageBuffer.addMessage(message, 'status');
                        },
                        sendGenericStatusMessage: (message) => {
                            session.sendSessionEvent({ type: 'message', message });
                        },
                        commitTypedProjection: (projection) => {
                            if (projection.transcriptEvent) {
                                session.sendSessionEvent(projection.transcriptEvent);
                                return true;
                            }
                            return false;
                        },
                    });
                    throw attachRuntimeAuthClassificationToError(error, classification);
                }
            },
            ...(codexAppServerProcessEnv.HAPPIER_TRANSCRIPT_STORAGE === 'direct'
                ? {}
                : {
                    sessionMedia: createAgentSessionMediaPersister({
                        workingDirectory: directory,
                        sessionId: session.sessionId,
                        accessPolicy: createSessionMediaAccessPolicy({
                            workingDirectory: directory,
                            providerMediaRoots: [resolveConfiguredCodexHome(codexAppServerProcessEnv)],
                        }),
                    }),
                }),
            ...(opts.credentials
                ? {
                    rememberUsageLimitRecoveryPreference: async () => {
                        await rememberCodexUsageLimitRecoveryPreference({
                            credentials: opts.credentials as Credentials,
                        });
                    },
                }
                : {}),
        });
        codexAppServerRuntime.setOnPromptAcceptedByProvider?.(({ localIds, providerTurnId, appliedModelId }) => {
            const normalizedLocalIds = normalizeProviderPromptLocalIds(localIds ?? []);
            const publishedExactOutcome = codexAppServerProviderInputOutcomes?.observeAccepted({
                localIds: normalizedLocalIds,
                providerTurnId,
                appliedModelId,
            }) === true;
            if (!publishedExactOutcome) {
                logger.debug('[codex-app-server] ignored provider acceptance without one exact Queue localId outcome binding', {
                    localIdCount: normalizedLocalIds.length,
                    providerTurnId,
                });
            }
        });
        codexAppServerRuntime.setOnUndeliverablePrompts?.((prompts) => {
            for (const prompt of prompts) {
                const localIds = normalizeProviderPromptLocalIds(prompt.localIds ?? []);
                if (localIds.length !== 1) {
                    logger.debug('[codex-app-server] ignored undeliverable prompt without one exact Pending localId', {
                        localIdCount: localIds.length,
                        userMessageSeq: prompt.userMessageSeq,
                    });
                    continue;
                }
                void blockProviderPromptDeliveryBeforeAcceptance({
                    localIds,
                    reason: 'provider_rejected_before_acceptance',
                    userMessageSeq: prompt.userMessageSeq,
                });
            }
        });
        session.setSessionRuntimeControls?.(codexAppServerRuntime);
        codexAppServerDaemonReportReadiness.resolve?.();
        codexAppServerDaemonReportReadiness.resolve = null;
        try {
            publishInFlightSteerCapability({ session, runtime: codexAppServerRuntime });
        } catch (e) {
            logger.debug('[codex] Failed to publish in-flight steer capability (non-fatal)', e);
        }
    }

    const callbackMetadata = session.getMetadataSnapshot?.();
    if ((!useCodexAppServer || startedInLocalMode) && callbackMetadata && session.sessionId?.trim()) {
        void reportSessionToDaemonIfRunning({
            sessionId: session.sessionId,
            metadata: {
                ...callbackMetadata,
                connectedServiceAccessTokenRefreshV1: {
                    v: 1,
                    mode: useCodexAppServer ? 'daemon_callback' : 'unavailable',
                    serviceIds: ['openai-codex'],
                },
            },
        }).catch((error) => {
            logger.debug('[codex] Failed to report OAuth refresh callback capability (non-fatal)', error);
        });
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
	            let pending: {
                    message: string;
                    mode: EnhancedMode;
                    isolate: boolean;
                    hash: string;
                    maxUserMessageSeq?: number | null;
                    userMessageLocalIds?: readonly string[] | null;
                    providerAcceptancePending?: boolean;
                    pendingProviderAction?: import('@/agent/runtime/modeMessageQueue').PendingProviderAction;
                } | null = null;

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
			                applyPermissionModeToActiveCodexPermissionHandler({
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

	        syncOverridesFromMetadata = (): void => {
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
                    codexArgs: opts.codexArgs ?? [],
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
                        ...consumeInitialGoalForStartOrLoad(),
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
                            importHistory: false,
                            ...consumeInitialGoalForStartOrLoad(),
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
            let message: {
                message: string;
                mode: EnhancedMode;
                isolate: boolean;
                hash: string;
                maxUserMessageSeq?: number | null;
                userMessageLocalIds?: readonly string[] | null;
                providerAcceptancePending?: boolean;
                pendingProviderAction?: import('@/agent/runtime/modeMessageQueue').PendingProviderAction;
            } | null = pending;
                pending = null;
                if (!message) {
                    // Capture the current signal to distinguish idle-abort from queue close
                    const waitSignal = abortController.signal;
                        const batch = await inputConsumer.waitForNextInput({ abortSignal: waitSignal });
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
                    logger.debug('[codex] input consumer returned batch');
                }
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }

                if (!message.mode.suppressUserEcho) {
                    messageBuffer.addMessage(message.message, 'user');
                }
                applyPermissionModeToActiveCodexPermissionHandler({
                    permissionMode: message.mode.permissionMode,
                    permissionModeUpdatedAt: message.mode.permissionModeUpdatedAt,
                });

                const specialCommand: SpecialCommandResult = message.mode.providerPromptAlreadyResolved
                    ? { type: null }
                    : parseSpecialCommand(message.message);
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
                confirmProviderAcceptedPrompt(message);
                continue;
            }

	            let readyTurnContext: ReadyNotificationTurnContext | undefined;
                let shouldBlockProviderDeliveryOnTurnFailure = false;
                let didAttemptProviderSend = false;
                let providerTurnSettledBeforeRuntimeAuthRecovery = false;
                let providerDeliveryLocalIds: string[] = [];
                const providerDeliveryUserMessageSeq = message.maxUserMessageSeq ?? null;
            try {
                const localId =
                    typeof message.mode.localId === 'string' && message.mode.localId
                        ? message.mode.localId
                        : null;
                const localIds = normalizeProviderPromptLocalIds([
                    ...(message.userMessageLocalIds ?? []),
                    localId,
                ]);
                providerDeliveryLocalIds = localIds;
                const startSeqExclusive = session.getLastObservedMessageSeq();
                const turnToken = session.beginTurnAssistantTextSnapshot({ startSeqExclusive });
                readyTurnContext = { turnToken, startSeqExclusive };
                let resolvedProviderDispatch: Readonly<{ text: string; metadata: unknown }> | null = null;
                // Prompt finalization runs once per queued message and owns BOTH the provider
                // prompt text and the dispatch metadata: every Codex send/steer below reads
                // `metadata` from here, never from `message.mode.promptMetadata` directly, so
                // composer references cannot reach `turnInput.ts` unresolved (R-10).
                const resolveProviderDispatch = async (): Promise<Readonly<{ text: string; metadata: unknown }>> => {
                    if (resolvedProviderDispatch !== null) return resolvedProviderDispatch;
                    const dispatchResolution = await resolveCodexQueuedPromptForDispatch({
                        sessionClient: session,
                        text: message.message,
                        localId,
                        replaySeedAllowed: specialCommand.type === null && !message.mode.providerPromptAlreadyResolved,
                        didBootstrap: didReplaySeedBootstrap,
                        metadata: message.mode.promptMetadata,
                        catalogs: codexDispatchCatalogReaders(),
                    });
                    didReplaySeedBootstrap = dispatchResolution.didBootstrap;
                    resolvedProviderDispatch = { text: dispatchResolution.text, metadata: dispatchResolution.metadata };
                    return resolvedProviderDispatch;
                };
                const resolveProviderPromptText = async (): Promise<string> => (await resolveProviderDispatch()).text;

                if (useCodexAcp || useCodexAppServer) {
                    shouldBlockProviderDeliveryOnTurnFailure = localIds.length > 0;
                    const codexRuntime = getCodexRemoteRuntime();
                    if (!codexRuntime) {
                        throw new Error('Codex remote runtime was not initialized');
                    }
                    const canUseInFlightSteerForQueuedMessage =
                        (message.pendingProviderAction === 'steer' || message.pendingProviderAction === undefined)
                        && (codexRuntime.canSteerPrompt ? codexRuntime.canSteerPrompt() : codexRuntime.isTurnInFlight());
                    if (wasCreated && useCodexAppServer && specialCommand.type === null && canUseInFlightSteerForQueuedMessage) {
                        if (shouldLogAcpDebug) {
                            logger.debug('[CodexAppServer] steerPrompt begin for queued message while turn is in flight');
                        }
                        const providerDispatch = await resolveProviderDispatch();
                        try {
                            didAttemptProviderSend = true;
                            await dispatchProviderInputOrThrow(async () => {
                                await codexRuntime.steerPrompt(providerDispatch.text, {
                                    ...providerPromptIdentityOption(localIds),
                                    metadata: providerDispatch.metadata,
                                    userMessageSeq: message.maxUserMessageSeq ?? null,
                                });
                            });
                            if (shouldLogAcpDebug) {
                                logger.debug('[CodexAppServer] steerPrompt complete for queued message while turn is in flight');
                            }
                            continue;
                        } catch (error) {
                            if (!isCodexAppServerNoActiveTurnToSteerError(error)) {
                                throw error;
                            }
                            await blockProviderPromptDeliveryBeforeAcceptance({
                                localIds,
                                reason: 'steering_unavailable',
                                userMessageSeq: message.maxUserMessageSeq ?? null,
                            });
                            continue;
                        }
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
                            const initialGoal = consumeInitialGoalForStartOrLoad();
                            const startOrLoadPromise = Promise.resolve(codexRuntime.startOrLoad({
                                resumeId,
                                // Avoid importing ACP replay history into Happier on resume; Happier transcript is the source of truth.
                                importHistory: false,
                                ...initialGoal,
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
                                const initialGoal = consumeInitialGoalForStartOrLoad();
                                const fallbackPromise = Promise.resolve(codexRuntime.startOrLoad({
                                    ...initialGoal,
                                })).then(() => undefined);
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
                            const initialGoal = consumeInitialGoalForStartOrLoad();
                            const startOrLoadPromise = Promise.resolve(codexRuntime.startOrLoad({
                                ...initialGoal,
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

                    if (specialCommand.type === 'compact') {
                        if (shouldLogAcpDebug) {
                            logger.debug('[CodexACP] compactContext begin');
                        }
                        await codexRuntime.compactContext(specialCommand.originalMessage ?? message.message.trim());
                        if (shouldLogAcpDebug) {
                            logger.debug('[CodexACP] compactContext complete');
                        }
                        confirmProviderAcceptedPrompt(message);
                        continue;
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
                    } else if (useCodexAppServer) {
                        await reconcileCodexAppServerOverridesBeforeTurn({
                            session,
                            syncOverridesFromMetadata,
                            sessionModeSync,
                            configOptionSync,
                            modelSync,
                        });
                    }
                    const systemPromptText = startedFreshSessionForTurn
                        ? await resolveFreshSessionSystemPrompt(
                            resolveAppendSystemPromptBaseOverride(message.mode),
                        )
                        : undefined;
                    const providerDispatch = await resolveProviderDispatch();
                    const promptForProvider = buildCodexAcpPromptForFreshSession({
                        prompt: providerDispatch.text,
                        startedFreshSession: startedFreshSessionForTurn,
                        systemPromptText,
                    });
                    didAttemptProviderSend = true;
                    const sessionModelState = readNewestSessionModelsMetadataStateV1(
                        session.getMetadataSnapshot(),
                    );
                    const appliedModelIdForPrompt = sessionModelState?.provider === 'codex'
                        ? sessionModelState.currentModelId
                        : message.mode.model ?? null;
                    const promptOptions = {
                        ...providerPromptIdentityOption(localIds),
                        metadata: providerDispatch.metadata,
                        userMessageSeq: message.maxUserMessageSeq ?? null,
                        appliedModelId: appliedModelIdForPrompt,
                    };
                    await dispatchProviderInputOrThrow(async () => {
                        if (useCodexAcp) {
                            if (codexRuntime.sendPromptWithMeta) {
                                await codexRuntime.sendPromptWithMeta({
                                    text: promptForProvider,
                                    localId,
                                    meta: typeof providerDispatch.metadata === 'object' && providerDispatch.metadata !== null
                                        ? providerDispatch.metadata as Record<string, unknown>
                                        : undefined,
                                    onProviderPromptAccepted: () => {
                                        confirmProviderAcceptedPrompt(message, appliedModelIdForPrompt);
                                    },
                                });
                            } else {
                                await codexRuntime.sendPrompt(promptForProvider, promptOptions);
                                confirmProviderAcceptedPrompt(message, appliedModelIdForPrompt);
                            }
                        } else {
                            await codexRuntime.sendPrompt(promptForProvider, promptOptions);
                        }
                    });
                    if (shouldLogAcpDebug) {
                        logger.debug('[CodexACP] sendPrompt complete');
                    }
                } else {
                    const providerPromptText = await resolveProviderPromptText();
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

                    thinking = true;
                    session.keepAlive(thinking, 'remote');
                    didAttemptProviderSend = true;
                    const startResponse = await dispatchProviderInputOrThrow(async () => await mcpClient.startSession(
                        startConfig,
                        { signal: abortController.signal },
                    ));
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
                    thinking = true;
                    session.keepAlive(thinking, 'remote');
                    didAttemptProviderSend = true;
                    const response = await dispatchProviderInputOrThrow(async () => await mcpClient.continueSession(
                        providerPromptText,
                        { signal: abortController.signal },
                    ));
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
                confirmProviderAcceptedPrompt(message, message.mode.model ?? null);
                }
            } catch (error) {
                if (shouldBlockProviderDeliveryOnTurnFailure) {
                    await blockProviderPromptDeliveryBeforeAcceptance({
                        localIds: providerDeliveryLocalIds,
                        userMessageSeq: providerDeliveryUserMessageSeq,
                        reason: resolveProviderPromptFailureDeliveryReason(error, didAttemptProviderSend),
                    });
                }

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
                    const runtimeAuthClassification = readRuntimeAuthClassification(error);
                    let runtimeAuthRecoveryStatusEmitted = false;
                    if (runtimeAuthClassification) {
                        logger.warn(
                            '[Codex] Runtime auth failure reported to daemon',
                            summarizeRuntimeAuthClassificationForLog(runtimeAuthClassification),
                        );
                        const runtime = useCodexAcp || useCodexAppServer
                            ? getCodexRemoteRuntime()
                            : null;
                        if (runtime) {
                            // The exact provider turn has already failed. Publish its terminal
                            // boundary before Connected Services attempts refresh/switch/continuation
                            // so recovery cannot wait on the turn that is waiting on recovery.
                            await runtime.flushTurn();
                            providerTurnSettledBeforeRuntimeAuthRecovery = true;
                        }
                        const recoveryReport = await reportConnectedServiceRuntimeAuthFailureToDaemon({
                            sessionId: session.sessionId,
                            switchesThisTurn: 0,
                            classification: runtimeAuthClassification,
                            logPrefix: '[Codex]',
                        });
                        runtimeAuthRecoveryStatusEmitted = projectConnectedServiceRuntimeAuthRecoveryReport({
                            report: recoveryReport,
                            classification: runtimeAuthClassification,
                            addStatusMessage: (message) => {
                                messageBuffer.addMessage(message, 'status');
                            },
                            sendGenericStatusMessage: (message) => {
                                session.sendSessionEvent({ type: 'message', message });
                            },
                            commitTypedProjection: (projection) => {
                                if (projection.transcriptEvent) {
                                    session.sendSessionEvent(projection.transcriptEvent);
                                    return true;
                                }
                                return false;
                            },
                        }).emitted;
                    } else {
                        logger.warn('Error in codex session:', error);
                    }
                    if (!runtimeAuthRecoveryStatusEmitted) {
                        const details = formatErrorForUi(error);
                        const messageText = `Codex process error: ${details}`;
                        messageBuffer.addMessage(messageText, 'status');
                        session.sendSessionEvent({ type: 'message', message: messageText });
                    }
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
                const remoteRuntime = useCodexAcp || useCodexAppServer ? getCodexRemoteRuntime() : null;
                const hasActiveAppServerProviderTurn = remoteRuntime
                    ? (remoteRuntime.hasActiveProviderTurn?.() ?? remoteRuntime.isTurnInFlight())
                    : false;
                const preserveActiveAppServerTurn =
                    useCodexAppServer
                    && hasActiveAppServerProviderTurn;
                if (useCodexAcp || useCodexAppServer) {
                    if (!preserveActiveAppServerTurn && !providerTurnSettledBeforeRuntimeAuthRecovery) {
                        await remoteRuntime?.flushTurn();
                    }
                }
                if (useCodexAcp) {
                    modelSync?.syncFromMetadata();
                }

                if (preserveActiveAppServerTurn) {
                    thinking = true;
                    session.keepAlive(thinking, 'remote');
                } else {
                    // Reset permission handler, reasoning processor, and diff processor
                    permissionHandler.reset();
                    diffProcessor.flushTurn();
                    diffProcessor.reset();
                    thinking = false;
                    session.keepAlive(thinking, 'remote');
                    const drainResult = !shouldExit
                        ? await inputConsumer.drainPending({
                            reason: 'codex-finalizer',
                            logPrefix: '[codex]',
                            shouldContinue: () => !shouldExit,
                        })
                        : { materialized: 0 };
                    if (drainResult.materialized <= 0) {
                        emitReadyIfIdle({
                            pending,
                            queueSize: () => messageQueue.size(),
                            shouldExit,
                            sendReady: () => sendReady(readyTurnContext),
                        });
                    }
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
        await cleanupRunResourcesOnce();
    }
}
