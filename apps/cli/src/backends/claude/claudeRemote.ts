import { EnhancedMode } from "./loop";
import { query, type QueryOptions, type SDKMessage, type SDKSystemMessage, AbortError, SDKUserMessage } from '@/backends/claude/sdk'
import { resolveClaudeSdkPermissionModeFromEnhancedMode } from "./utils/permissionMode";
import { join, resolve } from 'node:path';
import { projectPath } from "@/projectPath";
import { parseSpecialCommand } from "@/cli/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { PermissionResult } from "./sdk/types";
import type { JsRuntime } from "./runClaude";
import { getClaudeRemoteSystemPrompt } from "./utils/remoteSystemPrompt";
import { parseClaudeSdkFlagOverridesFromArgs } from "./remote/sdkFlagOverrides";
import { resolveClaudeRemoteSessionStartPlan } from "./remote/sessionStartPlan";
import { resolveClaudeConfigDirOverride } from "./utils/resolveClaudeConfigDirOverride";
import { resolveClaudeCodeExperimentalEnvOverlay } from "./spawn/resolveClaudeCodeExperimentalEnvOverlay";

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

export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    transcriptPath: string | null,
    path: string,
    claudeArgs?: string[],
    /**
     * Optional MCP config JSON to inject into the Claude Code CLI invocation (e.g. Happier MCP).
     * When set, this is prepended to any user-provided `--mcp-config` passthrough args.
     */
    happierMcpConfigJson?: string,
    signal?: AbortSignal,
    canCallTool: (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }) => Promise<PermissionResult>,
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string,
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: string, mode: EnhancedMode } | null>,
    onReady: () => void | Promise<void>,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void,
    setUserMessageSender?: (sender: ((message: SDKUserMessage) => void) | null) => void,
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
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

    // Prepare SDK options
    let mode = initial.mode;
    const argOverrides = parseClaudeSdkFlagOverridesFromArgs(opts.claudeArgs);
    const customSystemPrompt = argOverrides.customSystemPrompt ?? initial.mode.customSystemPrompt;
    const appendSystemPrompt = argOverrides.appendSystemPrompt ?? initial.mode.appendSystemPrompt;
    const remoteSystemPrompt = getClaudeRemoteSystemPrompt({ disableTodos: initial.mode.claudeRemoteDisableTodos === true });

    const passthroughMcpArgs = extractMcpConfigPassthroughArgs(opts.claudeArgs);
    const injectedMcpArgs =
        typeof opts.happierMcpConfigJson === 'string' && opts.happierMcpConfigJson.trim().length > 0
            ? ['--mcp-config', opts.happierMcpConfigJson.trim()]
            : null;
    const extraArgs = [...(injectedMcpArgs ?? []), ...(passthroughMcpArgs ?? [])];

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
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal }) =>
            opts.canCallTool(toolName, input, mode, options),
        executable: opts.jsRuntime ?? 'node',
        abort: opts.signal,
        pathToClaudeCodeExecutable: (() => {
            return resolve(join(projectPath(), 'scripts', 'claude_remote_launcher.cjs'));
        })(),
        env: resolveClaudeCodeExperimentalEnvOverlay({
            claudeCodeExperimentalAgentTeamsEnabled: mode.claudeCodeExperimentalAgentTeamsEnabled,
        }),
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

    // Push initial message
    let messages = new PushableAsyncIterable<SDKUserMessage>();
    opts.setUserMessageSender?.((message: SDKUserMessage) => messages.push(message));
    messages.push({
        type: 'user',
        message: {
            role: 'user',
            content: initial.message,
        },
    });

    // Start the loop
    const response = query({
        prompt: messages,
        options: sdkOptions,
        onMessageReceived: (message) => {
            logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);
            opts.onMessage(message);
        },
    });

    updateThinking(true);
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
                    // Do not block on filesystem writes here.
                    // The session scanner can handle missing files via watcher retries + UI warnings.
                    logger.debug(`[claudeRemote] Session initialized: ${systemInit.session_id}`);
                    opts.onSessionFound(systemInit.session_id);
                }
            }

            // Handle result messages
            if (message.type === 'result') {
                updateThinking(false);
                logger.debug('[claudeRemote] Result received, exiting claudeRemote');

                // Send completion messages
                if (isCompactCommand) {
                    logger.debug('[claudeRemote] Compaction completed');
                    if (opts.onCompletionEvent) {
                        opts.onCompletionEvent('Compaction completed');
                    }
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
                messages.push({ type: 'user', message: { role: 'user', content: next.message } });
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
        opts.setUserMessageSender?.(null);
        updateThinking(false);
    }
}
