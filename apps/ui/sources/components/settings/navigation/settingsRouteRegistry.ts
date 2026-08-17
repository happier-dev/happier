import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { usePathname, useRouter } from 'expo-router';

import type { TranslationKeyNoParams } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

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
    { name: 'connected-services/index', titleKey: 'settings.connectedServices' },
    { name: 'connected-services/[serviceId]', titleKey: 'connectedServices.fallbackName' },
    { name: 'connected-services/account', titleKey: 'connectedServices.profile.profileId' },
    { name: 'connected-services/provider-state-sharing', titleKey: 'connectedServices.providerStateSharing.title' },
    // Legacy deep-link redirects (`ConnectedAccountLegacyRouteRedirect`). They
    // render no screen of their own, so their chrome title is the section's, not
    // the name of the screen each one used to be.
    { name: 'connected-services/group', titleKey: 'connectedServices.title' },
    { name: 'connected-services/oauth', titleKey: 'connectedServices.title' },
    { name: 'connected-services/profile', titleKey: 'connectedServices.title' },
    { name: 'desktop', titleKey: 'settingsDesktop.title' },
    { name: 'diagnosis', titleKey: 'diagnosis.title' },
    { name: 'features', titleKey: 'settings.features' },
    { name: 'external-sessions', titleKey: 'externalSessions.settingsTitle' },
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
    { name: 'plugins/index', titleKey: 'settingsPlugins.title' },
    { name: 'plugins/webhooks', titleKey: 'settingsPlugins.title' },
    { name: 'plugins/[pluginId]', titleKey: 'settingsPlugins.detailTitle' },
    { name: 'plugins/[pluginId]/[pageId]', titleKey: 'settingsPlugins.detailTitle' },
    { name: 'plugins/panels', titleKey: 'settingsPlugins.appPanelsTitle' },
    { name: 'profiles', titleKey: 'settingsFeatures.profiles' },
    { name: 'prompts/index', titleKey: 'settings.prompts' },
    { name: 'prompts/assets', titleKey: 'promptLibrary.externalAssets' },
    { name: 'prompts/docs/index', titleKey: 'promptLibrary.prompts' },
    { name: 'prompts/docs/[id]', titleKey: 'promptLibrary.editPrompt' },
    { name: 'prompts/docs/[id]/export', titleKey: 'promptLibrary.externalAssetsExportTitle' },
    { name: 'prompts/docs/new', titleKey: 'promptLibrary.newPrompt' },
    { name: 'prompts/folders', titleKey: 'promptLibrary.folders' },
    { name: 'prompts/library', headerShown: false },
    { name: 'prompts/registries', titleKey: 'promptLibrary.registries' },
    { name: 'prompts/registries/item', titleKey: 'promptLibrary.registries' },
    { name: 'prompts/skills/index', titleKey: 'promptLibrary.skills' },
    { name: 'prompts/skills/[id]', titleKey: 'promptLibrary.editSkill' },
    { name: 'prompts/skills/[id]/export', titleKey: 'promptLibrary.externalAssetsExportTitle' },
    { name: 'prompts/skills/[id]/files/edit', titleKey: 'promptLibrary.editSupportingFile' },
    { name: 'prompts/skills/[id]/files/new', titleKey: 'promptLibrary.newSupportingFile' },
    { name: 'prompts/skills/new', titleKey: 'promptLibrary.newSkill' },
    { name: 'prompts/stacks', titleKey: 'promptLibrary.stacks' },
    { name: 'prompts/stacks/coding', titleKey: 'promptLibrary.codingStack' },
    { name: 'prompts/stacks/pick', titleKey: 'promptLibrary.addToStack' },
    { name: 'prompts/stacks/profiles/index', titleKey: 'promptLibrary.profileStacks' },
    { name: 'prompts/stacks/profiles/[id]', titleKey: 'promptLibrary.profileStacks' },
    { name: 'prompts/stacks/voice', titleKey: 'promptLibrary.voiceStack' },
    { name: 'prompts/templates', titleKey: 'promptLibrary.templates' },
    { name: 'prompts/templates/[id]', titleKey: 'promptLibrary.editTemplate' },
    { name: 'prompts/templates/new', titleKey: 'promptLibrary.newTemplate' },
    { name: 'agents/index', titleKey: 'settingsAgents.title' },
    { name: 'agents/[agentId]', titleKey: 'settingsAgents.title' },
    { name: 'agents/[agentId]/models', titleKey: 'settingsAgents.models' },
    { name: 'providers/index', titleKey: 'settingsProviders.title' },
    { name: 'providers/[connectionId]', titleKey: 'settingsProviders.detailTitle' },
    { name: 'providers/[connectionId]/models', titleKey: 'settingsProviders.models.manage' },
    { name: 'providers/new', titleKey: 'settingsProviders.addCustom' },
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
    { name: 'voice/dictation', titleKey: 'settingsVoice.intents.dictation.title' },
    { name: 'voice/conversations', titleKey: 'settingsVoice.intents.conversations.title' },
    { name: 'voice/privacy', titleKey: 'settingsVoice.intents.privacy.title' },
    { name: 'voice/advanced', titleKey: 'settingsVoice.intents.advanced.title' },
    { name: 'voice-history', titleKey: 'settingsVoice.history.title' },
] as const;

export function resolveSettingsRouteParentPathname(pathname: string | null | undefined): string | null {
    if (typeof pathname !== 'string') return null;
    const normalizedPathname = pathname.trim().replace(/\/+$/, '') || '/';
    if (normalizedPathname === '/settings') return null;
    if (!normalizedPathname.startsWith('/settings/')) return null;

    const parentPathname = normalizedPathname.slice(0, normalizedPathname.lastIndexOf('/'));
    return parentPathname === '' ? '/settings' : parentPathname;
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
    const router = useRouter();

    if (!shouldShowSettingsParentBackButton({ pathname, hideOnTopLevel })) {
        return null;
    }

    const parentPathname = resolveSettingsRouteParentPathname(pathname);

    return React.createElement(Pressable, {
        accessibilityLabel,
        accessibilityRole: 'button',
        hitSlop: 8,
        onPress: () => {
            if (parentPathname) {
                const result = runGuardedNavigation(() => router.navigate(parentPathname as never));
                if (result !== true) {
                    fireAndForget(result, { tag: 'SettingsParentBackButton.back' });
                }
            }
        },
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
    config?: Readonly<{ isModalPresentation?: boolean }>,
): readonly SettingsStackScreenDefinition[] {
    const isModalPresentation = config?.isModalPresentation ?? false;
    return SETTINGS_ROUTE_CHROME_DEFINITIONS.map((definition) => {
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
            options.headerTitle = t(definition.titleKey);
        }
        if (definition.name !== 'index' && options.headerShown !== false) {
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
