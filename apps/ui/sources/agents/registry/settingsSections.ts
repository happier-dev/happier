import type { ProviderSettingsSectionDef } from '@/agents/providers/shared/providerSettingsPlugin';

const claudeSettingsSections = [
    {
        id: 'claudeCodeExperiments',
        title: 'Claude Code experiments',
        footer: 'These settings apply to both local Claude (terminal) and remote Claude (Agent SDK) sessions started by Happier.',
        fields: [
            {
                key: 'claudeCodeExperimentalAgentTeamsEnabled',
                kind: 'boolean',
                title: 'Force-enable Agent Teams',
                subtitle: 'Enable Claude Code experimental Agent Teams (agent swarm) in all Claude sessions started by Happier.',
            },
        ],
    },
    {
        id: 'claudeRemoteSdk',
        title: 'Claude Agent SDK (remote mode)',
        footer:
            'Remote mode runs Claude on your machine, but controlled from the Happier UI. Local mode is the Claude Code TUI in your terminal. These settings affect remote mode only.',
        fields: [
            {
                key: 'claudeRemoteAgentSdkEnabled',
                kind: 'boolean',
                title: 'Use Agent SDK (remote)',
                subtitle: 'Use the official @anthropic-ai/claude-agent-sdk for remote mode.',
            },
            {
                key: 'claudeRemoteSettingSourcesV2',
                kind: 'multiEnum',
                title: 'Setting sources',
                subtitle: 'Controls which Claude settings are loaded.',
                enumOptions: [
                    {
                        id: 'user',
                        title: 'User',
                        subtitle: 'Loads user-global Claude config.',
                    },
                    {
                        id: 'project',
                        title: 'Project',
                        subtitle: 'Loads repo settings (including CLAUDE.md).',
                    },
                    {
                        id: 'local',
                        title: 'Local',
                        subtitle: 'Loads local-only overrides.',
                    },
                ],
            },
            {
                key: 'claudeRemoteIncludePartialMessages',
                kind: 'boolean',
                title: 'Partial streaming updates',
                subtitle: 'Show partial assistant output while Claude is still responding.',
            },
            {
                key: 'claudeLocalPermissionBridgeEnabled',
                kind: 'boolean',
                title: 'Experimental: local permission bridge',
                subtitle: 'Forward Claude local-mode permission prompts to Happier so you can approve or deny from the app UI.',
            },
            {
                key: 'claudeLocalPermissionBridgeWaitIndefinitely',
                kind: 'boolean',
                title: 'Experimental: wait indefinitely',
                subtitle:
                    'When enabled, Happier will wait indefinitely for an approval/deny from the app UI (no terminal fallback; may hang if the UI is closed).',
            },
            {
                key: 'claudeLocalPermissionBridgeTimeoutSeconds',
                kind: 'number',
                title: 'Local permission timeout (seconds)',
                subtitle:
                    'How long to wait for an approval/deny from the app UI before falling back to the terminal prompt (default: 600 = 10 minutes).',
                numberSpec: {
                    min: 1,
                    step: 30,
                    placeholder: '600',
                },
            },
            {
                key: 'claudeRemoteEnableFileCheckpointing',
                kind: 'boolean',
                title: 'File checkpointing + /rewind',
                subtitle:
                    'Enables file checkpoints and /rewind (files-only; does not rewind the conversation). Use /checkpoints to list and /rewind --confirm to apply (higher overhead).',
            },
            {
                key: 'claudeRemoteMaxThinkingTokens',
                kind: 'number',
                title: 'Max thinking tokens',
                subtitle: 'Limit Claude’s internal thinking budget (null = default).',
                numberSpec: {
                    min: 1,
                    step: 100,
                    placeholder: 'Default',
                    nullLabel: 'Default',
                },
            },
            {
                key: 'claudeRemoteDisableTodos',
                kind: 'boolean',
                title: 'Disable TODOs',
                subtitle: 'Prevent Claude from creating TODO items in remote mode.',
            },
            {
                key: 'claudeRemoteStrictMcpServerConfig',
                kind: 'boolean',
                title: 'Strict MCP server config',
                subtitle: 'Fail if any MCP server config is invalid.',
            },
            {
                key: 'claudeRemoteAdvancedOptionsJson',
                kind: 'json',
                title: 'Advanced options (JSON)',
                subtitle: 'Power-user Agent SDK overrides (validated client-side).',
            },
        ],
    },
] satisfies readonly ProviderSettingsSectionDef[];

const codexSettingsSections = [
    {
        id: 'codexMode',
        title: 'Codex mode',
        footer: 'Select the backend Codex should use for this machine.',
        fields: [
            {
                key: 'codexBackendMode',
                kind: 'enum',
                title: 'Codex backend mode',
                subtitle: 'Choose the integration backend.',
                enumOptions: [
                    {
                        id: 'acp',
                        title: 'ACP',
                        subtitle: 'Use the shared ACP runtime.',
                    },
                    {
                        id: 'mcp',
                        title: 'MCP',
                        subtitle: 'Use the legacy MCP-compatible path.',
                    },
                ],
            },
        ],
    },
] satisfies readonly ProviderSettingsSectionDef[];

const opencodeSettingsSections = [
    {
        id: 'opencodeBackendMode',
        title: 'Backend mode',
        footer: 'Server mode unlocks questions and native forking. ACP mode is a legacy fallback.',
        fields: [
            {
                key: 'opencodeBackendMode',
                kind: 'enum',
                title: 'OpenCode backend mode',
                subtitle: 'Choose the integration backend.',
                enumOptions: [
                    {
                        id: 'server',
                        title: 'Server (recommended)',
                        subtitle: 'Uses OpenCode server APIs for richer features and reliability.',
                    },
                    {
                        id: 'acp',
                        title: 'ACP (legacy)',
                        subtitle: 'Routes OpenCode through ACP; fewer features.',
                    },
                ],
            },
        ],
    },
    {
        id: 'opencodeServer',
        title: 'Server connection',
        footer: 'Leave empty to use Happier-managed OpenCode server lifecycle. Set an absolute http(s) URL to connect to an existing OpenCode server instead.',
        fields: [
            {
                key: 'opencodeServerBaseUrl',
                kind: 'text',
                title: 'Existing OpenCode server URL',
                subtitle: 'Optional override for a user-managed OpenCode server.',
            },
        ],
    },
] satisfies readonly ProviderSettingsSectionDef[];

const noopSettingsSections = [] as const satisfies readonly ProviderSettingsSectionDef[];

export const providerSettingsSectionsByProvider = {
    claude: claudeSettingsSections,
    codex: codexSettingsSections,
    opencode: opencodeSettingsSections,
    gemini: noopSettingsSections,
    kiro: noopSettingsSections,
} as const;

export type ProviderSettingsSectionsByProvider = typeof providerSettingsSectionsByProvider;

export function getProviderSettingsSections(providerId: keyof ProviderSettingsSectionsByProvider): readonly ProviderSettingsSectionDef[] {
    return providerSettingsSectionsByProvider[providerId];
}
