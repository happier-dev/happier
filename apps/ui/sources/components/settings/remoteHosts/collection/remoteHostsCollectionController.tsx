import * as React from 'react';
import { Platform } from 'react-native';

import type { ItemAction } from '@/components/ui/lists/itemActions';
import { t, tLoose } from '@/text';
import { Modal } from '@/modal';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { sync } from '@/sync/sync';
import {
    readRemoteHosts,
    removeRemoteHost,
    upsertRemoteHost,
    type RemoteHost,
} from '@/sync/domains/remoteHosts/remoteHostModel';
import {
    deleteRemoteHostLocalOverrides,
    getRemoteHostLocalOverrides,
    upsertRemoteHostLocalOverrides,
    type RemoteHostLocalOverrides,
} from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';
import { resolveRemoteHostEffectiveSshConfig } from '@/sync/domains/remoteHosts/resolveRemoteHostEffectiveSshConfig';
import { getDefaultSystemTaskRunner } from '@/components/systemTasks';
import { useSystemTaskSnapshot } from '@/components/systemTasks/useSystemTaskSnapshot';
import { readLatestSystemTaskPrompt } from '@/components/systemTasks/prompts/readLatestSystemTaskPrompt';
import { useSshSystemTaskPromptModals } from '@/components/systemTasks/ssh/useSshSystemTaskPromptModals';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';
import { readNativeSshBridgeInterruptionKey, type NativeSshBridgeInterruptionMarker } from '@/components/systemTasks/createNativeSshBridge';
import { NATIVE_SSH_BOOTSTRAP_TASK_KIND } from '@/components/systemTasks/bridges/native';
import { createDefaultNativeSshBridgeInterruptionStore } from '@/components/systemTasks/nativeSshBridgeInterruptionStore';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { buildRemoteSshManageHostSystemTaskSpec } from '@/components/systemTasks/specs/remoteSsh/buildRemoteSshManageHostSystemTaskSpec';
import { buildAccessChannelProjection } from '@/sync/domains/accessEndpoints/channels/buildProjection';
import { buildAccessEndpointProjection } from '@/sync/domains/accessEndpoints/buildProjection';
import { getNativeSshTunnelRuntime } from '@/sync/runtime/nativeSshTunnels/runtime';
import type { NativeSshTunnelSnapshot } from '@/sync/runtime/nativeSshTunnels/types';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';

import { useRemoteHostOutcomeActions } from '../useRemoteHostOutcomeActions';
import { useRemoteHostSshTunnelControl } from '../useRemoteHostSshTunnelControl';


function personalHomeCopy(key: string, fallback: string): string {
    const translationKey = `personalHome.settings.${key}`;
    const value = tLoose(translationKey);
    return value === translationKey ? fallback : value;
}

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


/** Whether this device can manage remote hosts at all. */
export type RemoteHostsAvailability = 'available' | 'desktopOnly' | 'managementDisabled';

export function useRemoteHostsGates() {
    const isDesktop = isDesktopHost();
    const runner = getDefaultSystemTaskRunner();
    const supportsRemoteHostManagementSurface = isDesktop || runner.mode === 'native';
    const remoteHostsManagementEnabled = useFeatureEnabled('remoteHosts.management');
    const secretMaterialAllowed = useFeatureEnabled('remoteHosts.secretMaterial');
    const setupSurfacePolicy = React.useMemo(() => resolveSetupSurfacePolicy(), []);
    const availability: RemoteHostsAvailability = !supportsRemoteHostManagementSurface
        ? 'desktopOnly'
        : !remoteHostsManagementEnabled ? 'managementDisabled' : 'available';
    return {
        availability,
        runner,
        secretMaterialAllowed,
        remoteSshMachineSetupAllowed: setupSurfacePolicy.machine.allowRemoteSshMachineSetup,
        nativeSshTransportAllowed: getFeatureBuildPolicyDecision('setup.ssh.nativeTransport') !== 'deny',
        supportsWholeRowPress: Platform.OS !== 'web',
    } as const;
}

/**
 * The Remote hosts collection's one owner of hosts, their tasks, tunnels, relay access and
 * interruptions. The collection layout runs it once and shares it with the rail and every page, so a
 * task started from one host keeps reporting while another page is open.
 */
export type RemoteHostsGates = ReturnType<typeof useRemoteHostsGates>;

export function useRemoteHostsCollectionController(gates: RemoteHostsGates) {
    const [remoteHostsRaw, setRemoteHosts] = useSettingMutable('remoteHostsV1');
    const remoteHosts = React.useMemo(() => readRemoteHosts(remoteHostsRaw), [remoteHostsRaw]);
    const hosts = React.useMemo(() => sortByLastUsedDesc(remoteHosts), [remoteHosts]);

    const runner = gates.runner;
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
                    const message = resolveSystemTaskFailureMessage(result.error) ?? t('settings.remoteHostsConnectionFailed');
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
        remoteHosts: remoteHosts,
        remoteHostsRaw: remoteHostsRaw,
        secretMaterialAllowed: gates.secretMaterialAllowed,
        onSshTunnelEnsured: () => {
            void sshTunnelControl.refreshTunnels();
        },
    });
    const activeRemoteHostSshTunnels = React.useMemo(() => (
        sshTunnelControl.tunnels.filter((tunnel) => tunnel.purpose === 'remote-host-access')
    ), [sshTunnelControl.tunnels]);
    const nativeSshCapabilityAvailable = gates.nativeSshTransportAllowed
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
        hosts,
        activeNativeSshBootstrapTaskIds,
    );
    const canRunRemoteHostMaintenanceTasks = runner.mode === 'tauri';
    const canRunRemoteHostBootstrapTasks = gates.remoteSshMachineSetupAllowed
        && (canRunRemoteHostMaintenanceTasks || (runner.mode === 'native' && nativeSshCapabilityAvailable));
    const connectableRemoteHostIds = React.useMemo(() => new Set(
        runner.mode === 'tauri'
            ? hosts.map((host) => host.id)
            : runner.mode === 'native' && nativeSshLoopbackTunnelAvailable
                ? hosts
                    .filter((host) => hasNativeUsableSshCredentialMaterial(host, gates.secretMaterialAllowed))
                    .map((host) => host.id)
                : [],
    ), [nativeSshLoopbackTunnelAvailable, hosts, gates.secretMaterialAllowed, runner.mode]);
    const nativeBootstrapCapableRemoteHostIds = React.useMemo(() => new Set(
        runner.mode === 'native' && nativeSshCapabilityAvailable
            ? hosts
                .filter((host) => hasNativeUsableSshCredentialMaterial(host, gates.secretMaterialAllowed))
                .map((host) => host.id)
            : [],
    ), [nativeSshCapabilityAvailable, hosts, gates.secretMaterialAllowed, runner.mode]);
    const hostNameById = React.useMemo(() => new Map(hosts.map((host) => [host.id, host.name])), [hosts]);
    const accessEndpointProjection = React.useMemo(() => buildAccessEndpointProjection({
        clientContext: runner.mode === 'native' ? 'native' : 'desktop',
        remoteHosts: hosts,
        sshTunnelSnapshots: sshTunnelControl.tunnels,
        nativeSshTunnelSnapshot,
    }), [nativeSshTunnelSnapshot, hosts, runner.mode, sshTunnelControl.tunnels]);
    const accessChannels = React.useMemo(() => buildAccessChannelProjection({
        endpoints: accessEndpointProjection.endpoints,
        diagnostics: accessEndpointProjection.diagnostics,
    }), [accessEndpointProjection.diagnostics, accessEndpointProjection.endpoints]);
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
                secretMaterialAllowed: gates.secretMaterialAllowed,
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
    }, [gates.secretMaterialAllowed, runner]);


    const saveHost = React.useCallback((input: Readonly<{ remoteHost: RemoteHost; localOverrides: RemoteHostLocalOverrides | null }>) => {
        setRemoteHosts(upsertRemoteHost(remoteHostsRaw, input.remoteHost));
        upsertRemoteHostLocalOverrides(input.remoteHost.id, input.localOverrides);
    }, [remoteHostsRaw, setRemoteHosts]);

    const deleteHost = React.useCallback((remoteHostId: string) => {
        setRemoteHosts(removeRemoteHost(remoteHostsRaw, remoteHostId));
        deleteRemoteHostLocalOverrides(remoteHostId);
    }, [remoteHostsRaw, setRemoteHosts]);

    /** Every operation this device can run on a saved host, in the order the host's page offers them. */
    const buildHostActions = React.useCallback((host: RemoteHost): ItemAction[] => {
        const canConnectFromThisDevice = connectableRemoteHostIds.has(host.id);
        const canSetupAsMachine = canRunRemoteHostBootstrapTasks
            && (canRunRemoteHostMaintenanceTasks || nativeBootstrapCapableRemoteHostIds.has(host.id));
        return [
            ...(canSetupAsMachine ? [{
                id: 'setupAsMachine',
                title: t('settings.remoteHostsSetupAsMachineTitle'),
                icon: 'rocket',
                onPress: () => {
                    void remoteHostOutcomeActions.setupAsMachine(host);
                },
            }] satisfies ItemAction[] : []),
            ...(canConnectFromThisDevice ? [{
                id: 'connectFromThisDevice',
                title: t('settings.remoteHostsConnectFromThisDeviceTitle'),
                subtitle: t('settings.remoteHostsConnectFromThisDeviceSubtitle'),
                icon: 'graph',
                onPress: () => {
                    void remoteHostOutcomeActions.connectFromThisDevice(host);
                },
            }] satisfies ItemAction[] : []),
            {
                id: 'useAsRelayHost',
                title: t('settings.remoteHostsUseAsRelayHostTitle'),
                subtitle: t('settings.remoteHostsUseAsRelayHostSubtitle'),
                icon: 'radio',
                onPress: () => {
                    void remoteHostOutcomeActions.openRelayAccess(host);
                },
            },
            {
                id: 'configureAccess',
                title: t('settings.remoteHostsConfigureAccessTitle'),
                subtitle: t('settings.remoteHostsConfigureAccessSubtitle'),
                icon: 'graph',
                onPress: () => {
                    void remoteHostOutcomeActions.openRelayAccess(host);
                },
            },
            ...(canRunRemoteHostMaintenanceTasks ? [{
                id: 'testConnection',
                title: t('settings.remoteHostsTestConnectionTitle'),
                icon: 'pulse',
                onPress: () => void startManageHostAction(host, 'testConnection', t('settings.remoteHostsTestConnectionTitle')),
            },
            {
                id: 'installOrUpdateCli',
                title: t('settings.remoteHostsInstallOrUpdateCliTitle'),
                icon: 'cloud-arrow-down',
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
            },
            {
                id: 'personalHome.erase',
                title: personalHomeCopy('eraseDataAction', 'Delete Personal Home data'),
                subtitle: personalHomeCopy('eraseDataSubtitle', 'Separate from uninstall. Permanently deletes the resolved Home data.'),
                icon: 'trash',
                destructive: true,
                onPress: () => void startManageHostAction(
                    host,
                    'personalHome.erase',
                    personalHomeCopy('eraseDataAction', 'Delete Personal Home data'),
                ),
            }] satisfies ItemAction[] : []),
        ];
    }, [
        canRunRemoteHostBootstrapTasks,
        canRunRemoteHostMaintenanceTasks,
        connectableRemoteHostIds,
        nativeBootstrapCapableRemoteHostIds,
        remoteHostOutcomeActions,
        startManageHostAction,
    ]);

    const combinedTaskSnapshot = remoteHostOutcomeActions.activeTaskSnapshot ?? sshTunnelControl.activeTaskSnapshot ?? activeTaskSnapshot ?? null;
    const combinedTaskTitle = remoteHostOutcomeActions.activeTaskSnapshot
        ? (remoteHostOutcomeActions.activeTaskTitle ?? t('settings.remoteHostsActiveTaskTitle'))
        : sshTunnelControl.activeTaskSnapshot
            ? t('settings.remoteHostsSshTunnelGroupTitle')
            : (activeTaskTitle ?? t('settings.remoteHostsActiveTaskTitle'));
    const cancelActiveTask = React.useCallback(() => {
        const taskId = remoteHostOutcomeActions.activeTaskSnapshot?.taskId
            ?? sshTunnelControl.activeTaskSnapshot?.taskId
            ?? activeTaskId;
        if (!taskId) return;
        void runner.cancel(taskId);
    }, [activeTaskId, remoteHostOutcomeActions.activeTaskSnapshot?.taskId, runner, sshTunnelControl.activeTaskSnapshot?.taskId]);

    return {
        ...gates,
        hosts,
        remoteHosts,
        hostNameById,
        buildHostActions,
        saveHost,
        deleteHost,
        startManageHostAction,
        canRunRemoteHostMaintenanceTasks,
        remoteHostOutcomeActions,
        sshTunnelControl,
        activeRemoteHostSshTunnels,
        accessChannels,
        accessEndpointProjection,
        handleAccessEndpointRemediationActionPress,
        nativeSshBootstrapInterruptions,
        activeTask: combinedTaskSnapshot
            ? { snapshot: combinedTaskSnapshot, title: combinedTaskTitle, cancel: combinedTaskSnapshot.result ? undefined : cancelActiveTask }
            : null,
    } as const;
}

export type RemoteHostsCollectionController = ReturnType<typeof useRemoteHostsCollectionController>;

const RemoteHostsCollectionContext = React.createContext<RemoteHostsCollectionController | null>(null);

export function RemoteHostsCollectionProvider(props: Readonly<{ value: RemoteHostsCollectionController; children: React.ReactNode }>) {
    return <RemoteHostsCollectionContext.Provider value={props.value}>{props.children}</RemoteHostsCollectionContext.Provider>;
}

/** The collection owner the Remote hosts layout shares with its rail and pages. */
export function useRemoteHostsCollection(): RemoteHostsCollectionController {
    const value = React.useContext(RemoteHostsCollectionContext);
    if (!value) throw new Error('useRemoteHostsCollection must be used inside the Remote hosts collection');
    return value;
}

export { getRemoteHostLocalOverrides };
