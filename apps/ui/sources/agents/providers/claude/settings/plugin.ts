import * as z from 'zod';

import {
    buildClaudeRemoteOutgoingMessageMetaExtras,
    buildClaudeRemoteProviderSettingsShape,
    CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS,
} from '@happier-dev/agents';

import type { ProviderSettingsPlugin } from '@/agents/providers/_shared/providerSettingsPlugin';

const shape = buildClaudeRemoteProviderSettingsShape(z);
const defaults: Record<keyof typeof shape, unknown> = CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS;

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
                    key: 'claudeLocalPermissionBridgeEnabled',
                    kind: 'boolean',
                    title: 'Experimental: local permission bridge',
                    subtitle:
                        'Forward Claude local-mode permission prompts to Happier so you can approve or deny from the app UI.',
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
    ],
    buildOutgoingMessageMetaExtras: ({ settings }) => {
        return buildClaudeRemoteOutgoingMessageMetaExtras(settings);
    },
} as const satisfies ProviderSettingsPlugin;
