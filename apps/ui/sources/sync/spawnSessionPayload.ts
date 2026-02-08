import type { TerminalSpawnOptions } from './terminalSettings';
import type { AgentId } from '@/agents/catalog';
import type { PermissionMode } from '@/sync/permissionTypes';

// Options for spawning a session
export interface SpawnSessionOptions {
    machineId: string;
    directory: string;
    approvedNewDirectoryCreation?: boolean;
    token?: string;
    agent?: AgentId;
    // Session-scoped profile identity (non-secret). Empty string means "no profile".
    profileId?: string;
    // Environment variables from AI backend profile
    // Accepts any environment variables - daemon will pass them to the agent process
    // Common variables include:
    // - ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL, ANTHROPIC_SMALL_FAST_MODEL
    // - OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_API_TIMEOUT_MS
    // - AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_VERSION, AZURE_OPENAI_DEPLOYMENT_NAME
    // - TOGETHER_API_KEY, TOGETHER_MODEL
    // - API_TIMEOUT_MS, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    // - Custom variables (DEEPSEEK_*, Z_AI_*, etc.)
    environmentVariables?: Record<string, string>;
    resume?: string;
    permissionMode?: PermissionMode;
    permissionModeUpdatedAt?: number;
    /**
     * Optional: seed a session-wide model override at spawn time.
     * This is persisted to session metadata so the model choice follows the session across devices.
     */
    modelId?: string;
    modelUpdatedAt?: number;
    /**
     * Experimental: allow Codex vendor resume.
     * Only relevant when agent === 'codex' and resume is set.
     */
    experimentalCodexResume?: boolean;
    /**
     * Experimental: route Codex through ACP (codex-acp).
     * When enabled, Codex sessions use ACP instead of MCP.
     */
    experimentalCodexAcp?: boolean;
    terminal?: TerminalSpawnOptions | null;
    /**
     * Windows-only: when starting a session remotely via the daemon, optionally open a visible console window
     * on the machine so the user can later interact locally.
     */
    windowsRemoteSessionConsole?: 'hidden' | 'visible';
}

export type SpawnHappySessionRpcParams = {
    type: 'spawn-in-directory'
    directory: string
    approvedNewDirectoryCreation?: boolean
    token?: string
    agent?: AgentId
    profileId?: string
    environmentVariables?: Record<string, string>
    resume?: string
    permissionMode?: PermissionMode
    permissionModeUpdatedAt?: number
    modelId?: string
    modelUpdatedAt?: number
    experimentalCodexResume?: boolean
    experimentalCodexAcp?: boolean
    terminal?: TerminalSpawnOptions
    windowsRemoteSessionConsole?: 'hidden' | 'visible'
};

export function buildSpawnHappySessionRpcParams(options: SpawnSessionOptions): SpawnHappySessionRpcParams {
    const { directory, approvedNewDirectoryCreation = false, token, agent, environmentVariables, profileId, resume, permissionMode, permissionModeUpdatedAt, modelId, modelUpdatedAt, experimentalCodexResume, experimentalCodexAcp, terminal, windowsRemoteSessionConsole } = options;

    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    const includeModelOverride =
        normalizedModelId.length > 0 &&
        normalizedModelId !== 'default' &&
        typeof modelUpdatedAt === 'number' &&
        Number.isFinite(modelUpdatedAt);

    const params: SpawnHappySessionRpcParams = {
        type: 'spawn-in-directory',
        directory,
        approvedNewDirectoryCreation,
        token,
        agent,
        profileId,
        environmentVariables,
        resume,
        permissionMode,
        permissionModeUpdatedAt,
        ...(includeModelOverride ? { modelId: normalizedModelId, modelUpdatedAt } : {}),
        experimentalCodexResume,
        experimentalCodexAcp,
    };

    if (terminal) {
        params.terminal = terminal;
    }
    if (windowsRemoteSessionConsole === 'hidden' || windowsRemoteSessionConsole === 'visible') {
        params.windowsRemoteSessionConsole = windowsRemoteSessionConsole;
    }

    return params;
}
