import { View } from 'react-native';
import * as React from 'react';

import type { SettingsBelowFoldSectionsProps } from '@/components/settings/settingsBelowFoldSectionTypes';
import { DependabotIcon } from '@/components/ui/icons/DependabotIcon';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

type SettingsAiAndAgentsSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'connectedServicesEnabled'
    | 'mcpServersEnabled'
    | 'memorySearchEnabled'
    | 'promptsLibraryEnabled'
    | 'router'
    | 'theme'
    | 'useProfiles'
    | 'voiceEnabled'
>>;

export const SettingsAiAndAgentsSection = React.memo(function SettingsAiAndAgentsSection({
    connectedServicesEnabled,
    mcpServersEnabled,
    memorySearchEnabled,
    promptsLibraryEnabled,
    router,
    theme,
    useProfiles,
    voiceEnabled,
}: SettingsAiAndAgentsSectionProps) {
    return (
        <ItemGroup title={t('settings.aiAndAgents')}>
            <Item
                title={t('settingsProviders.title')}
                subtitle={t('settingsProviders.entrySubtitle')}
                icon={<SafeIonicons name="sparkles-outline" size={29} color={theme.colors.accent.orange} />}
                onPress={() => router.push('/(app)/settings/providers')}
            />
            <Item
                title={t('subAgentGuidance.settings.groupTitle')}
                subtitle={t('settingsSession.subAgentGuidanceEntry.openSubtitle')}
                icon={(
                    <View style={{ width: 29, height: 29, alignItems: 'center', justifyContent: 'center' }}>
                        <DependabotIcon size={22} color={theme.colors.accent.orange} />
                    </View>
                )}
                onPress={() => router.push('/(app)/settings/sub-agent')}
            />
            {useProfiles ? (
                <Item
                    title={t('settings.profiles')}
                    subtitle={t('settings.profilesSubtitle')}
                    icon={<SafeIonicons name="person-outline" size={29} color={theme.colors.accent.purple} />}
                    onPress={() => router.push('/(app)/settings/profiles')}
                />
            ) : null}
            {connectedServicesEnabled ? (
                <Item
                    title={t('settings.connectedServices')}
                    subtitle={t('settings.connectedServicesSubtitle')}
                    icon={<SafeIonicons name="key-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push('/(app)/settings/connected-services')}
                />
            ) : null}
            {mcpServersEnabled ? (
                <Item
                    testID="settings-mcp-servers-item"
                    title={t('settings.mcpServers')}
                    subtitle={t('settings.mcpServersSubtitle')}
                    icon={<SafeIonicons name="extension-puzzle-outline" size={29} color={theme.colors.accent.purple} />}
                    onPress={() => router.push('/settings/mcp')}
                />
            ) : null}
            <Item
                testID="settings-plugin-marketplace-item"
                title={t('settingsPlugins.title')}
                subtitle={t('settingsPlugins.subtitle')}
                icon={<SafeIonicons name="grid-outline" size={29} color={theme.colors.accent.purple} />}
                onPress={() => router.push('/(app)/settings/plugins')}
            />
            {promptsLibraryEnabled ? (
                <Item
                    title={t('settings.prompts')}
                    subtitle={t('settings.promptsSubtitle')}
                    icon={<SafeIonicons name="library-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push('/(app)/settings/prompts')}
                />
            ) : null}
            {voiceEnabled ? (
                <Item
                    title={t('settings.voiceAssistant')}
                    subtitle={t('settings.voiceAssistantSubtitle')}
                    icon={<SafeIonicons name="mic-outline" size={29} color={theme.colors.state.success.foreground} />}
                    onPress={() => router.push('/(app)/settings/voice')}
                />
            ) : null}
            {memorySearchEnabled ? (
                <Item
                    title={t('settings.memorySearch')}
                    subtitle={t('settings.memorySearchSubtitle')}
                    icon={<SafeIonicons name="search-outline" size={29} color={theme.colors.state.success.foreground} />}
                    onPress={() => router.push('/(app)/settings/memory')}
                />
            ) : null}
        </ItemGroup>
    );
});
