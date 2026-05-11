import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { McpServerBindingV1, McpServerCatalogEntryV1, McpServersSettingsV1 } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { Switch } from '@/components/ui/forms/Switch';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { listMcpQuickInstallPresets, type McpQuickInstallPresetId } from '@/sync/domains/settings/mcpServers/mcpQuickInstallCatalog';

import { McpServerBadgePills } from './McpServerBadgePills';
import { describeConfiguredServerEndpoint, resolveBindingBadgeLabels, resolveTransportIconName } from './mcpServerUi';

export const McpConfiguredServersTab = React.memo(function McpConfiguredServersTab(props: Readonly<{
    settings: McpServersSettingsV1;
    serverRows: ReadonlyArray<{ server: McpServerCatalogEntryV1; bindings: McpServerBindingV1[] }>;
    machines: readonly Machine[];
    onToggleStrictMode: () => void;
    onEditServer: (serverId: string) => void;
    onDeleteServer: (serverId: string) => void | Promise<void>;
    onAddServer: () => void;
    onOpenQuickInstall: (presetId: McpQuickInstallPresetId) => void;
}>) {
    const { theme } = useUnistyles();
    const quickInstallPresets = React.useMemo(() => listMcpQuickInstallPresets(), []);

    return (
        <>
            <ItemGroup title={t('settings.mcpServersSegmentConfigured')}>
                {props.serverRows.length === 0 ? (
                    <Item
                    testID="settings.mcpServers.empty"
                    title={t('settings.mcpServersEmptyTitle')}
                    subtitle={t('settings.mcpServersConfiguredEmptySubtitle')}
                    icon={<Ionicons name="extension-puzzle-outline" size={29} color={theme.colors.accent.purple} />}
                    showChevron={false}
                    mode="info"
                />
                ) : (
                    props.serverRows.map(({ server, bindings }) => (
                        <Item
                            key={server.id}
                            testID={`mcp.server.card.${server.id}`}
                            title={server.title || server.name || t('settings.mcpServersUnnamed')}
                            subtitle={describeConfiguredServerEndpoint(server)}
                            subtitleAccessory={(
                                <McpServerBadgePills
                                    size="compact"
                                    align="start"
                                    badges={resolveBindingBadgeLabels(bindings, props.machines).map((label, index) => ({
                                        key: `${server.id}:scope:${index}`,
                                        label,
                                    }))}
                                />
                            )}
                            icon={<Ionicons name={resolveTransportIconName(server.transport)} size={29} color={theme.colors.accent.blue} />}
                            rightElement={(
                                <ItemRowActions
                                    title={server.title || server.name || t('settings.mcpServersUnnamed')}
                                    compactActionIds={['edit']}
                                    actions={[
                                        {
                                            id: 'edit',
                                            title: t('settings.mcpServersEditAction'),
                                            icon: 'pencil-outline',
                                            onPress: () => props.onEditServer(server.id),
                                        },
                                        {
                                            id: 'delete',
                                            title: t('settings.mcpServersDeleteAction'),
                                            icon: 'trash-outline',
                                            destructive: true,
                                            onPress: () => { void props.onDeleteServer(server.id); },
                                        },
                                    ]}
                                />
                            )}
                            onPress={() => props.onEditServer(server.id)}
                        />
                    ))
                )}
            </ItemGroup>

            <ItemGroup>
                <Item
                    testID="settings.mcpServers.addServer"
                    title={t('settings.mcpServersAddServer')}
                    subtitle={t('settings.mcpServersAddServerSubtitle')}
                    icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.state.success.foreground} />}
                    onPress={props.onAddServer}
                />
            </ItemGroup>

            <ItemGroup title={t('settings.mcpServersQuickInstallTitle')} footer={t('settings.mcpServersQuickInstallSubtitle')}>
                {quickInstallPresets.map((preset) => (
                    <Item
                        key={preset.id}
                        testID={`settings.mcpServers.quickInstall.${preset.id}`}
                        title={preset.title}
                        subtitle={preset.description}
                        icon={<Ionicons name="flash-outline" size={29} color={theme.colors.state.success.foreground} />}
                        onPress={() => props.onOpenQuickInstall(preset.id)}
                    />
                ))}
            </ItemGroup>

            <ItemGroup title={t('settings.mcpServersAdvancedTitle')} footer={t('settings.mcpServersAdvancedSubtitle')}>
                <Item
                    testID="settings.mcpServers.strictMode"
                    title={t('settings.mcpServersStrictMode')}
                    subtitle={t('settings.mcpServersStrictModeSubtitle')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color={theme.colors.accent.purple} />}
                    rightElement={<Switch value={Boolean(props.settings.strictMode)} onValueChange={props.onToggleStrictMode} />}
                    onPress={props.onToggleStrictMode}
                    showChevron={false}
                />
            </ItemGroup>
        </>
    );
});
