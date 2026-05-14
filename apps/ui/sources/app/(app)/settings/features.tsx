import React from 'react';
import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import {
    FEATURE_IDS,
    featureRequiresServerSnapshot,
    getFeatureDependencies,
    isFeatureServerRepresented,
    readServerEnabledBit,
    type FeatureId,
} from '@happier-dev/protocol';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { FeatureDiagnosticsPanel } from '@/components/settings/features/FeatureDiagnosticsPanel';
import {
    buildUiFeatureToggleDefaults,
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

export default React.memo(function FeaturesSettingsScreen() {
    const { theme } = useUnistyles();
    const [experiments, setExperiments] = useSettingMutable('experiments');
    const [featureToggles, setFeatureToggles] = useSettingMutable('featureToggles');
    const [useProfiles, setUseProfiles] = useSettingMutable('useProfiles');
    const [commandPaletteEnabled, setCommandPaletteEnabled] = useSettingMutable('commandPaletteEnabled');
    const [embeddedTerminalDockLocation, setEmbeddedTerminalDockLocation] = useLocalSettingMutable('embeddedTerminalDockLocation');
    const [showEnvironmentBadge, setShowEnvironmentBadge] = useSettingMutable('showEnvironmentBadge');
    const [useMachinePickerSearch, setUseMachinePickerSearch] = useSettingMutable('useMachinePickerSearch');
    const [usePathPickerSearch, setUsePathPickerSearch] = useSettingMutable('usePathPickerSearch');
    const [devModeEnabled] = useLocalSettingMutable('devModeEnabled');

    const toggleDefinitions = React.useMemo(() => listUiFeatureToggleDefinitions(), []);
    const selection = useEffectiveServerSelection();

    const resolveLegacyIconColor = React.useCallback((color: string): string => {
        const normalized = String(color).trim().toUpperCase();
        switch (normalized) {
            case '#007AFF':
            case '#0A84FF':
                return theme.colors.accent.blue;
            case '#34C759':
            case '#32D74B':
                return theme.colors.state.success.foreground;
            case '#FF9500':
            case '#FF9F0A':
                return theme.colors.accent.orange;
            case '#AF52DE':
            case '#BF5AF2':
                return theme.colors.accent.purple;
            case '#5856D6':
            case '#5E5CE6':
                return theme.colors.accent.indigo;
            case '#FF3B30':
            case '#FF453A':
                return theme.colors.state.danger.foreground;
            case '#FFCC00':
            case '#FFD60A':
                return theme.colors.accent.yellow;
            default:
                return color;
        }
    }, [
        theme.colors.accent.blue,
        theme.colors.accent.indigo,
        theme.colors.accent.orange,
        theme.colors.accent.purple,
        theme.colors.accent.yellow,
        theme.colors.state.success.foreground,
        theme.colors.state.danger.foreground,
    ]);

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
    const [embeddedTerminalDockMenuOpen, setEmbeddedTerminalDockMenuOpen] = React.useState(false);

    const seedExperimentalFeatureToggleDefaults = React.useCallback(() => {
        const defaults = buildUiFeatureToggleDefaults({ experimentalOnly: true });
        setFeatureToggles({
            ...(featureToggles ?? {}),
            ...defaults,
        });
    }, [featureToggles, setFeatureToggles]);

    const toggleSettings = React.useMemo(() => ({ experiments, featureToggles }), [experiments, featureToggles]);

    const toggleableFeatureIdSet = React.useMemo(() => {
        return new Set(toggleDefinitions.map((d) => d.featureId));
    }, [toggleDefinitions]);

    const dependentsByFeatureId = React.useMemo(() => {
        const map = new Map<FeatureId, FeatureId[]>();
        for (const def of toggleDefinitions) {
            map.set(def.featureId, []);
        }
        for (const def of toggleDefinitions) {
            for (const dep of getFeatureDependencies(def.featureId)) {
                if (!toggleableFeatureIdSet.has(dep)) continue;
                const list = map.get(dep);
                if (list) list.push(def.featureId);
            }
        }
        return map;
    }, [toggleDefinitions, toggleableFeatureIdSet]);

    const isLocallyBlockedByDependencies = React.useCallback((featureId: FeatureId): boolean => {
        for (const dep of getFeatureDependencies(featureId)) {
            if (!toggleableFeatureIdSet.has(dep)) continue;
            if (!resolveUiFeatureToggleEnabled(toggleSettings, dep)) return true;
        }
        return false;
    }, [toggleSettings, toggleableFeatureIdSet]);

    const embeddedTerminalDockSettingVisible = React.useMemo(() => {
        if (!experiments) return false;
        const embeddedTerminalDockToggle =
            toggleDefinitions.find((definition) => definition.featureId === 'terminal.embeddedPty') ?? null;
        if (embeddedTerminalDockToggle && isFeatureHardDisabledByServer(embeddedTerminalDockToggle)) return false;
        if (isLocallyBlockedByDependencies('terminal.embeddedPty')) return false;
        return resolveUiFeatureToggleEnabled(toggleSettings, 'terminal.embeddedPty');
    }, [experiments, isFeatureHardDisabledByServer, isLocallyBlockedByDependencies, toggleDefinitions, toggleSettings]);

    const embeddedTerminalDockLocationLabel = React.useMemo(() => {
        switch (embeddedTerminalDockLocation) {
            case 'details':
                return t('terminalEmbedded.location.details');
            case 'bottom':
                return t('terminalEmbedded.location.bottom');
            case 'sidebar':
            default:
                return t('terminalEmbedded.location.sidebar');
        }
    }, [embeddedTerminalDockLocation]);

    const applyLocalToggleChange = React.useCallback((featureId: FeatureId, next: boolean) => {
        const nextToggles: Record<string, boolean> = {
            ...(featureToggles ?? {}),
            [featureId]: next,
        };

        if (!next) {
            const queue: FeatureId[] = [featureId];
            const visited = new Set<FeatureId>(queue);
            while (queue.length > 0) {
                const current = queue.shift()!;
                for (const dependent of dependentsByFeatureId.get(current) ?? []) {
                    if (visited.has(dependent)) continue;
                    visited.add(dependent);
                    nextToggles[dependent] = false;
                    queue.push(dependent);
                }
            }
        }

        setFeatureToggles(nextToggles);
    }, [dependentsByFeatureId, featureToggles, setFeatureToggles]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Standard feature toggles first */}
            <ItemGroup>
                <Item
                    title={t('settingsFeatures.environmentBadge')}
                    subtitle={t('settingsFeatures.environmentBadgeSubtitle')}
                    icon={<Ionicons name="pricetag-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={<Switch value={showEnvironmentBadge} onValueChange={setShowEnvironmentBadge} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.machinePickerSearch')}
                    subtitle={t('settingsFeatures.machinePickerSearchSubtitle')}
                    icon={<Ionicons name="search-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={<Switch value={useMachinePickerSearch} onValueChange={setUseMachinePickerSearch} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.pathPickerSearch')}
                    subtitle={t('settingsFeatures.pathPickerSearchSubtitle')}
                    icon={<Ionicons name="folder-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={<Switch value={usePathPickerSearch} onValueChange={setUsePathPickerSearch} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.profiles')}
                    subtitle={useProfiles
                        ? t('settingsFeatures.profilesEnabled')
                        : t('settingsFeatures.profilesDisabled')}
                    icon={<Ionicons name="person-outline" size={29} color={theme.colors.accent.purple} />}
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
                        title={t('settingsFeatures.commandPalette')}
                        subtitle={commandPaletteEnabled ? t('settingsFeatures.commandPaletteEnabled') : t('settingsFeatures.commandPaletteDisabled')}
                        icon={<Ionicons name="keypad-outline" size={29} color={theme.colors.accent.blue} />}
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
                    icon={<Ionicons name="flask-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={
                        <Switch
                            testID="settings-feature-experiments-toggle"
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
                    title={t('settingsFeatures.localTogglesTitle')}
                    footer={t('settingsFeatures.localTogglesFooter')}
                >
                    {standardToggleDefinitions.map((d) => {
                        const blockedByDependencies = isLocallyBlockedByDependencies(d.featureId);
                        const enabled = blockedByDependencies ? false : resolveUiFeatureToggleEnabled(toggleSettings, d.featureId);

                        return (
                            <Item
                                key={d.featureId}
                                title={t(d.titleKey)}
                                subtitle={t(d.subtitleKey)}
                                icon={<Ionicons name={d.icon.ioniconName as keyof typeof Ionicons.glyphMap} size={29} color={resolveLegacyIconColor(d.icon.color)} />}
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
                    })}
                </ItemGroup>
            )}

            {experiments && experimentalToggleDefinitions.length > 0 && (
                <ItemGroup
                    title={t('settingsFeatures.experimentalOptions')}
                    footer={t('settingsFeatures.experimentalOptionsDescription')}
                >
                    {embeddedTerminalDockSettingVisible ? (
                        <DropdownMenu
                            open={embeddedTerminalDockMenuOpen}
                            onOpenChange={setEmbeddedTerminalDockMenuOpen}
                            variant="selectable"
                            search={false}
                            selectedId={embeddedTerminalDockLocation}
                            showCategoryTitles={false}
                            matchTriggerWidth={true}
                            connectToTrigger={true}
                            rowKind="item"
                            itemTrigger={{
                                title: t('terminalEmbedded.settings.locationTitle'),
                                subtitle: embeddedTerminalDockLocationLabel,
                                icon: <Ionicons name="terminal-outline" size={29} color={theme.colors.accent.blue} />,
                                itemProps: { testID: 'settings-embedded-terminal-dock-location' },
                            }}
                            items={[
                                { id: 'sidebar', title: t('terminalEmbedded.location.sidebar'), icon: <Ionicons name="albums-outline" size={18} color={theme.colors.text.secondary} /> },
                                { id: 'details', title: t('terminalEmbedded.location.details'), icon: <Ionicons name="information-circle-outline" size={18} color={theme.colors.text.secondary} /> },
                                { id: 'bottom', title: t('terminalEmbedded.location.bottom'), icon: <Ionicons name="reorder-four-outline" size={18} color={theme.colors.text.secondary} /> },
                            ]}
                            onSelect={(id) => {
                                if (id === 'sidebar' || id === 'details' || id === 'bottom') {
                                    setEmbeddedTerminalDockLocation(id);
                                }
                                setEmbeddedTerminalDockMenuOpen(false);
                            }}
                        />
                    ) : null}

                    {experimentalToggleDefinitions.map((d) => {
                        const blockedByDependencies = isLocallyBlockedByDependencies(d.featureId);
                        const enabled = blockedByDependencies ? false : resolveUiFeatureToggleEnabled(toggleSettings, d.featureId);

                        return (
                            <Item
                                key={d.featureId}
                                title={t(d.titleKey)}
                                subtitle={t(d.subtitleKey)}
                                icon={<Ionicons name={d.icon.ioniconName as keyof typeof Ionicons.glyphMap} size={29} color={resolveLegacyIconColor(d.icon.color)} />}
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
                    })}
                </ItemGroup>
            )}

            {(__DEV__ || devModeEnabled) && (
                <FeatureDiagnosticsPanel featureIds={FEATURE_IDS} />
            )}
        </ItemList>
    );
});
