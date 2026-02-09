import React from 'react';
import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { Switch } from '@/components/ui/forms/Switch';
import { t } from '@/text';

export default React.memo(function FeaturesSettingsScreen() {
    const [experiments, setExperiments] = useSettingMutable('experiments');
    const [expUsageReporting, setExpUsageReporting] = useSettingMutable('expUsageReporting');
    const [expGitOperations, setExpGitOperations] = useSettingMutable('expGitOperations');
    const [expShowThinkingMessages, setExpShowThinkingMessages] = useSettingMutable('expShowThinkingMessages');
    const [expSessionType, setExpSessionType] = useSettingMutable('expSessionType');
    const [expZen, setExpZen] = useSettingMutable('expZen');
    const [useProfiles, setUseProfiles] = useSettingMutable('useProfiles');
    const [agentInputEnterToSend, setAgentInputEnterToSend] = useSettingMutable('agentInputEnterToSend');
    const [commandPaletteEnabled, setCommandPaletteEnabled] = useLocalSettingMutable('commandPaletteEnabled');
    const [markdownCopyV2, setMarkdownCopyV2] = useLocalSettingMutable('markdownCopyV2');
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const [groupInactiveSessionsByProject, setGroupInactiveSessionsByProject] = useSettingMutable('groupInactiveSessionsByProject');
    const [useEnhancedSessionWizard, setUseEnhancedSessionWizard] = useSettingMutable('useEnhancedSessionWizard');
    const [useMachinePickerSearch, setUseMachinePickerSearch] = useSettingMutable('useMachinePickerSearch');
    const [usePathPickerSearch, setUsePathPickerSearch] = useSettingMutable('usePathPickerSearch');

    const setAllExperimentToggles = React.useCallback((enabled: boolean) => {
        setExpUsageReporting(enabled);
        // Intentionally NOT auto-enabled: this exposes write operations on user repositories.
        setExpGitOperations(false);
        setExpShowThinkingMessages(enabled);
        setExpSessionType(enabled);
        setExpZen(enabled);
    }, [
        setExpGitOperations,
        setExpSessionType,
        setExpShowThinkingMessages,
        setExpUsageReporting,
        setExpZen,
    ]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Standard feature toggles first */}
            <ItemGroup>
                <Item
                    title={t('settingsFeatures.markdownCopyV2')}
                    subtitle={t('settingsFeatures.markdownCopyV2Subtitle')}
                    icon={<Ionicons name="text-outline" size={29} color="#34C759" />}
                    rightElement={<Switch value={markdownCopyV2} onValueChange={setMarkdownCopyV2} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.hideInactiveSessions')}
                    subtitle={t('settingsFeatures.hideInactiveSessionsSubtitle')}
                    icon={<Ionicons name="eye-off-outline" size={29} color="#FF9500" />}
                    rightElement={<Switch value={hideInactiveSessions} onValueChange={setHideInactiveSessions} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.groupInactiveSessionsByProject')}
                    subtitle={t('settingsFeatures.groupInactiveSessionsByProjectSubtitle')}
                    icon={<Ionicons name="folder-outline" size={29} color="#007AFF" />}
                    rightElement={<Switch value={groupInactiveSessionsByProject} onValueChange={setGroupInactiveSessionsByProject} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.enhancedSessionWizard')}
                    subtitle={useEnhancedSessionWizard
                        ? t('settingsFeatures.enhancedSessionWizardEnabled')
                        : t('settingsFeatures.enhancedSessionWizardDisabled')}
                    icon={<Ionicons name="sparkles-outline" size={29} color="#AF52DE" />}
                    rightElement={<Switch value={useEnhancedSessionWizard} onValueChange={setUseEnhancedSessionWizard} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.machinePickerSearch')}
                    subtitle={t('settingsFeatures.machinePickerSearchSubtitle')}
                    icon={<Ionicons name="search-outline" size={29} color="#007AFF" />}
                    rightElement={<Switch value={useMachinePickerSearch} onValueChange={setUseMachinePickerSearch} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.pathPickerSearch')}
                    subtitle={t('settingsFeatures.pathPickerSearchSubtitle')}
                    icon={<Ionicons name="folder-outline" size={29} color="#007AFF" />}
                    rightElement={<Switch value={usePathPickerSearch} onValueChange={setUsePathPickerSearch} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.profiles')}
                    subtitle={useProfiles
                        ? t('settingsFeatures.profilesEnabled')
                        : t('settingsFeatures.profilesDisabled')}
                    icon={<Ionicons name="person-outline" size={29} color="#AF52DE" />}
                    rightElement={<Switch value={useProfiles} onValueChange={setUseProfiles} />}
                    showChevron={false}
                />
            </ItemGroup>

            {/* Web-only Features */}
            {Platform.OS === 'web' && (
                <ItemGroup
                    title={t('settingsFeatures.webFeatures')}
                    footer={t('settingsFeatures.webFeaturesDescription')}
                >
                    <Item
                        title={t('settingsFeatures.enterToSend')}
                        subtitle={agentInputEnterToSend ? t('settingsFeatures.enterToSendEnabled') : t('settingsFeatures.enterToSendDisabled')}
                        icon={<Ionicons name="return-down-forward-outline" size={29} color="#007AFF" />}
                        rightElement={<Switch value={agentInputEnterToSend} onValueChange={setAgentInputEnterToSend} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsFeatures.commandPalette')}
                        subtitle={commandPaletteEnabled ? t('settingsFeatures.commandPaletteEnabled') : t('settingsFeatures.commandPaletteDisabled')}
                        icon={<Ionicons name="keypad-outline" size={29} color="#007AFF" />}
                        rightElement={<Switch value={commandPaletteEnabled} onValueChange={setCommandPaletteEnabled} />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* Experiments last */}
            <ItemGroup
                title={t('settingsFeatures.experiments')}
                footer={t('settingsFeatures.experimentsDescription')}
            >
                <Item
                    title={t('settingsFeatures.experimentalFeatures')}
                    subtitle={experiments ? t('settingsFeatures.experimentalFeaturesEnabled') : t('settingsFeatures.experimentalFeaturesDisabled')}
                    icon={<Ionicons name="flask-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            value={experiments}
                            onValueChange={(next) => {
                                setExperiments(next);
                                // Requirement: toggling the master switch enables/disables all experiments by default.
                                setAllExperimentToggles(next);
                            }}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>

            {experiments && (
                <ItemGroup
                    title={t('settingsFeatures.experimentalOptions')}
                    footer={t('settingsFeatures.experimentalOptionsDescription')}
                >
                    <Item
                        title={t('settingsFeatures.expUsageReporting')}
                        subtitle={t('settingsFeatures.expUsageReportingSubtitle')}
                        icon={<Ionicons name="analytics-outline" size={29} color="#007AFF" />}
                        rightElement={<Switch value={expUsageReporting} onValueChange={setExpUsageReporting} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsFeatures.expGitOperations')}
                        subtitle={t('settingsFeatures.expGitOperationsSubtitle')}
                        icon={<Ionicons name="git-branch-outline" size={29} color="#FF9500" />}
                        rightElement={<Switch value={expGitOperations} onValueChange={setExpGitOperations} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsFeatures.expShowThinkingMessages')}
                        subtitle={t('settingsFeatures.expShowThinkingMessagesSubtitle')}
                        icon={<Ionicons name="chatbubbles-outline" size={29} color="#34C759" />}
                        rightElement={<Switch value={expShowThinkingMessages} onValueChange={setExpShowThinkingMessages} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsFeatures.expSessionType')}
                        subtitle={t('settingsFeatures.expSessionTypeSubtitle')}
                        icon={<Ionicons name="layers-outline" size={29} color="#AF52DE" />}
                        rightElement={<Switch value={expSessionType} onValueChange={setExpSessionType} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsFeatures.expZen')}
                        subtitle={t('settingsFeatures.expZenSubtitle')}
                        icon={<Ionicons name="leaf-outline" size={29} color="#34C759" />}
                        rightElement={<Switch value={expZen} onValueChange={setExpZen} />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
});
