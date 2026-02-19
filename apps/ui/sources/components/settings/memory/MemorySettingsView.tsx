import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/StyledText';
import { Modal } from '@/modal';

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

    const indexModeItems = React.useMemo(() => ([
        { id: 'hints', title: 'Light (recommended)', subtitle: 'Summary shards only' },
        { id: 'deep', title: 'Deep', subtitle: 'Index message chunks locally' },
    ] as const), []);

    const backfillItems = React.useMemo(() => ([
        { id: 'new_only', title: 'New only (recommended)', subtitle: 'Index only content created after enabling' },
        { id: 'last_30_days', title: 'Last 30 days', subtitle: 'Backfill recent sessions' },
        { id: 'all_history', title: 'All history', subtitle: 'Backfill everything (can take time)' },
    ] as const), []);

    const summarizerPermissionItems = React.useMemo(() => ([
        {
            id: 'no_tools',
            title: 'No tools (recommended)',
            subtitle: 'Summarize text only',
        },
        {
            id: 'read_only',
            title: 'Read-only',
            subtitle: 'Allow non-mutating tools when supported',
        },
    ] as const), []);

    const selectedMachineTitle = React.useMemo(() => {
        const machine = machines.find((m) => m.id === selectedMachineId);
        const label = machine?.metadata?.displayName || machine?.metadata?.host || selectedMachineId;
        return label && label.trim().length > 0 ? label : 'No machine';
    }, [machines, selectedMachineId]);

    if (!memorySearchEnabled) {
        return (
            <ItemList style={{ paddingTop: 0 }}>
                <ItemGroup
                    title="Local Memory Search"
                    footer="Enable memory search in Features to configure local indexing."
                >
                    <Item
                        title="Memory search is disabled"
                        subtitle="Open Settings → Features to enable memory.search"
                        icon={<Ionicons name="search-outline" size={29} color="#34C759" />}
                        onPress={() => { void Modal.alert('Memory search disabled', 'Enable memory.search in Settings → Features.'); }}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title="Local Memory Search"
                footer="When enabled, Happier builds a device-local index derived from decrypted transcripts to support fast recall and search."
            >
                <Item
                    title="Machine"
                    subtitle={selectedMachineTitle}
                    icon={<Ionicons name="desktop-outline" size={29} color="#007AFF" />}
                    rightElement={loading ? <Text>Loading…</Text> : null}
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
                            title: 'Change machine',
                            icon: <Ionicons name="swap-horizontal-outline" size={29} color="#5856D6" />,
                        }}
                    />
                </View>
                <Item
                    title="Enabled"
                    subtitle="Build and maintain a local index on this machine"
                    icon={<Ionicons name="search-outline" size={29} color="#34C759" />}
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
                title="Index mode"
                footer="Light mode stores small summary shards. Deep mode can find more but uses more disk."
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
                        title: 'Mode',
                        icon: <Ionicons name="options-outline" size={29} color="#FF9500" />,
                    }}
                />
            </ItemGroup>

            <ItemGroup
                title="Backfill"
                footer="Controls how much history is indexed when enabling local memory."
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
                        title: 'Policy',
                        icon: <Ionicons name="time-outline" size={29} color="#AF52DE" />,
                    }}
                />
            </ItemGroup>

            <MemorySettingsBudgetsSection settings={settings} writeSettings={writeSettings} />

            <ItemGroup
                title="Memory hint generation"
                footer="Controls how summary shards are generated for light memory search."
            >
                <Item
                    testID="memory-settings-summarizer-backend"
                    title="Summarizer backend"
                    subtitle={settings.hints.summarizerBackendId}
                    icon={<Ionicons name="server-outline" size={29} color="#007AFF" />}
                    onPress={async () => {
                        const next = await Modal.prompt(
                            'Summarizer backend',
                            'Enter an execution-run backend id (e.g. claude, codex).',
                            {
                                defaultValue: settings.hints.summarizerBackendId,
                                placeholder: 'claude',
                                confirmText: 'Save',
                                cancelText: 'Cancel',
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
                    title="Summarizer model"
                    subtitle={settings.hints.summarizerModelId}
                    icon={<Ionicons name="cube-outline" size={29} color="#5856D6" />}
                    onPress={async () => {
                        const next = await Modal.prompt(
                            'Summarizer model',
                            'Enter a model id to pass through to the backend.',
                            {
                                defaultValue: settings.hints.summarizerModelId,
                                placeholder: 'default',
                                confirmText: 'Save',
                                cancelText: 'Cancel',
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
                        title: 'Summarizer permissions',
                        icon: <Ionicons name="lock-closed-outline" size={29} color="#FF3B30" />,
                    }}
                />
            </ItemGroup>

            <MemorySettingsPrivacySection settings={settings} writeSettings={writeSettings} />

            <MemorySettingsEmbeddingsSection settings={settings} writeSettings={writeSettings} />
        </ItemList>
    );
});
