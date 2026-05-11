import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
    DaemonMcpServersDetectWarningV1,
    DaemonMcpServersPreviewResponse,
    DetectedMcpServerV1,
    McpServerBindingV1,
    McpServerCatalogEntryV1,
    McpServersSettingsV1,
} from '@happier-dev/protocol';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { getAgentDropdownMenuItems } from '@/components/settings/pickers/agentDropdownItems';
import { McpConfiguredServersTab } from '@/components/settings/mcpServers/McpConfiguredServersTab';
import { McpDetectedServersTab } from '@/components/settings/mcpServers/McpDetectedServersTab';
import { McpPreviewServersTab } from '@/components/settings/mcpServers/McpPreviewServersTab';
import { McpSegmentedHeader } from '@/components/settings/mcpServers/McpSegmentedHeader';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { useAllMachines, useSettingMutable } from '@/sync/domains/state/storage';
import { machineMcpServersDetect, machineMcpServersPreview } from '@/sync/ops/machineMcpServers';
import { normalizeMcpServersSettingsV1 } from '@/sync/domains/settings/mcpServers/normalizeMcpServersSettingsV1';
import { resolveImportedMcpServerFromDetectedV1 } from '@/sync/domains/settings/mcpServers/importDetectedMcpServerV1';
import { deleteMcpServerCatalogEntryV1 } from '@/sync/domains/settings/mcpServers/mcpServerCrud';
import { usePrimaryMachineFromActiveSelection } from '@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection';
import { t } from '@/text';
import { getPreferredMcpPreviewAgentId, listDetectedMcpProviderIds, listMcpPreviewAgentIds } from './mcpServerScreenHelpers';

export const McpServersSettingsScreen = React.memo(function McpServersSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const machines = useAllMachines();
    const primaryMachineId = usePrimaryMachineFromActiveSelection();

    const [mcpSettingsRaw, setMcpSettings] = useSettingMutable('mcpServersSettingsV1');
    const mcpSettings: McpServersSettingsV1 = React.useMemo(() => normalizeMcpServersSettingsV1(mcpSettingsRaw), [mcpSettingsRaw]);

    const bindingsByServerId = React.useMemo(() => {
        const map = new Map<string, McpServerBindingV1[]>();
        for (const binding of mcpSettings.bindings) {
            const list = map.get(binding.serverId);
            if (list) list.push(binding);
            else map.set(binding.serverId, [binding]);
        }
        return map;
    }, [mcpSettings.bindings]);

    const serverRows: Array<{ server: McpServerCatalogEntryV1; bindings: McpServerBindingV1[] }> = React.useMemo(() => {
        return mcpSettings.servers
            .slice()
            .sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name))
            .map((server) => ({ server, bindings: bindingsByServerId.get(server.id) ?? [] }));
    }, [bindingsByServerId, mcpSettings.servers]);

    const [segment, setSegment] = React.useState<'configured' | 'detected' | 'preview'>('configured');
    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(() => primaryMachineId);
    const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);
    const [selectedAgentId, setSelectedAgentId] = React.useState<AgentId>(() => getPreferredMcpPreviewAgentId(listMcpPreviewAgentIds(), null));
    const [agentMenuOpen, setAgentMenuOpen] = React.useState(false);
    const [directory, setDirectory] = React.useState('');

    const [detected, setDetected] = React.useState<DetectedMcpServerV1[] | null>(null);
    const [detectWarnings, setDetectWarnings] = React.useState<DaemonMcpServersDetectWarningV1[] | null>(null);
    const [preview, setPreview] = React.useState<Extract<DaemonMcpServersPreviewResponse, { ok: true }> | null>(null);

    React.useEffect(() => {
        if (selectedMachineId && machines.some((machine) => machine.id === selectedMachineId)) return;
        setSelectedMachineId(primaryMachineId);
    }, [machines, selectedMachineId, primaryMachineId]);

    const machineItems = React.useMemo((): DropdownMenuItem[] => {
        return machines.map((machine) => ({
            id: machine.id,
            title: machine.metadata?.displayName || machine.metadata?.host || machine.id,
            subtitle: machine.id,
            icon: <Ionicons name="laptop-outline" size={22} color={theme.colors.text.secondary} />,
        }));
    }, [machines, theme.colors.text.secondary]);

    const previewAgentIds = React.useMemo(() => listMcpPreviewAgentIds(), []);

    React.useEffect(() => {
        if (previewAgentIds.includes(selectedAgentId)) return;
        setSelectedAgentId(getPreferredMcpPreviewAgentId(previewAgentIds, selectedAgentId));
    }, [previewAgentIds, selectedAgentId]);

    const agentItems = React.useMemo(() => getAgentDropdownMenuItems({
        agentIds: previewAgentIds,
        iconColor: theme.colors.text.secondary,
    }), [previewAgentIds, theme.colors.text.secondary]);

    const selectedAgentTools = React.useMemo(() => getAgentCore(selectedAgentId).tools, [selectedAgentId]);

    const handleToggleStrictMode = React.useCallback(() => {
        setMcpSettings({ ...mcpSettings, strictMode: !mcpSettings.strictMode });
    }, [mcpSettings, setMcpSettings]);

    const handleAddServer = React.useCallback(() => {
        // `router.push` expects the public route (group segments like `/(app)` are not valid here on web).
        router.push('/settings/mcp-server');
    }, [router]);

    const handleOpenQuickInstall = React.useCallback((presetId: string) => {
        router.push(`/settings/mcp-server?addMode=quick-install&presetId=${encodeURIComponent(presetId)}`);
    }, [router]);

    const handleDeleteServer = React.useCallback(async (serverId: string) => {
        const server = mcpSettings.servers.find((item) => item.id === serverId) ?? null;
        if (!server) return;

        const confirmed = await Modal.confirm(
            t('settings.mcpServersDeleteTitle'),
            t('settings.mcpServersDeleteConfirm', { name: server.title || server.name }),
            { destructive: true, cancelText: t('common.cancel'), confirmText: t('common.delete') },
        );
        if (!confirmed) return;

        setMcpSettings(deleteMcpServerCatalogEntryV1(mcpSettings, serverId));
    }, [mcpSettings, setMcpSettings]);

    const detectAction = React.useCallback(async () => {
        if (!selectedMachineId) {
            Modal.alert(t('common.error'), t('settings.mcpServersNoMachineSelected'));
            return;
        }
        const response = await machineMcpServersDetect(selectedMachineId, {
            providers: listDetectedMcpProviderIds(),
            directory: directory.trim() || undefined,
        });
        if (!response.ok) {
            setDetected(null);
            setDetectWarnings(null);
            Modal.alert(t('common.error'), response.error);
            return;
        }
        setDetected(response.servers);
        setDetectWarnings(response.warnings ?? null);
    }, [directory, selectedMachineId]);
    const [detectLoading, runDetect] = useHappyAction(detectAction, { mode: 'rerun_latest' });

    const previewAction = React.useCallback(async () => {
        if (!selectedMachineId) {
            Modal.alert(t('common.error'), t('settings.mcpServersNoMachineSelected'));
            return;
        }
        if (!directory.trim()) {
            Modal.alert(t('common.error'), t('settings.mcpServersPreviewDirectoryRequired'));
            return;
        }
        const response = await machineMcpServersPreview(selectedMachineId, {
            agentId: selectedAgentId,
            directory: directory.trim(),
        });
        if (!response.ok) {
            setPreview(null);
            Modal.alert(t('common.error'), response.error);
            return;
        }
        setPreview(response);
    }, [directory, selectedAgentId, selectedMachineId]);
    const [previewLoading, runPreview] = useHappyAction(previewAction);

    React.useEffect(() => {
        if (segment !== 'detected') return;
        if (!selectedMachineId) return;
        void runDetect();
    }, [directory, runDetect, segment, selectedMachineId]);

    const handleImportDetected = React.useCallback(async (server: DetectedMcpServerV1) => {
        if (!selectedMachineId) return;

        const confirmed = await Modal.confirm(
            t('settings.mcpServersImportTitle'),
            t('settings.mcpServersImportConfirm', { provider: server.provider, name: server.name }),
            { cancelText: t('common.cancel'), confirmText: t('settings.mcpServersImportAction') },
        );
        if (!confirmed) return;

        try {
            const imported = resolveImportedMcpServerFromDetectedV1({
                existingSettings: mcpSettings,
                detected: server,
                machineId: selectedMachineId,
                nowMs: Date.now(),
                generateId: randomUUID,
            });
            if (imported.nextSettings !== mcpSettings) {
                setMcpSettings(imported.nextSettings);
            }
            router.push(`/settings/mcp-server?serverId=${encodeURIComponent(imported.entry.id)}`);
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.unknownError'));
        }
    }, [mcpSettings, router, selectedMachineId, setMcpSettings]);

    const managedServerCount = serverRows.length;
    const headerSubtitle = managedServerCount > 0
        ? t('settings.mcpServersHeroSubtitle', { configuredCount: managedServerCount })
        : t('settings.mcpServersHeroSubtitleEmpty');

    return (
        <ItemList>
            <McpSegmentedHeader
                title={t('settings.mcpServers')}
                subtitle={headerSubtitle}
                tabs={[
                    { id: 'configured', label: t('settings.mcpServersSegmentConfigured') },
                    { id: 'detected', label: t('settings.mcpServersSegmentDetected') },
                    { id: 'preview', label: t('settings.mcpServersSegmentPreview') },
                ]}
                activeTabId={segment}
                onSelectTab={setSegment}
                testIDPrefix="settings.mcpServers.segment"
            />

            {segment === 'configured' ? (
                <McpConfiguredServersTab
                    settings={mcpSettings}
                    serverRows={serverRows}
                    machines={machines}
                    onToggleStrictMode={handleToggleStrictMode}
                    onEditServer={(serverId) => router.push(`/settings/mcp-server?serverId=${encodeURIComponent(serverId)}`)}
                    onDeleteServer={handleDeleteServer}
                    onAddServer={handleAddServer}
                    onOpenQuickInstall={handleOpenQuickInstall}
                />
            ) : null}

            {segment === 'detected' ? (
                <McpDetectedServersTab
                    machines={machines}
                    machineItems={machineItems}
                    selectedMachineId={selectedMachineId}
                    onSelectMachine={setSelectedMachineId}
                    machineMenuOpen={machineMenuOpen}
                    onMachineMenuOpenChange={setMachineMenuOpen}
                    directory={directory}
                    onChangeDirectory={setDirectory}
                    loading={detectLoading}
                    detected={detected}
                    warnings={detectWarnings}
                    onRefresh={runDetect}
                    onImport={handleImportDetected}
                />
            ) : null}

            {segment === 'preview' ? (
                <McpPreviewServersTab
                    machines={machines}
                    machineItems={machineItems}
                    agentItems={agentItems}
                    selectedAgentTools={selectedAgentTools}
                    selectedMachineId={selectedMachineId}
                    onSelectMachine={setSelectedMachineId}
                    machineMenuOpen={machineMenuOpen}
                    onMachineMenuOpenChange={setMachineMenuOpen}
                    selectedAgentId={selectedAgentId}
                    onSelectAgentId={setSelectedAgentId}
                    agentMenuOpen={agentMenuOpen}
                    onAgentMenuOpenChange={setAgentMenuOpen}
                    directory={directory}
                    onChangeDirectory={setDirectory}
                    loading={previewLoading}
                    preview={preview}
                    onRefresh={runPreview}
                />
            ) : null}

            <View style={styles.footerSpacer} />
        </ItemList>
    );
});

const styles = StyleSheet.create(() => ({
    footerSpacer: {
        height: 16,
    },
}));
