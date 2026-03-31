import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';

import type { SettingsPageNode } from './types';
import { SETTINGS_ROUTES_V1 } from './routes';

export const SETTINGS_PAGE_CATALOG_V1: readonly SettingsPageNode[] = [
    {
        id: 'groupProfileAndAccount',
        titleKey: 'settings.profileAndAccount',
        keywords: ['account', 'profile', 'billing', 'plan', 'usage'],
        icon: ({ theme }) => <Ionicons name="person-circle-outline" size={18} color={theme.colors.textSecondary} />,
        children: [
            {
                id: 'account',
                titleKey: 'settings.account',
                subtitleKey: 'settings.accountSubtitle',
                route: SETTINGS_ROUTES_V1.account,
                keywords: ['account', 'profile', 'billing'],
                icon: ({ theme }) => <Ionicons name="person-circle-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'secrets',
                titleKey: 'settings.secrets',
                subtitleKey: 'settings.secretsSubtitle',
                route: SETTINGS_ROUTES_V1.secrets,
                keywords: ['secrets', 'keys', 'env', 'tokens'],
                gate: { requiresProfiles: true },
                icon: ({ theme }) => <Ionicons name="key-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'usage',
                titleKey: 'settings.usage',
                subtitleKey: 'settings.usageSubtitle',
                route: SETTINGS_ROUTES_V1.usage,
                keywords: ['usage', 'billing', 'limits', 'quota'],
                gate: { featureId: 'usage.reporting' },
                icon: ({ theme }) => <Ionicons name="analytics-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'machines',
                titleKey: 'settings.machines',
                route: SETTINGS_ROUTES_V1.machines,
                keywords: ['machines', 'devices', 'computer'],
                icon: ({ theme }) => <Ionicons name="desktop-outline" size={18} color={theme.colors.textSecondary} />,
                children: [
                    {
                        id: 'machinesAdd',
                        titleKey: 'settings.machineSetupSshMachineTitle',
                        subtitleKey: 'settings.machineSetupSshMachineSubtitle',
                        route: SETTINGS_ROUTES_V1.machinesAdd,
                        keywords: ['add', 'machine', 'ssh'],
                        icon: ({ theme }) => <Ionicons name="add-circle-outline" size={18} color={theme.colors.textSecondary} />,
                    },
                    {
                        id: 'machinesThisComputer',
                        titleKey: 'settings.machineSetupCurrentMachineTitle',
                        subtitleKey: 'settings.machineSetupCurrentMachineSubtitle',
                        route: SETTINGS_ROUTES_V1.machinesThisComputer,
                        keywords: ['this computer', 'local', 'device'],
                        icon: ({ theme }) => <Ionicons name="laptop-outline" size={18} color={theme.colors.textSecondary} />,
                    },
                ],
            },
        ],
    },
    {
        id: 'groupGeneral',
        titleKey: 'settings.general',
        keywords: ['general', 'appearance', 'language', 'experiments'],
        icon: ({ theme }) => <Ionicons name="settings-outline" size={18} color={theme.colors.textSecondary} />,
        children: [
            {
                id: 'general',
                titleKey: 'settings.title',
                route: SETTINGS_ROUTES_V1.general,
                keywords: ['general', 'settings', 'home'],
                icon: ({ theme }) => <Ionicons name="settings-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'appearance',
                titleKey: 'settings.appearance',
                subtitleKey: 'settings.appearanceSubtitle',
                route: SETTINGS_ROUTES_V1.appearance,
                keywords: ['appearance', 'theme', 'font', 'ui'],
                icon: ({ theme }) => <Ionicons name="color-palette-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'language',
                titleKey: 'settingsLanguage.title',
                route: SETTINGS_ROUTES_V1.language,
                keywords: ['language', 'locale', 'translation'],
                icon: ({ theme }) => <Ionicons name="language-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'features',
                titleKey: 'settings.featuresTitle',
                subtitleKey: 'settings.featuresSubtitle',
                route: SETTINGS_ROUTES_V1.features,
                keywords: ['features', 'experiments', 'beta'],
                icon: ({ theme }) => <Ionicons name="flask-outline" size={18} color={theme.colors.textSecondary} />,
            },
        ],
    },
    {
        id: 'groupAiAndAgents',
        titleKey: 'settings.aiAndAgents',
        keywords: ['agents', 'providers', 'mcp', 'prompts', 'voice'],
        icon: ({ theme }) => <Ionicons name="sparkles-outline" size={18} color={theme.colors.textSecondary} />,
        children: [
            {
                id: 'providers',
                titleKey: 'settingsProviders.title',
                subtitleKey: 'settingsProviders.entrySubtitle',
                route: SETTINGS_ROUTES_V1.providers,
                keywords: ['providers', 'agents', 'models', 'llm'],
                icon: ({ theme }) => <Ionicons name="sparkles-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'subAgent',
                titleKey: 'subAgentGuidance.settings.groupTitle',
                subtitleKey: 'settingsSession.subAgentGuidanceEntry.openSubtitle',
                route: SETTINGS_ROUTES_V1.subAgent,
                keywords: ['subagents', 'agents', 'delegation', 'rules'],
                icon: ({ theme }) => <Ionicons name="git-network-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'profiles',
                titleKey: 'settings.profiles',
                subtitleKey: 'settings.profilesSubtitle',
                route: SETTINGS_ROUTES_V1.profiles,
                gate: { requiresProfiles: true },
                keywords: ['profiles', 'personas'],
                icon: ({ theme }) => <Ionicons name="person-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'connectedServices',
                titleKey: 'settings.connectedServices',
                subtitleKey: 'settings.connectedServicesSubtitle',
                route: SETTINGS_ROUTES_V1.connectedServices,
                gate: { featureId: 'connectedServices' },
                keywords: ['connected services', 'oauth', 'accounts'],
                icon: ({ theme }) => <Ionicons name="key-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'mcp',
                titleKey: 'settings.mcpServers',
                subtitleKey: 'settings.mcpServersSubtitle',
                route: SETTINGS_ROUTES_V1.mcp,
                keywords: ['mcp', 'tools', 'servers', 'plugins'],
                gate: { featureId: 'mcp.servers' },
                icon: ({ theme }) => <Ionicons name="extension-puzzle-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'prompts',
                titleKey: 'settings.prompts',
                subtitleKey: 'settings.promptsSubtitle',
                route: SETTINGS_ROUTES_V1.prompts,
                keywords: ['prompts', 'templates', 'library'],
                gate: { featureId: 'prompts.library' },
                icon: ({ theme }) => <Ionicons name="library-outline" size={18} color={theme.colors.textSecondary} />,
                children: [
                    { id: 'promptsTemplates', titleKey: 'promptLibrary.templates', route: SETTINGS_ROUTES_V1.promptsTemplates, keywords: ['templates'], icon: ({ theme }) => <Ionicons name="flash-outline" size={18} color={theme.colors.textSecondary} /> },
                    { id: 'promptsFolders', titleKey: 'promptLibrary.folders', route: SETTINGS_ROUTES_V1.promptsFolders, keywords: ['folders'], icon: ({ theme }) => <Ionicons name="folder-outline" size={18} color={theme.colors.textSecondary} /> },
                    { id: 'promptsStacks', titleKey: 'promptLibrary.stacks', route: SETTINGS_ROUTES_V1.promptsStacks, keywords: ['stacks'], icon: ({ theme }) => <Ionicons name="layers-outline" size={18} color={theme.colors.textSecondary} /> },
                    { id: 'promptsRegistries', titleKey: 'promptLibrary.registries', route: SETTINGS_ROUTES_V1.promptsRegistries, keywords: ['registries'], icon: ({ theme }) => <Ionicons name="globe-outline" size={18} color={theme.colors.textSecondary} /> },
                    { id: 'promptsLibrary', titleKey: 'promptLibrary.library', route: SETTINGS_ROUTES_V1.promptsLibrary, keywords: ['library'], icon: ({ theme }) => <Ionicons name="library-outline" size={18} color={theme.colors.textSecondary} /> },
                    { id: 'promptsAssets', titleKey: 'promptLibrary.externalAssets', route: SETTINGS_ROUTES_V1.promptsAssets, keywords: ['assets', 'external'], icon: ({ theme }) => <Ionicons name="cloud-outline" size={18} color={theme.colors.textSecondary} /> },
                ],
            },
            {
                id: 'voice',
                titleKey: 'settings.voiceAssistant',
                subtitleKey: 'settings.voiceAssistantSubtitle',
                route: SETTINGS_ROUTES_V1.voice,
                gate: { featureId: 'voice' },
                keywords: ['voice', 'assistant', 'mic'],
                icon: ({ theme }) => <Ionicons name="mic-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'memory',
                titleKey: 'settings.memorySearch',
                subtitleKey: 'settings.memorySearchSubtitle',
                route: SETTINGS_ROUTES_V1.memory,
                gate: { featureId: 'memory.search' },
                keywords: ['memory', 'search', 'index'],
                icon: ({ theme }) => <Ionicons name="search-outline" size={18} color={theme.colors.textSecondary} />,
            },
        ],
    },
    {
        id: 'groupSessionsBehavior',
        titleKey: 'settings.sessionsBehavior',
        keywords: ['sessions', 'transcript', 'permissions', 'actions'],
        icon: ({ theme }) => <Ionicons name="terminal-outline" size={18} color={theme.colors.textSecondary} />,
        children: [
            {
                id: 'session',
                titleKey: 'settings.sessions',
                route: SETTINGS_ROUTES_V1.session,
                keywords: ['session', 'terminal', 'tmux'],
                icon: ({ theme }) => <Ionicons name="terminal-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'actions',
                titleKey: 'common.actions',
                subtitleKey: 'settings.actionsSubtitle',
                route: SETTINGS_ROUTES_V1.actions,
                keywords: ['actions', 'approvals', 'shortcuts'],
                icon: ({ theme }) => <Ionicons name="flash-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'transcript',
                titleKey: 'settings.transcript',
                subtitleKey: 'settings.transcriptSubtitle',
                route: SETTINGS_ROUTES_V1.transcript,
                keywords: ['transcript', 'chat', 'layout'],
                icon: ({ theme }) => <Ionicons name="chatbubbles-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'permissions',
                titleKey: 'settings.permissions',
                subtitleKey: 'settings.permissionsSubtitle',
                route: SETTINGS_ROUTES_V1.permissions,
                keywords: ['permissions', 'approval', 'security'],
                icon: ({ theme }) => <Ionicons name="shield-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'toolRendering',
                titleKey: 'settingsSession.toolRendering.title',
                route: SETTINGS_ROUTES_V1.toolRendering,
                keywords: ['tools', 'rendering'],
                icon: ({ theme }) => <Ionicons name="construct-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'handoff',
                titleKey: 'settingsSession.handoff.title',
                route: SETTINGS_ROUTES_V1.handoff,
                keywords: ['handoff', 'transfer'],
                icon: ({ theme }) => <Ionicons name="swap-horizontal-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'runs',
                titleKey: 'runs.title',
                subtitleKey: 'settings.executionRunsSubtitle',
                route: SETTINGS_ROUTES_V1.runs,
                keywords: ['runs', 'execution'],
                gate: { featureId: 'execution.runs' },
                icon: ({ theme }) => <Ionicons name="play-outline" size={18} color={theme.colors.textSecondary} />,
            },
        ],
    },
    {
        id: 'groupFilesAndSourceControl',
        titleKey: 'settings.filesAndSourceControl',
        keywords: ['files', 'source control', 'attachments'],
        icon: ({ theme }) => <Ionicons name="folder-outline" size={18} color={theme.colors.textSecondary} />,
        children: [
            {
                id: 'sourceControl',
                titleKey: 'settings.filesSourceControl',
                subtitleKey: 'settings.filesSourceControlSubtitle',
                route: SETTINGS_ROUTES_V1.sourceControl,
                gate: { featureId: 'scm.writeOperations' },
                keywords: ['git', 'scm', 'source control'],
                icon: ({ theme }) => <Ionicons name="git-branch-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'attachments',
                titleKey: 'settings.attachments',
                subtitleKey: 'settings.attachmentsSubtitle',
                route: SETTINGS_ROUTES_V1.attachments,
                gate: { featureId: 'attachments.uploads' },
                keywords: ['attachments', 'uploads', 'files'],
                icon: ({ theme }) => <Ionicons name="attach-outline" size={18} color={theme.colors.textSecondary} />,
            },
        ],
    },
    {
        id: 'groupSystem',
        titleKey: 'settings.system',
        keywords: ['system', 'servers', 'status', 'notifications'],
        icon: ({ theme }) => <Ionicons name="server-outline" size={18} color={theme.colors.textSecondary} />,
        children: [
            {
                id: 'servers',
                titleKey: 'settings.servers',
                subtitleKey: 'settings.serversSubtitle',
                route: SETTINGS_ROUTES_V1.servers,
                keywords: ['servers', 'relay'],
                icon: ({ theme }) => <Ionicons name="server-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'systemStatus',
                titleKey: 'settings.systemStatus',
                subtitleKey: 'settings.systemStatusSubtitle',
                route: SETTINGS_ROUTES_V1.systemStatus,
                keywords: ['system status', 'health', 'diagnostics'],
                icon: ({ theme }) => <Ionicons name="pulse-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'notifications',
                titleKey: 'settings.notifications',
                subtitleKey: 'settings.notificationsSubtitle',
                route: SETTINGS_ROUTES_V1.notifications,
                keywords: ['notif', 'notification', 'notifications', 'push'],
                icon: ({ theme }) => <Ionicons name="notifications-outline" size={18} color={theme.colors.textSecondary} />,
                children: [
                    {
                        id: 'notificationsPush',
                        titleKey: 'settingsNotifications.push.title',
                        route: SETTINGS_ROUTES_V1.notificationsPush,
                        keywords: ['push'],
                        icon: ({ theme }) => <Ionicons name="paper-plane-outline" size={18} color={theme.colors.textSecondary} />,
                    },
                ],
            },
            {
                id: 'diagnosis',
                titleKey: 'diagnosis.title',
                route: SETTINGS_ROUTES_V1.diagnosis,
                keywords: ['diagnosis', 'debug'],
                icon: ({ theme }) => <Ionicons name="medkit-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'reportIssue',
                titleKey: 'settings.reportIssue',
                route: SETTINGS_ROUTES_V1.reportIssue,
                keywords: ['report issue', 'bug'],
                icon: ({ theme }) => <Ionicons name="bug-outline" size={18} color={theme.colors.textSecondary} />,
            },
        ],
    },
] as const;

export function flattenSettingsPageCatalogV1(nodes: readonly SettingsPageNode[]): SettingsPageNode[] {
    const out: SettingsPageNode[] = [];
    const visit = (items: readonly SettingsPageNode[]) => {
        for (const item of items) {
            out.push(item);
            if (item.children) {
                visit(item.children);
            }
        }
    };
    visit(nodes);
    return out;
}
