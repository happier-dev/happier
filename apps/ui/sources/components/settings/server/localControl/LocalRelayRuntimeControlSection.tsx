import * as React from 'react';
import { View } from 'react-native';

import { getDefaultSystemTaskRunner, SystemTaskProgressCard } from '@/components/systemTasks';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { useLocalRelayRuntimeControl } from './useLocalRelayRuntimeControl';

function resolveStatusSubtitle(status: ReturnType<typeof useLocalRelayRuntimeControl>['status']): string {
    if (!status) {
        return t('settings.localRelayRuntime.statusChecking');
    }
    if (!status.installed) {
        return t('settings.localRelayRuntime.statusNotInstalled');
    }
    if (status.service.active !== true) {
        return t('settings.localRelayRuntime.statusStopped');
    }
    return status.healthy
        ? t('settings.localRelayRuntime.statusRunningHealthy')
        : t('settings.localRelayRuntime.statusRunningNeedsAttention');
}

export const LocalRelayRuntimeControlSection = React.memo(function LocalRelayRuntimeControlSection(props: Readonly<{
    runner?: SystemTaskRunner;
    onStatusChange?: (status: ReturnType<typeof useLocalRelayRuntimeControl>['status']) => void;
}>) {
    const {
        activeTaskSnapshot,
        installOrUpdate,
        isBusy,
        isUnavailable,
        lastErrorMessage,
        refreshStatus,
        startRelay,
        status,
        stopRelay,
    } = useLocalRelayRuntimeControl({
        ...(props.runner ? { runner: props.runner } : {}),
    });
    const runner = props.runner ?? getDefaultSystemTaskRunner();

    const canStart = !isUnavailable && status?.installed === true && status.service.active !== true && !isBusy;
    const canStop = !isUnavailable && status?.service.active === true && !isBusy;
    const cancel = React.useCallback(() => {
        if (!activeTaskSnapshot) {
            return;
        }
        void runner.cancel(activeTaskSnapshot.taskId);
    }, [activeTaskSnapshot, runner]);

    React.useEffect(() => {
        props.onStatusChange?.(status);
    }, [props.onStatusChange, status]);

    return (
        <>
            <ItemGroup
                title={t('settings.localRelayRuntime.title')}
                footer={t('settings.localRelayRuntime.footer')}
            >
                <Item
                    testID="settings.localRelayRuntime.status"
                    title={t('settings.localRelayRuntime.statusTitle')}
                    subtitle={isUnavailable ? t('settings.systemTaskBridgeUnavailable') : resolveStatusSubtitle(status)}
                    showChevron={false}
                    mode="info"
                />
                {status?.version ? (
                    <Item
                        title={t('settings.localRelayRuntime.versionTitle')}
                        subtitle={status.version}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                {status?.relayUrl ? (
                    <Item
                        testID="settings.localRelayRuntime.relayUrl"
                        title={t('settings.localRelayRuntime.relayUrlTitle')}
                        subtitle={status.relayUrl}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                <Item
                    testID="settings.localRelayRuntime.installOrUpdate"
                    title={t('settings.localRelayRuntime.installOrUpdateAction')}
                    onPress={() => {
                        void installOrUpdate();
                    }}
                    disabled={isBusy || isUnavailable}
                />
                <Item
                    testID="settings.localRelayRuntime.start"
                    title={t('settings.localRelayRuntime.startAction')}
                    onPress={() => {
                        void startRelay();
                    }}
                    disabled={!canStart}
                />
                <Item
                    testID="settings.localRelayRuntime.stop"
                    title={t('settings.localRelayRuntime.stopAction')}
                    onPress={() => {
                        void stopRelay();
                    }}
                    disabled={!canStop}
                />
                <Item
                    title={t('settings.localRelayRuntime.refreshAction')}
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
                    title={t('settings.localRelayRuntime.progressTitle')}
                    snapshot={activeTaskSnapshot}
                    onCancel={cancel}
                />
            ) : null}
        </>
    );
});
