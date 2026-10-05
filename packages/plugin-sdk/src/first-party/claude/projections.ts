import type { AgentModelOption } from '../../agents.js';
import {
    RawJSONLinesSchema as canonicalRawJSONLinesSchema,
} from '@happier-dev/protocol/agents/claude/transcripts';
import {
    ANTHROPIC_EFFORT_LEVELS as canonicalAnthropicEffortLevels,
    buildAnthropicModelOptions as buildCanonicalAnthropicModelOptions,
    normalizeAnthropicModelDisplayName as normalizeCanonicalAnthropicModelDisplayName,
    formatAnthropicEffortLevelLabel as formatCanonicalAnthropicEffortLevelLabel,
} from '@happier-dev/protocol/providers/anthropic-models';
import {
    CLAUDE_SETTING_SOURCES_V2 as canonicalClaudeSettingSourcesV2,
    CLAUDE_REMOTE_DEBUG_CATEGORIES as canonicalClaudeRemoteDebugCategories,
    CLAUDE_UNIFIED_TERMINAL_HOSTS as canonicalClaudeUnifiedTerminalHosts,
    CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES as canonicalClaudeUnifiedTerminalResumeChoices,
    CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES as canonicalClaudeUnifiedTerminalWorkspaceTrustPolicies,
    DEFAULT_CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE as canonicalDefaultClaudeUnifiedTerminalResumeChoice,
    DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY as canonicalDefaultClaudeUnifiedTerminalWorkspaceTrustPolicy,
    MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS as canonicalMaxClaudeRemoteAdvancedOptionsJsonChars,
    normalizeClaudeRemoteAdvancedOptionsJson as normalizeCanonicalClaudeRemoteAdvancedOptionsJson,
    normalizeClaudeUnifiedTerminalHost as normalizeCanonicalClaudeUnifiedTerminalHost,
    normalizeClaudeUnifiedTerminalResumeChoice as normalizeCanonicalClaudeUnifiedTerminalResumeChoice,
    normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy as normalizeCanonicalClaudeUnifiedTerminalWorkspaceTrustPolicy,
    isValidClaudeRemoteAdvancedOptionsJson as isValidCanonicalClaudeRemoteAdvancedOptionsJson,
} from '@happier-dev/protocol/agents/claude/settings-policy';

// These public DTOs are SDK-owned; their values and decisions stay Protocol-owned.
export type ClaudeSettingSourceV2 = 'user' | 'project' | 'local';
export type ClaudeRemoteDebugCategory = 'api' | 'mcp' | 'hooks' | 'file' | '1p';
export type ClaudeUnifiedTerminalHost = 'auto' | 'tmux' | 'zellij' | 'herdr';
export type ClaudeUnifiedTerminalResumeChoice =
    | 'ask_every_time' | 'resume_from_summary' | 'resume_full_session';
export type ClaudeUnifiedTerminalWorkspaceTrustPolicy =
    | 'ask_every_time' | 'always_trust_happier_workspaces' | 'always_reject_happier_workspaces';
export type AnthropicEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Native Claude row DTOs; the retained CLI parser remains Protocol-owned. */
export type ClaudeRawUsage = Readonly<{
    input_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens: number;
    service_tier?: string | null;
    [key: string]: unknown;
}>;

export type RawJSONLines =
    | Readonly<{
        type: 'user';
        isSidechain?: boolean;
        isMeta?: boolean;
        uuid: string;
        message: Readonly<{ content: string | unknown; [key: string]: unknown }>;
        [key: string]: unknown;
    }>
    | Readonly<{
        type: 'assistant';
        isSidechain?: boolean;
        uuid: string;
        message?: Readonly<{
            usage?: ClaudeRawUsage;
            model?: string;
            [key: string]: unknown;
        }>;
        [key: string]: unknown;
    }>
    | Readonly<{
        type: 'result';
        subtype: string;
        uuid: string;
        session_id: string;
        usage: Readonly<Record<string, unknown>>;
        modelUsage: Readonly<Record<string, unknown>>;
        [key: string]: unknown;
    }>
    | Readonly<{
        type: 'summary';
        summary: string;
        leafUuid: string;
        [key: string]: unknown;
    }>
    | Readonly<{
        type: 'system';
        uuid: string;
        [key: string]: unknown;
    }>
    | Readonly<{
        type: 'progress';
        uuid?: string;
        [key: string]: unknown;
    }>
    | Readonly<{
        type: 'attachment';
        uuid: string;
        attachment: Readonly<Record<string, unknown>>;
        [key: string]: unknown;
    }>;

export const RawJSONLinesSchema: Readonly<{
    safeParse(value: unknown):
        | Readonly<{ success: true; data: RawJSONLines }>
        | Readonly<{ success: false; error: string }>;
}> = canonicalRawJSONLinesSchema;

export const CLAUDE_SETTING_SOURCES_V2: readonly ClaudeSettingSourceV2[] = canonicalClaudeSettingSourcesV2;
export const CLAUDE_REMOTE_DEBUG_CATEGORIES: readonly ClaudeRemoteDebugCategory[] = canonicalClaudeRemoteDebugCategories;
export const CLAUDE_UNIFIED_TERMINAL_HOSTS: readonly ClaudeUnifiedTerminalHost[] = canonicalClaudeUnifiedTerminalHosts;
export const CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES: readonly ClaudeUnifiedTerminalResumeChoice[] = canonicalClaudeUnifiedTerminalResumeChoices;
export const CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES: readonly ClaudeUnifiedTerminalWorkspaceTrustPolicy[] = canonicalClaudeUnifiedTerminalWorkspaceTrustPolicies;
export const DEFAULT_CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE: ClaudeUnifiedTerminalResumeChoice = canonicalDefaultClaudeUnifiedTerminalResumeChoice;
export const DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY: ClaudeUnifiedTerminalWorkspaceTrustPolicy = canonicalDefaultClaudeUnifiedTerminalWorkspaceTrustPolicy;
export const MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS: number = canonicalMaxClaudeRemoteAdvancedOptionsJsonChars;
export const ANTHROPIC_EFFORT_LEVELS: readonly AnthropicEffortLevel[] = canonicalAnthropicEffortLevels;

export const normalizeClaudeRemoteAdvancedOptionsJson: (raw: unknown) => string =
    normalizeCanonicalClaudeRemoteAdvancedOptionsJson;
export const normalizeClaudeUnifiedTerminalHost: (raw: unknown) => ClaudeUnifiedTerminalHost | null =
    normalizeCanonicalClaudeUnifiedTerminalHost;
export const normalizeClaudeUnifiedTerminalResumeChoice: (raw: unknown) => ClaudeUnifiedTerminalResumeChoice | null =
    normalizeCanonicalClaudeUnifiedTerminalResumeChoice;
export const normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy: (raw: unknown) => ClaudeUnifiedTerminalWorkspaceTrustPolicy | null =
    normalizeCanonicalClaudeUnifiedTerminalWorkspaceTrustPolicy;
export const isValidClaudeRemoteAdvancedOptionsJson: (raw: string) => boolean =
    isValidCanonicalClaudeRemoteAdvancedOptionsJson;
export const normalizeAnthropicModelDisplayName: (raw: unknown, fallback: string) => string =
    normalizeCanonicalAnthropicModelDisplayName;
export const formatAnthropicEffortLevelLabel: (level: AnthropicEffortLevel) => string =
    formatCanonicalAnthropicEffortLevelLabel;
export const buildAnthropicModelOptions: (input: Readonly<{
    supportedLevels: readonly AnthropicEffortLevel[];
    defaultEffort?: AnthropicEffortLevel | null;
}>) => readonly AgentModelOption[] = buildCanonicalAnthropicModelOptions;
