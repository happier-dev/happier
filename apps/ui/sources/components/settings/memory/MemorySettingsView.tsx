import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';

import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useAllMachines } from '@/sync/domains/state/storage';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

import { DEFAULT_MEMORY_SETTINGS, MemorySettingsV1Schema, RPC_METHODS, type MemorySettingsV1 } from '@happier-dev/protocol';
import { MemorySettingsBudgetsSection } from './MemorySettingsBudgetsSection';
import { MemorySettingsEmbeddingsSection } from './MemorySettingsEmbeddingsSection';
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
        try {
            const raw = await machineRpcWithServerScope<unknown, unknown>({
                machineId: selectedMachineId,
                serverId,
                method: RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET,
                payload: {},
            });
            setSettings(MemorySettingsV1Schema.parse(raw));
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
        const raw = await machineRpcWithServerScope<unknown, unknown>({
            machineId: selectedMachineId,
            serverId,
            method: RPC_METHODS.DAEMON_MEMORY_SETTINGS_SET,
            payload: next,
        });
        const parsed = MemorySettingsV1Schema.parse(raw);
        setSettings(parsed);
    }, [memorySearchEnabled, selectedMachineId, serverId]);

    const machineItems = React.useMemo(() => {
        return machines.map((m) => ({
            id: m.id,
            title: m.metadata?.displayName || m.metadata?.host || m.id,
            subtitle: m.metadata?.host || undefined,
            icon: <Ionicons name="desktop-outline" size={20} color={theme.colors.textSecondary} />,
        }));
    }, [machines, theme.colors.textSecondary]);

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
                        icon={<Ionicons name="search-outline" size={29} color={theme.colors.success} />}
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
                footer={t('memorySearchSettings.enabled.footer')}
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
                    subtitle={t('memorySearchSettings.enabled.subtitle')}
                    icon={<Ionicons name="search-outline" size={29} color={theme.colors.success} />}
                    rightElement={(
                        <Switch
                            value={settings.enabled}
                            onValueChange={(value) => {
                                void writeSettings({ ...settings, enabled: Boolean(value) });
                            }}
                        />
                    )}
                    showChevron={false}
                />
            </ItemGroup>

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

            <MemorySettingsBudgetsSection settings={settings} writeSettings={writeSettings} />

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
                                placeholder: 'claude',
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
                        icon: <Ionicons name="lock-closed-outline" size={29} color={theme.colors.warningCritical} />,
                    }}
                />
            </ItemGroup>

            <MemorySettingsPrivacySection settings={settings} writeSettings={writeSettings} />

            <MemorySettingsEmbeddingsSection settings={settings} writeSettings={writeSettings} />
        </ItemList>
    );
});
