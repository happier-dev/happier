import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { runTerminalRemoteSessionModeLoop } from '@/agent/runtime/sessionLoop/runTerminalRemoteSessionModeLoop';
import type { McpServerConfig } from '@/agent';
import type { AccountSettings } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';
import {
    normalizeClaudeRuntimeStartingMode,
    mapClaudeRuntimeModeToSessionMode,
    mapSessionModeToClaudeRuntimeMode,
    type ClaudeRuntimeMode,
    type ClaudeRuntimeStartingModeInput,
    type JsRuntime,
} from '@/backends/claude/runtime/claudeSessionRuntimeOptions';
import type { ClaudeEnhancedModeMessageQueue, EnhancedMode, PermissionMode } from '@/backends/claude/runtime/claudeEnhancedMode';
import { launchClaudeRemoteSession } from '@/backends/claude/runtime/remote/launcher';

import { Session, type SessionPushSender } from './ClaudeSession';

export type { EnhancedMode, PermissionMode } from '@/backends/claude/runtime/claudeEnhancedMode';

interface LoopOptions {
    path: string;
    model?: string;
    permissionMode?: PermissionMode;
    permissionModeUpdatedAt?: number;
    startingMode?: ClaudeRuntimeStartingModeInput;
    /** Force-enable Claude Code experimental Agent Teams across terminal + remote starts (off = inherit). */
    claudeCodeExperimentalAgentTeamsEnabled?: boolean;
    launchTerminal: (params: Readonly<{
        session: Session;
        options?: Readonly<{ entry?: 'initial' | 'switch' }>;
    }>) => Promise<{ type: 'switch' } | { type: 'exit'; code: number }>;
    onModeChange: (mode: ClaudeRuntimeMode) => void;
    session: SessionClientPort;
    pushSender?: SessionPushSender | null;
    accountSettings?: AccountSettings | null;
    accountSettingsSecretsReadKeys?: readonly Uint8Array[];
    claudeArgs?: string[];
    messageQueue: ClaudeEnhancedModeMessageQueue;
    onSessionReady?: (session: Session) => void;
    /** Path to temporary settings file with non-hook config (required for session tracking) */
    hookSettingsPath: string;
    /**
     * Optional path to a Happier-generated plugin dir carrying the session's hooks.
     * Threaded through so the spawned CLI registers hooks via `--plugin-dir`, which
     * is additive across wrappers — `--settings` hooks are non-composable and get
     * silently dropped when a PATH-resident wrapper prepends its own overlay.
     */
    hookPluginDir?: string | null;
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime;
    startedBy?: 'daemon' | 'terminal';
    defaultSystemPromptText?: string;
    precomputedMcpBridge?: { mcpServers: Record<string, McpServerConfig>; stop: () => void } | null;
}

export async function runClaudeModeLoop(opts: LoopOptions): Promise<number> {
    // Get log path for debug display
    const logPath = logger.logFilePath;
    const session = new Session({
        client: opts.session,
        pushSender: opts.pushSender ?? null,
        accountSettings: opts.accountSettings ?? null,
        accountSettingsSecretsReadKeys: opts.accountSettingsSecretsReadKeys ?? [],
        path: opts.path,
        sessionId: null,
        claudeArgs: opts.claudeArgs,
        logPath: logPath,
        messageQueue: opts.messageQueue,
        onModeChange: (mode) => {
            opts.onModeChange(mapSessionModeToClaudeRuntimeMode(mode));
        },
        hookSettingsPath: opts.hookSettingsPath,
        hookPluginDir: opts.hookPluginDir ?? null,
        jsRuntime: opts.jsRuntime,
        startedBy: opts.startedBy ?? 'terminal',
        defaultSystemPromptText: opts.defaultSystemPromptText,
        precomputedMcpBridge: opts.precomputedMcpBridge ?? null,
    });
    session.claudeCodeExperimentalAgentTeamsEnabled = opts.claudeCodeExperimentalAgentTeamsEnabled === true;

    // Seed permission mode without blocking on transcript fetches.
    // The session's metadata snapshot is already available locally, and for fresh sessions
    // the retirement-only legacy direct runner seeds metadata explicitly before loop attach.
    const snapshot = opts.session.getMetadataSnapshot?.();
    const snapshotRecord = snapshot && typeof snapshot === 'object' ? snapshot as Readonly<Record<string, unknown>> : null;
    const snapshotMode = typeof snapshotRecord?.permissionMode === 'string' ? (snapshotRecord.permissionMode as PermissionMode) : null;
    const snapshotUpdatedAt = typeof snapshotRecord?.permissionModeUpdatedAt === 'number' ? snapshotRecord.permissionModeUpdatedAt : 0;
    if (snapshotMode && snapshotUpdatedAt > 0) {
        session.adoptLastPermissionModeFromMetadata(snapshotMode, snapshotUpdatedAt);
    } else {
        session.lastPermissionMode = opts.permissionMode ?? 'default';
        session.lastPermissionModeUpdatedAt = typeof opts.permissionModeUpdatedAt === 'number' ? opts.permissionModeUpdatedAt : 0;
    }
    opts.onSessionReady?.(session);

    return await runTerminalRemoteSessionModeLoop({
        startingMode: normalizeClaudeRuntimeStartingMode(opts.startingMode),
        remoteExitCode: 0,
        onBeforeIteration: (mode) => {
            logger.debug(`[loop] Iteration with mode: ${mode}`);
        },
        runTerminal: async ({ entry }) => await opts.launchTerminal({ session, options: { entry } }),
        runRemote: async () => await launchClaudeRemoteSession(session),
        onModeChange: (mode) => {
            session.onModeChange(mapClaudeRuntimeModeToSessionMode(mode));
        },
    });
}
