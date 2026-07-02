import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';

import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { fetchDaemonMemorySettings, writeDaemonMemorySettings } from '@/sync/domains/memory/fetchDaemonMemorySettings';
import { useAllMachines } from '@/sync/domains/state/storage';
import { fetchDaemonMemoryStatus } from '@/sync/domains/memory/fetchDaemonMemoryStatus';
import { getDaemonMemoryStatusStateTranslationKey } from '@/sync/domains/memory/getDaemonMemoryStatusStateTranslationKey';
import { getDaemonMemoryEmbeddingsStatusTranslationKey } from '@/sync/domains/memory/getDaemonMemoryEmbeddingsStatusTranslationKey';
import { presentDaemonMemoryStatus } from '@/sync/domains/memory/presentDaemonMemoryStatus';
import { presentDaemonMemoryEmbeddingsStatus } from '@/sync/domains/memory/presentDaemonMemoryEmbeddingsStatus';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

import {
    DEFAULT_MEMORY_SETTINGS,
    type MemorySettingsV1,
    type MemoryStatusV1,
} from '@happier-dev/protocol';
import { MemorySettingsBudgetsSection } from './MemorySettingsBudgetsSection';
import { MemorySettingsContentPolicySection } from './MemorySettingsContentPolicySection';
import { MemorySettingsCoverageSection } from './MemorySettingsCoverageSection';
import { MemorySettingsEmbeddingsSection } from './MemorySettingsEmbeddingsSection';
import { MemorySettingsIndexTelemetrySection } from './MemorySettingsIndexTelemetrySection';
import { MemorySettingsPrivacySection } from './MemorySettingsPrivacySection';

type IndexMode = MemorySettingsV1['indexMode'];

export const MemorySettingsView = React.memo(function MemorySettingsView() {
    const { theme } = useUnistyles();
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const machines = useAllMachines();
    const activeServerSnapshot = getActiveServerSnapshot();
    const serverId = activeServerSnapshot.serverId;

    const [selectedMachineId, setSelectedMachineId] = React.useState<string>(() => machines[0]?.id ?? '');
    const [settings, setSettings] = React.useState<MemorySettingsV1>(() => DEFAULT_MEMORY_SETTINGS);
    const [settingsRpcSupported, setSettingsRpcSupported] = React.useState(true);
    const [memoryStatus, setMemoryStatus] = React.useState<MemoryStatusV1 | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);
    const [indexModeMenuOpen, setIndexModeMenuOpen] = React.useState(false);
    const [backfillMenuOpen, setBackfillMenuOpen] = React.useState(false);
    const [summarizerPermissionMenuOpen, setSummarizerPermissionMenuOpen] = React.useState(false);

    React.useEffect(() => {
        if (!machines.find((m) => m.id === selectedMachineId)) {
            setSelectedMachineId(machines[0]?.id ?? '');
        }
    }, [machines, selectedMachineId]);

    const fetchSettings = React.useCallback(async () => {
        if (!memorySearchEnabled) return;
        if (!serverId || !selectedMachineId) return;
        setLoading(true);
        setMemoryStatus(null);
        try {
            const [settingsResult, status] = await Promise.all([
                fetchDaemonMemorySettings({
                    machineId: selectedMachineId,
                    serverId,
                }),
                fetchDaemonMemoryStatus({
                    machineId: selectedMachineId,
                    serverId,
                }).catch(() => null),
            ]);
            setSettings(settingsResult.settings);
            setSettingsRpcSupported(settingsResult.supported);
            setMemoryStatus(status);
        } finally {
            setLoading(false);
        }
    }, [memorySearchEnabled, selectedMachineId, serverId]);

    React.useEffect(() => {
        if (!memorySearchEnabled) return;
        void fetchSettings();
    }, [fetchSettings, memorySearchEnabled]);

    const writeSettings = React.useCallback(async (next: MemorySettingsV1) => {
        if (!memorySearchEnabled) return;
        if (!serverId || !selectedMachineId) return;
        const result = await writeDaemonMemorySettings({
            machineId: selectedMachineId,
            serverId,
            settings: next,
        });
        setSettings(result.settings);
        setSettingsRpcSupported(result.supported);
        if (!result.supported) {
            return;
        }
        const status = await fetchDaemonMemoryStatus({
            machineId: selectedMachineId,
            serverId,
        }).catch(() => null);
        setMemoryStatus(status);
    }, [memorySearchEnabled, selectedMachineId, serverId]);

    const machineItems = React.useMemo(() => {
        return machines.map((m) => ({
            id: m.id,
            title: m.metadata?.displayName || m.metadata?.host || m.id,
            subtitle: m.metadata?.host || undefined,
            icon: <Ionicons name="desktop-outline" size={20} color={theme.colors.text.secondary} />,
        }));
    }, [machines, theme.colors.text.secondary]);

    const indexModeItems = [
        { id: 'hints', title: t('memorySearchSettings.indexMode.options.lightTitle'), subtitle: t('memorySearchSettings.indexMode.options.lightSubtitle') },
        { id: 'deep', title: t('memorySearchSettings.indexMode.options.deepTitle'), subtitle: t('memorySearchSettings.indexMode.options.deepSubtitle') },
    ] as const;

    const backfillItems = [
        { id: 'new_only', title: t('memorySearchSettings.backfill.options.newOnlyTitle'), subtitle: t('memorySearchSettings.backfill.options.newOnlySubtitle') },
        { id: 'last_30_days', title: t('memorySearchSettings.backfill.options.last30DaysTitle'), subtitle: t('memorySearchSettings.backfill.options.last30DaysSubtitle') },
        { id: 'all_history', title: t('memorySearchSettings.backfill.options.allHistoryTitle'), subtitle: t('memorySearchSettings.backfill.options.allHistorySubtitle') },
    ] as const;

    const summarizerPermissionItems = [
        { id: 'no_tools', title: t('memorySearchSettings.hints.permissions.options.noToolsTitle'), subtitle: t('memorySearchSettings.hints.permissions.options.noToolsSubtitle') },
        { id: 'read_only', title: t('memorySearchSettings.hints.permissions.options.readOnlyTitle'), subtitle: t('memorySearchSettings.hints.permissions.options.readOnlySubtitle') },
    ] as const;

    const selectedMachineTitle = React.useMemo(() => {
        const machine = machines.find((m) => m.id === selectedMachineId);
        const label = machine?.metadata?.displayName || machine?.metadata?.host || selectedMachineId;
        return label && label.trim().length > 0 ? label : t('memorySearchSettings.machine.noMachine');
    }, [machines, selectedMachineId]);

    const statusPresentation = React.useMemo(() => presentDaemonMemoryStatus(memoryStatus), [memoryStatus]);
    const embeddingsStatusPresentation = React.useMemo(
        () => presentDaemonMemoryEmbeddingsStatus(memoryStatus),
        [memoryStatus],
    );
    const statusSubtitle = React.useMemo(() => {
        if (loading && !statusPresentation) return t('common.loading');
        return t(getDaemonMemoryStatusStateTranslationKey(statusPresentation));
    }, [loading, statusPresentation]);
    const embeddingsStatusSubtitle = React.useMemo(() => {
        if (loading && !embeddingsStatusPresentation) return t('common.loading');
        return t(getDaemonMemoryEmbeddingsStatusTranslationKey(embeddingsStatusPresentation));
    }, [embeddingsStatusPresentation, loading]);
    const diskUsageSubtitle = React.useMemo(() => {
        if (!statusPresentation) return t('memorySearchSettings.status.diskUsageUnavailable');
        return t('memorySearchSettings.status.diskUsageFormatted', {
            light: statusPresentation.lightSize ?? t('common.unavailable'),
            deep: statusPresentation.deepSize ?? t('common.unavailable'),
        });
    }, [statusPresentation]);
    const showEmbeddingsStatus = (memoryStatus?.indexMode ?? settings.indexMode) === 'deep';
    const embeddingsProviderSubtitle = React.useMemo(() => {
        const providerKind = embeddingsStatusPresentation?.providerKind;
        if (providerKind === 'local_transformers') {
            return t('memorySearchSettings.status.embeddingsProviderLocal');
        }
        if (providerKind === 'openai_compatible') {
            return t('memorySearchSettings.status.embeddingsProviderOpenAiCompatible');
        }
        return t('common.unavailable');
    }, [embeddingsStatusPresentation?.providerKind]);
    const embeddingsModelSubtitle = React.useMemo(() => {
        return embeddingsStatusPresentation?.modelId ?? t('common.unavailable');
    }, [embeddingsStatusPresentation?.modelId]);
    const showReadOnlySettings = settingsRpcSupported !== true;

    if (!memorySearchEnabled) {
        return (
            <ItemList style={{ paddingTop: 0 }}>
                <ItemGroup
                    title={t('settings.memorySearch')}
                    footer={t('memorySearchSettings.disabled.footer')}
                >
                    <Item
                        title={t('memorySearchSettings.disabled.title')}
                        subtitle={t('memorySearchSettings.disabled.subtitle')}
                        icon={<Ionicons name="search-outline" size={29} color={theme.colors.state.success.foreground} />}
                        onPress={() => { void Modal.alert(t('memorySearchSettings.disabled.alertTitle'), t('memorySearchSettings.disabled.alertBody')); }}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settings.memorySearch')}
                footer={showReadOnlySettings ? t('common.unavailable') : t('memorySearchSettings.enabled.footer')}
            >
                <Item
                    title={t('memorySearchSettings.machine.title')}
                    subtitle={selectedMachineTitle}
                    icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={loading ? <Text>{t('common.loading')}</Text> : null}
                    showChevron={false}
                />
                <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
                    <DropdownMenu
                        open={machineMenuOpen}
                        onOpenChange={setMachineMenuOpen}
                        selectedId={selectedMachineId}
                        search={true}
                        items={machineItems}
                        onSelect={(id) => {
                            setSelectedMachineId(id);
                            setMachineMenuOpen(false);
                        }}
                        itemTrigger={{
                            title: t('memorySearchSettings.machine.changeTitle'),
                            icon: <Ionicons name="swap-horizontal-outline" size={29} color={theme.colors.accent.indigo} />,
                        }}
                    />
                </View>
                <Item
                    title={t('memorySearchSettings.enabled.title')}
                    subtitle={showReadOnlySettings ? t('common.unavailable') : t('memorySearchSettings.enabled.subtitle')}
                    icon={<Ionicons name="search-outline" size={29} color={theme.colors.state.success.foreground} />}
                    rightElement={showReadOnlySettings ? null : (
                        <Switch
                            value={settings.enabled}
                            onValueChange={(value) => {
                                void writeSettings({ ...settings, enabled: Boolean(value) });
                            }}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('memorySearchSettings.status.title')}
                    subtitle={statusSubtitle}
                    icon={<Ionicons name="analytics-outline" size={29} color={theme.colors.accent.orange} />}
                    showChevron={false}
                />
                <Item
                    title={t('memorySearchSettings.status.diskUsageTitle')}
                    subtitle={diskUsageSubtitle}
                    icon={<Ionicons name="hardware-chip-outline" size={29} color={theme.colors.accent.purple} />}
                    showChevron={false}
                />
                {showEmbeddingsStatus ? (
                    <>
                        <Item
                            title={t('memorySearchSettings.status.embeddingsTitle')}
                            subtitle={embeddingsStatusSubtitle}
                            icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.accent.indigo} />}
                            showChevron={false}
                        />
                        <Item
                            title={t('memorySearchSettings.status.embeddingsProviderTitle')}
                            subtitle={embeddingsProviderSubtitle}
                            icon={<Ionicons name="cloud-outline" size={29} color={theme.colors.accent.blue} />}
                            showChevron={false}
                        />
                        <Item
                            title={t('memorySearchSettings.status.embeddingsModelTitle')}
                            subtitle={embeddingsModelSubtitle}
                            icon={<Ionicons name="cube-outline" size={29} color={theme.colors.accent.purple} />}
                            showChevron={false}
                        />
                    </>
                ) : null}
            </ItemGroup>

            <MemorySettingsIndexTelemetrySection memoryStatus={memoryStatus} />

            {showReadOnlySettings ? null : (
                <>
            <ItemGroup
                title={t('memorySearchSettings.indexMode.title')}
                footer={t('memorySearchSettings.indexMode.footer')}
            >
                <DropdownMenu
                    open={indexModeMenuOpen}
                    onOpenChange={setIndexModeMenuOpen}
                    selectedId={settings.indexMode}
                    items={indexModeItems}
                    onSelect={(id) => {
                        const mode = (id === 'deep' ? 'deep' : 'hints') as IndexMode;
                        void writeSettings({ ...settings, indexMode: mode });
                        setIndexModeMenuOpen(false);
                    }}
                    itemTrigger={{
                        title: t('memorySearchSettings.indexMode.triggerTitle'),
                        icon: <Ionicons name="options-outline" size={29} color={theme.colors.accent.orange} />,
                    }}
                />
            </ItemGroup>

            <ItemGroup
                title={t('memorySearchSettings.backfill.title')}
                footer={t('memorySearchSettings.backfill.footer')}
            >
                <DropdownMenu
                    open={backfillMenuOpen}
                    onOpenChange={setBackfillMenuOpen}
                    selectedId={settings.backfillPolicy}
                    items={backfillItems}
                    onSelect={(id) => {
                        const policy =
                            id === 'all_history'
                                ? 'all_history'
                                : id === 'last_30_days'
                                    ? 'last_30_days'
                                    : 'new_only';
                        void writeSettings({ ...settings, backfillPolicy: policy });
                        setBackfillMenuOpen(false);
                    }}
                    itemTrigger={{
                        title: t('memorySearchSettings.backfill.triggerTitle'),
                        icon: <Ionicons name="time-outline" size={29} color={theme.colors.accent.purple} />,
                    }}
                />
            </ItemGroup>

            <MemorySettingsCoverageSection settings={settings} writeSettings={writeSettings} />

            <MemorySettingsBudgetsSection settings={settings} writeSettings={writeSettings} />

            <MemorySettingsContentPolicySection settings={settings} writeSettings={writeSettings} />

            <ItemGroup
                title={t('memorySearchSettings.hints.title')}
                footer={t('memorySearchSettings.hints.footer')}
            >
                <Item
                    testID="memory-settings-summarizer-backend"
                    title={t('memorySearchSettings.hints.backend.title')}
                    subtitle={settings.hints.summarizerBackendId}
                    icon={<Ionicons name="server-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={async () => {
                        const next = await Modal.prompt(
                            t('memorySearchSettings.hints.backend.promptTitle'),
                            t('memorySearchSettings.hints.backend.promptBody'),
                            {
                                defaultValue: settings.hints.summarizerBackendId,
                                placeholder: DEFAULT_AGENT_ID,
                                confirmText: t('common.save'),
                                cancelText: t('common.cancel'),
                            },
                        );
                        if (typeof next === 'string' && next.trim()) {
                            void writeSettings({
                                ...settings,
                                hints: { ...settings.hints, summarizerBackendId: next.trim() },
                            });
                        }
                    }}
                    showChevron={false}
                />
                <Item
                    testID="memory-settings-summarizer-model"
                    title={t('memorySearchSettings.hints.model.title')}
                    subtitle={settings.hints.summarizerModelId}
                    icon={<Ionicons name="cube-outline" size={29} color={theme.colors.accent.indigo} />}
                    onPress={async () => {
                        const next = await Modal.prompt(
                            t('memorySearchSettings.hints.model.promptTitle'),
                            t('memorySearchSettings.hints.model.promptBody'),
                            {
                                defaultValue: settings.hints.summarizerModelId,
                                placeholder: 'default',
                                confirmText: t('common.save'),
                                cancelText: t('common.cancel'),
                            },
                        );
                        if (typeof next === 'string' && next.trim()) {
                            void writeSettings({
                                ...settings,
                                hints: { ...settings.hints, summarizerModelId: next.trim() },
                            });
                        }
                    }}
                    showChevron={false}
                />
                <DropdownMenu
                    open={summarizerPermissionMenuOpen}
                    onOpenChange={setSummarizerPermissionMenuOpen}
                    selectedId={settings.hints.summarizerPermissionMode}
                    items={summarizerPermissionItems}
                    onSelect={(id) => {
                        const mode = id === 'read_only' ? 'read_only' : 'no_tools';
                        void writeSettings({
                            ...settings,
                            hints: { ...settings.hints, summarizerPermissionMode: mode },
                        });
                        setSummarizerPermissionMenuOpen(false);
                    }}
                    itemTrigger={{
                        title: t('memorySearchSettings.hints.permissions.triggerTitle'),
                        icon: <Ionicons name="lock-closed-outline" size={29} color={theme.colors.state.danger.foreground} />,
                    }}
                />
            </ItemGroup>

            <MemorySettingsPrivacySection settings={settings} writeSettings={writeSettings} />

            <MemorySettingsEmbeddingsSection settings={settings} writeSettings={writeSettings} />
                </>
            )}
        </ItemList>
    );
});
