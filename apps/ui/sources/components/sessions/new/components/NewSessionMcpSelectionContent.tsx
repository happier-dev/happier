import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
    DaemonMcpServersPreviewResponse,
    McpServerCatalogEntryV1,
    SessionMcpSelectionV1,
} from '@happier-dev/protocol';
import { resolveManagedSessionMcpSelectionV1 } from '@happier-dev/protocol';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import {
    resolveAuthBadgeLabel,
    resolveDetectedAvailabilityLabel,
    resolveManagedServerAuthMode,
    resolvePreviewScopeLabel,
} from '@/components/settings/mcpServers/mcpServerUi';
import {
    setManagedSessionMcpServersEnabled,
    toggleManagedSessionMcpSelection,
} from '@/components/sessions/new/modules/sessionMcpSelectionState';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemListStatic } from '@/components/ui/lists/ItemList';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { normalizeMcpServersSettingsV1 } from '@/sync/domains/settings/mcpServers/normalizeMcpServersSettingsV1';

type PreviewSuccess = Extract<DaemonMcpServersPreviewResponse, { ok: true }>;

export type NewSessionMcpSelectionContentProps = Readonly<{
    machineId?: string | null;
    machineName?: string | null;
    directory: string;
    agentType: AgentId;
    hasContext: boolean;
    preview: PreviewSuccess | null;
    selection: SessionMcpSelectionV1;
    loading: boolean;
    error: string | null;
    previewUnsupported?: boolean;
    onSelectionChange: (selection: SessionMcpSelectionV1) => void;
    onRefresh: () => void;
    onOpenSettings: () => void;
    onClose: () => void;
    maxHeight: number;
}>;

type GroupActionButtonProps = Readonly<{
    testID: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    loading?: boolean;
    onPress: () => void;
}>;

function GroupActionButton(props: GroupActionButtonProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const isLoading = props.loading === true;

    return (
        <Pressable
            testID={props.testID}
            onPress={isLoading ? undefined : props.onPress}
            disabled={isLoading}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={({ pressed }) => [
                styles.groupActionButton,
                pressed ? styles.groupActionButtonPressed : null,
            ]}
        >
            {isLoading ? (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            ) : (
                normalizeNodeForView(
                    <Ionicons name={props.icon} size={18} color={theme.colors.textSecondary} />,
                )
            )}
        </Pressable>
    );
}

function GroupTitleRow(props: Readonly<{
    title: string;
    actions?: React.ReactNode;
}>) {
    const styles = stylesheet;

    return (
        <View style={styles.groupTitleRow}>
            <View style={styles.groupTitleTextWrap}>
                <Text style={styles.groupTitleText}>{props.title}</Text>
            </View>
            {props.actions ? (
                <View style={styles.groupActions}>
                    {props.actions}
                </View>
            ) : null}
        </View>
    );
}

function describeManagedReason(reasonCode: string): string {
    switch (reasonCode) {
        case 'active_by_default':
            return t('newSession.mcpReasonActiveByDefault');
        case 'forced_included':
            return t('newSession.mcpReasonForcedIncluded');
        case 'forced_excluded':
            return t('newSession.mcpReasonForcedExcluded');
        case 'managed_servers_disabled':
            return t('newSession.mcpReasonManagedDisabled');
        case 'binding_disabled':
            return t('newSession.mcpReasonBindingDisabled');
        case 'available_portable':
            return t('newSession.mcpReasonAvailablePortable');
        case 'not_portable':
            return t('newSession.mcpReasonNotPortable');
        default:
            return t('newSession.mcpReasonNotPortable');
    }
}

function resolveManagedAvailabilityLabel(availability: 'active' | 'available' | 'unavailable'): string {
    if (availability === 'active') return t('settings.mcpServersStatusActive');
    if (availability === 'available') return t('settings.mcpServersStatusAvailable');
    return t('settings.mcpServersStatusUnavailable');
}

export function NewSessionMcpSelectionContent(props: NewSessionMcpSelectionContentProps) {
    const styles = stylesheet;
    const showNoContextState = !props.loading && !props.hasContext;
    const preview = props.preview;

    const mcpServersSettingsRaw = useSetting('mcpServersSettingsV1');
    const mcpServersSettings = React.useMemo(
        () => normalizeMcpServersSettingsV1(mcpServersSettingsRaw),
        [mcpServersSettingsRaw],
    );

    const happierServerCount = mcpServersSettings.servers.length;

    const happierServers = React.useMemo((): readonly McpServerCatalogEntryV1[] => {
        return mcpServersSettings.servers
            .slice()
            .sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name));
    }, [mcpServersSettings.servers]);

    const agentDisplayName = t(getAgentCore(props.agentType).displayNameKey);
    const detectedSectionTitle = t('newSession.mcpDetectedSectionTitleForAgent', { agentName: agentDisplayName });

    const handleToggleManagedEnabled = React.useCallback((value: boolean) => {
        props.onSelectionChange(setManagedSessionMcpServersEnabled(props.selection, value));
    }, [props.onSelectionChange, props.selection]);

    const managedResolution = React.useMemo(() => {
        if (!props.machineId || !props.directory.trim()) return null;
        try {
            return resolveManagedSessionMcpSelectionV1(mcpServersSettings, {
                machineId: props.machineId,
                directory: props.directory.trim(),
                selection: props.selection,
            });
        } catch {
            return null;
        }
    }, [mcpServersSettings, props.directory, props.machineId, props.selection]);

    const renderManagedServerRow = React.useCallback((server: McpServerCatalogEntryV1) => {
        const item = managedResolution?.itemsByName[server.name] ?? null;

        if (!item) {
            return (
                <Item
                    key={server.id}
                    testID={`new-session.mcp.row.${server.id}`}
                    title={server.title ?? server.name}
                    subtitle={server.title ? server.name : undefined}
                    showChevron={false}
                />
            );
        }

        const scopeKind = item.bindingTargetKind === 'allMachines'
            ? 'allMachines'
            : item.bindingTargetKind === 'workspace'
                ? 'workspace'
                : 'machine';

        const subtitle = [
            resolvePreviewScopeLabel(scopeKind),
            resolveManagedServerAuthMode(server),
            describeManagedReason(item.reasonCode),
        ].filter(Boolean).join(' · ');

        return (
            <Item
                key={server.id}
                testID={`new-session.mcp.row.${server.id}`}
                title={server.title ?? server.name}
                subtitle={subtitle}
                detail={resolveManagedAvailabilityLabel(item.availability)}
                selected={false}
                disabled={!item.selectable}
                showChevron={false}
                onPress={item.selectable
                    ? () => props.onSelectionChange(toggleManagedSessionMcpSelection(props.selection, {
                        serverId: server.id,
                        selected: item.selected,
                        selectable: item.selectable,
                        defaultSelected: item.defaultSelected,
                    }))
                    : undefined}
                rightElement={item.selectable ? (
                    <Switch
                        value={item.selected}
                        onValueChange={() => props.onSelectionChange(toggleManagedSessionMcpSelection(props.selection, {
                            serverId: server.id,
                            selected: item.selected,
                            selectable: item.selectable,
                            defaultSelected: item.defaultSelected,
                        }))}
                    />
                ) : null}
            />
        );
    }, [managedResolution?.itemsByName, props.onSelectionChange, props.selection]);

    return (
        <View style={[styles.container, { maxHeight: props.maxHeight }]}>
            <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator
                keyboardShouldPersistTaps="handled"
            >
                <ItemListStatic style={styles.list}>
                    <ItemGroup
                        title={(
                            <GroupTitleRow
                                title={t('newSession.mcpHappierSectionTitle')}
                                actions={(
                                    <>
                                        <GroupActionButton
                                            testID="new-session.mcp.happier.refresh"
                                            icon="refresh-outline"
                                            loading={props.loading}
                                            onPress={props.onRefresh}
                                        />
                                        <GroupActionButton
                                            testID="new-session.mcp.happier.open-settings"
                                            icon="settings-outline"
                                            onPress={props.onOpenSettings}
                                        />
                                    </>
                                )}
                            />
                        )}
                    >
                        {happierServerCount === 0 ? (
                            <Item
                                testID="new-session.mcp.happier-empty"
                                title={t('newSession.mcpHappierEmptyTitle')}
                                subtitle={t('newSession.mcpHappierEmptySubtitle')}
                                showChevron={false}
                                rightElement={(
                                    <View style={styles.emptyActions}>
                                        <GroupActionButton
                                            testID="new-session.mcp.happier.empty.refresh"
                                            icon="refresh-outline"
                                            loading={props.loading}
                                            onPress={props.onRefresh}
                                        />
                                        <GroupActionButton
                                            testID="new-session.mcp.happier.empty.open-settings"
                                            icon="settings-outline"
                                            onPress={props.onOpenSettings}
                                        />
                                    </View>
                                )}
                            />
                        ) : (
                            <>
                                {happierServerCount > 0 ? (
                                    <Item
                                        testID="new-session.mcp.managed-enabled"
                                        title={t('newSession.mcpManagedToggleTitle')}
                                        subtitle={props.selection.managedServersEnabled
                                            ? t('settings.mcpServersStatusActive')
                                            : t('settings.mcpServersStatusUnavailable')}
                                        showChevron={false}
                                        onPress={() => handleToggleManagedEnabled(!props.selection.managedServersEnabled)}
                                        rightElement={(
                                            <Switch
                                                value={props.selection.managedServersEnabled}
                                                onValueChange={handleToggleManagedEnabled}
                                            />
                                        )}
                                    />
                                ) : null}

                                {happierServers.map(renderManagedServerRow)}
                            </>
                        )}
                    </ItemGroup>

                    {showNoContextState ? (
                        <ItemGroup title={t('newSession.mcpUnavailableNoContextTitle')}>
                            <Item
                                testID="new-session.mcp.empty"
                                title={t('newSession.mcpUnavailableNoContextTitle')}
                                subtitle={t('newSession.mcpUnavailableNoContextSubtitle')}
                                showChevron={false}
                            />
                        </ItemGroup>
                    ) : null}

                    {props.hasContext ? (
                        <ItemGroup
                            title={(
                                <GroupTitleRow
                                    title={detectedSectionTitle}
                                    actions={(
                                        <GroupActionButton
                                            testID="new-session.mcp.detected.refresh"
                                            icon="refresh-outline"
                                            loading={props.loading}
                                            onPress={props.onRefresh}
                                        />
                                    )}
                                />
                            )}
                        >
                            {props.previewUnsupported ? (
                                <Item
                                    testID="new-session.mcp.detected-unsupported"
                                    title={t('newSession.mcpDetectedUnsupportedTitle')}
                                    subtitle={t('newSession.mcpDetectedUnsupportedSubtitle')}
                                    showChevron={false}
                                />
                            ) : props.error ? (
                                <Item
                                    testID="new-session.mcp.detected-error"
                                    title={t('common.error')}
                                    subtitle={props.error}
                                    showChevron={false}
                                />
                            ) : preview ? (
                                preview.detected.length > 0 ? (
                                    preview.detected.map((entry) => (
                                        <Item
                                            key={entry.key}
                                            testID={`new-session.mcp.detected.${entry.name}`}
                                            title={entry.title || entry.name}
                                            subtitle={[
                                                resolvePreviewScopeLabel(entry.scopeKind),
                                                resolveAuthBadgeLabel(entry.authMode),
                                            ].filter(Boolean).join(' · ')}
                                            selected={false}
                                            detail={resolveDetectedAvailabilityLabel(entry)}
                                            showChevron={false}
                                        />
                                    ))
                                ) : (
                                    <Item
                                        testID="new-session.mcp.detected-empty"
                                        title={t('newSession.mcpDetectedEmptyTitle')}
                                        subtitle={t('newSession.mcpDetectedEmptySubtitle')}
                                        showChevron={false}
                                    />
                                )
                            ) : (
                                <Item
                                    testID="new-session.mcp.detected-empty"
                                    title={t('newSession.mcpDetectedEmptyTitle')}
                                    subtitle={t('newSession.mcpDetectedEmptySubtitle')}
                                    showChevron={false}
                                />
                            )}
                        </ItemGroup>
                    ) : null}
                </ItemListStatic>
            </ScrollView>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        backgroundColor: theme.colors.groupped.background,
        flexShrink: 1,
    },
    groupTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
    },
    groupTitleTextWrap: {
        flex: 1,
        minWidth: 0,
    },
    groupTitleText: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.groupped.sectionTitle,
        textTransform: 'uppercase',
    },
    groupActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginLeft: 12,
        flexShrink: 0,
    },
    groupActionButton: {
        width: 30,
        height: 30,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    groupActionButtonPressed: {
        opacity: 0.82,
    },
    scroll: {
        width: '100%',
    },
    scrollContent: {
        paddingBottom: 16,
    },
    list: {
        backgroundColor: 'transparent',
    },
    emptyActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
}));
