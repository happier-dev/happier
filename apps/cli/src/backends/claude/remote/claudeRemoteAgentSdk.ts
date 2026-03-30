import { query as agentSdkQuery, AbortError as AgentSdkAbortError, type Query as AgentSdkQueryType } from '@anthropic-ai/claude-agent-sdk';

import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import { logger } from '@/ui/logger';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { recordToolTraceEvent } from '@/agent/tools/trace/toolTrace';

import type { EnhancedMode } from '@/backends/claude/loop';
import { mapToClaudeMode, resolveClaudeSdkPermissionModeFromEnhancedMode } from '@/backends/claude/utils/permissionMode';
import { getDefaultClaudeCodePathForAgentSdk } from '@/backends/claude/sdk/utils';
import type { SessionHookData } from '@/backends/claude/utils/startHookServer';
import { getProjectPath } from '@/backends/claude/utils/path';
import { getClaudeRemoteSystemPrompt } from '@/backends/claude/utils/remoteSystemPrompt';
import { parseClaudeSdkFlagOverridesFromArgs } from '@/backends/claude/remote/sdkFlagOverrides';
import { resolveClaudeRemoteSessionStartPlan } from '@/backends/claude/remote/sessionStartPlan';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';
import { resolveClaudeCodeExperimentalEnvOverlay } from '@/backends/claude/spawn/resolveClaudeCodeExperimentalEnvOverlay';
import { normalizeClaudeToolUseNamesInSdkMessage } from '@/backends/claude/utils/normalizeClaudeToolUseNames';
import { tryMergeUserMcpConfigArgsIntoHappierMcp } from '@/backends/claude/utils/mcpConfigMerge';
import { ensureClaudeJsRuntimeExecutable } from '@/backends/claude/utils/ensureClaudeJsRuntimeExecutable';
import { resolveClaudeEffortForModel } from '@/backends/claude/utils/claudeEffort';
import { resolveClaudeCodeXdgIsolation } from '@/backends/claude/utils/resolveClaudeCodeXdgIsolation';
import { isValidEnvVarKey } from '@/terminal/runtime/envVarSanitization';

import type { SDKMessage, SDKSystemMessage, SDKUserMessage } from '@/backends/claude/sdk';
import type { PermissionResult } from '@/backends/claude/sdk/types';
import type { JsRuntime } from '@/backends/claude/runClaude';
import { createSubprocessStderrAppender, resolveSubprocessArtifactsDir } from '@/agent/runtime/subprocessArtifacts';
import { join } from 'node:path';
import { buildClaudeAgentSdkHooks } from './agentSdk/buildClaudeAgentSdkHooks';
import { parseCheckpointsCommand, parseRewindCommand } from './agentSdk/claudeAgentSdkSlashCommands';
import { parseExplicitSpawnEnvKeysFromProcessEnv } from './agentSdk/explicitSpawnEnvKeysMarker';
import {
    extractTextStartFromStreamEvent,
    extractTextDeltaFromStreamEvent,
    extractThinkingStartFromStreamEvent,
    extractThinkingDeltaFromStreamEvent,
    extractToolResultStartFromStreamEvent,
    extractToolUseInputJsonDeltaFromStreamEvent,
    extractToolUseStartFromStreamEvent,
    isContentBlockStopStreamEvent,
    isMessageStopStreamEvent,
    messageContainsToolResultForToolUseId,
    messageContainsToolUseId,
    recordSeenToolBlocks,
    stripSeenToolBlocksFromMessage,
} from './agentSdk/streamEventToolBlocks';
import type { StreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';

type AgentSdkQueryFactory = (params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Record<string, unknown>;
}) => AgentSdkQueryType;

function argsContainMcpConfigFlag(args?: string[] | null): boolean {
    const input = args ?? [];
    for (const arg of input) {
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
            claudeArgs?: string[];
        claudeExecutablePath?: string;
        /**
         * Optional anchor UUID for resuming a session at a specific assistant message.
         * Only applied when `resume` is set (i.e. we are resuming a prior session).
         */
        resumeSessionAt?: string | null;
    /**
     * Optional MCP servers to inject into the Claude Agent SDK invocation (e.g. Happier MCP).
     * This should be additive with the user's config (no strict MCP unless explicitly requested).
     */
    happierMcpServers?: Record<string, unknown>;
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
    streamedTranscriptWriter?: StreamedTranscriptWriter | null;
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
            claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
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
    let response: any;

    const mergedMcp = tryMergeUserMcpConfigArgsIntoHappierMcp({
        baseMcpServers: (opts.happierMcpServers ?? Object.create(null)) as Record<string, unknown>,
        claudeArgs: opts.claudeArgs,
    });
    if (!mergedMcp && argsContainMcpConfigFlag(opts.claudeArgs)) {
        throw new Error('Invalid --mcp-config: expected JSON object with a { "mcpServers": { ... } } field.');
    }
    const effectiveMcpServers = mergedMcp ? mergedMcp.mergedMcpServers : opts.happierMcpServers;
    const effectiveClaudeArgs = mergedMcp ? mergedMcp.filteredClaudeArgs : opts.claudeArgs;

    // Use args with any --mcp-config stripped for override parsing and start-plan resolution.
    opts = {
        ...opts,
        claudeArgs: effectiveClaudeArgs,
        ...(effectiveMcpServers ? { happierMcpServers: effectiveMcpServers } : {}),
    };

    const argOverrides = parseClaudeSdkFlagOverridesFromArgs(opts.claudeArgs);
    const customSystemPrompt = argOverrides.customSystemPrompt ?? mode.customSystemPrompt;
    const appendSystemPrompt = argOverrides.appendSystemPrompt ?? mode.appendSystemPrompt;
    const remoteSystemPrompt = getClaudeRemoteSystemPrompt({ disableTodos: mode.claudeRemoteDisableTodos === true });
    const enableFileCheckpointing = mode.claudeRemoteEnableFileCheckpointing === true;
    const settingSources = (() => {
        type SettingSource = 'user' | 'project' | 'local';

        const rawV2 = (mode as any).claudeRemoteSettingSourcesV2 as unknown;
        if (Array.isArray(rawV2)) {
            const set = new Set<string>();
            for (const value of rawV2) {
                if (typeof value === 'string') set.add(value);
            }
            const normalized: SettingSource[] = [];
            for (const key of ['user', 'project', 'local'] as const) {
                if (set.has(key)) normalized.push(key);
            }

            // Preserve fail-closed behavior: an explicit empty array means "no sources".
            // Do not widen to defaults; respect the user's explicit choice.
            if (normalized.length === 0) return [];

            // NOTE: Claude Agent SDK currently defaults `settingSources` to `[]` and will still pass
            // `--setting-sources ""` (empty string) when we omit the option.
            // To avoid that footgun we always pass the full default list explicitly.
            if (normalized.length === 3) return ['user', 'project', 'local'] as const;
            return normalized;
        }

        // Legacy v1 mapping (back-compat).
        const value = mode.claudeRemoteSettingSources;
        if (value === 'user_project') return ['user', 'project'] as const;
        if (value === 'project') return ['project'] as const;
        if (value === 'none') return [];

        // Default to all sources when not explicitly configured.
        return ['user', 'project', 'local'] as const;
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
    const runtimeExecutable = await ensureClaudeJsRuntimeExecutable(opts.jsRuntime);

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

    type RuntimeSettingsSnapshot = Readonly<{
        permissionMode: string;
        model: string | null;
        maxThinkingTokens: number | null | undefined;
    }>;

    const resolveDesiredRuntimeSettingsSnapshot = (resolvedMode: EnhancedMode): RuntimeSettingsSnapshot => {
        const permissionMode = resolveClaudeSdkPermissionModeFromEnhancedMode(resolvedMode);
        const model =
            typeof argOverrides.model === 'string'
                ? argOverrides.model
                : typeof resolvedMode.model === 'string'
                    ? resolvedMode.model
                    : null;

        const maxThinkingTokens =
            typeof resolvedMode.claudeRemoteMaxThinkingTokens === 'number' || resolvedMode.claudeRemoteMaxThinkingTokens === null
                ? resolvedMode.claudeRemoteMaxThinkingTokens
                : undefined;

        return { permissionMode, model, maxThinkingTokens };
    };

    let lastAppliedRuntimeSettings: RuntimeSettingsSnapshot = resolveDesiredRuntimeSettingsSnapshot(mode);

    const applyRuntimeSettingsUpdatesIfNeeded = async (next: RuntimeSettingsSnapshot): Promise<void> => {
        if (next.permissionMode !== lastAppliedRuntimeSettings.permissionMode) {
            await response?.setPermissionMode?.(next.permissionMode);
            lastAppliedRuntimeSettings = { ...lastAppliedRuntimeSettings, permissionMode: next.permissionMode };
        }

        if (next.model !== lastAppliedRuntimeSettings.model) {
            await response?.setModel?.(next.model ?? undefined);
            lastAppliedRuntimeSettings = { ...lastAppliedRuntimeSettings, model: next.model };
        }

        if (next.maxThinkingTokens !== lastAppliedRuntimeSettings.maxThinkingTokens && next.maxThinkingTokens !== undefined) {
            await response?.setMaxThinkingTokens?.(next.maxThinkingTokens ?? null);
            lastAppliedRuntimeSettings = { ...lastAppliedRuntimeSettings, maxThinkingTokens: next.maxThinkingTokens };
        }
    };

    const canCallToolWithModeTransitions = async (
        toolName: string,
        input: unknown,
        resolvedMode: EnhancedMode,
        options: {
            signal: AbortSignal;
            toolUseId?: string | null;
            agentId?: string | null;
            suggestions?: unknown;
            blockedPath?: string | null;
            decisionReason?: string | null;
        },
    ): Promise<PermissionResult> => {
        const result = await opts.canCallTool(toolName, input, resolvedMode, options);

        const normalizedToolName = typeof toolName === 'string' ? toolName.trim() : '';
        const isExitPlanMode = normalizedToolName === 'ExitPlanMode' || normalizedToolName === 'exit_plan_mode';
        if (isExitPlanMode && result.behavior === 'allow') {
            // Claude starts in permissionMode=plan when agentModeId=plan.
            // Exiting plan mode happens inside the same assistant turn, before the next user message
            // can propagate a metadata-based agentMode update. We must immediately transition our
            // runtime mode and Claude's permission mode so subsequent tool calls in the same turn
            // are evaluated under the selected permissionMode (e.g. yolo → bypassPermissions).
            mode = { ...mode, agentModeId: null };

            const nextPermissionMode = (() => {
                const mapped = mapToClaudeMode(mode.permissionMode);
                return mapped === 'plan' ? 'default' : mapped;
            })();

            try {
                await response?.setPermissionMode?.(nextPermissionMode);
                lastAppliedRuntimeSettings = { ...lastAppliedRuntimeSettings, permissionMode: nextPermissionMode };
            } catch (error) {
                logger.debug('[claudeRemoteAgentSdk] Failed to transition permission mode after ExitPlanMode (non-fatal)', error);
                opts.onCompletionEvent?.('Failed to transition permission mode after exiting plan mode (non-fatal); continuing.');
            }
        }

        return result;
    };

    const builtHooks = buildClaudeAgentSdkHooks({
        cwd: opts.path,
        claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
        getMode: () => mode,
        onSessionFound: (sessionId, data) => opts.onSessionFound(sessionId, data as any),
        canCallTool: (toolName, input, resolvedMode, options) =>
            canCallToolWithModeTransitions(toolName, input, resolvedMode, {
                signal: options.signal,
                toolUseId: options.toolUseId ?? null,
                agentId: options.agentId ?? null,
                suggestions: options.suggestions,
                blockedPath: options.blockedPath ?? null,
                decisionReason: options.decisionReason ?? null,
            }),
    });
    const hooks = builtHooks.hooks as any;
    const canUseTool = builtHooks.canUseTool as any;

    let syntheticUuidCounter = 0;
    const createSyntheticUuid = () => `happier_synth_${process.pid}_${++syntheticUuidCounter}`;

    const resolvePreferredModelId = (): string | null => {
        const candidate = argOverrides.model ?? mode.model;
        return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : null;
    };

    const normalizeSdkMessageForUiCompatibility = (message: SDKMessage, hints?: { defaultUuid?: string | null }) => {
        const preferredModelId = resolvePreferredModelId();

        const existingUuid = (message as any)?.uuid;
        const nextUuid =
            typeof existingUuid === 'string' && existingUuid.trim().length > 0
                ? existingUuid
                : typeof hints?.defaultUuid === 'string' && hints.defaultUuid.trim().length > 0
                    ? hints.defaultUuid
                    : createSyntheticUuid();

        const needsUuidPatch = nextUuid !== existingUuid;
        const needsModelPatch =
            message?.type === 'assistant' &&
            preferredModelId &&
            message &&
            typeof message === 'object' &&
            (message as any).message &&
            typeof (message as any).message === 'object' &&
            typeof (message as any).message.model !== 'string';

        if (!needsUuidPatch && !needsModelPatch) return message;

        return {
            ...(message as any),
            ...(needsUuidPatch ? { uuid: nextUuid } : null),
            ...(needsModelPatch
                ? {
                    message: {
                        ...(message as any).message,
                        model: preferredModelId,
                    },
                }
                : null),
        } as SDKMessage;
    };

    const emitMessage = (message: SDKMessage, hints?: { defaultUuid?: string | null }) => {
        const normalized = normalizeClaudeToolUseNamesInSdkMessage(message);
        opts.onMessage(normalizeSdkMessageForUiCompatibility(normalized, hints));
    };

    const buildSystemPrompt = (): any => {
        if (customSystemPrompt) {
            return `${customSystemPrompt}\n\n${remoteSystemPrompt}`;
        }

        const append = (appendSystemPrompt ? `${appendSystemPrompt}\n\n` : '') + remoteSystemPrompt;
        return { type: 'preset', preset: 'claude_code', append };
    };

        const buildClaudeSubprocessEnv = (): Record<string, string> => {
            const explicitSpawnEnvKeys = new Set(parseExplicitSpawnEnvKeysFromProcessEnv(process.env));
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

            const out: Record<string, string> = Object.create(null);
            for (const [key, value] of Object.entries(process.env)) {
                if (!isValidEnvVarKey(key)) continue;
                if (typeof value !== 'string') continue;
                if (explicitSpawnEnvKeys.has(key) || allowExact.has(key) || allowPrefixes.some((p) => key.startsWith(p))) {
                    out[key] = value;
                }
            }

            delete out.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON;
            return { ...out };
        };

        const mappedPermissionMode = resolveClaudeSdkPermissionModeFromEnhancedMode(mode);
        const experimentalEnvOverlay = resolveClaudeCodeExperimentalEnvOverlay({
            claudeCodeExperimentalAgentTeamsEnabled: mode.claudeCodeExperimentalAgentTeamsEnabled,
        });
        const xdgIsolationEnv = resolveClaudeCodeXdgIsolation({
            backendId: 'claude',
            scope: 'session',
            isolationId:
                typeof opts.sessionId === 'string' && opts.sessionId.trim().length > 0
                    ? opts.sessionId.trim()
                    : `pid_${process.pid}`,
        });
        const resumeSessionAt =
            typeof opts.resumeSessionAt === 'string' && opts.resumeSessionAt.trim().length > 0
                ? opts.resumeSessionAt.trim()
                : null;
        const resolvedEffort = resolveClaudeEffortForModel({
            modelId: argOverrides.model ?? mode.model,
            effort: argOverrides.effort ?? mode.reasoningEffort,
        });
            const queryOptions: Record<string, unknown> = {
                abortController,
                cwd: opts.path,
                // Claude Agent SDK: required so we receive `stream_event` deltas.
                // Without these, the remote launcher may select the Agent SDK runner (and strip
                // assistant {text,thinking} blocks), but we would never materialize output through
                // the streamed transcript writer (resulting in "thinking → online" with no reply).
                includePartialMessages: true,
            continue: shouldContinue || undefined,
            resume: startFrom ?? undefined,
            ...(startFrom && resumeSessionAt ? { resumeSessionAt } : {}),
            settingSources,
            permissionMode: mappedPermissionMode,
            allowDangerouslySkipPermissions: true,
            ...(resolvedEffort ? { effort: resolvedEffort } : {}),
            model: argOverrides.model ?? mode.model,
            fallbackModel: argOverrides.fallbackModel ?? mode.fallbackModel,
            maxTurns: argOverrides.maxTurns,
        systemPrompt: buildSystemPrompt(),
            strictMcpConfig: mode.claudeRemoteStrictMcpServerConfig === true || argOverrides.strictMcpConfig,
        canUseTool,
        ...(opts.happierMcpServers ? { mcpServers: opts.happierMcpServers } : {}),
            env: { ...xdgIsolationEnv, ...buildClaudeSubprocessEnv(), ...experimentalEnvOverlay },
            executable: runtimeExecutable,
            pathToClaudeCodeExecutable: opts.claudeExecutablePath ?? getDefaultClaudeCodePathForAgentSdk(),
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

    // Agent SDK expects objects (SDKUserMessage). It JSON-stringifies them before writing to stdin.
    const messages = new PushableAsyncIterable<SDKUserMessage>();
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

    let nextMessagePump: Promise<void> | null = null;
    const swallowOptionalPromise = async (promise: Promise<void> | null): Promise<void> => {
        if (!promise) return;
        await promise.catch(() => {});
    };

    const streamedTranscriptWriter = opts.streamedTranscriptWriter ?? null;
    let cleanupBufferedAssistantMessages: ((incoming: unknown) => void) | null = null;

    const flushStreamedTranscriptWriter = async (
        reason: 'tool-call-boundary' | 'turn-end' | 'abort',
        interruptedReason?: string,
    ) => {
        if (!streamedTranscriptWriter) return;
        try {
            await streamedTranscriptWriter.flushAll({
                reason,
                ...(reason === 'abort' && interruptedReason ? { interruptedReason } : {}),
            });
        } catch (error) {
            logger.debug('[claudeRemoteAgentSdk] Failed flushing streamed transcript writer (non-fatal)', { error, reason });
        }
    };

    const normalizeSidechainIdForStream = (message: unknown): string | null => {
        if (!message || typeof message !== 'object') return null;
        const raw = (message as any).parent_tool_use_id;
        if (raw === null || raw === undefined) return null;
        if (typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : null;
    };

    const extractAssistantAndThinkingTextFromAssistantMessage = (
        message: unknown,
    ): Readonly<{ assistantText: string | null; thinkingText: string | null }> => {
        if (!message || typeof message !== 'object') return { assistantText: null, thinkingText: null };
        const m = message as any;
        if (m.type !== 'assistant') return { assistantText: null, thinkingText: null };
        const content = m?.message?.content;
        if (!Array.isArray(content)) return { assistantText: null, thinkingText: null };

        const assistantParts: string[] = [];
        const thinkingParts: string[] = [];
        for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'text' && typeof (block as any).text === 'string') {
                assistantParts.push(String((block as any).text));
            } else if (block.type === 'thinking' && typeof (block as any).thinking === 'string') {
                thinkingParts.push(String((block as any).thinking));
            }
        }

        const assistantText = assistantParts.join('');
        const thinkingText = thinkingParts.join('');
        return {
            assistantText: assistantText.trim().length > 0 ? assistantText : null,
            thinkingText: thinkingText.trim().length > 0 ? thinkingText : null,
        };
    };

    const stripCoveredAssistantBlocks = (params: Readonly<{
        message: SDKMessage;
        stripAssistantText: boolean;
        stripThinkingText: boolean;
    }>): SDKMessage => {
        if (params.message.type !== 'assistant') return params.message;
        const content = Array.isArray((params.message as any)?.message?.content)
            ? ((params.message as any).message.content as unknown[])
            : null;
        if (!content) return params.message;
        if (!params.stripAssistantText && !params.stripThinkingText) return params.message;

        const stripped = content.filter((block) => {
            if (!block || typeof block !== 'object') return true;
            if (params.stripAssistantText && (block as any).type === 'text') return false;
            if (params.stripThinkingText && (block as any).type === 'thinking') return false;
            return true;
        });

        if (stripped.length === content.length) return params.message;
        return {
            ...(params.message as any),
            message: {
                ...((params.message as any).message ?? {}),
                content: stripped,
            },
        } as SDKMessage;
    };

    try {
        response = createQuery({
            prompt: messages,
            options: queryOptions,
        });

        updateThinking(true);
        const streamingToolUses = new Map<
            string,
            { sessionId: string; parentToolUseId: string | null; id: string; name: string; inputJson: string; initialInput: unknown }
        >();
        const streamingToolResults = new Map<
            string,
            { sessionId: string; parentToolUseId: string | null; toolUseId: string; content: string; isError: boolean }
        >();
        const pendingToolUseMessages = new Map<string, { toolUseId: string; message: SDKMessage }>();
        const pendingToolResultMessages = new Map<string, { toolUseId: string; message: SDKMessage }>();
        const bufferedStreamEventAssistantMessages = new Map<
            string,
            { sessionId: string; parentToolUseId: string | null; text: string; thinking: string; lastUuid: string | null }
        >();
        let didPublishAssistantTextThisTurn = false;
        const seen = { toolUseIds: new Set<string>(), toolResultIds: new Set<string>() };
        let lastCheckpointId: string | null = null;
        const checkpointIds: string[] = [];
        const checkpointIdSet = new Set<string>();
        let didFinalizeTurn = false;
        let awaitingNextTurnStart = false;

        function recordCheckpointId(id: string) {
            if (checkpointIdSet.has(id)) return;
            checkpointIdSet.add(id);
            checkpointIds.push(id);
        }

        const isUserTextMessage = (message: unknown): boolean => {
            const msg = message as any;
            return (
                msg?.message?.role === 'user' &&
                ((typeof msg.message.content === 'string' && msg.message.content.trim().length > 0) ||
                    (Array.isArray(msg.message.content) &&
                        msg.message.content.some(
                            (c: any) => c?.type === 'text' && typeof c.text === 'string' && c.text.trim().length > 0,
                        )))
            );
        };

        const extractAssistantText = (message: unknown): string | null => {
            return extractAssistantAndThinkingTextFromAssistantMessage(message).assistantText;
        };

        const extractResultText = (message: unknown): string | null => {
            const msg: any = message;
            if (!msg || typeof msg !== 'object') return null;
            if (msg.type !== 'result') return null;
            return typeof msg.result === 'string' && msg.result.trim().length > 0 ? msg.result : null;
        };

        const markAssistantTextPublished = (text: string | null | undefined) => {
            if (typeof text !== 'string' || text.trim().length === 0) return;
            didPublishAssistantTextThisTurn = true;
        };

        const buildBufferedStreamEventAssistantMessageKey = (message: unknown) => {
            const sessionId = typeof (message as any)?.session_id === 'string' ? (message as any).session_id : '';
            const parentToolUseId = normalizeSidechainIdForStream(message);
            return {
                key: `${sessionId}::${parentToolUseId ?? ''}`,
                sessionId,
                parentToolUseId,
            };
        };

        const ensureBufferedStreamEventAssistantMessage = (message: unknown) => {
            const { key, sessionId, parentToolUseId } = buildBufferedStreamEventAssistantMessageKey(message);
            const uuid = typeof (message as any)?.uuid === 'string' ? (message as any).uuid : null;
            const existing = bufferedStreamEventAssistantMessages.get(key);
            if (!existing) {
                const created = {
                    sessionId,
                    parentToolUseId,
                    text: '',
                    thinking: '',
                    lastUuid: uuid,
                };
                bufferedStreamEventAssistantMessages.set(key, created);
                return created;
            }
            existing.lastUuid = uuid;
            return existing;
        };

        const flushBufferedStreamEventAssistantMessage = (incoming: unknown) => {
            const flushOne = (pending: {
                sessionId: string;
                parentToolUseId: string | null;
                text: string;
                thinking: string;
                lastUuid: string | null;
            }) => {
                const pendingAssistantText = pending.text.trim();
                const pendingThinkingText = pending.thinking.trim();
                if (pendingAssistantText.length === 0 && pendingThinkingText.length === 0) return;

                const incomingAssistant = extractAssistantAndThinkingTextFromAssistantMessage(incoming);
                const incomingAssistantText = incomingAssistant.assistantText?.trim() ?? '';
                const incomingThinkingText = incomingAssistant.thinkingText?.trim() ?? '';

                if (
                    incoming &&
                    typeof incoming === 'object' &&
                    (incoming as any).type === 'assistant' &&
                    incomingAssistantText === pendingAssistantText &&
                    incomingThinkingText === pendingThinkingText
                ) {
                    markAssistantTextPublished(pendingAssistantText);
                    return;
                }

                const defaultUuid =
                    typeof pending.lastUuid === 'string' && pending.lastUuid.trim().length > 0
                        ? pending.lastUuid.trim()
                        : null;
                const content = [
                    ...(pendingThinkingText.length > 0 ? [{ type: 'thinking' as const, thinking: pending.thinking }] : []),
                    ...(pendingAssistantText.length > 0 ? [{ type: 'text' as const, text: pending.text }] : []),
                ];
                emitMessage({
                    type: 'assistant',
                    session_id: pending.sessionId,
                    parent_tool_use_id: pending.parentToolUseId,
                    ...(defaultUuid ? { uuid: defaultUuid } : null),
                    message: {
                        role: 'assistant',
                        content,
                    },
                } as any, { defaultUuid });
                markAssistantTextPublished(pendingAssistantText);
            };

            if (!incoming) {
                const pendingEntries = Array.from(bufferedStreamEventAssistantMessages.values());
                bufferedStreamEventAssistantMessages.clear();
                for (const pending of pendingEntries) {
                    flushOne(pending);
                }
                return;
            }

            const { key } = buildBufferedStreamEventAssistantMessageKey(incoming);
            const pending = bufferedStreamEventAssistantMessages.get(key);
            if (!pending) return;
            bufferedStreamEventAssistantMessages.delete(key);
            flushOne(pending);
        };
        cleanupBufferedAssistantMessages = flushBufferedStreamEventAssistantMessage;

        const buildStreamEventToolBlockKey = (message: unknown) => {
            const sessionId = typeof (message as any)?.session_id === 'string' ? (message as any).session_id : '';
            const parentToolUseId = normalizeSidechainIdForStream(message);
            return {
                key: `${sessionId}::${parentToolUseId ?? ''}`,
                sessionId,
                parentToolUseId,
            };
        };

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
                            await applyRuntimeSettingsUpdatesIfNeeded(resolveDesiredRuntimeSettingsSnapshot(mode));
                        } catch (e) {
                            logger.debug('[claudeRemoteAgentSdk] Failed to update runtime settings (non-fatal)', e);
                            opts.onCompletionEvent?.('Failed to update runtime settings (non-fatal); continuing.');
                        }

                        didPublishAssistantTextThisTurn = false;
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

        const finalizeCurrentTurn = async (params?: { completionEvent?: string }) => {
            if (didFinalizeTurn) return;
            didFinalizeTurn = true;
            awaitingNextTurnStart = true;
            updateThinking(false);
            await flushStreamedTranscriptWriter('turn-end');
            if (params?.completionEvent) {
                opts.onCompletionEvent?.(params.completionEvent);
            }
            await opts.onReady();
            scheduleNextMessagePump();
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
                const clearFinalizeGuardForNextTurnStart = () => {
                    // Claude can emit the next turn's assistant output exclusively via stream_event
                    // messages (no assembled assistant/user message). If we finalized the previous
                    // turn (e.g. on a compaction init boundary), we still need to clear the
                    // "result finalize" guard so the next `result` message can finalize and allow
                    // queued prompts to continue flowing.
                    if (awaitingNextTurnStart && didFinalizeTurn) {
                        awaitingNextTurnStart = false;
                        didFinalizeTurn = false;
                    }
                };

                const toolUseStart = extractToolUseStartFromStreamEvent(message);
                if (toolUseStart) {
                    clearFinalizeGuardForNextTurnStart();
                    await flushStreamedTranscriptWriter('tool-call-boundary');
                    flushBufferedStreamEventAssistantMessage(message);
                    const { key, sessionId, parentToolUseId } = buildStreamEventToolBlockKey(message);
                    streamingToolUses.set(key, {
                        sessionId,
                        parentToolUseId,
                        id: toolUseStart.id,
                        name: toolUseStart.name,
                        inputJson: '',
                        initialInput: toolUseStart.input,
                    });
                    continue;
                }

                const toolResultStart = extractToolResultStartFromStreamEvent(message);
                if (toolResultStart) {
                    clearFinalizeGuardForNextTurnStart();
                    flushBufferedStreamEventAssistantMessage(message);
                    const { key, sessionId, parentToolUseId } = buildStreamEventToolBlockKey(message);
                    streamingToolResults.set(key, {
                        sessionId,
                        parentToolUseId,
                        toolUseId: toolResultStart.toolUseId,
                        content: toolResultStart.content ?? '',
                        isError: toolResultStart.isError ?? false,
                    });
                    continue;
                }

                const thinkingStart = extractThinkingStartFromStreamEvent(message);
                if (thinkingStart) {
                    clearFinalizeGuardForNextTurnStart();
                    const buffered = ensureBufferedStreamEventAssistantMessage(message);
                    buffered.thinking += thinkingStart;
                    streamedTranscriptWriter?.appendThinkingDelta(thinkingStart, { sidechainId: normalizeSidechainIdForStream(message) });
                    continue;
                }

                const textStart = extractTextStartFromStreamEvent(message);
                if (textStart) {
                    clearFinalizeGuardForNextTurnStart();
                    const { key } = buildStreamEventToolBlockKey(message);
                    const streamingToolResult = streamingToolResults.get(key) ?? null;
                    if (!streamingToolResult) {
                        const buffered = ensureBufferedStreamEventAssistantMessage(message);
                        buffered.text += textStart;
                        streamedTranscriptWriter?.appendAssistantDelta(textStart, { sidechainId: normalizeSidechainIdForStream(message) });
                    } else {
                        streamingToolResult.content += textStart;
                    }
                    continue;
                }

                const toolUseInputDelta = extractToolUseInputJsonDeltaFromStreamEvent(message);
                if (toolUseInputDelta) {
                    clearFinalizeGuardForNextTurnStart();
                    const { key } = buildStreamEventToolBlockKey(message);
                    const streamingToolUse = streamingToolUses.get(key);
                    if (streamingToolUse) {
                        streamingToolUse.inputJson += toolUseInputDelta;
                        continue;
                    }
                }

                const thinkingDelta = extractThinkingDeltaFromStreamEvent(message);
                if (thinkingDelta) {
                    clearFinalizeGuardForNextTurnStart();
                    const buffered = ensureBufferedStreamEventAssistantMessage(message);
                    buffered.thinking += thinkingDelta;
                    streamedTranscriptWriter?.appendThinkingDelta(thinkingDelta, { sidechainId: normalizeSidechainIdForStream(message) });
                    continue;
                }

                const textDelta = extractTextDeltaFromStreamEvent(message);
                if (textDelta) {
                    clearFinalizeGuardForNextTurnStart();
                    const { key } = buildStreamEventToolBlockKey(message);
                    const streamingToolResult = streamingToolResults.get(key) ?? null;
                    if (!streamingToolResult) {
                        const buffered = ensureBufferedStreamEventAssistantMessage(message);
                        buffered.text += textDelta;
                        streamedTranscriptWriter?.appendAssistantDelta(textDelta, { sidechainId: normalizeSidechainIdForStream(message) });
                    } else {
                        streamingToolResult.content += textDelta;
                    }
                    continue;
                }

                if (isContentBlockStopStreamEvent(message)) {
                    const { key } = buildStreamEventToolBlockKey(message);
                    const streamingToolUse = streamingToolUses.get(key) ?? null;
                    if (streamingToolUse) {
                        if (seen.toolUseIds.has(streamingToolUse.id)) {
                            streamingToolUses.delete(key);
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

                        pendingToolUseMessages.set(key, {
                            toolUseId: streamingToolUse.id,
                            message: {
                                type: 'assistant',
                                session_id: streamingToolUse.sessionId,
                                parent_tool_use_id: streamingToolUse.parentToolUseId,
                                uuid: streamingToolUse.id,
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
                        });

                        streamingToolUses.delete(key);
                        continue;
                    }

                    const streamingToolResult = streamingToolResults.get(key) ?? null;
                    if (streamingToolResult) {
                        if (seen.toolResultIds.has(streamingToolResult.toolUseId)) {
                            streamingToolResults.delete(key);
                            continue;
                        }
                        pendingToolResultMessages.set(key, {
                            toolUseId: streamingToolResult.toolUseId,
                            message: {
                                type: 'user',
                                session_id: streamingToolResult.sessionId,
                                parent_tool_use_id: streamingToolResult.parentToolUseId,
                                uuid: streamingToolResult.toolUseId,
                                message: {
                                    role: 'user',
                                    content: [
                                        {
                                        type: 'tool_result',
                                        tool_use_id: streamingToolResult.toolUseId,
                                        content: streamingToolResult.content,
                                        is_error: Boolean((streamingToolResult as any).isError),
                                    },
                                ],
                            },
                        } as any,
                        });
                        streamingToolResults.delete(key);
                        continue;
                    }
                }

                if (isMessageStopStreamEvent(message)) {
                    flushBufferedStreamEventAssistantMessage(message);
                }

                continue;
            }

            // If we reconstructed tool blocks from stream events, prefer the assembled SDK message when it arrives
            // (avoid double-emitting the same tool_use/tool_result).
            //
            // Important: Claude Code can emit system/status/progress messages between stream_event stop and the
            // assembled assistant/user message. Do not flush pending tool blocks on those intermediary messages.
            const incomingMessageType = (message as any)?.type;
            if (incomingMessageType === 'assistant' || incomingMessageType === 'user' || incomingMessageType === 'result') {
                flushBufferedStreamEventAssistantMessage(message);
            }
            if (incomingMessageType === 'assistant' || incomingMessageType === 'user' || incomingMessageType === 'result') {
                for (const [key, pendingToolUseMessage] of Array.from(pendingToolUseMessages.entries())) {
                    if (messageContainsToolUseId(message, pendingToolUseMessage.toolUseId)) {
                        pendingToolUseMessages.delete(key);
                    } else if (incomingMessageType === 'user' && !messageContainsToolResultForToolUseId(message, pendingToolUseMessage.toolUseId)) {
                    // Not a boundary that implies the tool ran (tool_result) and not the assembled tool_use;
                    // keep buffering so we can still dedupe when the assistant tool_use arrives.
                        continue;
                    } else {
                        const deduped = stripSeenToolBlocksFromMessage(pendingToolUseMessage.message, seen);
                        if (deduped) {
                            emitMessage(deduped, { defaultUuid: pendingToolUseMessage.toolUseId });
                            recordSeenToolBlocks(deduped, seen);
                        }
                        pendingToolUseMessages.delete(key);
                    }
                }
            }

            if (incomingMessageType === 'assistant' || incomingMessageType === 'user' || incomingMessageType === 'result') {
                for (const [key, pendingToolResultMessage] of Array.from(pendingToolResultMessages.entries())) {
                    if (messageContainsToolResultForToolUseId(message, pendingToolResultMessage.toolUseId)) {
                        pendingToolResultMessages.delete(key);
                    } else {
                        const deduped = stripSeenToolBlocksFromMessage(pendingToolResultMessage.message, seen);
                        if (deduped) {
                            emitMessage(deduped, { defaultUuid: pendingToolResultMessage.toolUseId });
                            recordSeenToolBlocks(deduped, seen);
                        }
                        pendingToolResultMessages.delete(key);
                    }
                }
            }

                const sdkMessage = message as SDKMessage;
                const deduped = stripSeenToolBlocksFromMessage(sdkMessage, seen);
                if (!deduped) continue;

                let messageToEmit = deduped;
                if (incomingMessageType === 'assistant' && streamedTranscriptWriter) {
                    const { assistantText, thinkingText } = extractAssistantAndThinkingTextFromAssistantMessage(deduped);
                    const sidechainId = normalizeSidechainIdForStream(deduped);
                    let stripThinkingText = false;
                    let stripAssistantText = false;
                    if (typeof thinkingText === 'string' && thinkingText.length > 0) {
                        stripThinkingText = streamedTranscriptWriter.overrideThinkingText(thinkingText, { sidechainId });
                    }
                    if (typeof assistantText === 'string' && assistantText.length > 0) {
                        stripAssistantText = streamedTranscriptWriter.overrideAssistantText(assistantText, { sidechainId });
                    }
                    messageToEmit = stripCoveredAssistantBlocks({
                        message: deduped,
                        stripAssistantText,
                        stripThinkingText,
                    });
                    markAssistantTextPublished(assistantText);
                } else if (incomingMessageType === 'assistant') {
                    markAssistantTextPublished(extractAssistantText(deduped));
                }

                emitMessage(messageToEmit);
                recordSeenToolBlocks(messageToEmit, seen);

                if (
                    awaitingNextTurnStart &&
                    didFinalizeTurn &&
                    (incomingMessageType === 'assistant' || (incomingMessageType === 'user' && isUserTextMessage(message)))
                ) {
                    awaitingNextTurnStart = false;
                    didFinalizeTurn = false;
                }

                if (message && message.type === 'system' && message.subtype === 'init') {
                    const init = message as SDKSystemMessage;
                    if (init.session_id) {
                        const transcriptPath = join(
                            getProjectPath(opts.path, resolveClaudeConfigDirOverride(process.env)),
                            `${init.session_id}.jsonl`,
                        );
                        opts.onSessionFound(init.session_id, { transcript_path: transcriptPath, transcriptPath });
                        if (isCompactCommand) {
                            opts.onCompletionEvent?.('Compaction completed');
                            isCompactCommand = false;
                            await finalizeCurrentTurn();
                        }
                    }
                }

            if (message && message.type === 'user') {
                const msg = message as any;
                if (
                    enableFileCheckpointing &&
                    isUserTextMessage(msg) &&
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
                const resultText = extractResultText(message);
                if (!didPublishAssistantTextThisTurn && resultText) {
                    const { key, sessionId, parentToolUseId } = buildBufferedStreamEventAssistantMessageKey(message);
                    bufferedStreamEventAssistantMessages.set(key, {
                        sessionId,
                        parentToolUseId,
                        text: resultText,
                        thinking: '',
                        lastUuid: typeof (message as any).uuid === 'string' ? (message as any).uuid : null,
                    });
                    flushBufferedStreamEventAssistantMessage(message);
                }

                if (didFinalizeTurn) {
                    continue;
                }

                if (isCompactCommand) {
                    isCompactCommand = false;
                    await finalizeCurrentTurn({ completionEvent: 'Compaction completed' });
                    continue;
                }

                await finalizeCurrentTurn();
            }
        }
    } catch (e) {
        if (e instanceof AgentSdkAbortError) {
            logger.debug('[claudeRemoteAgentSdk] Aborted');
            await flushStreamedTranscriptWriter('abort', 'agent-sdk-abort');
            return;
        }
        if (e && typeof e === 'object') {
            const err = e as any;
            if (!err.happierClaudeCodeArtifacts) {
                err.happierClaudeCodeArtifacts = {
                    debugFilePath: debugFilePath ?? null,
                    stderrFilePath: stderrAppender?.path ?? null,
                };
            }
        }
        throw e;
    } finally {
        opts.setUserMessageSender?.(null);
        updateThinking(false);
        cleanupBufferedAssistantMessages?.(null);
        await flushStreamedTranscriptWriter('abort', 'runner-finalize');
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
