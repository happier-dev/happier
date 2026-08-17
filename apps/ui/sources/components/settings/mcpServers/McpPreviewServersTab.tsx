import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { DaemonMcpServersPreviewResponse } from '@happier-dev/protocol';
import type { AgentCoreConfig, AgentId } from '@/agents/registry/registryCore';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PathInputBrowseButton } from '@/components/ui/pathBrowser/PathInputBrowseButton';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

import { McpServerBadgePills } from './McpServerBadgePills';
import { McpServerRowSummary } from './McpServerRowSummary';
import {
    resolveAgentToolsDeliveryDescription,
    resolveAgentToolsDeliveryLabel,
    resolveAuthBadgeLabel,
    resolveDetectedAvailabilityLabel,
    resolveManagedAvailabilityLabel,
    resolvePreviewScopeLabel,
    resolveTransportIconName,
    resolveTransportLabel,
} from './mcpServerUi';
import { Icon } from '@/components/ui/icons/Icon';

type PreviewSuccess = Extract<DaemonMcpServersPreviewResponse, { ok: true }>;

export const McpPreviewServersTab = React.memo(function McpPreviewServersTab(props: Readonly<{
    agentItems: readonly DropdownMenuItem[];
    selectedAgentTools: AgentCoreConfig['tools'];
    selectedMachineId: string | null;
    selectedServerId: string | null;
    canExecute: boolean;
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

    const handleBrowseDirectory = React.useCallback(async () => {
        if (!props.selectedMachineId || !props.selectedServerId || !props.canExecute) return;
        const selected = await openMachinePathBrowserModal({
            machineId: props.selectedMachineId,
            serverId: props.selectedServerId,
            initialPath: props.directory,
            title: t('settings.mcpServersPreviewDirectoryTitle'),
        });
        if (selected) {
            props.onChangeDirectory(selected);
        }
    }, [props.canExecute, props.directory, props.onChangeDirectory, props.selectedMachineId, props.selectedServerId]);

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
                        icon: <Icon name="sparkle" size={29} color={theme.colors.accent.blue} />,
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
                    icon={<Icon name="cpu" size={29} color={theme.colors.accent.green} />}
                    showChevron={false}
                    mode="info"
                />

                <Item
                    testID="settings.mcpServers.preview.directory"
                    title={t('settings.mcpServersPreviewDirectoryTitle')}
                    subtitle={t('settings.mcpServersPreviewDirectorySubtitle')}
                    icon={<Icon name="folder-open" size={29} color={theme.colors.accent.blue} />}
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
                                disabled={!props.canExecute}
                            />
                        </View>
                    )}
                />

                <Item
                    testID="settings.mcpServers.preview.refresh"
                    title={t('settings.mcpServersPreviewRefreshTitle')}
                    subtitle={props.loading ? t('common.loading') : t('settings.mcpServersPreviewRefreshSubtitle')}
                    icon={<Icon name="eye" size={29} color={theme.colors.accent.blue} />}
                    onPress={props.onRefresh}
                    disabled={props.loading || !props.canExecute}
                    showChevron={false}
                />
            </ItemGroup>

            {!props.preview ? (
                <ItemGroup>
                    <Item
                        testID="settings.mcpServers.preview.empty"
                        title={t('settings.mcpServersPreviewEmptyTitle')}
                        subtitle={t('settings.mcpServersPreviewEmptySubtitle')}
                        icon={<Icon name="eye" size={29} color={theme.colors.text.secondary} />}
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
                                icon={<Icon name={resolveTransportIconName(entry.transport)} size={29} color={theme.colors.accent.blue} />}
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
                                icon={<Icon name={resolveTransportIconName(entry.transport)} size={29} color={theme.colors.accent.blue} />}
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
                                icon={<Icon name={resolveTransportIconName(entry.transport)} size={29} color={theme.colors.accent.blue} />}
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
