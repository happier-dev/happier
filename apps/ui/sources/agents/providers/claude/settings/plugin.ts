import {
    buildClaudeRemoteOutgoingMessageMetaExtras,
    CLAUDE_REMOTE_PROVIDER_FIELDS,
} from '@happier-dev/agents';

import type { ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';

export const CLAUDE_PROVIDER_SETTINGS_PLUGIN: ProviderSettingsPlugin = {
    providerId: 'claude',
    title: { key: 'settingsProviders.plugins.claude.title' },
    icon: { ionName: 'sparkles-outline', color: '#FF9500' },
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
                    route: '/(app)/settings/providers/claude',
                    iconIonName: 'sparkles-outline',
                },
            ],
        },
    ],
    uiSections: [
        {
            id: 'claudeCodeExperiments',
            title: { key: 'settingsProviders.plugins.claude.sections.claudeCodeExperiments.title' },
            footer: { key: 'settingsProviders.plugins.claude.sections.claudeCodeExperiments.footer' },
            fields: [
                {
                    key: 'claudeCodeExperimentalAgentTeamsEnabled',
                    kind: 'boolean',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeCodeExperimentalAgentTeamsEnabled.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeCodeExperimentalAgentTeamsEnabled.subtitle' },
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
                    key: 'claudeRemoteIncludePartialMessages',
                    kind: 'boolean',
                    title: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteIncludePartialMessages.title' },
                    subtitle: { key: 'settingsProviders.plugins.claude.fields.claudeRemoteIncludePartialMessages.subtitle' },
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
                        step: 30,
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
                        step: 100,
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
