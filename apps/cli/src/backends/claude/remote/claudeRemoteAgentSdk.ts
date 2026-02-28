import { query as agentSdkQuery, AbortError as AgentSdkAbortError, type Query as AgentSdkQueryType } from '@anthropic-ai/claude-agent-sdk';

import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import { logger } from '@/lib';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { recordToolTraceEvent } from '@/agent/tools/trace/toolTrace';

import type { EnhancedMode } from '@/backends/claude/loop';
import { resolveClaudeSdkPermissionModeFromEnhancedMode } from '@/backends/claude/utils/permissionMode';
import { getDefaultClaudeCodePathForAgentSdk } from '@/backends/claude/sdk/utils';
import type { SessionHookData } from '@/backends/claude/utils/startHookServer';
import { getProjectPath } from '@/backends/claude/utils/path';
import { getClaudeRemoteSystemPrompt } from '@/backends/claude/utils/remoteSystemPrompt';
import { normalizeClaudeToolUseNamesInSdkMessage } from '@/backends/claude/utils/normalizeClaudeToolUseNames';
import { parseClaudeSdkFlagOverridesFromArgs } from '@/backends/claude/remote/sdkFlagOverrides';
import { resolveClaudeRemoteSessionStartPlan } from '@/backends/claude/remote/sessionStartPlan';
import { tryMergeUserMcpConfigArgsIntoHappierMcp } from '@/backends/claude/utils/mcpConfigMerge';
import { parseCheckpointsCommand, parseRewindCommand } from './agentSdk/claudeAgentSdkSlashCommands';
import { parseExplicitSpawnEnvKeysFromProcessEnv } from './agentSdk/explicitSpawnEnvKeysMarker';
import { buildClaudeAgentSdkHooks } from './agentSdk/buildClaudeAgentSdkHooks';
import {
    extractTextDeltaFromStreamEvent,
    extractToolResultStartFromStreamEvent,
    extractToolUseInputJsonDeltaFromStreamEvent,
    extractToolUseStartFromStreamEvent,
    isContentBlockStopStreamEvent,
    messageContainsToolResultForToolUseId,
    messageContainsToolUseId,
    recordSeenToolBlocks,
    stripSeenToolBlocksFromMessage,
} from './agentSdk/streamEventToolBlocks';

import type { SDKMessage, SDKSystemMessage, SDKUserMessage } from '@/backends/claude/sdk';
import type { PermissionResult } from '@/backends/claude/sdk/types';
import type { JsRuntime } from '@/backends/claude/runClaude';
import { createSubprocessStderrAppender, resolveSubprocessArtifactsDir } from '@/agent/runtime/subprocessArtifacts';
import { join } from 'node:path';
import type { McpServerConfig } from '@/agent';

type AgentSdkQueryFactory = (params: {
    prompt: string | AsyncIterable<any>;
    options?: Record<string, unknown>;
}) => AgentSdkQueryType;

function argsContainMcpConfigFlag(args?: readonly string[] | null): boolean {
    if (!args || args.length === 0) return false;
    for (const arg of args) {
        if (arg === '--mcp-config') return true;
        if (typeof arg === 'string' && arg.startsWith('--mcp-config=')) return true;
    }
    return false;
}




export async function claudeRemoteAgentSdk(opts: {
	    // Fixed parameters
	    sessionId: string | null;
	    transcriptPath: string | null;
	    path: string;
	    claudeEnvVars?: Record<string, string>;
	    claudeArgs?: string[];
    claudeExecutablePath?: string;
    /** Optional anchor UUID for resuming at a specific assistant message. */
    resumeSessionAt?: string | null;
    /**
     * Optional MCP servers to inject into the Claude Agent SDK invocation (e.g. Happier MCP).
     * This should be additive with the user's config (no strict MCP unless explicitly requested).
     */
    happierMcpServers?: Record<string, McpServerConfig>;
    signal?: AbortSignal;
    canCallTool: (
        toolName: string,
        input: unknown,
        mode: EnhancedMode,
        options: {
            signal: AbortSignal;
            toolUseId?: string | null;
            agentId?: string | null;
            suggestions?: unknown;
            blockedPath?: string | null;
            decisionReason?: string | null;
        },
    ) => Promise<PermissionResult>;
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime;

    // Dynamic parameters
    nextMessage: () => Promise<{ message: string; mode: EnhancedMode } | null>;
    onReady: () => void | Promise<void>;
    isAborted: (toolCallId: string) => boolean;

    // Callbacks
    onSessionFound: (id: string, data?: SessionHookData) => void;
    onThinkingChange?: (thinking: boolean) => void;
    onMessage: (message: SDKMessage) => void;
    onCompletionEvent?: (message: string) => void;
    onSessionReset?: () => void;
    setUserMessageSender?: (sender: ((message: SDKUserMessage) => void) | null) => void;
    onCheckpointCaptured?: (checkpointId: string) => void;
    onCapabilities?: (caps: { slashCommands?: string[]; slashCommandDetails?: Array<{ command: string; description?: string }>; models?: unknown[] }) => void;

    // Test seam
    createQuery?: AgentSdkQueryFactory;
}) {
    const emitMessage = (message: SDKMessage) => {
        opts.onMessage(normalizeClaudeToolUseNamesInSdkMessage(message));
    };

    const recordTraceMarker = (params: { kind: string; payload: Record<string, unknown> }) => {
        recordToolTraceEvent({
            direction: 'outbound',
            sessionId: opts.sessionId ?? 'unknown',
            protocol: 'claude',
            provider: 'claude',
            kind: params.kind,
            payload: params.payload,
        });
    };

        const mergedMcp = tryMergeUserMcpConfigArgsIntoHappierMcp({
        baseMcpServers: opts.happierMcpServers ?? {},
        claudeArgs: effectiveClaudeArgs,
    });
    if (argsContainMcpConfigFlag(opts.claudeArgs) && !mergedMcp) {
        throw new Error('Invalid --mcp-config: expected JSON object with a { "mcpServers": { ... } } field.');
    }
    const effectiveClaudeArgs = mergedMcp ? mergedMcp.filteredClaudeArgs : opts.claudeArgs;
    const effectiveMcpServers = mergedMcp ? mergedMcp.mergedMcpServers : opts.happierMcpServers;

const { startFrom, shouldContinue } = resolveClaudeRemoteSessionStartPlan({
        sessionId: opts.sessionId,
        transcriptPath: opts.transcriptPath,
        path: opts.path,
        claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
        claudeArgs: effectiveClaudeArgs,
    }, {
        logPrefix: 'claudeRemoteAgentSdk',
    });

    const initial = await opts.nextMessage();
    if (!initial) return;

    const specialCommand = parseSpecialCommand(initial.message);
    if (specialCommand.type === 'clear') {
        opts.onCompletionEvent?.('Context was reset');
        opts.onSessionReset?.();
        return;
    }

    let isCompactCommand = false;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemoteAgentSdk] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        opts.onCompletionEvent?.('Compaction started');
    }

    let mode = initial.mode;

    const argOverrides = parseClaudeSdkFlagOverridesFromArgs(effectiveClaudeArgs);
    const customSystemPrompt = argOverrides.customSystemPrompt ?? mode.customSystemPrompt;
    const appendSystemPrompt = argOverrides.appendSystemPrompt ?? mode.appendSystemPrompt;
    const remoteSystemPrompt = getClaudeRemoteSystemPrompt({ disableTodos: mode.claudeRemoteDisableTodos === true });
    const enableFileCheckpointing = mode.claudeRemoteEnableFileCheckpointing === true;
    const settingSources = (() => {
        const value = mode.claudeRemoteSettingSources;
        if (value === 'none') return [];
        if (value === 'user_project') return ['user', 'project'];
        if (value === 'project') return ['project'];
        // Default: do not force settingSources so Claude can apply its own defaults
        // (which includes loading user configuration).
        return undefined;
    })();
    const advancedOptionsJsonRaw = typeof mode.claudeRemoteAdvancedOptionsJson === 'string'
        ? mode.claudeRemoteAdvancedOptionsJson.trim()
        : '';
    let advancedOptions: Record<string, unknown> | null = null;
    if (advancedOptionsJsonRaw.length > 0) {
        try {
            const parsed = JSON.parse(advancedOptionsJsonRaw) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                advancedOptions = parsed as Record<string, unknown>;
            } else {
                opts.onCompletionEvent?.('Invalid advanced Claude options JSON (must be an object); ignoring.');
            }
        } catch {
            opts.onCompletionEvent?.('Invalid advanced Claude options JSON; ignoring.');
        }
    }

    const abortController = new AbortController();
    const abortSignal = abortController.signal;
    if (opts.signal) {
        if (opts.signal.aborted) {
            abortController.abort();
        } else {
            opts.signal.addEventListener('abort', () => abortController.abort(), { once: true });
        }
    }

    const createQuery: AgentSdkQueryFactory = opts.createQuery ?? ((params) => agentSdkQuery(params as any) as any);

    const stderrAppender = await createSubprocessStderrAppender({
        agentName: 'claude',
        pid: process.pid,
        label: 'claude-code',
    });
    const debugFilePath = stderrAppender
        ? join(
            resolveSubprocessArtifactsDir({ agentName: 'claude' }),
            `claude-code-debug-${Date.now()}-pid-${process.pid}.log`,
        )
        : undefined;


    const built = buildClaudeAgentSdkHooks({
        cwd: opts.path,
        claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
        getMode: () => mode,
        onSessionFound: opts.onSessionFound,
        canCallTool: opts.canCallTool,
    });

    const buildSystemPrompt = (): any => {
        if (customSystemPrompt) {
            return `${customSystemPrompt}\n\n${remoteSystemPrompt}`;
        }

        const append = (appendSystemPrompt ? `${appendSystemPrompt}\n\n` : '') + remoteSystemPrompt;
        return { type: 'preset', preset: 'claude_code', append };
    };

    const buildClaudeSubprocessEnv = (): Record<string, string> => {
        const allowExact = new Set<string>([
            'PATH',
            'HOME',
            'USER',
            'LOGNAME',
            'SHELL',
            'TERM',
            'LANG',
            'LC_ALL',
            'LC_CTYPE',
            'TMPDIR',
            'TEMP',
            'TMP',
            'SSH_AUTH_SOCK',
            'HTTP_PROXY',
            'HTTPS_PROXY',
            'NO_PROXY',
            'SSL_CERT_FILE',
            'SSL_CERT_DIR',
            '__CF_USER_TEXT_ENCODING',
            // Allow E2E harnesses to observe Claude subprocess invocations when using the fake CLI.
            // These are inert unless the tests explicitly set them.
            'HAPPIER_E2E_FAKE_CLAUDE_LOG',
            'HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID',
            'HAPPY_E2E_FAKE_CLAUDE_LOG',
            'HAPPY_E2E_FAKE_CLAUDE_SESSION_ID',
        ]);
        if (process.platform === 'win32') {
            for (const key of ['USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR']) {
                allowExact.add(key);
            }
        }
        const allowPrefixes = [
            'XDG_',
            'CLAUDE_',
            'ANTHROPIC_',
            'FORCE_COLOR',
            'NO_COLOR',
            'COLORTERM',
            'TERM_',
            // E2E harness env markers (safe to pass-through; ignored in production runs).
            'HAPPIER_E2E_',
            'HAPPY_E2E_',
        ];

        const explicitSpawnEnvKeys = new Set(parseExplicitSpawnEnvKeysFromProcessEnv(process.env));

        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (typeof value !== 'string') continue;
            if (explicitSpawnEnvKeys.has(key) || allowExact.has(key) || allowPrefixes.some((p) => key.startsWith(p))) {
                out[key] = value;
            }
        }

        delete out.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON;

        return { ...out, ...(opts.claudeEnvVars ?? {}) };
    };

    const mappedPermissionMode = resolveClaudeSdkPermissionModeFromEnhancedMode(mode);
    const resumeSessionAt =
        typeof opts.resumeSessionAt === 'string' && opts.resumeSessionAt.trim().length > 0
            ? opts.resumeSessionAt.trim()
            : null;
	    const queryOptions: Record<string, unknown> = {
	        abortController,
	        cwd: opts.path,
	        continue: shouldContinue || undefined,
	        resume: startFrom ?? undefined,
	        ...(startFrom && resumeSessionAt ? { resumeSessionAt } : {}),
	        permissionMode: mappedPermissionMode,
	        allowDangerouslySkipPermissions: mappedPermissionMode === 'bypassPermissions',
	        model: argOverrides.model ?? mode.model,
        fallbackModel: argOverrides.fallbackModel ?? mode.fallbackModel,
        maxTurns: argOverrides.maxTurns,
        systemPrompt: buildSystemPrompt(),
        strictMcpConfig: mode.claudeRemoteStrictMcpServerConfig === true || argOverrides.strictMcpConfig,
        canUseTool: built.canUseTool,
        ...(effectiveMcpServers ? { mcpServers: effectiveMcpServers } : {}),
        env: buildClaudeSubprocessEnv(),
        executable: opts.jsRuntime ?? 'node',
        pathToClaudeCodeExecutable: opts.claudeExecutablePath ?? getDefaultClaudeCodePathForAgentSdk(),
        includePartialMessages: mode.claudeRemoteIncludePartialMessages === true || undefined,
        enableFileCheckpointing: enableFileCheckpointing || undefined,
        extraArgs: enableFileCheckpointing ? { 'replay-user-messages': null } : undefined,
        maxThinkingTokens: typeof mode.claudeRemoteMaxThinkingTokens === 'number' ? mode.claudeRemoteMaxThinkingTokens : undefined,
        hooks: built.hooks,
    };

    if (settingSources !== undefined) {
        queryOptions.settingSources = settingSources;
    }

    if (debugFilePath) {
        queryOptions.debugFile = debugFilePath;
    }
    if (stderrAppender) {
        queryOptions.stderr = (data: string) => {
            stderrAppender.append(data);
        };
    }

    if (advancedOptions) {
        const allowlistedKeys = [
            'plugins',
            'betas',
            'maxBudgetUsd',
            'sandbox',
            'additionalDirectories',
            'permissionPromptToolName',
            'tools',
            'systemPrompt',
            'debug',
            'debugFile',
            'stderr',
        ] as const;

        for (const key of allowlistedKeys) {
            if (Object.prototype.hasOwnProperty.call(advancedOptions, key)) {
                const value = advancedOptions[key];
                if (key === 'stderr') {
                    if (typeof value === 'function') queryOptions[key] = value;
                    continue;
                }
                if (key === 'debugFile') {
                    if (typeof value === 'string') queryOptions[key] = value;
                    continue;
                }
                if (key === 'debug') {
                    if (typeof value === 'boolean') queryOptions[key] = value;
                    continue;
                }
                queryOptions[key] = value;
            }
        }
    }

    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            opts.onThinkingChange?.(thinking);
        }
    };

    const messages = new PushableAsyncIterable<any>();
    opts.setUserMessageSender?.((message: SDKUserMessage) => messages.push(message));

    messages.push({
        type: 'user',
        session_id: '',
        parent_tool_use_id: null,
        message: {
            role: 'user',
            content: [{ type: 'text', text: initial.message }],
        },
    });

    let response: any;
    let nextMessagePump: Promise<void> | null = null;
    const swallowOptionalPromise = async (promise: Promise<void> | null): Promise<void> => {
        if (!promise) return;
        await promise.catch(() => {});
    };
    try {
        response = createQuery({
            prompt: messages,
            options: queryOptions,
        });

        updateThinking(true);
        let streamingToolUse:
            | { sessionId: string; id: string; name: string; inputJson: string; initialInput: unknown }
            | null = null;
        let streamingToolResult: { sessionId: string; toolUseId: string; content: string } | null = null;
        let pendingToolUseMessage: { toolUseId: string; message: SDKMessage } | null = null;
        let pendingToolResultMessage: { toolUseId: string; message: SDKMessage } | null = null;
        const seen = { toolUseIds: new Set<string>(), toolResultIds: new Set<string>() };
        let lastCheckpointId: string | null = null;
        const checkpointIds: string[] = [];
        const checkpointIdSet = new Set<string>();

        function recordCheckpointId(id: string) {
            if (checkpointIdSet.has(id)) return;
            checkpointIdSet.add(id);
            checkpointIds.push(id);
        }

        const ABORTED = Symbol('aborted');
        const waitForAbort = (signal: AbortSignal): Promise<typeof ABORTED> =>
            new Promise((resolve) => {
                if (signal.aborted) {
                    resolve(ABORTED);
                    return;
                }
                signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
            });

        const scheduleNextMessagePump = () => {
            if (nextMessagePump) return;

            nextMessagePump = (async () => {
                try {
                    while (!abortSignal.aborted) {
                        const nextOrAbort = await Promise.race([opts.nextMessage(), waitForAbort(abortSignal)]);
                        if (nextOrAbort === ABORTED) {
                            return;
                        }

                        const next = nextOrAbort as { message: string; mode: EnhancedMode } | null;
                        if (!next) {
                            messages.end();
                            try {
                                response?.close?.();
                            } catch {
                                // ignore
                            }
                            return;
                        }

                        const checkpointsCommand = parseCheckpointsCommand(next.message);
                        if (checkpointsCommand) {
                            if (!enableFileCheckpointing) {
                                opts.onCompletionEvent?.('No checkpoints are available unless file checkpointing is enabled.');
                                continue;
                            }

                            if (checkpointIds.length === 0) {
                                opts.onCompletionEvent?.('No checkpoints have been captured yet.');
                                continue;
                            }

                            opts.onCompletionEvent?.(
                                [
                                    'Available checkpoints (newest first):',
                                    ...checkpointIds
                                        .slice()
                                        .reverse()
                                        .map((id) => `- ${id}`),
                                    '',
                                    'Note: Agent SDK rewind restores files only; it does not rewind the conversation.',
                                    'To rewind: /rewind <checkpoint-id> --confirm',
                                ].join('\n'),
                            );
                            continue;
                        }

                        const rewindCommand = parseRewindCommand(next.message);
                        if (rewindCommand) {
                            if (!enableFileCheckpointing) {
                                opts.onCompletionEvent?.('Rewind is not available unless file checkpointing is enabled.');
                                continue;
                            }

                            const checkpointId = rewindCommand.checkpointId ?? lastCheckpointId;
                            if (!checkpointId) {
                                opts.onCompletionEvent?.('No checkpoint id is available yet. Send a normal message first, then try /rewind again.');
                                continue;
                            }

                            if (!rewindCommand.confirmed) {
                                opts.onCompletionEvent?.(
                                    [
                                        'Rewind is a destructive filesystem operation.',
                                        'It restores files to a previous checkpoint and may discard your local file edits.',
                                        '',
                                        'Important: Agent SDK rewind restores files only; it does not rewind the conversation.',
                                        '',
                                        `To confirm, re-run: /rewind ${checkpointId} --confirm`,
                                    ].join('\n'),
                                );
                                continue;
                            }

                            const result = await (response as any).rewindFiles?.(checkpointId, undefined);
                            if (result && typeof result === 'object' && (result as any).canRewind === false) {
                                const error = typeof (result as any).error === 'string' ? (result as any).error : 'Rewind failed';
                                opts.onCompletionEvent?.(error);
                                continue;
                            }

                            emitMessage({
                                type: 'system',
                                subtype: 'happier',
                                happierTraceMarker: 'checkpoint-rewind',
                                checkpointId,
                            } as any);
                            recordTraceMarker({ kind: 'checkpoint-rewind', payload: { marker: 'checkpoint-rewind', checkpointId } });
                            opts.onCompletionEvent?.(`Rewound files to checkpoint ${checkpointId}`);
                            continue;
                        }

                        const nextSpecial = parseSpecialCommand(next.message);
                        if (nextSpecial.type === 'clear') {
                            opts.onCompletionEvent?.('Context was reset');
                            opts.onSessionReset?.();
                            messages.end();
                            try {
                                response?.close?.();
                            } catch {
                                // ignore
                            }
                            return;
                        }

                        if (nextSpecial.type === 'compact') {
                            isCompactCommand = true;
                            opts.onCompletionEvent?.('Compaction started');
                        }

                        mode = next.mode;

                        try {
                            await (response as any).setPermissionMode?.(resolveClaudeSdkPermissionModeFromEnhancedMode(mode));
                            await (response as any).setModel?.(mode.model ?? undefined);
                            if (
                                typeof mode.claudeRemoteMaxThinkingTokens === 'number' ||
                                mode.claudeRemoteMaxThinkingTokens === null
                            ) {
                                await (response as any).setMaxThinkingTokens?.(mode.claudeRemoteMaxThinkingTokens ?? null);
                            }
                        } catch (e) {
                            logger.debug('[claudeRemoteAgentSdk] Failed to update runtime settings (non-fatal)', e);
                            opts.onCompletionEvent?.('Failed to update runtime settings (non-fatal); continuing.');
                        }

                        messages.push({
                            type: 'user',
                            session_id: '',
                            parent_tool_use_id: null,
                            message: {
                                role: 'user',
                                content: [{ type: 'text', text: next.message }],
                            },
                        });

                        updateThinking(true);
                        return;
                    }
                } finally {
                    nextMessagePump = null;
                }
            })();
        };

        // Fire-and-forget capability publication.
        // This must not block the main streaming loop.
        const onCapabilities = opts.onCapabilities;
        if (onCapabilities) {
            void (async () => {
                try {
                    const [commandsResult, modelsResult] = await Promise.allSettled([
                        (response as any).supportedCommands?.(),
                        (response as any).supportedModels?.(),
                    ]);

                    const commandsRaw = commandsResult.status === 'fulfilled' ? commandsResult.value : null;
                    const modelsRaw = modelsResult.status === 'fulfilled' ? modelsResult.value : null;

                    const commandDetails = Array.isArray(commandsRaw)
                        ? commandsRaw
                            .map((cmd: any) => ({
                                command: typeof cmd?.command === 'string' ? cmd.command : null,
                                description: typeof cmd?.description === 'string' ? cmd.description : undefined,
                            }))
                            .filter((cmd: any) => typeof cmd.command === 'string' && cmd.command.length > 0)
                        : [];

                    onCapabilities({
                        ...(commandDetails.length > 0
                            ? {
                                slashCommands: commandDetails.map((c: any) => c.command),
                                slashCommandDetails: commandDetails,
                            }
                            : {}),
                        ...(Array.isArray(modelsRaw) ? { models: modelsRaw } : {}),
                    });
                } catch {
                    // ignore
                }
            })();
        }

        for await (const message of response as any) {
            if (message && typeof message === 'object' && (message as any).type === 'stream_event') {
                const toolUseStart = extractToolUseStartFromStreamEvent(message);
                if (toolUseStart) {
                    streamingToolUse = {
                        sessionId: typeof (message as any).session_id === 'string' ? (message as any).session_id : '',
                        id: toolUseStart.id,
                        name: toolUseStart.name,
                        inputJson: '',
                        initialInput: toolUseStart.input,
                    };
                    continue;
                }

                const toolResultStart = extractToolResultStartFromStreamEvent(message);
                if (toolResultStart) {
                    streamingToolResult = {
                        sessionId: typeof (message as any).session_id === 'string' ? (message as any).session_id : '',
                        toolUseId: toolResultStart.toolUseId,
                        content: '',
                    };
                    continue;
                }

                const toolUseInputDelta = extractToolUseInputJsonDeltaFromStreamEvent(message);
                if (toolUseInputDelta && streamingToolUse) {
                    streamingToolUse.inputJson += toolUseInputDelta;
                    continue;
                }

                const textDelta = extractTextDeltaFromStreamEvent(message);
                if (textDelta) {
                    if (streamingToolResult) {
                        streamingToolResult.content += textDelta;
                        continue;
                    }
                    if (mode.claudeRemoteIncludePartialMessages === true) {
                        emitMessage({
                            type: 'assistant',
                            happierPartial: true,
                            session_id: (message as any).session_id,
                            parent_tool_use_id: null,
                            message: {
                                role: 'assistant',
                                content: [{ type: 'text', text: textDelta }],
                            },
                        } as any);
                    }
                    continue;
                }

                if (isContentBlockStopStreamEvent(message)) {
                    if (streamingToolUse) {
                        if (seen.toolUseIds.has(streamingToolUse.id)) {
                            streamingToolUse = null;
                            continue;
                        }
                        const inputFromJson = (() => {
                            const raw = streamingToolUse.inputJson.trim();
                            if (!raw) return null;
                            try {
                                return JSON.parse(raw) as unknown;
                            } catch {
                                return null;
                            }
                        })();

                        pendingToolUseMessage = {
                            toolUseId: streamingToolUse.id,
                            message: {
                            type: 'assistant',
                            session_id: streamingToolUse.sessionId,
                            parent_tool_use_id: null,
                            message: {
                                role: 'assistant',
                                content: [
                                    {
                                        type: 'tool_use',
                                        id: streamingToolUse.id,
                                        name: streamingToolUse.name,
                                        input: inputFromJson ?? streamingToolUse.initialInput ?? {},
                                    },
                                ],
                            },
                        } as any,
                        };

                        streamingToolUse = null;
                        continue;
                    }

                    if (streamingToolResult) {
                        if (seen.toolResultIds.has(streamingToolResult.toolUseId)) {
                            streamingToolResult = null;
                            continue;
                        }
                        pendingToolResultMessage = {
                            toolUseId: streamingToolResult.toolUseId,
                            message: {
                                type: 'user',
                            session_id: streamingToolResult.sessionId,
                            parent_tool_use_id: null,
                            message: {
                                role: 'user',
                                content: [
                                    {
                                        type: 'tool_result',
                                        tool_use_id: streamingToolResult.toolUseId,
                                        content: streamingToolResult.content,
                                        is_error: false,
                                    },
                                ],
                            },
                        } as any,
                        };
                        streamingToolResult = null;
                        continue;
                    }
                }

                continue;
            }

            // If we reconstructed tool blocks from stream events, prefer the assembled SDK message when it arrives
            // (avoid double-emitting the same tool_use/tool_result).
            //
            // Important: Claude Code can emit system/status/progress messages between stream_event stop and the
            // assembled assistant/user message. Do not flush pending tool blocks on those intermediary messages.
            const messageType = (message as any)?.type;
            if (pendingToolUseMessage && (messageType === 'assistant' || messageType === 'user' || messageType === 'result')) {
                if (messageContainsToolUseId(message, pendingToolUseMessage.toolUseId)) {
                    pendingToolUseMessage = null;
                } else if (messageType === 'user' && !messageContainsToolResultForToolUseId(message, pendingToolUseMessage.toolUseId)) {
                    // Not a boundary that implies the tool ran (tool_result) and not the assembled tool_use;
                    // keep buffering so we can still dedupe when the assistant tool_use arrives.
                } else {
                    const deduped = stripSeenToolBlocksFromMessage(pendingToolUseMessage.message, seen);
                    if (deduped) {
                        emitMessage(deduped);
                        recordSeenToolBlocks(deduped, seen);
                    }
                    pendingToolUseMessage = null;
                }
            }

            if (pendingToolResultMessage && (messageType === 'assistant' || messageType === 'user' || messageType === 'result')) {
                if (messageContainsToolResultForToolUseId(message, pendingToolResultMessage.toolUseId)) {
                    pendingToolResultMessage = null;
                } else {
                    const deduped = stripSeenToolBlocksFromMessage(pendingToolResultMessage.message, seen);
                    if (deduped) {
                        emitMessage(deduped);
                        recordSeenToolBlocks(deduped, seen);
                    }
                    pendingToolResultMessage = null;
                }
            }

            const sdkMessage = message as SDKMessage;
            const deduped = stripSeenToolBlocksFromMessage(sdkMessage, seen);
            if (!deduped) continue;
            emitMessage(deduped);
            recordSeenToolBlocks(deduped, seen);

            if (message && message.type === 'system' && message.subtype === 'init') {
                const init = message as SDKSystemMessage;
                if (init.session_id) {
                    const transcriptPath = join(
                        getProjectPath(opts.path, resolveClaudeConfigDirOverride(process.env)),
                        `${init.session_id}.jsonl`,
                    );
                    opts.onSessionFound(init.session_id, { transcript_path: transcriptPath, transcriptPath });
                }
            }

            if (message && message.type === 'user') {
                const msg = message as any;
                const isUserTextMessage =
                    msg.message?.role === 'user' &&
                    ((typeof msg.message.content === 'string' && msg.message.content.trim().length > 0) ||
                        (Array.isArray(msg.message.content) &&
                            msg.message.content.some(
                                (c: any) => c?.type === 'text' && typeof c.text === 'string' && c.text.trim().length > 0,
                            )));

                if (
                    enableFileCheckpointing &&
                    isUserTextMessage &&
                    typeof msg.uuid === 'string' &&
                    msg.uuid.length > 0 &&
                    msg.uuid !== lastCheckpointId
                ) {
                    lastCheckpointId = msg.uuid;
                    recordCheckpointId(msg.uuid);
                    opts.onCheckpointCaptured?.(msg.uuid);
                }
                if (msg.message?.role === 'user' && Array.isArray(msg.message.content)) {
                    for (const c of msg.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id && opts.isAborted(c.tool_use_id)) {
                            logger.debug('[claudeRemoteAgentSdk] Tool aborted, exiting claudeRemoteAgentSdk');
                            return;
                        }
                    }
                }
            }

            if (message && message.type === 'result') {
                updateThinking(false);

                if (isCompactCommand) {
                    opts.onCompletionEvent?.('Compaction completed');
                    isCompactCommand = false;
                }

                await opts.onReady();
                scheduleNextMessagePump();
            }
        }
    } catch (e) {
        if (e instanceof AgentSdkAbortError) {
            logger.debug('[claudeRemoteAgentSdk] Aborted');
            return;
        }
        throw e;
    } finally {
        opts.setUserMessageSender?.(null);
        updateThinking(false);
        abortController.abort();
        await swallowOptionalPromise(nextMessagePump);
        try {
            response?.close();
        } catch {
            // ignore
        }
        await stderrAppender?.close().catch(() => {});
    }
}
