import { randomUUID } from 'node:crypto';

import type { McpServerConfig } from '@/agent';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { DeferredStartupPushSender } from '@/agent/runtime/startup/deferredStartupTypes';
import type { AccountSettings } from '@happier-dev/protocol';
import { normalizeStartingMode } from '@/agent/runtime/session/loop/resolveStartingMode';
import type {
    HostSessionTerminalRemoteHandoffReason,
    HostSessionTerminalRemoteHandoffResult,
    HostSessionTerminalRemoteModeRuntime,
} from '@/agent/runtime/session/loop/terminalRemoteModeRuntime';
import type {
    RuntimeTurnCompletionOptions,
    RuntimeTurnConfigUpdate,
    RuntimeTurnMessageHandler,
    RuntimeTurnOperations,
    RuntimeTurnStartOrLoadOptions,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import { requireTerminalRuntimeLaunch } from '@/agent/terminalRuntime/providers/requireTerminalRuntimeLaunch';
import { logger } from '@/ui/logger';

import { createClaudeEnhancedModeMessageQueue, type EnhancedMode } from './claudeEnhancedMode';
import { cleanupClaudeRuntimeAdjuncts } from './cleanupRuntimeAdjuncts';
import {
    mapClaudeRuntimeModeToSessionMode,
    type ClaudeSessionRuntimeOptions,
} from './claudeSessionRuntimeOptions';
import { launchClaudeRemoteSession } from './remote/launcher';
import { Session } from './session/ClaudeSession';
import { createClaudeRuntimeAdjunctState } from '../utils/createClaudeRuntimeAdjunctState';

type ClaudeRuntimeTurnOperationsParams = Readonly<{
    opts: ClaudeSessionRuntimeOptions;
    directory: string;
    machineId: string;
    session: ApiSessionClient;
    mcpServers: Record<string, McpServerConfig>;
    accountSettings?: AccountSettings | null;
    hookSettingsPath: string;
    hookPluginDir: string | null;
    hookServer: Readonly<{ stop: () => void }>;
    currentSessionRef: { current: Session | null };
    initialMode: EnhancedMode;
    setThinking: (value: boolean) => void;
    getPermissionMode: () => EnhancedMode['permissionMode'];
    localPermissionBridgeManager: ReturnType<typeof createClaudeRuntimeAdjunctState>['localPermissionBridgeManager'];
    deferredPushSenderRef: { current: DeferredStartupPushSender | null };
}>;

type ClaudeTerminalLaunch = (params: Readonly<{
    session: Session;
    options?: Readonly<{ entry?: 'initial' | 'switch' }>;
}>) => Promise<{ type: 'switch' } | { type: 'exit'; code: number }>;

export function createClaudeRuntimeTurnOperations(
    params: ClaudeRuntimeTurnOperationsParams,
): RuntimeTurnOperations & HostSessionTerminalRemoteModeRuntime {
    const messageQueue = createClaudeEnhancedModeMessageQueue();
    const subscribers = new Set<RuntimeTurnMessageHandler>();
    let sessionReadyPromise: Promise<Session> | null = null;
    let terminalLaunchPromise: Promise<ClaudeTerminalLaunch> | null = null;
    let vendorSpawnNotified = false;
    let disposed = false;
    let currentMode: EnhancedMode = params.initialMode;
    let activeTurnCompletion: { promise: Promise<void>; resolve: () => void } | null = null;
    let activeRuntimeTaskId: string | null = null;

    const notifySubscribers = (message: unknown) => {
        for (const subscriber of subscribers) {
            subscriber(message);
        }
    };

    const resolveActiveTurn = () => {
        const completion = activeTurnCompletion;
        if (!completion) return;
        activeTurnCompletion = null;
        completion.resolve();
    };

    const notifyVendorSpawnInvoked = () => {
        if (vendorSpawnNotified) return;
        vendorSpawnNotified = true;
        params.opts.onVendorSpawnInvoked?.();
    };

    const ensureTerminalLaunch = async (): Promise<ClaudeTerminalLaunch> => {
        terminalLaunchPromise ??= requireTerminalRuntimeLaunch<
            { session: Session; options?: { entry?: 'initial' | 'switch' } },
            { type: 'switch' } | { type: 'exit'; code: number }
        >('claude');
        return terminalLaunchPromise;
    };

    const bindSessionInstance = (sessionInstance: Session): void => {
        params.currentSessionRef.current = sessionInstance;
        params.localPermissionBridgeManager.setSession(sessionInstance);
        const originalOnThinkingChange = sessionInstance.onThinkingChange.bind(sessionInstance);
        sessionInstance.onThinkingChange = (thinking: boolean) => {
            originalOnThinkingChange(thinking);
            params.setThinking(thinking);
            if (thinking) {
                if (!activeRuntimeTaskId) {
                    activeRuntimeTaskId = randomUUID();
                    notifySubscribers({ type: 'task_started', id: activeRuntimeTaskId });
                }
                notifySubscribers({ type: 'thinking', thinking });
                return;
            }

            const taskId = activeRuntimeTaskId;
            activeRuntimeTaskId = null;
            if (taskId) {
                notifySubscribers({ type: 'task_complete', id: taskId });
            }
            notifySubscribers({ type: 'thinking', thinking });
            resolveActiveTurn();
        };
        const pushSender = params.deferredPushSenderRef.current;
        if (pushSender) {
            sessionInstance.setPushSender(pushSender);
        }
    };

    const createSessionInstance = (): Session => {
        notifyVendorSpawnInvoked();
        const sessionInstance = new Session({
            client: params.session as SessionClientPort,
            pushSender: null,
            accountSettings: params.accountSettings !== undefined
                ? params.accountSettings
                : params.opts.accountSettings ?? params.opts.accountSettingsContext?.settings ?? null,
            accountSettingsSecretsReadKeys: params.opts.accountSettingsContext?.settingsSecretsReadKeys ?? [],
            path: params.directory,
            sessionId: null,
            claudeArgs: params.opts.claudeArgs,
            logPath: logger.logFilePath,
            messageQueue,
            onModeChange: (mode) => {
                params.session.sendSessionEvent({ type: 'switch', mode });
            },
            hookSettingsPath: params.hookSettingsPath,
            hookPluginDir: params.hookPluginDir,
            jsRuntime: params.opts.jsRuntime,
            startedBy: params.opts.startedBy ?? 'terminal',
            terminalRuntime: params.opts.terminalRuntime ?? null,
            defaultSystemPromptText: undefined,
            precomputedMcpBridge: {
                mcpServers: params.mcpServers,
                stop: () => undefined,
            },
        });
        sessionInstance.claudeCodeExperimentalAgentTeamsEnabled =
            params.initialMode.claudeCodeExperimentalAgentTeamsEnabled === true;

        const snapshot = params.session.getMetadataSnapshot?.();
        const snapshotRecord = snapshot && typeof snapshot === 'object'
            ? snapshot as Readonly<Record<string, unknown>>
            : null;
        const snapshotMode = typeof snapshotRecord?.permissionMode === 'string'
            ? snapshotRecord.permissionMode as EnhancedMode['permissionMode']
            : null;
        const snapshotUpdatedAt = typeof snapshotRecord?.permissionModeUpdatedAt === 'number'
            ? snapshotRecord.permissionModeUpdatedAt
            : 0;
        if (snapshotMode && snapshotUpdatedAt > 0) {
            sessionInstance.adoptLastPermissionModeFromMetadata(snapshotMode, snapshotUpdatedAt);
        } else {
            sessionInstance.lastPermissionMode = params.opts.permissionMode ?? 'default';
            sessionInstance.lastPermissionModeUpdatedAt =
                typeof params.opts.permissionModeUpdatedAt === 'number' ? params.opts.permissionModeUpdatedAt : 0;
        }
        bindSessionInstance(sessionInstance);
        return sessionInstance;
    };

    const ensureSessionReady = async (): Promise<Session> => {
        if (disposed) {
            throw new Error('Claude runtime turn operations have been disposed');
        }
        const existingSession = params.currentSessionRef.current;
        if (existingSession) {
            return existingSession;
        }
        sessionReadyPromise ??= Promise.resolve()
            .then(() => createSessionInstance())
            .finally(() => {
                sessionReadyPromise = null;
            });
        return await sessionReadyPromise;
    };

    const resolveModeForNextPrompt = (): EnhancedMode => ({
        ...currentMode,
        permissionMode: params.getPermissionMode(),
        agentModeId: params.opts.sessionModeId ?? currentMode.agentModeId ?? null,
        model: params.opts.model ?? params.opts.modelId ?? currentMode.model,
    });

    const requestGracefulRemoteHandoff = async (
        reason: HostSessionTerminalRemoteHandoffReason,
    ): Promise<HostSessionTerminalRemoteHandoffResult> => {
        await ensureSessionReady();
        const result = await params.session.rpcHandlerManager.invokeLocal('switch', { to: 'remote', reason });
        if (result && typeof result === 'object') {
            const record = result as Readonly<Record<string, unknown>>;
            if (typeof record.error === 'string') {
                return { ok: false, detail: record.error };
            }
        }
        return result === false
            ? { ok: false, detail: 'remote_handoff_rejected' }
            : { ok: true };
    };

    return Object.freeze({
        beginTurnLifecycle() {
            activeTurnCompletion = (() => {
                let resolve!: () => void;
                const promise = new Promise<void>((innerResolve) => {
                    resolve = innerResolve;
                });
                return { promise, resolve };
            })();
        },
        async startOrLoadSession(_opts?: RuntimeTurnStartOrLoadOptions) {
            await ensureSessionReady();
        },
        async sendTurnPrompt(prompt: string) {
            await ensureSessionReady();
            currentMode = resolveModeForNextPrompt();
            messageQueue.push(prompt, currentMode);
        },
        async steerInFlightTurn(message: string) {
            await ensureSessionReady();
            messageQueue.push(message, resolveModeForNextPrompt());
        },
        async waitForTurnCompletion(opts?: RuntimeTurnCompletionOptions) {
            const completion = activeTurnCompletion;
            if (!completion) return;
            const timeoutMs = typeof opts?.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : 0;
            if (timeoutMs > 0) {
                await Promise.race([
                    completion.promise,
                    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
                ]);
                return;
            }
            await completion.promise;
        },
        subscribeRuntimeMessages(handler: RuntimeTurnMessageHandler) {
            subscribers.add(handler);
            return () => {
                subscribers.delete(handler);
            };
        },
        async respondToPermission() {},
        async cancelTurn() {
            const currentSession = params.currentSessionRef.current;
            try {
                currentSession?.noteUserAbortRequested();
                await currentSession?.abortCurrentTurn();
            } finally {
                const taskId = activeRuntimeTaskId;
                activeRuntimeTaskId = null;
                if (taskId) {
                    notifySubscribers({ type: 'turn_aborted', id: taskId, reason: 'interrupted' });
                }
                messageQueue.reset();
                resolveActiveTurn();
            }
        },
        readSessionIdentity() {
            return { sessionId: params.currentSessionRef.current?.sessionId ?? null };
        },
        async updateSessionRuntimeConfig(update: RuntimeTurnConfigUpdate) {
            currentMode = {
                ...currentMode,
                agentModeId: update.modeId ?? currentMode.agentModeId ?? null,
                model: update.modelId ?? currentMode.model,
            };
        },
        async resetOrDisposeRuntime() {
            disposed = true;
            messageQueue.close();
            params.localPermissionBridgeManager.setSession(null);
            params.localPermissionBridgeManager.dispose();
            const currentSession = params.currentSessionRef.current;
            params.currentSessionRef.current = null;
            currentSession?.cleanup();
            cleanupClaudeRuntimeAdjuncts({
                hookServer: params.hookServer,
                hookSettingsPath: params.hookSettingsPath,
                hookPluginDir: params.hookPluginDir,
            });
            activeRuntimeTaskId = null;
            resolveActiveTurn();
        },
        resolveTerminalRemoteSessionModeLoop() {
            return {
                startingMode: normalizeStartingMode(params.opts.startingMode) ?? 'terminal',
                remoteExitCode: 0,
                onBeforeIteration: (mode) => {
                    logger.debug(`[loop] Iteration with mode: ${mode}`);
                },
                runTerminal: async ({ entry }) => {
                    const session = await ensureSessionReady();
                    const launchTerminal = await ensureTerminalLaunch();
                    return await launchTerminal({ session, options: { entry } });
                },
                runRemote: async () => await launchClaudeRemoteSession(await ensureSessionReady()),
                onModeChange: (mode) => {
                    params.currentSessionRef.current?.onModeChange(mapClaudeRuntimeModeToSessionMode(mode));
                },
                getResumeReadiness: () => {
                    const sessionId = params.currentSessionRef.current?.sessionId;
                    return typeof sessionId === 'string' && sessionId.trim().length > 0
                        ? { ready: true }
                        : { ready: false, detail: 'missing_runtime_session_identity' };
                },
                requestGracefulRemoteHandoff,
            };
        },
    });
}
