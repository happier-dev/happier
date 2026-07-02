import type { TerminalSpawnOptions } from '@/terminal/runtime/terminalConfig';
import type { PermissionMode } from '@/api/types';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import type { Metadata } from '@/api/types';
import type { CodexBackendMode } from '@happier-dev/agents';
import {
    AcpConfigOptionOverridesV1,
    type RuntimeDescriptorV1,
    type BackendTargetRefV2,
    type ConnectedServiceMaterializationIdentityV1,
    type SessionAttachMetadataIdentityPolicy,
    SessionMcpSelectionV1,
    SpawnSessionErrorCode,
    type SpawnSessionErrorDetail,
} from '@happier-dev/protocol';
export { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
export type { SpawnSessionErrorCode, SpawnSessionErrorDetail } from '@happier-dev/protocol';
import { registerCapabilitiesHandlers } from './capabilities';
import { registerPreviewEnvHandler } from './previewEnv';
import { registerBashHandler } from './bash';
import { registerRipgrepHandler } from './ripgrep';
import { registerDifftasticHandler } from './difftastic';
import { registerSessionUserMessageSendHandler } from './sessionUserMessageSend';
import { registerSessionControlHandlers, type SessionRuntimeControls } from './sessionControls';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';
import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { SESSION_TRANSCRIPT_RPC_SCOPES } from './actionSpecRpcRegistration';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';
import type { FilesystemAccessPolicy } from './fileSystem/accessPolicy/filesystemAccessPolicy';
import { readCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
export {
    readCanonicalSpawnRuntimeSelection,
    readSpawnRuntimeDescriptorV1,
    type CanonicalSpawnRuntimeSelection,
} from './spawnRuntimeSelection';

/*
 * Spawn Session Options and Result
 * This rpc type is used by the daemon, all other RPCs here are for sessions
 */

export interface SpawnSessionOptions {
    machineId?: string;
    directory: string;
    /**
     * Daemon-only spawn idempotency salt.
     *
     * When set, the daemon treats the spawn request as unique for the purposes of spawn request
     * coalescing (prevents returning a recent success session id for rapid consecutive spawns).
     *
     * This must not be forwarded into the spawned session process (it is not an environment variable).
     */
    spawnNonce?: string;
    /**
     * Optional initial prompt to seed for daemon-driven session starts.
     * The spawned process consumes this prompt from environment and sends it
     * through the normal session user-message pipeline.
     */
    initialPrompt?: string;
    sessionId?: string;
    /**
     * Resume an existing agent session by id (vendor resume).
     *
     * Upstream intent: Claude (`--resume <sessionId>`).
     * If resume is requested for an unsupported agent, the daemon should return an error
     * rather than silently spawning a fresh session.
     */
    resume?: string;
    /**
     * Legacy compatibility for older boundaries that still send the ACP toggle.
     * Prefer codexBackendMode for new spawn/resume callers.
     */
    experimentalCodexAcp?: boolean;
    codexBackendMode?: CodexBackendMode;
    runtimeDescriptorV1?: RuntimeDescriptorV1;
    /**
     * Existing Happy session ID to reconnect to (for inactive session resume).
     * When set, the CLI will connect to this session instead of creating a new one.
     */
    existingSessionId?: string;
    /**
     * Existing-session attach cursor for wake-after-send resume.
     *
     * When a UI first commits a wake prompt to the Happier transcript and then asks the daemon
     * to resume the stopped runner, the child must catch up after this seq so the new prompt is
     * delivered once without replaying older turns.
     */
    initialTranscriptAfterSeq?: number;
    /**
     * Optional attach-only metadata identity policy.
     * Preserve current persisted machine identity for normal attaches, but allow runtime replacement
     * for cross-machine handoff cutover.
     */
    attachMetadataIdentityPolicy?: SessionAttachMetadataIdentityPolicy;
    /**
     * Optional: explicit permission mode to publish at startup (seed or override).
     * When omitted, the runner preserves existing metadata.permissionMode.
     */
    permissionMode?: PermissionMode;
    /**
     * Optional timestamp for permissionMode (ms). Used to order explicit UI selections across devices.
     */
    permissionModeUpdatedAt?: number;
    /**
     * Optional: ACP/static agent mode override to seed at startup (spawn/resume attach).
     */
    agentModeId?: string;
    agentModeUpdatedAt?: number;
    /**
     * Optional: session-wide model override to seed at startup (spawn/resume attach).
     *
     * When set, the spawned CLI process will publish `metadata.modelOverrideV1` so the model choice
     * follows the session across devices.
     */
    modelId?: string;
    modelUpdatedAt?: number;
    accountSettingsVersionHint?: number;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    approvedNewDirectoryCreation?: boolean;
    backendTarget?: BackendTargetRefV2;
    /**
     * Daemon/runtime terminal configuration for the spawned session (non-secret).
     * Preferred over legacy TMUX_* env vars.
     */
    terminal?: TerminalSpawnOptions;
    /**
     * Windows-only: whether a daemon-spawned *remote* session should start in a visible console window.
     *
     * - `hidden` (default): no visible console window (best for background/remote usage; avoids flicker).
     * - `visible`: open a new console window so the user can later interact locally on the machine.
     *
     * Note: this is intentionally scoped to daemon-spawned remote sessions and does not affect tool subprocesses.
     */
    windowsRemoteSessionLaunchMode?: 'hidden' | 'windows_terminal' | 'console';
    windowsRemoteSessionConsole?: 'hidden' | 'visible';
    windowsTerminalWindowName?: string;
    /**
     * Session-scoped profile identity for display/debugging across devices.
     * This is NOT the profile content; actual runtime behavior is still driven
     * by environmentVariables passed for this spawn.
     *
     * Empty string is allowed and means "no profile".
     */
    profileId?: string;
    /**
     * Arbitrary environment variables for the spawned session.
     *
     * The GUI builds these from a profile (env var list + tmux settings) and may include
     * provider-specific keys like:
     * - ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL
     * - OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
     * - AZURE_OPENAI_* / TOGETHER_*
     * - TMUX_SESSION_NAME / TMUX_TMPDIR
     */
    environmentVariables?: Record<string, string>;

    /**
     * Optional: per-session bindings to Happier Connected Services profiles.
     *
     * This payload must NOT include secrets. The daemon uses it to fetch sealed credentials from the cloud
     * and decrypt/materialize them locally for the provider runtime.
     */
    connectedServices?: unknown;
    /**
     * Optional timestamp for connectedServices (ms). Used to preserve the caller's latest
     * connected-service selection ordering across retries/restarts.
     */
    connectedServicesUpdatedAt?: number;
    /**
     * Stable daemon-owned materialization identity for connected-service runtime state.
     * This is generated before first materialization and reused on respawn/restart paths.
     */
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
    /**
     * Optional per-session MCP selection overlay for Happier-managed MCP servers.
     * This is stored in session metadata and applied at runner startup.
     */
    mcpSelection?: SessionMcpSelectionV1;

    /**
     * Controls whether the session transcript is committed to Happier server storage ("persisted")
     * or treated as provider-backed only ("direct").
     *
     * When set to "direct", the daemon will signal the spawned runner to suppress transcript commits.
     */
    transcriptStorage?: 'persisted' | 'direct';
}
export type SpawnSessionResult =
    | { type: 'success'; sessionId?: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorCode: SpawnSessionErrorCode; errorMessage: string; errorDetail?: SpawnSessionErrorDetail };

type RpcRegistrar = Readonly<{
    registerHandler(method: string, handler: (input: unknown) => Promise<unknown>): void;
}>;

export function registerSessionTranscriptRpcHandlers(params: Readonly<{
    rpcHandlerManager: RpcRegistrar;
    actionExecutor?: RpcActionExecutor;
    resolveActionExecutor?: () => RpcActionExecutor | Promise<RpcActionExecutor>;
}>): void {
    registerActionSpecRpcHandlers({
        rpcHandlerManager: params.rpcHandlerManager,
        actionExecutor: params.actionExecutor,
        resolveActionExecutor: params.resolveActionExecutor,
        scopes: SESSION_TRANSCRIPT_RPC_SCOPES,
    });
}

async function resolveProductionTranscriptActionExecutor(params: Readonly<{
    workingDirectory: string;
    accessPolicy: FilesystemAccessPolicy;
}>): Promise<RpcActionExecutor> {
    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
        return {
            execute: async () => ({
                ok: false,
                errorCode: 'not_authenticated',
                error: 'not_authenticated',
            }),
        };
    }
    return createCliActionExecutorFromCredentials({
        credentials,
        sessionLogAccess: {
            workingDirectory: params.workingDirectory,
            accessPolicy: params.accessPolicy,
        },
    });
}

/**
 * Register all session RPC handlers with the daemon
 */
export function registerSessionHandlers(
    rpcHandlerManager: RpcHandlerRegistrar,
    workingDirectory: string,
    opts?: Readonly<{
        getSessionMetadata?: () => Metadata | null;
        enqueueRegisteredSessionStateFieldMutation?: ((mutation: RegisteredSessionStateFieldMutationV1) => Promise<void> | void) | null;
        isUsageLimitRecoveryEnabled?: (() => Promise<boolean> | boolean) | null;
        enqueueSessionUserMessage?: ((request: {
            text: string;
            localId?: string;
            meta: Record<string, unknown>;
        }) => Promise<void> | void) | null;
        sessionRuntimeControls?: SessionRuntimeControls | null;
        accessPolicy?: FilesystemAccessPolicy;
        transcriptActionExecutor?: RpcActionExecutor | null;
    }>,
) {
    const accessPolicy = opts?.accessPolicy ?? { kind: 'osUser' };

    registerBashHandler(rpcHandlerManager, workingDirectory, { accessPolicy });
    // Checklist-based machine capability registry (replaces legacy detect-cli / detect-capabilities / dep-status).
    registerCapabilitiesHandlers(rpcHandlerManager);
    registerDaemonContributionRegistryProjectionHandler(rpcHandlerManager);
    registerPreviewEnvHandler(rpcHandlerManager);
    registerRipgrepHandler(rpcHandlerManager, workingDirectory, { accessPolicy });
    registerDifftasticHandler(rpcHandlerManager, workingDirectory, { accessPolicy });
    registerSessionUserMessageSendHandler(rpcHandlerManager, {
        workingDirectory,
        enqueueSessionUserMessage: opts?.enqueueSessionUserMessage ?? null,
        sessionRuntimeControls: opts?.sessionRuntimeControls ?? null,
    });
    registerSessionControlHandlers(rpcHandlerManager, {
        getSessionMetadata: opts?.getSessionMetadata ?? null,
        enqueueRegisteredSessionStateFieldMutation: opts?.enqueueRegisteredSessionStateFieldMutation ?? null,
        isUsageLimitRecoveryEnabled: opts?.isUsageLimitRecoveryEnabled ?? null,
        sessionRuntimeControls: opts?.sessionRuntimeControls ?? null,
    });
    registerSessionTranscriptRpcHandlers({
        rpcHandlerManager,
        ...(opts?.transcriptActionExecutor ? { actionExecutor: opts.transcriptActionExecutor } : {}),
        resolveActionExecutor: () => resolveProductionTranscriptActionExecutor({ workingDirectory, accessPolicy }),
    });
}
