import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { RelayAccessControlSection } from '@/components/settings/server/relayAccess/RelayAccessControlSection';
import { t } from '@/text';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';
import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';

import { RemoteHostEditorSections, useRemoteHostEditor } from '../RemoteHostForm';
import { getRemoteHostLocalOverrides, useRemoteHostsCollection } from './remoteHostsCollectionController';
import { publishRemoteHostDraftTitle } from './remoteHostDraftTitle';
import { RemoteHostInterruptedSetups, RemoteHostTunnelRows } from './RemoteHostsCollection';
import { REMOTE_HOSTS_ROOT, remoteHostHref } from './remoteHostsRoutes';

/** What a host can be used for from this device; the rest of its operations maintain Happier there. */
const USE_ACTION_IDS = new Set(['setupAsMachine', 'connectFromThisDevice', 'useAsRelayHost', 'configureAccess']);
const DESTRUCTIVE_ACTION_IDS = new Set(['personalHome.erase']);

/**
 * A remote host in the collection: one page for a new host (the draft, `hostId` null) and a saved one.
 * A saved host's page leads with what this device can do with it, then keeps Happier there up to date,
 * then edits how to reach it. Save is the page's primary action; `⋯` removes the host or discards the
 * draft. Leaving with unsaved changes asks first.
 */
export const RemoteHostPage = React.memo(function RemoteHostPage(props: Readonly<{ hostId: string | null }>) {
    const collection = useRemoteHostsCollection();
    const host = props.hostId ? collection.hosts.find((entry) => entry.id === props.hostId) ?? null : null;
    if (props.hostId && !host && !collection.catalogComplete) return null;
    if (props.hostId && !host) {
        return (
            <ItemList>
                <PageHeader
                    testID="settings.remoteHosts.host.header"
                    alwaysShowTitle
                    title={t('settings.remoteHostsTitle')}
                    description={t('settingsRemoteHostsPage.hostNotFound')}
                />
            </ItemList>
        );
    }
    // One editor per host: a different host (or the draft) starts from its own saved values.
    return <RemoteHostEditorPage key={JSON.stringify([collection.scope?.serverId, collection.scope?.accountId, host?.id ?? 'new'])} host={host} />;
});

const RemoteHostEditorPage = React.memo(function RemoteHostEditorPage(props: Readonly<{ host: RemoteHost | null }>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const collection = useRemoteHostsCollection();
    const host = props.host;
    const params = useLocalSearchParams<{ remoteHostIntent?: string; expectedRevision?: string }>();
    const isNew = host === null;
    const localOverrides = React.useMemo(() => (host ? getRemoteHostLocalOverrides(host.id) : null), [host]);
    const editor = useRemoteHostEditor({
        remoteHost: host,
        localOverrides,
        secretMaterialAllowed: collection.secretMaterialAllowed,
    });

    // The collection's draft row shows the name as it is typed.
    React.useEffect(() => {
        if (isNew) publishRemoteHostDraftTitle(editor.state.name);
    }, [editor.state.name, isNew]);
    React.useEffect(() => (isNew ? () => publishRemoteHostDraftTitle('') : undefined), [isNew]);

    // Navigation waits for the render that marks the draft clean, so the guard lets it through.
    const [pendingHref, setPendingHref] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (pendingHref === null) return;
        setPendingHref(null);
        router.replace(pendingHref as never);
    }, [pendingHref, router]);

    const [saving, setSaving] = React.useState(false);
    const save = React.useCallback(async (): Promise<boolean> => {
        if (saving) return false;
        const payload = editor.buildSavePayload();
        if (!payload) return false;
        setSaving(true);
        try {
            const receipt = await collection.saveHost({ ...payload, accountDirty: editor.accountDirty });
            if (!receipt.ok || receipt.localOverrides === 'retired') return false;
            const localOverridesSaved = receipt.localOverrides === 'saved';
            editor.markSaved({ localOverridesSaved, remoteHost: receipt.host });
            if (isNew && localOverridesSaved) setPendingHref(remoteHostHref(payload.remoteHost.id));
            return localOverridesSaved;
        } finally { setSaving(false); }
    }, [collection, editor, isNew, saving]);
    const leave = React.useCallback(() => setPendingHref(REMOTE_HOSTS_ROOT), []);
    useUnsavedDraftNavigationGuard({
        navigation,
        isDirty: editor.dirty,
        onDiscard: editor.discard,
        onSave: save,
        onLeave: leave,
        tag: 'RemoteHostPage.leave',
    });

    const remove = React.useCallback(async () => {
        if (!host) return;
        if (!await collection.deleteHost(host.id)) return;
        editor.discard();
        leave();
    }, [collection, editor, host, leave]);
    const discardDraft = React.useCallback(() => {
        editor.discard();
        leave();
    }, [editor, leave]);
    const menuActions = React.useMemo((): readonly PageHeaderMenuAction[] => (isNew
        ? [{ id: 'discard', title: t('settingsRemoteHostsPage.discard'), onSelect: discardDraft }]
        : [{ id: 'remove', title: t('common.remove'), destructive: true, onSelect: remove }]), [discardDraft, isNew, remove]);

    const actions = React.useMemo(() => (host ? collection.buildHostActions(host) : []), [collection, host]);
    const useActions = actions.filter((action) => USE_ACTION_IDS.has(action.id));
    const maintenanceActions = actions.filter((action) => !USE_ACTION_IDS.has(action.id) && !DESTRUCTIVE_ACTION_IDS.has(action.id));
    const eraseAction = actions.find((action) => action.id === 'personalHome.erase');
    const relayAccessSelection = collection.remoteHostOutcomeActions.relayAccessSelection;
    React.useEffect(() => {
        if (host && params.remoteHostIntent === 'relay' && collection.catalogComplete
            && String(collection.catalogRevision ?? '') === params.expectedRevision) {
            collection.remoteHostOutcomeActions.selectRelayAccess(host);
        }
    }, [host, params.remoteHostIntent, params.expectedRevision, collection.catalogComplete, collection.catalogRevision, collection.remoteHostOutcomeActions.selectRelayAccess]);
    const hostTunnels = host ? collection.activeRemoteHostSshTunnels.filter((tunnel) => tunnel.remoteHostId === host.id) : [];

    return (
        <ItemList keyboardShouldPersistTaps="handled">
            <PageHeader
                testID="settings.remoteHosts.host.header"
                alwaysShowTitle
                title={editor.state.name.trim() || host?.name || t('settingsRemoteHostsPage.newHostTitle')}
                description={t(isNew ? 'settingsRemoteHostsPage.newHostDescription' : 'settingsRemoteHostsPage.hostPageDescription')}
                meta={host ? [{ key: 'target', text: host.ssh.target }] : undefined}
                leading={(
                    <PageHeaderMarkSlot>
                        <Icon name="desktop" size={22} color={theme.colors.text.secondary} />
                    </PageHeaderMarkSlot>
                )}
                primaryAction={{
                    testID: 'settings.remoteHosts.host.save',
                    title: t('common.save'),
                    disabled: saving || !collection.canMutate || !editor.valid || (!editor.dirty && !isNew),
                    onPress: () => { void save(); },
                }}
                actions={(
                    <View style={styles.headerActions}>
                        <PageHeaderMenu testID="settings.remoteHosts.host.menu" actions={menuActions} />
                    </View>
                )}
            />

            {useActions.length > 0 ? (
                <ItemGroup
                    title={t('settingsRemoteHostsPage.useSection')}
                    description={t('settingsRemoteHostsPage.useSectionDescription')}
                >
                    <HostActionButtons actions={useActions} />
                </ItemGroup>
            ) : null}

            {host && relayAccessSelection?.host.id === host.id ? (
                <>
                    <ItemGroup title={t('settings.remoteHostsRelayAccessGroupTitle')}>
                        <Item
                            testID={`settings.remoteHosts.relayAccess.${host.id}`}
                            title={t('settings.remoteHostsRelayAccessActiveTitle', { host: host.name })}
                            subtitle={t('settings.remoteHostsRelayAccessActiveSubtitle')}
                            subtitleLines={0}
                            mode="info"
                            showChevron={false}
                        />
                    </ItemGroup>
                    <RelayAccessControlSection
                        remoteHost={{ scope: relayAccessSelection.scope, hostId: relayAccessSelection.host.id,
                            expectedRevision: relayAccessSelection.revision }}
                        target={relayAccessSelection.target}
                        upstreamUrl={relayAccessSelection.upstreamUrl}
                        runWithTarget={collection.remoteHostOutcomeActions.runRelayAccessTask}
                        runner={collection.runner}
                        accessChannels={collection.accessChannels}
                        accessEndpointRemediationActions={collection.accessEndpointProjection.remediationActions}
                        onAccessEndpointRemediationActionPress={collection.handleAccessEndpointRemediationActionPress}
                    />
                </>
            ) : null}

            {host && hostTunnels.length > 0 ? (
                <ItemGroup
                    title={t('settings.remoteHostsSshTunnelGroupTitle')}
                    description={t('settingsRemoteHostsPage.sshTunnelsDescription')}
                >
                    {hostTunnels.map((tunnel) => (
                        <RemoteHostTunnelRows
                            key={tunnel.tunnelKey}
                            testIdSuffix={host.id}
                            label={host.name}
                            url={tunnel.httpBaseUrl}
                            onStop={() => { void collection.sshTunnelControl.stopTunnel(tunnel.tunnelKey); }}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {host ? <RemoteHostInterruptedSetups hostId={host.id} /> : null}

            {maintenanceActions.length > 0 ? (
                <ItemGroup
                    title={t('settingsRemoteHostsPage.maintenanceSection')}
                    description={t('settingsRemoteHostsPage.maintenanceSectionDescription')}
                >
                    <HostActionButtons actions={maintenanceActions} />
                </ItemGroup>
            ) : null}

            <RemoteHostEditorSections
                editor={editor}
                remoteHost={host}
                savedRemoteHosts={collection.remoteHosts}
                systemTaskRunner={collection.runner}
                secretMaterialAllowed={collection.secretMaterialAllowed}
            />

            {eraseAction ? (
                <ItemGroup surface="none">
                    <SectionContentRow>
                        <View style={styles.buttonRow}>
                            <RoundButton
                                testID={`settings.remoteHosts.hostAction.${eraseAction.id}`}
                                size="small"
                                display="destructive"
                                title={eraseAction.title}
                                accessibilityHint={eraseAction.subtitle}
                                onPress={() => eraseAction.onPress?.()}
                            />
                        </View>
                    </SectionContentRow>
                    {eraseAction.subtitle ? (
                        <Item title={eraseAction.subtitle} titleLines={0} mode="info" showChevron={false} />
                    ) : null}
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});

/** A host's operations as one wrapping row of buttons; each says what it does. */
const HostActionButtons = React.memo(function HostActionButtons(props: Readonly<{
    actions: readonly ItemAction[];
}>) {
    return (
        <SectionContentRow>
            <View style={styles.buttonRow}>
                {props.actions.map((action) => (
                    <RoundButton
                        key={action.id}
                        testID={`settings.remoteHosts.hostAction.${action.id}`}
                        size="small"
                        display="secondary"
                        title={action.title}
                        accessibilityHint={action.subtitle}
                        disabled={action.disabled}
                        onPress={() => action.onPress?.()}
                    />
                ))}
            </View>
        </SectionContentRow>
    );
});

const styles = StyleSheet.create(() => ({
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    buttonRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
}));
