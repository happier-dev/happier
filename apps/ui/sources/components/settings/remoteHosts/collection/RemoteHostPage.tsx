import * as React from 'react';
import { View } from 'react-native';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';

import { useAddProjectFromRemoteWorkspace } from '@/components/projects/useAddProjectFromRemoteWorkspace';
import { useAttachableRemoteWorkspaces } from '@/components/settings/machines/managed/useAttachableRemoteWorkspaces';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkIcon } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Modal } from '@/modal';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';
import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';

import { RemoteHostEditorSections, useRemoteHostEditor } from '../RemoteHostForm';
import { getRemoteHostLocalOverrides, useRemoteHostsCollection } from './remoteHostsCollectionController';
import { useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';
import { RemoteHostInterruptedSetups, RemoteHostTunnelRows } from './RemoteHostsCollection';
import { REMOTE_HOSTS_ROOT, remoteHostHref } from './remoteHostsRoutes';

/** What a host can be used for from this device; the rest of its operations maintain Happier there. */
const USE_ACTION_IDS = new Set(['setupAsMachine', 'useFoldersHere', 'connectFromThisDevice', 'configureAccess']);
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
    const router = useRouter();
    const navigation = useNavigation();
    const collection = useRemoteHostsCollection();
    const host = props.host;
    const isNew = host === null;
    const localOverrides = React.useMemo(() => (host ? getRemoteHostLocalOverrides(host.id) : null), [host]);
    const editor = useRemoteHostEditor({
        remoteHost: host,
        localOverrides,
        secretMaterialAllowed: collection.secretMaterialAllowed,
    });

    // The collection's draft row shows the name as it is typed.
    const { publish: publishRemoteHostDraftTitle } = useCollectionDraftTitle();
    React.useEffect(() => {
        if (isNew) publishRemoteHostDraftTitle(editor.state.name);
    }, [editor.state.name, isNew, publishRemoteHostDraftTitle]);
    React.useEffect(() => (isNew ? () => publishRemoteHostDraftTitle('') : undefined), [isNew, publishRemoteHostDraftTitle]);

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

    // Folders here without installing Happier (F6): the host's own Set up as machine is the unsupported-platform way on.
    const [foldersPending, setFoldersPending] = React.useState(false);
    const actions = React.useMemo((): ItemAction[] => {
        if (!host) return [];
        const built = collection.buildHostActions(host);
        if (built.length === 0) return built;
        const folders: ItemAction = { id: 'useFoldersHere', title: t('settingsRemoteHostsPage.useFoldersHere'), icon: 'folder',
            disabled: foldersPending, onPress: () => setFoldersPending(true) };
        const setup = built.findIndex((action) => action.id === 'setupAsMachine');
        return [...built.slice(0, setup + 1), folders, ...built.slice(setup + 1)];
    }, [collection, foldersPending, host]);
    const setupAsMachine = actions.find((action) => action.id === 'setupAsMachine');
    const settleFolders = React.useCallback(() => setFoldersPending(false), []);
    const useActions = actions.filter((action) => USE_ACTION_IDS.has(action.id));
    const maintenanceActions = actions.filter((action) => !USE_ACTION_IDS.has(action.id) && !DESTRUCTIVE_ACTION_IDS.has(action.id));
    const eraseAction = actions.find((action) => action.id === 'personalHome.erase');
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
                    <PageHeaderMarkIcon name="desktop" />
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

            {host && foldersPending && collection.scope ? (
                <RemoteHostFoldersLauncher
                    serverId={collection.scope.serverId}
                    host={host}
                    onSetUpAsMachine={setupAsMachine?.onPress ? () => setupAsMachine.onPress?.() : undefined}
                    onSettled={settleFolders}
                />
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

/**
 * "Use folders here without installing Happier": mounted only while pressed. It resolves the controller and the
 * provisioner that attaches this saved host, then hands the attach to the shared folder chooser and Project open.
 */
function RemoteHostFoldersLauncher(props: Readonly<{
    serverId: string;
    host: RemoteHost;
    onSetUpAsMachine?: () => void;
    onSettled(): void;
}>) {
    const { host, onSetUpAsMachine, onSettled } = props;
    const addProject = useAddProjectFromRemoteWorkspace();
    const [bindingId, setBindingId] = React.useState<string>();
    const state = useAttachableRemoteWorkspaces({ serverId: props.serverId, open: true, bindingId, remoteHostId: host.id });
    const onlyChoice = state.kind === 'choose_account' ? state.accounts[0]?.bindingId : undefined;
    // The host is the workspace; its provisioner is the one choice, never a step for the person.
    if (onlyChoice && onlyChoice !== bindingId) setBindingId(onlyChoice);
    const latest = React.useRef(state);
    latest.current = state;
    const started = React.useRef(false);
    React.useEffect(() => {
        if (started.current) return;
        const refuse = (code: string, message: string | null) => {
            started.current = true;
            Modal.alert(t('common.error'), message || resolveActionExecutionErrorMessage({ code }, t('errors.tryAgain')));
            onSettled();
        };
        if (state.kind === 'failed') return refuse(state.code, state.message);
        if (state.kind === 'choose_account' && state.accounts.length === 0) return refuse('provider_unavailable', null);
        if (state.kind !== 'ready') return;
        started.current = true;
        const account = state.accounts[0]!;
        void addProject({
            name: host.name,
            controllerMachineId: account.controller.machineId,
            onSetUpAsMachine,
            // The chooser's Retry attaches through the listing that is current then.
            attach: (request) => {
                const current = latest.current;
                return current.kind === 'ready'
                    ? current.attach({ ...request, bindingId: account.bindingId, workspaceId: host.id })
                    : Promise.resolve({ kind: 'failed', code: 'target_unavailable', message: null });
            },
        }).finally(onSettled);
    }, [addProject, host.id, host.name, onSetUpAsMachine, onSettled, state]);
    return null;
}

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
