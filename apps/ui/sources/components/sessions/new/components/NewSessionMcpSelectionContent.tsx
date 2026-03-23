import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
    DaemonMcpServersPreviewResponse,
    ManagedMcpPreviewEntryV1,
    McpServerCatalogEntryV1,
    SessionMcpSelectionV1,
} from '@happier-dev/protocol';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import {
    resolveAuthBadgeLabel,
    resolveDetectedAvailabilityLabel,
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
    machineName?: string | null;
    directory: string;
    agentType: AgentId;
    hasContext: boolean;
    preview: PreviewSuccess | null;
    selection: SessionMcpSelectionV1;
    loading: boolean;
    error: string | null;
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

function describeManagedReason(entry: ManagedMcpPreviewEntryV1): string {
    switch (entry.reasonCode) {
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
        default:
            return t('newSession.mcpReasonNotPortable');
    }
}

function describeManagedSubtitle(entry: ManagedMcpPreviewEntryV1): string {
    return [
        resolvePreviewScopeLabel(entry.scopeKind),
        resolveAuthBadgeLabel(entry.authMode),
        describeManagedReason(entry),
    ].filter(Boolean).join(' · ');
}

function groupManagedEntries(entries: ReadonlyArray<ManagedMcpPreviewEntryV1>): Readonly<{
    selected: ManagedMcpPreviewEntryV1[];
    available: ManagedMcpPreviewEntryV1[];
    unavailable: ManagedMcpPreviewEntryV1[];
}> {
    const selected: ManagedMcpPreviewEntryV1[] = [];
    const available: ManagedMcpPreviewEntryV1[] = [];
    const unavailable: ManagedMcpPreviewEntryV1[] = [];

    for (const entry of entries) {
        if (entry.selected) {
            selected.push(entry);
        } else if (entry.availability === 'available') {
            available.push(entry);
        } else {
            unavailable.push(entry);
        }
    }

    return { selected, available, unavailable };
}

export function NewSessionMcpSelectionContent(props: NewSessionMcpSelectionContentProps) {
    const styles = stylesheet;
    const managedGroups = React.useMemo(() => groupManagedEntries(props.preview?.managed ?? []), [props.preview?.managed]);
    const hasManagedEntries = (props.preview?.managed.length ?? 0) > 0;
    const showNoContextState = !props.preview && !props.error && !props.loading && !props.hasContext;
    const showPreviewEmptyState =
        (!props.preview && !props.error && !props.loading && props.hasContext)
        || (
            props.preview !== null
            && props.preview.managed.length === 0
            && props.preview.detected.length === 0
        );

    const mcpServersSettingsRaw = useSetting('mcpServersSettingsV1');
    const mcpServersSettings = React.useMemo(
        () => normalizeMcpServersSettingsV1(mcpServersSettingsRaw),
        [mcpServersSettingsRaw],
    );

    const happierServerCount = mcpServersSettings.servers.length;
    const showCombinedEmptyState = happierServerCount === 0 && showPreviewEmptyState;

    const happierServers = React.useMemo((): readonly McpServerCatalogEntryV1[] => {
        return mcpServersSettings.servers
            .slice()
            .sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name));
    }, [mcpServersSettings.servers]);

    const agentDisplayName = t(getAgentCore(props.agentType).displayNameKey);
    const detectedSectionTitle = t('newSession.mcpDetectedSectionTitleForAgent', { agentName: agentDisplayName });

    const handleToggleManagedEnabled = React.useCallback((value: boolean) => {
        props.onSelectionChange(setManagedSessionMcpServersEnabled(props.selection, value));
    }, [props]);

    const renderManagedItem = React.useCallback((entry: ManagedMcpPreviewEntryV1) => (
        <Item
            key={entry.key}
            testID={`new-session.mcp.row.${entry.serverId}`}
            title={entry.title || entry.name}
            subtitle={describeManagedSubtitle(entry)}
            detail={entry.selected
                ? t('settings.mcpServersStatusActive')
                : entry.availability === 'available'
                    ? t('settings.mcpServersStatusAvailable')
                    : t('settings.mcpServersStatusUnavailable')}
            selected={entry.selected}
            disabled={!entry.selectable}
            showChevron={false}
            onPress={entry.selectable
                ? () => props.onSelectionChange(toggleManagedSessionMcpSelection(props.selection, entry))
                : undefined}
            rightElement={entry.selectable ? (
                <Switch
                    value={entry.selected}
                    onValueChange={() => props.onSelectionChange(toggleManagedSessionMcpSelection(props.selection, entry))}
                />
            ) : null}
        />
    ), [props]);

    const managedByServerId = React.useMemo(() => {
        const map = new Map<string, ManagedMcpPreviewEntryV1>();
        for (const entry of props.preview?.managed ?? []) {
            map.set(entry.serverId, entry);
        }
        return map;
    }, [props.preview?.managed]);

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
                                actions={!showCombinedEmptyState ? (
                                    <GroupActionButton
                                        testID="new-session.mcp.happier-open-settings"
                                        icon="settings-outline"
                                        onPress={props.onOpenSettings}
                                    />
                                ) : undefined}
                            />
                        )}
                    >
                        {happierServerCount === 0 ? (
                            <Item
                                testID="new-session.mcp.happier-empty"
                                title={t('newSession.mcpHappierEmptyTitle')}
                                subtitle={t('newSession.mcpHappierEmptySubtitle')}
                                showChevron={false}
                                rightElement={showCombinedEmptyState ? (
                                    <View style={styles.emptyActions}>
                                        <GroupActionButton
                                            testID="new-session.mcp.refresh"
                                            icon="refresh-outline"
                                            loading={props.loading}
                                            onPress={props.onRefresh}
                                        />
                                        <GroupActionButton
                                            testID="new-session.mcp.happier-open-settings"
                                            icon="settings-outline"
                                            onPress={props.onOpenSettings}
                                        />
                                    </View>
                                ) : null}
                            />
                        ) : (
                            <>
                                {hasManagedEntries ? (
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

                                {happierServers.map((server) => {
                                    const managedEntry = managedByServerId.get(server.id) ?? null;
                                    if (managedEntry) return renderManagedItem(managedEntry);

                                    // When preview isn't available (or a server isn't relevant for this context),
                                    // still show it so users understand what exists in Happier settings.
                                    return (
                                        <Item
                                            key={server.id}
                                            testID={`new-session.mcp.happier.server.${server.id}`}
                                            title={server.title ?? server.name}
                                            subtitle={server.title ? server.name : undefined}
                                            showChevron={false}
                                        />
                                    );
                                })}
                            </>
                        )}
                    </ItemGroup>

                    {props.error ? (
                        <ItemGroup title={t('common.error')}>
                            <Item
                                testID="new-session.mcp.error"
                                title={t('common.error')}
                                subtitle={props.error}
                                showChevron={false}
                            />
                        </ItemGroup>
                    ) : null}

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

                    {showPreviewEmptyState && !showCombinedEmptyState && happierServerCount > 0 ? (
                        <ItemGroup>
                            <Item
                                testID="new-session.mcp.empty"
                                title={t('settings.mcpServersEmptyTitle')}
                                subtitle={t('settings.mcpServersEmptySubtitle')}
                                showChevron={false}
                                rightElement={(
                                    <View style={styles.emptyActions}>
                                        <GroupActionButton
                                            testID="new-session.mcp.refresh"
                                            icon="refresh-outline"
                                            loading={props.loading}
                                            onPress={props.onRefresh}
                                        />
                                        <GroupActionButton
                                            testID="new-session.mcp.empty-open-settings"
                                            icon="settings-outline"
                                            onPress={props.onOpenSettings}
                                        />
                                    </View>
                                )}
                            />
                        </ItemGroup>
                    ) : null}

                    {props.preview ? (
                        <>
                            {managedGroups.selected.length > 0 ? (
                                <ItemGroup title={t('newSession.mcpSelectedSectionTitle')}>
                                    {managedGroups.selected.map(renderManagedItem)}
                                </ItemGroup>
                            ) : null}

                            {managedGroups.available.length > 0 ? (
                                <ItemGroup title={t('newSession.mcpAvailableSectionTitle')}>
                                    {managedGroups.available.map(renderManagedItem)}
                                </ItemGroup>
                            ) : null}

                            {managedGroups.unavailable.length > 0 ? (
                                <ItemGroup title={t('newSession.mcpUnavailableSectionTitle')}>
                                    {managedGroups.unavailable.map(renderManagedItem)}
                                </ItemGroup>
                            ) : null}

                            {props.preview.detected.length > 0 ? (
                                <ItemGroup
                                    title={(
                                        <GroupTitleRow
                                            title={detectedSectionTitle}
                                            actions={(
                                                <GroupActionButton
                                                    testID="new-session.mcp.refresh"
                                                    icon="refresh-outline"
                                                    loading={props.loading}
                                                    onPress={props.onRefresh}
                                                />
                                            )}
                                        />
                                    )}
                                >
                                    {props.preview.detected.map((entry) => (
                                        <Item
                                            key={entry.key}
                                            testID={`new-session.mcp.detected.${entry.name}`}
                                            title={entry.title || entry.name}
                                            subtitle={[
                                                resolvePreviewScopeLabel(entry.scopeKind),
                                                resolveAuthBadgeLabel(entry.authMode),
                                            ].filter(Boolean).join(' · ')}
                                            selected={entry.selected}
                                            detail={resolveDetectedAvailabilityLabel(entry)}
                                            showChevron={false}
                                        />
                                    ))}
                                </ItemGroup>
                            ) : null}
                        </>
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
