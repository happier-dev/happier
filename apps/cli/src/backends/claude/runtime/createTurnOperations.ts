import type { McpServerConfig } from '@/agent';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { DeferredStartupPushSender } from '@/agent/runtime/startup/deferredStartupTypes';
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
import { mapClaudeRuntimeModeToSessionMode, type ClaudeSessionRuntimeOptions } from './claudeSessionRuntimeOptions';
import { runClaudeModeLoop } from './session/runModeLoop';
import type { Session } from './session/ClaudeSession';
import { createClaudeRuntimeAdjunctState } from '../utils/createClaudeRuntimeAdjunctState';

type ClaudeRuntimeTurnOperationsParams = Readonly<{
    opts: ClaudeSessionRuntimeOptions;
    directory: string;
    machineId: string;
    session: ApiSessionClient;
    mcpServers: Record<string, McpServerConfig>;
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

export function createClaudeRuntimeTurnOperations(params: ClaudeRuntimeTurnOperationsParams): RuntimeTurnOperations {
    const messageQueue = createClaudeEnhancedModeMessageQueue();
    const subscribers = new Set<RuntimeTurnMessageHandler>();
    let providerLoop: Promise<number> | null = null;
    let disposed = false;
    let currentMode: EnhancedMode = params.initialMode;
    let activeTurnCompletion: { promise: Promise<void>; resolve: () => void } | null = null;

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

    const ensureProviderLoopStarted = async () => {
        if (providerLoop) return;
        params.opts.onVendorSpawnInvoked?.();
        const launchTerminal = await requireTerminalRuntimeLaunch<
            { session: Session; options?: { entry?: 'initial' | 'switch' } },
            { type: 'switch' } | { type: 'exit'; code: number }
        >('claude');
        providerLoop = runClaudeModeLoop({
            path: params.directory,
            model: params.opts.model ?? params.opts.modelId,
            permissionMode: params.opts.permissionMode,
            permissionModeUpdatedAt: params.opts.permissionModeUpdatedAt,
            startingMode: params.opts.startingMode,
            claudeCodeExperimentalAgentTeamsEnabled: params.initialMode.claudeCodeExperimentalAgentTeamsEnabled,
            startedBy: params.opts.startedBy,
            hookSettingsPath: params.hookSettingsPath,
            hookPluginDir: params.hookPluginDir,
            claudeArgs: params.opts.claudeArgs,
            jsRuntime: params.opts.jsRuntime,
            defaultSystemPromptText: undefined,
            messageQueue,
            session: params.session,
            pushSender: null,
            accountSettings: params.opts.accountSettings ?? null,
            precomputedMcpBridge: {
                mcpServers: params.mcpServers,
                stop: () => undefined,
            },
            launchTerminal,
            onModeChange: (newMode) => {
                params.session.sendSessionEvent({ type: 'switch', mode: mapClaudeRuntimeModeToSessionMode(newMode) });
            },
            onSessionReady: (sessionInstance) => {
                params.currentSessionRef.current = sessionInstance;
                params.localPermissionBridgeManager.setSession(sessionInstance);
                const originalOnThinkingChange = sessionInstance.onThinkingChange.bind(sessionInstance);
                sessionInstance.onThinkingChange = (thinking: boolean) => {
                    originalOnThinkingChange(thinking);
                    params.setThinking(thinking);
                    notifySubscribers({ type: 'thinking', thinking });
                    if (!thinking) {
                        resolveActiveTurn();
                    }
                };
                const pushSender = params.deferredPushSenderRef.current;
                if (pushSender) {
                    sessionInstance.setPushSender(pushSender);
                }
            },
        }).finally(() => {
            resolveActiveTurn();
        });
    };

    const resolveModeForNextPrompt = (): EnhancedMode => ({
        ...currentMode,
        permissionMode: params.getPermissionMode(),
        agentModeId: params.opts.sessionModeId ?? currentMode.agentModeId ?? null,
        model: params.opts.model ?? params.opts.modelId ?? currentMode.model,
    });

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
            if (disposed) {
                throw new Error('Claude runtime turn operations have been disposed');
            }
            await ensureProviderLoopStarted();
        },
        async sendTurnPrompt(prompt: string) {
            await ensureProviderLoopStarted();
            currentMode = resolveModeForNextPrompt();
            messageQueue.push(prompt, currentMode);
        },
        async steerInFlightTurn(message: string) {
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
            resolveActiveTurn();
            try {
                await providerLoop?.catch((error) => {
                    logger.debug('[claude] Provider loop exited during reset/dispose', error);
                });
            } catch {
                // The catch above is defensive; reset/dispose must stay best-effort.
            }
        },
    });
}
