import {
    buildClaudeRemoteOutgoingMessageMetaExtras,
    CLAUDE_REMOTE_PROVIDER_FIELDS,
    MAX_CLAUDE_REMOTE_IDLE_RECLAIM_TIMEOUT_MINUTES,
} from '@happier-dev/agents';

import type { ProviderSettingEnumOption, ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';

const responseLocationOptions = [
    {
        id: 'app_and_terminal',
        title: { key: 'settingsProviders.plugins.claude.responseLocationOptions.app_and_terminal.title' },
        subtitle: { key: 'settingsProviders.plugins.claude.responseLocationOptions.app_and_terminal.subtitle' },
    },
    {
        id: 'app_only',
        title: { key: 'settingsProviders.plugins.claude.responseLocationOptions.app_only.title' },
        subtitle: { key: 'settingsProviders.plugins.claude.responseLocationOptions.app_only.subtitle' },
    },
    {
        id: 'terminal_only',
        title: { key: 'settingsProviders.plugins.claude.responseLocationOptions.terminal_only.title' },
        subtitle: { key: 'settingsProviders.plugins.claude.responseLocationOptions.terminal_only.subtitle' },
    },
] as const satisfies readonly ProviderSettingEnumOption[];

export const CLAUDE_PROVIDER_SETTINGS_PLUGIN: ProviderSettingsPlugin = {
    providerId: 'claude',
    title: { key: 'settingsProviders.plugins.claude.title' },
    icon: { ionName: 'sparkles-outline', color: { kind: 'theme', token: 'orange' } },
    settings: CLAUDE_REMOTE_PROVIDER_FIELDS,
    subagentSettingsSections: [
        {
            id: 'claudeTeams',
            title: { key: 'subAgentGuidance.settings.providers.claude.title' },
            footer: { key: 'subAgentGuidance.settings.providers.claude.footer' },
            items: [
                {
                    id: 'claudeTeamsProviderSettings',
                    title: { key: 'subAgentGuidance.settings.providers.claude.openTitle' },
                    subtitle: { key: 'subAgentGuidance.settings.providers.claude.openSubtitle' },
                    route: '/settings/providers/claude',
                    iconIonName: 'sparkles-outline',
                },
            ],
        },
    ],
    uiSections: [
        {
            id: 'claudeModelDiscovery',
            title: { key: 'settingsProviders.plugins.claude.sections.claudeModelDiscovery.title' },
            footer: { key: 'settingsProviders.plugins.claude.sections.claudeModelDiscovery.footer' },
            fields: [
                {
                    key: 'claudeDynamicModelProbeEnabled',
                    kind: 'boolean',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeDynamicModelProbeEnabled.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeDynamicModelProbeEnabled.subtitle' },
                },
            ],
        },
        {
            id: 'claudeUnifiedTerminal',
            featureId: 'providers.claude.unifiedTerminal',
            title: { key: 'settingsProviders.plugins.claude.sections.claudeUnifiedTerminal.title' },
            footer: { key: 'settingsProviders.plugins.claude.sections.claudeUnifiedTerminal.footer' },
            fields: [
                {
                    key: 'claudeUnifiedTerminalEnabled',
                    kind: 'boolean',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalEnabled.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalEnabled.subtitle' },
                },
                {
                    key: 'claudeUnifiedTerminalQuestionResponseLocation',
                    kind: 'enum',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalQuestionResponseLocation.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalQuestionResponseLocation.subtitle' },
                    enumOptions: responseLocationOptions,
                },
                {
                    key: 'claudeUnifiedTerminalPermissionResponseLocation',
                    kind: 'enum',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalPermissionResponseLocation.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalPermissionResponseLocation.subtitle' },
                    enumOptions: responseLocationOptions,
                },
                {
                    key: 'claudeUnifiedTerminalHost',
                    kind: 'enum',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.subtitle' },
                    enumOptions: [
                        {
                            id: 'auto',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.auto.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.auto.subtitle' },
                        },
                        {
                            id: 'tmux',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.tmux.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.tmux.subtitle' },
                        },
                        {
                            id: 'zellij',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.zellij.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.zellij.subtitle' },
                        },
                    ],
                },
                {
                    key: 'claudeUnifiedTerminalResumeChoice',
                    kind: 'enum',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.subtitle' },
                    enumOptions: [
                        {
                            id: 'ask_every_time',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.ask_every_time.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.ask_every_time.subtitle' },
                        },
                        {
                            id: 'resume_from_summary',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.resume_from_summary.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.resume_from_summary.subtitle' },
                        },
                        {
                            id: 'resume_full_session',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.resume_full_session.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalResumeChoice.options.resume_full_session.subtitle' },
                        },
                    ],
                },
                {
                    key: 'claudeUnifiedTerminalWorkspaceTrust',
                    kind: 'enum',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalWorkspaceTrust.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalWorkspaceTrust.subtitle' },
                    enumOptions: [
                        {
                            id: 'ask_every_time',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalWorkspaceTrust.options.ask_every_time.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalWorkspaceTrust.options.ask_every_time.subtitle' },
                        },
                        {
                            id: 'always_trust_happier_workspaces',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalWorkspaceTrust.options.always_trust_happier_workspaces.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalWorkspaceTrust.options.always_trust_happier_workspaces.subtitle' },
                        },
                        {
                            id: 'always_reject_happier_workspaces',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalWorkspaceTrust.options.always_reject_happier_workspaces.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalWorkspaceTrust.options.always_reject_happier_workspaces.subtitle' },
                        },
                    ],
                },
            ],
        },
        {
            id: 'claudeCodeExperiments',
            title: { key: 'settingsProviders.plugins.claude.sections.claudeCodeExperiments.title' },
            footer: { key: 'settingsProviders.plugins.claude.sections.claudeCodeExperiments.footer' },
            fields: [
                {
                    key: 'claudeCodeIncludeInNativeHistory',
                    kind: 'boolean',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeCodeIncludeInNativeHistory.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeCodeIncludeInNativeHistory.subtitle' },
                },
                {
                    key: 'claudeCodeExperimentalAgentTeamsEnabled',
                    kind: 'boolean',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeCodeExperimentalAgentTeamsEnabled.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeCodeExperimentalAgentTeamsEnabled.subtitle' },
                },
            ],
        },
        {
            id: 'claudeIdleReclaim',
            title: { key: 'settingsProviders.plugins.claude.sections.claudeIdleReclaim.title' },
            footer: { key: 'settingsProviders.plugins.claude.sections.claudeIdleReclaim.footer' },
            fields: [
                {
                    key: 'claudeRemoteIdleReclaimEnabled',
                    kind: 'boolean',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteIdleReclaimEnabled.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteIdleReclaimEnabled.subtitle' },
                },
                {
                    key: 'claudeRemoteIdleReclaimTimeoutMinutes',
                    kind: 'number',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteIdleReclaimTimeoutMinutes.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteIdleReclaimTimeoutMinutes.subtitle' },
                    numberSpec: { min: 1, max: MAX_CLAUDE_REMOTE_IDLE_RECLAIM_TIMEOUT_MINUTES, step: 1 },
                },
            ],
        },
        {
            id: 'claudeRemoteSdk',
            title: { key: 'settingsProviders.plugins.claude.sections.claudeRemoteSdk.title' },
            footer: { key: 'settingsProviders.plugins.claude.sections.claudeRemoteSdk.footer' },
            fields: [
                {
                    key: 'claudeRemoteAgentSdkEnabled',
                    kind: 'boolean',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteAgentSdkEnabled.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteAgentSdkEnabled.subtitle' },
                },
                {
                    key: 'claudeRemoteDebugEnabled',
                    kind: 'boolean',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteDebugEnabled.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteDebugEnabled.subtitle' },
                },
                {
                    key: 'claudeRemoteVerboseEnabled',
                    kind: 'boolean',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteVerboseEnabled.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteVerboseEnabled.subtitle' },
                },
                {
                    key: 'claudeRemoteDebugCategories',
                    kind: 'multiEnum',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.subtitle' },
                    enumOptions: [
                        {
                            id: 'api',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.api.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.api.subtitle' },
                        },
                        {
                            id: 'mcp',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.mcp.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.mcp.subtitle' },
                        },
                        {
                            id: 'hooks',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.hooks.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.hooks.subtitle' },
                        },
                        {
                            id: 'file',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.file.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.file.subtitle' },
                        },
                        {
                            id: '1p',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.1p.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.1p.subtitle' },
                        },
                    ],
                },
                {
                    key: 'claudeRemoteSettingSourcesV2',
                    kind: 'multiEnum',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.subtitle' },
                    enumOptions: [
                        {
                            id: 'user',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.user.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.user.subtitle' },
                        },
                        {
                            id: 'project',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.project.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.project.subtitle' },
                        },
                        {
                            id: 'local',
                            title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.local.title' },
                            subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.local.subtitle' },
                        },
                    ],
                },
                {
                    key: 'claudeLocalPermissionBridgeEnabled',
                    kind: 'boolean',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeLocalPermissionBridgeEnabled.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeLocalPermissionBridgeEnabled.subtitle' },
                },
                {
                    key: 'claudeLocalPermissionBridgeWaitIndefinitely',
                    kind: 'boolean',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeLocalPermissionBridgeWaitIndefinitely.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeLocalPermissionBridgeWaitIndefinitely.subtitle' },
                },
                {
                    key: 'claudeLocalPermissionBridgeTimeoutSeconds',
                    kind: 'number',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeLocalPermissionBridgeTimeoutSeconds.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeLocalPermissionBridgeTimeoutSeconds.subtitle' },
                    numberSpec: {
                        min: 1,
                        step: 1,
                        placeholder: '600',
                    },
                },
                {
                    key: 'claudeRemoteEnableFileCheckpointing',
                    kind: 'boolean',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteEnableFileCheckpointing.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteEnableFileCheckpointing.subtitle' },
                },
                {
                    key: 'claudeRemoteMaxThinkingTokens',
                    kind: 'number',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteMaxThinkingTokens.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteMaxThinkingTokens.subtitle' },
                    numberSpec: {
                        min: 1,
                        step: 1,
                        placeholder: { key: 'common.default' },
                    },
                },
                {
                    key: 'claudeRemoteDisableTodos',
                    kind: 'boolean',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteDisableTodos.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteDisableTodos.subtitle' },
                },
                {
                    key: 'claudeRemoteStrictMcpServerConfig',
                    kind: 'boolean',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteStrictMcpServerConfig.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteStrictMcpServerConfig.subtitle' },
                },
                {
                    key: 'claudeRemoteAdvancedOptionsJson',
                    kind: 'json',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteAdvancedOptionsJson.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteAdvancedOptionsJson.subtitle' },
                },
            ],
        },
    ],
    buildOutgoingMessageMetaExtras: ({ settings }) => {
        return buildClaudeRemoteOutgoingMessageMetaExtras(settings);
    },
};
