import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { McpServerBindingV1, McpServerCatalogEntryV1 } from '@happier-dev/protocol';
import { McpServerBindingV1Schema, McpServerCatalogEntryV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PathInputBrowseButton } from '@/components/ui/pathBrowser/PathInputBrowseButton';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Modal } from '@/modal';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { machineMcpServersTest } from '@/sync/ops/machineMcpServers';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { useMachineAdministrationExecutionTargetBinding } from '@/sync/domains/machines/administration/useExecutionTargetBinding';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { describeBindingTarget } from './McpBindingTargetFields';

const styles = StyleSheet.create(() => ({
    directoryInputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 1,
    },
    directoryInput: {
        flex: 1,
        minWidth: 0,
    },
}));

export const McpServerTestPanel = React.memo(function McpServerTestPanel(props: Readonly<{
    server: McpServerCatalogEntryV1;
    bindings: ReadonlyArray<McpServerBindingV1>;
    machines: readonly Machine[];
    targetSelection: Pick<MachineAdministrationTargetSelectionV1, 'selectedTarget' | 'resolveExecutionTarget'>;
}>) {
    const { theme } = useUnistyles();
    const administrationTargetSelection = props.targetSelection;
    const selectedTarget = administrationTargetSelection.selectedTarget;
    const {
        selectionKey,
        resolveExactExecutionTarget,
        isExecutionTargetCurrent,
    } = useMachineAdministrationExecutionTargetBinding(administrationTargetSelection);

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
                title: describeBindingTarget(binding.target, props.machines),
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
        <ItemGroup
            title={t('settings.mcpServersTestTitle')}
            description={t('settings.mcpServersTestFooter')}
            action={(
                <SectionActionButton
                    testID="mcp.server.test.run"
                    icon="play"
                    title={t('settings.mcpServersTestRunTitle')}
                    loading={isTesting}
                    disabled={executionTarget === null || !canTestServer || !canTestBinding || isTesting}
                    onPress={runTest}
                />
            )}
        >
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
                    subtitle: selectedBinding ? describeBindingTarget(selectedBinding.target, props.machines) : t('settings.mcpServersTestNoBinding'),
                }}
                rowKind="item"
                connectToTrigger
                variant="selectable"
                search={false}
                showCategoryTitles={false}
                matchTriggerWidth
            />

            <Item
                testID="mcp.server.test.directory"
                title={t('settings.mcpServersTestDirectoryTitle')}
                subtitle={t('settings.mcpServersTestDirectorySubtitle')}
                showChevron={false}
                accessoryLayout="adaptive"
                rightElement={(
                    <View style={styles.directoryInputRow}>
                        <FieldTextInput
                            testID="mcp.server.test.directory.input"
                            style={styles.directoryInput}
                            value={directory}
                            onChangeText={setDirectory}
                            accessibilityLabel={t('settings.mcpServersTestDirectoryTitle')}
                            placeholder={t('settings.mcpServersTestDirectoryPrompt')}
                            monospace
                        />
                        <PathInputBrowseButton
                            onPress={handleBrowseDirectory}
                            disabled={executionTarget === null}
                        />
                    </View>
                )}
            />

            {lastResult ? (
                lastResult.ok ? (
                    <Item
                        testID="mcp.server.test.result.ok"
                        title={t('settings.mcpServersTestResultOkTitle')}
                        subtitle={t('settings.mcpServersTestResultOkSubtitle', { toolCount: lastResult.toolCount, durationMs: lastResult.durationMs })}
                        accessibilityLiveRegion="polite"
                        mode="info"
                        showChevron={false}
                    />
                ) : (
                    <Item
                        testID="mcp.server.test.result.error"
                        title={t('settings.mcpServersTestResultErrorTitle')}
                        subtitle={`${lastResult.errorCode} · ${lastResult.error}`}
                        subtitleLines={0}
                        subtitleLeading={<View style={collectionListStyles.troubleDot} />}
                        accessibilityLiveRegion="polite"
                        mode="info"
                        showChevron={false}
                    />
                )
            ) : null}
        </ItemGroup>
    );
});
