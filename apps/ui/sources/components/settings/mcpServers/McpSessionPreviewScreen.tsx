import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { DaemonMcpServersPreviewResponse } from '@happier-dev/protocol';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { getAgentDropdownMenuItems } from '@/components/settings/pickers/agentDropdownItems';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { machineMcpServersPreview } from '@/sync/ops/machineMcpServers';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationExecutionTargetBinding } from '@/sync/domains/machines/administration/useExecutionTargetBinding';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';

import { McpPreviewServersTab } from './McpPreviewServersTab';
import { MCP_PREVIEW_SETTINGS } from './mcpSettings';
import { getPreferredMcpPreviewAgentId, listMcpPreviewAgentIds } from './mcpServerScreenHelpers';

type FailurePolicy = 'skip' | 'stop';

/**
 * `/settings/mcp/preview`: which MCP servers a session would receive for an agent and a folder on the
 * managed machine, and the Account-wide policy for a server that cannot start. The policy is an
 * Account setting, so it renders and saves without a machine; only the preview waits on the chip.
 */
export const McpSessionPreviewScreen = React.memo(function McpSessionPreviewScreen() {
    const { theme } = useUnistyles();
    const [strictMode, setStrictMode] = useSettingMutable('mcpServersStrictMode');
    const targetSelection = useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.mcpServers);
    const selectedTarget = targetSelection.selectedTarget;
    const { selectionKey, resolveExactExecutionTarget, isExecutionTargetCurrent } = useMachineAdministrationExecutionTargetBinding(targetSelection);
    const previewAgentIds = React.useMemo(() => listMcpPreviewAgentIds(), []);
    const [selectedAgentId, setSelectedAgentId] = React.useState<AgentId>(() => getPreferredMcpPreviewAgentId(previewAgentIds, null));
    const [agentMenuOpen, setAgentMenuOpen] = React.useState(false);
    const [directory, setDirectory] = React.useState('');
    const [preview, setPreview] = React.useState<Extract<DaemonMcpServersPreviewResponse, { ok: true }> | null>(null);
    const previousSelectionKeyRef = React.useRef(selectionKey);

    React.useLayoutEffect(() => {
        const previousSelectionKey = previousSelectionKeyRef.current;
        previousSelectionKeyRef.current = selectionKey;
        if (!previousSelectionKey || previousSelectionKey === selectionKey) return;
        setDirectory('');
    }, [selectionKey]);
    React.useEffect(() => {
        setPreview(null);
    }, [selectionKey]);
    React.useEffect(() => {
        if (previewAgentIds.includes(selectedAgentId)) return;
        setSelectedAgentId(getPreferredMcpPreviewAgentId(previewAgentIds, selectedAgentId));
    }, [previewAgentIds, selectedAgentId]);

    const agentItems = React.useMemo(() => getAgentDropdownMenuItems({
        agentIds: previewAgentIds,
        iconColor: theme.colors.text.secondary,
    }), [previewAgentIds, theme.colors.text.secondary]);
    const selectedAgentTools = React.useMemo(() => getAgentCore(selectedAgentId)?.tools ?? null, [selectedAgentId]);

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
    const [loading, runPreview] = useHappyAction(previewAction);

    const setFailurePolicy = React.useCallback((policy: FailurePolicy) => {
        const next = policy === 'stop';
        if (strictMode === next) return;
        setStrictMode(next);
    }, [setStrictMode, strictMode]);

    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    return (
        <ItemList keyboardShouldPersistTaps="handled">
            <SettingsPageHeader
                description={t('mcpSettings.previewPurpose')}
                actions={(
                    <MachineAdministrationTargetSelector
                        selection={targetSelection}
                        presentation="chip"
                        testIDPrefix="settings.mcpServers.administration.target"
                    />
                )}
            />
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
                loading={loading}
                preview={preview}
                onRefresh={runPreview}
            />
            <ItemGroup title={t('mcpSettings.failureSection')} description={t('mcpSettings.failureSectionDescription')}>
                <SettingAnchor setting={MCP_PREVIEW_SETTINGS.settings.mcpServersStrictMode}>
                    <SegmentedChoiceItem<FailurePolicy>
                        testID="settings.mcpServers.strictMode"
                        testIDPrefix="settings.mcpServers.strictMode"
                        title={t(MCP_PREVIEW_SETTINGS.settings.mcpServersStrictMode.titleKey)}
                        subtitle={t('mcpSettings.failurePolicyDescription')}
                        value={strictMode ? 'stop' : 'skip'}
                        options={[
                            { id: 'skip', label: t('mcpSettings.failurePolicySkip') },
                            { id: 'stop', label: t('mcpSettings.failurePolicyStop') },
                        ]}
                        onChange={setFailurePolicy}
                    />
                </SettingAnchor>
            </ItemGroup>
        </ItemList>
    );
});
