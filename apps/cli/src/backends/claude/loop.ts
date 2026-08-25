import type { SessionClientPort } from "@/api/session/sessionClientPort"
import { MessageQueue2 } from "@/agent/runtime/modeMessageQueue"
import { logger } from "@/ui/logger"
import { Session } from "./session"
import { claudeLocalLauncher } from "./claudeLocalLauncher"
import { claudeRemoteLauncher } from "./claudeRemoteLauncher"
import { claudeUnifiedTerminalLauncher } from './unifiedTerminal/claudeUnifiedTerminalLauncher';
import type { JsRuntime } from "./runClaude"
import type { PushNotificationClient } from "@/api/pushNotifications"
import type { AccountSettings } from '@happier-dev/protocol';
import type { ClaudeUnifiedTerminalHost, ClaudeUnifiedTerminalResumeChoice } from '@happier-dev/agents';
import type { McpServerConfig } from '@/agent';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { installClaudeProviderOwnedUserMessageEchoClassifier } from './utils/claudeProviderOwnedUserMessageEcho';
import type { SessionRuntimeActivityContributionHandle } from '@/session/runtimeActivity/types';

// Re-export permission mode type from api/types
// Single unified type with 7 modes - Codex modes mapped at SDK boundary
export type { PermissionMode } from "@/api/types"
import type { PermissionMode } from "@/api/types"

const CLAUDE_UNIFIED_TERMINAL_FEATURE_ID = 'providers.claude.unifiedTerminal';

export interface EnhancedMode {
    permissionMode: PermissionMode;
    /** Agent/session mode override id (e.g. "plan"). Stored via acpSessionModeOverrideV1 in session metadata. */
    agentModeId?: string | null;
    /**
     * Whether replaySeedV1 is allowed to prefix this prompt (provider-only).
     * Special commands like /clear should disable seeding.
     */
    replaySeedAllowed?: boolean;
    /**
     * Stable id for the originating user message (when provided by the app),
     * used for discard markers and reconciliation.
     */
    localId?: string | null;
    model?: string;
    fallbackModel?: string;
    customSystemPrompt?: string;
    appendSystemPrompt?: string;
    /**
     * Model-scoped "Thinking" selection (generic id: reasoning_effort).
     *
     * For Claude Code this maps to `--effort <level>` when supported.
     */
    reasoningEffort?: string;
    /**
     * Session-only Claude Code ultracode setting (generic config option id: ultracode).
     *
     * Forces xhigh effort + Dynamic Workflows. NOT an effort level: it rides the
     * `--settings {"ultracode":true}` overlay (spawn) or `/effort ultracode` (unified TUI),
     * never `--effort` or the SDK `effort` option. Only honored on xhigh-capable models.
     */
    ultracode?: boolean;
    /**
     * Effort tiers the selected model reports (Anthropic Models API), resolved once when the mode
     * is built.
     *
     * Curated models carry their own static effort table; this supplies the same evidence for a
     * discovered model. It is part of the mode — not read from a cache at spawn time — so
     * launch-option hashing stays a pure function of the mode.
     */
    modelEffortLevels?: readonly string[];
    /**
     * The model `modelEffortLevels` was resolved for.
     *
     * Call sites can override the model (e.g. `--model` inside `claudeArgs`), so tiers are only
     * evidence when they belong to the model actually being launched.
     */
    modelEffortLevelsModelId?: string | null;

    // Claude remote-mode (provider-scoped) settings forwarded via message meta.
    claudeRemoteAgentSdkEnabled?: boolean;
    claudeUnifiedTerminalEnabled?: boolean;
    claudeUnifiedTerminalHost?: ClaudeUnifiedTerminalHost;
    claudeUnifiedTerminalResumeChoice?: ClaudeUnifiedTerminalResumeChoice;
    claudeRemoteSettingSourcesV2?: ReadonlyArray<'user' | 'project' | 'local'>;
    claudeRemoteSettingSources?: 'project' | 'user_project' | 'none';
    claudeCodeExperimentalAgentTeamsEnabled?: boolean;
    claudeRemoteEnableFileCheckpointing?: boolean;
    claudeRemoteMaxThinkingTokens?: number | null;
    claudeRemoteDisableTodos?: boolean;
    claudeRemoteStrictMcpServerConfig?: boolean;
    claudeRemoteDebugEnabled?: boolean;
    claudeRemoteVerboseEnabled?: boolean;
    claudeRemoteDebugCategories?: ReadonlyArray<'api' | 'mcp' | 'hooks' | 'file' | '1p'>;
    claudeRemoteAdvancedOptionsJson?: string;
}
interface LoopOptions {
    path: string
    model?: string
    permissionMode?: PermissionMode
    permissionModeUpdatedAt?: number
    startingMode?: 'local' | 'remote'
    claudeUnifiedTerminalEnabled?: boolean
        /** Force-enable Claude Code experimental Agent Teams across local + remote starts (off = inherit). */
        claudeCodeExperimentalAgentTeamsEnabled?: boolean
    onModeChange: (mode: 'local' | 'remote') => void
    session: SessionClientPort
    pushSender?: PushNotificationClient | null
    accountSettings?: AccountSettings | null
    accountSettingsSecretsReadKeys?: readonly Uint8Array[]
    claudeArgs?: string[]
    messageQueue: MessageQueue2<EnhancedMode>
    onSessionReady?: (session: Session) => Promise<void> | void
    /** Path to temporary settings file with non-hook config (required for session tracking) */
    hookSettingsPath: string
    /**
     * Optional path to a Happier-generated plugin dir carrying the session's hooks.
     * Threaded through so the spawned CLI registers hooks via `--plugin-dir`, which
     * is additive across wrappers — `--settings` hooks are non-composable and get
     * silently dropped when a PATH-resident wrapper prepends its own overlay.
     */
    hookPluginDir?: string | null
    /**
     * Hook-server coordinates (port + shared secret) for the statusline forwarder wrapper.
     * Threaded into the Unified terminal spawn's `--settings` overlay; null/absent simply
     * disables statusline forwarding (additive enrichment).
     */
    statuslineForwarder?: Readonly<{ port: number; secret: string }> | null
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime
    startedBy?: 'daemon' | 'terminal'
    terminalRuntime?: TerminalRuntimeFlags | null
    defaultSystemPromptText?: string
    precomputedMcpBridge?: { mcpServers: Record<string, McpServerConfig>; stop: () => void } | null
    reportSessionMetadataToDaemon?: (input: Readonly<{
        sessionId: string;
        metadata: import('@/api/types').Metadata;
    }>) => Promise<void> | void
    runtimeActivityContributions?: Readonly<{
        activateProviderTasks(): Promise<Readonly<{
            providerTasks: SessionRuntimeActivityContributionHandle;
            isCurrentRuntime: () => boolean;
        }>>;
    }>
    initialClaudeUnifiedTerminalMode?: EnhancedMode
    expectedExistingTerminalHostAttachmentId?: string
    onTerminalHostReady?: ((params: Readonly<{
        handle: import('@/integrations/terminalHost/_types').TerminalHostHandle;
        terminal: NonNullable<import('@/api/types').Metadata['terminal']>;
        destroyOwnedHostForExplicitStop: () => Promise<void>;
    }>) => void | Promise<void>)
    signal?: AbortSignal
}

export async function loop(opts: LoopOptions): Promise<number> {

    installClaudeProviderOwnedUserMessageEchoClassifier(opts.session);
    logger.infoFile('[CLAUDE_STARTUP] stage=provider_loop_entered');

    // Get log path for debug display
    const logPath = logger.logFilePath;
    logger.infoFile('[CLAUDE_STARTUP] stage=provider_activity_binding_started');
    const runtimeActivityContributions =
        await opts.runtimeActivityContributions?.activateProviderTasks();
    logger.infoFile('[CLAUDE_STARTUP] stage=provider_activity_binding_completed');
    let session = new Session({
        client: opts.session,
        pushSender: opts.pushSender ?? null,
        accountSettings: opts.accountSettings ?? null,
        accountSettingsSecretsReadKeys: opts.accountSettingsSecretsReadKeys ?? [],
        path: opts.path,
        sessionId: null,
        claudeArgs: opts.claudeArgs,
        logPath: logPath,
        messageQueue: opts.messageQueue,
        onModeChange: opts.onModeChange,
        hookSettingsPath: opts.hookSettingsPath,
        hookPluginDir: opts.hookPluginDir ?? null,
        claudeStatuslineForwarder: opts.statuslineForwarder ?? null,
        jsRuntime: opts.jsRuntime,
        startedBy: opts.startedBy ?? 'terminal',
        terminalRuntime: opts.terminalRuntime ?? null,
        defaultSystemPromptText: opts.defaultSystemPromptText,
        precomputedMcpBridge: opts.precomputedMcpBridge ?? null,
        reportSessionMetadataToDaemon: opts.reportSessionMetadataToDaemon ?? null,
        runtimeActivityContributions,
    });
    session.claudeCodeExperimentalAgentTeamsEnabled = opts.claudeCodeExperimentalAgentTeamsEnabled === true;

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
    logger.infoFile('[CLAUDE_STARTUP] stage=session_ready_callback_started');
    await opts.onSessionReady?.(session)
    logger.infoFile('[CLAUDE_STARTUP] stage=session_ready_callback_completed');

    if (opts.claudeUnifiedTerminalEnabled === true) {
        const unifiedTerminalDecision = resolveCliFeatureDecision({
            featureId: CLAUDE_UNIFIED_TERMINAL_FEATURE_ID,
            env: process.env,
        });
        if (unifiedTerminalDecision.state !== 'enabled') {
            throw new Error('Claude unified terminal runtime is disabled by feature policy');
        }
        logger.infoFile('[CLAUDE_STARTUP] stage=provider_launcher_entered', { runtime: 'unified-terminal' });
        const result = await claudeUnifiedTerminalLauncher(session, {
            initialMode: opts.initialClaudeUnifiedTerminalMode ?? {
                permissionMode: opts.permissionMode ?? session.lastPermissionMode ?? 'default',
                model: opts.model,
                claudeUnifiedTerminalEnabled: true,
                claudeCodeExperimentalAgentTeamsEnabled: opts.claudeCodeExperimentalAgentTeamsEnabled,
            },
            expectedExistingTerminalHostAttachmentId: opts.expectedExistingTerminalHostAttachmentId,
            onTerminalHostReady: opts.onTerminalHostReady,
            signal: opts.signal,
        });
        switch (result.type) {
            case 'exit':
                return result.code;
            case 'switch':
                logger.warn('[loop] Ignoring legacy Claude unified terminal switch request');
                return 0;
            default:
                const _: never = result satisfies never;
        }
    }

    let mode: 'local' | 'remote' = opts.startingMode ?? 'local';
    let localEntry: 'initial' | 'switch' = mode === 'local' ? 'initial' : 'switch';
    while (true) {
        logger.debug(`[loop] Iteration with mode: ${mode}`);
        switch (mode) {
            case 'local': {
                logger.infoFile('[CLAUDE_STARTUP] stage=provider_launcher_entered', { runtime: 'local' });
                const result = await claudeLocalLauncher(session, {
                    entry: localEntry,
                    remoteSwitchingEnabled: true,
                });
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
                logger.infoFile('[CLAUDE_STARTUP] stage=provider_launcher_entered', { runtime: 'agent-sdk' });
                const reason = await claudeRemoteLauncher(session, {
                    initialMode: opts.initialClaudeUnifiedTerminalMode,
                });
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
