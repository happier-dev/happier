import React from 'react';
import { FEATURE_IDS, featureRequiresServerSnapshot, getFeatureDependencies, isFeatureServerRepresented, type FeatureId } from '@happier-dev/protocol/features/catalog';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { Switch } from '@/components/ui/forms/Switch';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';
import { FeatureDiagnosticsPanel } from '@/components/settings/features/FeatureDiagnosticsPanel';
import {
    buildUiFeatureExperimentsChange,
    buildUiFeatureToggleChange,
    listUiFeatureToggleDefinitions,
    resolveUiFeatureToggleEnabled,
    type UiFeatureToggleDefinition,
} from '@/sync/domains/features/featureRegistry';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { useEffectiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import {
    useServerFeaturesMainSelectionSnapshot,
    useServerFeaturesRuntimeSnapshot,
} from '@/sync/domains/features/featureDecisionRuntime';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { settingRendersOnHost } from '@/components/settings/catalog/settingDeclarations';
import { FEATURES_SETTINGS, resolveFeatureToggleSetting } from '@/components/settings/features/featuresSettings';

export const WorkspaceRouteBody = React.memo(function FeaturesSettingsScreen() {
    const [experiments, setExperiments] = useSettingMutable('experiments');
    const [featureToggles, setFeatureToggles] = useSettingMutable('featureToggles');
    const [useProfiles, setUseProfiles] = useSettingMutable('useProfiles');
    const [commandPaletteEnabled, setCommandPaletteEnabled] = useSettingMutable('commandPaletteEnabled');
    const [terminalRendererPreference, setTerminalRendererPreference] = useLocalSettingMutable('terminalRendererPreference');
    const [useMachinePickerSearch, setUseMachinePickerSearch] = useSettingMutable('useMachinePickerSearch');
    const [usePathPickerSearch, setUsePathPickerSearch] = useSettingMutable('usePathPickerSearch');
    const [devModeEnabled] = useLocalSettingMutable('devModeEnabled');

    const toggleDefinitions = React.useMemo(() => listUiFeatureToggleDefinitions(), []);
    const selection = useEffectiveServerSelection();

    const shouldProbeServerForToggleVisibility = React.useMemo(() => {
        for (const def of toggleDefinitions) {
            if (getFeatureBuildPolicyDecision(def.featureId) === 'deny') continue;
            if (def.serverVisibilityScope === 'main_selection' && featureRequiresServerSnapshot(def.featureId)) return true;
        }
        return false;
    }, [toggleDefinitions]);
    const shouldProbeRuntimeServerForToggleVisibility = React.useMemo(() => {
        for (const def of toggleDefinitions) {
            if (getFeatureBuildPolicyDecision(def.featureId) === 'deny') continue;
            if (def.serverVisibilityScope === 'runtime' && featureRequiresServerSnapshot(def.featureId)) return true;
        }
        return false;
    }, [toggleDefinitions]);

    const serverSnapshot = useServerFeaturesMainSelectionSnapshot(selection.serverIds, { enabled: shouldProbeServerForToggleVisibility });
    const runtimeServerSnapshot = useServerFeaturesRuntimeSnapshot({ enabled: shouldProbeRuntimeServerForToggleVisibility });

    const serverProbeFeatureIdsByFeatureId = React.useMemo(() => {
        const memo = new Map<FeatureId, FeatureId[]>();

        const resolve = (featureId: FeatureId): FeatureId[] => {
            const cached = memo.get(featureId);
            if (cached) return cached;

            const serverFeatureIdSet = new Set<FeatureId>();
            const visited = new Set<FeatureId>();
            const queue: FeatureId[] = [featureId];

            while (queue.length > 0) {
                const current = queue.shift()!;
                if (visited.has(current)) continue;
                visited.add(current);

                if (isFeatureServerRepresented(current)) {
                    serverFeatureIdSet.add(current);
                }

                for (const dep of getFeatureDependencies(current)) {
                    queue.push(dep);
                }
            }

            const result = [...serverFeatureIdSet];
            memo.set(featureId, result);
            return result;
        };

        for (const def of toggleDefinitions) {
            resolve(def.featureId);
        }

        return memo;
    }, [toggleDefinitions]);

    const isKnownFeatureId = React.useCallback((featureId: unknown): featureId is FeatureId => {
        return typeof featureId === 'string' && (FEATURE_IDS as readonly string[]).includes(featureId);
    }, []);

    const isRuntimeFeatureHardDisabledByServer = React.useCallback(
        (featureId: FeatureId): boolean => {
            if (!isKnownFeatureId(featureId)) return false;
            if (!featureRequiresServerSnapshot(featureId)) return false;
            if (runtimeServerSnapshot.status === 'loading') return false;
            if (runtimeServerSnapshot.status === 'error') return false;
            if (runtimeServerSnapshot.status === 'unsupported') return true;

            const serverFeatureIdsToProbe = serverProbeFeatureIdsByFeatureId.get(featureId) ?? [];
            if (serverFeatureIdsToProbe.length === 0) return false;

            for (const serverFeatureId of serverFeatureIdsToProbe) {
                const enabled = readServerEnabledBit(runtimeServerSnapshot.features, serverFeatureId) === true;
                if (!enabled) return true;
            }

            return false;
        },
        [isKnownFeatureId, runtimeServerSnapshot, serverProbeFeatureIdsByFeatureId],
    );

    const isFeatureHardDisabledByServer = React.useCallback(
        (definition: UiFeatureToggleDefinition): boolean => {
            const featureId = definition.featureId;
            if (!isKnownFeatureId(featureId)) return false;
            if (!featureRequiresServerSnapshot(featureId)) return false;
            if (definition.serverVisibilityScope === 'runtime') {
                return isRuntimeFeatureHardDisabledByServer(featureId);
            }
            if (serverSnapshot.status !== 'ready') return false;
            if (serverSnapshot.serverIds.length === 0) return false;

            const serverFeatureIdsToProbe = serverProbeFeatureIdsByFeatureId.get(featureId) ?? [];
            if (serverFeatureIdsToProbe.length === 0) return false;

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

                for (const serverFeatureId of serverFeatureIdsToProbe) {
                    const enabled = readServerEnabledBit(snapshot.features, serverFeatureId) === true;
                    if (!enabled) return true;
                }
            }

            return false;
        },
        [isKnownFeatureId, isRuntimeFeatureHardDisabledByServer, serverProbeFeatureIdsByFeatureId, serverSnapshot],
    );

    const visibleToggleDefinitions = React.useMemo(() => {
        return toggleDefinitions.filter((d) => {
            if (getFeatureBuildPolicyDecision(d.featureId) === 'deny') return false;
            if (isFeatureHardDisabledByServer(d)) return false;
            return true;
        });
    }, [isFeatureHardDisabledByServer, toggleDefinitions]);

    const standardToggleDefinitions = visibleToggleDefinitions.filter((d) => !d.isExperimental);
    const experimentalToggleDefinitions = visibleToggleDefinitions.filter((d) => d.isExperimental);

    const seedExperimentalFeatureToggleDefaults = React.useCallback(() => {
        setFeatureToggles(buildUiFeatureExperimentsChange({ experiments, featureToggles }, true).featureToggles!);
    }, [experiments, featureToggles, setFeatureToggles]);

    const toggleSettings = React.useMemo(() => ({ experiments, featureToggles }), [experiments, featureToggles]);

    const toggleableFeatureIdSet = React.useMemo(() => {
        return new Set(toggleDefinitions.map((d) => d.featureId));
    }, [toggleDefinitions]);

    const isLocallyBlockedByDependencies = React.useCallback((featureId: FeatureId): boolean => {
        for (const dep of getFeatureDependencies(featureId)) {
            if (!toggleableFeatureIdSet.has(dep)) continue;
            if (!resolveUiFeatureToggleEnabled(toggleSettings, dep)) return true;
        }
        return false;
    }, [toggleSettings, toggleableFeatureIdSet]);

    const embeddedTerminalDockSettingVisible = React.useMemo(() => {
        const embeddedTerminalDockToggle =
            toggleDefinitions.find((definition) => definition.featureId === 'terminal.embeddedPty') ?? null;
        if (embeddedTerminalDockToggle && isFeatureHardDisabledByServer(embeddedTerminalDockToggle)) return false;
        if (isLocallyBlockedByDependencies('terminal.embeddedPty')) return false;
        return resolveUiFeatureToggleEnabled(toggleSettings, 'terminal.embeddedPty');
    }, [isFeatureHardDisabledByServer, isLocallyBlockedByDependencies, toggleDefinitions, toggleSettings]);

    const applyLocalToggleChange = React.useCallback((featureId: FeatureId, next: boolean) => {
        setFeatureToggles(buildUiFeatureToggleChange({ experiments, featureToggles }, featureId, next).featureToggles);
    }, [experiments, featureToggles, setFeatureToggles]);

    const renderToggleRow = (d: UiFeatureToggleDefinition) => {
        const blockedByDependencies = isLocallyBlockedByDependencies(d.featureId);
        const enabled = blockedByDependencies ? false : resolveUiFeatureToggleEnabled(toggleSettings, d.featureId);
        const setting = resolveFeatureToggleSetting(d.featureId);
        const row = (
            <Item
                title={t(d.titleKey)}
                subtitle={t(d.subtitleKey)}
                rightElement={
                    <Switch
                        testID={`settings-feature-toggle-${d.featureId}`}
                        value={enabled}
                        disabled={blockedByDependencies}
                        onValueChange={(next) => applyLocalToggleChange(d.featureId, next)}
                    />
                }
                showChevron={false}
            />
        );
        return setting ? <SettingAnchor key={d.featureId} setting={setting}>{row}</SettingAnchor> : <React.Fragment key={d.featureId}>{row}</React.Fragment>;
    };

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settings.featuresSubtitle')} />
            <ItemGroup
                title={t(FEATURES_SETTINGS.sections.general.titleKey)}
                description={t('settingsFeatures.generalDescription')}
            >
                <SettingRow
                    setting={FEATURES_SETTINGS.settings.machinePickerSearch}
                    rightElement={<Switch value={useMachinePickerSearch} onValueChange={setUseMachinePickerSearch} />}
                    showChevron={false}
                />
                <SettingRow
                    setting={FEATURES_SETTINGS.settings.pathPickerSearch}
                    rightElement={<Switch value={usePathPickerSearch} onValueChange={setUsePathPickerSearch} />}
                    showChevron={false}
                />
                <SettingRow
                    setting={FEATURES_SETTINGS.settings.profiles}
                    subtitle={useProfiles
                        ? t('settingsFeatures.profilesEnabled')
                        : t('settingsFeatures.profilesDisabled')}
                    rightElement={<Switch value={useProfiles} onValueChange={setUseProfiles} />}
                    showChevron={false}
                />
            </ItemGroup>

            {standardToggleDefinitions.length > 0 && (
                // The terminal rows need the embedded terminal on; the section shows its switch.
                <SettingSection section={FEATURES_SETTINGS.sectionRefs.optionalFeatures}>
                <ItemGroup
                    title={t(FEATURES_SETTINGS.sections.optionalFeatures.titleKey)}
                    description={t('settingsFeatures.localTogglesFooter')}
                >
                    {standardToggleDefinitions.flatMap((d) => {
                        const rows = [renderToggleRow(d)];
                        if (d.featureId !== 'terminal.embeddedPty' || !embeddedTerminalDockSettingVisible) return rows;
                        // How the terminal draws belongs right under the terminal itself.
                        if (settingRendersOnHost(FEATURES_SETTINGS.settings.terminalRenderer)) {
                            rows.push(
                                <SettingAnchor key="terminalRenderer" setting={FEATURES_SETTINGS.settings.terminalRenderer}>
                                    <SegmentedChoiceItem<'auto' | 'xterm-webview' | 'native'>
                                        testID="settings-terminal-renderer-preference"
                                        testIDPrefix="settings-terminal-renderer-preference"
                                        title={t(FEATURES_SETTINGS.settings.terminalRenderer.titleKey)}
                                        options={[
                                            { id: 'auto', label: t('terminalEmbedded.settings.rendererAuto'), description: t('terminalEmbedded.settings.rendererAutoDescription') },
                                            { id: 'xterm-webview', label: t('terminalEmbedded.settings.rendererXtermWebView'), description: t('terminalEmbedded.settings.rendererXtermWebViewDescription') },
                                            { id: 'native', label: t('terminalEmbedded.settings.rendererNative'), description: t('terminalEmbedded.settings.rendererNativeDescription') },
                                        ]}
                                        value={terminalRendererPreference === 'xterm-webview' || terminalRendererPreference === 'native'
                                            ? terminalRendererPreference
                                            : 'auto'}
                                        onChange={setTerminalRendererPreference}
                                    />
                                </SettingAnchor>,
                            );
                        }
                        return rows;
                    })}
                </ItemGroup>
                </SettingSection>
            )}

            {/* Web-only features */}
            {settingRendersOnHost(FEATURES_SETTINGS.settings.commandPalette) && (
                <ItemGroup
                    title={t(FEATURES_SETTINGS.sections.webFeatures.titleKey)}
                    description={t('settingsFeatures.webFeaturesDescription')}
                >
                    <SettingRow
                        setting={FEATURES_SETTINGS.settings.commandPalette}
                        subtitle={commandPaletteEnabled ? t('settingsFeatures.commandPaletteEnabled') : t('settingsFeatures.commandPaletteDisabled')}
                        rightElement={<Switch value={commandPaletteEnabled} onValueChange={setCommandPaletteEnabled} />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* Experiments last: the switch, then the experimental features it unlocks. */}
            <SettingSection section={FEATURES_SETTINGS.sectionRefs.experiments}>
            <ItemGroup
                title={t(FEATURES_SETTINGS.sections.experiments.titleKey)}
                description={t('settingsFeatures.experimentsDescription')}
            >
                <SettingRow
                    setting={FEATURES_SETTINGS.settings.experimentalFeatures}
                    subtitle={experiments ? t('settingsFeatures.experimentalFeaturesEnabled') : t('settingsFeatures.experimentalFeaturesDisabled')}
                    rightElement={
                        <Switch
                            testID="settings-feature-experiments-toggle"
                            value={experiments}
                            onValueChange={(next) => {
                                setExperiments(next);
                                if (next) {
                                    // Seed each experimental toggle from its own registry default.
                                    seedExperimentalFeatureToggleDefaults();
                                }
                            }}
                        />
                    }
                    showChevron={false}
                />
                {experiments ? experimentalToggleDefinitions.map(renderToggleRow) : null}
            </ItemGroup>
            </SettingSection>

            {(__DEV__ || devModeEnabled) && (
                <FeatureDiagnosticsPanel featureIds={FEATURE_IDS} />
            )}
        </ItemList>
    );
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
