import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import type { DaemonMcpServersDetectWarningV1, DetectedMcpServerV1 } from '@happier-dev/protocol';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';

import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { resolveImportedMcpServerFromDetectedV1 } from '@/sync/domains/settings/mcpServers/importDetectedMcpServerV1';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationExecutionTargetBinding } from '@/sync/domains/machines/administration/useExecutionTargetBinding';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { requireUpdatedMcpServerCatalogMutation } from '@/sync/api/account/apiMcpServerCatalog';

import { McpDetectedServersTab } from './McpDetectedServersTab';
import { mcpServerRoute } from './collection/mcpServerCollectionModel';
import { useMcpServersSettings } from './useMcpServersSettings';

/**
 * `/settings/mcp/on-machine`: the MCP servers other agents configure on the managed machine, with an
 * Import for each. The machine chip in the header scopes the whole page; it stays through loading,
 * offline and error states because it is the control that recovers them.
 */
export const McpDetectedServersScreen = React.memo(function McpDetectedServersScreen() {
    const router = useRouter();
    const { writable, snapshot, mutate, approval: importApproval, scope } = useMcpServersSettings();
    const targetSelection = useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.mcpServers);
    const selectedTarget = targetSelection.selectedTarget;
    const { selectionKey, resolveExactExecutionTarget, isExecutionTargetCurrent } = useMachineAdministrationExecutionTargetBinding(targetSelection);
    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    const probeExecution = useMountedActionExecution(executionTarget?.serverId);
    const [directory, setDirectory] = React.useState('');
    const [detected, setDetected] = React.useState<DetectedMcpServerV1[] | null>(null);
    const [warnings, setWarnings] = React.useState<DaemonMcpServersDetectWarningV1[] | null>(null);
    const previousSelectionKeyRef = React.useRef(selectionKey);

    // A different machine is a different place to look: its folder and its findings start empty.
    React.useLayoutEffect(() => {
        const previousSelectionKey = previousSelectionKeyRef.current;
        previousSelectionKeyRef.current = selectionKey;
        if (!previousSelectionKey || previousSelectionKey === selectionKey) return;
        setDirectory('');
    }, [selectionKey]);
    React.useEffect(() => {
        setDetected(null);
        setWarnings(null);
    }, [selectionKey]);

    const detectAction = React.useCallback(async () => {
        const requestedSelection = selectionKey;
        const executionTarget = resolveExactExecutionTarget(selectedTarget);
        if (!executionTarget || !probeExecution.ready) return;
        // No `providers` filter: the daemon on this exact machine owns the
        // current MCP discovery-source registry, including the sources an
        // installed Agent contributes. Sending this app binary's bundled Agent
        // list instead would drop every installed Agent's source before
        // detection even runs.
        const receipt = await probeExecution.execute('mcp.servers.probe', {
            machineId: executionTarget.machine.id,
            directory: directory.trim() || undefined,
        });
        if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
        if (!receipt.ok) {
            setDetected(null);
            setWarnings(null);
            Modal.alert(t('common.error'), receipt.errorCode ?? receipt.error);
            return;
        }
        const response = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.probe'].parse(receipt.result);
        if (!response.ok) {
            setDetected(null);
            setWarnings(null);
            Modal.alert(t('common.error'), response.error);
            return;
        }
        setDetected(response.servers);
        setWarnings(response.warnings ?? null);
    }, [directory, isExecutionTargetCurrent, resolveExactExecutionTarget, selectedTarget, selectionKey, probeExecution.execute, probeExecution.ready]);
    const [loading, runDetect] = useHappyAction(detectAction, { mode: 'rerun_latest' });

    React.useEffect(() => {
        void runDetect();
    }, [directory, runDetect, selectionKey]);

    const importServer = React.useCallback(async (server: DetectedMcpServerV1) => {
        if (!writable) {
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
                existingSettings: writable,
                detected: server,
                machineId: executionTarget.machine.id,
                nowMs: Date.now(),
                generateId: randomUUID,
            });
            if (snapshot.revision === 'absent') throw new Error('authority-not-confirmed');
            if (imported.action === 'created') {
                requireUpdatedMcpServerCatalogMutation(await mutate('mcp.servers.create', {
                    expectedRevision: snapshot.revision, entry: imported.entry, bindings: [imported.binding],
                }));
            } else if (imported.action === 'updated') {
                requireUpdatedMcpServerCatalogMutation(await mutate(
                    imported.bindingAction === 'add' ? 'mcp.bindings.add' : 'mcp.bindings.edit', {
                        expectedRevision: snapshot.revision, binding: imported.binding,
                    }));
            }
            if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
            const result = runGuardedNavigation(() => router.replace(mcpServerRoute(imported.entry.id) as never));
            if (result !== true) fireAndForget(result, { tag: 'McpDetectedServersScreen.import' });
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.unknownError'));
        }
    }, [isExecutionTargetCurrent, resolveExactExecutionTarget, router, selectedTarget, selectionKey, mutate, snapshot.revision, writable]);

    return (
        <ItemList keyboardShouldPersistTaps="handled">
            <SettingsPageHeader
                description={t('mcpSettings.onMachinePurpose')}
                actions={(
                    <MachineAdministrationTargetSelector
                        selection={targetSelection}
                        presentation="chip"
                        testIDPrefix="settings.mcpServers.administration.target"
                    />
                )}
            />
            {importApproval.approvalId && scope ? (
                <ActionApprovalPendingNotice testID="mcp.detected.import.approval"
                    message={t('secrets.catalog.approvalPending')}
                    onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(importApproval.approvalId!)}?serverId=${encodeURIComponent(scope.serverId)}`)} />
            ) : null}
            {probeExecution.approval.approvalId && executionTarget ? (
                <ActionApprovalPendingNotice testID="mcp.detected.approval"
                    message={t('secrets.catalog.approvalPending')}
                    onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(probeExecution.approval.approvalId!)}?serverId=${encodeURIComponent(executionTarget.serverId)}`)} />
            ) : null}
            <McpDetectedServersTab
                selectedMachineId={executionTarget?.machine.id ?? null}
                selectedServerId={executionTarget?.serverId ?? null}
                canExecute={executionTarget !== null && probeExecution.ready}
                directory={directory}
                onChangeDirectory={setDirectory}
                loading={loading}
                detected={detected}
                warnings={warnings}
                onRefresh={runDetect}
                onImport={(server) => { void importServer(server); }}
            />
        </ItemList>
    );
});
