export const CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS_ENV_VAR = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' as const;

export function resolveClaudeCodeExperimentalEnvOverlay(params: Readonly<{
    claudeCodeExperimentalAgentTeamsEnabled?: boolean;
}>): Record<string, string> {
    if (params.claudeCodeExperimentalAgentTeamsEnabled !== true) {
        return {};
    }
    return { [CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS_ENV_VAR]: '1' };
}

export function resolveClaudeAgentSdkExtraArgs(params: Readonly<{
    enableFileCheckpointing: boolean;
    debugEnabled: boolean;
    verboseEnabled: boolean;
    debugCategories: readonly string[];
}>): Record<string, string | null> | undefined {
    const out: Record<string, string | null> = Object.create(null);
    if (params.enableFileCheckpointing) out['replay-user-messages'] = null;
    if (params.debugEnabled) out.debug = params.debugCategories.length > 0 ? params.debugCategories.join(',') : null;
    if (params.verboseEnabled) out.verbose = null;
    return Object.keys(out).length > 0 ? out : undefined;
}

export function applyClaudeAgentSdkAdvancedOptions(params: Readonly<{
    queryOptions: Record<string, unknown>;
    advancedOptions: Record<string, unknown> | null;
}>): void {
    if (!params.advancedOptions) return;

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
        if (!Object.prototype.hasOwnProperty.call(params.advancedOptions, key)) continue;
        const value = params.advancedOptions[key];
        if (key === 'stderr') {
            if (typeof value === 'function') params.queryOptions[key] = value;
            continue;
        }
        if (key === 'debugFile') {
            if (typeof value === 'string') params.queryOptions[key] = value;
            continue;
        }
        if (key === 'debug') {
            if (typeof value === 'boolean') params.queryOptions[key] = value;
            continue;
        }
        params.queryOptions[key] = value;
    }
}
