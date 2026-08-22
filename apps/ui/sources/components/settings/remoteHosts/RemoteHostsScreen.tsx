import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { t } from '@/text';
import { Modal } from '@/modal';
import { useSettingMutable, useSettings } from '@/sync/domains/state/storage';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { sync } from '@/sync/sync';

import {
    readRemoteHosts,
    removeRemoteHost,
    upsertRemoteHost,
    type RemoteHost,
    type RemoteHostsV1Raw,
} from '@/sync/domains/remoteHosts/remoteHostModel';
import { getRemoteHostLocalOverrides, deleteRemoteHostLocalOverrides, upsertRemoteHostLocalOverrides } from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';
import { resolveRemoteHostEffectiveSshConfig } from '@/sync/domains/remoteHosts/resolveRemoteHostEffectiveSshConfig';
import { getDefaultSystemTaskRunner } from '@/components/systemTasks';
import { useSystemTaskSnapshot } from '@/components/systemTasks/useSystemTaskSnapshot';
import { SystemTaskProgressCard } from '@/components/systemTasks/SystemTaskProgressCard';
import { readLatestSystemTaskPrompt } from '@/components/systemTasks/prompts/readLatestSystemTaskPrompt';
import { useSshSystemTaskPromptModals } from '@/components/systemTasks/ssh/useSshSystemTaskPromptModals';
import { readNativeSshBridgeInterruptionKey, type NativeSshBridgeInterruptionMarker } from '@/components/systemTasks/createNativeSshBridge';
import { NATIVE_SSH_BOOTSTRAP_TASK_KIND } from '@/components/systemTasks/bridges/native';
import { createDefaultNativeSshBridgeInterruptionStore } from '@/components/systemTasks/nativeSshBridgeInterruptionStore';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { buildRemoteSshManageHostSystemTaskSpec } from '@/components/systemTasks/specs/remoteSsh/buildRemoteSshManageHostSystemTaskSpec';
import { RelayAccessControlSection } from '@/components/settings/server/relayAccess/RelayAccessControlSection';
import { AccessEndpointSettingsSection } from '@/components/settings/server/accessEndpoints/AccessEndpointSettingsSection';
import { buildAccessChannelProjection } from '@/sync/domains/accessEndpoints/channels/buildProjection';
import { buildAccessEndpointProjection } from '@/sync/domains/accessEndpoints/buildProjection';
import { getNativeSshTunnelRuntime } from '@/sync/runtime/nativeSshTunnels/runtime';
import type { NativeSshTunnelSnapshot } from '@/sync/runtime/nativeSshTunnels/types';

import { RemoteHostForm } from './RemoteHostForm';
import { TrustedHostKeysSection } from './TrustedHostKeysSection';
import { pinnedRemoteHostOutcomeActionIds } from './remoteHostOutcomeActions';
import { useRemoteHostOutcomeActions } from './useRemoteHostOutcomeActions';
import { useRemoteHostSshTunnelControl } from './useRemoteHostSshTunnelControl';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { Icon } from '@/components/ui/icons/Icon';

const REMOTE_HOST_ROW_ACTIONS_OVERFLOW_THRESHOLD = Number.MAX_SAFE_INTEGER;

function sortByLastUsedDesc(hosts: readonly RemoteHost[]): RemoteHost[] {
    return [...hosts].sort((left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0));
}

function hasNativeUsableSshCredentialMaterial(
    host: RemoteHost,
    secretMaterialAllowed: boolean,
): boolean {
    if (!secretMaterialAllowed) {
        return false;
    }
    if (host.ssh.authMode === 'password') {
        return Boolean(host.ssh.passwordEnc);
    }
    if (host.ssh.authMode === 'keyfile') {
        return Boolean(host.ssh.identityPrivateKeyEnc);
    }
    return false;
}

function emptyNativeSshTunnelSnapshot(): NativeSshTunnelSnapshot {
    return {
        leases: [],
        platformLimitations: [],
    };
}

function useNativeSshTunnelSnapshot(enabled: boolean): NativeSshTunnelSnapshot {
    const [snapshot, setSnapshot] = React.useState<NativeSshTunnelSnapshot>(() => emptyNativeSshTunnelSnapshot());

    React.useEffect(() => {
        if (!enabled) {
            setSnapshot(emptyNativeSshTunnelSnapshot());
            return undefined;
        }
        const runtime = getNativeSshTunnelRuntime();
        setSnapshot(runtime.listTunnels());
        return runtime.subscribe(() => {
            setSnapshot(runtime.listTunnels());
        });
    }, [enabled]);

    return snapshot;
}

type NativeSshBootstrapInterruption = Readonly<{
    remoteHostId: string;
    remoteHostName: string;
    marker: NativeSshBridgeInterruptionMarker;
}>;

function useNativeSshBootstrapInterruptions(
    enabled: boolean,
    hosts: readonly RemoteHost[],
    activeTaskIds: readonly string[],
): Readonly<{
    interruptions: readonly NativeSshBootstrapInterruption[];
    clearInterruption: (key: string) => void;
}> {
    const store = React.useMemo(() => createDefaultNativeSshBridgeInterruptionStore(), []);
    const [revision, setRevision] = React.useState(0);
    const activeTaskIdSet = React.useMemo(() => new Set(activeTaskIds), [activeTaskIds]);
    const interruptions = React.useMemo(() => {
        if (!enabled) {
            return [];
        }
        const markers = new Map((store.list?.() ?? []).map((marker) => [marker.key, marker] as const));
        return hosts.flatMap((host): NativeSshBootstrapInterruption[] => {
            const key = readNativeSshBridgeInterruptionKey({
                kind: NATIVE_SSH_BOOTSTRAP_TASK_KIND,
                params: { remoteHostId: host.id },
            });
            const marker = markers.get(key) ?? store.read(key);
            return marker && !activeTaskIdSet.has(marker.taskId)
                ? [{
                    remoteHostId: host.id,
                    remoteHostName: host.name,
                    marker,
                }]
                : [];
        });
    }, [activeTaskIdSet, enabled, hosts, revision, store]);

    const clearInterruption = React.useCallback((key: string) => {
        store.remove(key);
        setRevision((value) => value + 1);
    }, [store]);

    return { interruptions, clearInterruption };
}

export const RemoteHostsScreen = React.memo(function RemoteHostsScreen() {
    const isDesktop = isDesktopHost();
    const runner = getDefaultSystemTaskRunner();
    const supportsRemoteHostManagementSurface = isDesktop || runner.mode === 'native';
    const { theme } = useUnistyles();
    const supportsWholeRowPress = Platform.OS !== 'web';
    const [remoteHostsRaw, setRemoteHosts] = useSettingMutable('remoteHostsV1');
    const remoteHosts = React.useMemo(() => readRemoteHosts(remoteHostsRaw), [remoteHostsRaw]);
    const hosts = React.useMemo(() => sortByLastUsedDesc(remoteHosts), [remoteHosts]);
    useSettings(); // Ensure settings are hydrated for feature decisions.
    const remoteHostsManagementEnabled = useFeatureEnabled('remoteHosts.management');
    const secretMaterialAllowed = useFeatureEnabled('remoteHosts.secretMaterial');
    const setupSurfacePolicy = React.useMemo(() => resolveSetupSurfacePolicy(), []);
    const remoteSshMachineSetupAllowed = setupSurfacePolicy.machine.allowRemoteSshMachineSetup;
    const nativeSshTransportAllowed = getFeatureBuildPolicyDecision('setup.ssh.nativeTransport') !== 'deny';

    if (!supportsRemoteHostManagementSurface) {
        return (
            <ItemList>
                <ItemGroup title={t('settings.remoteHostsTitle')}>
                    <Item
                        testID="settings.remoteHosts.desktopOnly"
                        title={t('settings.remoteHostsDesktopOnlyTitle')}
                        subtitle={t('settings.remoteHostsDesktopOnlySubtitle')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    if (!remoteHostsManagementEnabled) {
        return (
            <ItemList>
                <ItemGroup title={t('settings.remoteHostsTitle')}>
                    <Item
                        testID="settings.remoteHosts.managementDisabled"
                        title={t('settings.remoteHostsManagementDisabledTitle')}
                        subtitle={t('settings.remoteHostsManagementDisabledSubtitle')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <RemoteHostsScreenBody
            hosts={hosts}
            remoteHosts={remoteHosts}
            remoteHostsRaw={remoteHostsRaw}
            setRemoteHosts={setRemoteHosts}
            runner={runner}
            remoteSshMachineSetupAllowed={remoteSshMachineSetupAllowed}
            nativeSshTransportAllowed={nativeSshTransportAllowed}
            secretMaterialAllowed={secretMaterialAllowed}
            supportsWholeRowPress={supportsWholeRowPress}
            themeTextSecondary={theme.colors.text.secondary}
        />
    );
});

const RemoteHostsScreenBody = React.memo(function RemoteHostsScreenBody(props: Readonly<{
    hosts: RemoteHost[];
    remoteHosts: RemoteHost[];
    remoteHostsRaw: RemoteHostsV1Raw;
    runner: ReturnType<typeof getDefaultSystemTaskRunner>;
    remoteSshMachineSetupAllowed: boolean;
    nativeSshTransportAllowed: boolean;
    setRemoteHosts: (value: RemoteHostsV1Raw) => void;
    secretMaterialAllowed: boolean;
    supportsWholeRowPress: boolean;
    themeTextSecondary: string;
}>) {
    const runner = props.runner;
    const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
    const [activeTaskTitle, setActiveTaskTitle] = React.useState<string | null>(null);
    const [activeTaskAction, setActiveTaskAction] = React.useState<string | null>(null);
    const activeTaskSnapshot = useSystemTaskSnapshot(runner, activeTaskId);
    const latestPrompt = React.useMemo(() => readLatestSystemTaskPrompt(activeTaskSnapshot), [activeTaskSnapshot]);
    useSshSystemTaskPromptModals({
        runner,
        taskId: activeTaskId,
        snapshot: activeTaskSnapshot,
        prompt: latestPrompt,
    });

    React.useEffect(() => {
        if (!activeTaskId) return;
        const result = activeTaskSnapshot?.result;
        if (!result) return;
        void (async () => {
            try {
                if (result.ok) {
                    if (activeTaskAction === 'testConnection') {
                        Modal.alert(t('common.success'), t('settings.remoteHostsConnectionSucceeded'));
                    } else {
                        Modal.alert(t('common.success'), activeTaskTitle ?? t('common.success'));
                    }
                } else {
                    const message = result.error.message || t('settings.remoteHostsConnectionFailed');
                    Modal.alert(t('common.error'), message);
                }
            } finally {
                setActiveTaskId(null);
                setActiveTaskTitle(null);
                setActiveTaskAction(null);
            }
        })();
    }, [activeTaskAction, activeTaskId, activeTaskSnapshot?.result, activeTaskTitle]);

    const sshTunnelControl = useRemoteHostSshTunnelControl({ runner });
    const remoteHostOutcomeActions = useRemoteHostOutcomeActions({
        runner,
        remoteHosts: props.remoteHosts,
        remoteHostsRaw: props.remoteHostsRaw,
        secretMaterialAllowed: props.secretMaterialAllowed,
        onSshTunnelEnsured: () => {
            void sshTunnelControl.refreshTunnels();
        },
    });
    const activeRemoteHostSshTunnels = React.useMemo(() => (
        sshTunnelControl.tunnels.filter((tunnel) => tunnel.purpose === 'remote-host-access')
    ), [sshTunnelControl.tunnels]);
    const nativeSshCapabilityAvailable = props.nativeSshTransportAllowed
        && runner.capabilities?.nativeSsh?.available === true;
    const nativeSshLoopbackTunnelAvailable = nativeSshCapabilityAvailable
        && runner.capabilities?.nativeSsh?.supportsLoopbackTunnel === true;
    const nativeSshTunnelSnapshot = useNativeSshTunnelSnapshot(runner.mode === 'native' && nativeSshLoopbackTunnelAvailable);
    const activeNativeSshBootstrapTaskIds = React.useMemo(() => [
        ...(activeTaskId && activeTaskSnapshot && !activeTaskSnapshot.result ? [activeTaskId] : []),
        ...(remoteHostOutcomeActions.activeTaskSnapshot && !remoteHostOutcomeActions.activeTaskSnapshot.result
            ? [remoteHostOutcomeActions.activeTaskSnapshot.taskId]
            : []),
        ...(sshTunnelControl.activeTaskSnapshot && !sshTunnelControl.activeTaskSnapshot.result
            ? [sshTunnelControl.activeTaskSnapshot.taskId]
            : []),
    ], [
        activeTaskId,
        activeTaskSnapshot,
        remoteHostOutcomeActions.activeTaskSnapshot,
        sshTunnelControl.activeTaskSnapshot,
    ]);
    const nativeSshBootstrapInterruptions = useNativeSshBootstrapInterruptions(
        runner.mode === 'native' && nativeSshCapabilityAvailable,
        props.hosts,
        activeNativeSshBootstrapTaskIds,
    );
    const canRunRemoteHostMaintenanceTasks = runner.mode === 'tauri';
    const canRunRemoteHostBootstrapTasks = props.remoteSshMachineSetupAllowed
        && (canRunRemoteHostMaintenanceTasks || (runner.mode === 'native' && nativeSshCapabilityAvailable));
    const connectableRemoteHostIds = React.useMemo(() => new Set(
        runner.mode === 'tauri'
            ? props.hosts.map((host) => host.id)
            : runner.mode === 'native' && nativeSshLoopbackTunnelAvailable
                ? props.hosts
                    .filter((host) => hasNativeUsableSshCredentialMaterial(host, props.secretMaterialAllowed))
                    .map((host) => host.id)
                : [],
    ), [nativeSshLoopbackTunnelAvailable, props.hosts, props.secretMaterialAllowed, runner.mode]);
    const nativeBootstrapCapableRemoteHostIds = React.useMemo(() => new Set(
        runner.mode === 'native' && nativeSshCapabilityAvailable
            ? props.hosts
                .filter((host) => hasNativeUsableSshCredentialMaterial(host, props.secretMaterialAllowed))
                .map((host) => host.id)
            : [],
    ), [nativeSshCapabilityAvailable, props.hosts, props.secretMaterialAllowed, runner.mode]);
    const hostNameById = React.useMemo(() => new Map(props.hosts.map((host) => [host.id, host.name])), [props.hosts]);
    const accessEndpointProjection = React.useMemo(() => buildAccessEndpointProjection({
        clientContext: runner.mode === 'native' ? 'native' : 'desktop',
        remoteHosts: props.hosts,
        sshTunnelSnapshots: sshTunnelControl.tunnels,
        nativeSshTunnelSnapshot,
    }), [nativeSshTunnelSnapshot, props.hosts, runner.mode, sshTunnelControl.tunnels]);
    const accessChannels = React.useMemo(() => buildAccessChannelProjection({
        endpoints: accessEndpointProjection.endpoints,
    }), [accessEndpointProjection.endpoints]);
    const handleAccessEndpointRemediationActionPress = React.useCallback((payload: Readonly<{
        action: Readonly<{
            ownerSurface: string;
            payload?: Readonly<Record<string, unknown>>;
        }>;
    }>) => {
        if (payload.action.ownerSurface !== 'sshTunnel.stop') {
            return;
        }
        const leaseId = typeof payload.action.payload?.leaseId === 'string' ? payload.action.payload.leaseId : '';
        if (leaseId && runner.mode === 'native') {
            void (async () => {
                try {
                    await getNativeSshTunnelRuntime().releaseTunnel(leaseId);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error ?? '');
                    Modal.alert(t('common.error'), message || t('settings.remoteHostsConnectFromThisDeviceFailed'));
                }
            })();
            return;
        }
        const tunnelKey = typeof payload.action.payload?.tunnelKey === 'string' ? payload.action.payload.tunnelKey : '';
        if (tunnelKey) {
            void sshTunnelControl.stopTunnel(tunnelKey);
        }
    }, [runner.mode, sshTunnelControl]);

    const startManageHostAction = React.useCallback(async (
        remoteHost: RemoteHost,
        action: Parameters<typeof buildRemoteSshManageHostSystemTaskSpec>[0]['action'],
        title: string,
    ) => {
        try {
            const localOverrides = getRemoteHostLocalOverrides(remoteHost.id);
            const resolved = await resolveRemoteHostEffectiveSshConfig({
                remoteHost,
                localOverrides,
                secretMaterialAllowed: props.secretMaterialAllowed,
                decryptSecretValue: (input) => sync.decryptSecretValue(input),
            });
            if (!resolved.ok) {
                Modal.alert(t('common.error'), resolved.error.message);
                return;
            }

            const spec = buildRemoteSshManageHostSystemTaskSpec({
                action,
                channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(),
                sshTarget: resolved.value.sshTarget,
                sshPort: resolved.value.sshPort ? String(resolved.value.sshPort) : '',
                sshAuth: resolved.value.sshAuth,
                identityFilePath: resolved.value.identityFilePath,
                identityPrivateKey: resolved.value.identityPrivateKey,
                sshConfigFilePath: resolved.value.sshConfigFilePath,
                sshPassword: resolved.value.password,
                knownHostsMode: 'app',
                serviceMode: 'user',
                relayRuntime: {
                    channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(),
                    mode: 'user',
                },
            });
            const taskId = await runner.start(spec);
            setActiveTaskId(taskId);
            setActiveTaskTitle(title);
            setActiveTaskAction(action);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error ?? '');
            Modal.alert(t('common.error'), message || t('settings.remoteHostsConnectionFailed'));
        }
    }, [props.secretMaterialAllowed, runner]);

    const openEditor = React.useCallback((remoteHostId: string | null) => {
        const existing = remoteHostId ? props.hosts.find((entry) => entry.id === remoteHostId) ?? null : null;
        const localOverrides = existing ? getRemoteHostLocalOverrides(existing.id) : null;

        Modal.show({
            component: RemoteHostForm,
            props: {
                remoteHost: existing,
                localOverrides,
                savedRemoteHosts: props.remoteHosts,
                systemTaskRunner: runner,
                secretMaterialAllowed: props.secretMaterialAllowed,
                remoteMaintenanceSupported: canRunRemoteHostMaintenanceTasks,
                onSave: ({ remoteHost, localOverrides }) => {
                    props.setRemoteHosts(upsertRemoteHost(props.remoteHostsRaw, remoteHost));
                    upsertRemoteHostLocalOverrides(remoteHost.id, localOverrides);
                },
                onDelete: (id) => {
                    props.setRemoteHosts(removeRemoteHost(props.remoteHostsRaw, id));
                    deleteRemoteHostLocalOverrides(id);
                },
                onTestConnection: (host) => void startManageHostAction(host, 'testConnection', t('settings.remoteHostsTestConnectionTitle')),
            },
            closeOnBackdrop: true,
        });
    }, [props.hosts, props.remoteHosts, props.remoteHostsRaw, props.secretMaterialAllowed, props.setRemoteHosts, startManageHostAction]);

    return (
        <ItemList>
            <ItemGroup title={t('settings.remoteHostsTitle')}>
                {props.hosts.length === 0 ? (
                    <Item
                        testID="settings.remoteHosts.empty"
                        title={t('settings.remoteHostsEmptyTitle')}
                        subtitle={t('settings.remoteHostsEmptySubtitle')}
                        mode="info"
                        showChevron={false}
                    />
                ) : null}
                {props.hosts.map((host) => (
                    (() => {
                        const canConnectFromThisDevice = connectableRemoteHostIds.has(host.id);
                        const canSetupAsMachine = canRunRemoteHostBootstrapTasks
                            && (canRunRemoteHostMaintenanceTasks || nativeBootstrapCapableRemoteHostIds.has(host.id));
                        const actions: ItemAction[] = [
                            ...(canSetupAsMachine ? [{
                                id: 'setupAsMachine',
                                title: t('settings.remoteHostsSetupAsMachineTitle'),
                                icon: 'rocket',
                                inlineTestID: `settings.remoteHosts.action.setupAsMachine.${host.id}`,
                                onPress: () => {
                                    void remoteHostOutcomeActions.setupAsMachine(host);
                                },
                            }] satisfies ItemAction[] : []),
                            ...(canConnectFromThisDevice ? [{
                                id: 'connectFromThisDevice',
                                title: t('settings.remoteHostsConnectFromThisDeviceTitle'),
                                subtitle: t('settings.remoteHostsConnectFromThisDeviceSubtitle'),
                                icon: 'graph',
                                inlineTestID: `settings.remoteHosts.action.connectFromThisDevice.${host.id}`,
                                onPress: () => {
                                    void remoteHostOutcomeActions.connectFromThisDevice(host);
                                },
                            }] satisfies ItemAction[] : []),
                            {
                                id: 'useAsRelayHost',
                                title: t('settings.remoteHostsUseAsRelayHostTitle'),
                                subtitle: t('settings.remoteHostsUseAsRelayHostSubtitle'),
                                icon: 'radio',
                                inlineTestID: `settings.remoteHosts.action.useAsRelayHost.${host.id}`,
                                onPress: () => {
                                    void remoteHostOutcomeActions.openRelayAccess(host);
                                },
                            },
                            {
                                id: 'configureAccess',
                                title: t('settings.remoteHostsConfigureAccessTitle'),
                                subtitle: t('settings.remoteHostsConfigureAccessSubtitle'),
                                icon: 'graph',
                                inlineTestID: `settings.remoteHosts.action.configureAccess.${host.id}`,
                                onPress: () => {
                                    void remoteHostOutcomeActions.openRelayAccess(host);
                                },
                            },
                            {
                                id: 'openDetails',
                                title: t('settings.remoteHostsOpenDetailsTitle'),
                                icon: 'info',
                                onPress: () => openEditor(host.id),
                            },
                            ...(canRunRemoteHostMaintenanceTasks ? [{
                                id: 'testConnection',
                                title: t('settings.remoteHostsTestConnectionTitle'),
                                icon: 'pulse',
                                inlineTestID: 'settings.remoteHosts.action.testConnection',
                                onPress: () => void startManageHostAction(host, 'testConnection', t('settings.remoteHostsTestConnectionTitle')),
                            },
                            {
                                id: 'installOrUpdateCli',
                                title: t('settings.remoteHostsInstallOrUpdateCliTitle'),
                                icon: 'cloud-arrow-down',
                                inlineTestID: 'settings.remoteHosts.action.installOrUpdateCli',
                                onPress: () => void startManageHostAction(host, 'installOrUpdateCli', t('settings.remoteHostsInstallOrUpdateCliTitle')),
                            },
                            {
                                id: 'daemonService.installOrUpdate',
                                title: t('settings.remoteHostsDaemonServiceInstallOrUpdateTitle'),
                                icon: 'wrench',
                                onPress: () => void startManageHostAction(host, 'daemonService.installOrUpdate', t('settings.remoteHostsDaemonServiceInstallOrUpdateTitle')),
                            },
                            {
                                id: 'daemonService.start',
                                title: t('settings.remoteHostsDaemonServiceStartTitle'),
                                icon: 'play',
                                onPress: () => void startManageHostAction(host, 'daemonService.start', t('settings.remoteHostsDaemonServiceStartTitle')),
                            },
                            {
                                id: 'daemonService.stop',
                                title: t('settings.remoteHostsDaemonServiceStopTitle'),
                                icon: 'stop',
                                onPress: () => void startManageHostAction(host, 'daemonService.stop', t('settings.remoteHostsDaemonServiceStopTitle')),
                            },
                            {
                                id: 'daemonService.restart',
                                title: t('settings.remoteHostsDaemonServiceRestartTitle'),
                                icon: 'arrow-clockwise',
                                onPress: () => void startManageHostAction(host, 'daemonService.restart', t('settings.remoteHostsDaemonServiceRestartTitle')),
                            },
                            {
                                id: 'relayRuntime.status',
                                title: t('settings.remoteHostsRelayRuntimeStatusTitle'),
                                icon: 'info',
                                onPress: () => void startManageHostAction(host, 'relayRuntime.status', t('settings.remoteHostsRelayRuntimeStatusTitle')),
                            },
                            {
                                id: 'relayRuntime.installOrUpdate',
                                title: t('settings.remoteHostsRelayRuntimeInstallOrUpdateTitle'),
                                icon: 'download',
                                onPress: () => void startManageHostAction(host, 'relayRuntime.installOrUpdate', t('settings.remoteHostsRelayRuntimeInstallOrUpdateTitle')),
                            },
                            {
                                id: 'relayRuntime.start',
                                title: t('settings.remoteHostsRelayRuntimeStartTitle'),
                                icon: 'play',
                                onPress: () => void startManageHostAction(host, 'relayRuntime.start', t('settings.remoteHostsRelayRuntimeStartTitle')),
                            },
                            {
                                id: 'relayRuntime.stop',
                                title: t('settings.remoteHostsRelayRuntimeStopTitle'),
                                icon: 'stop',
                                onPress: () => void startManageHostAction(host, 'relayRuntime.stop', t('settings.remoteHostsRelayRuntimeStopTitle')),
                            },
                            {
                                id: 'relayRuntime.restart',
                                title: t('settings.remoteHostsRelayRuntimeRestartTitle'),
                                icon: 'arrow-clockwise',
                                onPress: () => void startManageHostAction(host, 'relayRuntime.restart', t('settings.remoteHostsRelayRuntimeRestartTitle')),
                            }] satisfies ItemAction[] : []),
                            {
                                id: 'edit',
                                title: t('common.edit'),
                                icon: 'pencil',
                                inlineTestID: `settings.remoteHosts.action.edit.${host.id}`,
                                onPress: () => openEditor(host.id),
                            },
                            {
                                id: 'remove',
                                title: t('common.remove'),
                                icon: 'trash',
                                destructive: true,
                                onPress: () => {
                                    void (async () => {
                                        const confirmed = await Modal.confirm(
                                            t('common.remove'),
                                            host.name,
                                            { destructive: true, confirmText: t('common.remove'), cancelText: t('common.cancel') },
                                        );
                                        if (!confirmed) return;
                                        props.setRemoteHosts(removeRemoteHost(props.remoteHostsRaw, host.id));
                                        deleteRemoteHostLocalOverrides(host.id);
                                    })();
                                },
                            },
                        ];

                        const subtitle = [
                            host.ssh.target,
                            typeof host.ssh.port === 'number' && Number.isFinite(host.ssh.port)
                                ? t('settings.remoteHostsPortLine', { port: host.ssh.port })
                                : null,
                        ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join('\n');

                        return (
                            <Item
                                key={host.id}
                                testID={`settings.remoteHosts.hostRow.${host.id}`}
                                title={host.name}
                                subtitle={subtitle}
                                subtitleLines={0}
                                icon={<Icon name="desktop" size={16} color={props.themeTextSecondary} />}
                                showChevron={false}
                                onPress={props.supportsWholeRowPress ? () => openEditor(host.id) : undefined}
                                rightElement={(
                                    <ItemRowActions
                                        title={host.name}
                                        actions={actions}
                                        compactActionIds={[...pinnedRemoteHostOutcomeActionIds]}
                                        pinnedActionIds={[...pinnedRemoteHostOutcomeActionIds]}
                                        compactThreshold={REMOTE_HOST_ROW_ACTIONS_OVERFLOW_THRESHOLD}
                                        overflowTriggerTestID={`settings.remoteHosts.actions.more.${host.id}`}
                                        overflowPosition="beforePinned"
                                    />
                                )}
                            />
                        );
                    })()
                ))}
            </ItemGroup>

            <ItemGroup title={t('common.actions')}>
                <Item
                    testID="settings.remoteHosts.addHost"
                    title={t('settings.remoteHostsAddHost')}
                    onPress={() => openEditor(null)}
                />
            </ItemGroup>

            <TrustedHostKeysSection />

            {activeRemoteHostSshTunnels.length > 0 ? (
                <ItemGroup title={t('settings.remoteHostsSshTunnelGroupTitle')}>
                    {activeRemoteHostSshTunnels.map((tunnel) => {
                        const remoteHostId = tunnel.remoteHostId ?? tunnel.tunnelKey;
                        const hostName = tunnel.remoteHostId ? hostNameById.get(tunnel.remoteHostId) : null;
                        const label = hostName ?? tunnel.tunnelKey;
                        return (
                            <React.Fragment key={tunnel.tunnelKey}>
                                <Item
                                    testID={`settings.remoteHosts.sshTunnel.${remoteHostId}`}
                                    title={t('settings.remoteHostsSshTunnelActiveTitle', { host: label })}
                                    subtitle={t('settings.remoteHostsSshTunnelActiveSubtitle', { url: tunnel.httpBaseUrl })}
                                    mode="info"
                                    showChevron={false}
                                />
                                <Item
                                    testID={`settings.remoteHosts.sshTunnel.stop.${remoteHostId}`}
                                    title={t('settings.remoteHostsSshTunnelStopTitle')}
                                    showChevron={false}
                                    onPress={() => {
                                        void sshTunnelControl.stopTunnel(tunnel.tunnelKey);
                                    }}
                                />
                            </React.Fragment>
                        );
                    })}
                </ItemGroup>
            ) : null}

            {remoteHostOutcomeActions.relayAccessSelection ? (
                <>
                    <ItemGroup title={t('settings.remoteHostsRelayAccessGroupTitle')}>
                        <Item
                            testID={`settings.remoteHosts.relayAccess.${remoteHostOutcomeActions.relayAccessSelection.host.id}`}
                            title={t('settings.remoteHostsRelayAccessActiveTitle', { host: remoteHostOutcomeActions.relayAccessSelection.host.name })}
                            subtitle={t('settings.remoteHostsRelayAccessActiveSubtitle')}
                            mode="info"
                            showChevron={false}
                        />
                    </ItemGroup>
                    <RelayAccessControlSection
                        target={remoteHostOutcomeActions.relayAccessSelection.target}
                        upstreamUrl={remoteHostOutcomeActions.relayAccessSelection.upstreamUrl}
                        runner={runner}
                        accessChannels={accessChannels}
                        accessEndpointRemediationActions={accessEndpointProjection.remediationActions}
                        onAccessEndpointRemediationActionPress={handleAccessEndpointRemediationActionPress}
                    />
                </>
            ) : accessChannels.length > 0 ? (
                <AccessEndpointSettingsSection
                    channels={accessChannels}
                    remediationActions={accessEndpointProjection.remediationActions}
                    onRemediationActionPress={handleAccessEndpointRemediationActionPress}
                />
            ) : null}

            {nativeSshBootstrapInterruptions.interruptions.length > 0 ? (
                <ItemGroup title={t('settings.remoteHostsActiveTaskTitle')}>
                    {nativeSshBootstrapInterruptions.interruptions.map((interruption) => (
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
                                    compactThreshold={REMOTE_HOST_ROW_ACTIONS_OVERFLOW_THRESHOLD}
                                />
                            )}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {(remoteHostOutcomeActions.activeTaskSnapshot ?? sshTunnelControl.activeTaskSnapshot ?? activeTaskSnapshot) ? (
                <ItemGroup title={t('settings.remoteHostsActiveTaskTitle')}>
                    <SystemTaskProgressCard
                        snapshot={remoteHostOutcomeActions.activeTaskSnapshot ?? sshTunnelControl.activeTaskSnapshot ?? activeTaskSnapshot!}
                        onCancel={(remoteHostOutcomeActions.activeTaskSnapshot ?? sshTunnelControl.activeTaskSnapshot ?? activeTaskSnapshot)?.result ? undefined : () => {
                            const taskId = remoteHostOutcomeActions.activeTaskSnapshot?.taskId
                                ?? sshTunnelControl.activeTaskSnapshot?.taskId
                                ?? activeTaskId;
                            if (!taskId) return;
                            void runner.cancel(taskId);
                        }}
                        title={remoteHostOutcomeActions.activeTaskSnapshot
                            ? (remoteHostOutcomeActions.activeTaskTitle ?? t('settings.remoteHostsActiveTaskTitle'))
                            : sshTunnelControl.activeTaskSnapshot
                                ? t('settings.remoteHostsSshTunnelGroupTitle')
                                : (activeTaskTitle ?? t('settings.remoteHostsActiveTaskTitle'))}
                    />
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});
