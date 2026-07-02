import { type Query as AgentSdkQueryType, query as agentSdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'node:path';

import { createSubprocessStderrAppender, resolveSubprocessArtifactsDir } from '@/agent/runtime/subprocessArtifacts';
import type { EnhancedMode } from '@/backends/claude/runtime/claudeEnhancedMode';
import type { PermissionResult } from '@/backends/claude/sdk/types';
import type { SDKUserMessage } from '@/backends/claude/sdk';
import { getDefaultClaudeCodePathForAgentSdk } from '@/backends/claude/sdk/utils';
import type { SessionHookData } from '@happier-dev/plugins-claude/agent/hooks/protocol';
import {
    applyClaudeAgentSdkAdvancedOptions,
    resolveClaudeAgentSdkExtraArgs,
} from '@happier-dev/plugins-claude/agent/runtime/remote/sdk';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';
import { ensureClaudeJsRuntimeExecutable } from '@/backends/claude/utils/ensureClaudeJsRuntimeExecutable';
import { tryMergeUserMcpConfigArgsIntoHappierMcp } from '@/backends/claude/utils/mcpConfigMerge';
import { parseClaudeSdkFlagOverridesFromArgs } from '@/backends/claude/remote/sdkFlagOverrides';
import { resolveClaudeRemoteSessionStartPlan } from '@/backends/claude/remote/sessionStartPlan';
import { logClaudeRuntimeAuthEnvDiagnostic } from '@/backends/claude/spawn/logClaudeRuntimeAuthEnvDiagnostic';
import {
    buildClaudeAgentSdkSubprocessEnv,
    getClaudeRemoteSystemPromptText,
    resolveClaudeRemoteSdkLaunchSettings,
    resolveDesiredRuntimeSettingsSnapshot,
} from './agentSdk/claudeAgentSdkLaunchConfig';
import { buildClaudeAgentSdkHooks } from './agentSdk/buildClaudeAgentSdkHooks';
import type {
    AgentSdkQueryFactory,
    RunClaudeRemoteAgentSdkCanCallToolOptions,
    RunClaudeRemoteAgentSdkOptions,
} from './runAgentSdkTypes';

export type PrepareClaudeAgentSdkLaunchContextResult = {
    abortController: AbortController;
    abortSignal: AbortSignal;
    argOverrides: ReturnType<typeof parseClaudeSdkFlagOverridesFromArgs>;
    builtHooks: ReturnType<typeof buildClaudeAgentSdkHooks>;
    claudeConfigDir: ReturnType<typeof resolveClaudeConfigDirOverride>;
    createQuery: AgentSdkQueryFactory;
    debugFilePath: string | undefined;
    enableFileCheckpointing: boolean;
    launchSettings: ReturnType<typeof resolveClaudeRemoteSdkLaunchSettings>;
    lastAppliedRuntimeSettings: ReturnType<typeof resolveDesiredRuntimeSettingsSnapshot>;
    normalizedOpts: RunClaudeRemoteAgentSdkOptions;
    queryOptions: Record<string, unknown>;
    startFrom: string | null;
    stderrAppender: Awaited<ReturnType<typeof createSubprocessStderrAppender>>;
};

function argsContainMcpConfigFlag(args?: string[] | null): boolean {
    const input = args ?? [];
    for (const arg of input) {
        if (arg === '--mcp-config') return true;
        if (typeof arg === 'string' && arg.startsWith('--mcp-config=')) return true;
    }
    return false;
}

export async function prepareClaudeAgentSdkLaunchContext(params: {
    opts: RunClaudeRemoteAgentSdkOptions;
    initialMode: EnhancedMode;
    prompt: string | AsyncIterable<SDKUserMessage>;
    getMode: () => EnhancedMode;
    recordSessionFound: (sessionId: string, data?: SessionHookData) => void;
    canCallTool: (
        toolName: string,
        input: unknown,
        resolvedMode: EnhancedMode,
        options: RunClaudeRemoteAgentSdkCanCallToolOptions,
    ) => Promise<PermissionResult>;
}): Promise<PrepareClaudeAgentSdkLaunchContextResult> {
    const claudeConfigDir = resolveClaudeConfigDirOverride(process.env);
    const { startFrom, shouldContinue } = resolveClaudeRemoteSessionStartPlan(
        {
            sessionId: params.opts.sessionId,
            transcriptPath: params.opts.transcriptPath,
            path: params.opts.path,
            claudeConfigDir,
            claudeArgs: params.opts.claudeArgs,
        },
        {
            logPrefix: 'claudeRemoteAgentSdk',
        },
    );

    const mergedMcp = tryMergeUserMcpConfigArgsIntoHappierMcp({
        baseMcpServers: (params.opts.happierMcpServers ?? Object.create(null)) as Record<string, unknown>,
        claudeArgs: params.opts.claudeArgs,
    });
    if (!mergedMcp && argsContainMcpConfigFlag(params.opts.claudeArgs)) {
        throw new Error('Invalid --mcp-config: expected JSON object with a { "mcpServers": { ... } } field.');
    }

    const normalizedOpts: RunClaudeRemoteAgentSdkOptions = {
        ...params.opts,
        claudeArgs: mergedMcp ? mergedMcp.filteredClaudeArgs : params.opts.claudeArgs,
        ...(mergedMcp?.mergedMcpServers ? { happierMcpServers: mergedMcp.mergedMcpServers } : {}),
    };

    const argOverrides = parseClaudeSdkFlagOverridesFromArgs(normalizedOpts.claudeArgs);
    const launchSettings = resolveClaudeRemoteSdkLaunchSettings({
        mode: params.initialMode,
        argOverrides,
        sessionId: normalizedOpts.sessionId ?? null,
        resumeSessionAt: normalizedOpts.resumeSessionAt ?? null,
        onCompletionEvent: normalizedOpts.onCompletionEvent,
    });
    const remoteSystemPrompt = getClaudeRemoteSystemPromptText({ mode: params.initialMode });

    const abortController = new AbortController();
    const abortSignal = abortController.signal;
    if (normalizedOpts.signal) {
        if (normalizedOpts.signal.aborted) {
            abortController.abort();
        } else {
            normalizedOpts.signal.addEventListener('abort', () => abortController.abort(), { once: true });
        }
    }

    const createQuery: AgentSdkQueryFactory =
        normalizedOpts.createQuery ?? ((queryParams) => agentSdkQuery(queryParams as any) as AgentSdkQueryType);
    const runtimeExecutable = await ensureClaudeJsRuntimeExecutable(normalizedOpts.jsRuntime);

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

    const builtHooks = buildClaudeAgentSdkHooks({
        cwd: normalizedOpts.path,
        claudeConfigDir,
        getMode: params.getMode,
        onSessionFound: (sessionId, data) => params.recordSessionFound(sessionId, data as any),
        canCallTool: (toolName, input, resolvedMode, options) =>
            params.canCallTool(toolName, input, resolvedMode, {
                signal: options.signal,
                toolUseId: options.toolUseId ?? null,
                agentId: options.agentId ?? null,
                suggestions: options.suggestions,
                blockedPath: options.blockedPath ?? null,
                decisionReason: options.decisionReason ?? null,
            }),
    });

    const {
        customSystemPrompt,
        appendSystemPrompt,
        enableFileCheckpointing,
        settingSources,
        advancedOptions,
        mappedPermissionMode,
        resumeSessionAt,
        resolvedEffort,
    } = launchSettings;

    const buildSystemPrompt = (): any => {
        if (customSystemPrompt) {
            return `${customSystemPrompt}\n\n${remoteSystemPrompt}`;
        }

        const append = (appendSystemPrompt ? `${appendSystemPrompt}\n\n` : '') + remoteSystemPrompt;
        return { type: 'preset', preset: 'claude_code', append };
    };

    const extraArgs = resolveClaudeAgentSdkExtraArgs({
        enableFileCheckpointing,
        debugEnabled: launchSettings.debugEnabled,
        verboseEnabled: launchSettings.verboseEnabled,
        debugCategories: launchSettings.debugCategories,
    });
    const childEnv = buildClaudeAgentSdkSubprocessEnv({
        claudeConfigDir,
        xdgIsolationEnv: launchSettings.xdgIsolationEnv,
        experimentalEnvOverlay: launchSettings.experimentalEnvOverlay,
    });
    logClaudeRuntimeAuthEnvDiagnostic({
        logPrefix: 'claudeRemoteAgentSdk',
        sessionId: normalizedOpts.sessionId ?? null,
        startFrom,
        runnerEnv: process.env,
        childEnv,
    });

    const queryOptions: Record<string, unknown> = {
        abortController,
        includePartialMessages: true,
        cwd: normalizedOpts.path,
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
        model: argOverrides.model ?? params.initialMode.model,
        fallbackModel: argOverrides.fallbackModel ?? params.initialMode.fallbackModel,
        maxTurns: argOverrides.maxTurns,
        systemPrompt: buildSystemPrompt(),
        strictMcpConfig: params.initialMode.claudeRemoteStrictMcpServerConfig === true || argOverrides.strictMcpConfig,
        canUseTool: builtHooks.canUseTool,
        ...(normalizedOpts.happierMcpServers ? { mcpServers: normalizedOpts.happierMcpServers } : {}),
        env: childEnv,
        executable: runtimeExecutable,
        pathToClaudeCodeExecutable: normalizedOpts.claudeExecutablePath ?? getDefaultClaudeCodePathForAgentSdk(),
        enableFileCheckpointing: enableFileCheckpointing || undefined,
        extraArgs,
        maxThinkingTokens:
            typeof params.initialMode.claudeRemoteMaxThinkingTokens === 'number'
                ? params.initialMode.claudeRemoteMaxThinkingTokens
                : undefined,
        hooks: builtHooks.hooks,
    };
    if (debugFilePath) {
        queryOptions.debugFile = debugFilePath;
    }
    if (stderrAppender) {
        queryOptions.stderr = (data: string) => {
            stderrAppender.append(data);
        };
    }
    applyClaudeAgentSdkAdvancedOptions({ queryOptions, advancedOptions });

    return {
        abortController,
        abortSignal,
        argOverrides,
        builtHooks,
        claudeConfigDir,
        createQuery,
        debugFilePath,
        enableFileCheckpointing,
        launchSettings,
        lastAppliedRuntimeSettings: resolveDesiredRuntimeSettingsSnapshot({
            resolvedMode: params.initialMode,
            argOverrides,
        }),
        normalizedOpts,
        queryOptions,
        startFrom,
        stderrAppender,
    };
}
