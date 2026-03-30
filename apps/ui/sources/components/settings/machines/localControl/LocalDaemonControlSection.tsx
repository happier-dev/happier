import * as React from 'react';
import { View } from 'react-native';

import { SystemTaskProgressCard } from '@/components/systemTasks';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

import { useLocalDaemonControl } from './useLocalDaemonControl';

function resolveStatusSubtitle(
    status: ReturnType<typeof useLocalDaemonControl>['status'],
    activeRelayUrl: string | null,
): string {
    if (!status) {
        return t('machine.daemonStatus.unknown');
    }
    if (!status.serviceInstalled) {
        return activeRelayUrl
            ? t('server.relayDrift.bannerNotInstalledDescription', { activeRelayUrl })
            : t('machine.daemonStatus.stopped');
    }
    if (status.needsAuth) {
        return activeRelayUrl
            ? t('server.relayDrift.bannerNeedsAuthDescription', { activeRelayUrl })
            : t('machine.daemonStatus.stopped');
    }
    if (!status.daemonRunning) {
        return activeRelayUrl
            ? t('server.relayDrift.bannerNotRunningDescription', { activeRelayUrl })
            : t('machine.daemonStatus.stopped');
    }
    return t('machine.daemonStatus.likelyAlive');
}

export const LocalDaemonControlSection = React.memo(function LocalDaemonControlSection(props: Readonly<{
    runner?: SystemTaskRunner;
}>) {
    const {
        activeTaskSnapshot,
        activeTaskTitle,
        canRepair,
        canStart,
        cancel,
        lastErrorMessage,
        repairBackgroundService,
        startDaemonService,
        status,
        isBusy,
        isUnavailable,
        refreshStatus,
    } = useLocalDaemonControl({
        ...(props.runner ? { runner: props.runner } : {}),
    });
    const activeServerSnapshot = getActiveServerSnapshot();

    return (
        <>
            <ItemGroup title={t('machine.daemon')}>
                <Item
                    testID="settings.localDaemonControl.status"
                    title={t('machine.status')}
                    subtitle={isUnavailable ? t('settings.systemTaskBridgeUnavailable') : resolveStatusSubtitle(status, activeServerSnapshot.serverUrl)}
                    showChevron={false}
                    mode="info"
                />
                {status?.machineId ? (
                    <Item
                        testID="settings.localDaemonControl.machineId"
                        title={t('machine.machineId')}
                        subtitle={status.machineId}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                <Item
                    testID="settings.localDaemonControl.start"
                    title={t('sessionGettingStarted.title.startDaemon')}
                    onPress={() => {
                        void startDaemonService();
                    }}
                    disabled={!canStart}
                />
                <Item
                    testID="settings.localDaemonControl.repair"
                    title={t('server.relayDrift.repairAction')}
                    onPress={() => {
                        void repairBackgroundService();
                    }}
                    disabled={!canRepair}
                />
                <Item
                    title={t('common.refresh')}
                    onPress={() => {
                        void refreshStatus();
                    }}
                    disabled={isBusy || isUnavailable}
                />
                {lastErrorMessage ? (
                    <Item
                        title={t('common.error')}
                        subtitle={lastErrorMessage}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
            </ItemGroup>
            {activeTaskSnapshot ? (
                <SystemTaskProgressCard
                    title={activeTaskTitle ?? t('machine.daemon')}
                    snapshot={activeTaskSnapshot}
                    onCancel={cancel}
                />
            ) : null}
        </>
    );
});
