import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { DaemonMcpServersPreviewResponse } from '@happier-dev/protocol';
import type { AgentCoreConfig, AgentId } from '@/agents/registry/registryCore';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PathInputBrowseButton } from '@/components/ui/pathBrowser/PathInputBrowseButton';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { TextInput } from '@/components/ui/text/Text';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import { McpServerBadgePills } from './McpServerBadgePills';
import { McpServerRowSummary } from './McpServerRowSummary';
import {
    describeMachine,
    resolveAgentToolsDeliveryDescription,
    resolveAgentToolsDeliveryLabel,
    resolveAuthBadgeLabel,
    resolveDetectedAvailabilityLabel,
    resolveManagedAvailabilityLabel,
    resolvePreviewScopeLabel,
    resolveTransportIconName,
    resolveTransportLabel,
} from './mcpServerUi';
import { resolveMachineServerId } from './resolveMachineServerId';

type PreviewSuccess = Extract<DaemonMcpServersPreviewResponse, { ok: true }>;

export const McpPreviewServersTab = React.memo(function McpPreviewServersTab(props: Readonly<{
    machines: readonly Machine[];
    machineItems: readonly DropdownMenuItem[];
    agentItems: readonly DropdownMenuItem[];
    selectedAgentTools: AgentCoreConfig['tools'];
    selectedMachineId: string | null;
    onSelectMachine: (machineId: string) => void;
    machineMenuOpen: boolean;
    onMachineMenuOpenChange: (open: boolean) => void;
    selectedAgentId: AgentId;
    onSelectAgentId: (agentId: AgentId) => void;
    agentMenuOpen: boolean;
    onAgentMenuOpenChange: (open: boolean) => void;
    directory: string;
    onChangeDirectory: (value: string) => void;
    loading: boolean;
    preview: PreviewSuccess | null;
    onRefresh: () => void;
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
            title: t('settings.mcpServersPreviewDirectoryTitle'),
        });
        if (selected) {
            props.onChangeDirectory(selected);
        }
    }, [props.directory, props.onChangeDirectory, props.selectedMachineId, selectedMachineServerId]);

    return (
        <>
            <ItemGroup title={t('settings.mcpServersSegmentPreview')}>
                <DropdownMenu
                    open={props.agentMenuOpen}
                    onOpenChange={props.onAgentMenuOpenChange}
                    items={props.agentItems}
                    selectedId={props.selectedAgentId}
                    onSelect={(agentId) => props.onSelectAgentId(agentId as AgentId)}
                    itemTrigger={{
                        title: t('settings.mcpServersPreviewAgentTitle'),
                        subtitle: props.selectedAgentId,
                        icon: <Ionicons name="sparkles-outline" size={29} color={theme.colors.accent.blue} />,
                    }}
                    rowKind="item"
                    connectToTrigger
                    variant="default"
                />

                <DropdownMenu
                    open={props.machineMenuOpen}
                    onOpenChange={props.onMachineMenuOpenChange}
                    items={props.machineItems}
                    selectedId={props.selectedMachineId}
                    onSelect={props.onSelectMachine}
                    itemTrigger={{
                        title: t('settings.mcpServersPreviewMachineTitle'),
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
                    testID="settings.mcpServers.preview.delivery"
                    title={t('settings.mcpServersPreviewDeliveryTitle')}
                    subtitle={resolveAgentToolsDeliveryDescription(props.selectedAgentTools.delivery)}
                    detail={resolveAgentToolsDeliveryLabel(props.selectedAgentTools.delivery)}
                    icon={<Ionicons name="hardware-chip-outline" size={29} color={theme.colors.accent.green} />}
                    showChevron={false}
                    mode="info"
                />

                <Item
                    testID="settings.mcpServers.preview.directory"
                    title={t('settings.mcpServersPreviewDirectoryTitle')}
                    subtitle={t('settings.mcpServersPreviewDirectorySubtitle')}
                    icon={<Ionicons name="folder-open-outline" size={29} color={theme.colors.accent.blue} />}
                    showChevron={false}
                    rightElement={(
                        <View style={styles.directoryInputRow}>
                            <TextInput
                                testID="settings.mcpServers.preview.directoryInput"
                                style={[styles.directoryInput, styles.directoryInputField]}
                                value={props.directory}
                                onChangeText={props.onChangeDirectory}
                                placeholder={t('settings.mcpServersPreviewDirectoryPlaceholder')}
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
                    testID="settings.mcpServers.preview.refresh"
                    title={t('settings.mcpServersPreviewRefreshTitle')}
                    subtitle={props.loading ? t('common.loading') : t('settings.mcpServersPreviewRefreshSubtitle')}
                    icon={<Ionicons name="eye-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={props.onRefresh}
                    disabled={props.loading || !props.selectedMachineId}
                    showChevron={false}
                />
            </ItemGroup>

            {!props.preview ? (
                <ItemGroup>
                    <Item
                        testID="settings.mcpServers.preview.empty"
                        title={t('settings.mcpServersPreviewEmptyTitle')}
                        subtitle={t('settings.mcpServersPreviewEmptySubtitle')}
                        icon={<Ionicons name="eye-outline" size={29} color={theme.colors.text.secondary} />}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>
            ) : (
                <>
                    <ItemGroup title={t('settings.mcpServersSourceBuiltIn')}>
                        {props.preview.builtIn.map((entry) => (
                            <Item
                                key={entry.key}
                                title={entry.title || entry.name}
                                subtitle={(
                                    <McpServerRowSummary
                                        primary={resolvePreviewScopeLabel(entry.scopeKind)}
                                        secondary={t('settings.mcpServersBuiltInDescription')}
                                    />
                                )}
                                icon={<Ionicons name={resolveTransportIconName(entry.transport)} size={29} color={theme.colors.accent.blue} />}
                                detail={resolveTransportLabel(entry.transport)}
                                rightElement={(
                                    <McpServerBadgePills
                                        badges={[
                                            { key: `${entry.key}:source`, label: t('settings.mcpServersSourceBuiltIn'), tone: 'success' },
                                            { key: `${entry.key}:auth`, label: resolveAuthBadgeLabel(entry.authMode) },
                                        ]}
                                    />
                                )}
                                showChevron={false}
                                mode="info"
                            />
                        ))}
                    </ItemGroup>

                    <ItemGroup title={t('settings.mcpServersSourceHappier')}>
                        {props.preview.managed.map((entry) => (
                            <Item
                                key={entry.key}
                                title={entry.title || entry.name}
                                subtitle={(
                                    <McpServerRowSummary
                                        primary={resolvePreviewScopeLabel(entry.scopeKind)}
                                        secondary={resolveManagedAvailabilityLabel(entry)}
                                    />
                                )}
                                icon={<Ionicons name={resolveTransportIconName(entry.transport)} size={29} color={theme.colors.accent.blue} />}
                                detail={resolveTransportLabel(entry.transport)}
                                rightElement={(
                                    <McpServerBadgePills
                                        badges={[
                                            { key: `${entry.key}:source`, label: t('settings.mcpServersSourceHappier'), tone: entry.selected ? 'success' : 'accent' },
                                            { key: `${entry.key}:auth`, label: resolveAuthBadgeLabel(entry.authMode) },
                                        ]}
                                    />
                                )}
                                showChevron={false}
                                mode="info"
                            />
                        ))}
                    </ItemGroup>

                    <ItemGroup title={t('settings.mcpServersSourceDetected')}>
                        {props.preview.detected.map((entry) => (
                            <Item
                                key={entry.key}
                                title={entry.title || entry.name}
                                subtitle={(
                                    <McpServerRowSummary
                                        primary={`${entry.provider} · ${resolvePreviewScopeLabel(entry.scopeKind)}`}
                                        secondary={entry.sourcePath}
                                    />
                                )}
                                icon={<Ionicons name={resolveTransportIconName(entry.transport)} size={29} color={theme.colors.accent.blue} />}
                                detail={resolveTransportLabel(entry.transport)}
                                rightElement={(
                                    <McpServerBadgePills
                                        badges={[
                                            { key: `${entry.key}:source`, label: t('settings.mcpServersSourceDetected'), tone: 'warning' },
                                            { key: `${entry.key}:availability`, label: resolveDetectedAvailabilityLabel(entry) },
                                            { key: `${entry.key}:auth`, label: resolveAuthBadgeLabel(entry.authMode) },
                                        ]}
                                    />
                                )}
                                showChevron={false}
                                mode="info"
                            />
                        ))}
                    </ItemGroup>
                </>
            )}
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
