import * as React from 'react';
import { Platform } from 'react-native';

import type { ItemAction } from '@/components/ui/lists/itemActions';
import { t, tLoose } from '@/text';
import { Modal } from '@/modal';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';
import type { RemoteHostActionIdV1 } from '@happier-dev/protocol/remoteHosts/remoteHostActionIdsV1';
import type { RemoteHostActionInputByIdV1 } from '@happier-dev/protocol/remoteHosts/remoteHostActionsV1';
import { useRemoteHostCatalogSnapshot } from '@/sync/store/settings/remoteHostCatalogSnapshot';
import { invalidateRemoteHostCatalogProjection } from '@/sync/engine/settings/remoteHostCatalogEngine';
import { withProfileAccount } from '@/sync/api/account/apiProfileCatalog';
import { prepareRemoteHostSaveInContext, readRemoteHostCatalogInContext,
    type RemoteHostCredentialChanges } from '@/sync/api/account/apiRemoteHostCatalog';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { REMOTE_HOST_MAINTENANCE_ACTION_IDS } from '@/sync/ops/remoteHosts/remoteHostOperations';
import type { createDefaultActionExecutor, UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';
import {
    deleteRemoteHostLocalOverrides,
    getRemoteHostLocalOverrides,
    upsertRemoteHostLocalOverrides,
    type RemoteHostLocalOverrides,
} from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';
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
import { buildAccessChannelProjection } from '@/sync/domains/accessEndpoints/channels/buildProjection';
import { buildAccessEndpointProjection } from '@/sync/domains/accessEndpoints/buildProjection';
import { getNativeSshTunnelRuntime } from '@/sync/runtime/nativeSshTunnels/runtime';
import type { NativeSshTunnelSnapshot } from '@/sync/runtime/nativeSshTunnels/types';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { router } from 'expo-router';

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
        return Boolean(host.ssh.passwordSecretRef);
    }
    if (host.ssh.authMode === 'keyfile') {
        return Boolean(host.ssh.identityPrivateKeySecretRef);
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
export type RemoteHostSaveReceipt = Readonly<{ ok: false }>
    | Readonly<{ ok: true; revision: number; host: RemoteHost; localOverrides: 'saved' | 'pending' | 'retired' }>;

export function useRemoteHostsCollectionController(gates: RemoteHostsGates) {
    const scope = useActiveServerAccountScope();
    const tunnelExecution = useMountedActionExecution(scope, { onApprovalPending: registration => {
        if (registration.scope) router.push(`/inbox/approvals/${encodeURIComponent(registration.artifactId)}?serverId=${encodeURIComponent(registration.scope.serverId)}`);
    } });
    const snapshot = useRemoteHostCatalogSnapshot(scope);
    const remoteHosts = snapshot?.data ?? [];
    const catalog = snapshot?.catalog;
    const catalogRevision = catalog?.status === 'ready' || catalog?.status === 'partial' ? catalog.revision : null;
    const catalogComplete = catalog?.status === 'ready' && snapshot?.stale === false;
    const canMutate = Boolean(scope && catalogComplete);
    const actionExecutor = React.useRef<Promise<ReturnType<typeof createDefaultActionExecutor>> | null>(null);
    const executeAction = React.useCallback(async <T extends RemoteHostActionIdV1,>(actionId: T,
        input: RemoteHostActionInputByIdV1[T], presentation?: Pick<UiActionExecutorContext, 'openRoute'>) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!scope || !lifetime || !areServerAccountScopesEqual(scope, lifetime.scope)) return null;
        actionExecutor.current ??= import('@/sync/ops/actions/defaultActionExecutor').then(owner => owner.createDefaultActionExecutor());
        const executor = await actionExecutor.current;
        if (!lifetime.isCurrent()) return null;
        const result = await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user',
            serverId: scope.serverId, expectedAccountId: scope.accountId, ...presentation });
        if (!result.ok) Modal.alert(t('common.error'), result.error);
        else if (result.result && typeof result.result === 'object' && 'status' in result.result
            && (result.result.status === 'unavailable' || result.result.status === 'conflict' || result.result.status === 'outcome_unknown')) {
            Modal.alert(t('common.error'), t('errors.operationFailed'));
        }
        return result;
    }, [scope]);
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
        scope,
        catalogRevision,
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
                    const result = await tunnelExecution.execute('remote_hosts.tunnel.stop', { target: { kind: 'native', leaseId } });
                    if (!result.ok) throw new Error(result.errorCode);
                    if (result.result && typeof result.result === 'object' && 'status' in result.result && result.result.status !== 'released') {
                        throw new Error('reason' in result.result ? String(result.result.reason) : String(result.result.status));
                    }
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
    }, [runner.mode, sshTunnelControl, tunnelExecution.execute]);

    const startManageHostAction = React.useCallback(async (
        remoteHost: RemoteHost,
        action: keyof typeof REMOTE_HOST_MAINTENANCE_ACTION_IDS,
        title: string,
    ) => {
        try {
            if (!canMutate || catalogRevision === null) return;
            const result = await executeAction(REMOTE_HOST_MAINTENANCE_ACTION_IDS[action],
                { hostId: remoteHost.id, expectedRevision: catalogRevision });
            if (result?.ok && result.result && typeof result.result === 'object'
                && 'status' in result.result && result.result.status === 'task_started'
                && 'taskId' in result.result && typeof result.result.taskId === 'string') {
                setActiveTaskId(result.result.taskId);
                setActiveTaskTitle(title);
                setActiveTaskAction(action);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error ?? '');
            Modal.alert(t('common.error'), message || t('settings.remoteHostsConnectionFailed'));
        }
    }, [canMutate, catalogRevision, executeAction]);


    const saveHost = React.useCallback(async (input: Readonly<{ remoteHost: RemoteHost;
        localOverrides: RemoteHostLocalOverrides | null; credentialChanges?: RemoteHostCredentialChanges;
        accountDirty?: boolean }>): Promise<RemoteHostSaveReceipt> => {
        if (!scope || !canMutate || catalogRevision === null) return { ok: false };
        try {
            return await withProfileAccount<RemoteHostSaveReceipt>(scope, undefined, async account => {
                if (input.accountDirty === false) {
                    // Only an acknowledged existing row can continue a device-local
                    // save. A new draft or withdrawn catalog still needs Account admission.
                    const current = await readRemoteHostCatalogInContext(account);
                    account.assertCurrent();
                    const host = current.status === 'ready' ? current.hosts.find(host => host.id === input.remoteHost.id) : undefined;
                    if (current.status !== 'ready'
                        || current.revision !== catalogRevision || typeof current.revision !== 'number'
                        || !host
                        || input.credentialChanges && Object.keys(input.credentialChanges).length > 0) return { ok: false };
                    try {
                        upsertRemoteHostLocalOverrides(input.remoteHost.id, input.localOverrides);
                        return { ok: true, revision: current.revision, host, localOverrides: 'saved' };
                    } catch (error) {
                        if (!account.accountLifetime.isCurrent()) return { ok: true, revision: current.revision, host, localOverrides: 'retired' };
                        Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.operationFailed'));
                        return { ok: true, revision: current.revision, host, localOverrides: 'pending' };
                    }
                }
                const prepared = await prepareRemoteHostSaveInContext(account, { host: input.remoteHost,
                    expectedRevision: catalogRevision, credentialChanges: input.credentialChanges });
                try {
                    account.assertCurrent();
                    const result = await executeAction('remote_hosts.save', prepared.input);
                    if (!result?.ok || !result.result || typeof result.result !== 'object'
                        || !('status' in result.result) || result.result.status !== 'updated'
                        || !('revision' in result.result) || typeof result.result.revision !== 'number') return { ok: false };
                    // A durable acknowledgement belongs to the original Account; local
                    // overrides and editor projection must not follow a retired Account.
                    const revision = result.result.revision;
                    const host = prepared.input.host;
                    try {
                        account.assertCurrent();
                        await invalidateRemoteHostCatalogProjection(scope);
                        account.assertCurrent();
                        upsertRemoteHostLocalOverrides(input.remoteHost.id, input.localOverrides);
                        return { ok: true, revision, host, localOverrides: 'saved' };
                    } catch (error) {
                        if (!account.accountLifetime.isCurrent()) return { ok: true, revision, host, localOverrides: 'retired' };
                        Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.operationFailed'));
                        return { ok: true, revision, host, localOverrides: 'pending' };
                    }
                } finally { prepared.dispose(); }
            });
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.operationFailed'));
            return { ok: false };
        }
    }, [scope, canMutate, catalogRevision, executeAction]);

    const deleteHost = React.useCallback(async (remoteHostId: string): Promise<boolean> => {
        if (!scope || !canMutate || catalogRevision === null) return false;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !areServerAccountScopesEqual(scope, lifetime.scope)) return false;
        const result = await executeAction('remote_hosts.delete', { hostId: remoteHostId, expectedRevision: catalogRevision });
        if (!result?.ok || !result.result || typeof result.result !== 'object'
            || !('status' in result.result) || result.result.status !== 'updated' || !lifetime.isCurrent()) return false;
        await invalidateRemoteHostCatalogProjection(scope);
        if (!lifetime.isCurrent()) return false;
        try { deleteRemoteHostLocalOverrides(remoteHostId); }
        catch (error) { Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.operationFailed')); }
        return true;
    }, [scope, canMutate, catalogRevision, executeAction]);

    const openHost = React.useCallback(async (hostId: string | null, openRoute: NonNullable<UiActionExecutorContext['openRoute']>) => {
        if (!canMutate) return null;
        if (hostId === null) return executeAction('remote_hosts.add', {}, { openRoute });
        if (!canMutate || catalogRevision === null) return null;
        return executeAction('remote_hosts.edit', { hostId, expectedRevision: catalogRevision }, { openRoute });
    }, [canMutate, catalogRevision, executeAction]);

    /** Every operation this device can run on a saved host, in the order the host's page offers them. */
    const buildHostActions = React.useCallback((host: RemoteHost): ItemAction[] => {
        if (!canMutate) return [];
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
                    void remoteHostOutcomeActions.configureRelayAccess(host);
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
        canMutate,
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
        scope,
        catalogRevision,
        catalogStatus: catalog?.status ?? 'loading',
        catalogComplete,
        canMutate,
        openHost,
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
