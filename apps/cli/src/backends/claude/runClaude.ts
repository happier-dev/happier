import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import { loop } from '@/backends/claude/loop';
import { AgentState, Metadata, Session as ApiSession } from '@/api/types';
import packageJson from '../../../package.json';
import { Credentials } from '@/persistence';
import { EnhancedMode, PermissionMode } from './loop';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { startCaffeinate, stopCaffeinate } from '@/integrations/caffeinate';
import { extractSDKMetadataAsync } from '@/backends/claude/sdk/metadataExtractor';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import { getEnvironmentInfo } from '@/ui/doctor';
import { configuration } from '@/configuration';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import { startHappyServer } from '@/mcp/startHappyServer';
import { startHookServer } from '@/backends/claude/utils/startHookServer';
import { generateHookSettingsFile, cleanupHookSettingsFile } from '@/backends/claude/utils/generateHookSettings';
import { registerKillSessionHandler } from '@/rpc/handlers/killSession';
import { projectPath } from '../../projectPath';
import { resolve } from 'node:path';
import { startOfflineReconnection, connectionState } from '@/api/offline/serverConnectionErrors';
import { claudeLocal } from '@/backends/claude/claudeLocal';
import { createSessionScanner } from '@/backends/claude/utils/sessionScanner';
import { Session } from './session';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import { buildTerminalMetadataFromRuntimeFlags } from '@/terminal/runtime/terminalMetadata';
import { persistTerminalAttachmentInfoIfNeeded, reportSessionToDaemonIfRunning, sendTerminalFallbackMessageIfNeeded } from '@/agent/runtime/startupSideEffects';
import { applyStartupMetadataUpdateToSession, buildModelOverride, buildPermissionModeOverride } from '@/agent/runtime/startupMetadataUpdate';
import { resolveStartupPermissionModeFromSession } from '@/agent/runtime/permission/startupPermissionModeSeed';
import { createBaseSessionForAttach } from '@/agent/runtime/createBaseSessionForAttach';
import { createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { hashClaudeEnhancedModeForQueue } from '@/backends/claude/remote/modeHash';
import { applyClaudeRemoteMetaState } from '@/backends/claude/remote/claudeRemoteMetaState';
import { resolveInitialClaudeRemoteMetaState } from '@/backends/claude/remote/resolveInitialClaudeRemoteMetaState';
import { inferPermissionIntentFromClaudeArgs } from './utils/inferPermissionIntentFromArgs';
import { adoptModelOverrideFromMetadata } from './utils/adoptModelOverrideFromMetadata';
import { resolveModelOverrideFromMetadataSnapshot } from '@/agent/runtime/permission/permissionModeFromMetadata';
import { initializeBackendApiContext } from '@/agent/runtime/initializeBackendApiContext';
import { ClaudeLocalPermissionBridge, DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE } from '@/backends/claude/localPermissions/localPermissionBridge';
import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { computeRunnerTerminationOutcome, type RunnerTerminationEvent } from '@/agent/runtime/runnerTerminationOutcome';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/runnerTerminationHandlers';

/** JavaScript runtime to use for spawning Claude Code */
export type JsRuntime = 'node' | 'bun'

export interface StartOptions {
    model?: string
    modelId?: string
    modelUpdatedAt?: number
    permissionMode?: PermissionMode
    startingMode?: 'local' | 'remote'
    shouldStartDaemon?: boolean
    claudeEnvVars?: Record<string, string>
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
}

export function extractMcpServersFromClaudeArgs(args?: string[]): { claudeArgs?: string[]; mcpServers: Record<string, any> } {
    const input = args ?? [];
    if (input.length === 0) return { claudeArgs: args, mcpServers: {} };

    const output: string[] = [];
    const mcpServers: Record<string, any> = {};
    let strippedAny = false;

    for (let i = 0; i < input.length; i++) {
        const arg = input[i];
        if (arg !== '--mcp-config') {
            output.push(arg);
            continue;
        }

        const raw = i + 1 < input.length ? input[i + 1] : undefined;
        if (typeof raw !== 'string' || raw.length === 0) {
            // Keep as-is so upstream Claude can surface a helpful error message.
            output.push(arg);
            continue;
        }

        // Consume value
        i++;

        try {
            const parsed = JSON.parse(raw) as any;
            const servers = parsed && typeof parsed === 'object' ? (parsed as any).mcpServers : null;
            if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
                // Not a supported shape; keep as-is for upstream Claude.
                output.push('--mcp-config', raw);
                continue;
            }

            for (const [name, config] of Object.entries(servers as Record<string, any>)) {
                if (typeof name !== 'string' || name.length === 0) continue;
                mcpServers[name] = config;
            }

            // Preserve any non-mcp keys so upstream Claude still sees them.
            const extras = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : null;
            if (extras) {
                delete (extras as any).mcpServers;
                if (Object.keys(extras).length > 0) {
                    output.push('--mcp-config', JSON.stringify(extras));
                }
            }
            strippedAny = true;
        } catch {
            // Invalid JSON; keep as-is for upstream Claude.
            output.push('--mcp-config', raw);
        }
    }

    if (!strippedAny) return { claudeArgs: args, mcpServers };
    return { claudeArgs: output.length > 0 ? output : undefined, mcpServers };
}

export async function runClaude(credentials: Credentials, options: StartOptions = {}): Promise<void> {
    logger.debug(`[CLAUDE] ===== CLAUDE MODE STARTING =====`);
    logger.debug(`[CLAUDE] This is the Claude agent, NOT Gemini`);
    
    const workingDirectory = process.cwd();
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

    const terminal = buildTerminalMetadataFromRuntimeFlags(options.terminalRuntime ?? null);
    // Resolve initial permission mode for sessions that start in terminal local mode.
    // This is important because there may be no app-sent user messages yet (no meta.permissionMode to infer from).
    const explicitPermissionMode = options.permissionMode;
    const explicitPermissionModeUpdatedAt = options.permissionModeUpdatedAt;
    const initialPermissionMode = options.permissionMode ?? inferPermissionIntentFromClaudeArgs(options.claudeArgs) ?? 'default';
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
        modelId: initialModelId,
        modelUpdatedAt: initialModelUpdatedAt,
    });

    // Let the daemon track externally started terminal sessions immediately, even if
    // upstream session creation is delayed. A later report with the real session id
    // will reconcile the tracked session record.
    if (options.startedBy === 'terminal' || options.startedBy === 'daemon') {
        await reportSessionToDaemonIfRunning({ sessionId: `PID-${process.pid}`, metadata });
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
            let offlineSessionId: string | null = null;

            const reconnection = startOfflineReconnection({
                serverUrl: configuration.serverUrl,
                onReconnected: async () => {
                    const resp = await api.getOrCreateSession({ tag: randomUUID(), metadata, state });
                    if (!resp) throw new Error('Server unavailable');
                    const session = api.sessionSyncClient(resp);
                    const scanner = await createSessionScanner({
                        sessionId: null,
                        workingDirectory,
                        onMessage: (msg) => session.sendClaudeSessionMessage(msg)
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
                await claudeLocal({
                    path: workingDirectory,
                    sessionId: null,
                    onSessionFound: (id) => { offlineSessionId = id; },
                    onThinkingChange: () => {},
                    abort: abortController.signal,
                    claudeEnvVars: options.claudeEnvVars,
                    claudeArgs: options.claudeArgs,
                    mcpServers: {},
                    allowedTools: []
                });
            } finally {
                process.removeListener('SIGINT', abortOnSignal);
                process.removeListener('SIGTERM', abortOnSignal);
                reconnection.cancel();
                stopCaffeinate();
            }
            process.exit(0);
        }

        baseSession = response;
        logger.debug(`Session created: ${baseSession.id}`);
    }

    // Create realtime session
    const session = api.sessionSyncClient(baseSession);
    // Report to daemon immediately so daemon session tracking does not depend on
    // later startup work (metadata snapshot refresh, permission/model seeding, etc.).
    await reportSessionToDaemonIfRunning({ sessionId: baseSession.id, metadata });

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
            applyStartupMetadataUpdateToSession({
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
                mode: 'attach',
            });
        }
    } else {
        applyStartupMetadataUpdateToSession({
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

    // If the user did not explicitly choose a permission mode for this CLI process, prefer the
    // canonical session metadata snapshot. This is essential for:
    // - UI apply timing = next_prompt (metadata already set, message meta absent)
    // - local ↔ remote switching without losing the selected permission policy
    if (typeof explicitPermissionMode !== 'string') {
        const seeded = await resolveStartupPermissionModeFromSession({ session, take: 50 });
        if (seeded) {
            options.permissionMode = seeded.mode;
            options.permissionModeUpdatedAt = seeded.updatedAt;
        }
    }

    if (!initialModelId) {
        const resolved = resolveModelOverrideFromMetadataSnapshot({ metadata: session.getMetadataSnapshot() });
        if (resolved) {
            options.modelId = resolved.modelId;
            options.model = resolved.modelId;
            options.modelUpdatedAt = resolved.updatedAt;
        }
    }

    await persistTerminalAttachmentInfoIfNeeded({ sessionId: baseSession.id, terminal });
    sendTerminalFallbackMessageIfNeeded({ session, terminal });

    // Extract SDK metadata in background and update session when ready
    extractSDKMetadataAsync(async (sdkMetadata) => {
        logger.debug('[start] SDK metadata extracted, updating session:', sdkMetadata);
        try {
            // Update session metadata with tools and slash commands
            session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                tools: sdkMetadata.tools,
                slashCommands: sdkMetadata.slashCommands
            }));
            logger.debug('[start] Session metadata updated with SDK capabilities');
        } catch (error) {
            logger.debug('[start] Failed to update session metadata:', error);
        }
    });

    // Extract user-provided MCP servers from --mcp-config so we can:
    // - merge them with Happy's built-in MCP server
    // - keep MCP servers consistent across local↔remote mode switches
    // - avoid passing multiple --mcp-config flags to Claude
    //
    // IMPORTANT: do this only after we've confirmed the server is reachable.
    // If the server is unreachable and we fall back to offline local mode, we must
    // preserve the user's raw `--mcp-config` flag for upstream Claude.
    const extractedMcp = extractMcpServersFromClaudeArgs(options.claudeArgs);
    options.claudeArgs = extractedMcp.claudeArgs;

    // Start Happier MCP server
    const happyServer = await startHappyServer(session);
    logger.debug(`[START] Happier MCP server started at ${happyServer.url}`);

    // Variable to track current session instance (updated via onSessionReady callback)
    // Used by hook server to notify Session when Claude changes session ID
    let currentSession: Session | null = null;
    let currentClaudeRemoteMetaState = resolveInitialClaudeRemoteMetaState({ metaDefaults: options.claudeRemoteMetaDefaults });
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

    // Start Hook server for receiving Claude session notifications
    const hookServerOptions: Parameters<typeof startHookServer>[0] = {
        onSessionHook: (sessionId, data) => {
            logger.debug(`[START] Session hook received: ${sessionId}`, data);
            
            // Update session ID in the Session instance
            if (currentSession) {
                const previousSessionId = currentSession.sessionId;
                if (previousSessionId !== sessionId) {
                    logger.debug(`[START] Claude session ID changed: ${previousSessionId} -> ${sessionId}`);
                }
                currentSession.onSessionFound(sessionId, data);
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
            if (!localPermissionBridgeEnabled || !localPermissionBridge) {
                return DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE;
            }
            return localPermissionBridge.handlePermissionHook(data);
        },
        permissionHookSecret,
        permissionRequestTimeoutMs: localPermissionBridgeWaitIndefinitely ? null : localPermissionBridgeTimeoutMs,
    };
    const hookServer = await startHookServer(hookServerOptions);
    logger.debug(`[START] Hook server started on port ${hookServer.port}`);

    // Generate hook settings file for Claude
    const hookSettingsPath = generateHookSettingsFile(hookServer.port, {
        enableLocalPermissionBridge: true,
        permissionHookSecret,
    });
    logger.debug(`[START] Generated hook settings file: ${hookSettingsPath}`);

    // Print log file path
    const logPath = logger.logFilePath;
    logger.infoDeveloper(`Session: ${baseSession.id}`);
    logger.infoDeveloper(`Logs: ${logPath}`);

    // Set initial agent state
    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: options.startingMode !== 'remote',
        capabilities: {
            ...(currentState.capabilities && typeof currentState.capabilities === 'object' ? currentState.capabilities : {}),
            askUserQuestionAnswersInPermission: true,
            localPermissionBridgeInLocalMode: localPermissionBridgeEnabled,
            permissionsInUiWhileLocal: localPermissionBridgeEnabled,
        },
    }));

    // Start caffeinate to prevent sleep on macOS
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
        logger.infoDeveloper('Sleep prevention enabled (macOS)');
    }

    // Import MessageQueue2 and create message queue
    const messageQueue = new MessageQueue2<EnhancedMode>(hashClaudeEnhancedModeForQueue);

    // Forward messages to the queue
    // Permission modes: Use the unified 7-mode type, mapping happens at SDK boundary in claudeRemote.ts
    let currentPermissionMode: PermissionMode = options.permissionMode ?? 'default';
    let currentModel = options.model; // Track current model state
    let currentModelUpdatedAt = typeof options.modelUpdatedAt === 'number' ? options.modelUpdatedAt : 0;
    let currentFallbackModel: string | undefined = undefined; // Track current fallback model
    let currentCustomSystemPrompt: string | undefined = undefined; // Track current custom system prompt
    let currentAppendSystemPrompt: string | undefined = undefined; // Track current append system prompt
    let currentAllowedTools: string[] | undefined = undefined; // Track current allowed tools
    let currentDisallowedTools: string[] | undefined = undefined; // Track current disallowed tools
    session.onUserMessage((message) => {
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

        // Resolve allowed tools - use message.meta.allowedTools if provided, otherwise use current
        let messageAllowedTools = currentAllowedTools;
        if (message.meta?.hasOwnProperty('allowedTools')) {
            messageAllowedTools = message.meta.allowedTools || undefined; // null becomes undefined
            currentAllowedTools = messageAllowedTools;
            logger.debug(`[loop] Allowed tools updated from user message: ${messageAllowedTools ? messageAllowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no allowed tools override, using current: ${currentAllowedTools ? currentAllowedTools.join(', ') : 'none'}`);
        }

        // Resolve disallowed tools - use message.meta.disallowedTools if provided, otherwise use current
        let messageDisallowedTools = currentDisallowedTools;
        if (message.meta?.hasOwnProperty('disallowedTools')) {
            messageDisallowedTools = message.meta.disallowedTools || undefined; // null becomes undefined
            currentDisallowedTools = messageDisallowedTools;
            logger.debug(`[loop] Disallowed tools updated from user message: ${messageDisallowedTools ? messageDisallowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no disallowed tools override, using current: ${currentDisallowedTools ? currentDisallowedTools.join(', ') : 'none'}`);
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
            session.updateAgentState((currentState) => ({
                ...currentState,
                capabilities: {
                    ...(currentState.capabilities && typeof currentState.capabilities === 'object' ? currentState.capabilities : {}),
                    askUserQuestionAnswersInPermission: true,
                    localPermissionBridgeInLocalMode: localPermissionBridgeEnabled,
                    permissionsInUiWhileLocal: localPermissionBridgeEnabled,
                },
            }));
        }

        // Check for special commands before processing
        const specialCommand = parseSpecialCommand(message.content.text);

        if (specialCommand.type === 'compact') {
            logger.debug('[start] Detected /compact command');
            const enhancedMode: EnhancedMode = {
                permissionMode: messagePermissionMode || 'default',
                localId: message.localId ?? null,
                model: messageModel,
                fallbackModel: messageFallbackModel,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: messageAppendSystemPrompt,
                allowedTools: messageAllowedTools,
                disallowedTools: messageDisallowedTools,
                ...currentClaudeRemoteMetaState,
            };
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, enhancedMode);
            logger.debugLargeJson('[start] /compact command pushed to queue:', message);
            return;
        }

        if (specialCommand.type === 'clear') {
            logger.debug('[start] Detected /clear command');
            const enhancedMode: EnhancedMode = {
                permissionMode: messagePermissionMode || 'default',
                localId: message.localId ?? null,
                model: messageModel,
                fallbackModel: messageFallbackModel,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: messageAppendSystemPrompt,
                allowedTools: messageAllowedTools,
                disallowedTools: messageDisallowedTools,
                ...currentClaudeRemoteMetaState,
            };
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, enhancedMode);
            logger.debugLargeJson('[start] /clear command pushed to queue:', message);
            return;
        }

        // Push with resolved permission mode, model, system prompts, and tools
        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            localId: message.localId ?? null,
            model: messageModel,
            fallbackModel: messageFallbackModel,
            customSystemPrompt: messageCustomSystemPrompt,
            appendSystemPrompt: messageAppendSystemPrompt,
            allowedTools: messageAllowedTools,
            disallowedTools: messageDisallowedTools,
            ...currentClaudeRemoteMetaState,
        };
        messageQueue.push(message.content.text, enhancedMode);
        logger.debugLargeJson('User message pushed to queue:', message)
    });

    // Setup signal handlers for graceful shutdown and crash reporting.
    const cleanup = async (event: RunnerTerminationEvent, outcome: ReturnType<typeof computeRunnerTerminationOutcome>) => {
        logger.debug('[START] Cleanup initiated', {
            kind: event.kind,
            ...(event.kind === 'signal' ? { signal: event.signal } : {}),
            exitCode: outcome.exitCode,
            archive: outcome.archive,
            archiveReason: outcome.archiveReason,
            ...(event.kind === 'unhandledRejection' ? { cause: formatErrorForUi(event.reason) } : {}),
            ...(event.kind === 'uncaughtException' ? { cause: formatErrorForUi(event.error) } : {}),
        });

        try {
            if (session) {
                if (outcome.archive) {
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        lifecycleState: 'archived',
                        lifecycleStateSince: Date.now(),
                        archivedBy: 'cli',
                        archiveReason: outcome.archiveReason ?? 'User terminated',
                    }));
                }

                // Cleanup session resources (intervals, callbacks)
                currentSession?.cleanup();

                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Stop caffeinate
            stopCaffeinate();

            // Stop Happier MCP server
            happyServer.stop();

            // Stop Hook server and cleanup settings file
            disposeLocalPermissionBridge();
            hookServer.stop();
            cleanupHookSettingsFile(hookSettingsPath);

            logger.debug('[START] Cleanup complete');
        } catch (error) {
            logger.debug('[START] Error during cleanup (non-fatal):', error);
        }
    };

    const terminationHandlers = registerRunnerTerminationHandlers({
        process,
        exit: (code) => process.exit(code),
        onTerminate: cleanup,
    });

    registerKillSessionHandler(session.rpcHandlerManager, async () => {
        terminationHandlers.requestTermination({ kind: 'killSession' });
        await terminationHandlers.whenTerminated;
    });

    // Create claude loop
    const exitCode = await loop({
        path: workingDirectory,
        model: options.model,
        permissionMode: options.permissionMode,
        startingMode: options.startingMode,
        messageQueue,
        api,
        allowedTools: happyServer.toolNames.map(toolName => `mcp__happy__${toolName}`),
        onModeChange: (newMode) => {
            session.sendSessionEvent({ type: 'switch', mode: newMode });
            session.updateAgentState((currentState) => ({
                ...currentState,
                controlledByUser: newMode === 'local'
            }));
            if (newMode === 'local') {
                localPermissionBridge?.activate();
            }
        },
        onSessionReady: (sessionInstance) => {
            // Store reference for hook server callback
            currentSession = sessionInstance;
            if (!localPermissionBridge) {
                localPermissionBridge = new ClaudeLocalPermissionBridge(sessionInstance, { responseTimeoutMs: localPermissionBridgeTimeoutMs });
                localPermissionBridge.activate();
            } else if (localPermissionBridgeEnabled) {
                rebuildLocalPermissionBridge();
            }
        },
        mcpServers: {
            ...extractedMcp.mcpServers,
            // Keep Happy MCP server last so a user-provided "happy" entry cannot override it.
            happy: {
                type: 'http' as const,
                url: happyServer.url,
            },
        },
        session,
        claudeEnvVars: options.claudeEnvVars,
        claudeArgs: options.claudeArgs,
        hookSettingsPath,
        jsRuntime: options.jsRuntime
    });

    terminationHandlers.dispose();

    // Cleanup session resources (intervals, callbacks) - prevents memory leak
    // Note: currentSession is set by onSessionReady callback during loop()
    (currentSession as Session | null)?.cleanup();

    // Send session death message
    session.sendSessionDeath();

    // Wait for socket to flush
    logger.debug('Waiting for socket to flush...');
    await session.flush();

    // Close session
    logger.debug('Closing session...');
    await session.close();

    // Stop caffeinate before exiting
    stopCaffeinate();
    logger.debug('Stopped sleep prevention');

    // Stop Happier MCP server
    happyServer.stop();
    logger.debug('Stopped Happier MCP server');

    // Stop Hook server and cleanup settings file
    disposeLocalPermissionBridge();
    hookServer.stop();
    cleanupHookSettingsFile(hookSettingsPath);
    logger.debug('Stopped Hook server and cleaned up settings file');

    // Exit with the code from Claude
    process.exit(exitCode);
}
