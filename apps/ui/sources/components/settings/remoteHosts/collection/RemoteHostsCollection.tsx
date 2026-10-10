import * as React from 'react';
import { View } from 'react-native';
import { Redirect, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { AccessEndpointSettingsSection } from '@/components/settings/server/accessEndpoints/AccessEndpointSettingsSection';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingRow, useSettingRevealRequested } from '@/components/settings/shell/SettingRow';
import { SystemTaskProgressCard } from '@/components/systemTasks/SystemTaskProgressCard';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';

import { REMOTE_HOSTS_SETTINGS } from '../remoteHostsSettings';
import { TrustedHostKeysSection } from '../TrustedHostKeysSection';
import {
    RemoteHostsCollectionProvider,
    useRemoteHostsCollection,
    useRemoteHostsCollectionController,
    useRemoteHostsGates,
    type RemoteHostsGates,
} from './remoteHostsCollectionController';
import { remoteHostDraftTitle } from './remoteHostDraftTitle';
import {
    REMOTE_HOSTS_ACCESS_ROUTE,
    readLastVisitedRemoteHostId,
    resolveRemoteHostsLandingHref,
    resolveSelectedRemoteHostsEntry,
} from './remoteHostsRoutes';
import { CollectionDraftRow, CollectionList, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { HappierCollectionListMark, useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';

function openHref(router: ReturnType<typeof useRouter>, href: string, replace: boolean, tag: string) {
    const result = runGuardedNavigation(() => (replace ? router.replace(href as never) : router.push(href as never)));
    if (result !== true) fireAndForget(result, { tag });
}

function hostTargetLine(host: RemoteHost): string {
    return typeof host.ssh.port === 'number' && Number.isFinite(host.ssh.port)
        ? `${host.ssh.target} · ${t('settings.remoteHostsPortLine', { port: host.ssh.port })}`
        : host.ssh.target;
}

/**
 * The Remote hosts collection's shell state: the page this device shows when it cannot manage remote
 * hosts, else the one collection owner (hosts, their tasks, tunnels and relay access) around the
 * rail and pages.
 */
export const RemoteHostsCollectionRoot = React.memo(function RemoteHostsCollectionRoot(props: Readonly<{ children: React.ReactNode }>) {
    const gates = useRemoteHostsGates();
    if (gates.availability !== 'available') return <RemoteHostsUnavailablePage availability={gates.availability} />;
    return <RemoteHostsCollectionMounted gates={gates}>{props.children}</RemoteHostsCollectionMounted>;
});

const RemoteHostsCollectionMounted = React.memo(function RemoteHostsCollectionMounted(props: Readonly<{
    gates: RemoteHostsGates;
    children: React.ReactNode;
}>) {
    const controller = useRemoteHostsCollectionController(props.gates);
    return <RemoteHostsCollectionProvider value={controller}>{props.children}</RemoteHostsCollectionProvider>;
});

const RemoteHostsUnavailablePage = React.memo(function RemoteHostsUnavailablePage(props: Readonly<{
    availability: 'desktopOnly' | 'managementDisabled';
}>) {
    const desktopOnly = props.availability === 'desktopOnly';
    return (
        <ItemList>
            <SettingsPageHeader description={t('settingsRemoteHostsPage.pageDescription')} />
            <ItemGroup
                title={t('settingsRemoteHostsPage.savedHostsSection')}
                description={t('settingsRemoteHostsPage.unavailableDescription')}
            >
                <Item
                    testID={desktopOnly ? 'settings.remoteHosts.desktopOnly' : 'settings.remoteHosts.managementDisabled'}
                    title={t(desktopOnly ? 'settings.remoteHostsDesktopOnlyTitle' : 'settings.remoteHostsManagementDisabledTitle')}
                    subtitle={t(desktopOnly ? 'settings.remoteHostsDesktopOnlySubtitle' : 'settings.remoteHostsManagementDisabledSubtitle')}
                    subtitleLines={0}
                    mode="info"
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});

/** A running host task (bootstrap, tunnel, maintenance): above whichever page is open, since it outlives it. */
export const RemoteHostsActiveTask = React.memo(function RemoteHostsActiveTask() {
    const { activeTask } = useRemoteHostsCollection();
    if (!activeTask) return null;
    return (
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <SystemTaskProgressCard snapshot={activeTask.snapshot} onCancel={activeTask.cancel} title={activeTask.title} />
        </View>
    );
});

/**
 * The collection's "+": a new host starts as a draft in the collection, with its editor as the page.
 */
export const AddRemoteHostButton = React.memo(function AddRemoteHostButton(props: Readonly<{ replace: boolean }>) {
    const router = useRouter();
    const collection = useRemoteHostsCollection();
    return (
        <IconButton
            testID="settings.remoteHosts.add"
            iconName="plus"
            accessibilityLabel={t('settings.remoteHostsAddHost')}
            tooltip={t('settings.remoteHostsAddHost')}
            variant="plain"
            onPress={() => { void collection.openHost(null, href => props.replace ? router.replace(href as never) : router.push(href as never)); }}
        />
    );
});

/**
 * The saved hosts, most recently used first, then this device's keys and connections. `rail` is the
 * list beside the open page (rows replace it); `page` is the same list as the index where no rail
 * shows (rows push). Adding is the last row of the list and the "+" of the rail.
 */
export const RemoteHostsCollectionList = React.memo(function RemoteHostsCollectionList(props: Readonly<{ variant: 'rail' | 'page' }>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = usePathname();
    const { hosts, openHost, catalogComplete } = useRemoteHostsCollection();
    const rail = props.variant === 'rail';
    const selected = rail ? resolveSelectedRemoteHostsEntry(pathname) : null;
    const onDetailRoute = resolveSelectedRemoteHostsEntry(pathname) !== null;

    const hostRows = hosts.map((host) => (
        <Item
            key={host.id}
            testID={`settings.remoteHosts.hostRow.${host.id}`}
            title={host.name}
            subtitle={hostTargetLine(host)}
            icon={(
                <HappierCollectionListMark>
                    <Icon name="desktop" size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
            selected={rail ? selected?.kind === 'host' && selected.hostId === host.id : undefined}
            density={rail ? 'compact' : undefined}
            showChevron={!rail}
            pressableStyle={rail ? collectionListStyles.row : undefined}
            onPress={() => { void openHost(host.id, href => rail && onDetailRoute ? router.replace(href as never) : router.push(href as never)); }}
        />
    ));
    const accessRow = (
        <Item
            testID="settings.remoteHosts.accessRow"
            title={t('settingsRemoteHostsPage.accessTitle')}
            subtitle={t('settingsRemoteHostsPage.accessRowSubtitle')}
            icon={(
                <HappierCollectionListMark>
                    <Icon name="key" size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
            selected={rail ? selected?.kind === 'access' : undefined}
            density={rail ? 'compact' : undefined}
            showChevron={!rail}
            pressableStyle={rail ? collectionListStyles.row : undefined}
            onPress={() => openHref(router, REMOTE_HOSTS_ACCESS_ROUTE, rail && onDetailRoute, 'RemoteHostsCollectionList.access')}
        />
    );

    if (!rail) {
        return (
            <>
                <ItemGroup
                    title={t('settingsRemoteHostsPage.savedHostsSection')}
                    description={hosts.length > 0 ? t('settingsRemoteHostsPage.savedHostsDescription') : undefined}
                >
                    {hostRows}
                    <SettingRow
                        testID="settings.remoteHosts.addHost"
                        setting={REMOTE_HOSTS_SETTINGS.settings.addHost}
                        onPress={() => { void openHost(null, href => router.push(href as never)); }}
                    />
                </ItemGroup>
                <ItemGroup>{accessRow}</ItemGroup>
            </>
        );
    }

    return (
        <CollectionList
            testID="settings.remoteHosts.rail"
            title={t('settings.remoteHostsTitle')}
            count={catalogComplete ? hosts.length : undefined}
            headerAction={<AddRemoteHostButton replace={onDetailRoute} />}
        >
            {selected?.kind === 'new' ? <RemoteHostDraftRow /> : null}
            {hostRows}
            {accessRow}
        </CollectionList>
    );
});

const RemoteHostDraftRow = React.memo(function RemoteHostDraftRow() {
    const { theme } = useUnistyles();
    return (
        <CollectionDraftRow
            testID="settings.remoteHosts.rail.draft"
            titles={remoteHostDraftTitle}
            placeholder={t('settingsRemoteHostsPage.newHostTitle')}
            mark={(
                <HappierCollectionListMark>
                    <Icon name="desktop" size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
        />
    );
});

/** The rail beside the open page. */
export const RemoteHostsRail = React.memo(function RemoteHostsRail() {
    return <RemoteHostsCollectionList variant="rail" />;
});

/**
 * `/settings/remote-hosts`. Beside the rail something is always selected, so the index lands on a
 * host (or the new-host draft); where no rail shows, it is the list page and rows push their page.
 */
export const RemoteHostsSettingsIndex = React.memo(function RemoteHostsSettingsIndex() {
    const view = useHappierCollectionIndexView();
    if (view === 'pending') return null;
    if (view === 'land') return <RemoteHostsLanding />;
    return (
        <ItemList>
            <SettingsPageHeader
                testID="settings.remoteHosts.header"
                description={t('settingsRemoteHostsPage.pageDescription')}
                actions={<AddRemoteHostButton replace={false} />}
            />
            <RemoteHostsCollectionList variant="page" />
        </ItemList>
    );
});

const ADD_HOST_SETTINGS = [REMOTE_HOSTS_SETTINGS.settings.addHost];

const RemoteHostsLanding = React.memo(function RemoteHostsLanding() {
    const { hosts, catalogComplete } = useRemoteHostsCollection();
    const addHostRequested = useSettingRevealRequested(ADD_HOST_SETTINGS);
    if (!catalogComplete) return null;
    const href = resolveRemoteHostsLandingHref(hosts.map((host) => host.id), readLastVisitedRemoteHostId(), { addHostRequested });
    return <Redirect href={href as never} />;
});

/**
 * Keys and connections: host keys this device trusts, tunnels open to saved hosts, access routes
 * and SSH setups that were interrupted. They concern every host, so they have their own page.
 */
export const RemoteHostsAccessPage = React.memo(function RemoteHostsAccessPage() {
    const {
        activeRemoteHostSshTunnels,
        hostNameById,
        sshTunnelControl,
        remoteHostOutcomeActions,
        accessChannels,
        accessEndpointProjection,
        handleAccessEndpointRemediationActionPress,
    } = useRemoteHostsCollection();
    return (
        <ItemList>
            <SettingsPageHeader
                testID="settings.remoteHosts.access.header"
                alwaysShowTitle
                title={t('settingsRemoteHostsPage.accessTitle')}
                description={t('settingsRemoteHostsPage.accessPageDescription')}
            />
            <TrustedHostKeysSection />
            {activeRemoteHostSshTunnels.length > 0 ? (
                <ItemGroup
                    title={t('settings.remoteHostsSshTunnelGroupTitle')}
                    description={t('settingsRemoteHostsPage.sshTunnelsDescription')}
                >
                    {activeRemoteHostSshTunnels.map((tunnel) => {
                        const remoteHostId = tunnel.remoteHostId ?? tunnel.tunnelKey;
                        const label = (tunnel.remoteHostId ? hostNameById.get(tunnel.remoteHostId) : null) ?? tunnel.tunnelKey;
                        return (
                            <RemoteHostTunnelRows
                                key={tunnel.tunnelKey}
                                testIdSuffix={remoteHostId}
                                label={label}
                                url={tunnel.httpBaseUrl}
                                onStop={() => { void sshTunnelControl.stopTunnel(tunnel.tunnelKey); }}
                            />
                        );
                    })}
                </ItemGroup>
            ) : null}
            {!remoteHostOutcomeActions.relayAccessSelection && accessChannels.length > 0 ? (
                <AccessEndpointSettingsSection
                    channels={accessChannels}
                    remediationActions={accessEndpointProjection.remediationActions}
                    onRemediationActionPress={handleAccessEndpointRemediationActionPress}
                />
            ) : null}
            <RemoteHostInterruptedSetups />
        </ItemList>
    );
});

/** An open tunnel to a host, and the one action it has: stop. */
export const RemoteHostTunnelRows = React.memo(function RemoteHostTunnelRows(props: Readonly<{
    testIdSuffix: string;
    label: string;
    url: string;
    onStop: () => void;
}>) {
    return (
        <>
            <Item
                testID={`settings.remoteHosts.sshTunnel.${props.testIdSuffix}`}
                title={t('settings.remoteHostsSshTunnelActiveTitle', { host: props.label })}
                subtitle={t('settings.remoteHostsSshTunnelActiveSubtitle', { url: props.url })}
                mode="info"
                showChevron={false}
            />
            <Item
                testID={`settings.remoteHosts.sshTunnel.stop.${props.testIdSuffix}`}
                title={t('settings.remoteHostsSshTunnelStopTitle')}
                showChevron={false}
                onPress={props.onStop}
            />
        </>
    );
});

/** SSH setups the app was running when it last closed, for every host or one (`hostId`). */
export const RemoteHostInterruptedSetups = React.memo(function RemoteHostInterruptedSetups(props: Readonly<{ hostId?: string }>) {
    const { nativeSshBootstrapInterruptions } = useRemoteHostsCollection();
    const interruptions = props.hostId
        ? nativeSshBootstrapInterruptions.interruptions.filter((interruption) => interruption.remoteHostId === props.hostId)
        : nativeSshBootstrapInterruptions.interruptions;
    if (interruptions.length === 0) return null;
    return (
        <ItemGroup title={t('settings.remoteHostsActiveTaskTitle')}>
            {interruptions.map((interruption) => (
                <Item
                    key={interruption.marker.key}
                    testID={`settings.remoteHosts.interruptedBootstrap.${interruption.remoteHostId}`}
                    title={t('settings.remoteHostsSetupAsMachineTitle')}
                    subtitle={interruption.remoteHostName}
                    mode="info"
                    showChevron={false}
                    rightElement={(
                        <ItemRowActions
                            title={interruption.remoteHostName}
                            actions={[{
                                id: 'clearInterruptedBootstrap',
                                title: t('common.remove'),
                                icon: 'x-circle',
                                onPress: () => {
                                    nativeSshBootstrapInterruptions.clearInterruption(interruption.marker.key);
                                },
                            }]}
                            compactThreshold={Number.MAX_SAFE_INTEGER}
                        />
                    )}
                />
            ))}
        </ItemGroup>
    );
});
