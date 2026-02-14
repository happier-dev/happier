import { query as agentSdkQuery, AbortError as AgentSdkAbortError, type Query as AgentSdkQueryType } from '@anthropic-ai/claude-agent-sdk';

import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import { logger } from '@/lib';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { recordToolTraceEvent } from '@/agent/tools/trace/toolTrace';

import type { EnhancedMode } from '@/backends/claude/loop';
import { mapToClaudeMode } from '@/backends/claude/utils/permissionMode';
import { getDefaultClaudeCodePathForAgentSdk } from '@/backends/claude/sdk/utils';
import type { SessionHookData } from '@/backends/claude/utils/startHookServer';
import { getProjectPath } from '@/backends/claude/utils/path';
import { getClaudeRemoteSystemPrompt } from '@/backends/claude/utils/remoteSystemPrompt';
import { parseClaudeSdkFlagOverridesFromArgs } from '@/backends/claude/remote/sdkFlagOverrides';
import { resolveClaudeRemoteSessionStartPlan } from '@/backends/claude/remote/sessionStartPlan';

import type { SDKMessage, SDKSystemMessage, SDKUserMessage } from '@/backends/claude/sdk';
import type { PermissionResult } from '@/backends/claude/sdk/types';
import type { JsRuntime } from '@/backends/claude/runClaude';
import { createSubprocessStderrAppender, resolveSubprocessArtifactsDir } from '@/agent/runtime/subprocessArtifacts';
import { join } from 'node:path';

type AgentSdkQueryFactory = (params: {
    prompt: string | AsyncIterable<any>;
    options?: Record<string, unknown>;
}) => AgentSdkQueryType;

function parseRewindCommand(message: string): { type: 'rewind'; checkpointId?: string; confirmed: boolean } | null {
    const trimmed = message.trim();
    if (!trimmed.startsWith('/rewind')) return null;

    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts[0] !== '/rewind') return null;

    let checkpointId: string | undefined;
    let confirmed = false;

    for (const part of parts.slice(1)) {
        if (part === '--confirm' || part === '--yes' || part === '-y') {
            confirmed = true;
            continue;
        }

        if (part.startsWith('-')) continue;
        if (!checkpointId) checkpointId = part;
    }

    return { type: 'rewind', checkpointId, confirmed };
}

function parseCheckpointsCommand(message: string): { type: 'checkpoints' } | null {
    const trimmed = message.trim();
    if (trimmed === '/checkpoints') return { type: 'checkpoints' };
    return null;
}

function toAgentSdkPermissionResult(result: PermissionResult): any {
    if (result.behavior === 'allow') {
        return {
            behavior: 'allow',
            updatedInput: result.updatedInput,
        };
    }

    return {
        behavior: 'deny',
        message: result.message,
        ...(result.interrupt !== undefined ? { interrupt: result.interrupt } : {}),
    };
}

function extractTextDeltaFromStreamEvent(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;
    const m = message as any;
    if (m.type !== 'stream_event') return null;

    const event = m.event;
    if (!event || typeof event !== 'object') return null;
    if (event.type !== 'content_block_delta') return null;

    const delta = event.delta;
    if (!delta || typeof delta !== 'object') return null;
    if (delta.type !== 'text_delta') return null;

    return typeof delta.text === 'string' ? delta.text : null;
}

export async function claudeRemoteAgentSdk(opts: {
    // Fixed parameters
    sessionId: string | null;
    transcriptPath: string | null;
    path: string;
    mcpServers?: Record<string, any>;
    claudeEnvVars?: Record<string, string>;
    claudeArgs?: string[];
    claudeExecutablePath?: string;
    allowedTools: string[];
    signal?: AbortSignal;
    canCallTool: (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }) => Promise<PermissionResult>;
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime;

    // Dynamic parameters
    nextMessage: () => Promise<{ message: string; mode: EnhancedMode } | null>;
    onReady: () => void;
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

    const { startFrom, shouldContinue } = resolveClaudeRemoteSessionStartPlan({
        sessionId: opts.sessionId,
        transcriptPath: opts.transcriptPath,
        path: opts.path,
        claudeConfigDir: opts.claudeEnvVars?.CLAUDE_CONFIG_DIR ?? null,
        claudeArgs: opts.claudeArgs,
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

    const argOverrides = parseClaudeSdkFlagOverridesFromArgs(opts.claudeArgs);
    const customSystemPrompt = argOverrides.customSystemPrompt ?? mode.customSystemPrompt;
    const appendSystemPrompt = argOverrides.appendSystemPrompt ?? mode.appendSystemPrompt;
    const allowedTools = argOverrides.allowedTools ?? mode.allowedTools;
    const disallowedTools = argOverrides.disallowedTools ?? mode.disallowedTools;
    const remoteSystemPrompt = getClaudeRemoteSystemPrompt({ disableTodos: mode.claudeRemoteDisableTodos === true });
    const enableFileCheckpointing = mode.claudeRemoteEnableFileCheckpointing === true;
    const settingSources = (() => {
        const value = mode.claudeRemoteSettingSources;
        if (value === 'none') return [];
        if (value === 'user_project') return ['user', 'project'];
        return ['project'];
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

    const hooks = {
        SessionStart: [
            {
                hooks: [
                    async (input: any) => {
                        const sessionId =
                            input && typeof input.session_id === 'string'
                                ? input.session_id
                                : input && typeof input.sessionId === 'string'
                                    ? input.sessionId
                                    : undefined;
                        if (sessionId) {
                            const transcriptRaw =
                                typeof input.transcript_path === 'string'
                                    ? input.transcript_path
                                    : typeof input.transcriptPath === 'string'
                                        ? input.transcriptPath
                                        : undefined;
                            const transcriptPathFallback =
                                transcriptRaw ??
                                join(
                                    getProjectPath(opts.path, opts.claudeEnvVars?.CLAUDE_CONFIG_DIR ?? null),
                                    `${sessionId}.jsonl`,
                                );
                            opts.onSessionFound(
                                sessionId,
                                { transcript_path: transcriptPathFallback, transcriptPath: transcriptPathFallback },
                            );
                        }
                        return { continue: true };
                    },
                ],
            },
        ],
    };

    const canUseTool = async (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal }) => {
        const result = await opts.canCallTool(toolName, input, mode, { signal: options.signal });
        return toAgentSdkPermissionResult(result);
    };

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

        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (typeof value !== 'string') continue;
            if (allowExact.has(key) || allowPrefixes.some((p) => key.startsWith(p))) {
                out[key] = value;
            }
        }

        return { ...out, ...(opts.claudeEnvVars ?? {}) };
    };

    const mappedPermissionMode = mapToClaudeMode(mode.permissionMode);
    const queryOptions: Record<string, unknown> = {
        abortController,
        cwd: opts.path,
        continue: shouldContinue || undefined,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        settingSources,
        permissionMode: mappedPermissionMode,
        allowDangerouslySkipPermissions: mappedPermissionMode === 'bypassPermissions',
        model: argOverrides.model ?? mode.model,
        fallbackModel: argOverrides.fallbackModel ?? mode.fallbackModel,
        maxTurns: argOverrides.maxTurns,
        systemPrompt: buildSystemPrompt(),
        allowedTools: allowedTools ? allowedTools.concat(opts.allowedTools) : opts.allowedTools,
        disallowedTools,
        strictMcpConfig: mode.claudeRemoteStrictMcpServerConfig === true || argOverrides.strictMcpConfig,
        canUseTool,
        env: buildClaudeSubprocessEnv(),
        executable: opts.jsRuntime ?? 'node',
        pathToClaudeCodeExecutable: opts.claudeExecutablePath ?? getDefaultClaudeCodePathForAgentSdk(),
        includePartialMessages: mode.claudeRemoteIncludePartialMessages === true || undefined,
        enableFileCheckpointing: enableFileCheckpointing || undefined,
        extraArgs: enableFileCheckpointing ? { 'replay-user-messages': null } : undefined,
        maxThinkingTokens: typeof mode.claudeRemoteMaxThinkingTokens === 'number' ? mode.claudeRemoteMaxThinkingTokens : undefined,
        hooks,
    };

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
    try {
        response = createQuery({
            prompt: messages,
            options: queryOptions,
        });

        updateThinking(true);
        let lastCheckpointId: string | null = null;
        const checkpointIds: string[] = [];
        const checkpointIdSet = new Set<string>();

        function recordCheckpointId(id: string) {
            if (checkpointIdSet.has(id)) return;
            checkpointIdSet.add(id);
            checkpointIds.push(id);
        }

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
                const textDelta = extractTextDeltaFromStreamEvent(message);
                if (textDelta && mode.claudeRemoteIncludePartialMessages === true) {
                    opts.onMessage({
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

            opts.onMessage(message as SDKMessage);

            if (message && message.type === 'system' && message.subtype === 'init') {
                const init = message as SDKSystemMessage;
                if (init.session_id) {
                    const transcriptPath = join(
                        getProjectPath(opts.path, opts.claudeEnvVars?.CLAUDE_CONFIG_DIR ?? null),
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

                opts.onReady();

                while (true) {
                    const next = await opts.nextMessage();
                    if (!next) {
                        messages.end();
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

                        opts.onMessage({
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
                        return;
                    }

                    if (nextSpecial.type === 'compact') {
                        isCompactCommand = true;
                        opts.onCompletionEvent?.('Compaction started');
                    }

                    mode = next.mode;

                    try {
                        await (response as any).setPermissionMode?.(mapToClaudeMode(mode.permissionMode));
                        await (response as any).setModel?.(mode.model ?? undefined);
                        if (typeof mode.claudeRemoteMaxThinkingTokens === 'number' || mode.claudeRemoteMaxThinkingTokens === null) {
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
                    break;
                }
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
        try {
            response?.close();
        } catch {
            // ignore
        }
        await stderrAppender?.close().catch(() => {});
    }
}
