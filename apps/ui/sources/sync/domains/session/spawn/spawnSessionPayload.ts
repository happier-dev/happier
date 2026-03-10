import type { TerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type {
    BackendTargetRefV1,
    SessionMcpSelectionV1,
    WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol';

// Options for spawning a session
export interface SpawnSessionOptions {
    machineId: string;
    serverId?: string | null;
    directory: string;
    transcriptStorage?: 'persisted' | 'direct';
    approvedNewDirectoryCreation?: boolean;
    token?: string;
    backendTarget: BackendTargetRefV1;
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
     * Experimental: route Codex through ACP (codex-acp).
     * When enabled, Codex sessions use ACP instead of MCP.
     */
    experimentalCodexAcp?: boolean;
    terminal?: TerminalSpawnOptions | null;
    /**
     * Windows-only: when starting a session remotely via the daemon, optionally open a visible console window
     * on the machine so the user can later interact locally.
     */
    windowsRemoteSessionLaunchMode?: WindowsRemoteSessionLaunchMode;
    windowsRemoteSessionConsole?: 'hidden' | 'visible';
    /**
     * Optional: per-session bindings to Happier Connected Services profiles.
     *
     * This payload must NOT include secrets. The daemon uses it to fetch sealed credentials from the cloud
     * and decrypt/materialize them locally for the provider runtime.
     */
    connectedServices?: unknown;
    mcpSelection?: SessionMcpSelectionV1;
}

export type SpawnHappySessionRpcParams = {
    type: 'spawn-in-directory'
    directory: string
    transcriptStorage?: 'persisted' | 'direct'
    approvedNewDirectoryCreation?: boolean
    token?: string
    backendTarget: BackendTargetRefV1
    profileId?: string
    environmentVariables?: Record<string, string>
    resume?: string
    permissionMode?: PermissionMode
    permissionModeUpdatedAt?: number
    modelId?: string
    modelUpdatedAt?: number
    experimentalCodexAcp?: boolean
    terminal?: TerminalSpawnOptions
    windowsRemoteSessionLaunchMode?: WindowsRemoteSessionLaunchMode
    windowsRemoteSessionConsole?: 'hidden' | 'visible'
    connectedServices?: unknown
    mcpSelection?: SessionMcpSelectionV1
};

export function buildSpawnHappySessionRpcParams(options: SpawnSessionOptions): SpawnHappySessionRpcParams {
    const {
        directory,
        transcriptStorage,
        approvedNewDirectoryCreation = false,
        token,
        backendTarget,
        environmentVariables,
        profileId,
        resume,
        permissionMode,
        permissionModeUpdatedAt,
        modelId,
        modelUpdatedAt,
        experimentalCodexAcp,
        terminal,
        windowsRemoteSessionLaunchMode,
        windowsRemoteSessionConsole,
        connectedServices,
        mcpSelection,
    } = options;

    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    const includeModelOverride =
        normalizedModelId.length > 0 &&
        normalizedModelId !== 'default' &&
        typeof modelUpdatedAt === 'number' &&
        Number.isFinite(modelUpdatedAt);

    const params: SpawnHappySessionRpcParams = {
        type: 'spawn-in-directory',
        directory,
        transcriptStorage,
        approvedNewDirectoryCreation,
        token,
        backendTarget,
        profileId,
        environmentVariables,
        resume,
        permissionMode,
        permissionModeUpdatedAt,
        ...(includeModelOverride ? { modelId: normalizedModelId, modelUpdatedAt } : {}),
        experimentalCodexAcp,
        connectedServices,
        ...(mcpSelection ? { mcpSelection } : {}),
    };

    if (terminal) {
        params.terminal = terminal;
    }
    if (
        windowsRemoteSessionLaunchMode === 'hidden'
        || windowsRemoteSessionLaunchMode === 'windows_terminal'
        || windowsRemoteSessionLaunchMode === 'console'
    ) {
        params.windowsRemoteSessionLaunchMode = windowsRemoteSessionLaunchMode;
    } else if (windowsRemoteSessionConsole === 'hidden' || windowsRemoteSessionConsole === 'visible') {
        params.windowsRemoteSessionLaunchMode = windowsRemoteSessionConsole === 'visible' ? 'console' : 'hidden';
    }

    return params;
}
