import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
    DaemonMcpServersDetectWarningV1,
    DaemonMcpServersPreviewResponse,
    DetectedMcpServerV1,
    MachineAdministrationTargetV1,
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
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { useAllMachines, useSettingMutable } from '@/sync/domains/state/storage';
import { machineMcpServersDetect, machineMcpServersPreview } from '@/sync/ops/machineMcpServers';
import {
    normalizeMcpServersSettingsV1,
    readWritableMcpServersSettingsV1,
} from '@/sync/domains/settings/mcpServers/normalizeMcpServersSettingsV1';
import { resolveImportedMcpServerFromDetectedV1 } from '@/sync/domains/settings/mcpServers/importDetectedMcpServerV1';
import { deleteMcpServerCatalogEntryV1 } from '@/sync/domains/settings/mcpServers/mcpServerCrud';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import {
    useMachineAdministrationTargetSelection,
    type FreshMachineAdministrationExecutionTargetV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';
import { getPreferredMcpPreviewAgentId, listDetectedMcpProviderIds, listMcpPreviewAgentIds } from './mcpServerScreenHelpers';
import { Icon } from '@/components/ui/icons/Icon';

export const McpServersSettingsScreen = React.memo(function McpServersSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const machines = useAllMachines();
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.mcpServers,
    );
    const selectedTarget = administrationTargetSelection.selectedTarget;
    const selectionKey = selectedTarget
        ? `${selectedTarget.serverIdentityId}\0${selectedTarget.machineId}`
        : '';
    const selectionKeyRef = React.useRef(selectionKey);
    selectionKeyRef.current = selectionKey;
    const resolveExecutionTargetRef = React.useRef(administrationTargetSelection.resolveExecutionTarget);
    resolveExecutionTargetRef.current = administrationTargetSelection.resolveExecutionTarget;
    const resolveExactExecutionTarget = React.useCallback((
        expectedTarget: MachineAdministrationTargetV1 | null,
    ): FreshMachineAdministrationExecutionTargetV1 | null => {
        const resolved = resolveExecutionTargetRef.current();
        return expectedTarget !== null
            && resolved !== null
            && machineAdministrationTargetsEqual(expectedTarget, resolved.target)
            ? resolved
            : null;
    }, []);
    const isExecutionTargetCurrent = React.useCallback((
        requestedSelection: string,
        executionTarget: FreshMachineAdministrationExecutionTargetV1,
    ): boolean => {
        if (selectionKeyRef.current !== requestedSelection) return false;
        const current = resolveExactExecutionTarget(executionTarget.target);
        return current !== null
            && current.serverId === executionTarget.serverId
            && current.machine.id === executionTarget.machine.id;
    }, [resolveExactExecutionTarget]);

    const [mcpSettingsRaw, setMcpSettings] = useSettingMutable('mcpServersSettingsV1');
    const mcpSettings: McpServersSettingsV1 = React.useMemo(() => normalizeMcpServersSettingsV1(mcpSettingsRaw), [mcpSettingsRaw]);
    const writableMcpSettings = React.useMemo(
        () => readWritableMcpServersSettingsV1(mcpSettingsRaw),
        [mcpSettingsRaw],
    );

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
    const [selectedAgentId, setSelectedAgentId] = React.useState<AgentId>(() => getPreferredMcpPreviewAgentId(listMcpPreviewAgentIds(), null));
    const [agentMenuOpen, setAgentMenuOpen] = React.useState(false);
    const [directory, setDirectory] = React.useState('');

    const [detected, setDetected] = React.useState<DetectedMcpServerV1[] | null>(null);
    const [detectWarnings, setDetectWarnings] = React.useState<DaemonMcpServersDetectWarningV1[] | null>(null);
    const [preview, setPreview] = React.useState<Extract<DaemonMcpServersPreviewResponse, { ok: true }> | null>(null);
    const previousSelectionKeyRef = React.useRef(selectionKey);

    React.useLayoutEffect(() => {
        const previousSelectionKey = previousSelectionKeyRef.current;
        previousSelectionKeyRef.current = selectionKey;
        if (!previousSelectionKey || previousSelectionKey === selectionKey) return;
        setDirectory('');
    }, [selectionKey]);

    React.useEffect(() => {
        setDetected(null);
        setDetectWarnings(null);
        setPreview(null);
    }, [selectionKey]);

    const previewAgentIds = React.useMemo(() => listMcpPreviewAgentIds(), []);

    React.useEffect(() => {
        if (previewAgentIds.includes(selectedAgentId)) return;
        setSelectedAgentId(getPreferredMcpPreviewAgentId(previewAgentIds, selectedAgentId));
    }, [previewAgentIds, selectedAgentId]);

    const agentItems = React.useMemo(() => getAgentDropdownMenuItems({
        agentIds: previewAgentIds,
        iconColor: theme.colors.text.secondary,
    }), [previewAgentIds, theme.colors.text.secondary]);

    const selectedAgentTools = React.useMemo(() => getAgentCore(selectedAgentId)?.tools ?? null, [selectedAgentId]);

    const handleToggleStrictMode = React.useCallback(() => {
        if (!writableMcpSettings) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return;
        }
        setMcpSettings({ ...writableMcpSettings, strictMode: !writableMcpSettings.strictMode });
    }, [setMcpSettings, writableMcpSettings]);

    const handleAddServer = React.useCallback(() => {
        // `router.push` expects the public route (group segments like `/(app)` are not valid here on web).
        router.push('/settings/mcp-server');
    }, [router]);

    const handleOpenQuickInstall = React.useCallback((presetId: string) => {
        router.push(`/settings/mcp-server?addMode=quick-install&presetId=${encodeURIComponent(presetId)}`);
    }, [router]);

    const handleDeleteServer = React.useCallback(async (serverId: string) => {
        if (!writableMcpSettings) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return;
        }
        const server = writableMcpSettings.servers.find((item) => item.id === serverId) ?? null;
        if (!server) return;

        const confirmed = await Modal.confirm(
            t('settings.mcpServersDeleteTitle'),
            t('settings.mcpServersDeleteConfirm', { name: server.title || server.name }),
            { destructive: true, cancelText: t('common.cancel'), confirmText: t('common.delete') },
        );
        if (!confirmed) return;

        setMcpSettings(deleteMcpServerCatalogEntryV1(writableMcpSettings, serverId));
    }, [setMcpSettings, writableMcpSettings]);

    const detectAction = React.useCallback(async () => {
        const requestedSelection = selectionKey;
        const executionTarget = resolveExactExecutionTarget(selectedTarget);
        if (!executionTarget) return;
        const response = await machineMcpServersDetect(executionTarget.machine.id, {
            providers: listDetectedMcpProviderIds(),
            directory: directory.trim() || undefined,
        }, { serverId: executionTarget.serverId });
        if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
        if (!response.ok) {
            setDetected(null);
            setDetectWarnings(null);
            Modal.alert(t('common.error'), response.error);
            return;
        }
        setDetected(response.servers);
        setDetectWarnings(response.warnings ?? null);
    }, [directory, isExecutionTargetCurrent, resolveExactExecutionTarget, selectedTarget, selectionKey]);
    const [detectLoading, runDetect] = useHappyAction(detectAction, { mode: 'rerun_latest' });

    const previewAction = React.useCallback(async () => {
        const requestedSelection = selectionKey;
        const executionTarget = resolveExactExecutionTarget(selectedTarget);
        if (!executionTarget) return;
        if (!directory.trim()) {
            Modal.alert(t('common.error'), t('settings.mcpServersPreviewDirectoryRequired'));
            return;
        }
        const response = await machineMcpServersPreview(executionTarget.machine.id, {
            agentId: selectedAgentId,
            directory: directory.trim(),
        }, { serverId: executionTarget.serverId });
        if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
        if (!response.ok) {
            setPreview(null);
            Modal.alert(t('common.error'), response.error);
            return;
        }
        setPreview(response);
    }, [directory, isExecutionTargetCurrent, resolveExactExecutionTarget, selectedAgentId, selectedTarget, selectionKey]);
    const [previewLoading, runPreview] = useHappyAction(previewAction);

    React.useEffect(() => {
        if (segment !== 'detected') return;
        void runDetect();
    }, [directory, runDetect, segment, selectionKey]);

    const handleImportDetected = React.useCallback(async (server: DetectedMcpServerV1) => {
        if (!writableMcpSettings) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return;
        }
        const requestedSelection = selectionKey;
        const expectedTarget = selectedTarget;
        if (!expectedTarget) return;

        const confirmed = await Modal.confirm(
            t('settings.mcpServersImportTitle'),
            t('settings.mcpServersImportConfirm', { provider: server.provider, name: server.name }),
            { cancelText: t('common.cancel'), confirmText: t('settings.mcpServersImportAction') },
        );
        if (!confirmed) return;
        const executionTarget = resolveExactExecutionTarget(expectedTarget);
        if (!executionTarget || !isExecutionTargetCurrent(requestedSelection, executionTarget)) return;

        try {
            const imported = resolveImportedMcpServerFromDetectedV1({
                existingSettings: writableMcpSettings,
                detected: server,
                machineId: executionTarget.machine.id,
                nowMs: Date.now(),
                generateId: randomUUID,
            });
            if (imported.nextSettings !== writableMcpSettings) {
                setMcpSettings(imported.nextSettings);
            }
            router.push(`/settings/mcp-server?serverId=${encodeURIComponent(imported.entry.id)}`);
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.unknownError'));
        }
    }, [isExecutionTargetCurrent, resolveExactExecutionTarget, router, selectedTarget, selectionKey, setMcpSettings, writableMcpSettings]);

    const executionTarget = resolveExactExecutionTarget(selectedTarget);
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

            {segment !== 'configured' ? (
                <MachineAdministrationTargetSelector
                    selection={administrationTargetSelection}
                    testIDPrefix="settings.mcpServers.administration.target"
                />
            ) : null}

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
                    selectedMachineId={executionTarget?.machine.id ?? null}
                    selectedServerId={executionTarget?.serverId ?? null}
                    canExecute={executionTarget !== null}
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
                    agentItems={agentItems}
                    selectedAgentTools={selectedAgentTools}
                    selectedMachineId={executionTarget?.machine.id ?? null}
                    selectedServerId={executionTarget?.serverId ?? null}
                    canExecute={executionTarget !== null}
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
