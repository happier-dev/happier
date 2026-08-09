import {
    query as agentSdkQuery,
    AbortError as AgentSdkAbortError,
    type Query as AgentSdkQueryType,
    type SpawnOptions as AgentSdkSpawnOptions,
    type SpawnedProcess as AgentSdkSpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import {
    redactBugReportSensitiveText,
    trimBugReportTextToMaxBytes,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
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
import { buildClaudeSubprocessEnv } from '@/backends/claude/spawn/buildClaudeSubprocessEnv';
import { logClaudeRuntimeAuthEnvDiagnostic } from '@/backends/claude/spawn/logClaudeRuntimeAuthEnvDiagnostic';
import { isCompactHookLocalCommandStdout } from '@/backends/claude/utils/isCompactHookLocalCommandStdout';
import { normalizeClaudeToolUseNamesInSdkMessage } from '@/backends/claude/utils/normalizeClaudeToolUseNames';
import { tryMergeUserMcpConfigArgsIntoHappierMcp } from '@/backends/claude/utils/mcpConfigMerge';
import { ensureClaudeJsRuntimeExecutable } from '@/backends/claude/utils/ensureClaudeJsRuntimeExecutable';
import {
    resolveModeEffortLevelsForModel,
    buildClaudeUltracodeSettingsJson,
    resolveClaudeEffortForModel,
    resolveClaudeUltracodeForModel,
} from '@/backends/claude/utils/claudeEffort';
import { resolveClaudeCodeXdgIsolation } from '@/backends/claude/utils/resolveClaudeCodeXdgIsolation';

import type { SDKMessage, SDKSystemMessage, SDKUserMessage } from '@/backends/claude/sdk';
import type { PermissionResult } from '@/backends/claude/sdk/types';
import type { JsRuntime } from '@/backends/claude/runClaude';
import { createSubprocessStderrAppender, resolveSubprocessArtifactsDir } from '@/agent/runtime/subprocessArtifacts';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createEventShapeLoggerForLog } from '@/diagnostics/eventShapeForLog';
import { readTailTextFile } from '@/utils/fs/readTailTextFile';
import { buildClaudeAgentSdkHooks } from './agentSdk/buildClaudeAgentSdkHooks';
import {
    normalizeClaudeProviderTaskEvent,
    readClaudeSessionHookProviderTaskActivity,
} from '@/backends/claude/providerActivity/createClaudeProviderActivityLedger';
import type { createClaudeProviderRuntimeActivityAdapter } from '@/backends/claude/providerActivity/createClaudeProviderRuntimeActivityAdapter';
import {
    handleClaudeRuntimeActivityLoss,
    createClaudeRuntimeActivityEvidence,
    isReplaySdkMessage,
    publishClaudeProviderTaskRuntimeActivity,
    reconcileClaudeRuntimeActivity,
    type ClaudeRuntimeActivityEvidence,
} from './runtimeActivityEvidence';
import { repairClaudeTranscriptAfterInterrupt } from './agentSdk/repairClaudeTranscriptAfterInterrupt';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { parseCheckpointsCommand, parseRewindCommand } from './agentSdk/claudeAgentSdkSlashCommands';
import {
    mapClaudeRateLimitEventToQuotaEvidence,
    mapClaudeRateLimitEventToUsageDetails,
    type NormalizedProviderUsageLimitDetailsV1,
} from '../connectedServices/mapClaudeRateLimitEventToUsageDetails';
import { classifyClaudeConnectedServiceRuntimeAuthFailure } from '../connectedServices/classifyClaudeConnectedServiceRuntimeAuthFailure';
import { resolveClaudeRuntimeAuthRetryDecision } from '../connectedServices/claudeRuntimeAuthRetryDecision';
import {
    buildClaudeTodoWriteWorkState,
    createClaudeTaskToolWorkStateTracker,
} from '@/backends/claude/workState/claudeWorkState';
import {
    buildClaudeCompactBoundaryEventIdentity,
    buildClaudeCompactionCompletedEvent,
    buildClaudeCompactionLifecycleId,
    buildClaudeCompactionStartedEvent,
    type ClaudeCompletionEvent,
} from '../contextCompactionEvents';
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
import type { StreamedTranscriptFlushSummary, StreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import type { SessionWorkStateV1 } from '@/session/workState/sessionWorkStateMetadata';
import {
    confirmClaudeRemoteProviderPromptAccepted,
    reportClaudeRemoteProviderPromptTransportFailure,
    type ClaudeRemoteProviderAcceptedPrompt,
    type ClaudeRemoteProviderPromptAcceptedHandler,
    type ClaudeRemoteProviderPromptTransportFailure,
    type ClaudeRemoteProviderPromptTransportFailureHandler,
} from './providerPromptAcceptance';
import type { ClaudeSubscriptionAuthTokensRefreshSelection } from '../connectedServices/claudeSubscriptionAuthTokensRefreshBridgeContract';
import {
    createClaudeSubscriptionAccessTokenRefreshCallback,
} from '../connectedServices/claudeSubscriptionAccessTokenRefresh';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

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
    nextMessage: () => Promise<ClaudeRemoteProviderAcceptedPrompt<EnhancedMode> | null>;
    onReady: () => void | Promise<void>;
    onSubagentFlush?: () => void | Promise<void>;
    isAborted: (toolCallId: string) => boolean;

    // Callbacks
    onSessionFound: (id: string, data?: SessionHookData) => void;
    onThinkingChange?: (thinking: boolean) => void;
    onMessage: (message: SDKMessage) => void;
    /** Correlation supplied by the workflow owner after onMessage has observed the same SDK fact. */
    isWorkflowProviderTaskId?: (taskId: string) => boolean;
    streamedTranscriptWriter?: StreamedTranscriptWriter | null;
    onCompletionEvent?: (event: ClaudeCompletionEvent) => void;
    onSessionReset?: () => void;
    setUserMessageSender?: (sender: ((message: SDKUserMessage) => void) | null) => void;
    onPromptAcceptedByProvider?: ClaudeRemoteProviderPromptAcceptedHandler | null;
    onPromptTransportFailure?: ClaudeRemoteProviderPromptTransportFailureHandler | null;
    /** Exact availability of the SDK streaming-input boundary for the active foreground turn. */
    onInFlightSteerAvailabilityChange?: ((available: boolean) => void) | null;
    /**
     * Registers a best-effort interrupt handler that can stop the current turn without
     * terminating the underlying Claude Code subprocess.
     *
     * Used by the remote launcher to implement UI "Abort" without losing context.
     */
    setTurnInterrupt?: ((handler: (() => Promise<void>) | null) => void) | null;
    onCheckpointCaptured?: (checkpointId: string) => void;
    onCapabilities?: (caps: { slashCommands?: string[]; slashCommandDetails?: Array<{ command: string; description?: string }>; models?: unknown[] }) => void;
    onWorkStateSnapshot?: (snapshot: SessionWorkStateV1) => void | Promise<void>;
    onRateLimitEvent?: (details: NormalizedProviderUsageLimitDetailsV1) => void | Promise<void>;
    onQuotaEvidence?: (details: NormalizedProviderUsageLimitDetailsV1) => void | Promise<void>;
    onRuntimeAuthFailureEvent?: (error: unknown) => void | Promise<void>;
    runtimeActivityAdapter?: ReturnType<typeof createClaudeProviderRuntimeActivityAdapter> | null;
    providerRuntimeActivityEvidence?: ClaudeRuntimeActivityEvidence | null;
    claudeSubscriptionAccessTokenRefreshSelection?: ClaudeSubscriptionAuthTokensRefreshSelection | null;
    onWorkflowActivityObserverReady?: (() => void) | null;

    // Test seam
    createQuery?: AgentSdkQueryFactory;
    spawnClaudeCodeProcess?: ((options: AgentSdkSpawnOptions) => AgentSdkSpawnedProcess) | null;
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

	    const claudeConfigDir = resolveClaudeConfigDirOverride(process.env);
	    const { startFrom, shouldContinue } = resolveClaudeRemoteSessionStartPlan({
	        sessionId: opts.sessionId,
	        transcriptPath: opts.transcriptPath,
	        path: opts.path,
	        claudeConfigDir,
	        claudeArgs: opts.claudeArgs,
	    }, {
	        logPrefix: 'claudeRemoteAgentSdk',
	    });

    let compactionSequence = 0;
    let activeCompactionLifecycleId: string | null = null;
    const nextCompactionLifecycleId = (sessionId?: string | null) => buildClaudeCompactionLifecycleId({
        sessionId: sessionId ?? opts.sessionId ?? startFrom,
        sequence: ++compactionSequence,
    });
    const emitManualCompactionStarted = () => {
        const lifecycleId = nextCompactionLifecycleId();
        activeCompactionLifecycleId = lifecycleId;
        opts.onCompletionEvent?.(buildClaudeCompactionStartedEvent({ lifecycleId }));
    };
    const publishWorkStateSnapshot = (snapshot: SessionWorkStateV1) => {
        const ownedSourceFamilies = (snapshot as { ownedSourceFamilies?: unknown }).ownedSourceFamilies;
        const hasOwnedSourceFamilies = Array.isArray(ownedSourceFamilies) && ownedSourceFamilies.length > 0;
        if (!opts.onWorkStateSnapshot || (snapshot.items.length === 0 && !hasOwnedSourceFamilies)) return;
        void Promise.resolve(opts.onWorkStateSnapshot(snapshot)).catch((error) => {
            logger.debug('[claudeRemoteAgentSdk] Failed publishing work-state snapshot (non-fatal)', error);
        });
    };

    const isTodoProjectionToolName = (value: unknown): boolean => {
        if (typeof value !== 'string') return false;
        const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
        return normalized === 'todowrite';
    };

    const taskToolWorkStateTracker = createClaudeTaskToolWorkStateTracker({
        backendId: 'claude',
        agentId: 'claude',
    });

    const publishTodoWriteWorkStateFromMessage = (message: SDKMessage) => {
        if (!message || typeof message !== 'object') return;
        const content = (message as any)?.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            if ((block as any).type !== 'tool_use') continue;
            if (!isTodoProjectionToolName((block as any).name)) continue;
            publishWorkStateSnapshot(buildClaudeTodoWriteWorkState({
                backendId: 'claude',
                agentId: 'claude',
                updatedAt: Date.now(),
                input: (block as any).input,
            }));
        }
    };

    const publishTaskToolWorkStateFromMessage = (message: SDKMessage) => {
        const snapshot = taskToolWorkStateTracker.applyMessage(message, Date.now());
        if (snapshot) publishWorkStateSnapshot(snapshot);
    };
    const emitCompactionCompleted = (params?: Readonly<{
        providerSessionId?: string | null;
        trigger?: 'manual' | 'auto' | 'threshold' | 'overflow' | 'unknown';
        tokenCountBefore?: number;
        tokenCountSource?: string;
    }>) => {
        const lifecycleId = activeCompactionLifecycleId ?? nextCompactionLifecycleId(params?.providerSessionId);
        activeCompactionLifecycleId = null;
        opts.onCompletionEvent?.(buildClaudeCompactionCompletedEvent({
            lifecycleId,
            source: 'provider-event',
            trigger: params?.trigger ?? 'manual',
            ...(params?.providerSessionId ? { providerSessionId: params.providerSessionId } : {}),
            ...(typeof params?.tokenCountBefore === 'number' ? { tokenCountBefore: params.tokenCountBefore } : {}),
            ...(params?.tokenCountSource ? { tokenCountSource: params.tokenCountSource } : {}),
        }));
    };
    const readCompactBoundaryMetadata = (system: Record<string, unknown>) => {
        const metadata = system.compact_metadata;
        const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? metadata as Record<string, unknown>
            : {};
        const rawTrigger = record.trigger;
        const trigger: 'manual' | 'auto' | 'threshold' | 'overflow' | 'unknown' | undefined =
            rawTrigger === 'manual' ||
                rawTrigger === 'auto' ||
                rawTrigger === 'threshold' ||
                rawTrigger === 'overflow' ||
                rawTrigger === 'unknown'
                ? rawTrigger
                : undefined;
        const rawPreTokens = record.pre_tokens;
        const tokenCountBefore = typeof rawPreTokens === 'number' && Number.isFinite(rawPreTokens)
            ? rawPreTokens
            : undefined;
        return {
            ...(trigger ? { trigger } : {}),
            ...(typeof tokenCountBefore === 'number'
                ? { tokenCountBefore, tokenCountSource: 'claude-compact-metadata.pre_tokens' }
                : {}),
        };
    };
    const readCompactBoundaryEventIdentity = (system: Record<string, unknown>) => buildClaudeCompactBoundaryEventIdentity({
        providerSessionId: typeof system.session_id === 'string' ? system.session_id : null,
        uuid: typeof system.uuid === 'string' ? system.uuid : null,
        timestamp: typeof system.timestamp === 'string' ? system.timestamp : null,
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
	        emitManualCompactionStarted();
	    }

        let mode = initial.mode;
        let response: any;
        let handleClaudeRuntimeActivityLossForCurrentQuery: ((reason: string) => void) | null = null;
        let didSettleRuntimeActivityForCurrentTurn = false;
		    let latestClaudeSessionId: string | null =
		        typeof opts.sessionId === 'string' && opts.sessionId.trim().length > 0 ? opts.sessionId.trim() : startFrom ?? null;
		    let latestTranscriptPath: string | null =
		        typeof opts.transcriptPath === 'string' && opts.transcriptPath.trim().length > 0 ? opts.transcriptPath.trim() : null;
		    const recordSessionFound = (sessionId: string, data?: SessionHookData) => {
		        const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
		        if (normalized.length > 0) {
		            latestClaudeSessionId = normalized;
		            const explicitTranscriptPath = (() => {
		                if (!data || typeof data !== 'object') return '';
		                const obj: any = data;
		                const raw = typeof obj.transcriptPath === 'string'
		                    ? obj.transcriptPath
		                    : typeof obj.transcript_path === 'string'
		                        ? obj.transcript_path
		                        : '';
		                return typeof raw === 'string' ? raw.trim() : '';
		            })();
		            if (explicitTranscriptPath.length > 0) {
		                latestTranscriptPath = explicitTranscriptPath;
		            } else if (!latestTranscriptPath) {
		                latestTranscriptPath = join(getProjectPath(opts.path, claudeConfigDir), `${normalized}.jsonl`);
		            }
		        }
		        opts.onSessionFound(normalized, data as any);
		    };

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
    const debugEnabled = mode.claudeRemoteDebugEnabled === true;
    const verboseEnabled = mode.claudeRemoteVerboseEnabled === true;
    const debugCategories = (() => {
        const raw = mode.claudeRemoteDebugCategories;
        if (!Array.isArray(raw)) return [] as string[];
        const set = new Set<string>();
        for (const value of raw) {
            set.add(value);
        }
        const out: string[] = [];
        for (const key of ['api', 'mcp', 'hooks', 'file', '1p'] as const) {
            if (set.has(key)) out.push(key);
        }
        return out;
    })();
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
    const providerRuntimeActivityEvidence =
        opts.providerRuntimeActivityEvidence ?? createClaudeRuntimeActivityEvidence();
    const providerActivityLedger = providerRuntimeActivityEvidence.providerActivityLedger;
    const resolveReplacementProviderTaskInterruptId = (terminalTaskId: string): string | null => (
        providerActivityLedger
            .getActiveProviderTaskBlockers()
            .filter((blocker) => blocker.taskId !== terminalTaskId)
            .at(-1)?.taskId
        ?? null
    );
    const runtimeActivityEffectParams = {
        evidence: providerRuntimeActivityEvidence,
        logger,
        logPrefix: '[claudeRemoteAgentSdk]',
        runtimeActivityAdapter: opts.runtimeActivityAdapter,
    };
    handleClaudeRuntimeActivityLossForCurrentQuery = (reason: string) => handleClaudeRuntimeActivityLoss({
        ...runtimeActivityEffectParams,
        reason,
    });
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
	        claudeConfigDir,
	        getMode: () => mode,
	        onSessionFound: (sessionId, data) => recordSessionFound(sessionId, data as any),
	        onSessionHook: (data) => {
	            const activity = readClaudeSessionHookProviderTaskActivity(data);
	            if (!activity) return;
	            publishClaudeProviderTaskRuntimeActivity({
	                ...runtimeActivityEffectParams,
	                activity,
	            });
	        },
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
        publishTodoWriteWorkStateFromMessage(normalized);
        publishTaskToolWorkStateFromMessage(normalized);
        opts.onMessage(normalizeSdkMessageForUiCompatibility(normalized, hints));
    };

    const buildSystemPrompt = (): any => {
        if (customSystemPrompt) {
            return `${customSystemPrompt}\n\n${remoteSystemPrompt}`;
        }

        const append = (appendSystemPrompt ? `${appendSystemPrompt}\n\n` : '') + remoteSystemPrompt;
        return { type: 'preset', preset: 'claude_code', append };
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
        const effortModelId = argOverrides.model ?? mode.model;
        const effortSupportedLevels = resolveModeEffortLevelsForModel(mode, effortModelId);
        const resolvedEffort = resolveClaudeEffortForModel({
            modelId: effortModelId,
            effort: argOverrides.effort ?? mode.reasoningEffort,
            supportedLevels: effortSupportedLevels,
        });
        // Ultracode is a session-only SETTING, not an effort level. The vendored Agent SDK
        // (0.2.123) has no typed `ultracode` option yet, so it rides the spawned CLI's
        // `--settings` overlay via extraArgs. Revisit on SDK bump (typed control request).
        const resolvedUltracode = resolveClaudeUltracodeForModel({
            modelId: effortModelId,
            ultracode: mode.ultracode,
            supportedLevels: effortSupportedLevels,
        });
        const extraArgs = (() => {
            const out: Record<string, string | null> = Object.create(null);
            if (enableFileCheckpointing) out['replay-user-messages'] = null;
            if (debugEnabled) out.debug = debugCategories.length > 0 ? debugCategories.join(',') : null;
            if (verboseEnabled) out.verbose = null;
            if (resolvedUltracode) out.settings = buildClaudeUltracodeSettingsJson();
            return Object.keys(out).length > 0 ? out : undefined;
        })();
        const claudeSubprocessEnv = { ...xdgIsolationEnv, ...buildClaudeSubprocessEnv(), ...experimentalEnvOverlay };
        logClaudeRuntimeAuthEnvDiagnostic({
            logPrefix: 'claudeRemoteAgentSdk',
            sessionId: opts.sessionId ?? null,
            startFrom,
            runnerEnv: process.env,
            childEnv: claudeSubprocessEnv,
        });
        const claudeSubscriptionRefreshSelection = opts.claudeSubscriptionAccessTokenRefreshSelection ?? null;
        const daemonRefreshSessionId = opts.sessionId?.trim() || 'unknown';
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
            // When the resolved mode is 'default', omit `permissionMode` so the Agent SDK falls
            // back to the user's `permissions.defaultMode` from `.claude/settings.json`. Settings
            // are already being loaded via `settingSources` above, so a user-configured
            // defaultMode (e.g. "acceptEdits") takes effect for Happier sessions that don't
            // explicitly pick a mode. Non-'default' modes still win as before.
            ...(mappedPermissionMode !== 'default' ? { permissionMode: mappedPermissionMode } : {}),
            allowDangerouslySkipPermissions: true,
            ...(resolvedEffort ? { effort: resolvedEffort } : {}),
            model: argOverrides.model ?? mode.model,
            fallbackModel: argOverrides.fallbackModel ?? mode.fallbackModel,
            maxTurns: argOverrides.maxTurns,
            systemPrompt: buildSystemPrompt(),
            strictMcpConfig: mode.claudeRemoteStrictMcpServerConfig === true || argOverrides.strictMcpConfig,
            canUseTool,
            ...(opts.happierMcpServers ? { mcpServers: opts.happierMcpServers } : {}),
            env: claudeSubprocessEnv,
            executable: runtimeExecutable,
            pathToClaudeCodeExecutable: opts.claudeExecutablePath ?? getDefaultClaudeCodePathForAgentSdk(),
            enableFileCheckpointing: enableFileCheckpointing || undefined,
            extraArgs,
            maxThinkingTokens:
                typeof mode.claudeRemoteMaxThinkingTokens === 'number' ? mode.claudeRemoteMaxThinkingTokens : undefined,
            hooks,
            ...(claudeSubscriptionRefreshSelection ? {
                getOAuthToken: createClaudeSubscriptionAccessTokenRefreshCallback({
                    sessionId: daemonRefreshSessionId,
                    selection: claudeSubscriptionRefreshSelection,
                }),
            } : {}),
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

    const shapeLogger = createEventShapeLoggerForLog({ logger, scope: 'claude-agent-sdk' });

    // Agent SDK expects objects (SDKUserMessage). It JSON-stringifies them before writing to stdin.
    type ProviderInputEnvelope = Readonly<{
        message: SDKUserMessage;
        acceptedPrompt?: ClaudeRemoteProviderAcceptedPrompt;
    }>;
    type ArmedProviderInput = Readonly<{
        serializedMessage: string;
        acceptedPrompt: ClaudeRemoteProviderAcceptedPrompt;
    }>;
    const messages = new PushableAsyncIterable<ProviderInputEnvelope>();
    let armedProviderInput: ArmedProviderInput | null = null;
    const providerMessages: AsyncIterable<SDKUserMessage> = {
        async *[Symbol.asyncIterator]() {
            for await (const envelope of messages) {
                if (envelope.acceptedPrompt) {
                    armedProviderInput = {
                        serializedMessage: `${JSON.stringify(envelope.message)}\n`,
                        acceptedPrompt: envelope.acceptedPrompt,
                    };
                }
                yield envelope.message;
            }
        },
    };

    const defaultSpawnClaudeCodeProcess = (spawnOptions: AgentSdkSpawnOptions): AgentSdkSpawnedProcess => {
        const invocation = resolveWindowsCommandInvocation({
            command: spawnOptions.command,
            args: spawnOptions.args,
            env: spawnOptions.env,
        });
        const stderrHandler = typeof queryOptions.stderr === 'function'
            ? queryOptions.stderr as (data: string) => void
            : null;
        const debugValue = spawnOptions.env.DEBUG_CLAUDE_AGENT_SDK?.trim().toLowerCase();
        const debugEnabled = Boolean(
            debugValue
            && debugValue !== '0'
            && debugValue !== 'false'
            && debugValue !== 'off'
            && debugValue !== 'no',
        );
        const child = spawn(invocation.command, invocation.args, {
            cwd: spawnOptions.cwd,
            env: spawnOptions.env,
            signal: spawnOptions.signal,
            stdio: ['pipe', 'pipe', debugEnabled || stderrHandler ? 'pipe' : 'ignore'],
            windowsHide: true,
            ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });
        child.stderr?.on('data', (data: Buffer | string) => {
            const text = data.toString();
            if (debugEnabled) {
                logger.debug('[claudeRemoteAgentSdk:stderr]', text);
            }
            try {
                stderrHandler?.(text);
            } catch {
                // Match the SDK boundary: diagnostic callbacks cannot break process transport.
            }
        });
        return child as unknown as AgentSdkSpawnedProcess;
    };

    const spawnBaseProcess = opts.spawnClaudeCodeProcess ?? defaultSpawnClaudeCodeProcess;
    queryOptions.spawnClaudeCodeProcess = (spawnOptions: AgentSdkSpawnOptions): AgentSdkSpawnedProcess => {
        const spawnedProcess = spawnBaseProcess(spawnOptions);
        const originalWrite = spawnedProcess.stdin.write.bind(spawnedProcess.stdin) as (
            ...args: unknown[]
        ) => boolean;
        const pendingWrites = new Set<(kind: ClaudeRemoteProviderPromptTransportFailure['kind']) => void>();

        const settlePendingAsAmbiguous = () => {
            for (const settle of [...pendingWrites]) {
                settle('effect_may_have_occurred');
            }
        };
        spawnedProcess.stdin.on('error', settlePendingAsAmbiguous);
        spawnedProcess.on('error', settlePendingAsAmbiguous);
        spawnedProcess.on('exit', settlePendingAsAmbiguous);

        spawnedProcess.stdin.write = ((...writeArgs: unknown[]): boolean => {
            const chunk = writeArgs[0];
            const serializedChunk = typeof chunk === 'string'
                ? chunk
                : Buffer.isBuffer(chunk)
                    ? chunk.toString()
                    : null;
            const armed = armedProviderInput;
            if (!armed || serializedChunk !== armed.serializedMessage) {
                return originalWrite(...writeArgs);
            }
            armedProviderInput = null;

            let settled = false;
            const settle = (
                outcome: 'accepted' | ClaudeRemoteProviderPromptTransportFailure['kind'],
            ): void => {
                if (settled) return;
                settled = true;
                pendingWrites.delete(settleFailure);
                if (outcome === 'accepted') {
                    confirmClaudeRemoteProviderPromptAccepted(
                        opts.onPromptAcceptedByProvider,
                        armed.acceptedPrompt,
                    );
                    return;
                }
                reportClaudeRemoteProviderPromptTransportFailure(
                    opts.onPromptTransportFailure,
                    armed.acceptedPrompt,
                    outcome,
                );
            };
            const settleFailure = (kind: ClaudeRemoteProviderPromptTransportFailure['kind']) => {
                settle(kind);
            };
            pendingWrites.add(settleFailure);

            const existingCallbackIndex = typeof writeArgs.at(-1) === 'function'
                ? writeArgs.length - 1
                : -1;
            const existingCallback = existingCallbackIndex >= 0
                ? writeArgs[existingCallbackIndex] as (error?: Error | null) => void
                : null;
            const onWriteComplete = (error?: Error | null) => {
                settle(error ? 'effect_may_have_occurred' : 'accepted');
                try {
                    existingCallback?.(error);
                } catch {
                    // Preserve the transport result even if an optional caller callback throws.
                }
            };
            if (existingCallbackIndex >= 0) {
                writeArgs[existingCallbackIndex] = onWriteComplete;
            } else {
                writeArgs.push(onWriteComplete);
            }

            try {
                return originalWrite(...writeArgs);
            } catch (error) {
                settle('rejected_before_effect');
                throw error;
            }
        }) as typeof spawnedProcess.stdin.write;

        return spawnedProcess;
    };
    let nextMessagePump: Promise<void> | null = null;
    let deferredUntilForegroundTurnEnds: ClaudeRemoteProviderAcceptedPrompt<EnhancedMode> | null = null;
    const swallowOptionalPromise = async (promise: Promise<void> | null): Promise<void> => {
        if (!promise) return;
        await promise.catch(() => {});
    };

    const streamedTranscriptWriter = opts.streamedTranscriptWriter ?? null;
    let cleanupBufferedAssistantMessages: ((incoming: unknown) => void) | null = null;
    let lastTurnFlushSummary: StreamedTranscriptFlushSummary | null = null;

	    const flushStreamedTranscriptWriter = async (
	        reason: 'tool-call-boundary' | 'turn-end' | 'abort',
	        interruptedReason?: string,
	    ): Promise<StreamedTranscriptFlushSummary | null> => {
	        if (!streamedTranscriptWriter) return null;
        try {
            return await streamedTranscriptWriter.flushAll({
                reason,
                ...(reason === 'abort' && interruptedReason ? { interruptedReason } : {}),
            });
        } catch (error) {
            logger.debug('[claudeRemoteAgentSdk] Failed flushing streamed transcript writer (non-fatal)', { error, reason });
            return null;
	        }
	    };

	    let didRequestTurnInterrupt = false;
	    const repairTranscriptAfterAbort = async () => {
	        if (!didRequestTurnInterrupt && !abortSignal.aborted) return;
	        try {
	            await repairClaudeTranscriptAfterInterrupt({
	                sessionId: latestClaudeSessionId,
	                transcriptPath: latestTranscriptPath,
	                workDir: opts.path,
	                claudeConfigDir,
	            });
	        } catch {
	            // Best-effort: transcript repair should never crash the runner.
	        }
	    };

	    const normalizeSidechainIdForStream = (message: unknown): string | null => {
	        if (!message || typeof message !== 'object') return null;
	        const raw = (message as any).parent_tool_use_id;
        return readNonBlankOpaqueIdentifier(raw);
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
	            prompt: providerMessages,
	            options: queryOptions,
        });
        opts.onWorkflowActivityObserverReady?.();
        await opts.runtimeActivityAdapter?.activateObservation('claude-agent-sdk-provider-observer-installed');
        opts.setUserMessageSender?.((message: SDKUserMessage) => messages.push({ message }));
        messages.push({
            message: {
                type: 'user',
                session_id: '',
                parent_tool_use_id: null,
                message: {
                    role: 'user',
                    content: [{ type: 'text', text: initial.message }],
                },
            },
            acceptedPrompt: initial,
        });

        let foregroundTaskInterruptId: string | null = null;
        let detachedTaskInterruptId: string | null = null;
        let foregroundTurnInterruptActive = true;
        let deferredInterruptedReason: string | null = null;

	        const interruptTurn = async (): Promise<void> => {
                let stopTaskSucceeded = false;
	            try {
                    const stopTask = (response as any)?.stopTask;
                    if (typeof stopTask === 'function') {
                        const taskId = foregroundTaskInterruptId
                            ?? (foregroundTurnInterruptActive ? null : detachedTaskInterruptId);
                        if (typeof taskId === 'string' && taskId.trim().length > 0) {
                            didRequestTurnInterrupt = true;
                            deferredInterruptedReason = deferredInterruptedReason ?? 'turn-interrupt';
                            try {
                                await stopTask.call(response, taskId);
                                stopTaskSucceeded = true;
                                return;
                            } catch {
                                // Best-effort: if stopTask fails, fall back to interrupt().
                            }
                        }
                    }

	                const interrupt = (response as any)?.interrupt;
	                if (typeof interrupt === 'function') {
	                    didRequestTurnInterrupt = true;
                        deferredInterruptedReason = deferredInterruptedReason ?? 'turn-interrupt';
	                    await interrupt.call(response);
	                }
	            } catch {
	                // Best-effort: interrupt is optional and should not crash cancellation.
	            } finally {
	                // Ensure UI thinking state is released even if Claude does not emit a clean result.
	                updateThinking(false);
                    if (!stopTaskSucceeded) {
                        try {
                            cleanupBufferedAssistantMessages?.(null);
                        } catch {
                            // ignore
                        }
	                    await flushStreamedTranscriptWriter('abort', 'turn-interrupt');
                    }
	            }
	        };
	        opts.setTurnInterrupt?.(interruptTurn);

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
        // Per-sidechain record of which scopes published assistant text this turn, so the result
        // fallback can skip re-emission for any scope that already reached the wire via any channel
        // (streamed deltas, full-message emit, stream-event buffer flush). Root is keyed as null.
        const sidechainsWithPublishedAssistantTextThisTurn = new Set<string | null>();
        // The streamed writer may flush a segment at a tool boundary before the SDK emits its
        // assembled assistant message. Keep exact per-scope coverage until that assembled
        // message arrives so already-durable text is not emitted a second time.
        const streamedAssistantTextAwaitingAssembly = new Map<string | null, string>();
        const streamedThinkingTextAwaitingAssembly = new Map<string | null, string>();
        const turnDiagnostics = {
            streamEventCount: 0,
            assistantMessageCount: 0,
            userMessageCount: 0,
            resultMessageCount: 0,
            systemMessageCount: 0,
            unknownMessageCount: 0,
            streamedTextDeltaChars: 0,
            streamedThinkingDeltaChars: 0,
            streamedToolUseDeltaChars: 0,
            didPublishAssistantTextThisTurn: false,
            didDurablyFlushAssistantTextThisTurn: false,
        };
        const resetTurnDiagnostics = () => {
            turnDiagnostics.streamEventCount = 0;
            turnDiagnostics.assistantMessageCount = 0;
            turnDiagnostics.userMessageCount = 0;
            turnDiagnostics.resultMessageCount = 0;
            turnDiagnostics.systemMessageCount = 0;
            turnDiagnostics.unknownMessageCount = 0;
            turnDiagnostics.streamedTextDeltaChars = 0;
            turnDiagnostics.streamedThinkingDeltaChars = 0;
            turnDiagnostics.streamedToolUseDeltaChars = 0;
            turnDiagnostics.didPublishAssistantTextThisTurn = false;
            turnDiagnostics.didDurablyFlushAssistantTextThisTurn = false;
        };
        const seen = { toolUseIds: new Set<string>(), toolResultIds: new Set<string>() };
        let lastCheckpointId: string | null = null;
        const checkpointIds: string[] = [];
        const checkpointIdSet = new Set<string>();
        let didFinalizeTurn = false;
        let awaitingNextTurnStart = false;
        let didReleaseTurnForResult = false;
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

        const collectAgentSdkResultErrorText = (value: unknown, output: string[]): void => {
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (trimmed) output.push(trimmed);
                return;
            }
            if (value instanceof Error) {
                collectAgentSdkResultErrorText(value.message, output);
                return;
            }
            if (Array.isArray(value)) {
                for (const item of value) collectAgentSdkResultErrorText(item, output);
                return;
            }
            if (!value || typeof value !== 'object') return;
            const record = value as Record<string, unknown>;
            for (const key of ['message', 'error', 'detail', 'details', 'description', 'code', 'type']) {
                collectAgentSdkResultErrorText(record[key], output);
            }
        };

        const formatAgentSdkResultFailureText = (subtype: string, parts: readonly string[]): string => {
            const detail = trimBugReportTextToMaxBytes(
                redactBugReportSensitiveText(parts.join('; ')),
                1_024,
            ).trim();
            return detail ? `${subtype}: ${detail}` : subtype;
        };

        const readAgentSdkResultFailure = (message: unknown): string | null => {
            const msg: any = message;
            if (!msg || typeof msg !== 'object' || msg.type !== 'result') return null;
            const subtype = typeof msg.subtype === 'string' ? msg.subtype : '';
            if (subtype !== 'error_max_turns' && subtype !== 'error_during_execution') return null;
            const errorParts: string[] = [];
            collectAgentSdkResultErrorText(msg.errors, errorParts);
            const resultText = extractResultText(message);
            if (resultText) errorParts.push(resultText);
            return formatAgentSdkResultFailureText(subtype, errorParts);
        };

        const hasActiveProviderTasks = (): boolean => providerActivityLedger.hasActiveProviderTasks();

        const markAssistantTextPublished = (text: string | null | undefined, sidechainId: string | null) => {
            if (typeof text !== 'string' || text.trim().length === 0) return;
            didPublishAssistantTextThisTurn = true;
            turnDiagnostics.didPublishAssistantTextThisTurn = true;
            sidechainsWithPublishedAssistantTextThisTurn.add(sidechainId);
        };

        const appendStreamedTextAwaitingAssembly = (
            target: Map<string | null, string>,
            sidechainId: string | null,
            text: string,
        ) => {
            if (text.length === 0) return;
            target.set(sidechainId, `${target.get(sidechainId) ?? ''}${text}`);
        };

        const resolveAssistantSegmentFlushSummary = (
            summary: StreamedTranscriptFlushSummary | null,
            sidechainId: string | null,
        ): { sawText: boolean; didDurablyFlush: boolean } | null => {
            if (!summary) return null;
            const segmentSummaries = Array.isArray(summary.segments) ? summary.segments : [];
            const exact = segmentSummaries.find(
                (segment) => segment.kind === 'assistant' && segment.sidechainId === sidechainId,
            );
            if (exact) {
                return {
                    sawText: exact.sawText,
                    didDurablyFlush: exact.didDurablyFlush,
                };
            }
            if (sidechainId !== null) return null;
            return summary.assistantRoot;
        };

        const emitAssistantTextMessage = (params: {
            sessionId: string;
            parentToolUseId: string | null;
            assistantText: string;
            thinkingText?: string;
            defaultUuid?: string | null;
        }) => {
            const assistantText = params.assistantText.trim();
            const thinkingText = typeof params.thinkingText === 'string' ? params.thinkingText.trim() : '';
            if (assistantText.length === 0 && thinkingText.length === 0) return;
            const content = [
                ...(thinkingText.length > 0 ? [{ type: 'thinking' as const, thinking: params.thinkingText ?? '' }] : []),
                ...(assistantText.length > 0 ? [{ type: 'text' as const, text: params.assistantText }] : []),
            ];
            emitMessage({
                type: 'assistant',
                session_id: params.sessionId,
                parent_tool_use_id: params.parentToolUseId,
                ...(params.defaultUuid ? { uuid: params.defaultUuid } : null),
                message: {
                    role: 'assistant',
                    content,
                },
            } as any, params.defaultUuid ? { defaultUuid: params.defaultUuid } : undefined);
            markAssistantTextPublished(params.assistantText, params.parentToolUseId);
        };

        const maybeEmitResultAssistantFallback = (message: unknown, resultText: string | null): boolean => {
            if (!streamedTranscriptWriter || typeof resultText !== 'string' || resultText.trim().length === 0) {
                return false;
            }
            const sidechainId = normalizeSidechainIdForStream(message);
            // Belt-and-suspenders: if assistant text already reached the wire for THIS scope
            // (root or sidechain) via any channel this turn (streamed deltas, full-message emit,
            // buffered stream-event flush), re-emitting from the result message would duplicate
            // the message with a synthetic uuid. Durable flushing is the preferred signal; this
            // guard catches any other delivery path.
            if (sidechainsWithPublishedAssistantTextThisTurn.has(sidechainId)) {
                return false;
            }
            const assistantFlush = resolveAssistantSegmentFlushSummary(lastTurnFlushSummary, sidechainId);
            if (sidechainId === null) {
                if (assistantFlush?.didDurablyFlush === true) {
                    return false;
                }
            } else if (assistantFlush?.sawText !== true || assistantFlush.didDurablyFlush === true) {
                return false;
            }
            const sessionId = typeof (message as any)?.session_id === 'string' ? (message as any).session_id : '';
            const uuid = typeof (message as any)?.uuid === 'string' ? (message as any).uuid : null;
            emitAssistantTextMessage({
                sessionId,
                parentToolUseId: sidechainId,
                assistantText: resultText,
                defaultUuid: uuid,
            });
            logger.debug('[claudeRemoteAgentSdk] Materialized result assistant fallback after non-durable streamed flush', {
                sidechainId,
                resultTextLength: resultText.length,
            });
            return true;
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

	                // When we have a streamed transcript writer, it is the single source of truth for assistant/thinking
	                // content. Stream-event buffering exists only to support legacy flows (no streamed writer) and to
	                // help with tool-block reconstruction. Never emit buffered assistant content in writer mode.
	                if (streamedTranscriptWriter) {
	                    markAssistantTextPublished(pendingAssistantText, pending.parentToolUseId);
	                    return;
	                }
	
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
                    markAssistantTextPublished(pendingAssistantText, pending.parentToolUseId);
                    return;
                }

                const defaultUuid = typeof pending.lastUuid === 'string' && pending.lastUuid.trim().length > 0
                    ? pending.lastUuid.trim()
                    : null;
                emitAssistantTextMessage({
                    sessionId: pending.sessionId,
                    parentToolUseId: pending.parentToolUseId,
                    assistantText: pending.text,
                    thinkingText: pending.thinking,
                    defaultUuid,
                });
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
                        const nextOrAbort = deferredUntilForegroundTurnEnds ?? await Promise.race([
                            opts.nextMessage(),
                            waitForAbort(abortSignal),
                        ]);
                        deferredUntilForegroundTurnEnds = null;
                        if (nextOrAbort === ABORTED) {
                            return;
                        }

                        const next: ClaudeRemoteProviderAcceptedPrompt<EnhancedMode> | null = nextOrAbort;
                        if (!next) {
                            messages.end();
                            try {
                                response?.close?.();
                            } catch {
                                // ignore
                            }
                            return;
                        }

                        // The active pump exists only to consume an explicit provider action.
                        // Preserve an ordinary queued row for the normal post-result turn rather
                        // than silently turning it into in-flight steering input.
                        if (foregroundTurnInterruptActive && next.pendingProviderAction === undefined) {
                            deferredUntilForegroundTurnEnds = next;
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
                            emitManualCompactionStarted();
                        }

                        mode = next.mode;
                        lastTurnFlushSummary = null;

                        try {
                            await applyRuntimeSettingsUpdatesIfNeeded(resolveDesiredRuntimeSettingsSnapshot(mode));
                        } catch (e) {
                            logger.debug('[claudeRemoteAgentSdk] Failed to update runtime settings (non-fatal)', e);
                            opts.onCompletionEvent?.('Failed to update runtime settings (non-fatal); continuing.');
                        }

                        const pendingProviderAction = next.pendingProviderAction;
                        if (pendingProviderAction === 'interrupt_and_send') {
                            const interrupt = (response as any)?.interrupt;
                            if (typeof interrupt !== 'function') {
                                reportClaudeRemoteProviderPromptTransportFailure(
                                    opts.onPromptTransportFailure,
                                    next,
                                    'rejected_before_effect',
                                );
                                continue;
                            }
                            opts.onInFlightSteerAvailabilityChange?.(false);
                            try {
                                didRequestTurnInterrupt = true;
                                deferredInterruptedReason = deferredInterruptedReason ?? 'pending-interrupt-and-send';
                                await interrupt.call(response);
                                cleanupBufferedAssistantMessages?.(null);
                                await flushStreamedTranscriptWriter('abort', 'pending-interrupt-and-send');
                            } catch {
                                reportClaudeRemoteProviderPromptTransportFailure(
                                    opts.onPromptTransportFailure,
                                    next,
                                    'rejected_before_effect',
                                );
                                opts.onInFlightSteerAvailabilityChange?.(true);
                                continue;
                            }
                        }

                        if (pendingProviderAction !== 'steer') {
                            didPublishAssistantTextThisTurn = false;
                            sidechainsWithPublishedAssistantTextThisTurn.clear();
                            streamedAssistantTextAwaitingAssembly.clear();
                            streamedThinkingTextAwaitingAssembly.clear();
                            didReleaseTurnForResult = false;
                            didSettleRuntimeActivityForCurrentTurn = false;
                            foregroundTaskInterruptId = null;
                        }
                        foregroundTurnInterruptActive = true;
                        messages.push({
                            message: {
                                type: 'user',
                                session_id: '',
                                parent_tool_use_id: null,
                                message: {
                                    role: 'user',
                                    content: [{ type: 'text', text: next.message }],
                                },
                            },
                            acceptedPrompt: next,
                        });

                        updateThinking(true);
                        opts.onInFlightSteerAvailabilityChange?.(true);
                    }
                } finally {
                    nextMessagePump = null;
                }
            })();
        };

        const finalizeCurrentTurn = async (params?: { completionEvent?: ClaudeCompletionEvent }) => {
            if (didFinalizeTurn) return;
            didFinalizeTurn = true;
            awaitingNextTurnStart = true;
            foregroundTurnInterruptActive = false;
            opts.onInFlightSteerAvailabilityChange?.(false);
            foregroundTaskInterruptId = null;
            updateThinking(false);
            const interruptedReason = deferredInterruptedReason;
            deferredInterruptedReason = null;
            if (typeof interruptedReason === 'string' && interruptedReason.trim().length > 0) {
                lastTurnFlushSummary = await flushStreamedTranscriptWriter('abort', interruptedReason);
            } else {
                lastTurnFlushSummary = await flushStreamedTranscriptWriter('turn-end');
            }
            turnDiagnostics.didDurablyFlushAssistantTextThisTurn = lastTurnFlushSummary?.assistantRoot.didDurablyFlush === true;
            logger.debug('[claudeRemoteAgentSdk] Turn summary', {
                ...turnDiagnostics,
                didPublishAssistantTextThisTurn,
            });
            await reconcileClaudeRuntimeActivity({
                ...runtimeActivityEffectParams,
                reason: 'claude_agent_sdk_foreground_finalized',
            });
            didSettleRuntimeActivityForCurrentTurn = true;
            resetTurnDiagnostics();
            if (params?.completionEvent) {
                opts.onCompletionEvent?.(params.completionEvent);
            }
            await opts.onReady();
            scheduleNextMessagePump();
        };

        const reconcileRuntimeActivityForResult = async () => {
            foregroundTurnInterruptActive = false;
            opts.onInFlightSteerAvailabilityChange?.(false);
            foregroundTaskInterruptId = null;
            if (!hasActiveProviderTasks()) {
                detachedTaskInterruptId = null;
            }
            updateThinking(false);
            lastTurnFlushSummary = await flushStreamedTranscriptWriter('turn-end');
            turnDiagnostics.didDurablyFlushAssistantTextThisTurn = lastTurnFlushSummary?.assistantRoot.didDurablyFlush === true;
            logger.debug('[claudeRemoteAgentSdk] Turn result summary', {
                ...turnDiagnostics,
                didPublishAssistantTextThisTurn,
                resultObserved: true,
                activeProviderTaskBlockers: providerActivityLedger.getActiveProviderTaskBlockers(),
                activeProviderTaskCount: providerActivityLedger.getActiveProviderTaskCount(),
            });
            await reconcileClaudeRuntimeActivity({
                ...runtimeActivityEffectParams,
                reason: 'claude_agent_sdk_foreground_result',
            });
            didSettleRuntimeActivityForCurrentTurn = true;
            resetTurnDiagnostics();
        };

        const releaseCurrentTurnForResult = async () => {
            if (didFinalizeTurn || didReleaseTurnForResult) return;
            didReleaseTurnForResult = true;
            await reconcileRuntimeActivityForResult();
            await opts.onReady();
            scheduleNextMessagePump();
        };

        const finalizeSubagentTurn = async () => {
            lastTurnFlushSummary = await flushStreamedTranscriptWriter('turn-end');
            logger.debug('[claudeRemoteAgentSdk] Subagent turn summary', {
                ...turnDiagnostics,
                didPublishAssistantTextThisTurn,
            });
            resetTurnDiagnostics();
            await opts.onSubagentFlush?.();
        };

        const noteTerminalProviderTask = async (
            activity: Readonly<{ type: 'terminal'; sessionId: string; taskId: string }>,
            options: { flushSubagent: boolean },
        ): Promise<boolean> => {
            const taskId = activity.taskId;
            publishClaudeProviderTaskRuntimeActivity({
                ...runtimeActivityEffectParams,
                activity,
            });
            if (taskId === foregroundTaskInterruptId) {
                foregroundTaskInterruptId = null;
            }
            if (taskId === detachedTaskInterruptId) {
                detachedTaskInterruptId = resolveReplacementProviderTaskInterruptId(taskId);
            }
            if (options.flushSubagent) {
                await finalizeSubagentTurn();
            }
            return true;
        };

        opts.onInFlightSteerAvailabilityChange?.(true);
        scheduleNextMessagePump();

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
            const inboundType = (() => {
                if (!message || typeof message !== 'object') return 'unknown';
                const raw = (message as any).type;
                return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : 'unknown';
            })();
            shapeLogger.log(`inbound:${inboundType}`, message);
            if (inboundType === 'stream_event') {
                turnDiagnostics.streamEventCount += 1;
            } else if (inboundType === 'assistant') {
                turnDiagnostics.assistantMessageCount += 1;
            } else if (inboundType === 'user') {
                turnDiagnostics.userMessageCount += 1;
            } else if (inboundType === 'result') {
                turnDiagnostics.resultMessageCount += 1;
            } else if (inboundType === 'system') {
                turnDiagnostics.systemMessageCount += 1;
            } else {
                turnDiagnostics.unknownMessageCount += 1;
            }

            const runtimeAuthFailure = classifyClaudeConnectedServiceRuntimeAuthFailure({ error: message });
            if (runtimeAuthFailure) {
                const retryDecision = resolveClaudeRuntimeAuthRetryDecision(message);
                if (retryDecision.action === 'await_provider_retry') {
                    emitMessage(message as SDKMessage);
                    continue;
                }
                await opts.onRuntimeAuthFailureEvent?.(message);
                emitMessage(message as SDKMessage);
                return;
            } else {
                const quotaEvidence = mapClaudeRateLimitEventToQuotaEvidence(message);
                if (quotaEvidence) {
                    await opts.onQuotaEvidence?.(quotaEvidence);
                }
                const rateLimitDetails = mapClaudeRateLimitEventToUsageDetails(message);
                if (rateLimitDetails) {
                    await opts.onRateLimitEvent?.(rateLimitDetails);
                }
            }
            if (inboundType === 'rate_limit_event') {
                continue;
            }

            if (message && typeof message === 'object' && (message as any).type === 'stream_event') {
                const clearFinalizeGuardForNextTurnStart = () => {
                    // Claude can emit the next turn's assistant output exclusively via stream_event
                    // messages (no assembled assistant/user message). If we finalized the previous
                    // turn (e.g. after a standalone /compact command), we still need to clear the
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
                    turnDiagnostics.streamedThinkingDeltaChars += thinkingStart.length;
                    const sidechainId = normalizeSidechainIdForStream(message);
                    appendStreamedTextAwaitingAssembly(streamedThinkingTextAwaitingAssembly, sidechainId, thinkingStart);
                    streamedTranscriptWriter?.appendThinkingDelta(thinkingStart, { sidechainId });
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
                        turnDiagnostics.streamedTextDeltaChars += textStart.length;
                        const sidechainId = normalizeSidechainIdForStream(message);
                        appendStreamedTextAwaitingAssembly(streamedAssistantTextAwaitingAssembly, sidechainId, textStart);
                        streamedTranscriptWriter?.appendAssistantDelta(textStart, { sidechainId });
                    } else {
                        streamingToolResult.content += textStart;
                        turnDiagnostics.streamedToolUseDeltaChars += textStart.length;
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
                        turnDiagnostics.streamedToolUseDeltaChars += toolUseInputDelta.length;
                        continue;
                    }
                }

                const thinkingDelta = extractThinkingDeltaFromStreamEvent(message);
                if (thinkingDelta) {
                    clearFinalizeGuardForNextTurnStart();
                    const buffered = ensureBufferedStreamEventAssistantMessage(message);
                    buffered.thinking += thinkingDelta;
                    turnDiagnostics.streamedThinkingDeltaChars += thinkingDelta.length;
                    const sidechainId = normalizeSidechainIdForStream(message);
                    appendStreamedTextAwaitingAssembly(streamedThinkingTextAwaitingAssembly, sidechainId, thinkingDelta);
                    streamedTranscriptWriter?.appendThinkingDelta(thinkingDelta, { sidechainId });
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
                        turnDiagnostics.streamedTextDeltaChars += textDelta.length;
                        const sidechainId = normalizeSidechainIdForStream(message);
                        appendStreamedTextAwaitingAssembly(streamedAssistantTextAwaitingAssembly, sidechainId, textDelta);
                        streamedTranscriptWriter?.appendAssistantDelta(textDelta, { sidechainId });
                    } else {
                        streamingToolResult.content += textDelta;
                        turnDiagnostics.streamedToolUseDeltaChars += textDelta.length;
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
                if (isCompactHookLocalCommandStdout(sdkMessage)) continue;
                const deduped = stripSeenToolBlocksFromMessage(sdkMessage, seen);
                if (!deduped) continue;

                let messageToEmit = deduped;
                if (incomingMessageType === 'assistant' && streamedTranscriptWriter) {
                    const { assistantText, thinkingText } = extractAssistantAndThinkingTextFromAssistantMessage(deduped);
                    const sidechainId = normalizeSidechainIdForStream(deduped);
                    let stripThinkingText = false;
                    let stripAssistantText = false;
                    if (typeof thinkingText === 'string' && thinkingText.length > 0) {
                        const didOverrideLiveSegment = streamedTranscriptWriter.overrideThinkingText(thinkingText, { sidechainId });
                        stripThinkingText = streamedThinkingTextAwaitingAssembly.get(sidechainId) === thinkingText
                            || didOverrideLiveSegment;
                    }
                    if (typeof assistantText === 'string' && assistantText.length > 0) {
                        const didOverrideLiveSegment = streamedTranscriptWriter.overrideAssistantText(assistantText, { sidechainId });
                        stripAssistantText = streamedAssistantTextAwaitingAssembly.get(sidechainId) === assistantText
                            || didOverrideLiveSegment;
                    }
                    streamedThinkingTextAwaitingAssembly.delete(sidechainId);
                    streamedAssistantTextAwaitingAssembly.delete(sidechainId);
                    messageToEmit = stripCoveredAssistantBlocks({
                        message: deduped,
                        stripAssistantText,
                        stripThinkingText,
                    });
                    markAssistantTextPublished(assistantText, sidechainId);
                } else if (incomingMessageType === 'assistant') {
                    markAssistantTextPublished(
                        extractAssistantText(deduped),
                        normalizeSidechainIdForStream(deduped),
                    );
                }

                emitMessage(messageToEmit);
                recordSeenToolBlocks(messageToEmit, seen);

                if (
                    awaitingNextTurnStart &&
                    didFinalizeTurn &&
                    (
                        incomingMessageType === 'assistant'
                        || incomingMessageType === 'user'
                        || incomingMessageType === 'result'
                    )
                ) {
                    awaitingNextTurnStart = false;
                    didFinalizeTurn = false;
                }

                const providerTaskFacts = isReplaySdkMessage(message)
                    ? null
                    : normalizeClaudeProviderTaskEvent(message);
                if (providerTaskFacts?.interruptTarget?.type === 'active') {
                    const taskId = providerTaskFacts.interruptTarget.taskId;
                    const previousDetachedTaskId: string | null = detachedTaskInterruptId;
                    detachedTaskInterruptId = taskId;
                    if (
                        foregroundTurnInterruptActive
                        && !foregroundTaskInterruptId
                        && taskId !== previousDetachedTaskId
                    ) {
                        foregroundTaskInterruptId = taskId;
                    }
                } else if (
                    providerTaskFacts?.interruptTarget?.type === 'terminal'
                    && providerTaskFacts.activity === null
                ) {
                    const taskId = providerTaskFacts.interruptTarget.taskId;
                    if (foregroundTaskInterruptId === taskId) foregroundTaskInterruptId = null;
                    if (detachedTaskInterruptId === taskId) {
                        detachedTaskInterruptId = resolveReplacementProviderTaskInterruptId(taskId);
                    }
                }

                if (message && message.type === 'system') {
                    const system = message as SDKSystemMessage;
                    const subtype = (system as any).subtype;
                    const taskActivity = providerTaskFacts?.activity ?? null;

                    if (taskActivity) {
                        if (taskActivity.type === 'started') {
                            publishClaudeProviderTaskRuntimeActivity({
                                ...runtimeActivityEffectParams,
                                activity: taskActivity,
                            });
                        } else if (taskActivity.type === 'progress') {
                            publishClaudeProviderTaskRuntimeActivity({
                                ...runtimeActivityEffectParams,
                                activity: taskActivity,
                            });
                        } else if (taskActivity.type === 'terminal') {
                            await noteTerminalProviderTask(taskActivity, {
                                flushSubagent: subtype === 'task_notification',
                            });
                        }
                    }

                    if (subtype === 'init' || subtype === 'compact_boundary') {
                        if (system.session_id) {
                            const transcriptPath = join(
                                getProjectPath(opts.path, claudeConfigDir),
                                `${system.session_id}.jsonl`,
                            );
                            logger.debug(
                                subtype === 'compact_boundary'
                                    ? '[claudeRemoteAgentSdk] Compact boundary'
                                    : '[claudeRemoteAgentSdk] Session initialized',
                                {
                                    claudeSessionId: system.session_id,
                                    transcriptPath,
                                },
                            );
                            recordSessionFound(system.session_id, {
                                transcript_path: transcriptPath,
                                transcriptPath,
                                ...(subtype === 'compact_boundary' ? { source: 'compact' } : {}),
                            });
                        }

                        if (subtype === 'compact_boundary') {
                            const wasStandaloneCompactCommand = isCompactCommand;
                            const providerEventId = readCompactBoundaryEventIdentity(system as Record<string, unknown>);
                            const completionEvent = buildClaudeCompactionCompletedEvent({
                                lifecycleId: activeCompactionLifecycleId
                                    ?? providerEventId
                                    ?? nextCompactionLifecycleId(system.session_id),
                                source: 'provider-event',
                                ...(providerEventId ? { providerEventId } : {}),
                                providerSessionId: typeof system.session_id === 'string' ? system.session_id : undefined,
                                ...readCompactBoundaryMetadata(system as Record<string, unknown>),
                            });
                            activeCompactionLifecycleId = null;
                            isCompactCommand = false;
                            if (wasStandaloneCompactCommand) {
                                await finalizeCurrentTurn({ completionEvent });
                            } else {
                                opts.onCompletionEvent?.(completionEvent);
                            }
                        } else if (isCompactCommand) {
                            emitCompactionCompleted();
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
                const failure = readAgentSdkResultFailure(message);
                if (failure) {
                    await reconcileRuntimeActivityForResult();
                    throw new Error(failure);
                }

                const resultText = extractResultText(message);
                if (!streamedTranscriptWriter && !didPublishAssistantTextThisTurn && resultText) {
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

                if (!didFinalizeTurn) {
                    if (isCompactCommand) {
                        isCompactCommand = false;
                        await finalizeCurrentTurn({
                            completionEvent: buildClaudeCompactionCompletedEvent({
                                lifecycleId: activeCompactionLifecycleId ?? nextCompactionLifecycleId(),
                                source: 'provider-event',
                            }),
                        });
                        activeCompactionLifecycleId = null;
                    } else {
                        await releaseCurrentTurnForResult();
                    }
                }

                maybeEmitResultAssistantFallback(message, resultText);

                if (didFinalizeTurn) {
                    continue;
                }
            }
        }
	    } catch (e) {
	        if (e instanceof AgentSdkAbortError) {
	            logger.debug('[claudeRemoteAgentSdk] Aborted');
	            return;
	        }
        if (e && typeof e === 'object') {
            const err = e as any;
            const existing = err.happierClaudeCodeArtifacts;
            const artifacts =
                existing && typeof existing === 'object' && !Array.isArray(existing)
                    ? (existing as Record<string, unknown>)
                    : ({} as Record<string, unknown>);

            if (artifacts.debugFilePath === undefined) artifacts.debugFilePath = debugFilePath ?? null;
            if (artifacts.stderrFilePath === undefined) artifacts.stderrFilePath = stderrAppender?.path ?? null;

            const debugPath = typeof artifacts.debugFilePath === 'string' ? artifacts.debugFilePath : null;
            const stderrPath = typeof artifacts.stderrFilePath === 'string' ? artifacts.stderrFilePath : null;

            if (typeof artifacts.debugTail !== 'string') {
                artifacts.debugTail = debugPath
                    ? await readTailTextFile({ path: debugPath, maxBytes: configuration.filesReadMaxBytes }).catch(() => '')
                    : '';
            }
            if (typeof artifacts.stderrTail !== 'string') {
                artifacts.stderrTail = stderrPath
                    ? await readTailTextFile({ path: stderrPath, maxBytes: configuration.filesReadMaxBytes }).catch(() => '')
                    : '';
            }

            err.happierClaudeCodeArtifacts = artifacts;
        }
        throw e;
    } finally {
        opts.onInFlightSteerAvailabilityChange?.(false);
        opts.setUserMessageSender?.(null);
        opts.setTurnInterrupt?.(null);
        if (!didSettleRuntimeActivityForCurrentTurn || providerActivityLedger.hasActiveProviderTasks()) {
            handleClaudeRuntimeActivityLossForCurrentQuery?.('claude_agent_sdk_stream_finalized');
        }
        updateThinking(false);
        cleanupBufferedAssistantMessages?.(null);

        await flushStreamedTranscriptWriter('abort', 'runner-finalize');

        abortController.abort();
        await swallowOptionalPromise(nextMessagePump);

        try {
            const maybe = (response as any)?.close?.();
            await Promise.resolve(maybe);
        } catch {
            // ignore
        }

        await repairTranscriptAfterAbort();
        await stderrAppender?.close().catch(() => {});
    }
}
