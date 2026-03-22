import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
    DaemonMcpServersPreviewResponse,
    ManagedMcpPreviewEntryV1,
    SessionMcpSelectionV1,
} from '@happier-dev/protocol';

import { type AgentId } from '@/agents/catalog/catalog';
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
    onPress: () => void;
}>;

function GroupActionButton(props: GroupActionButtonProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <Pressable
            testID={props.testID}
            onPress={props.onPress}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={({ pressed }) => [
                styles.groupActionButton,
                pressed ? styles.groupActionButtonPressed : null,
            ]}
        >
            {normalizeNodeForView(
                <Ionicons name={props.icon} size={18} color={theme.colors.textSecondary} />,
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

    return (
        <View style={[styles.container, { maxHeight: props.maxHeight }]}>
            <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator
                keyboardShouldPersistTaps="handled"
            >
                <ItemListStatic style={styles.list}>
                    {hasManagedEntries ? (
                        <ItemGroup
                            title={(
                                <GroupTitleRow
                                    title={t('newSession.mcpManagedToggleTitle')}
                                    actions={(
                                        <GroupActionButton
                                            testID="new-session.mcp.open-settings"
                                            icon="settings-outline"
                                            onPress={props.onOpenSettings}
                                        />
                                    )}
                                />
                            )}
                            footer={t('newSession.mcpManagedToggleSubtitle')}
                        >
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
                        </ItemGroup>
                    ) : null}

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

                    {props.loading ? (
                        <ItemGroup title={t('common.loading')}>
                            <Item
                                testID="new-session.mcp.loading"
                                title={t('common.loading')}
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

                    {showPreviewEmptyState ? (
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
                                            title={t('newSession.mcpDetectedSectionTitle')}
                                            actions={(
                                                <GroupActionButton
                                                    testID="new-session.mcp.refresh"
                                                    icon="refresh-outline"
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
                                                resolveDetectedAvailabilityLabel(entry),
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
        marginHorizontal: 18,
        minHeight: 28,
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
