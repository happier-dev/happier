import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { hashClaudeEnhancedModeForQueue } from '../remote/modeHash';

// Re-export permission mode type from api/types.
// Single unified type with 7 modes - Codex modes mapped at SDK boundary.
export type { PermissionMode } from '@/api/types';
import type { PermissionMode } from '@/api/types';

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

    // Claude remote-mode (provider-scoped) settings forwarded via message meta.
    claudeRemoteAgentSdkEnabled?: boolean;
    claudeRemoteSettingSourcesV2?: ReadonlyArray<'user' | 'project' | 'local'>;
    claudeRemoteSettingSources?: 'project' | 'user_project' | 'none';
    claudeCodeExperimentalAgentTeamsEnabled?: boolean;
    claudeLocalPermissionBridgeEnabled?: boolean;
    claudeLocalPermissionBridgeWaitIndefinitely?: boolean;
    claudeLocalPermissionBridgeTimeoutSeconds?: number;
    claudeRemoteEnableFileCheckpointing?: boolean;
    claudeRemoteMaxThinkingTokens?: number | null;
    claudeRemoteDisableTodos?: boolean;
    claudeRemoteStrictMcpServerConfig?: boolean;
    claudeRemoteDebugEnabled?: boolean;
    claudeRemoteVerboseEnabled?: boolean;
    claudeRemoteDebugCategories?: ReadonlyArray<'api' | 'mcp' | 'hooks' | 'file' | '1p'>;
    claudeRemoteAdvancedOptionsJson?: string;
}

export type ClaudeEnhancedModeMessageQueue = MessageQueue2<EnhancedMode>;

export function createClaudeEnhancedModeMessageQueue(): ClaudeEnhancedModeMessageQueue {
    return new MessageQueue2<EnhancedMode>(hashClaudeEnhancedModeForQueue);
}
