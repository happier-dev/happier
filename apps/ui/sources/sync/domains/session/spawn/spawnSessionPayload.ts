import type { TerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { buildCodexAgentRuntimeDescriptor, type CodexBackendMode } from '@happier-dev/agents';
import {
    isVersionSupported,
    MINIMUM_CLI_BACKEND_TARGET_SPAWN_VERSION,
} from '@/utils/system/versionUtils';
import type {
    AcpConfigOptionOverridesV1,
    AgentRuntimeDescriptorV1,
    BackendTargetRefV1,
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
    agentRuntimeDescriptorV1?: AgentRuntimeDescriptorV1;
    terminal?: TerminalSpawnOptions | null;
    /**
     * Windows-only: how a daemon-spawned remote session should be hosted locally.
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
}

export type SpawnHappySessionRpcParams = CodexBackendTransportFields & {
    type: 'spawn-in-directory'
    directory: string
    transcriptStorage?: 'persisted' | 'direct'
    approvedNewDirectoryCreation?: boolean
    backendTarget: BackendTargetRefV1
    profileId?: string
    environmentVariables?: Record<string, string>
    resume?: string
    agentRuntimeDescriptorV1?: AgentRuntimeDescriptorV1
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
    const legacyAgent = params.backendTarget.kind === 'builtInAgent' ? params.backendTarget.agentId.trim() : '';
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

export function buildSpawnHappySessionRpcParams(options: SpawnSessionOptions): SpawnHappySessionRpcParams {
    const {
        directory,
        transcriptStorage,
        approvedNewDirectoryCreation = false,
        backendTarget,
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
        agentRuntimeDescriptorV1,
        terminal,
        windowsRemoteSessionLaunchMode,
        windowsRemoteSessionConsole,
        windowsTerminalWindowName,
        connectedServices,
        mcpSelection,
    } = options;

    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    const includeModelOverride =
        normalizedModelId.length > 0 &&
        normalizedModelId !== 'default' &&
        typeof modelUpdatedAt === 'number' &&
        Number.isFinite(modelUpdatedAt);
    const codexTransportFields = buildCodexBackendTransportFields({ codexBackendMode, experimentalCodexAcp, agentRuntimeDescriptorV1 });
    const canonicalCodexBackendMode = codexTransportFields.codexBackendMode;

    const params: SpawnHappySessionRpcParams = {
        type: 'spawn-in-directory',
        directory,
        transcriptStorage,
        approvedNewDirectoryCreation,
        backendTarget,
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
        ...codexTransportFields,
        ...(() => {
            if (agentRuntimeDescriptorV1) {
                return { agentRuntimeDescriptorV1 };
            }

            if (backendTarget.kind === 'builtInAgent' && backendTarget.agentId === 'codex' && canonicalCodexBackendMode) {
                return {
                    agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
                        backendMode: canonicalCodexBackendMode,
                        vendorSessionId: resume,
                    }),
                };
            }

            return {};
        })(),
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
    if (typeof windowsTerminalWindowName === 'string' && windowsTerminalWindowName.trim().length > 0) {
        params.windowsTerminalWindowName = windowsTerminalWindowName.trim();
    }

    return params;
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
