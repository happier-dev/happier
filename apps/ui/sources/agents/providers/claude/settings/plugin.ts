import * as z from 'zod';

import type { ProviderSettingsPlugin } from '@/agents/providers/_shared/providerSettingsPlugin';

const MAX_ADVANCED_OPTIONS_JSON_CHARS = 16_384;

function isValidAdvancedOptionsJson(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed) return true;
    if (trimmed.length > MAX_ADVANCED_OPTIONS_JSON_CHARS) return false;
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
    } catch {
        return false;
    }
}

function normalizeAdvancedOptionsJson(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!trimmed) return '';
    if (!isValidAdvancedOptionsJson(trimmed)) return '';
    const parsed = JSON.parse(trimmed) as unknown;
    const normalized = JSON.stringify(parsed);
    return normalized.length <= MAX_ADVANCED_OPTIONS_JSON_CHARS ? normalized : '';
}

const shape = {
    claudeRemoteAgentSdkEnabled: z.boolean(),
    claudeRemoteSettingSources: z.enum(['project', 'user_project', 'none']),
    claudeRemoteIncludePartialMessages: z.boolean(),
    claudeRemoteEnableFileCheckpointing: z.boolean(),
    claudeRemoteMaxThinkingTokens: z.number().int().positive().nullable(),
    claudeRemoteDisableTodos: z.boolean(),
    claudeRemoteStrictMcpServerConfig: z.boolean(),
    claudeRemoteAdvancedOptionsJson: z.string().refine(isValidAdvancedOptionsJson, {
        message: 'Must be empty or a valid JSON object string',
    }),
} as const;

const defaults: Record<keyof typeof shape, unknown> = {
    claudeRemoteAgentSdkEnabled: false,
    claudeRemoteSettingSources: 'project',
    claudeRemoteIncludePartialMessages: false,
    claudeRemoteEnableFileCheckpointing: false,
    claudeRemoteMaxThinkingTokens: null,
    claudeRemoteDisableTodos: false,
    claudeRemoteStrictMcpServerConfig: false,
    claudeRemoteAdvancedOptionsJson: '',
};

export const CLAUDE_PROVIDER_SETTINGS_PLUGIN = {
    providerId: 'claude',
    title: 'Claude (remote)',
    icon: { ionName: 'sparkles-outline', color: '#FF9500' },
    settingsShape: shape,
    settingsDefaults: defaults,
    uiSections: [
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
                    key: 'claudeRemoteSettingSources',
                    kind: 'enum',
                    title: 'Setting sources',
                    subtitle: 'Controls which Claude settings are loaded.',
                    enumOptions: [
                        {
                            id: 'project',
                            title: 'Project only',
                            subtitle: 'Loads repo settings (e.g. CLAUDE.md) for predictability.',
                        },
                        {
                            id: 'user_project',
                            title: 'User + Project',
                            subtitle: 'Closer to local Claude behavior; may include user-global config.',
                        },
                        {
                            id: 'none',
                            title: 'None',
                            subtitle: 'Most deterministic; ignores CLAUDE.md and user config.',
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
    ],
    buildOutgoingMessageMetaExtras: ({ settings }) => {
        return {
            claudeRemoteAgentSdkEnabled: Boolean(settings.claudeRemoteAgentSdkEnabled),
            claudeRemoteSettingSources: typeof settings.claudeRemoteSettingSources === 'string' ? settings.claudeRemoteSettingSources : 'project',
            claudeRemoteIncludePartialMessages: Boolean(settings.claudeRemoteIncludePartialMessages),
            claudeRemoteEnableFileCheckpointing: Boolean(settings.claudeRemoteEnableFileCheckpointing),
            claudeRemoteMaxThinkingTokens:
                typeof settings.claudeRemoteMaxThinkingTokens === 'number' ? settings.claudeRemoteMaxThinkingTokens : null,
            claudeRemoteDisableTodos: Boolean(settings.claudeRemoteDisableTodos),
            claudeRemoteStrictMcpServerConfig: Boolean(settings.claudeRemoteStrictMcpServerConfig),
            claudeRemoteAdvancedOptionsJson: normalizeAdvancedOptionsJson(settings.claudeRemoteAdvancedOptionsJson),
        };
    },
} as const satisfies ProviderSettingsPlugin;
