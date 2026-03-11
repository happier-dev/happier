import React from 'react';
import { Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
    DaemonMcpServersPreviewResponse,
    ManagedMcpPreviewEntryV1,
    SessionMcpSelectionV1,
} from '@happier-dev/protocol';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { resolveAuthBadgeLabel, resolveDetectedAvailabilityLabel, resolvePreviewScopeLabel } from '@/components/settings/mcpServers/mcpServerUi';
import { resolveAgentToolsDeliveryDescription, resolveAgentToolsDeliveryLabel } from '@/components/settings/mcpServers/mcpServerUi';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemListStatic } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal';
import {
    setManagedSessionMcpServersEnabled,
    toggleManagedSessionMcpSelection,
} from '@/components/sessions/new/modules/sessionMcpSelectionState';
import { t } from '@/text';

type PreviewSuccess = Extract<DaemonMcpServersPreviewResponse, { ok: true }>;

export type NewSessionMcpSelectionModalProps = Readonly<CustomModalInjectedProps & {
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
}>;

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

export function NewSessionMcpSelectionModal(props: NewSessionMcpSelectionModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { height: windowHeight } = useWindowDimensions();
    const maxHeight = Math.min(760, Math.max(420, Math.floor(windowHeight * 0.88)));
    const agentTools = React.useMemo(() => getAgentCore(props.agentType).tools, [props.agentType]);
    const managedGroups = React.useMemo(() => groupManagedEntries(props.preview?.managed ?? []), [props.preview?.managed]);
    const showNoContextState = !props.preview && !props.error && !props.loading && !props.hasContext;
    const showPreviewEmptyState = !props.preview && !props.error && !props.loading && props.hasContext;

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
        <View style={[styles.container, { maxHeight, height: maxHeight }]}>
            <View style={styles.header}>
                <View style={styles.headerTextBlock}>
                    <Text style={styles.headerTitle}>{t('newSession.mcpModalTitle')}</Text>
                    <Text style={styles.headerSubtitle}>
                        {t('newSession.mcpModalSubtitle', {
                            machineName: props.machineName || '—',
                            directory: props.directory || '—',
                        })}
                    </Text>
                </View>
                <Pressable
                    onPress={props.onClose}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                >
                    {normalizeNodeForView(<Ionicons name="close" size={20} color={theme.colors.textSecondary} />)}
                </Pressable>
            </View>

            <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator
                keyboardShouldPersistTaps="handled"
            >
                <ItemListStatic style={styles.list}>
                    <ItemGroup title={t('settings.mcpServersPreviewDeliveryTitle')}>
                        <Item
                            testID="new-session.mcp.delivery"
                            title={t('settings.mcpServersPreviewDeliveryTitle')}
                            subtitle={resolveAgentToolsDeliveryDescription(agentTools.delivery)}
                            detail={resolveAgentToolsDeliveryLabel(agentTools.delivery)}
                            showChevron={false}
                        />
                    </ItemGroup>

                    <ItemGroup title={t('newSession.mcpManagedToggleTitle')} footer={t('newSession.mcpManagedToggleSubtitle')}>
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

                    <ItemGroup title={t('settings.mcpServersPreviewRefreshTitle')}>
                        <Item
                            testID="new-session.mcp.refresh"
                            title={t('settings.mcpServersPreviewRefreshTitle')}
                            subtitle={props.loading ? t('common.loading') : t('settings.mcpServersPreviewRefreshSubtitle')}
                            showChevron={false}
                            onPress={props.onRefresh}
                        />
                        <Item
                            testID="new-session.mcp.open-settings"
                            title={t('newSession.mcpOpenSettingsTitle')}
                            subtitle={t('newSession.mcpOpenSettingsSubtitle')}
                            onPress={() => {
                                props.onClose();
                                props.onOpenSettings();
                            }}
                        />
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

                    {showPreviewEmptyState ? (
                        <ItemGroup title={t('settings.mcpServersPreviewEmptyTitle')}>
                            <Item
                                testID="new-session.mcp.empty"
                                title={t('settings.mcpServersPreviewEmptyTitle')}
                                subtitle={t('settings.mcpServersPreviewEmptySubtitle')}
                                showChevron={false}
                            />
                        </ItemGroup>
                    ) : null}

                    {props.preview ? (
                        <>
                            {props.preview.builtIn.length > 0 ? (
                                <ItemGroup title={t('settings.mcpServersSourceBuiltIn')}>
                                    {props.preview.builtIn.map((entry) => (
                                        <Item
                                            key={entry.key}
                                            testID={`new-session.mcp.built-in.${entry.name}`}
                                            title={entry.title || entry.name}
                                            subtitle={t('settings.mcpServersBuiltInDescription')}
                                            detail={t('settings.mcpServersStatusActive')}
                                            selected
                                            showChevron={false}
                                        />
                                    ))}
                                </ItemGroup>
                            ) : null}

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
                                <ItemGroup title={t('newSession.mcpDetectedSectionTitle')}>
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
                    ) : (
                        null
                    )}
                </ItemListStatic>
            </ScrollView>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '94%',
        maxWidth: 620,
        backgroundColor: theme.colors.groupped.background,
        borderRadius: 18,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        flexShrink: 1,
    },
    header: {
        paddingHorizontal: 18,
        paddingVertical: 14,
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
        gap: 12,
    },
    headerTextBlock: {
        flex: 1,
        gap: 4,
    },
    headerTitle: {
        color: theme.colors.text,
        fontSize: Platform.select({ ios: 18, default: 17 }),
        ...Typography.default('semiBold'),
    },
    headerSubtitle: {
        color: theme.colors.textSecondary,
        fontSize: Platform.select({ ios: 14, default: 13 }),
        ...Typography.default(),
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        paddingBottom: 18,
    },
    list: {
        backgroundColor: 'transparent',
        paddingHorizontal: 16,
        paddingTop: 14,
    },
}));
