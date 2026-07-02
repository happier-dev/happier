import type { TerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { CodexBackendMode } from '@happier-dev/agents';
import {
    isVersionSupported,
    MINIMUM_CLI_BACKEND_TARGET_SPAWN_VERSION,
} from '@/utils/system/versionUtils';
import {
    convertBackendTargetRefV2ToV1,
    readBackendTargetRefV2,
    type BackendTargetRefV2Input,
    type BackendTargetRefV2,
} from '@happier-dev/protocol';
import type {
    AcpConfigOptionOverridesV1,
    RuntimeDescriptorV1,
    SessionMcpSelectionV1,
    WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol';

import { buildCodexBackendTransportFields, type CodexBackendTransportFields } from '../codexBackendTransport';

// Options for spawning a session
export interface SpawnSessionOptions {
    machineId: string;
    serverId?: string | null;
    directory: string;
    transcriptStorage?: 'persisted' | 'direct';
    approvedNewDirectoryCreation?: boolean;
    backendTarget: BackendTargetRefV2Input;
    spawnNonce?: string;
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
    agentModeId?: string;
    agentModeUpdatedAt?: number;
    /**
     * Optional: seed a session-wide model override at spawn time.
     * This is persisted to session metadata so the model choice follows the session across devices.
     */
    modelId?: string;
    modelUpdatedAt?: number;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    /**
     * Experimental: route Codex through ACP (codex-acp).
     * When enabled, Codex sessions use ACP instead of MCP.
     */
    experimentalCodexAcp?: boolean;
    codexBackendMode?: CodexBackendMode;
    runtimeDescriptorV1?: RuntimeDescriptorV1;
    terminal?: TerminalSpawnOptions | null;
    /**
     * Windows-only: when starting a session remotely via the daemon, optionally open a visible console window
     * on the machine so the user can later interact locally.
     */
    windowsRemoteSessionLaunchMode?: WindowsRemoteSessionLaunchMode;
    windowsRemoteSessionConsole?: 'hidden' | 'visible';
    windowsTerminalWindowName?: string;
    /**
     * Optional: per-session bindings to Happier Connected Services profiles.
     *
     * This payload must NOT include secrets. The daemon uses it to fetch sealed credentials from the cloud
     * and decrypt/materialize them locally for the provider runtime.
     */
    connectedServices?: unknown;
    mcpSelection?: SessionMcpSelectionV1;
    /**
     * Internal daemon freshness barrier. Callers should normally omit this and let
     * `machineSpawnNewSession` capture a freshly flushed account-settings version.
     */
    accountSettingsVersionHint?: number;
}

export type SpawnHappySessionRpcParams = CodexBackendTransportFields & {
    type: 'spawn-in-directory'
    directory: string
    transcriptStorage?: 'persisted' | 'direct'
    approvedNewDirectoryCreation?: boolean
    backendTarget: BackendTargetRefV2
    spawnNonce?: string
    profileId?: string
    environmentVariables?: Record<string, string>
    resume?: string
    runtimeDescriptorV1?: RuntimeDescriptorV1
    permissionMode?: PermissionMode
    permissionModeUpdatedAt?: number
    agentModeId?: string
    agentModeUpdatedAt?: number
    modelId?: string
    modelUpdatedAt?: number
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1
    terminal?: TerminalSpawnOptions
    windowsRemoteSessionLaunchMode?: WindowsRemoteSessionLaunchMode
    windowsRemoteSessionConsole?: 'hidden' | 'visible'
    windowsTerminalWindowName?: string
    connectedServices?: unknown
    mcpSelection?: SessionMcpSelectionV1
    /**
     * Internal daemon freshness barrier captured immediately before the RPC.
     */
    accountSettingsVersionHint?: number
};

export type LegacySpawnHappySessionRpcParams = {
    type: 'spawn-in-directory'
    directory: string
    approvedNewDirectoryCreation?: boolean
    agent?: string
    profileId?: string
    environmentVariables?: Record<string, string>
    resume?: string
    permissionMode?: PermissionMode
    permissionModeUpdatedAt?: number
    modelId?: string
    modelUpdatedAt?: number
    experimentalCodexAcp?: boolean
    terminal?: TerminalSpawnOptions
    windowsRemoteSessionConsole?: 'hidden' | 'visible'
    connectedServices?: unknown
};

export type CompatibleSpawnHappySessionRpcParams =
    | SpawnHappySessionRpcParams
    | LegacySpawnHappySessionRpcParams;

export function shouldUseLegacySpawnHappySessionRpcParams(daemonCliVersion?: string | null): boolean {
    const normalizedVersion = typeof daemonCliVersion === 'string' ? daemonCliVersion.trim() : '';
    return normalizedVersion.length > 0
        && !isVersionSupported(normalizedVersion, MINIMUM_CLI_BACKEND_TARGET_SPAWN_VERSION);
}

function resolveLegacyWindowsRemoteSessionConsole(params: Readonly<{
    windowsRemoteSessionLaunchMode?: WindowsRemoteSessionLaunchMode;
    windowsRemoteSessionConsole?: 'hidden' | 'visible';
}>): 'hidden' | 'visible' | undefined {
    if (params.windowsRemoteSessionConsole === 'hidden' || params.windowsRemoteSessionConsole === 'visible') {
        return params.windowsRemoteSessionConsole;
    }
    if (params.windowsRemoteSessionLaunchMode === 'hidden') return 'hidden';
    if (params.windowsRemoteSessionLaunchMode === 'console') return 'visible';
    return undefined;
}

function buildLegacySpawnHappySessionRpcParams(options: SpawnSessionOptions): LegacySpawnHappySessionRpcParams {
    const params = buildSpawnHappySessionRpcParams(options);
    const legacyBackendTarget = convertBackendTargetRefV2ToV1(readBackendTargetRefV2(params.backendTarget));
    const legacyAgent = legacyBackendTarget.kind === 'builtInAgent' ? legacyBackendTarget.agentId.trim() : '';
    if (legacyAgent.length === 0) {
        throw new Error('Legacy spawn payload is only available for built-in agents');
    }

    const legacyConsole = resolveLegacyWindowsRemoteSessionConsole({
        windowsRemoteSessionLaunchMode: params.windowsRemoteSessionLaunchMode,
        windowsRemoteSessionConsole: params.windowsRemoteSessionConsole,
    });

    return {
        type: 'spawn-in-directory',
        directory: params.directory,
        approvedNewDirectoryCreation: params.approvedNewDirectoryCreation,
        agent: legacyAgent,
        profileId: params.profileId,
        environmentVariables: params.environmentVariables,
        resume: params.resume,
        permissionMode: params.permissionMode,
        permissionModeUpdatedAt: params.permissionModeUpdatedAt,
        ...(typeof params.modelId === 'string' && typeof params.modelUpdatedAt === 'number'
            ? {
                modelId: params.modelId,
                modelUpdatedAt: params.modelUpdatedAt,
            }
            : {}),
        ...(params.codexBackendMode === 'acp' ? { experimentalCodexAcp: true } : {}),
        ...(params.terminal ? { terminal: params.terminal } : {}),
        ...(legacyConsole ? { windowsRemoteSessionConsole: legacyConsole } : {}),
        ...(params.connectedServices !== undefined ? { connectedServices: params.connectedServices } : {}),
    };
}

export function buildCompatibleSpawnHappySessionRpcParams(params: Readonly<{
    options: SpawnSessionOptions;
    daemonCliVersion?: string | null;
}>): CompatibleSpawnHappySessionRpcParams {
    if (!shouldUseLegacySpawnHappySessionRpcParams(params.daemonCliVersion)) {
        return buildSpawnHappySessionRpcParams(params.options);
    }
    return buildLegacySpawnHappySessionRpcParams(params.options);
}

export function buildSpawnHappySessionRpcParams(options: SpawnSessionOptions): SpawnHappySessionRpcParams {
    const {
        directory,
        transcriptStorage,
        approvedNewDirectoryCreation = false,
        backendTarget,
        spawnNonce,
        environmentVariables,
        profileId,
        resume,
        permissionMode,
        permissionModeUpdatedAt,
        agentModeId,
        agentModeUpdatedAt,
        modelId,
        modelUpdatedAt,
        sessionConfigOptionOverrides,
        experimentalCodexAcp,
        codexBackendMode,
        runtimeDescriptorV1,
        terminal,
        windowsRemoteSessionLaunchMode,
        windowsRemoteSessionConsole,
        windowsTerminalWindowName,
        connectedServices,
        mcpSelection,
        accountSettingsVersionHint,
    } = options;

    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    const includeModelOverride =
        normalizedModelId.length > 0 &&
        normalizedModelId !== 'default' &&
        typeof modelUpdatedAt === 'number' &&
        Number.isFinite(modelUpdatedAt);
    const canonicalBackendTarget = readBackendTargetRefV2(backendTarget);
    const codexTransportFields = buildCodexBackendTransportFields({
        backendTarget: canonicalBackendTarget,
        ...(typeof spawnNonce === 'string' && spawnNonce.trim().length > 0 ? { spawnNonce: spawnNonce.trim() } : {}),
        codexBackendMode,
        experimentalCodexAcp,
        runtimeDescriptorV1,
        resume,
    });

    const params: SpawnHappySessionRpcParams = {
        type: 'spawn-in-directory',
        directory,
        transcriptStorage,
        approvedNewDirectoryCreation,
        backendTarget: canonicalBackendTarget,
        profileId,
        environmentVariables,
        resume,
        permissionMode,
        permissionModeUpdatedAt,
        ...(typeof agentModeId === 'string' && agentModeId.trim().length > 0
            ? {
                agentModeId: agentModeId.trim(),
                ...(typeof agentModeUpdatedAt === 'number' && Number.isFinite(agentModeUpdatedAt)
                    ? { agentModeUpdatedAt }
                    : {}),
            }
            : {}),
        ...(includeModelOverride ? { modelId: normalizedModelId, modelUpdatedAt } : {}),
        ...(sessionConfigOptionOverrides ? { sessionConfigOptionOverrides } : {}),
        ...(codexTransportFields.codexBackendMode ? { codexBackendMode: codexTransportFields.codexBackendMode } : {}),
        ...(runtimeDescriptorV1
            ? { runtimeDescriptorV1 }
            : codexTransportFields.runtimeDescriptorV1
                ? { runtimeDescriptorV1: codexTransportFields.runtimeDescriptorV1 }
                : {}),
        connectedServices,
        ...(mcpSelection ? { mcpSelection } : {}),
        ...(typeof accountSettingsVersionHint === 'number' && Number.isInteger(accountSettingsVersionHint) && accountSettingsVersionHint >= 0
            ? { accountSettingsVersionHint }
            : {}),
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
    if (typeof windowsTerminalWindowName === 'string' && windowsTerminalWindowName.trim().length > 0) {
        params.windowsTerminalWindowName = windowsTerminalWindowName.trim();
    }

    return params;
}
