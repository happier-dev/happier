import type { EnhancedMode } from "./loop";
import { query, type QueryOptions, type SDKMessage, type SDKSystemMessage, AbortError, type SDKUserMessage } from '@/backends/claude/sdk'
import { resolveClaudeSdkPermissionModeFromEnhancedMode } from "./utils/permissionMode";
import { parseSpecialCommand } from "@/cli/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import type { PermissionResult } from "./sdk/types";
import type { JsRuntime } from "./runClaude";
import { getClaudeRemoteSystemPrompt } from "./utils/remoteSystemPrompt";
import { parseClaudeSdkFlagOverridesFromArgs } from "./remote/sdkFlagOverrides";
import { resolveClaudeRemoteSessionStartPlan } from "./remote/sessionStartPlan";
import { resolveClaudeConfigDirOverride } from "./utils/resolveClaudeConfigDirOverride";
import { resolveClaudeConfigDirEnvOverlay } from "./utils/resolveClaudeConfigDirEnvOverlay";
import { resolveClaudeCodeExperimentalEnvOverlay } from "./spawn/resolveClaudeCodeExperimentalEnvOverlay";
import { logClaudeRuntimeAuthEnvDiagnostic } from "./spawn/logClaudeRuntimeAuthEnvDiagnostic";
import { ensureClaudeJsRuntimeExecutable } from "./utils/ensureClaudeJsRuntimeExecutable";
import { resolveClaudeCliPath } from "./utils/resolveClaudeCliPath";
import { resolveCliRuntimeAssetPath } from '@/runtime/assets/resolveCliRuntimeAssetPath';
import { buildClaudeEffortCliArgs, resolveModeEffortLevelsForModel } from "./utils/claudeEffort";
import {
    buildClaudeCompactionCompletedEvent,
    buildClaudeCompactionLifecycleId,
    buildClaudeCompactionStartedEvent,
    type ClaudeCompletionEvent,
} from './contextCompactionEvents';
import {
    confirmClaudeRemoteProviderPromptAccepted,
    reportClaudeRemoteProviderPromptTransportFailure,
    type ClaudeRemoteProviderAcceptedPrompt,
    type ClaudeRemoteProviderPromptAcceptedHandler,
    type ClaudeRemoteProviderPromptTransportFailureHandler,
} from './remote/providerPromptAcceptance';
import type { createClaudeProviderRuntimeActivityAdapter } from './providerActivity/createClaudeProviderRuntimeActivityAdapter';
import { isClaudeLegacyRequiredHookObservationFailure } from './remote/runtimeActivityEvidence';

function buildClaudeEffortArgs(params: Readonly<{
    modelId: unknown;
    effort: unknown;
    supportedLevels?: readonly string[];
}>): string[] {
    return buildClaudeEffortCliArgs(params);
}

function extractMcpConfigPassthroughArgs(args?: string[]): string[] | undefined {
    const input = args ?? [];
    const out: string[] = [];
    for (let i = 0; i < input.length; i++) {
        const arg = input[i];
        if (typeof arg === 'string' && arg.startsWith('--mcp-config=')) {
            // Support the equals form (`--mcp-config=<json>`).
            out.push(arg);
            continue;
        }
        if (arg !== '--mcp-config') continue;
        const next = i + 1 < input.length ? input[i + 1] : undefined;
        // Pass the flag through as-is; do not parse/merge.
        out.push('--mcp-config');
        if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) {
            out.push(next);
            i++;
        }
    }
    return out.length > 0 ? out : undefined;
}

function resolveSettingSourcesPassthroughArgs(mode: EnhancedMode): string[] | null {
    const rawV2 = mode.claudeRemoteSettingSourcesV2;
    if (Array.isArray(rawV2)) {
        const set = new Set<string>();
        for (const value of rawV2) {
            if (typeof value === 'string') set.add(value);
        }
        const normalized: Array<'user' | 'project' | 'local'> = [];
        for (const key of ['user', 'project', 'local'] as const) {
            if (set.has(key)) normalized.push(key);
        }
        if (normalized.length === 3) return null;
        // Claude Code CLI does not accept an explicit "none" value for --setting-sources.
        // If no sources are selected, omit the override so we don't break the invocation.
        if (normalized.length === 0) return null;
        const value = normalized.join(',');
        return ['--setting-sources', value];
    }

    const legacy = mode.claudeRemoteSettingSources;
    // Legacy "none" can't be represented as a Claude Code CLI flag; avoid passing an invalid value.
    if (legacy === 'none') return null;
    if (legacy === 'project') return ['--setting-sources', 'project'];
    if (legacy === 'user_project') return ['--setting-sources', 'user,project'];
    return null;
}

function isClaudeHookLifecycleStreamMessage(value: SDKMessage): boolean {
    return value.type === 'system'
        && (
            value.subtype === 'hook_started'
            || value.subtype === 'hook_progress'
            || value.subtype === 'hook_response'
        );
}

export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    transcriptPath: string | null,
    path: string,
    claudeArgs?: string[],
    /**
     * Optional MCP config JSON to inject into the Claude Code CLI invocation (e.g. Happier MCP).
     *
     * Claude Code merges multiple `--mcp-config` inputs additively and uses last-write-wins
     * when the same server name appears more than once.
     *
     * We intentionally append Happier's injected MCP config AFTER any user-provided `--mcp-config`
     * passthrough args so Happier wins on collisions (and so we don't need to parse/merge user JSON).
     */
    happierMcpConfigJson?: string,
    signal?: AbortSignal,
    /**
     * Registers a best-effort interrupt handler that can stop the current turn without
     * terminating the underlying Claude Code subprocess.
     *
     * Used by the remote launcher to implement UI "Abort" without losing context.
     */
    setTurnInterrupt?: ((handler: (() => Promise<void>) | null) => void) | null,
    canCallTool: (
        toolName: string,
        input: unknown,
        mode: EnhancedMode,
        options: { signal: AbortSignal; toolUseId?: string | null },
    ) => Promise<PermissionResult>,
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string,
    /** Session-scoped plugin whose hooks provide lifecycle and runtime-activity evidence. */
    hookPluginDir?: string | null,
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime,

    // Dynamic parameters
    nextMessage: () => Promise<ClaudeRemoteProviderAcceptedPrompt<EnhancedMode> | null>,
    onReady: () => void | Promise<void>,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (event: ClaudeCompletionEvent) => void,
    onSessionReset?: () => void,
    setUserMessageSender?: (sender: ((message: SDKUserMessage) => void) | null) => void,
    onPromptAcceptedByProvider?: ClaudeRemoteProviderPromptAcceptedHandler | null,
    onPromptTransportFailure?: ClaudeRemoteProviderPromptTransportFailureHandler | null,
    onProviderActivityObservationLost?: (() => void) | null,
    runtimeActivityAdapter?: ReturnType<typeof createClaudeProviderRuntimeActivityAdapter> | null,
    onWorkflowActivityObserverReady?: (() => void) | null,
}) {

    // Determine how we should (re)start the Claude session.
    //
    // IMPORTANT: do not "fail closed" to a fresh session just because our local transcript check
    // can't validate the session yet. That can cause context loss during fast local↔remote switching
    // (the session file may exist but not contain "uuid/messageId" lines yet).
    const { startFrom, shouldContinue } = resolveClaudeRemoteSessionStartPlan({
        sessionId: opts.sessionId,
        transcriptPath: opts.transcriptPath,
        path: opts.path,
        claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
        claudeArgs: opts.claudeArgs,
    });

    let compactionSequence = 0;
    let activeCompactionLifecycleId: string | null = null;
    const nextCompactionLifecycleId = () => buildClaudeCompactionLifecycleId({
        sessionId: opts.sessionId ?? startFrom,
        sequence: ++compactionSequence,
    });
    const emitManualCompactionStarted = () => {
        const lifecycleId = nextCompactionLifecycleId();
        activeCompactionLifecycleId = lifecycleId;
        opts.onCompletionEvent?.(buildClaudeCompactionStartedEvent({ lifecycleId }));
    };
    const emitCompactionCompleted = () => {
        const lifecycleId = activeCompactionLifecycleId ?? nextCompactionLifecycleId();
        activeCompactionLifecycleId = null;
        opts.onCompletionEvent?.(buildClaudeCompactionCompletedEvent({
            lifecycleId,
            source: 'provider-event',
        }));
    };

    // Get initial message
    const initial = await opts.nextMessage();
    if (!initial) { // No initial message - exit
        return;
    }

    // Handle special commands
    const specialCommand = parseSpecialCommand(initial.message);

    // Handle /clear command
    if (specialCommand.type === 'clear') {
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        return;
    }

    // Handle /compact command
    let isCompactCommand = false;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        emitManualCompactionStarted();
    }

    // Prepare SDK options
    let mode = initial.mode;
    const argOverrides = parseClaudeSdkFlagOverridesFromArgs(opts.claudeArgs);
    const customSystemPrompt = argOverrides.customSystemPrompt ?? initial.mode.customSystemPrompt;
    const appendSystemPrompt = argOverrides.appendSystemPrompt ?? initial.mode.appendSystemPrompt;
    const remoteSystemPrompt = getClaudeRemoteSystemPrompt({ disableTodos: initial.mode.claudeRemoteDisableTodos === true });

    const settingSourcesArgs = resolveSettingSourcesPassthroughArgs(mode);
    const passthroughMcpArgs = extractMcpConfigPassthroughArgs(opts.claudeArgs);
    const injectedMcpArgs =
        typeof opts.happierMcpConfigJson === 'string' && opts.happierMcpConfigJson.trim().length > 0
            ? ['--mcp-config', opts.happierMcpConfigJson.trim()]
            : null;
    const effortArgs = buildClaudeEffortArgs({
        modelId: argOverrides.model ?? initial.mode.model,
        effort: argOverrides.effort ?? initial.mode.reasoningEffort,
        supportedLevels: resolveModeEffortLevelsForModel(initial.mode, argOverrides.model ?? initial.mode.model),
    });
    const extraArgs = [
        ...(opts.hookPluginDir ? ['--plugin-dir', opts.hookPluginDir] : []),
        ...effortArgs,
        ...(settingSourcesArgs ?? []),
        ...(passthroughMcpArgs ?? []),
        ...(injectedMcpArgs ?? []),
    ];
    const runtimeExecutable = await ensureClaudeJsRuntimeExecutable(opts.jsRuntime);
    const resolvedClaudeCliPath = resolveClaudeCliPath();
    const launcherEnv = {
        ...resolveClaudeCodeExperimentalEnvOverlay({
            claudeCodeExperimentalAgentTeamsEnabled: mode.claudeCodeExperimentalAgentTeamsEnabled,
        }),
        ...resolveClaudeConfigDirEnvOverlay(process.env),
    };
    if (!launcherEnv.HAPPIER_CLAUDE_PATH && !launcherEnv.HAPPY_CLAUDE_PATH) {
        launcherEnv.HAPPIER_CLAUDE_PATH = resolvedClaudeCliPath;
    }
    logClaudeRuntimeAuthEnvDiagnostic({
        logPrefix: 'claudeRemote',
        sessionId: opts.sessionId,
        startFrom,
        runnerEnv: process.env,
        childEnv: launcherEnv,
    });

    const sdkOptions: QueryOptions = {
        cwd: opts.path,
        continue: shouldContinue || undefined,
        resume: startFrom ?? undefined,
        permissionMode: resolveClaudeSdkPermissionModeFromEnhancedMode(initial.mode),
        model: argOverrides.model ?? initial.mode.model,
        fallbackModel: argOverrides.fallbackModel ?? initial.mode.fallbackModel,
        maxTurns: argOverrides.maxTurns,
        customSystemPrompt: customSystemPrompt || undefined,
        appendSystemPrompt: (appendSystemPrompt ? appendSystemPrompt + '\n\n' : '') + remoteSystemPrompt,
        extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
        strictMcpConfig: argOverrides.strictMcpConfig,
        includeHookEvents: true,
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal; toolUseId?: string | null }) =>
            opts.canCallTool(toolName, input, mode, options),
        executable: runtimeExecutable,
        abort: opts.signal,
        pathToClaudeCodeExecutable: resolveCliRuntimeAssetPath('scripts', 'claude_remote_launcher.cjs'),
        env: launcherEnv,
        settingsPath: opts.hookSettingsPath,
    }

    // Track thinking state
    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[claudeRemote] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    type ProviderInputEnvelope = Readonly<{
        message: SDKUserMessage;
        acceptedPrompt?: ClaudeRemoteProviderAcceptedPrompt<EnhancedMode>;
    }>;
    const messages = new PushableAsyncIterable<ProviderInputEnvelope>();
    const pendingPromptByMessage = new WeakMap<object, ClaudeRemoteProviderAcceptedPrompt<EnhancedMode>>();
    const providerMessages: AsyncIterable<SDKUserMessage> = {
        async *[Symbol.asyncIterator]() {
            for await (const envelope of messages) {
                if (envelope.acceptedPrompt) {
                    pendingPromptByMessage.set(envelope.message, envelope.acceptedPrompt);
                }
                yield envelope.message;
            }
        },
    };
    // Start the loop
    const response = query({
        prompt: providerMessages,
        options: sdkOptions,
        onPromptTransportOutcome: (message, outcome) => {
            if (!message || typeof message !== 'object') return;
            const acceptedPrompt = pendingPromptByMessage.get(message);
            if (!acceptedPrompt) return;
            pendingPromptByMessage.delete(message);
            if (outcome === 'accepted') {
                confirmClaudeRemoteProviderPromptAccepted(
                    opts.onPromptAcceptedByProvider,
                    acceptedPrompt,
                );
                return;
            }
            reportClaudeRemoteProviderPromptTransportFailure(
                opts.onPromptTransportFailure,
                acceptedPrompt,
                outcome,
            );
        },
        onMessageReceived: (message) => {
            if (isClaudeHookLifecycleStreamMessage(message)) return;
            logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);
            opts.onMessage(message);
        },
    });
    opts.onWorkflowActivityObserverReady?.();
    await opts.runtimeActivityAdapter?.activateObservation('claude-legacy-provider-observer-installed');
    opts.setUserMessageSender?.((message: SDKUserMessage) => messages.push({ message }));
    messages.push({
        message: {
            type: 'user',
            message: {
                role: 'user',
                content: initial.message,
            },
        },
        acceptedPrompt: initial,
    });

    const interruptTurn = async (): Promise<void> => {
        try {
            const interrupt = (response as any)?.interrupt;
            if (typeof interrupt === 'function') {
                await interrupt.call(response);
            }
        } catch {
            // Best-effort: interrupt is optional and should not crash cancellation.
        } finally {
            updateThinking(false);
        }
    };
    opts.setTurnInterrupt?.(interruptTurn);

    updateThinking(true);
    let currentProviderSessionId = startFrom;
    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        for await (const message of response) {
            // NOTE: opts.onMessage is already called via onMessageReceived above.
            // This loop handles control flow only (result/init/abort).

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                // Start thinking when session initializes
                updateThinking(true);

                const systemInit = message as SDKSystemMessage;
                if (systemInit.session_id) {
                    currentProviderSessionId = systemInit.session_id;
                    // Do not block on filesystem writes here.
                    // The session scanner can handle missing files via watcher retries + UI warnings.
                    logger.debug(`[claudeRemote] Session initialized: ${systemInit.session_id}`);
                    opts.onSessionFound(systemInit.session_id);
                }
            }

            if (isClaudeLegacyRequiredHookObservationFailure(message, currentProviderSessionId)) {
                opts.onProviderActivityObservationLost?.();
            }

            // Handle result messages
            if (message.type === 'result') {
                updateThinking(false);
                logger.debug('[claudeRemote] Result received, exiting claudeRemote');

                // Send completion messages
                if (isCompactCommand) {
                    logger.debug('[claudeRemote] Compaction completed');
                    emitCompactionCompleted();
                    isCompactCommand = false;
                }

                // Send ready event
                await opts.onReady();

                // Push next message
                const next = await opts.nextMessage();
                if (!next) {
                    messages.end();
                    return;
                }
                mode = next.mode;
                messages.push({
                    message: { type: 'user', message: { role: 'user', content: next.message } },
                    acceptedPrompt: next,
                });
            }

            // Handle tool result
            if (message.type === 'user') {
                const msg = message as SDKUserMessage;
                if (msg.message.role === 'user' && Array.isArray(msg.message.content)) {
                    for (let c of msg.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id && opts.isAborted(c.tool_use_id)) {
                            logger.debug('[claudeRemote] Tool aborted, exiting claudeRemote');
                            return;
                        }
                    }
                }
            }
        }
    } catch (e) {
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        } else {
            throw e;
        }
    } finally {
        opts.setTurnInterrupt?.(null);
        opts.setUserMessageSender?.(null);
        updateThinking(false);
    }
}
