import * as React from 'react';
import type { SystemTaskResult } from '@happier-dev/protocol';

import { getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

import { buildLocalDaemonServiceSystemTaskSpec } from './buildLocalDaemonServiceSystemTaskSpec';
import { buildRelayDriftRepairSystemTaskSpec } from '@/sync/domains/server/relayDrift/relayDriftSystemTask';
import { decorateLocalControlSnapshot } from '@/components/settings/server/localControl/decorateLocalControlSnapshot';
import { resolveWebappUrlFromServerUrl } from '@/sync/domains/server/url/resolveWebappUrlFromServerUrl';

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

function readErrorMessage(result: SystemTaskResult | null): string | null {
    if (!result || result.ok) {
        return null;
    }
    const message = typeof result.error?.message === 'string' ? result.error.message.trim() : '';
    return message || null;
}

export function useLocalDaemonControl(options: Readonly<{
    runner?: SystemTaskRunner;
}> = {}) {
    const runner = options.runner ?? getDefaultSystemTaskRunner();
    const activeServerSnapshot = getActiveServerSnapshot();
    const [bridgeUnavailable, setBridgeUnavailable] = React.useState(false);
    const isUnavailable = runner.mode === 'unavailable' || bridgeUnavailable;
    const [statusTaskId, setStatusTaskId] = React.useState<string | null>(null);
    const [startTaskId, setStartTaskId] = React.useState<string | null>(null);
    const [repairTaskId, setRepairTaskId] = React.useState<string | null>(null);
    const [lastStatus, setLastStatus] = React.useState<LocalDaemonStatusData | null>(null);
    const [lastErrorMessage, setLastErrorMessage] = React.useState<string | null>(null);
    const autoRefreshRequestedRef = React.useRef(false);
    const handledStartResultTaskIdRef = React.useRef<string | null>(null);
    const handledRepairResultTaskIdRef = React.useRef<string | null>(null);

    const statusSnapshot = useSystemTaskSnapshot(runner, statusTaskId);
    const startSnapshot = useSystemTaskSnapshot(runner, startTaskId);
    const repairSnapshot = useSystemTaskSnapshot(runner, repairTaskId);

    const refreshStatus = React.useCallback(async () => {
        if (isUnavailable) {
            return null;
        }
        try {
            const taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec('daemon.service.status.v1'));
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
            setStatusTaskId(taskId);
            return taskId;
        } catch (error) {
            const message = readSystemTaskStartErrorMessage(error);
            const unavailable = isSystemTaskBridgeUnavailableError(error);
            setBridgeUnavailable(unavailable);
            setLastErrorMessage(unavailable
                ? t('settings.systemTaskBridgeUnavailable')
                : (message ?? t('settings.systemTaskStartFailed')));
            return null;
        }
    }, [isUnavailable, runner]);

    const runAction = React.useCallback(async (kind: 'daemon.service.start.v1') => {
        if (isUnavailable) {
            return null;
        }
        try {
            const taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec(kind));
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
            setStartTaskId(taskId);
            handledStartResultTaskIdRef.current = null;
            return taskId;
        } catch (error) {
            const message = readSystemTaskStartErrorMessage(error);
            const unavailable = isSystemTaskBridgeUnavailableError(error);
            setBridgeUnavailable(unavailable);
            setLastErrorMessage(unavailable
                ? t('settings.systemTaskBridgeUnavailable')
                : (message ?? t('settings.systemTaskStartFailed')));
            return null;
        }
    }, [isUnavailable, runner]);

    const startDaemonService = React.useCallback(async () => {
        await runAction('daemon.service.start.v1');
    }, [runAction]);

    const repairBackgroundService = React.useCallback(async () => {
        if (isUnavailable || !activeServerSnapshot.serverUrl) {
            return null;
        }
        try {
            const taskId = await runner.start(buildRelayDriftRepairSystemTaskSpec({
                activeRelayUrl: activeServerSnapshot.serverUrl,
                activeWebappUrl: resolveWebappUrlFromServerUrl(activeServerSnapshot.serverUrl),
                activeLocalRelayUrl: activeServerSnapshot.activeLocalRelayUrl ?? null,
            }));
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
            setRepairTaskId(taskId);
            handledRepairResultTaskIdRef.current = null;
            return taskId;
        } catch (error) {
            const message = readSystemTaskStartErrorMessage(error);
            const unavailable = isSystemTaskBridgeUnavailableError(error);
            setBridgeUnavailable(unavailable);
            setLastErrorMessage(unavailable
                ? t('settings.systemTaskBridgeUnavailable')
                : (message ?? t('settings.systemTaskStartFailed')));
            return null;
        }
    }, [activeServerSnapshot.activeLocalRelayUrl, activeServerSnapshot.serverUrl, isUnavailable, runner]);

    React.useEffect(() => {
        if (isUnavailable) {
            return;
        }
        if (autoRefreshRequestedRef.current) {
            return;
        }
        autoRefreshRequestedRef.current = true;
        void refreshStatus().catch(() => {});
    }, [isUnavailable, refreshStatus]);

    React.useEffect(() => {
        const nextStatus = readLocalDaemonStatusData(statusSnapshot?.result ?? null);
        if (nextStatus) {
            setLastStatus(nextStatus);
            setLastErrorMessage(null);
            return;
        }

        const errorMessage = readErrorMessage(statusSnapshot?.result ?? null);
        if (errorMessage) {
            setLastErrorMessage(errorMessage);
        }
    }, [statusSnapshot]);

    React.useEffect(() => {
        if (!startSnapshot?.result || handledStartResultTaskIdRef.current === startSnapshot.taskId) {
            return;
        }

        handledStartResultTaskIdRef.current = startSnapshot.taskId;
        if (!startSnapshot.result.ok) {
            setLastErrorMessage(readErrorMessage(startSnapshot.result));
            return;
        }

        const inlineStatus = readLocalDaemonStatusData(startSnapshot.result);
        if (inlineStatus) {
            setLastStatus(inlineStatus);
            setLastErrorMessage(null);
        }

        void refreshStatus().catch(() => {});
    }, [refreshStatus, startSnapshot]);

    React.useEffect(() => {
        if (!repairSnapshot?.result || handledRepairResultTaskIdRef.current === repairSnapshot.taskId) {
            return;
        }

        handledRepairResultTaskIdRef.current = repairSnapshot.taskId;
        if (!repairSnapshot.result.ok) {
            setLastErrorMessage(readErrorMessage(repairSnapshot.result));
            return;
        }

        void refreshStatus().catch(() => {});
    }, [repairSnapshot, refreshStatus]);

    const activeTaskSnapshot = React.useMemo<SystemTaskRunState | null>(() => {
        const snapshot = repairSnapshot?.result ? null : repairSnapshot ?? (startSnapshot?.result ? null : startSnapshot);
        return snapshot ? decorateLocalControlSnapshot(snapshot) : null;
    }, [repairSnapshot, startSnapshot]);

    const activeTaskTitle = React.useMemo(() => {
        if (repairSnapshot && repairSnapshot.result == null) {
            return t('server.relayDrift.progressTitle');
        }
        if (startSnapshot && startSnapshot.result == null) {
            return t('machine.daemon');
        }
        return null;
    }, [repairSnapshot, startSnapshot]);

    const isBusy = activeTaskSnapshot != null && activeTaskSnapshot.result == null;
    const canStart = !isUnavailable && !isBusy && lastStatus?.serviceInstalled === true && lastStatus.daemonRunning !== true && lastStatus.needsAuth !== true;
    const canRepair = !isUnavailable && !isBusy && Boolean(activeServerSnapshot.serverUrl);

    return {
        activeTaskSnapshot,
        activeTaskTitle,
        canRepair,
        canStart,
        lastErrorMessage,
        refreshStatus,
        repairBackgroundService,
        startDaemonService,
        status: lastStatus,
        isBusy,
        isUnavailable,
        cancel: React.useCallback(() => {
            const activeTaskId = repairSnapshot && repairSnapshot.result == null
                ? repairTaskId
                : startSnapshot && startSnapshot.result == null
                    ? startTaskId
                    : null;
            if (!activeTaskId) {
                return;
            }
            void runner.cancel(activeTaskId);
        }, [repairSnapshot, repairTaskId, runner, startSnapshot, startTaskId]),
    };
}
