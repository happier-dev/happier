import type { AccountSettings } from '@happier-dev/protocol';

import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/sessionLoop/runHostSessionRuntime';
import type { PermissionMode } from './claudeEnhancedMode';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';

/** JavaScript runtime to use for spawning Claude Code. */
export type JsRuntime = 'node' | 'bun';
export type ClaudeRuntimeMode = 'terminal' | 'remote';
export type ClaudeRuntimeStartingModeInput = ClaudeRuntimeMode | 'local';

export function normalizeClaudeRuntimeStartingMode(mode: unknown): ClaudeRuntimeMode {
    return mode === 'remote' ? 'remote' : 'terminal';
}

export function mapClaudeRuntimeModeToSessionMode(mode: ClaudeRuntimeMode): 'local' | 'remote' {
    return mode === 'remote' ? 'remote' : 'local';
}

export function mapSessionModeToClaudeRuntimeMode(mode: 'local' | 'remote'): ClaudeRuntimeMode {
    return mode === 'remote' ? 'remote' : 'terminal';
}

export interface StartOptions {
    model?: string;
    modelId?: string;
    modelUpdatedAt?: number;
    permissionMode?: PermissionMode;
    sessionModeId?: string;
    sessionModeUpdatedAt?: number;
    startingMode?: ClaudeRuntimeStartingModeInput;
    shouldStartDaemon?: boolean;
    claudeArgs?: string[];
    startedBy?: 'daemon' | 'terminal';
    /** JavaScript runtime to use for spawning Claude Code (default: 'node'). */
    jsRuntime?: JsRuntime;
    /** Internal terminal runtime flags passed by the spawner (daemon/tmux wrapper). */
    terminalRuntime?: TerminalRuntimeFlags | null;
    /** Seed defaults for Claude remote-mode settings forwarded via message meta. */
    claudeRemoteMetaDefaults?: Record<string, unknown> | null;
    /**
     * Optional timestamp for permissionMode (ms). Used to order explicit UI selections across devices.
     * When omitted, the runner falls back to local time when publishing a mode.
     */
    permissionModeUpdatedAt?: number;
    /**
     * Existing Happy session ID to reconnect to.
     * When set, the CLI will connect to this session instead of creating a new one.
     * Used for resuming inactive sessions.
     */
    existingSessionId?: string;
    /** Account settings snapshot for this runner (used for notification policy + seeds). */
    accountSettings?: AccountSettings | null;
    /** Internal startup timing hook used to mark when the vendor loop is invoked. */
    onVendorSpawnInvoked?: (() => void) | null;
}

export type ClaudeSessionRuntimeOptions = HostSessionRuntimeRunOptions & StartOptions & Readonly<{
    directory?: string;
}>;
