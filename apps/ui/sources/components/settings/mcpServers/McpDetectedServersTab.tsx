import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { DaemonMcpServersDetectWarningV1, DetectedMcpServerV1 } from '@happier-dev/protocol';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PathInputBrowseButton } from '@/components/ui/pathBrowser/PathInputBrowseButton';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { TextInput } from '@/components/ui/text/Text';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import { describeMachine, formatDetectedWarning, resolveDetectedServerStatusLabel, resolveTransportIconName } from './mcpServerUi';
import { resolveMachineServerId } from './resolveMachineServerId';

export const McpDetectedServersTab = React.memo(function McpDetectedServersTab(props: Readonly<{
    machines: readonly Machine[];
    machineItems: readonly DropdownMenuItem[];
    selectedMachineId: string | null;
    onSelectMachine: (machineId: string) => void;
    machineMenuOpen: boolean;
    onMachineMenuOpenChange: (open: boolean) => void;
    directory: string;
    onChangeDirectory: (value: string) => void;
    loading: boolean;
    detected: DetectedMcpServerV1[] | null;
    warnings: DaemonMcpServersDetectWarningV1[] | null;
    onRefresh: () => void;
    onImport: (server: DetectedMcpServerV1) => void;
}>) {
    const { theme } = useUnistyles();
    const selectedMachineServerId = React.useMemo(
        () => resolveMachineServerId(props.machines, props.selectedMachineId),
        [props.machines, props.selectedMachineId],
    );

    const handleBrowseDirectory = React.useCallback(async () => {
        if (!props.selectedMachineId) return;
        const selected = await openMachinePathBrowserModal({
            machineId: props.selectedMachineId,
            serverId: selectedMachineServerId,
            initialPath: props.directory,
            title: t('settings.mcpServersDetectedDirectoryTitle'),
        });
        if (selected) {
            props.onChangeDirectory(selected);
        }
    }, [props.directory, props.onChangeDirectory, props.selectedMachineId, selectedMachineServerId]);

    return (
        <>
            <ItemGroup title={t('settings.mcpServersDetectedTitle')}>
                <DropdownMenu
                    open={props.machineMenuOpen}
                    onOpenChange={props.onMachineMenuOpenChange}
                    items={props.machineItems}
                    selectedId={props.selectedMachineId}
                    onSelect={(id) => props.onSelectMachine(id)}
                    itemTrigger={{
                        title: t('settings.mcpServersDetectedMachineTitle'),
                        subtitle: props.selectedMachineId
                            ? describeMachine(props.selectedMachineId, props.machines)
                            : t('settings.mcpServersNoMachineSelected'),
                        icon: <Ionicons name="laptop-outline" size={29} color={theme.colors.accent.indigo} />,
                    }}
                    rowKind="item"
                    connectToTrigger
                    variant="default"
                />

                <Item
                    testID="settings.mcpServers.detect.directory"
                    title={t('settings.mcpServersDetectedDirectoryTitle')}
                    subtitle={t('settings.mcpServersDetectedDirectorySubtitle')}
                    icon={<Ionicons name="folder-open-outline" size={29} color={theme.colors.accent.blue} />}
                    showChevron={false}
                    rightElement={(
                        <View style={styles.directoryInputRow}>
                            <TextInput
                                testID="settings.mcpServers.detect.directoryInput"
                                style={[styles.directoryInput, styles.directoryInputField]}
                                value={props.directory}
                                onChangeText={props.onChangeDirectory}
                                placeholder={t('settings.mcpServersDetectedDirectoryPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                            />
                            <PathInputBrowseButton
                                onPress={handleBrowseDirectory}
                                disabled={!props.selectedMachineId}
                            />
                        </View>
                    )}
                />

                <Item
                    testID="settings.mcpServers.detect.refresh"
                    title={t('settings.mcpServersDetectedRefreshTitle')}
                    subtitle={props.loading ? t('common.loading') : t('settings.mcpServersDetectedRefreshSubtitle')}
                    icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={props.onRefresh}
                    disabled={props.loading || !props.selectedMachineId}
                    showChevron={false}
                />
            </ItemGroup>

            {props.warnings && props.warnings.length > 0 ? (
                <ItemGroup title={t('settings.mcpServersDetectedWarningsTitle')}>
                    {props.warnings.map((warning, index) => (
                    <Item
                        key={`${warning.provider}:${warning.code}:${index}`}
                        title={t('settings.mcpServersDetectedWarningsTitle')}
                        subtitle={formatDetectedWarning(warning)}
                        icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.text.secondary} />}
                        showChevron={false}
                    />
                    ))}
                </ItemGroup>
            ) : null}

            <ItemGroup title={t('settings.mcpServersSegmentDetected')}>
                {props.detected && props.detected.length > 0 ? (
                    props.detected.map((server, index) => (
                        <Item
                            key={`${server.provider}:${server.name}:${index}`}
                            testID={`mcp.detected.card.${index}`}
                            title={server.name}
                            subtitle={server.transport === 'stdio'
                                ? [server.stdio?.command ?? '', ...(server.stdio?.args ?? [])].filter(Boolean).join(' ')
                                : (server.remote?.url ?? '')}
                            icon={<Ionicons name={resolveTransportIconName(server.transport)} size={29} color={theme.colors.accent.blue} />}
                            detail={resolveDetectedServerStatusLabel(server.provider, server.enabled)}
                            onPress={() => props.onImport(server)}
                        />
                    ))
                ) : (
                    <Item
                        testID="settings.mcpServers.detect.empty"
                        title={t('settings.mcpServersDetectedEmptyTitle')}
                        subtitle={t('settings.mcpServersDetectedEmptySubtitle')}
                        icon={<Ionicons name="search-outline" size={29} color={theme.colors.text.secondary} />}
                        showChevron={false}
                        mode="info"
                    />
                )}
            </ItemGroup>
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    directoryInputRow: {
        minWidth: 180,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    directoryInput: {
        borderRadius: 12,
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 14,
        lineHeight: 18,
    },
    directoryInputField: {
        flex: 1,
        minWidth: 0,
    },
}));
