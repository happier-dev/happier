import React from 'react';
import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FEATURE_IDS, featureRequiresServerSnapshot, readServerEnabledBit, type FeatureId } from '@happier-dev/protocol';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { Switch } from '@/components/ui/forms/Switch';
import { t } from '@/text';
import { Modal } from '@/modal';
import { FeatureDiagnosticsPanel } from '@/components/settings/features/FeatureDiagnosticsPanel';
import {
    buildUiFeatureToggleDefaults,
    listUiFeatureToggleDefinitions,
    resolveUiFeatureToggleEnabled,
} from '@/sync/domains/features/featureRegistry';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { useEffectiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { useServerFeaturesMainSelectionSnapshot } from '@/sync/domains/features/featureDecisionRuntime';

export default React.memo(function FeaturesSettingsScreen() {
    const [experiments, setExperiments] = useSettingMutable('experiments');
    const [featureToggles, setFeatureToggles] = useSettingMutable('featureToggles');
    const [useProfiles, setUseProfiles] = useSettingMutable('useProfiles');
    const [agentInputEnterToSend, setAgentInputEnterToSend] = useSettingMutable('agentInputEnterToSend');
    const [agentInputHistoryScope, setAgentInputHistoryScope] = useSettingMutable('agentInputHistoryScope');
    const [commandPaletteEnabled, setCommandPaletteEnabled] = useLocalSettingMutable('commandPaletteEnabled');
    const [markdownCopyV2, setMarkdownCopyV2] = useLocalSettingMutable('markdownCopyV2');
    const [showEnvironmentBadge, setShowEnvironmentBadge] = useSettingMutable('showEnvironmentBadge');
    const [useEnhancedSessionWizard, setUseEnhancedSessionWizard] = useSettingMutable('useEnhancedSessionWizard');
    const [useMachinePickerSearch, setUseMachinePickerSearch] = useSettingMutable('useMachinePickerSearch');
    const [usePathPickerSearch, setUsePathPickerSearch] = useSettingMutable('usePathPickerSearch');
    const [devModeEnabled] = useLocalSettingMutable('devModeEnabled');

    const toggleDefinitions = React.useMemo(() => listUiFeatureToggleDefinitions(), []);
    const selection = useEffectiveServerSelection();

    const shouldProbeServerForToggleVisibility = React.useMemo(() => {
        for (const def of toggleDefinitions) {
            if (getFeatureBuildPolicyDecision(def.featureId) === 'deny') continue;
            if (featureRequiresServerSnapshot(def.featureId)) return true;
        }
        return false;
    }, [toggleDefinitions]);

    const serverSnapshot = useServerFeaturesMainSelectionSnapshot(selection.serverIds, { enabled: shouldProbeServerForToggleVisibility });

    const isToggleHardDisabledByServer = React.useCallback(
        (featureId: FeatureId): boolean => {
            if (!featureRequiresServerSnapshot(featureId)) return false;
            if (serverSnapshot.status !== 'ready') return false;
            if (serverSnapshot.serverIds.length === 0) return false;

            for (const serverId of serverSnapshot.serverIds) {
                const snapshot = serverSnapshot.snapshotsByServerId[serverId];
                if (!snapshot) {
                    // Unexpected in ready state; do not hide based on incomplete data.
                    return false;
                }
                if (snapshot.status === 'error') {
                    // Probe failures are not definitive; keep the toggle visible.
                    return false;
                }
                if (snapshot.status === 'unsupported') {
                    return true;
                }

                const enabled = readServerEnabledBit(snapshot.features, featureId) === true;
                if (!enabled) return true;
            }

            return false;
        },
        [serverSnapshot],
    );

    const visibleToggleDefinitions = React.useMemo(() => {
        return toggleDefinitions.filter((d) => {
            if (getFeatureBuildPolicyDecision(d.featureId) === 'deny') return false;
            if (isToggleHardDisabledByServer(d.featureId)) return false;
            return true;
        });
    }, [isToggleHardDisabledByServer, toggleDefinitions]);

    const standardToggleDefinitions = visibleToggleDefinitions.filter((d) => !d.isExperimental);
    const experimentalToggleDefinitions = visibleToggleDefinitions.filter((d) => d.isExperimental);

    const seedExperimentalFeatureToggleDefaults = React.useCallback(() => {
        const defaults = buildUiFeatureToggleDefaults({ experimentalOnly: true });
        setFeatureToggles({
            ...(featureToggles ?? {}),
            ...defaults,
        });
    }, [featureToggles, setFeatureToggles]);

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
                    title={t('settingsFeatures.environmentBadge')}
                    subtitle={t('settingsFeatures.environmentBadgeSubtitle')}
                    icon={<Ionicons name="pricetag-outline" size={29} color="#5856D6" />}
                    rightElement={<Switch value={showEnvironmentBadge} onValueChange={setShowEnvironmentBadge} />}
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
                        title={t('settingsFeatures.historyScope')}
                        subtitle={agentInputHistoryScope === 'global'
                            ? t('settingsFeatures.historyScopeGlobal')
                            : t('settingsFeatures.historyScopePerSession')}
                        icon={<Ionicons name="time-outline" size={29} color="#007AFF" />}
                        showChevron={true}
                        onPress={async () => {
                            const wantsGlobal = await Modal.confirm(
                                t('settingsFeatures.historyScopeModalTitle'),
                                t('settingsFeatures.historyScopeModalMessage'),
                                {
                                    cancelText: t('settingsFeatures.historyScopePerSessionOption'),
                                    confirmText: t('settingsFeatures.historyScopeGlobalOption'),
                                }
                            );
                            setAgentInputHistoryScope(wantsGlobal ? 'global' : 'perSession');
                        }}
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
                                if (next) {
                                    // Requirement: toggling the master switch enables all experimental toggles by default.
                                    seedExperimentalFeatureToggleDefaults();
                                }
                            }}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>

            {standardToggleDefinitions.length > 0 && (
                <ItemGroup
                    title="Features"
                    footer="Per-feature local toggles (independent of server support)."
                >
                    {standardToggleDefinitions.map((d) => {
                        const enabled = resolveUiFeatureToggleEnabled({ experiments, featureToggles }, d.featureId);

                        return (
                            <Item
                                key={d.featureId}
                                title={t(d.titleKey)}
                                subtitle={t(d.subtitleKey)}
                                icon={<Ionicons name={d.icon.ioniconName as keyof typeof Ionicons.glyphMap} size={29} color={d.icon.color} />}
                                rightElement={
                                    <Switch
                                        value={enabled}
                                        onValueChange={(next) => {
                                            setFeatureToggles({
                                                ...(featureToggles ?? {}),
                                                [d.featureId]: next,
                                            });
                                        }}
                                    />
                                }
                                showChevron={false}
                            />
                        );
                    })}
                </ItemGroup>
            )}

            {experiments && experimentalToggleDefinitions.length > 0 && (
                <ItemGroup
                    title={t('settingsFeatures.experimentalOptions')}
                    footer={t('settingsFeatures.experimentalOptionsDescription')}
                >
                    {experimentalToggleDefinitions.map((d) => {
                        const enabled = resolveUiFeatureToggleEnabled({ experiments, featureToggles }, d.featureId);

                        return (
                            <Item
                                key={d.featureId}
                                title={t(d.titleKey)}
                                subtitle={t(d.subtitleKey)}
                                icon={<Ionicons name={d.icon.ioniconName as keyof typeof Ionicons.glyphMap} size={29} color={d.icon.color} />}
                                rightElement={
                                    <Switch
                                        value={enabled}
                                        onValueChange={(next) => {
                                            setFeatureToggles({
                                                ...(featureToggles ?? {}),
                                                [d.featureId]: next,
                                            });
                                        }}
                                    />
                                }
                                showChevron={false}
                            />
                        );
                    })}
                </ItemGroup>
            )}

            {(__DEV__ || devModeEnabled) && (
                <FeatureDiagnosticsPanel featureIds={FEATURE_IDS} />
            )}
        </ItemList>
    );
});
