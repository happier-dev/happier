import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HomeMark } from '@/components/homes/HomeMark';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { parseServerSettingsRouteParams } from '@/components/settings/server/navigation/serverSettingsRouteParams';
import { ServerGroupsSection } from '@/components/settings/server/sections/ServerGroupsSection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useHappyAction } from '@/hooks/ui/useHappyAction';

import { useHomesCollection } from './HomesCollection';
import { HOMES_COLLECTION_ROOT } from './homeCollectionModel';
import { homeGroupDraftTitle } from './homeGroupDraftTitle';

/**
 * A group of Homes in Settings → Homes: which Homes it gathers and how their sessions are listed
 * (`groupId`), or a new group being made (`null`, the collection's draft; `?groupServerIds=` seeds it).
 */
export const HomeGroupPage = React.memo(function HomeGroupPage(props: Readonly<{ groupId: string | null }>) {
    if (props.groupId === null) return <NewHomeGroupPage />;
    return <ExistingHomeGroupPage key={props.groupId} groupId={props.groupId} />;
});

const ExistingHomeGroupPage = React.memo(function ExistingHomeGroupPage(props: Readonly<{ groupId: string }>) {
    const router = useRouter();
    const { controller, collection } = useHomesCollection();
    const row = collection.groups.find((group) => group.id === props.groupId) ?? null;
    const group = row?.group ?? null;
    const [nameDraft, setNameDraft] = React.useState<string | null>(null);
    const [savingName, saveName] = useHappyAction(async () => {
        if (!group || nameDraft === null || !nameDraft.trim()) return;
        await controller.onRenameGroup(group, nameDraft);
        setNameDraft(null);
    });
    const { onEditGroupMembers } = controller;
    // Membership editing follows the page's group, so it is edited without switching to it.
    React.useEffect(() => {
        if (group) onEditGroupMembers(group);
    }, [group, onEditGroupMembers]);

    if (!row || !group) {
        return (
            <ItemList>
                <EmptyState
                    testID="settings.homes.group.missing"
                    iconName="stack"
                    title={t('addFlows.groupMissingTitle')}
                    subtitle={t('addFlows.groupMissingDescription')}
                    primaryAction={{ label: t('settings.servers'), onPress: () => router.replace(HOMES_COLLECTION_ROOT as never) }}
                />
            </ItemList>
        );
    }

    const menuActions: PageHeaderMenuAction[] = [
        { id: 'rename', testID: 'settings.homes.group.menu.rename', title: t('common.rename'), disabled: savingName, onSelect: () => setNameDraft(group.name) },
        {
            id: 'remove',
            testID: 'settings.homes.group.menu.remove',
            title: t('common.remove'),
            destructive: true,
            onSelect: async () => {
                await controller.onRemoveGroup(group);
                router.replace(HOMES_COLLECTION_ROOT as never);
            },
        },
    ];

    return (
        <ItemList>
            <PageHeader
                testID="settings.homes.group.header"
                alwaysShowTitle
                title={row.title}
                description={t('server.serverCount', { count: row.count })}
                meta={row.current ? [{ key: 'current', text: t('addFlows.homesInUse') }] : undefined}
                leading={<HomeMark glyph="stack" size="page" />}
                actions={(
                    <View style={styles.headerActions}>
                        {row.current ? null : (
                            <RoundButton
                                testID="settings.homes.group.switch"
                                size="small"
                                display="secondary"
                                title={t('server.homes.switch')}
                                onPress={() => void controller.onSwitchGroup(group)}
                            />
                        )}
                        <PageHeaderMenu testID="settings.homes.group.menu" actions={menuActions} />
                    </View>
                )}
            />
            {nameDraft !== null ? (
                <ItemGroup>
                    <View style={styles.fields}>
                        <FieldItem label={t('server.serverGroupNameLabel')} labelNativeID="settings-homes-group-rename-label" style={styles.field}>
                            <FieldTextInput testID="settings.homes.group.name" value={nameDraft} onChangeText={setNameDraft} editable={!savingName} accessibilityLabel={t('server.serverGroupNameLabel')} accessibilityLabelledBy="settings-homes-group-rename-label" onSubmitEditing={saveName} />
                        </FieldItem>
                        <View style={styles.headerActions}>
                            <RoundButton testID="settings.homes.group.name.cancel" size="small" display="secondary" title={t('common.cancel')} disabled={savingName} onPress={() => setNameDraft(null)} />
                            <RoundButton testID="settings.homes.group.name.save" size="small" title={t('common.save')} disabled={savingName || !nameDraft.trim()} loading={savingName} onPress={saveName} />
                        </View>
                    </View>
                </ItemGroup>
            ) : null}
            <ServerGroupsSection
                groupSelectionPresentation={controller.groupSelectionPresentation}
                groupId={controller.editedServerGroupId === group.id ? group.id : null}
                selectedGroupServerIds={controller.selectedGroupServerIds}
                servers={controller.servers}
                onToggleGroupPresentation={controller.onToggleGroupPresentation}
                onToggleGroupServer={controller.onToggleGroupServer}
            />
        </ItemList>
    );
});

const NewHomeGroupPage = React.memo(function NewHomeGroupPage() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const params = useLocalSearchParams<{ groupServerIds?: string | string[] }>();
    const { controller } = useHomesCollection();
    const [name, setName] = React.useState('');
    const [memberIds, setMemberIds] = React.useState<readonly string[]>(() => {
        // A link that names the Homes (even none) is taken as asked; only a bare draft starts from the Home in use.
        if (params.groupServerIds !== undefined) {
            return parseServerSettingsRouteParams({ groupServerIds: params.groupServerIds }).initialGroupServerIds;
        }
        return controller.activeServerId ? [controller.activeServerId] : [];
    });
    const [saving, setSaving] = React.useState(false);

    React.useEffect(() => {
        homeGroupDraftTitle.publish(name.trim());
    }, [name]);
    React.useEffect(() => () => homeGroupDraftTitle.publish(''), []);

    const leave = React.useCallback(() => {
        const result = runGuardedNavigation(() => router.replace(HOMES_COLLECTION_ROOT as never));
        if (result !== true) fireAndForget(result, { tag: 'NewHomeGroupPage.leave' });
    }, [router]);
    const toggle = React.useCallback((id: string) => {
        setMemberIds((current) => (current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id]));
    }, []);
    const save = React.useCallback(async () => {
        const trimmed = name.trim();
        if (saving || !trimmed || memberIds.length === 0) return;
        setSaving(true);
        try {
            if (await controller.onCreateServerGroup({ name: trimmed, serverIds: [...memberIds] })) leave();
        } finally {
            setSaving(false);
        }
    }, [controller, leave, memberIds, name, saving]);

    const canSave = !saving && name.trim().length > 0 && memberIds.length > 0;
    return (
        <ItemList keyboardShouldPersistTaps="handled">
            <PageHeader
                testID="settings.homes.groupDraft.header"
                alwaysShowTitle={name.trim().length > 0}
                title={name.trim() || t('addFlows.newGroup')}
                description={t('server.addServerGroupSubtitle')}
                leading={<HomeMark glyph="stack" size="page" />}
                cancelAction={{ testID: 'settings.homes.groupDraft.discard', title: t('addFlows.discard'), onPress: leave }}
                primaryAction={{
                    testID: 'settings.homes.groupDraft.save',
                    title: saving ? t('common.loading') : t('server.saveServerGroup'),
                    disabled: !canSave,
                    onPress: save,
                }}
            />
            <ItemGroup>
                <View style={styles.fields}>
                    <FieldItem label={t('server.serverGroupNameLabel')} labelNativeID="settings-homes-group-name-label" style={styles.field}>
                        <FieldTextInput
                            testID="settings.homes.groupDraft.name"
                            value={name}
                            onChangeText={setName}
                            placeholder={t('server.serverGroupNamePlaceholder')}
                            editable={!saving}
                            accessibilityLabel={t('server.serverGroupNameLabel')}
                            accessibilityLabelledBy="settings-homes-group-name-label"
                        />
                    </FieldItem>
                </View>
            </ItemGroup>
            <ItemGroup title={t('server.serverGroupServersLabel')}>
                {controller.servers.map((profile) => {
                    const id = resolveServerProfileScopeId(profile);
                    const selected = memberIds.includes(id);
                    return (
                        <Item
                            key={profile.id}
                            testID={`settings.homes.groupDraft.member.${profile.id}`}
                            title={resolveHomeDisplayLabel(profile, profile.id)}
                            subtitle={toServerUrlDisplay(profile.serverUrl)}
                            rightElement={(
                                <Icon
                                    name={selected ? 'check-circle' : 'circle'}
                                    size={20}
                                    color={selected ? theme.colors.status.connected : theme.colors.text.secondary}
                                />
                            )}
                            accessibilityRole="checkbox"
                            webRole="checkbox"
                            selected={selected}
                            showChevron={false}
                            onPress={() => toggle(id)}
                        />
                    );
                })}
            </ItemGroup>
        </ItemList>
    );
});

const styles = StyleSheet.create({
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    fields: {
        paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        paddingVertical: 12,
    },
    field: {
        maxWidth: 480,
    },
});
