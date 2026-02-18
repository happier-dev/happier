import type { TerminalSpawnOptions } from '@/terminal/runtime/terminalConfig';
import type { PermissionMode } from '@/api/types';
import type { CatalogAgentId } from '@/backends/types';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { SpawnSessionErrorCode } from '@happier-dev/protocol';
export { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
export type { SpawnSessionErrorCode } from '@happier-dev/protocol';
import { registerCapabilitiesHandlers } from './capabilities';
import { registerPreviewEnvHandler } from './previewEnv';
import { registerBashHandler } from './bash';
import { registerFileSystemHandlers } from './fileSystem';
import { registerRipgrepHandler } from './ripgrep';
import { registerDifftasticHandler } from './difftastic';
import { registerScmHandlers } from './scm';

/*
 * Spawn Session Options and Result
 * This rpc type is used by the daemon, all other RPCs here are for sessions
 */

export interface SpawnSessionOptions {
    machineId?: string;
    directory: string;
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
     * Experimental: allow Codex vendor resume for this spawn.
     * This is evaluated by the daemon BEFORE spawning the child process.
     */
    experimentalCodexResume?: boolean;
    /**
     * Experimental: switch Codex sessions to use ACP (codex-acp) instead of MCP.
     * This is evaluated by the daemon BEFORE spawning the child process.
     */
    experimentalCodexAcp?: boolean;
    /**
     * Existing Happy session ID to reconnect to (for inactive session resume).
     * When set, the CLI will connect to this session instead of creating a new one.
     */
    existingSessionId?: string;
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
     * Optional: session-wide model override to seed at startup (spawn/resume attach).
     *
     * When set, the spawned CLI process will publish `metadata.modelOverrideV1` so the model choice
     * follows the session across devices.
     */
    modelId?: string;
    modelUpdatedAt?: number;
    approvedNewDirectoryCreation?: boolean;
    agent?: CatalogAgentId;
    token?: string;
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
    windowsRemoteSessionConsole?: 'hidden' | 'visible';
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
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId?: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorCode: SpawnSessionErrorCode; errorMessage: string };

/**
 * Register all session RPC handlers with the daemon
 */
export function registerSessionHandlers(
    rpcHandlerManager: RpcHandlerRegistrar,
    workingDirectory: string,
) {
    registerBashHandler(rpcHandlerManager, workingDirectory);
    // Checklist-based machine capability registry (replaces legacy detect-cli / detect-capabilities / dep-status).
    registerCapabilitiesHandlers(rpcHandlerManager);
    registerPreviewEnvHandler(rpcHandlerManager);
    registerFileSystemHandlers(rpcHandlerManager, workingDirectory);
    registerRipgrepHandler(rpcHandlerManager, workingDirectory);
    registerDifftasticHandler(rpcHandlerManager, workingDirectory);
    registerScmHandlers(rpcHandlerManager, workingDirectory);
}
