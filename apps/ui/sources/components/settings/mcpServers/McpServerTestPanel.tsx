import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { MachineAdministrationTargetV1, McpServerBindingV1, McpServerCatalogEntryV1 } from '@happier-dev/protocol';
import { McpServerBindingV1Schema, McpServerCatalogEntryV1Schema } from '@happier-dev/protocol';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PathInputBrowseButton } from '@/components/ui/pathBrowser/PathInputBrowseButton';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { TextInput } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { machineMcpServersTest } from '@/sync/ops/machineMcpServers';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import {
    type FreshMachineAdministrationExecutionTargetV1,
    type MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

const styles = StyleSheet.create((theme) => ({
    directoryInputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minWidth: 260,
        maxWidth: 420,
    },
    directoryInput: {
        flex: 1,
        minHeight: 40,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 9,
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
    },
}));

function describeBinding(binding: McpServerBindingV1, machines: readonly Machine[]): string {
    const target = binding.target;
    if (target.t === 'allMachines') return t('settings.mcpServersBindingTargetAllMachines');
    const machine = machines.find((m) => m.id === target.machineId) ?? null;
    const machineLabel = machine?.metadata?.displayName || machine?.metadata?.host || target.machineId;
    if (target.t === 'machine') return t('settings.mcpServersBindingTargetMachine', { machine: machineLabel });
    return t('settings.mcpServersBindingTargetWorkspace', { machine: machineLabel, path: target.workspaceRoot });
}

export const McpServerTestPanel = React.memo(function McpServerTestPanel(props: Readonly<{
    server: McpServerCatalogEntryV1;
    bindings: ReadonlyArray<McpServerBindingV1>;
    machines: readonly Machine[];
    targetSelection: Pick<MachineAdministrationTargetSelectionV1, 'selectedTarget' | 'resolveExecutionTarget'>;
}>) {
    const { theme } = useUnistyles();
    const administrationTargetSelection = props.targetSelection;
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

    const [bindingId, setBindingId] = React.useState<string | null>(null);
    const [openMenu, setOpenMenu] = React.useState<'binding' | null>(null);
    const [directory, setDirectory] = React.useState<string>('');
    const [lastResult, setLastResult] = React.useState<null | { ok: true; toolCount: number; durationMs: number } | { ok: false; errorCode: string; error: string; durationMs: number }>(null);
    const previousSelectionKeyRef = React.useRef(selectionKey);

    React.useLayoutEffect(() => {
        const previousSelectionKey = previousSelectionKeyRef.current;
        previousSelectionKeyRef.current = selectionKey;
        if (!previousSelectionKey || previousSelectionKey === selectionKey) return;
        setDirectory('');
        setLastResult(null);
    }, [selectionKey]);

    const bindingItems = React.useMemo((): DropdownMenuItem[] => {
        const items: DropdownMenuItem[] = [
            {
                id: '',
                title: t('settings.mcpServersTestNoBinding'),
                subtitle: t('settings.mcpServersTestNoBindingSubtitle'),
                icon: <Icon name="minus-circle" size={20} color={theme.colors.text.secondary} />,
            },
        ];

        for (const binding of props.bindings) {
            items.push({
                id: binding.id,
                title: describeBinding(binding, props.machines),
                subtitle: binding.enabled ? t('common.enabled') : t('common.disabled'),
                icon: <Icon name="push-pin" size={20} color={theme.colors.text.secondary} />,
            });
        }

        return items;
    }, [props.bindings, props.machines, theme.colors.text.secondary]);

    const selectedBinding = React.useMemo(() => {
        if (!bindingId) return null;
        return props.bindings.find((b) => b.id === bindingId) ?? null;
    }, [bindingId, props.bindings]);
    React.useEffect(() => {
        if (!selectedBinding) return;
        if (selectedBinding.target.t === 'workspace') {
            setDirectory(selectedBinding.target.workspaceRoot);
        }
    }, [selectedBinding]);

    const canTestServer = React.useMemo(() => McpServerCatalogEntryV1Schema.safeParse(props.server).success, [props.server]);
    const canTestBinding = React.useMemo(() => {
        if (!selectedBinding) return true;
        return McpServerBindingV1Schema.safeParse(selectedBinding).success;
    }, [selectedBinding]);

    const [isTesting, runTest] = useHappyAction(async () => {
        const requestedSelection = selectionKey;
        const executionTarget = resolveExactExecutionTarget(selectedTarget);
        if (!executionTarget) return;
        const parsed = McpServerCatalogEntryV1Schema.safeParse(props.server);
        if (!parsed.success) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return;
        }
        const binding = selectedBinding ? McpServerBindingV1Schema.parse(selectedBinding) : null;
        const response = await machineMcpServersTest(executionTarget.machine.id, {
            t: 'draft',
            directory: directory.trim() || '/',
            server: parsed.data,
            binding,
        }, { serverId: executionTarget.serverId });
        if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;

        if (response.ok) {
            setLastResult({ ok: true, toolCount: response.toolCount, durationMs: response.durationMs });
        } else {
            setLastResult({ ok: false, errorCode: response.errorCode, error: response.error, durationMs: response.durationMs });
        }
    });

    const handleBrowseDirectory = React.useCallback(async () => {
        const requestedSelection = selectionKey;
        const executionTarget = resolveExactExecutionTarget(selectedTarget);
        if (!executionTarget) return;
        const selected = await openMachinePathBrowserModal({
            machineId: executionTarget.machine.id,
            serverId: executionTarget.serverId,
            initialPath: directory.trim(),
            title: t('settings.mcpServersTestDirectoryTitle'),
        });
        if (typeof selected === 'string' && isExecutionTargetCurrent(requestedSelection, executionTarget)) {
            setDirectory(selected);
        }
    }, [directory, isExecutionTargetCurrent, resolveExactExecutionTarget, selectedTarget, selectionKey]);

    const executionTarget = resolveExactExecutionTarget(selectedTarget);

    return (
        <ItemGroup title={t('settings.mcpServersTestTitle')} footer={t('settings.mcpServersTestFooter')}>
            <DropdownMenu
                open={openMenu === 'binding'}
                onOpenChange={(open) => setOpenMenu(open ? 'binding' : null)}
                items={bindingItems}
                selectedId={bindingId ?? ''}
                onSelect={(id) => {
                    setBindingId(id || null);
                    setOpenMenu(null);
                }}
                itemTrigger={{
                    title: t('settings.mcpServersTestBindingTitle'),
                    subtitle: selectedBinding ? describeBinding(selectedBinding, props.machines) : t('settings.mcpServersTestNoBinding'),
                    icon: <Icon name="push-pin" size={29} color={theme.colors.accent.purple} />,
                }}
                rowKind="item"
                connectToTrigger
                variant="default"
            />

            <Item
                testID="mcp.server.test.directory"
                title={t('settings.mcpServersTestDirectoryTitle')}
                subtitle={t('settings.mcpServersTestDirectorySubtitle')}
                icon={<Icon name="folder" size={29} color={theme.colors.accent.blue} />}
                showChevron={false}
                rightElement={(
                    <View style={styles.directoryInputRow}>
                        <TextInput
                            testID="mcp.server.test.directory.input"
                            style={styles.directoryInput}
                            value={directory}
                            onChangeText={setDirectory}
                            placeholder={t('settings.mcpServersTestDirectoryPrompt')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        <PathInputBrowseButton
                            onPress={handleBrowseDirectory}
                            disabled={executionTarget === null}
                        />
                    </View>
                )}
            />

            <Item
                testID="mcp.server.test.run"
                title={t('settings.mcpServersTestRunTitle')}
                subtitle={isTesting ? t('common.loading') : t('settings.mcpServersTestRunSubtitle')}
                icon={<Icon name="flask" size={29} color={theme.colors.state.success.foreground} />}
                onPress={runTest}
                disabled={executionTarget === null || !canTestServer || !canTestBinding || isTesting}
                showChevron={false}
            />

            {lastResult ? (
                lastResult.ok ? (
                    <Item
                        testID="mcp.server.test.result.ok"
                        title={t('settings.mcpServersTestResultOkTitle')}
                        subtitle={t('settings.mcpServersTestResultOkSubtitle', { toolCount: lastResult.toolCount, durationMs: lastResult.durationMs })}
                        icon={<Icon name="check-circle" size={29} color={theme.colors.state.success.foreground} />}
                        showChevron={false}
                    />
                ) : (
                    <Item
                        testID="mcp.server.test.result.error"
                        title={t('settings.mcpServersTestResultErrorTitle')}
                        subtitle={`${lastResult.errorCode} · ${lastResult.error}`}
                        icon={<Icon name="warning-circle" size={29} color={theme.colors.status.error} />}
                        showChevron={false}
                    />
                )
            ) : null}
        </ItemGroup>
    );
});
