import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

import type { TranslationKeyNoParams } from '@/text';

type Translate = (key: TranslationKeyNoParams) => string;

export type SettingsStackScreenDefinition = Readonly<{
    name: string;
    options: NativeStackNavigationOptions;
}>;

type SettingsRouteChromeDefinition = Readonly<{
    headerBackTitleKey?: TranslationKeyNoParams;
    headerShown?: boolean;
    name: string;
    titleKey?: TranslationKeyNoParams;
}>;

const SETTINGS_ROUTE_CHROME_DEFINITIONS: readonly SettingsRouteChromeDefinition[] = [
    { name: 'index', titleKey: 'settings.title', headerBackTitleKey: 'common.home' },
    { name: 'account', titleKey: 'settings.account' },
    { name: 'acp-backend', titleKey: 'settings.acpCatalogBackendEditorTitle' },
    { name: 'acp', titleKey: 'settings.acpCatalog' },
    { name: 'actions', titleKey: 'common.actions' },
    { name: 'actions/[actionId]', titleKey: 'common.actions' },
    { name: 'add-phone', titleKey: 'settings.addYourPhone' },
    { name: 'appearance', titleKey: 'settings.appearance' },
    { name: 'appearance/themes', titleKey: 'settingsAppearance.themeProfiles.title' },
    { name: 'appearance/themes/[profileId]', titleKey: 'settingsAppearance.themeProfiles.editorTitle' },
    { name: 'appearance/themes/import', titleKey: 'settingsAppearance.themeProfiles.importProfile' },
    { name: 'appearance/themes/export', titleKey: 'settingsAppearance.themeProfiles.exportProfile' },
    { name: 'attachments', titleKey: 'settings.attachments' },
    { name: 'connect/claude', headerShown: false },
    { name: 'connected-services', titleKey: 'settings.connectedServices' },
    { name: 'connected-services/[serviceId]', titleKey: 'connectedServices.fallbackName' },
    { name: 'connected-services/provider-state-sharing', titleKey: 'connectedServices.providerStateSharing.title' },
    { name: 'connected-services/group', titleKey: 'connectedServices.detail.groupDetail.routeTitle' },
    { name: 'connected-services/oauth', titleKey: 'connectedServices.detail.addOauthProfileTitle' },
    { name: 'connected-services/profile', titleKey: 'connectedServices.profile.profileId' },
    { name: 'desktop', titleKey: 'settingsDesktop.title' },
    { name: 'diagnosis', titleKey: 'diagnosis.title' },
    { name: 'features', titleKey: 'settings.features' },
    { name: 'keyboard', titleKey: 'settingsKeyboard.title' },
    { name: 'language', titleKey: 'settingsLanguage.currentLanguage' },
    { name: 'machines', titleKey: 'settings.machines' },
    { name: 'machines/add', titleKey: 'settings.addMachine' },
    { name: 'machines/this-computer', titleKey: 'settings.machineSetupCurrentMachineTitle' },
    { name: 'mcp-server', titleKey: 'settings.mcpServersEditorTitle' },
    { name: 'mcp', titleKey: 'settings.mcpServers' },
    { name: 'memory', titleKey: 'settings.memorySearch' },
    { name: 'notifications', titleKey: 'settings.notifications' },
    { name: 'notifications/push', titleKey: 'settingsNotifications.push.troubleshootTitle' },
    { name: 'pets', titleKey: 'settingsPets.title' },
    { name: 'plugins', titleKey: 'settingsPlugins.title' },
    { name: 'plugins/[pluginId]', titleKey: 'settingsPlugins.detailTitle' },
    { name: 'profiles', titleKey: 'settingsFeatures.profiles' },
    { name: 'prompts', titleKey: 'settings.prompts' },
    { name: 'prompts/assets', titleKey: 'promptLibrary.externalAssets' },
    { name: 'prompts/docs', titleKey: 'promptLibrary.prompts' },
    { name: 'prompts/docs/[id]', titleKey: 'promptLibrary.editPrompt' },
    { name: 'prompts/docs/[id]/export', titleKey: 'promptLibrary.externalAssetsExportTitle' },
    { name: 'prompts/docs/new', titleKey: 'promptLibrary.newPrompt' },
    { name: 'prompts/folders', titleKey: 'promptLibrary.folders' },
    { name: 'prompts/library', headerShown: false },
    { name: 'prompts/registries', titleKey: 'promptLibrary.registries' },
    { name: 'prompts/registries/item', titleKey: 'promptLibrary.registries' },
    { name: 'prompts/skills', titleKey: 'promptLibrary.skills' },
    { name: 'prompts/skills/[id]', titleKey: 'promptLibrary.editSkill' },
    { name: 'prompts/skills/[id]/export', titleKey: 'promptLibrary.externalAssetsExportTitle' },
    { name: 'prompts/skills/[id]/files/edit', titleKey: 'promptLibrary.editSupportingFile' },
    { name: 'prompts/skills/[id]/files/new', titleKey: 'promptLibrary.newSupportingFile' },
    { name: 'prompts/skills/new', titleKey: 'promptLibrary.newSkill' },
    { name: 'prompts/stacks', titleKey: 'promptLibrary.stacks' },
    { name: 'prompts/stacks/coding', titleKey: 'promptLibrary.codingStack' },
    { name: 'prompts/stacks/pick', titleKey: 'promptLibrary.addToStack' },
    { name: 'prompts/stacks/profiles', titleKey: 'promptLibrary.profileStacks' },
    { name: 'prompts/stacks/profiles/[id]', titleKey: 'promptLibrary.profileStacks' },
    { name: 'prompts/stacks/voice', titleKey: 'promptLibrary.voiceStack' },
    { name: 'prompts/templates', titleKey: 'promptLibrary.templates' },
    { name: 'prompts/templates/[id]', titleKey: 'promptLibrary.editTemplate' },
    { name: 'prompts/templates/new', titleKey: 'promptLibrary.newTemplate' },
    { name: 'providers', titleKey: 'settingsProviders.title' },
    { name: 'providers/[providerId]', titleKey: 'settingsProviders.title' },
    { name: 'remote-hosts', titleKey: 'settings.remoteHostsTitle' },
    { name: 'report-issue', titleKey: 'settings.reportIssue' },
    { name: 'secrets', titleKey: 'settings.secrets' },
    { name: 'server', titleKey: 'server.serverConfiguration' },
    { name: 'session', titleKey: 'settings.sessions' },
    { name: 'session/composer', titleKey: 'settingsSession.composer.title' },
    { name: 'session/handoff', titleKey: 'settingsSession.handoff.title' },
    { name: 'session/new-session-wizard', titleKey: 'settingsSession.sessionCreation.wizardDispositionTitle' },
    { name: 'session/permissions', titleKey: 'settingsSession.permissions.title' },
    { name: 'session/provider-limits', titleKey: 'settingsSession.providerLimits.title' },
    { name: 'session/resume', titleKey: 'settingsSession.resume.title' },
    { name: 'session/runtime', titleKey: 'settingsSession.runtime.title' },
    { name: 'session/tool-rendering', titleKey: 'settingsSession.toolRendering.title' },
    { name: 'session/transcript', titleKey: 'settingsSession.transcript.title' },
    { name: 'session/transcript/advanced', titleKey: 'settingsSession.transcript.advancedTitle' },
    { name: 'source-control', titleKey: 'navigation.sourceControl' },
    { name: 'sub-agent', titleKey: 'subAgentGuidance.settings.groupTitle' },
    { name: 'system-status', titleKey: 'settings.systemStatus' },
    { name: 'usage', titleKey: 'settings.usage' },
    { name: 'voice', titleKey: 'settings.voiceAssistant' },
] as const;

export function getSettingsStackScreenDefinitions(t: Translate): readonly SettingsStackScreenDefinition[] {
    return SETTINGS_ROUTE_CHROME_DEFINITIONS.map((definition) => {
        const options: NativeStackNavigationOptions = {
            headerBackTitle: t(definition.headerBackTitleKey ?? 'common.back'),
            headerShown: definition.headerShown ?? true,
        };
        if (definition.titleKey) {
            options.headerTitle = t(definition.titleKey);
        }
        return {
            name: definition.name,
            options,
        };
    });
}
