import * as React from 'react';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';

import type { SettingsPageGate, SettingsPageNode } from './types';
import { SETTINGS_ROUTES } from './routes';
import { Icon } from '@/components/ui/icons/Icon';
import { PLUGINS_SURFACE_ICON } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { homeAdministrationSettingsEntryHref } from '@/components/settings/home/governance/homeAdministrationRoutes';

const Ionicons = SafeIonicons;

export const SETTINGS_PAGE_CATALOG: readonly SettingsPageNode[] = [
    {
        id: 'settings',
        // "Overview", not "Settings": this row's page is the whole menu plus profile and
        // pairing, so naming it "Settings" inside the settings rail promises a home it isn't.
        titleKey: 'settings.overview',
        route: SETTINGS_ROUTES.general,
        keywordsKey: 'settingsSearchKeywords.settings',
        icon: ({ theme }) => <Icon name="sliders-horizontal" size={16} color={theme.colors.text.secondary} />,
        children: [
            {
                id: 'groupProfileAndAccount',
                titleKey: 'settings.profileAndAccount',
                keywordsKey: 'settingsSearchKeywords.groupProfileAndAccount',
                icon: ({ theme }) => <Icon name="user-circle" size={16} color={theme.colors.text.secondary} />,
                children: [
                    {
                        id: 'account',
                        titleKey: 'settings.account',
                        subtitleKey: 'settings.accountSubtitle',
                        route: SETTINGS_ROUTES.account,
                        keywordsKey: 'settingsSearchKeywords.account',
                        icon: ({ theme }) => <Icon name="user-circle" size={16} color={theme.colors.text.secondary} />,
                        children: [
                            {
                                id: 'accountSecurity',
                                titleKey: 'settingsAccount.security',
                                route: SETTINGS_ROUTES.accountSecurity,
                                keywordsKey: 'settingsSearchKeywords.accountSecurity',
                                icon: ({ theme }) => <Icon name="key" size={16} color={theme.colors.text.secondary} />,
                                children: [
                            {
                                id: 'apiTokens',
                                titleKey: 'settingsApiTokens.title',
                                subtitleKey: 'settingsApiTokens.entrySubtitle',
                                route: SETTINGS_ROUTES.apiTokens,
                                keywordsKey: 'settingsSearchKeywords.apiTokens',
                                icon: ({ theme }) => <Icon name="key" size={16} color={theme.colors.text.secondary} />,
                            },
                                ],
                            },
                        ],
                    },
                    {
                        id: 'teams',
                        titleKey: 'teams.title',
                        subtitleKey: 'teams.entrySubtitle',
                        route: SETTINGS_ROUTES.teams,
                        keywordsKey: 'settingsSearchKeywords.teams',
                        icon: ({ theme }) => <Icon name="users" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'homeAdministration',
                        titleKey: 'homeGovernance.title',
                        route: homeAdministrationSettingsEntryHref(),
                        keywordsKey: 'settingsSearchKeywords.homeAdministration',
                        icon: ({ theme }) => <Icon name="house" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'secrets',
                        titleKey: 'settings.secrets',
                        subtitleKey: 'settings.secretsSubtitle',
                        route: SETTINGS_ROUTES.secrets,
                        keywordsKey: 'settingsSearchKeywords.secrets',
                        gate: { requiresProfiles: true },
                        icon: ({ theme }) => <Icon name="key" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'usage',
                        titleKey: 'settings.usage',
                        subtitleKey: 'settings.usageSubtitle',
                        route: SETTINGS_ROUTES.usage,
                        keywordsKey: 'settingsSearchKeywords.usage',
                        gate: { featureId: 'usage.reporting' },
                        icon: ({ theme }) => <Icon name="chart-line" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'machines',
                        titleKey: 'settings.machines',
                        route: SETTINGS_ROUTES.machines,
                        keywordsKey: 'settingsSearchKeywords.machines',
                        icon: ({ theme }) => <Icon name="desktop" size={16} color={theme.colors.text.secondary} />,
                        children: [
                            {
                                id: 'machinePoolsNew',
                                titleKey: 'machinePools.add',
                                subtitleKey: 'machinePools.benefit',
                                route: SETTINGS_ROUTES.machinePoolsNew,
                                keywordsKey: 'settingsSearchKeywords.machinePoolsNew',
                                icon: ({ theme }) => <Icon name="stack" size={16} color={theme.colors.text.secondary} />,
                            },
                            {
                                id: 'machinesAdd',
                                titleKey: 'settings.addMachine',
                                subtitleKey: 'settingsMachines.addPageDescription',
                                route: SETTINGS_ROUTES.machinesAdd,
                                keywordsKey: 'settingsSearchKeywords.machinesAdd',
                                icon: ({ theme }) => <Icon name="plus-circle" size={16} color={theme.colors.text.secondary} />,
                            },
                            {
                                id: 'machinesThisComputer',
                                titleKey: 'settings.machineSetupCurrentMachineTitle',
                                subtitleKey: 'settings.machineSetupCurrentMachineSubtitle',
                                route: SETTINGS_ROUTES.machinesThisComputer,
                                keywordsKey: 'settingsSearchKeywords.machinesThisComputer',
                                icon: ({ theme }) => <Icon name="laptop" size={16} color={theme.colors.text.secondary} />,
                            },
                        ],
                    },
                    {
                        id: 'remoteHosts',
                        titleKey: 'settings.remoteHostsTitle',
                        route: SETTINGS_ROUTES.remoteHosts,
                        keywordsKey: 'settingsSearchKeywords.remoteHosts',
                        gate: { featureId: 'remoteHosts.management', requiresTauriDesktop: true },
                        icon: ({ theme }) => <Icon name="hard-drives" size={16} color={theme.colors.text.secondary} />,
                    },
                ],
            },
            {
                id: 'groupGeneral',
                titleKey: 'settings.general',
                keywordsKey: 'settingsSearchKeywords.groupGeneral',
                icon: ({ theme }) => <Icon name="sliders-horizontal" size={16} color={theme.colors.text.secondary} />,
                children: [
                    {
                        id: 'appearance',
                        titleKey: 'settings.appearance',
                        subtitleKey: 'settings.appearanceSubtitle',
                        route: SETTINGS_ROUTES.appearance,
                        keywordsKey: 'settingsSearchKeywords.appearance',
                        icon: ({ theme }) => <Icon name="palette" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'keyboard',
                        titleKey: 'settingsKeyboard.title',
                        subtitleKey: 'settingsKeyboard.entrySubtitle',
                        route: SETTINGS_ROUTES.keyboard,
                        keywordsKey: 'settingsSearchKeywords.keyboard',
                        icon: ({ theme }) => <Icon name="squares-four" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'pets',
                        titleKey: 'settings.pets',
                        subtitleKey: 'settings.petsSubtitle',
                        route: SETTINGS_ROUTES.pets,
                        keywordsKey: 'settingsSearchKeywords.pets',
                        gate: { featureId: 'pets.companion' },
                        icon: ({ theme }) => <Icon name="paw-print" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'language',
                        titleKey: 'settingsLanguage.title',
                        route: SETTINGS_ROUTES.language,
                        keywordsKey: 'settingsSearchKeywords.language',
                        icon: ({ theme }) => <Icon name="translate" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'features',
                        titleKey: 'settings.featuresTitle',
                        subtitleKey: 'settings.featuresSubtitle',
                        route: SETTINGS_ROUTES.features,
                        keywordsKey: 'settingsSearchKeywords.features',
                        icon: ({ theme }) => <Icon name="flask" size={16} color={theme.colors.text.secondary} />,
                    },
                ],
            },
            {
                id: 'groupAiAndAgents',
                titleKey: 'settings.aiAndAgents',
                keywordsKey: 'settingsSearchKeywords.groupAiAndAgents',
                icon: ({ theme }) => <Icon name="sparkle" size={16} color={theme.colors.text.secondary} />,
                children: [
                    {
                        id: 'agents',
                        titleKey: 'settingsAgents.title',
                        subtitleKey: 'settingsAgents.entrySubtitle',
                        route: SETTINGS_ROUTES.agents,
                        keywordsKey: 'settingsSearchKeywords.agents',
                        icon: ({ theme }) => <Icon name="sparkle" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'providers',
                        titleKey: 'settingsProviders.title',
                        subtitleKey: 'settingsProviders.entrySubtitle',
                        route: SETTINGS_ROUTES.providers,
                        keywordsKey: 'settingsSearchKeywords.providers',
                        gate: { featureId: 'providers' },
                        icon: ({ theme }) => <Icon name="cube" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'subAgent',
                        titleKey: 'subAgentGuidance.settings.groupTitle',
                        subtitleKey: 'settingsSession.subAgentGuidanceEntry.openSubtitle',
                        route: SETTINGS_ROUTES.subAgent,
                        keywordsKey: 'settingsSearchKeywords.subAgent',
                        icon: ({ theme }) => <Icon name="graph" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'profiles',
                        titleKey: 'settings.profiles',
                        subtitleKey: 'settings.profilesSubtitle',
                        route: SETTINGS_ROUTES.profiles,
                        gate: { requiresProfiles: true },
                        keywordsKey: 'settingsSearchKeywords.profiles',
                        icon: ({ theme }) => <Icon name="person" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'roles',
                        titleKey: 'roles.rail.label',
                        subtitleKey: 'roles.settings.description',
                        route: SETTINGS_ROUTES.roles,
                        keywordsKey: 'settingsSearchKeywords.roles',
                        icon: ({ theme }) => <Icon name="users" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'delegation',
                        titleKey: 'roles.delegation.title',
                        subtitleKey: 'roles.delegation.description',
                        route: SETTINGS_ROUTES.delegation,
                        keywordsKey: 'settingsSearchKeywords.delegation',
                        icon: ({ theme }) => <Icon name="tree-structure" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'connectedServices',
                        titleKey: 'settings.connectedServices',
                        subtitleKey: 'settings.connectedServicesSubtitle',
                        route: SETTINGS_ROUTES.connectedServices,
                        keywordsKey: 'settingsSearchKeywords.connectedServices',
                        icon: ({ theme }) => <Icon name="key" size={16} color={theme.colors.text.secondary} />,
                        children: [
                            {
                                // How agents sign in (the collection rail's foot): per-agent defaults, state sharing.
                                id: 'connectedServicesAgentSignIn',
                                titleKey: 'connectedServicesCollection.agentSignInTitle',
                                subtitleKey: 'connectedServicesSettings.usageDescription',
                                route: SETTINGS_ROUTES.connectedServicesAgentSignIn,
                                icon: ({ theme }) => <Icon name="sparkle" size={16} color={theme.colors.text.secondary} />,
                            },
                        ],
                    },
                    {
                        id: 'mcp',
                        titleKey: 'settings.mcpServers',
                        subtitleKey: 'settings.mcpServersSubtitle',
                        route: SETTINGS_ROUTES.mcp,
                        keywordsKey: 'settingsSearchKeywords.mcp',
                        gate: { featureId: 'mcp.servers' },
                        icon: ({ theme }) => <Icon name="puzzle-piece" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'plugins',
                        titleKey: 'settingsPlugins.title',
                        subtitleKey: 'settingsPlugins.subtitle',
                        route: SETTINGS_ROUTES.plugins,
                        keywordsKey: 'settingsSearchKeywords.plugins',
                        icon: ({ theme }) => <Icon name={PLUGINS_SURFACE_ICON} size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'prompts',
                        titleKey: 'settings.prompts',
                        subtitleKey: 'settings.promptsSubtitle',
                        route: SETTINGS_ROUTES.prompts,
                        keywordsKey: 'settingsSearchKeywords.prompts',
                        gate: { featureId: 'prompts.library' },
                        icon: ({ theme }) => <Icon name="books" size={16} color={theme.colors.text.secondary} />,
                        children: [
                            { id: 'promptsTemplates', titleKey: 'promptLibrary.templates', route: SETTINGS_ROUTES.promptsTemplates, keywordsKey: 'settingsSearchKeywords.promptsTemplates', icon: ({ theme }) => <Icon name="lightning" size={16} color={theme.colors.text.secondary} /> },
                            { id: 'promptsFolders', titleKey: 'promptLibrary.folders', route: SETTINGS_ROUTES.promptsFolders, keywordsKey: 'settingsSearchKeywords.promptsFolders', icon: ({ theme }) => <Icon name="folder" size={16} color={theme.colors.text.secondary} /> },
                            { id: 'promptsStacks', titleKey: 'promptLibrary.stacks', route: SETTINGS_ROUTES.promptsStacks, keywordsKey: 'settingsSearchKeywords.promptsStacks', icon: ({ theme }) => <Icon name="stack-simple" size={16} color={theme.colors.text.secondary} /> },
                            { id: 'promptsRegistries', titleKey: 'promptLibrary.registries', route: SETTINGS_ROUTES.promptsRegistries, keywordsKey: 'settingsSearchKeywords.promptsRegistries', gate: { featureId: 'prompts.skills.registries' }, icon: ({ theme }) => <Icon name="globe" size={16} color={theme.colors.text.secondary} /> },
                            { id: 'promptsLibrary', titleKey: 'promptLibrary.prompts', route: SETTINGS_ROUTES.promptsLibrary, keywordsKey: 'settingsSearchKeywords.promptsLibrary', icon: ({ theme }) => <Icon name="books" size={16} color={theme.colors.text.secondary} /> },
                            { id: 'promptsAssets', titleKey: 'promptLibrary.externalAssets', route: SETTINGS_ROUTES.promptsAssets, keywordsKey: 'settingsSearchKeywords.promptsAssets', gate: { featureId: 'prompts.assets.external' }, icon: ({ theme }) => <Icon name="cloud" size={16} color={theme.colors.text.secondary} /> },
                        ],
                    },
                    {
                        id: 'voice',
                        titleKey: 'settings.voiceAssistant',
                        subtitleKey: 'settings.voiceAssistantSubtitle',
                        route: SETTINGS_ROUTES.voice,
                        keywordsKey: 'settingsSearchKeywords.voice',
                        icon: ({ theme }) => <Icon name="microphone" size={16} color={theme.colors.text.secondary} />,
                        children: [
                            { id: 'voiceConversations', titleKey: 'settingsVoice.intents.conversations.title', subtitleKey: 'settingsVoice.intents.conversations.subtitle', route: SETTINGS_ROUTES.voiceConversations, gate: { featureId: 'voice' }, keywordsKey: 'settingsSearchKeywords.voiceConversations', icon: ({ theme }) => <Icon name="chat-circle" size={16} color={theme.colors.text.secondary} /> },
                            { id: 'voiceDictation', titleKey: 'settingsVoice.intents.dictation.title', subtitleKey: 'settingsVoice.intents.dictation.subtitle', route: SETTINGS_ROUTES.voiceDictation, keywordsKey: 'settingsSearchKeywords.voiceDictation', icon: ({ theme }) => <Icon name="microphone" size={16} color={theme.colors.text.secondary} /> },
                            { id: 'voicePrivacy', titleKey: 'settingsVoice.intents.privacy.title', subtitleKey: 'settingsVoice.intents.privacy.subtitle', route: SETTINGS_ROUTES.voicePrivacy, keywordsKey: 'settingsSearchKeywords.voicePrivacy', icon: ({ theme }) => <Icon name="shield-check" size={16} color={theme.colors.text.secondary} /> },
                            { id: 'voiceAdvanced', titleKey: 'settingsVoice.intents.advanced.title', subtitleKey: 'settingsVoice.intents.advanced.subtitle', route: SETTINGS_ROUTES.voiceAdvanced, keywordsKey: 'settingsSearchKeywords.voiceAdvanced', icon: ({ theme }) => <Icon name="sliders-horizontal" size={16} color={theme.colors.text.secondary} /> },
                        ],
                    },
                    {
                        id: 'memory',
                        titleKey: 'settings.memorySearch',
                        subtitleKey: 'settings.memorySearchSubtitle',
                        route: SETTINGS_ROUTES.memory,
                        gate: { featureId: 'memory.search' },
                        keywordsKey: 'settingsSearchKeywords.memory',
                        icon: ({ theme }) => <Icon name="magnifying-glass" size={16} color={theme.colors.text.secondary} />,
                    },
                ],
            },
            {
                id: 'groupSessionsBehavior',
                titleKey: 'settings.sessionsBehavior',
                keywordsKey: 'settingsSearchKeywords.groupSessionsBehavior',
                icon: ({ theme }) => <Icon name="terminal" size={16} color={theme.colors.text.secondary} />,
                children: [
                    {
                        id: 'session',
                        titleKey: 'settings.sessions',
                        route: SETTINGS_ROUTES.session,
                        keywordsKey: 'settingsSearchKeywords.session',
                        icon: ({ theme }) => <Icon name="terminal" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'externalSessions',
                        titleKey: 'externalSessions.settingsTitle',
                        subtitleKey: 'externalSessions.settingsEntrySubtitle',
                        route: SETTINGS_ROUTES.externalSessions,
                        keywordsKey: 'settingsSearchKeywords.externalSessions',
                        gate: { featureId: 'sessions.direct' },
                        icon: ({ theme }) => <Icon name="link" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'actions',
                        titleKey: 'common.actions',
                        subtitleKey: 'settings.actionsSubtitle',
                        route: SETTINGS_ROUTES.actions,
                        keywordsKey: 'settingsSearchKeywords.actions',
                        icon: ({ theme }) => <Icon name="lightning" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'embeds',
                        titleKey: 'settingsEmbeds.title',
                        subtitleKey: 'settingsEmbeds.purpose',
                        route: SETTINGS_ROUTES.embeds,
                        keywordsKey: 'settingsSearchKeywords.embeds',
                        icon: ({ theme }) => <Icon name="browsers" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'transcript',
                        titleKey: 'settings.transcript',
                        subtitleKey: 'settings.transcriptSubtitle',
                        route: SETTINGS_ROUTES.transcript,
                        keywordsKey: 'settingsSearchKeywords.transcript',
                        icon: ({ theme }) => <Icon name="chats-circle" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'permissions',
                        titleKey: 'settings.permissions',
                        subtitleKey: 'settings.permissionsSubtitle',
                        route: SETTINGS_ROUTES.permissions,
                        keywordsKey: 'settingsSearchKeywords.permissions',
                        icon: ({ theme }) => <Icon name="shield" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'toolRendering',
                        titleKey: 'settingsSession.toolRendering.title',
                        route: SETTINGS_ROUTES.toolRendering,
                        keywordsKey: 'settingsSearchKeywords.toolRendering',
                        icon: ({ theme }) => <Icon name="wrench" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'handoff',
                        titleKey: 'settingsSession.handoff.title',
                        route: SETTINGS_ROUTES.handoff,
                        keywordsKey: 'settingsSearchKeywords.handoff',
                        icon: ({ theme }) => <Icon name="arrows-left-right" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'runs',
                        titleKey: 'runs.title',
                        subtitleKey: 'settings.executionRunsSubtitle',
                        route: SETTINGS_ROUTES.runs,
                        keywordsKey: 'settingsSearchKeywords.runs',
                        gate: { featureId: 'execution.runs' },
                        icon: ({ theme }) => <Icon name="play" size={16} color={theme.colors.text.secondary} />,
                    },
                ],
            },
            {
                id: 'groupFilesAndSourceControl',
                titleKey: 'settings.filesAndSourceControl',
                keywordsKey: 'settingsSearchKeywords.groupFilesAndSourceControl',
                icon: ({ theme }) => <Icon name="folder" size={16} color={theme.colors.text.secondary} />,
                children: [
                    {
                        id: 'sourceControl',
                        titleKey: 'settings.filesSourceControl',
                        subtitleKey: 'settings.filesSourceControlSubtitle',
                        route: SETTINGS_ROUTES.sourceControl,
                        gate: { featureId: 'scm.writeOperations' },
                        keywordsKey: 'settingsSearchKeywords.sourceControl',
                        icon: ({ theme }) => <Icon name="git-branch" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'attachments',
                        titleKey: 'settings.attachments',
                        subtitleKey: 'settings.attachmentsSubtitle',
                        route: SETTINGS_ROUTES.attachments,
                        gate: { featureId: 'attachments.uploads' },
                        keywordsKey: 'settingsSearchKeywords.attachments',
                        icon: ({ theme }) => <Icon name="paperclip" size={16} color={theme.colors.text.secondary} />,
                    },
                ],
            },
            {
                id: 'groupSystem',
                titleKey: 'settings.system',
                keywordsKey: 'settingsSearchKeywords.groupSystem',
                icon: ({ theme }) => <Icon name="hard-drives" size={16} color={theme.colors.text.secondary} />,
                children: [
                    {
                        id: 'servers',
                        titleKey: 'settings.servers',
                        subtitleKey: 'settings.serversSubtitle',
                        route: SETTINGS_ROUTES.servers,
                        keywordsKey: 'settingsSearchKeywords.servers',
                        icon: ({ theme }) => <Icon name="hard-drives" size={16} color={theme.colors.text.secondary} />,
                        children: [
                            {
                                id: 'serversAdd',
                                titleKey: 'addFlows.addHome',
                                subtitleKey: 'addFlows.addHomeSubtitle',
                                route: SETTINGS_ROUTES.serversAdd,
                                keywordsKey: 'settingsSearchKeywords.servers',
                                icon: ({ theme }) => <Icon name="plus-circle" size={16} color={theme.colors.text.secondary} />,
                            },
                        ],
                    },
                    {
                        id: 'updates',
                        titleKey: 'updates.title',
                        subtitleKey: 'updates.catalogSubtitle',
                        route: SETTINGS_ROUTES.updates,
                        keywordsKey: 'settingsSearchKeywords.updates',
                        icon: ({ theme }) => <Icon name="download" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'systemStatus',
                        titleKey: 'settings.systemStatus',
                        subtitleKey: 'settings.systemStatusSubtitle',
                        route: SETTINGS_ROUTES.systemStatus,
                        keywordsKey: 'settingsSearchKeywords.systemStatus',
                        icon: ({ theme }) => <Icon name="pulse" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'notifications',
                        titleKey: 'settings.notifications',
                        subtitleKey: 'settings.notificationsSubtitle',
                        route: SETTINGS_ROUTES.notifications,
                        keywordsKey: 'settingsSearchKeywords.notifications',
                        icon: ({ theme }) => <Icon name="bell" size={16} color={theme.colors.text.secondary} />,
                        children: [
                            {
                                id: 'notificationsPush',
                                titleKey: 'settingsNotifications.push.title',
                                route: SETTINGS_ROUTES.notificationsPush,
                                keywordsKey: 'settingsSearchKeywords.notificationsPush',
                                icon: ({ theme }) => <Icon name="paper-plane" size={16} color={theme.colors.text.secondary} />,
                            },
                        ],
                    },
                    {
                        id: 'desktop',
                        titleKey: 'settingsDesktop.title',
                        subtitleKey: 'settingsDesktop.footer',
                        route: SETTINGS_ROUTES.desktop,
                        keywordsKey: 'settingsSearchKeywords.desktop',
                        gate: { requiresTauriDesktop: true },
                        icon: ({ theme }) => <Icon name="desktop" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'diagnosis',
                        titleKey: 'diagnosis.title',
                        route: SETTINGS_ROUTES.diagnosis,
                        keywordsKey: 'settingsSearchKeywords.diagnosis',
                        icon: ({ theme }) => <Icon name="first-aid-kit" size={16} color={theme.colors.text.secondary} />,
                    },
                    {
                        id: 'reportIssue',
                        titleKey: 'settings.reportIssue',
                        route: SETTINGS_ROUTES.reportIssue,
                        keywordsKey: 'settingsSearchKeywords.reportIssue',
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

export function readSettingsPageGate(pageId: string): SettingsPageGate | undefined {
    return flattenSettingsPageCatalog(SETTINGS_PAGE_CATALOG).find((page) => page.id === pageId)?.gate;
}
