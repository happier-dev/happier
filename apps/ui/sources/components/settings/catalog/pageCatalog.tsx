import * as React from 'react';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';

import type { SettingsPageNode } from './types';
import { SETTINGS_ROUTES } from './routes';
import { Icon } from '@/components/ui/icons/Icon';

const Ionicons = SafeIonicons;

export const SETTINGS_PAGE_CATALOG: readonly SettingsPageNode[] = [
    {
        id: 'settings',
        // "Overview", not "Settings": this row's page is the whole menu plus profile and
        // pairing, so naming it "Settings" inside the settings rail promises a home it isn't.
        titleKey: 'settings.overview',
        route: SETTINGS_ROUTES.general,
        keywords: ['settings', 'home', 'overview'],
        icon: ({ theme }) => <Icon name="sliders-horizontal" size={16} color={theme.colors.text.secondary} />,
        children: [
            {
                id: 'groupProfileAndAccount',
                titleKey: 'settings.profileAndAccount',
                keywords: ['account', 'profile', 'billing', 'plan', 'usage'],
                icon: ({ theme }) => <Icon name="user-circle" size={16} color={theme.colors.text.secondary} />,
                children: [
                    {
                        id: 'account',
                        titleKey: 'settings.account',
                        subtitleKey: 'settings.accountSubtitle',
                        route: SETTINGS_ROUTES.account,
                        keywords: ['account', 'profile', 'billing'],
                        icon: ({ theme }) => <Icon name="user-circle" size={16} color={theme.colors.text.secondary} />,
                        children: [
                            {
                                id: 'apiTokens',
                                titleKey: 'settingsApiTokens.title',
                                subtitleKey: 'settingsApiTokens.entrySubtitle',
                                route: SETTINGS_ROUTES.apiTokens,
                                keywords: ['api token', 'personal access token', 'pat', 'automation', 'cli', 'sdk'],
                                icon: ({ theme }) => <Icon name="key" size={16} color={theme.colors.text.secondary} />,
                            },
                        ],
                    },
                    {
                        id: 'secrets',
                        titleKey: 'settings.secrets',
                        subtitleKey: 'settings.secretsSubtitle',
                        route: SETTINGS_ROUTES.secrets,
                        keywords: ['secrets', 'keys', 'env', 'tokens'],
                        gate: { requiresProfiles: true },
                        icon: ({ theme }) => <Icon name="key" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'usage',
                        titleKey: 'settings.usage',
                        subtitleKey: 'settings.usageSubtitle',
                        route: SETTINGS_ROUTES.usage,
                        keywords: ['usage', 'billing', 'limits', 'quota'],
                        gate: { featureId: 'usage.reporting' },
                        icon: ({ theme }) => <Icon name="chart-line" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'machines',
                        titleKey: 'settings.machines',
                        route: SETTINGS_ROUTES.machines,
                        keywords: ['machines', 'devices', 'computer'],
                        icon: ({ theme }) => <Icon name="desktop" size={16} color={theme.colors.text.secondary} />,
                        children: [
                            {
                                id: 'machinesAdd',
                                titleKey: 'settings.machineSetupSshMachineTitle',
                                subtitleKey: 'settings.machineSetupSshMachineSubtitle',
                                route: SETTINGS_ROUTES.machinesAdd,
                                keywords: ['add', 'machine', 'ssh'],
                                icon: ({ theme }) => <Icon name="plus-circle" size={16} color={theme.colors.text.secondary} />,
                            },
                            {
                                id: 'machinesThisComputer',
                                titleKey: 'settings.machineSetupCurrentMachineTitle',
                                subtitleKey: 'settings.machineSetupCurrentMachineSubtitle',
                                route: SETTINGS_ROUTES.machinesThisComputer,
                                keywords: ['this computer', 'local', 'device'],
                                icon: ({ theme }) => <Icon name="laptop" size={16} color={theme.colors.text.secondary} />,
                            },
                        ],
                    },
                    {
                        id: 'remoteHosts',
                        titleKey: 'settings.remoteHostsTitle',
                        route: SETTINGS_ROUTES.remoteHosts,
                        keywords: ['remote', 'host', 'hosts', 'ssh', 'server', 'machines'],
                        gate: { featureId: 'remoteHosts.management', requiresTauriDesktop: true },
                        icon: ({ theme }) => <Icon name="hard-drives" size={16} color={theme.colors.text.secondary} />,
                    },
                ],
            },
            {
                id: 'groupGeneral',
                titleKey: 'settings.general',
                keywords: ['general', 'appearance', 'language', 'experiments'],
                icon: ({ theme }) => <Icon name="sliders-horizontal" size={16} color={theme.colors.text.secondary} />,
                children: [
                    {
                        id: 'appearance',
                        titleKey: 'settings.appearance',
                        subtitleKey: 'settings.appearanceSubtitle',
                        route: SETTINGS_ROUTES.appearance,
                        keywords: ['appearance', 'theme', 'font', 'ui', 'sidebar'],
                        icon: ({ theme }) => <Icon name="palette" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'keyboard',
                        titleKey: 'settingsKeyboard.title',
                        subtitleKey: 'settingsKeyboard.entrySubtitle',
                        route: SETTINGS_ROUTES.keyboard,
                        keywords: ['keyboard', 'shortcut', 'shortcuts', 'hotkeys', 'commands'],
                        icon: ({ theme }) => <Icon name="squares-four" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'pets',
                        titleKey: 'settings.pets',
                        subtitleKey: 'settings.petsSubtitle',
                        route: SETTINGS_ROUTES.pets,
                        keywords: ['pets', 'blink', 'companion', 'codex'],
                        gate: { featureId: 'pets.companion' },
                        icon: ({ theme }) => <Icon name="paw-print" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'language',
                        titleKey: 'settingsLanguage.title',
                        route: SETTINGS_ROUTES.language,
                        keywords: ['language', 'locale', 'translation'],
                        icon: ({ theme }) => <Icon name="translate" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'features',
                        titleKey: 'settings.featuresTitle',
                        subtitleKey: 'settings.featuresSubtitle',
                        route: SETTINGS_ROUTES.features,
                        keywords: ['features', 'experiments', 'beta'],
                        icon: ({ theme }) => <Icon name="flask" size={16} color={theme.colors.text.secondary} />,
                    },
                ],
            },
            {
                id: 'groupAiAndAgents',
                titleKey: 'settings.aiAndAgents',
                keywords: ['agents', 'providers', 'mcp', 'prompts', 'voice'],
                icon: ({ theme }) => <Icon name="sparkle" size={16} color={theme.colors.text.secondary} />,
                children: [
                    {
                        id: 'agents',
                        titleKey: 'settingsAgents.title',
                        subtitleKey: 'settingsAgents.entrySubtitle',
                        route: SETTINGS_ROUTES.agents,
                        keywords: ['providers', 'agents', 'models', 'llm'],
                        icon: ({ theme }) => <Icon name="sparkle" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'providers',
                        titleKey: 'settingsProviders.title',
                        subtitleKey: 'settingsProviders.entrySubtitle',
                        route: SETTINGS_ROUTES.providers,
                        keywords: ['providers', 'models', 'openrouter', 'ollama', 'lm studio'],
                        gate: { featureId: 'providers' },
                        icon: ({ theme }) => <Icon name="cube" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'subAgent',
                        titleKey: 'subAgentGuidance.settings.groupTitle',
                        subtitleKey: 'settingsSession.subAgentGuidanceEntry.openSubtitle',
                        route: SETTINGS_ROUTES.subAgent,
                        keywords: ['subagents', 'agents', 'delegation', 'rules'],
                        icon: ({ theme }) => <Icon name="graph" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'profiles',
                        titleKey: 'settings.profiles',
                        subtitleKey: 'settings.profilesSubtitle',
                        route: SETTINGS_ROUTES.profiles,
                        gate: { requiresProfiles: true },
                        keywords: ['profiles', 'personas'],
                        icon: ({ theme }) => <Icon name="person" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'connectedServices',
                        titleKey: 'settings.connectedServices',
                        subtitleKey: 'settings.connectedServicesSubtitle',
                        route: SETTINGS_ROUTES.connectedServices,
                        keywords: ['connected services', 'oauth', 'accounts'],
                        icon: ({ theme }) => <Icon name="key" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'mcp',
                        titleKey: 'settings.mcpServers',
                        subtitleKey: 'settings.mcpServersSubtitle',
                        route: SETTINGS_ROUTES.mcp,
                        keywords: ['mcp', 'tools', 'servers', 'plugins'],
                        gate: { featureId: 'mcp.servers' },
                        icon: ({ theme }) => <Icon name="puzzle-piece" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'plugins',
                        titleKey: 'settingsPlugins.title',
                        subtitleKey: 'settingsPlugins.subtitle',
                        route: SETTINGS_ROUTES.plugins,
                        keywords: ['plugins', 'marketplace', 'catalog', 'descriptor', 'discovery'],
                        icon: ({ theme }) => <Icon name="grid-four" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'prompts',
                        titleKey: 'settings.prompts',
                        subtitleKey: 'settings.promptsSubtitle',
                        route: SETTINGS_ROUTES.prompts,
                        keywords: ['prompts', 'templates', 'library'],
                        gate: { featureId: 'prompts.library' },
                        icon: ({ theme }) => <Icon name="books" size={16} color={theme.colors.text.secondary} />,
                        children: [
                            { id: 'promptsTemplates', titleKey: 'promptLibrary.templates', route: SETTINGS_ROUTES.promptsTemplates, keywords: ['templates'], icon: ({ theme }) => <Icon name="lightning" size={16} color={theme.colors.text.secondary} /> },
                            { id: 'promptsFolders', titleKey: 'promptLibrary.folders', route: SETTINGS_ROUTES.promptsFolders, keywords: ['folders'], icon: ({ theme }) => <Icon name="folder" size={16} color={theme.colors.text.secondary} /> },
                            { id: 'promptsStacks', titleKey: 'promptLibrary.stacks', route: SETTINGS_ROUTES.promptsStacks, keywords: ['stacks'], icon: ({ theme }) => <Icon name="stack-simple" size={16} color={theme.colors.text.secondary} /> },
                            { id: 'promptsRegistries', titleKey: 'promptLibrary.registries', route: SETTINGS_ROUTES.promptsRegistries, keywords: ['registries'], icon: ({ theme }) => <Icon name="globe" size={16} color={theme.colors.text.secondary} /> },
                            { id: 'promptsLibrary', titleKey: 'promptLibrary.library', route: SETTINGS_ROUTES.promptsLibrary, keywords: ['library'], icon: ({ theme }) => <Icon name="books" size={16} color={theme.colors.text.secondary} /> },
                            { id: 'promptsAssets', titleKey: 'promptLibrary.externalAssets', route: SETTINGS_ROUTES.promptsAssets, keywords: ['assets', 'external'], icon: ({ theme }) => <Icon name="cloud" size={16} color={theme.colors.text.secondary} /> },
                        ],
                    },
                    {
                        id: 'voice',
                        titleKey: 'settings.voiceAssistant',
                        subtitleKey: 'settings.voiceAssistantSubtitle',
                        route: SETTINGS_ROUTES.voice,
                        gate: { featureId: 'voice' },
                        keywords: ['voice', 'assistant', 'mic'],
                        icon: ({ theme }) => <Icon name="microphone" size={16} color={theme.colors.text.secondary} />,
                        children: [
                            { id: 'voiceConversations', titleKey: 'settingsVoice.intents.conversations.title', subtitleKey: 'settingsVoice.intents.conversations.subtitle', route: SETTINGS_ROUTES.voiceConversations, keywords: ['voice', 'conversation', 'realtime', 'provider'], icon: ({ theme }) => <Icon name="chat-circle" size={16} color={theme.colors.text.secondary} /> },
                            { id: 'voiceDictation', titleKey: 'settingsVoice.intents.dictation.title', subtitleKey: 'settingsVoice.intents.dictation.subtitle', route: SETTINGS_ROUTES.voiceDictation, keywords: ['voice', 'dictation', 'speech', 'transcription'], icon: ({ theme }) => <Icon name="microphone" size={16} color={theme.colors.text.secondary} /> },
                            { id: 'voicePrivacy', titleKey: 'settingsVoice.intents.privacy.title', subtitleKey: 'settingsVoice.intents.privacy.subtitle', route: SETTINGS_ROUTES.voicePrivacy, keywords: ['voice', 'privacy', 'history', 'retention'], icon: ({ theme }) => <Icon name="shield-check" size={16} color={theme.colors.text.secondary} /> },
                            { id: 'voiceAdvanced', titleKey: 'settingsVoice.intents.advanced.title', subtitleKey: 'settingsVoice.intents.advanced.subtitle', route: SETTINGS_ROUTES.voiceAdvanced, keywords: ['voice', 'advanced', 'machine', 'diagnostics'], icon: ({ theme }) => <Icon name="sliders-horizontal" size={16} color={theme.colors.text.secondary} /> },
                        ],
                    },
                    {
                        id: 'memory',
                        titleKey: 'settings.memorySearch',
                        subtitleKey: 'settings.memorySearchSubtitle',
                        route: SETTINGS_ROUTES.memory,
                        gate: { featureId: 'memory.search' },
                        keywords: ['memory', 'search', 'index'],
                        icon: ({ theme }) => <Icon name="magnifying-glass" size={16} color={theme.colors.text.secondary} />,
                    },
                ],
            },
            {
                id: 'groupSessionsBehavior',
                titleKey: 'settings.sessionsBehavior',
                keywords: ['sessions', 'transcript', 'permissions', 'actions'],
                icon: ({ theme }) => <Icon name="terminal" size={16} color={theme.colors.text.secondary} />,
                children: [
                    {
                        id: 'session',
                        titleKey: 'settings.sessions',
                        route: SETTINGS_ROUTES.session,
                        keywords: ['session', 'terminal', 'tmux'],
                        icon: ({ theme }) => <Icon name="terminal" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'externalSessions',
                        titleKey: 'externalSessions.settingsTitle',
                        subtitleKey: 'externalSessions.settingsEntrySubtitle',
                        route: SETTINGS_ROUTES.externalSessions,
                        keywords: ['external sessions', 'background follow', 'hooks'],
                        gate: { featureId: 'sessions.direct' },
                        icon: ({ theme }) => <Icon name="link" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'actions',
                        titleKey: 'common.actions',
                        subtitleKey: 'settings.actionsSubtitle',
                        route: SETTINGS_ROUTES.actions,
                        keywords: ['actions', 'approvals', 'shortcuts'],
                        icon: ({ theme }) => <Icon name="lightning" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'transcript',
                        titleKey: 'settings.transcript',
                        subtitleKey: 'settings.transcriptSubtitle',
                        route: SETTINGS_ROUTES.transcript,
                        keywords: ['transcript', 'chat', 'layout'],
                        icon: ({ theme }) => <Icon name="chats-circle" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'permissions',
                        titleKey: 'settings.permissions',
                        subtitleKey: 'settings.permissionsSubtitle',
                        route: SETTINGS_ROUTES.permissions,
                        keywords: ['permissions', 'approval', 'security'],
                        icon: ({ theme }) => <Icon name="shield" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'toolRendering',
                        titleKey: 'settingsSession.toolRendering.title',
                        route: SETTINGS_ROUTES.toolRendering,
                        keywords: ['tools', 'rendering'],
                        icon: ({ theme }) => <Icon name="wrench" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'handoff',
                        titleKey: 'settingsSession.handoff.title',
                        route: SETTINGS_ROUTES.handoff,
                        keywords: ['handoff', 'transfer'],
                        icon: ({ theme }) => <Icon name="arrows-left-right" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'runs',
                        titleKey: 'runs.title',
                        subtitleKey: 'settings.executionRunsSubtitle',
                        route: SETTINGS_ROUTES.runs,
                        keywords: ['runs', 'execution'],
                        gate: { featureId: 'execution.runs' },
                        icon: ({ theme }) => <Icon name="play" size={16} color={theme.colors.text.secondary} />,
                    },
                ],
            },
            {
                id: 'groupFilesAndSourceControl',
                titleKey: 'settings.filesAndSourceControl',
                keywords: ['files', 'source control', 'attachments'],
                icon: ({ theme }) => <Icon name="folder" size={16} color={theme.colors.text.secondary} />,
                children: [
                    {
                        id: 'sourceControl',
                        titleKey: 'settings.filesSourceControl',
                        subtitleKey: 'settings.filesSourceControlSubtitle',
                        route: SETTINGS_ROUTES.sourceControl,
                        gate: { featureId: 'scm.writeOperations' },
                        keywords: ['git', 'scm', 'source control'],
                        icon: ({ theme }) => <Icon name="git-branch" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'attachments',
                        titleKey: 'settings.attachments',
                        subtitleKey: 'settings.attachmentsSubtitle',
                        route: SETTINGS_ROUTES.attachments,
                        gate: { featureId: 'attachments.uploads' },
                        keywords: ['attachments', 'uploads', 'files'],
                        icon: ({ theme }) => <Icon name="paperclip" size={16} color={theme.colors.text.secondary} />,
                    },
                ],
            },
            {
                id: 'groupSystem',
                titleKey: 'settings.system',
                keywords: ['system', 'servers', 'status', 'notifications'],
                icon: ({ theme }) => <Icon name="hard-drives" size={16} color={theme.colors.text.secondary} />,
                children: [
                    {
                        id: 'servers',
                        titleKey: 'settings.servers',
                        subtitleKey: 'settings.serversSubtitle',
                        route: SETTINGS_ROUTES.servers,
                        keywords: ['servers', 'relay'],
                        icon: ({ theme }) => <Icon name="hard-drives" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'systemStatus',
                        titleKey: 'settings.systemStatus',
                        subtitleKey: 'settings.systemStatusSubtitle',
                        route: SETTINGS_ROUTES.systemStatus,
                        keywords: ['system status', 'health', 'diagnostics'],
                        icon: ({ theme }) => <Icon name="pulse" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'notifications',
                        titleKey: 'settings.notifications',
                        subtitleKey: 'settings.notificationsSubtitle',
                        route: SETTINGS_ROUTES.notifications,
                        keywords: ['notif', 'notification', 'notifications', 'push'],
                        icon: ({ theme }) => <Icon name="bell" size={16} color={theme.colors.text.secondary} />,
                        children: [
                            {
                                id: 'notificationsPush',
                                titleKey: 'settingsNotifications.push.title',
                                route: SETTINGS_ROUTES.notificationsPush,
                                keywords: ['push'],
                                icon: ({ theme }) => <Icon name="paper-plane" size={16} color={theme.colors.text.secondary} />,
                            },
                        ],
                    },
                    {
                        id: 'desktop',
                        titleKey: 'settingsDesktop.title',
                        subtitleKey: 'settingsDesktop.footer',
                        route: SETTINGS_ROUTES.desktop,
                        keywords: ['desktop', 'tauri', 'overlay', 'window'],
                        gate: { requiresTauriDesktop: true },
                        icon: ({ theme }) => <Icon name="desktop" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'diagnosis',
                        titleKey: 'diagnosis.title',
                        route: SETTINGS_ROUTES.diagnosis,
                        keywords: ['diagnosis', 'debug'],
                        icon: ({ theme }) => <Icon name="first-aid-kit" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'reportIssue',
                        titleKey: 'settings.reportIssue',
                        route: SETTINGS_ROUTES.reportIssue,
                        keywords: ['report issue', 'bug'],
                        icon: ({ theme }) => <Icon name="bug" size={16} color={theme.colors.text.secondary} />,
                    },
                ],
            },
        ],
    },
] as const;

export function flattenSettingsPageCatalog(nodes: readonly SettingsPageNode[]): SettingsPageNode[] {
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
