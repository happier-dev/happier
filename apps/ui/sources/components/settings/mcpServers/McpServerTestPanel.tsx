import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { McpServerBindingV1, McpServerCatalogEntryV1 } from '@happier-dev/protocol';
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
import { t } from '@/text';
import { resolveMachineServerId } from './resolveMachineServerId';

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

function describeMachine(machineId: string, machines: readonly Machine[]): string {
    const machine = machines.find((m) => m.id === machineId) ?? null;
    return machine?.metadata?.displayName || machine?.metadata?.host || machineId;
}

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
}>) {
    const { theme } = useUnistyles();

    const [machineId, setMachineId] = React.useState<string | null>(() => props.machines[0]?.id ?? null);
    const [bindingId, setBindingId] = React.useState<string | null>(null);
    const [openMenu, setOpenMenu] = React.useState<'machine' | 'binding' | null>(null);
    const [directory, setDirectory] = React.useState<string>('');
    const [lastResult, setLastResult] = React.useState<null | { ok: true; toolCount: number; durationMs: number } | { ok: false; errorCode: string; error: string; durationMs: number }>(null);

    React.useEffect(() => {
        if (machineId && props.machines.some((m) => m.id === machineId)) return;
        setMachineId(props.machines[0]?.id ?? null);
    }, [machineId, props.machines]);

    const machineItems = React.useMemo((): DropdownMenuItem[] => {
        return props.machines.map((m) => ({
            id: m.id,
            title: m.metadata?.displayName || m.metadata?.host || m.id,
            subtitle: m.id,
            icon: <Ionicons name="laptop-outline" size={22} color={theme.colors.text.secondary} />,
        }));
    }, [props.machines, theme.colors.text.secondary]);

    const bindingItems = React.useMemo((): DropdownMenuItem[] => {
        const items: DropdownMenuItem[] = [
            {
                id: '',
                title: t('settings.mcpServersTestNoBinding'),
                subtitle: t('settings.mcpServersTestNoBindingSubtitle'),
                icon: <Ionicons name="remove-circle-outline" size={22} color={theme.colors.text.secondary} />,
            },
        ];

        for (const binding of props.bindings) {
            items.push({
                id: binding.id,
                title: describeBinding(binding, props.machines),
                subtitle: binding.enabled ? t('common.enabled') : t('common.disabled'),
                icon: <Ionicons name="pin-outline" size={22} color={theme.colors.text.secondary} />,
            });
        }

        return items;
    }, [props.bindings, props.machines, theme.colors.text.secondary]);

    const selectedBinding = React.useMemo(() => {
        if (!bindingId) return null;
        return props.bindings.find((b) => b.id === bindingId) ?? null;
    }, [bindingId, props.bindings]);
    const selectedMachineServerId = React.useMemo(
        () => resolveMachineServerId(props.machines, machineId),
        [machineId, props.machines],
    );

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
        if (!machineId) {
            Modal.alert(t('common.error'), t('settings.mcpServersNoMachineSelected'));
            return;
        }
        const parsed = McpServerCatalogEntryV1Schema.safeParse(props.server);
        if (!parsed.success) {
            Modal.alert(t('common.error'), t('settings.mcpServersValidationFailed'));
            return;
        }
        const binding = selectedBinding ? McpServerBindingV1Schema.parse(selectedBinding) : null;
        const response = await machineMcpServersTest(machineId, {
            t: 'draft',
            directory: directory.trim() || '/',
            server: parsed.data,
            binding,
        });

        if (response.ok) {
            setLastResult({ ok: true, toolCount: response.toolCount, durationMs: response.durationMs });
        } else {
            setLastResult({ ok: false, errorCode: response.errorCode, error: response.error, durationMs: response.durationMs });
        }
    });

    const handleBrowseDirectory = React.useCallback(async () => {
        if (!machineId) return;
        const selected = await openMachinePathBrowserModal({
            machineId,
            serverId: selectedMachineServerId,
            initialPath: directory.trim(),
            title: t('settings.mcpServersTestDirectoryTitle'),
        });
        if (typeof selected === 'string') {
            setDirectory(selected);
        }
    }, [directory, machineId, selectedMachineServerId]);

    return (
        <ItemGroup title={t('settings.mcpServersTestTitle')} footer={t('settings.mcpServersTestFooter')}>
            <DropdownMenu
                open={openMenu === 'machine'}
                onOpenChange={(open) => setOpenMenu(open ? 'machine' : null)}
                items={machineItems}
                selectedId={machineId}
                onSelect={(id) => {
                    setMachineId(id);
                    setOpenMenu(null);
                }}
                itemTrigger={{
                    title: t('settings.mcpServersTestMachineTitle'),
                    subtitle: machineId ? describeMachine(machineId, props.machines) : t('settings.mcpServersNoMachineSelected'),
                    icon: <Ionicons name="laptop-outline" size={29} color={theme.colors.accent.indigo} />,
                }}
                rowKind="item"
                connectToTrigger
                variant="default"
            />

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
                    icon: <Ionicons name="pin-outline" size={29} color={theme.colors.accent.purple} />,
                }}
                rowKind="item"
                connectToTrigger
                variant="default"
            />

            <Item
                testID="mcp.server.test.directory"
                title={t('settings.mcpServersTestDirectoryTitle')}
                subtitle={t('settings.mcpServersTestDirectorySubtitle')}
                icon={<Ionicons name="folder-outline" size={29} color={theme.colors.accent.blue} />}
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
                            disabled={!machineId}
                        />
                    </View>
                )}
            />

            <Item
                testID="mcp.server.test.run"
                title={t('settings.mcpServersTestRunTitle')}
                subtitle={isTesting ? t('common.loading') : t('settings.mcpServersTestRunSubtitle')}
                icon={<Ionicons name="flask-outline" size={29} color={theme.colors.state.success.foreground} />}
                onPress={runTest}
                disabled={!machineId || !canTestServer || !canTestBinding || isTesting}
                showChevron={false}
            />

            {lastResult ? (
                lastResult.ok ? (
                    <Item
                        testID="mcp.server.test.result.ok"
                        title={t('settings.mcpServersTestResultOkTitle')}
                        subtitle={t('settings.mcpServersTestResultOkSubtitle', { toolCount: lastResult.toolCount, durationMs: lastResult.durationMs })}
                        icon={<Ionicons name="checkmark-circle-outline" size={29} color={theme.colors.state.success.foreground} />}
                        showChevron={false}
                    />
                ) : (
                    <Item
                        testID="mcp.server.test.result.error"
                        title={t('settings.mcpServersTestResultErrorTitle')}
                        subtitle={`${lastResult.errorCode} · ${lastResult.error}`}
                        icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.status.error} />}
                        showChevron={false}
                    />
                )
            ) : null}
        </ItemGroup>
    );
});
