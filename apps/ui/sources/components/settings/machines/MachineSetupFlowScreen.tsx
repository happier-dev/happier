import * as React from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import type { SystemTaskResult } from '@happier-dev/protocol';

import { SystemTaskProgressCard, useSystemTaskSnapshot } from '@/components/systemTasks';
import { resolveThisComputerSetupFollowUp, useThisComputerSetupTask } from '@/components/systemTasks/useThisComputerSetupTask';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import { ProviderSetupFlow } from '@/components/settings/providers/setup/ProviderSetupFlow';
import { LocalRelayRuntimeControlSection } from '@/components/settings/server/localControl/LocalRelayRuntimeControlSection';
import { LocalTailscaleSecureAccessSection } from '@/components/settings/server/localControl/LocalTailscaleSecureAccessSection';
import { resolveKnownLocalRelayUrl } from '@/components/settings/server/localControl/resolveKnownLocalRelayUrl';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { getActiveServerSnapshot, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { isTauriDesktop } from '@/utils/platform/tauri';

import { DesktopOnlySetupNotice } from './DesktopOnlySetupNotice';
import { LocalDaemonControlSection } from './localControl/LocalDaemonControlSection';
import { buildLocalDaemonServiceSystemTaskSpec } from './localControl/buildLocalDaemonServiceSystemTaskSpec';
import { RemoteSshMachineSetupSection } from './RemoteSshMachineSetupSection';
import { upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';

type MachineSetupFlowScreenProps = Readonly<{
    autoStartLocalTask?: boolean;
    embedded?: boolean;
    initialProviderMachineId?: string | null;
    mode?: 'full' | 'localOnly' | 'remoteOnly';
    onLocalSetupSucceeded?: (machineId: string | null) => void;
    runner?: SystemTaskRunner;
}>;

function resolveLocalSetupStartErrorSubtitle(startError: string): string {
    if (!String(startError ?? '').trim()) {
        return t('settings.systemTaskStartFailed');
    }
    if (isSystemTaskBridgeUnavailableError(startError)) {
        return t('settings.systemTaskBridgeUnavailable');
    }
    return t('settings.systemTaskStartFailed');
}

type LocalDaemonStatusData = Readonly<{
    serviceInstalled: boolean;
    daemonRunning: boolean;
    needsAuth: boolean;
    machineId: string | null;
}>;

function readLocalDaemonStatusData(result: SystemTaskResult | null): LocalDaemonStatusData | null {
    if (!result?.ok) {
        return null;
    }

    const data = result.data as Record<string, unknown> | undefined;
    if (!data) {
        return null;
    }

    return {
        serviceInstalled: data.serviceInstalled === true,
        daemonRunning: data.daemonRunning === true,
        needsAuth: data.needsAuth === true,
        machineId: typeof data.machineId === 'string' && data.machineId.trim().length > 0 ? data.machineId.trim() : null,
    };
}

export const MachineSetupFlowScreen = React.memo(function MachineSetupFlowScreen(props: MachineSetupFlowScreenProps) {
    const isRemoteOnly = props.mode === 'remoteOnly';
    const isBrowserWeb = Platform.OS === 'web' && !isTauriDesktop();
    const supportsDesktopControls = props.runner != null || isTauriDesktop();

    if (isBrowserWeb || !supportsDesktopControls) {
        const notice = (
            <DesktopOnlySetupNotice
                testID="settings.machineSetup.desktopOnlyNotice"
                groupTitle={isRemoteOnly ? t('settings.machineSetupSshMachineTitle') : t('settings.addMachine')}
                title={t('setupOnboarding.webDesktopOnlyTitle')}
                subtitle={t('setupOnboarding.webDesktopOnlyBody')}
            />
        );
        return props.embedded ? notice : <ItemList>{notice}</ItemList>;
    }

    return <DesktopMachineSetupFlowScreen {...props} />;
});

const DesktopMachineSetupFlowScreen = React.memo(function DesktopMachineSetupFlowScreen(props: MachineSetupFlowScreenProps) {
    const { theme } = useUnistyles();
    const isBrowserWeb = Platform.OS === 'web' && !isTauriDesktop() && props.runner == null;
    const isRemoteOnly = props.mode === 'remoteOnly';
    const isLocalOnly = props.mode === 'localOnly';
    const [showRemoteSetupState, setShowRemoteSetupState] = React.useState(false);
    const [localRelayUrl, setLocalRelayUrl] = React.useState<string | null>(null);
    const [remoteCompletedMachine, setRemoteCompletedMachine] = React.useState<Readonly<{
        machineId: string | null;
        serverId: string | null;
        relayRuntimeUrl: string | null;
    }> | null>(null);
    const showRemoteSetup = isRemoteOnly ? true : (isLocalOnly ? false : showRemoteSetupState);
    const {
        activeTaskSnapshot,
        cancel,
        completedMachineId,
        runner,
        start,
        startError,
    } = useThisComputerSetupTask({
        autoStart: !isBrowserWeb && !isRemoteOnly && props.autoStartLocalTask,
        onSucceeded: (snapshot) => {
            const machineId = (snapshot.result?.ok
                ? (snapshot.result.data as { machineId?: unknown } | undefined)?.machineId
                : null);
            props.onLocalSetupSucceeded?.(typeof machineId === 'string' && machineId.trim().length > 0 ? machineId.trim() : null);
        },
        ...(props.runner ? { runner: props.runner } : {}),
    });
    const [adoptTaskId, setAdoptTaskId] = React.useState<string | null>(null);
    const adoptTaskSnapshot = useSystemTaskSnapshot(runner, adoptTaskId);
    const [adoptedMachineId, setAdoptedMachineId] = React.useState<string | null>(null);
    const handledAdoptResultTaskIdRef = React.useRef<string | null>(null);

    const localSetupFollowUp = React.useMemo(() => {
        return resolveThisComputerSetupFollowUp(activeTaskSnapshot?.result ?? null);
    }, [activeTaskSnapshot?.result]);

    const localSetupSnapshotForCard = React.useMemo(() => {
        if (!activeTaskSnapshot) {
            return null;
        }
        if (!localSetupFollowUp) {
            return activeTaskSnapshot;
        }
        return {
            ...activeTaskSnapshot,
            awaitingInput: true,
            status: 'running' as const,
            latestMessage: localSetupFollowUp === 'auth'
                ? t('server.relayDrift.progressStepAuthenticate')
                : activeTaskSnapshot.latestMessage,
        };
    }, [activeTaskSnapshot, localSetupFollowUp]);

    const handleStartLocalTask = React.useCallback(async () => {
        try {
            await start();
        } catch {
            // startError state is rendered below
        }
    }, [start]);
    const activeServerSnapshot = getActiveServerSnapshot();
    const knownLocalRelayUrl = React.useMemo(() => resolveKnownLocalRelayUrl({
        activeServerUrl: activeServerSnapshot.serverUrl,
        activeLocalRelayUrl: activeServerSnapshot.activeLocalRelayUrl,
    }), [activeServerSnapshot.activeLocalRelayUrl, activeServerSnapshot.serverUrl]);
    const handleLocalRelayStatusChange = React.useCallback((status: Readonly<{ relayUrl: string }> | null | undefined) => {
        const nextRelayUrl = typeof status?.relayUrl === 'string' && status.relayUrl.trim().length > 0
            ? status.relayUrl.trim()
            : null;
        setLocalRelayUrl((current) => current === nextRelayUrl ? current : nextRelayUrl);
    }, []);
    const remoteRelayRuntimeUrl = remoteCompletedMachine?.relayRuntimeUrl ?? null;
    const providerMachineId = remoteCompletedMachine?.machineId ?? completedMachineId ?? adoptedMachineId ?? props.initialProviderMachineId ?? null;
    const providerServerId = remoteCompletedMachine?.machineId
        ? remoteCompletedMachine.serverId ?? undefined
        : undefined;
    const copyRemoteRelayUrl = React.useCallback(() => {
        if (!remoteRelayRuntimeUrl) {
            return;
        }
        void setClipboardStringSafe(remoteRelayRuntimeUrl).then((copied) => {
            if (copied) {
                Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: t('settings.machineSetupRemoteRelayRuntimeUrlTitle') }));
                return;
            }
            Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
        });
    }, [remoteRelayRuntimeUrl]);
    const saveRemoteRelayUrl = React.useCallback(() => {
        if (!remoteRelayRuntimeUrl) {
            return;
        }
        try {
            upsertServerProfile({ serverUrl: remoteRelayRuntimeUrl, source: 'url' });
        } catch {
            // ignore: invalid url or storage failure should not block setup completion
        }
    }, [remoteRelayRuntimeUrl]);
    const desktopOnlyNoticeTitle = isRemoteOnly
        ? t('settings.machineSetupSshMachineTitle')
        : isLocalOnly
            ? t('settings.machineSetupCurrentMachineTitle')
            : t('settings.addMachine');

    if (isBrowserWeb) {
        const notice = (
            <DesktopOnlySetupNotice
                testID="settings.machineSetup.desktopOnlyNotice"
                groupTitle={desktopOnlyNoticeTitle}
                title={t('setupOnboarding.webDesktopOnlyTitle')}
                subtitle={t('setupOnboarding.webDesktopOnlyBody')}
            />
        );
        return props.embedded ? notice : <ItemList>{notice}</ItemList>;
    }

    const handleAuthenticateLocalSetup = React.useCallback(() => {
        const relayUrl = typeof activeServerSnapshot.serverUrl === 'string'
            ? activeServerSnapshot.serverUrl.trim()
            : '';
        if (!relayUrl) {
            Modal.alert(t('common.error'), t('server.failedToConnectToServer'));
            return;
        }
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl,
        });
        router.push(`/server?url=${encodeURIComponent(relayUrl)}&auto=1`);
    }, [activeServerSnapshot.serverUrl]);

    const handleApprovePairingLocalSetup = React.useCallback(() => {
        router.push('/inbox');
    }, []);

    React.useEffect(() => {
        if (!adoptTaskSnapshot?.result || handledAdoptResultTaskIdRef.current === adoptTaskSnapshot.taskId) {
            return;
        }

        handledAdoptResultTaskIdRef.current = adoptTaskSnapshot.taskId;
        const status = readLocalDaemonStatusData(adoptTaskSnapshot.result);
        if (!status) {
            return;
        }

        if (!status.serviceInstalled || !status.daemonRunning || status.needsAuth || !status.machineId) {
            Modal.alert(t('common.error'), t('settings.machineSetupAdoptExistingNotReady'));
            return;
        }

        setAdoptedMachineId(status.machineId);
        props.onLocalSetupSucceeded?.(status.machineId);
    }, [adoptTaskSnapshot, props]);

    const handleAdoptExistingInstallation = React.useCallback(async () => {
        try {
            const taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec('daemon.service.status.v1'));
            setAdoptTaskId(taskId);
        } catch (error) {
            const message = readSystemTaskStartErrorMessage(error);
            Modal.alert(t('common.error'), message ?? t('settings.systemTaskStartFailed'));
        }
    }, [runner]);

    const handleSwitchToRemoteRelay = React.useCallback(async () => {
        if (!remoteRelayRuntimeUrl) {
            return;
        }

        const confirmed = await Modal.confirm(
            t('settings.machineSetupRemoteRelaySwitchConfirmTitle'),
            t('settings.machineSetupRemoteRelaySwitchConfirmBody', { relayUrl: remoteRelayRuntimeUrl }),
            {
                confirmText: t('common.continue'),
                cancelText: t('common.cancel'),
            },
        );
        if (!confirmed) {
            return;
        }

        try {
            await upsertActivateAndSwitchServer({
                serverUrl: remoteRelayRuntimeUrl,
                source: 'url',
                scope: 'device',
            });
        } catch (error) {
            const message = error instanceof Error ? error.message.trim() : '';
            Modal.alert(t('common.error'), message || t('server.failedToConnectToServer'));
            return;
        }

        setPendingSetupIntent({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: remoteRelayRuntimeUrl,
            machineId: remoteCompletedMachine?.machineId ?? null,
        });
        router.push(`/server?url=${encodeURIComponent(remoteRelayRuntimeUrl)}&auto=1`);
    }, [remoteCompletedMachine?.machineId, remoteRelayRuntimeUrl]);

    const content = (
        <>
            {(isRemoteOnly || isLocalOnly) ? null : (
                <ItemGroup title={t('settings.addMachine')}>
                    <Item
                        testID="settings.machineSetup.startLocalTask"
                        title={t('settings.machineSetupCurrentMachineTitle')}
                        subtitle={t('settings.machineSetupCurrentMachineSubtitle')}
                        icon={<Ionicons name="laptop-outline" size={29} color={theme.colors.accent.blue} />}
                        onPress={() => {
                            void handleStartLocalTask();
                        }}
                    />
                    <Item
                        testID="settings.machineSetup.adoptExisting"
                        title={t('settings.machineSetupAdoptExistingTitle')}
                        subtitle={t('settings.machineSetupAdoptExistingSubtitle')}
                        icon={<Ionicons name="checkmark-done-outline" size={29} color={theme.colors.accent.indigo} />}
                        onPress={() => {
                            void handleAdoptExistingInstallation();
                        }}
                    />
                    <Item
                        testID="settings.machineSetup.startRemoteTask"
                        title={t('settings.machineSetupSshMachineTitle')}
                        subtitle={t('settings.machineSetupSshMachineSubtitle')}
                        icon={<Ionicons name="server-outline" size={29} color={theme.colors.accent.orange} />}
                        onPress={() => {
                            setShowRemoteSetupState((current) => !current);
                        }}
                    />
                </ItemGroup>
            )}

            <ItemGroup title={t('settings.machineSetupStagesTitle')}>
                <Item
                    title={t('settings.machineSetupStageConnect')}
                    icon={<Ionicons name="link-outline" size={29} color={theme.colors.accent.blue} />}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    title={t('settings.machineSetupStageInstall')}
                    icon={<Ionicons name="download-outline" size={29} color={theme.colors.accent.orange} />}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    title={t('settings.machineSetupStageFinish')}
                    icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.accent.indigo} />}
                    showChevron={false}
                    mode="info"
                />
            </ItemGroup>

            {!isBrowserWeb && !isRemoteOnly && activeTaskSnapshot ? (
                <SystemTaskProgressCard
                    title={t('settings.machineSetupCurrentMachineTitle')}
                    snapshot={localSetupSnapshotForCard ?? activeTaskSnapshot}
                    onCancel={activeTaskSnapshot.result ? undefined : cancel}
                />
            ) : null}

            {!isBrowserWeb && !isRemoteOnly && adoptTaskSnapshot ? (
                <SystemTaskProgressCard
                    title={t('settings.machineSetupAdoptExistingProgressTitle')}
                    snapshot={adoptTaskSnapshot}
                    onCancel={adoptTaskSnapshot.result ? undefined : () => {
                        if (!adoptTaskSnapshot.taskId) {
                            return;
                        }
                        void runner.cancel(adoptTaskSnapshot.taskId);
                    }}
                />
            ) : null}

            {!isBrowserWeb && !isRemoteOnly && localSetupFollowUp ? (
                <ItemGroup title={t('common.next')}>
                    {localSetupFollowUp === 'auth' ? (
                        <Item
                            testID="settings.machineSetup.localSetupFollowUp.authenticate"
                            title={t('common.authenticate')}
                            subtitle={t('server.relayDrift.bannerNeedsAuthDescription', { activeRelayUrl: activeServerSnapshot.serverUrl })}
                            onPress={handleAuthenticateLocalSetup}
                        />
                    ) : (
                        <Item
                            testID="settings.machineSetup.localSetupFollowUp.approvePairing"
                            title={t('settings.machineSetupRemotePromptApproveAction')}
                            subtitle={t('inbox.approvals')}
                            onPress={handleApprovePairingLocalSetup}
                        />
                    )}
                </ItemGroup>
            ) : null}

            {!isBrowserWeb && !isRemoteOnly && startError ? (
                <ItemGroup title={t('common.error')}>
                    <Item
                        testID="settings.machineSetup.startError"
                        title={t('common.error')}
                        subtitle={resolveLocalSetupStartErrorSubtitle(startError)}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>
            ) : null}

            <RemoteSshMachineSetupSection
                runner={props.runner}
                expanded={showRemoteSetup}
                onCompletedChange={setRemoteCompletedMachine}
            />

            {remoteRelayRuntimeUrl ? (
                <ItemGroup title={t('settings.machineSetupRemoteRelayRuntimeReadyTitle')}>
                    <Item
                        testID="settings.machineSetup.remoteRelayRuntimeUrl"
                        title={t('settings.machineSetupRemoteRelayRuntimeUrlTitle')}
                        subtitle={remoteRelayRuntimeUrl}
                        showChevron={false}
                        mode="info"
                    />
                    <Item
                        testID="settings.machineSetup.copyRemoteRelayUrl"
                        title={t('common.copy')}
                        onPress={copyRemoteRelayUrl}
                    />
                    <Item
                        testID="settings.machineSetup.remoteRelayKeepCurrent"
                        title={t('settings.machineSetupRemoteRelayKeepCurrentTitle')}
                        subtitle={t('settings.machineSetupRemoteRelayKeepCurrentSubtitle')}
                        onPress={saveRemoteRelayUrl}
                    />
                    <Item
                        testID="settings.machineSetup.remoteRelaySwitch"
                        title={t('settings.machineSetupRemoteRelaySwitchTitle')}
                        subtitle={t('settings.machineSetupRemoteRelaySwitchSubtitle')}
                        onPress={handleSwitchToRemoteRelay}
                    />
                </ItemGroup>
            ) : null}

            {!isBrowserWeb && !isRemoteOnly ? (
                <>
                    <LocalDaemonControlSection runner={props.runner} />
                    <LocalRelayRuntimeControlSection
                        runner={props.runner}
                        onStatusChange={handleLocalRelayStatusChange}
                    />
                    <LocalTailscaleSecureAccessSection
                        runner={props.runner}
                        upstreamUrl={localRelayUrl ?? knownLocalRelayUrl}
                    />
                </>
            ) : null}

            {providerMachineId ? (
                <ProviderSetupFlow
                    machineId={providerMachineId}
                    serverId={providerServerId}
                />
            ) : null}
        </>
    );

    return props.embedded ? content : <ItemList>{content}</ItemList>;
});
