import type { TerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { buildCodexAgentRuntimeDescriptor, type CodexBackendMode } from '@happier-dev/agents';
import {
    isVersionSupported,
    MINIMUM_CLI_BACKEND_TARGET_SPAWN_VERSION,
    MINIMUM_CLI_SPAWN_PENDING_FIRST_INPUT_VERSION,
    MINIMUM_CLI_SOURCE_CONTEXT_SPAWN_VERSION,
} from '@/utils/system/versionUtils';
import type {
    AcpConfigOptionOverridesV1,
    AgentRuntimeDescriptorV1,
    BackendTargetRefV1,
    SessionMcpSelectionV1,
    SessionSpawnSourceContextV1,
    PendingFirstInputV1,
    WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol';

import { buildCodexBackendTransportFields, type CodexBackendTransportFields } from '../codexBackendTransport';
import { readNonBlankSessionControlIdentifier } from '@/sync/domains/sessionControl/opaqueIdentifiers';

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
    spawnNonce?: string;
    /** Opaque UI-local identity for one explicit user launch attempt. */
    userAttemptId?: string;
    /** Fixed first-turn identity retained with spawn custody until follow-up settles. */
    firstTurnLocalId?: string;
    /** Fixed attachment follow-up identity retained with spawn custody until follow-up settles. */
    attachmentMessageLocalId?: string;
    /** One-shot first turn transferred to a compatible daemon as part of fresh-session custody. */
    pendingFirstInput?: PendingFirstInputV1;
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
    connectedServicesUpdatedAt?: number;
    mcpSelection?: SessionMcpSelectionV1;
    /**
     * "Create this Session as a continuation of that one", with bounded Replay
     * through the recorded cutoff.
     *
     * Carried on both predecessor creation ingresses: the strict
     * `session.spawn_new` Action input and this machine-RPC payload, whose
     * daemon side (`SpawnDaemonSessionRequestCompatSchema`) declares the field
     * and routes it through the canonical Replay-seeded creator.
     *
     * That compat schema is a plain `z.object`, so a daemon predating the field
     * would strip it silently rather than reject. It is therefore sent only to
     * daemons positively known to support the field; `machineSpawnNewSession`
     * fails unknown and older versions closed before custody or RPC submission.
     */
    sourceContext?: SessionSpawnSourceContextV1;
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
    backendTarget: BackendTargetRefV1
    profileId?: string
    environmentVariables?: Record<string, string>
    resume?: string
    spawnNonce?: string
    pendingFirstInput?: PendingFirstInputV1
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
    connectedServicesUpdatedAt?: number
    mcpSelection?: SessionMcpSelectionV1
    /**
     * Typed source recipe for a Replay-seeded child. Required semantics on the
     * daemon: it resolves the seed before creating the child and creates no
     * child on failure. Deliberately absent from the legacy params shape.
     */
    sourceContext?: SessionSpawnSourceContextV1
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
    connectedServicesUpdatedAt?: number
};

export type CompatibleSpawnHappySessionRpcParams =
    | SpawnHappySessionRpcParams
    | LegacySpawnHappySessionRpcParams;

export function shouldUseLegacySpawnHappySessionRpcParams(daemonCliVersion?: string | null): boolean {
    const normalizedVersion = typeof daemonCliVersion === 'string' ? daemonCliVersion.trim() : '';
    return normalizedVersion.length > 0
        && !isVersionSupported(normalizedVersion, MINIMUM_CLI_BACKEND_TARGET_SPAWN_VERSION);
}

export function supportsSpawnPendingFirstInput(daemonCliVersion?: string | null): boolean {
    const normalizedVersion = typeof daemonCliVersion === 'string' ? daemonCliVersion.trim() : '';
    return normalizedVersion.length > 0
        && isVersionSupported(normalizedVersion, MINIMUM_CLI_SPAWN_PENDING_FIRST_INPUT_VERSION);
}

export function supportsSpawnSourceContext(daemonCliVersion?: string | null): boolean {
    const normalizedVersion = typeof daemonCliVersion === 'string' ? daemonCliVersion.trim() : '';
    return normalizedVersion.length > 0
        && isVersionSupported(normalizedVersion, MINIMUM_CLI_SOURCE_CONTEXT_SPAWN_VERSION);
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
        spawnNonce,
        pendingFirstInput,
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
        connectedServicesUpdatedAt,
        mcpSelection,
        sourceContext,
        accountSettingsVersionHint,
    } = options;

    const normalizedModelId = readNonBlankSessionControlIdentifier(modelId) ?? '';
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
        ...(typeof spawnNonce === 'string' && spawnNonce.trim().length > 0
            ? { spawnNonce }
            : {}),
        ...(pendingFirstInput ? { pendingFirstInput } : {}),
        permissionMode,
        permissionModeUpdatedAt,
        ...(readNonBlankSessionControlIdentifier(agentModeId)
            ? {
                agentModeId: agentModeId!,
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
        ...(typeof connectedServicesUpdatedAt === 'number' && Number.isFinite(connectedServicesUpdatedAt)
            ? { connectedServicesUpdatedAt }
            : {}),
        ...(mcpSelection ? { mcpSelection } : {}),
        ...(sourceContext ? { sourceContext } : {}),
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

export function buildCompatibleSpawnHappySessionRpcParams(params: Readonly<{
    options: SpawnSessionOptions;
    daemonCliVersion?: string | null;
}>): CompatibleSpawnHappySessionRpcParams {
    if (!shouldUseLegacySpawnHappySessionRpcParams(params.daemonCliVersion)) {
        const current = buildSpawnHappySessionRpcParams(params.options);
        if (supportsSpawnPendingFirstInput(params.daemonCliVersion)) {
            return current;
        }
        const { pendingFirstInput: _pendingFirstInput, ...compatible } = current;
        return compatible;
    }
    return buildLegacySpawnHappySessionRpcParams(params.options);
}
