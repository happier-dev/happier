import type { SessionClientPort } from "@/api/session/sessionClientPort"
import { MessageQueue2 } from "@/agent/runtime/modeMessageQueue"
import { logger } from "@/ui/logger"
import { Session } from "./session"
import { claudeLocalLauncher, LauncherResult } from "./claudeLocalLauncher"
import { claudeRemoteLauncher } from "./claudeRemoteLauncher"
import type { JsRuntime } from "./runClaude"
import type { PushNotificationClient } from "@/api/pushNotifications"

// Re-export permission mode type from api/types
// Single unified type with 7 modes - Codex modes mapped at SDK boundary
export type { PermissionMode } from "@/api/types"
import type { PermissionMode } from "@/api/types"

export interface EnhancedMode {
    permissionMode: PermissionMode;
    /**
     * Stable id for the originating user message (when provided by the app),
     * used for discard markers and reconciliation.
     */
    localId?: string | null;
    model?: string;
    fallbackModel?: string;
    customSystemPrompt?: string;
    appendSystemPrompt?: string;
    allowedTools?: string[];
    disallowedTools?: string[];

    // Claude remote-mode (provider-scoped) settings forwarded via message meta.
    claudeRemoteAgentSdkEnabled?: boolean;
    claudeRemoteSettingSources?: 'project' | 'user_project' | 'none';
    claudeRemoteIncludePartialMessages?: boolean;
    claudeRemoteEnableFileCheckpointing?: boolean;
    claudeRemoteMaxThinkingTokens?: number | null;
    claudeRemoteDisableTodos?: boolean;
    claudeRemoteStrictMcpServerConfig?: boolean;
    claudeRemoteAdvancedOptionsJson?: string;
}

interface LoopOptions {
    path: string
    model?: string
    permissionMode?: PermissionMode
    permissionModeUpdatedAt?: number
    startingMode?: 'local' | 'remote'
    onModeChange: (mode: 'local' | 'remote') => void
    mcpServers: Record<string, any>
    session: SessionClientPort
    pushSender?: PushNotificationClient | null
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    messageQueue: MessageQueue2<EnhancedMode>
    allowedTools?: string[]
    onSessionReady?: (session: Session) => void
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime
    startedBy?: 'daemon' | 'terminal'
}

export async function loop(opts: LoopOptions): Promise<number> {

    // Get log path for debug display
    const logPath = logger.logFilePath;
    let session = new Session({
        client: opts.session,
        pushSender: opts.pushSender ?? null,
        path: opts.path,
        sessionId: null,
        claudeEnvVars: opts.claudeEnvVars,
        claudeArgs: opts.claudeArgs,
        mcpServers: opts.mcpServers,
        logPath: logPath,
        messageQueue: opts.messageQueue,
        allowedTools: opts.allowedTools,
        onModeChange: opts.onModeChange,
        hookSettingsPath: opts.hookSettingsPath,
        jsRuntime: opts.jsRuntime,
        startedBy: opts.startedBy ?? 'terminal',
    });

    // Seed permission mode without blocking on transcript fetches.
    // The session's metadata snapshot is already available locally, and for fresh sessions
    // the current CLI process seeds metadata explicitly in runClaude.ts.
    const snapshot = opts.session.getMetadataSnapshot?.() as any;
    const snapshotMode = typeof snapshot?.permissionMode === 'string' ? (snapshot.permissionMode as PermissionMode) : null;
    const snapshotUpdatedAt = typeof snapshot?.permissionModeUpdatedAt === 'number' ? snapshot.permissionModeUpdatedAt : 0;
    if (snapshotMode && snapshotUpdatedAt > 0) {
        session.adoptLastPermissionModeFromMetadata(snapshotMode, snapshotUpdatedAt);
    } else {
        session.lastPermissionMode = opts.permissionMode ?? 'default';
        session.lastPermissionModeUpdatedAt = typeof opts.permissionModeUpdatedAt === 'number' ? opts.permissionModeUpdatedAt : 0;
    }
    opts.onSessionReady?.(session)

    let mode: 'local' | 'remote' = opts.startingMode ?? 'local';
    let localEntry: 'initial' | 'switch' = mode === 'local' ? 'initial' : 'switch';
    while (true) {
        logger.debug(`[loop] Iteration with mode: ${mode}`);
        switch (mode) {
            case 'local': {
                const result = await claudeLocalLauncher(session, { entry: localEntry });
                localEntry = 'switch';
                switch (result.type) {
                    case 'switch':
                        mode = 'remote';
                        session.onModeChange(mode);
                        break;
                    case 'exit':
                        return result.code;
                    default:
                        const _: never = result satisfies never;
                }
                break;
            }

            case 'remote': {
                const reason = await claudeRemoteLauncher(session);
                switch (reason) {
                    case 'exit':
                        return 0;
                    case 'switch':
                        mode = 'local';
                        session.onModeChange(mode);
                        localEntry = 'switch';
                        break;
                    default:
                        const _: never = reason satisfies never;
                }
                break;
            }

            default: {
                const _: never = mode satisfies never;
            }
        }
    }
}
