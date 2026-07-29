import type { TerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type {
    AgentSessionStartupInstructionsV1,
    CodexBackendMode,
} from '@happier-dev/protocol';
import {
    buildBackendTargetKeyV2,
    readBackendTargetRefV2,
    SessionModelSelectionV1Schema,
    type BackendTargetRefV2Input,
    type BackendTargetRefV2,
} from '@happier-dev/protocol';
import type {
    AcpConfigOptionOverridesV1,
    RuntimeDescriptorV1,
    SessionMcpSelectionV1,
    SessionModelSelectionV1,
    WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol';
import {
    buildBackendTransportFieldsFromUiState,
    type AgentBackendTransportFields,
} from '@/agents/registry/registryUiBehavior';

// Options for spawning a session
export interface SpawnSessionOptions {
    machineId: string;
    serverId?: string | null;
    directory: string;
    transcriptStorage?: 'persisted' | 'direct';
    approvedNewDirectoryCreation?: boolean;
    backendTarget: BackendTargetRefV2Input;
    spawnNonce?: string;
    /** Opaque UI-local identity for one explicit user launch attempt. */
    userAttemptId?: string;
    // Session-scoped profile identity (non-secret). Empty string means "no profile".
    profileId?: string;
    // Launch-profile extras and narrow legacy compatibility environment.
    // Provider endpoint/auth/model routing is resolved from modelSelection and its
    // exact provider connection; reserved routing keys are rejected at the daemon
    // spawn-composition boundary rather than accepted from this UI payload.
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
    modelSelection?: SessionModelSelectionV1;
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

export type SpawnHappySessionRpcParams = AgentBackendTransportFields & {
    type: 'spawn-in-directory'
    directory: string
    transcriptStorage?: 'persisted' | 'direct'
    approvedNewDirectoryCreation?: boolean
    backendTarget: BackendTargetRefV2
    spawnNonce?: string
    profileId?: string
    environmentVariables?: Record<string, string>
    resume?: string
    agentSessionStartupInstructionsV1?: AgentSessionStartupInstructionsV1
    runtimeDescriptorV1?: RuntimeDescriptorV1
    permissionMode?: PermissionMode
    permissionModeUpdatedAt?: number
    agentModeId?: string
    agentModeUpdatedAt?: number
    modelSelection?: SessionModelSelectionV1
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

function buildSpawnHappySessionRpcParamsInternal(
    options: SpawnSessionOptions,
    trustedHiddenSystemSessionStartupInstructions?: AgentSessionStartupInstructionsV1,
): SpawnHappySessionRpcParams {
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
        modelSelection,
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

    const normalizedSpawnNonce = typeof spawnNonce === 'string' ? spawnNonce.trim() : '';
    const canonicalBackendTarget = readBackendTargetRefV2(backendTarget);
    const canonicalModelSelection = modelSelection
        ? SessionModelSelectionV1Schema.parse(modelSelection)
        : null;
    if (canonicalModelSelection
        && canonicalModelSelection.ref.agentTargetKey !== buildBackendTargetKeyV2(canonicalBackendTarget)) {
        throw new Error('Spawn model selection target mismatch');
    }
    const backendTransportFields = buildBackendTransportFieldsFromUiState({
        backendTarget: canonicalBackendTarget,
        providerMode: codexBackendMode,
        legacyExperimentalMode: experimentalCodexAcp,
        runtimeDescriptorV1,
        providerSessionId: resume,
    });

    const params: SpawnHappySessionRpcParams = {
        type: 'spawn-in-directory',
        directory,
        transcriptStorage,
        approvedNewDirectoryCreation,
        backendTarget: canonicalBackendTarget,
        ...(normalizedSpawnNonce ? { spawnNonce: normalizedSpawnNonce } : {}),
        profileId,
        environmentVariables,
        resume,
        ...(trustedHiddenSystemSessionStartupInstructions
            ? { agentSessionStartupInstructionsV1: trustedHiddenSystemSessionStartupInstructions }
            : {}),
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
        ...(canonicalModelSelection ? { modelSelection: canonicalModelSelection } : {}),
        ...(sessionConfigOptionOverrides ? { sessionConfigOptionOverrides } : {}),
        ...(backendTransportFields.codexBackendMode ? { codexBackendMode: backendTransportFields.codexBackendMode } : {}),
        ...(runtimeDescriptorV1
            ? { runtimeDescriptorV1 }
            : backendTransportFields.runtimeDescriptorV1
                ? { runtimeDescriptorV1: backendTransportFields.runtimeDescriptorV1 }
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

export function buildSpawnHappySessionRpcParams(options: SpawnSessionOptions): SpawnHappySessionRpcParams {
    return buildSpawnHappySessionRpcParamsInternal(options);
}

/**
 * Narrow wire builder for host-owned hidden system sessions. Ordinary session
 * creation must use buildSpawnHappySessionRpcParams and cannot author startup text.
 */
export function buildTrustedHiddenSystemSessionSpawnHappySessionRpcParams(
    options: SpawnSessionOptions,
    startupInstructions: AgentSessionStartupInstructionsV1,
): SpawnHappySessionRpcParams {
    return buildSpawnHappySessionRpcParamsInternal(options, startupInstructions);
}
