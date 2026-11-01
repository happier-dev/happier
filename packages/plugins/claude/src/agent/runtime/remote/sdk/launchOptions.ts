import type { AgentSessionProviderBinding, AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';
import type { QueryOptions } from '../../../sdk/types.js';
import { buildClaudeHookSettingsOverlay } from '../../../hooks/settings.js';
import { buildClaudeMcpConfigArgs } from '../../../mcp/materializeConfigArgs.js';
import { resolveClaudeLaunchSettingsOverlayArgs } from '../../launchSettings.js';
import { resolveClaudePermissionModeFromRuntimeMode } from '../../permissionMode.js';
import { buildClaudePluginDirArgs } from '../../pluginDirArgs.js';
import { isClaudeUltracodeSupportedModelId } from '../../reasoningEffort.js';
import type { ClaudeAgentSdkTurnOperationsParams } from './session.js';

/** Turn and resumed control queries share every prefix-affecting launch decision. */
export function buildClaudeSdkQueryLaunchOptions(params: ClaudeAgentSdkTurnOperationsParams, state: Readonly<{
    skills: AgentSessionSkillDelivery | undefined;
    permissionMode: string;
    workspaceWrites: 'allow' | 'deny';
    modelId: string | null;
    providerModel: AgentSessionProviderBinding['model'] | undefined;
    fallbackModel: string | null;
    effort: string | null;
    ultracode: boolean;
    hookPluginDir: string | null;
    mcpServers: ClaudeAgentSdkTurnOperationsParams['mcpServers'];
    skillOverrides: Readonly<Record<string, 'off'>>;
    resolvePermission: NonNullable<QueryOptions['canCallTool']>;
    getOAuthToken: QueryOptions['getOAuthToken'] | null;
}>): Readonly<{ options: QueryOptions; launchEffort: string | null }> {
    const launchSettings = {
        ...buildClaudeHookSettingsOverlay(),
        ...(state.ultracode && isClaudeUltracodeSupportedModelId(state.modelId, state.providerModel)
            ? { ultracode: true } : {}),
    };
    const args = resolveClaudeLaunchSettingsOverlayArgs({
        args: [], interactionKind: 'noninteractive_sdk', permissionMode: state.permissionMode,
        launchSettings, workspaceWrites: state.workspaceWrites,
        skillOverrides: state.skillOverrides,
        mcpToolPolicy: params.mcpToolPolicy, helperModelEnv: params.helperModelEnv,
        allowedTools: params.allowedTools, unlistedTools: params.unlistedTools,
    });
    const settingsJson = args.includes('--settings') ? args[args.indexOf('--settings') + 1]
        : Object.keys(launchSettings).length > 0 ? JSON.stringify(launchSettings) : undefined;
    return {
        launchEffort: launchSettings.ultracode ? 'xhigh' : state.effort,
        options: {
            cwd: params.directory, env: params.launchEnv, skills: state.skills, abort: params.abortSignal,
            allowDangerouslySkipPermissions: true,
            permissionMode: resolveClaudePermissionModeFromRuntimeMode({ permissionMode: state.permissionMode }),
            ...(state.modelId ? { model: state.modelId } : {}),
            ...(state.fallbackModel ? { fallbackModel: state.fallbackModel } : {}),
            ...(state.effort ? { effort: state.effort } : {}),
            extraArgs: [
                ...(params.publishTranscriptMessages === true || params.publishSdkMessages === true
                    ? ['--include-partial-messages'] : []),
                ...(params.supportsSystemPromptSnapshotOff === true ? ['--system-prompt-snapshot', 'off'] : []),
                ...buildClaudePluginDirArgs({ hookPluginDir: state.hookPluginDir, skills: state.skills }),
                ...(state.hookPluginDir ? ['--include-hook-events'] : []),
                ...buildClaudeMcpConfigArgs(state.mcpServers),
            ],
            ...(settingsJson ? { settingsJson } : {}),
            ...(params.unlistedTools !== 'deny' || !state.hookPluginDir ? { canCallTool: state.resolvePermission } : {}),
            ...(state.getOAuthToken ? { getOAuthToken: state.getOAuthToken } : {}),
            ...params.advancedOptions,
            allowedTools: params.allowedTools, unlistedTools: params.unlistedTools,
            settingSources: params.unlistedTools === 'deny' && !state.hookPluginDir ? [] : params.settingSources,
            ...(params.unlistedTools === 'deny' ? { strictMcpConfig: true } : {}),
            ...(params.startupInstructions ? { appendSystemPrompt: params.startupInstructions, appendSystemPromptFile: true } : {}),
        },
    };
}
