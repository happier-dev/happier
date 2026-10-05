import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';

import type { TranslationKeyNoParams } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

type Translate = (key: TranslationKeyNoParams) => string;

export type SettingsStackScreenDefinition = Readonly<{
    name: string;
    options: NativeStackNavigationOptions;
}>;

/** Settings sections that own a nested stack (collection + detail); their screens resolve under `/settings/<navigator>`. */
export type SettingsNestedNavigator = 'account/api-tokens' | 'connected-services' | 'providers' | 'agents' | 'teams' | 'mcp' | 'prompts/docs' | 'prompts/skills' | 'prompts/templates' | 'machines' | 'embeds' | 'profiles' | 'roles' | 'remote-hosts' | 'home/[serverId]' | 'server';

type SettingsRouteChromeDefinition = Readonly<{
    navigator?: SettingsNestedNavigator;
    headerBackTitleKey?: TranslationKeyNoParams;
    headerShown?: boolean;
    /**
     * An entity page names itself in its own `PageHeader alwaysShowTitle` (a Team, a member, a
     * Group), so the phone header keeps an empty title: one title on the page.
     */
    headsItself?: boolean;
    name: string;
    titleKey?: TranslationKeyNoParams;
}>;

const SETTINGS_ROUTE_CHROME_DEFINITIONS: readonly SettingsRouteChromeDefinition[] = [
    { name: 'index', titleKey: 'settings.title', headerBackTitleKey: 'common.home' },
    { name: 'account', titleKey: 'settings.account' },
    { name: 'account/security', titleKey: 'settingsAccount.security', headerBackTitleKey: 'settings.account' },
    // API tokens are one collection (the rail + a token's detail) under its own nested stack.
    { name: 'account/api-tokens', titleKey: 'settingsApiTokens.title' },
    { name: 'index', navigator: 'account/api-tokens', titleKey: 'settingsApiTokens.title' },
    { name: '[tokenId]', navigator: 'account/api-tokens', titleKey: 'settingsApiTokens.title', headsItself: true },
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
    // Connected services is one collection (its rail + the detail) under its own nested stack; the
    // index of every service is its unselected detail (lab `csvc` C1/C2).
    { name: 'connected-services', titleKey: 'settings.connectedServices' },
    { name: 'index', navigator: 'connected-services', titleKey: 'settings.connectedServices' },
    { name: 'connect', navigator: 'connected-services', titleKey: 'settings.connectedServices', headsItself: true },
    { name: '[serviceId]', navigator: 'connected-services', titleKey: 'connectedServices.fallbackName' },
    { name: 'account', navigator: 'connected-services', titleKey: 'connectedServices.profile.profileId', headsItself: true },
    { name: 'sign-in', navigator: 'connected-services', titleKey: 'connectedServicesCollection.agentSignInTitle' },
    { name: 'provider-state-sharing', navigator: 'connected-services', titleKey: 'connectedServicesSettings.perAgentTitle' },
    // Legacy deep-link redirects (`ConnectedAccountLegacyRouteRedirect`). They
    // render no screen of their own, so their chrome title is the section's, not
    // the name of the screen each one used to be.
    { name: 'group', navigator: 'connected-services', titleKey: 'connectedServices.title' },
    { name: 'oauth', navigator: 'connected-services', titleKey: 'connectedServices.title' },
    { name: 'profile', navigator: 'connected-services', titleKey: 'connectedServices.title' },
    { name: 'desktop', titleKey: 'settingsDesktop.title' },
    { name: 'diagnosis', titleKey: 'diagnosis.title' },
    { name: 'features', titleKey: 'settings.features' },
    { name: 'external-sessions', titleKey: 'externalSessions.settingsTitle' },
    { name: 'home/index', titleKey: 'homeGovernance.title' },
    // The Home console is one collection (its rail + the page) under its own nested stack (plan §3.10).
    { name: 'home/[serverId]', titleKey: 'homeGovernance.title' },
    { name: 'index', navigator: 'home/[serverId]', titleKey: 'homeGovernance.title' },
    { name: 'people/index', navigator: 'home/[serverId]', titleKey: 'homeGovernance.people' },
    { name: 'people/[accountId]', navigator: 'home/[serverId]', titleKey: 'homeGovernance.people', headsItself: true },
    { name: 'policies', navigator: 'home/[serverId]', titleKey: 'homeGovernance.policies' },
    { name: 'teams', navigator: 'home/[serverId]', titleKey: 'homeGovernance.teams' },
    { name: 'reach', navigator: 'home/[serverId]', titleKey: 'homeGovernance.reach.title' },
    { name: 'email', navigator: 'home/[serverId]', titleKey: 'homeGovernance.email.title' },
    { name: 'features', navigator: 'home/[serverId]', titleKey: 'homeGovernance.features.title' },
    { name: 'data', navigator: 'home/[serverId]', titleKey: 'homeGovernance.data.title' },
    { name: 'runtime', navigator: 'home/[serverId]', titleKey: 'homeGovernance.runtime.title' },
    { name: 'server-settings', navigator: 'home/[serverId]', titleKey: 'homeGovernance.console.serverSettings' },
    { name: 'activity', navigator: 'home/[serverId]', titleKey: 'homeGovernance.activity.title' },
    { name: 'policies/identity/new', navigator: 'home/[serverId]', titleKey: 'identityAdministration.createTitle' },
    { name: 'policies/identity/[providerId]/index', navigator: 'home/[serverId]', titleKey: 'identityAdministration.title' },
    { name: 'policies/identity/[providerId]/edit', navigator: 'home/[serverId]', titleKey: 'identityAdministration.editTitle' },
    { name: 'policies/github-apps/new', navigator: 'home/[serverId]', titleKey: 'identityAdministration.githubAppCreateTitle' },
    { name: 'policies/github-apps/[registrationId]/index', navigator: 'home/[serverId]', titleKey: 'identityAdministration.githubApps' },
    { name: 'policies/github-apps/[registrationId]/edit', navigator: 'home/[serverId]', titleKey: 'identityAdministration.githubAppEditTitle' },
    // Identity providers and GitHub Apps live under Sign-in providers; the Policies routes above
    // only redirect links saved before the move.
    { name: 'sign-in-providers', navigator: 'home/[serverId]', titleKey: 'homeGovernance.signInProviders.title' },
    { name: 'sign-in-providers/identity/new', navigator: 'home/[serverId]', titleKey: 'identityAdministration.createTitle' },
    { name: 'sign-in-providers/identity/[providerId]/index', navigator: 'home/[serverId]', titleKey: 'identityAdministration.title' },
    { name: 'sign-in-providers/identity/[providerId]/edit', navigator: 'home/[serverId]', titleKey: 'identityAdministration.editTitle' },
    { name: 'sign-in-providers/github-apps/new', navigator: 'home/[serverId]', titleKey: 'identityAdministration.githubAppCreateTitle' },
    { name: 'sign-in-providers/github-apps/[registrationId]/index', navigator: 'home/[serverId]', titleKey: 'identityAdministration.githubApps' },
    { name: 'sign-in-providers/github-apps/[registrationId]/edit', navigator: 'home/[serverId]', titleKey: 'identityAdministration.githubAppEditTitle' },
    { name: 'keyboard', titleKey: 'settingsKeyboard.title' },
    { name: 'language', titleKey: 'settingsLanguage.title' },
    // Embeds is one collection (its rail + the detail, create and edit) under its own nested stack (plan 04 §4.10).
    { name: 'embeds', titleKey: 'settingsEmbeds.title' },
    { name: 'index', navigator: 'embeds', titleKey: 'settingsEmbeds.title' },
    { name: 'new', navigator: 'embeds', titleKey: 'settingsEmbeds.newTitle' },
    { name: '[tokenId]', navigator: 'embeds', titleKey: 'settingsEmbeds.title', headsItself: true },
    { name: 'machines', titleKey: 'settings.machines' },
    { name: 'index', navigator: 'machines', titleKey: 'settings.machines' },
    { name: '[id]', navigator: 'machines', titleKey: 'settings.machines' },
    { name: 'add', navigator: 'machines', titleKey: 'settings.addMachine' },
    { name: 'this-computer', navigator: 'machines', titleKey: 'settingsMachines.thisComputerTitle' },
    { name: 'pools/[poolId]', navigator: 'machines', titleKey: 'machinePools.title' },
    { name: 'pools/new', navigator: 'machines', titleKey: 'machinePools.add' },
    { name: 'mcp-server', titleKey: 'settings.mcpServersEditorTitle' },
    { name: 'mcp', titleKey: 'settings.mcpServers' },
    { name: 'index', navigator: 'mcp', titleKey: 'settings.mcpServers' },
    { name: 'new', navigator: 'mcp', titleKey: 'mcpSettings.newServer' },
    { name: 'on-machine', navigator: 'mcp', titleKey: 'mcpSettings.onMachineTitle' },
    { name: 'preview', navigator: 'mcp', titleKey: 'mcpSettings.previewTitle' },
    { name: '[serverId]', navigator: 'mcp', titleKey: 'settings.mcpServersEditorTitle' },
    { name: 'memory', titleKey: 'settings.memorySearch' },
    { name: 'notifications', titleKey: 'settings.notifications' },
    { name: 'notifications/push', titleKey: 'settingsNotifications.push.troubleshootTitle' },
    { name: 'pets', titleKey: 'settingsPets.title' },
    { name: 'plugins/index', titleKey: 'settingsPlugins.title' },
    { name: 'plugins/webhooks', titleKey: 'settingsPlugins.webhookAdministration.title' },
    { name: 'plugins/listing', titleKey: 'settingsPlugins.detailTitle' },
    { name: 'plugins/[pluginId]', titleKey: 'settingsPlugins.detailTitle' },
    { name: 'plugins/[pluginId]/[pageId]', titleKey: 'settingsPlugins.detailTitle' },
    { name: 'plugins/sources', titleKey: 'settingsPlugins.sourceAdministration.title' },
    { name: 'plugins/development', titleKey: 'settingsPlugins.views.development' },
    { name: 'plugins/diagnostics', titleKey: 'settingsPlugins.views.diagnostics' },
    { name: 'profiles', titleKey: 'settingsFeatures.profiles' },
    { name: 'index', navigator: 'profiles', titleKey: 'settingsFeatures.profiles' },
    { name: 'new', navigator: 'profiles', titleKey: 'profiles.addProfile' },
    { name: 'default-environment', navigator: 'profiles', titleKey: 'profiles.noProfile' },
    { name: '[profileId]', navigator: 'profiles', titleKey: 'profiles.editProfile' },
    { name: 'roles', titleKey: 'roles.rail.label' },
    { name: 'index', navigator: 'roles', titleKey: 'roles.rail.label' },
    { name: 'new', navigator: 'roles', titleKey: 'roles.settings.newRole' },
    { name: '[roleId]', navigator: 'roles', titleKey: 'roles.rail.label' },
    { name: 'delegation', titleKey: 'roles.delegation.title' },
    // `prompts` has its own layout (it waits for the library to load), so the stack sees one `prompts` screen.
    { name: 'prompts', titleKey: 'settings.prompts' },
    { name: 'prompts/index', titleKey: 'settings.prompts' },
    { name: 'prompts/assets', titleKey: 'promptLibrary.externalAssets' },
    { name: 'index', navigator: 'prompts/docs', titleKey: 'promptLibrary.prompts' },
    { name: '[id]', navigator: 'prompts/docs', titleKey: 'promptLibrary.editPrompt' },
    { name: '[id]/export', navigator: 'prompts/docs', titleKey: 'promptLibrary.externalAssetsExportTitle' },
    { name: 'new', navigator: 'prompts/docs', titleKey: 'promptLibrary.newPrompt' },
    { name: 'prompts/docs', titleKey: 'promptLibrary.prompts' },
    { name: 'prompts/skills', titleKey: 'promptLibrary.skills' },
    { name: 'prompts/templates', titleKey: 'promptLibrary.templates' },
    { name: 'prompts/folders', titleKey: 'promptLibrary.folders' },
    { name: 'prompts/library', headerShown: false },
    { name: 'prompts/registries', titleKey: 'promptLibrary.registries' },
    { name: 'prompts/registries/item', titleKey: 'promptLibrary.registries' },
    { name: 'index', navigator: 'prompts/skills', titleKey: 'promptLibrary.skills' },
    { name: '[id]', navigator: 'prompts/skills', titleKey: 'promptLibrary.editSkill' },
    { name: '[id]/export', navigator: 'prompts/skills', titleKey: 'promptLibrary.externalAssetsExportTitle' },
    { name: '[id]/files/edit', navigator: 'prompts/skills', titleKey: 'promptLibrary.editSupportingFile' },
    { name: '[id]/files/new', navigator: 'prompts/skills', titleKey: 'promptLibrary.newSupportingFile' },
    { name: 'new', navigator: 'prompts/skills', titleKey: 'promptLibrary.newSkill' },
    { name: 'prompts/stacks', titleKey: 'promptLibrary.stacks' },
    { name: 'prompts/stacks/coding', titleKey: 'promptLibrary.codingStack' },
    { name: 'prompts/stacks/pick', titleKey: 'promptLibrary.addToStack' },
    { name: 'prompts/stacks/profiles/index', titleKey: 'promptLibrary.profileStacks' },
    { name: 'prompts/stacks/profiles/[id]', titleKey: 'promptLibrary.profileStacks' },
    { name: 'prompts/stacks/voice', titleKey: 'promptLibrary.voiceStack' },
    { name: 'index', navigator: 'prompts/templates', titleKey: 'promptLibrary.templates' },
    { name: '[id]', navigator: 'prompts/templates', titleKey: 'promptLibrary.editTemplate' },
    { name: 'new', navigator: 'prompts/templates', titleKey: 'promptLibrary.newTemplate' },
    { name: 'agents', titleKey: 'settingsAgents.title' },
    { name: 'index', navigator: 'agents', titleKey: 'settingsAgents.title' },
    { name: '[agentId]', navigator: 'agents', titleKey: 'settingsAgents.title' },
    { name: '[agentId]/models', navigator: 'agents', titleKey: 'settingsAgents.models' },
    { name: 'custom/index', navigator: 'agents', titleKey: 'settingsAgents.customAcp.newTitle' },
    { name: 'custom/[backendId]', navigator: 'agents', titleKey: 'settingsAgents.collection.customAgents' },
    { name: 'providers', titleKey: 'settingsProviders.title' },
    { name: 'index', navigator: 'providers', titleKey: 'settingsProviders.title' },
    { name: '[connectionId]', navigator: 'providers', titleKey: 'settingsProviders.detailTitle' },
    { name: '[connectionId]/models', navigator: 'providers', titleKey: 'settingsProviders.models.manage' },
    { name: 'new', navigator: 'providers', titleKey: 'settingsProviders.addCustom' },
    { name: 'remote-hosts', titleKey: 'settings.remoteHostsTitle' },
    { name: 'index', navigator: 'remote-hosts', titleKey: 'settings.remoteHostsTitle' },
    { name: '[hostId]', navigator: 'remote-hosts', titleKey: 'settings.remoteHostsTitle' },
    { name: 'new', navigator: 'remote-hosts', titleKey: 'settingsRemoteHostsPage.newHostTitle' },
    { name: 'access', navigator: 'remote-hosts', titleKey: 'settingsRemoteHostsPage.accessTitle' },
    { name: 'report-issue', titleKey: 'settings.reportIssue' },
    { name: 'secrets', titleKey: 'settings.secrets' },
    { name: 'server', titleKey: 'settings.servers' },
    { name: 'index', navigator: 'server', titleKey: 'settings.servers' },
    { name: 'device', navigator: 'server', titleKey: 'addFlows.thisDeviceTitle' },
    { name: 'add', navigator: 'server', titleKey: 'addFlows.addHome' },
    { name: '[homeId]', navigator: 'server', titleKey: 'settings.servers', headsItself: true },
    { name: 'groups/new', navigator: 'server', titleKey: 'addFlows.newGroup' },
    { name: 'groups/[groupId]', navigator: 'server', titleKey: 'addFlows.groupsTitle', headsItself: true },
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
    { name: 'session/transcript/advanced', titleKey: 'settingsSessionPages.transcript.advancedTitle' },
    { name: 'source-control', titleKey: 'navigation.sourceControl' },
    { name: 'sub-agent', titleKey: 'subAgentGuidance.settings.groupTitle' },
    { name: 'system-status', titleKey: 'settings.systemStatus' },
    { name: 'updates', titleKey: 'updates.title' },
    { name: 'teams', titleKey: 'teams.title' },
    { name: 'index', navigator: 'teams', titleKey: 'teams.title' },
    { name: 'new', navigator: 'teams', titleKey: 'teams.create.title' },
    { name: '[serverId]/[teamId]/index', navigator: 'teams', titleKey: 'teams.title', headsItself: true },
    { name: '[serverId]/[teamId]/members/index', navigator: 'teams', titleKey: 'teams.tabs.members' },
    { name: '[serverId]/[teamId]/members/add', navigator: 'teams', titleKey: 'teams.tabs.members' },
    { name: '[serverId]/[teamId]/members/[membershipId]', navigator: 'teams', titleKey: 'teams.tabs.members', headsItself: true },
    { name: '[serverId]/[teamId]/groups/index', navigator: 'teams', titleKey: 'teams.tabs.groups' },
    { name: '[serverId]/[teamId]/groups/new', navigator: 'teams', titleKey: 'teams.tabs.groups' },
    { name: '[serverId]/[teamId]/groups/[groupId]', navigator: 'teams', titleKey: 'teams.tabs.groups', headsItself: true },
    { name: '[serverId]/[teamId]/invitations/index', navigator: 'teams', titleKey: 'teams.tabs.invitations' },
    { name: '[serverId]/[teamId]/invitations/new', navigator: 'teams', titleKey: 'teams.tabs.invitations' },
    { name: '[serverId]/[teamId]/settings', navigator: 'teams', titleKey: 'teams.tabs.settings' },
    { name: '[serverId]/[teamId]/authentication', navigator: 'teams', titleKey: 'teams.tabs.authentication' },
    { name: '[serverId]/[teamId]/authentication/new', navigator: 'teams', titleKey: 'identityAdministration.add' },
    { name: '[serverId]/[teamId]/authentication/github-apps/[registrationId]/index', navigator: 'teams', titleKey: 'identityAdministration.githubApps' },
    { name: '[serverId]/[teamId]/authentication/github-apps/[registrationId]/edit', navigator: 'teams', titleKey: 'identityAdministration.githubAppEditTitle' },
    { name: '[serverId]/[teamId]/authentication/directory', navigator: 'teams', titleKey: 'teams.authentication.directory.title' },
    { name: '[serverId]/[teamId]/authentication/directory/[sourceId]', navigator: 'teams', titleKey: 'teams.authentication.directory.title' },
    { name: '[serverId]/[teamId]/authentication/[connectionId]', navigator: 'teams', titleKey: 'teams.tabs.authentication' },
    { name: '[serverId]/[teamId]/authentication/[connectionId]/edit', navigator: 'teams', titleKey: 'identityAdministration.editTitle' },
    // Lane 10 shared credentials. Every destination the credential surfaces
    // navigate to is registered here, so a route reached by ordinary navigation
    // carries the same header, Back title and chrome as the rest of Settings
    // instead of falling back to the raw Expo Router segment.
    { name: '[serverId]/[teamId]/credentials/index', navigator: 'teams', titleKey: 'teams.credentials.title' },
    { name: '[serverId]/[teamId]/credentials/new', navigator: 'teams', titleKey: 'teams.credentials.create.title' },
    { name: '[serverId]/[teamId]/credentials/[resourceId]/index', navigator: 'teams', titleKey: 'teams.credentials.title' },
    { name: '[serverId]/[teamId]/credentials/[resourceId]/edit', navigator: 'teams', titleKey: 'teams.credentials.edit.title' },
    { name: '[serverId]/[teamId]/credentials/[resourceId]/access', navigator: 'teams', titleKey: 'teams.credentials.audience.title' },
    { name: '[serverId]/[teamId]/credentials/[resourceId]/request-policy', navigator: 'teams', titleKey: 'teams.credentials.requestPolicy.title' },
    { name: '[serverId]/[teamId]/credentials/[resourceId]/activity', navigator: 'teams', titleKey: 'teams.credentials.activity.title' },
    { name: '[serverId]/[teamId]/credentials/[resourceId]/limits', navigator: 'teams', titleKey: 'teams.credentials.limits.title' },
    { name: '[serverId]/[teamId]/credentials/[resourceId]/usage', navigator: 'teams', titleKey: 'teams.credentials.usage.title' },
    { name: '[serverId]/[teamId]/credentials/[resourceId]/external-api', navigator: 'teams', titleKey: 'teams.credentials.externalApi.title' },
    { name: 'usage', titleKey: 'settings.usage' },
    { name: 'voice', titleKey: 'settings.voiceAssistant' },
    { name: 'voice/dictation', titleKey: 'settingsVoice.intents.dictation.title' },
    { name: 'voice/conversations', titleKey: 'settingsVoice.intents.conversations.title' },
    { name: 'voice/service', titleKey: 'settingsVoice.pages.conversations.serviceTitle' },
    { name: 'voice/privacy', titleKey: 'settingsVoice.intents.privacy.title' },
    { name: 'voice/advanced', titleKey: 'settingsVoice.intents.advanced.title' },
    { name: 'voice-history', titleKey: 'settingsVoice.history.title' },
] as const;

/** Every registered settings route name, with its navigator prefix (`prompts/skills/[id]/files/edit`). */
export function listSettingsRouteNames(): string[] {
    return SETTINGS_ROUTE_CHROME_DEFINITIONS.map((definition) => (
        definition.navigator ? `${definition.navigator}/${definition.name}` : definition.name
    ));
}

function matchRouteSegments(pattern: readonly string[], segments: readonly string[]): 'static' | 'dynamic' | null {
    if (pattern.length !== segments.length) return null;
    let dynamic = false;
    for (let i = 0; i < pattern.length; i += 1) {
        const part = pattern[i]!;
        if (part.startsWith('[') && part.endsWith(']')) {
            dynamic = true;
            continue;
        }
        if (part !== segments[i]) return null;
    }
    return dynamic ? 'dynamic' : 'static';
}

/**
 * The title key of the settings route at `pathname`, from the same registry that titles the native
 * header, so an in-content page header and the navigation bar can never disagree. A fully static route
 * wins over a sibling with a dynamic segment (`prompts/docs/new` over `prompts/docs/[id]`); screens of
 * a nested navigator (Providers, Agents) resolve under `/settings/<navigator>`.
 */
export function resolveSettingsRouteTitleKey(pathname: string | null | undefined): TranslationKeyNoParams | null {
    if (typeof pathname !== 'string') return null;
    const normalized = pathname.trim().replace(/\/+$/, '') || '/';
    if (normalized !== '/settings' && !normalized.startsWith('/settings/')) return null;
    const segments = normalized === '/settings' ? [] : normalized.slice('/settings/'.length).split('/');
    let dynamicMatch: TranslationKeyNoParams | null = null;
    for (const definition of SETTINGS_ROUTE_CHROME_DEFINITIONS) {
        if (!definition.titleKey) continue;
        const nameSegments = (definition.navigator ? `${definition.navigator}/${definition.name}` : definition.name).split('/');
        const candidates = nameSegments[nameSegments.length - 1] === 'index'
            ? [nameSegments.slice(0, -1)]
            : [nameSegments];
        for (const candidate of candidates) {
            const match = matchRouteSegments(candidate, segments);
            if (match === 'static') return definition.titleKey;
            if (match === 'dynamic' && dynamicMatch === null) dynamicMatch = definition.titleKey;
        }
    }
    return dynamicMatch;
}

/**
 * The nested-navigator screen that renders `pathname` inside a collection (`/settings/<navigator>/…`),
 * from the same registry the navigator registers its screens from. A fully static route wins over a
 * dynamic sibling (`members/add` over `members/[membershipId]`).
 */
export function resolveSettingsNestedRouteName(
    navigator: SettingsNestedNavigator,
    pathname: string | null | undefined,
): string | null {
    if (typeof pathname !== 'string') return null;
    const normalized = pathname.trim().replace(/\/+$/, '') || '/';
    if (!normalized.startsWith('/settings/')) return null;
    // A navigator may sit under a dynamic segment (`home/[serverId]/people`): its root matches by pattern.
    const rootPattern = navigator.split('/');
    const pathSegments = normalized.slice('/settings/'.length).split('/');
    if (pathSegments.length < rootPattern.length
        || matchRouteSegments(rootPattern, pathSegments.slice(0, rootPattern.length)) === null) {
        return null;
    }
    const segments = pathSegments.slice(rootPattern.length);
    let dynamicMatch: string | null = null;
    for (const definition of SETTINGS_ROUTE_CHROME_DEFINITIONS) {
        if (definition.navigator !== navigator) continue;
        const nameSegments = definition.name.split('/');
        const candidate = nameSegments[nameSegments.length - 1] === 'index' ? nameSegments.slice(0, -1) : nameSegments;
        const match = matchRouteSegments(candidate, segments);
        if (match === 'static') return definition.name;
        if (match === 'dynamic' && dynamicMatch === null) dynamicMatch = definition.name;
    }
    return dynamicMatch;
}

/**
 * The URL patterns of every mounted settings route (`index` is its directory), from the registry the
 * stacks register their screens from. The registry test keeps it equal to `app/(app)/settings/**`.
 */
const MOUNTED_SETTINGS_ROUTE_PATTERNS: readonly (readonly string[])[] = listSettingsRouteNames().map((name) => {
    const segments = name.split('/');
    return segments[segments.length - 1] === 'index' ? segments.slice(0, -1) : segments;
});

/**
 * Whether a registered route names `segment` literally after `prefix` (`pools` under `machines`). The
 * router gives such a segment to its static directory, never to a dynamic sibling (`machines/[id]`).
 */
function isStaticSettingsSegment(prefix: readonly string[], segment: string): boolean {
    return MOUNTED_SETTINGS_ROUTE_PATTERNS.some((pattern) => pattern.length > prefix.length
        && pattern[prefix.length] === segment
        && matchRouteSegments(pattern.slice(0, prefix.length), prefix) !== null);
}

function isMountedSettingsRoute(segments: readonly string[]): boolean {
    return MOUNTED_SETTINGS_ROUTE_PATTERNS.some((pattern) => {
        if (pattern.length !== segments.length) return false;
        return pattern.every((part, index) => (part.startsWith('[') && part.endsWith(']')
            ? !isStaticSettingsSegment(segments.slice(0, index), segments[index]!)
            : part === segments[index]));
    });
}

/**
 * Where a settings screen's back affordance leads: the nearest ancestor path that is a mounted
 * route. Organizational segments with no screen of their own (a Team's Home segment, `pools`,
 * `github-apps`, a skill's `files`) are skipped, so back never lands on "Unmatched Route".
 */
export function resolveSettingsRouteParentPathname(pathname: string | null | undefined): string | null {
    if (typeof pathname !== 'string') return null;
    const normalizedPathname = pathname.trim().replace(/\/+$/, '') || '/';
    if (normalizedPathname === '/settings') return null;
    if (!normalizedPathname.startsWith('/settings/')) return null;

    // Custom ACP agents live in the Agents collection; `custom` alone is the new-agent draft, not
    // the parent of a saved agent, although it is a mounted route.
    if (/^\/settings\/agents\/custom(?:\/[^/]+)?$/.test(normalizedPathname)) return '/settings/agents';

    const segments = normalizedPathname.slice('/settings/'.length).split('/');
    for (let length = segments.length - 1; length > 0; length -= 1) {
        const ancestor = segments.slice(0, length);
        if (isMountedSettingsRoute(ancestor)) return `/settings/${ancestor.join('/')}`;
    }
    return '/settings';
}

/**
 * Whether the within-settings "back" arrow should be shown for the current route.
 *
 * - The settings index has no parent → never shows.
 * - In modal presentation (`hideOnTopLevel`), top-level categories (parent === '/settings')
 *   are reachable from the nav rail, so the redundant back arrow is hidden; only deeper
 *   sub-screens keep it.
 * - In full-screen (phone) presentation, every non-index screen keeps the back arrow.
 */
export function shouldShowSettingsParentBackButton(params: Readonly<{
    pathname: string | null | undefined;
    hideOnTopLevel: boolean;
}>): boolean {
    const parentPathname = resolveSettingsRouteParentPathname(params.pathname);
    if (!parentPathname) return false;
    if (params.hideOnTopLevel && parentPathname === '/settings') return false;
    return true;
}

/**
 * The settings back affordance's destination and action, shared by the phone header and the modal's
 * in-page control. Back returns to the parent screen that is already in the stack (with its state:
 * a search query, a scroll position); only when it is not there (a deep link) does the parent
 * replace the current screen. `navigate` would stack a second copy of the parent instead.
 */
export function useSettingsParentBack(tag: string): Readonly<{ parentPathname: string | null; goToParent: () => void }> {
    const pathname = usePathname();
    const router = useRouter();
    const parentPathname = resolveSettingsRouteParentPathname(pathname);
    const goToParent = React.useCallback(() => {
        if (!parentPathname) return;
        const result = runGuardedNavigation(() => router.dismissTo(parentPathname as never));
        if (result !== true) {
            fireAndForget(result, { tag });
        }
    }, [parentPathname, router, tag]);
    return { parentPathname, goToParent };
}

function SettingsParentBackButton({
    accessibilityLabel,
    tintColor,
    hideOnTopLevel,
}: Readonly<{
    accessibilityLabel: string;
    tintColor?: string;
    hideOnTopLevel: boolean;
}>): React.ReactElement | null {
    const pathname = usePathname();
    const { goToParent } = useSettingsParentBack('SettingsParentBackButton.back');

    if (!shouldShowSettingsParentBackButton({ pathname, hideOnTopLevel })) {
        return null;
    }

    return React.createElement(Pressable, {
        accessibilityLabel,
        accessibilityRole: 'button',
        hitSlop: 8,
        onPress: goToParent,
        style: {
            alignItems: 'center',
            justifyContent: 'center',
            marginLeft: Platform.select({ ios: -8, default: 0 }) as number,
            paddingHorizontal: 8,
            paddingVertical: 6,
        },
    }, React.createElement(Ionicons, {
        color: tintColor,
        name: Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back',
        size: 28,
    }));
}

export function getSettingsStackScreenDefinitions(
    t: Translate,
    config?: Readonly<{ isModalPresentation?: boolean; navigator?: SettingsNestedNavigator }>,
): readonly SettingsStackScreenDefinition[] {
    const isModalPresentation = config?.isModalPresentation ?? false;
    return SETTINGS_ROUTE_CHROME_DEFINITIONS.filter((definition) => definition.navigator === config?.navigator).map((definition) => {
        const options: NativeStackNavigationOptions = {
            headerBackTitle: t(definition.headerBackTitleKey ?? 'common.back'),
            headerShown: definition.headerShown ?? true,
        };
        if (isModalPresentation) {
            // In modal mode the navigator header is removed entirely; the close and (sub-screen)
            // back affordances are rendered as floating controls by SettingsShell instead.
            options.headerShown = false;
            return { name: definition.name, options };
        }
        if (definition.titleKey) {
            options.headerTitle = definition.headsItself ? '' : t(definition.titleKey);
        }
        if ((definition.name !== 'index' || definition.navigator) && options.headerShown !== false) {
            const accessibilityLabel = t('common.back');
            options.headerLeft = ({ tintColor }) => React.createElement(SettingsParentBackButton, {
                accessibilityLabel,
                tintColor,
                hideOnTopLevel: false,
            });
        }
        return {
            name: definition.name,
            options,
        };
    });
}
