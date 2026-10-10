import * as React from 'react';
import { SshTunnelListResponseSchema, type SshTunnelSnapshot } from '@happier-dev/protocol/ssh/tunnels';
import type { SystemTaskResult } from '@happier-dev/protocol/system/tasks/spec';

import { getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import {
    buildSshTunnelListSystemTaskSpec,
} from '@/components/systemTasks/specs/localControl/buildSshTunnelSystemTaskSpec';
import { t } from '@/text';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostActionsV1';
import { router } from 'expo-router';

function readSshTunnelList(result: SystemTaskResult | null): readonly SshTunnelSnapshot[] | null {
    if (!result?.ok) {
        return null;
    }

    const parsed = SshTunnelListResponseSchema.safeParse(result.data);
    if (!parsed.success || !parsed.data.ok) {
        return null;
    }

    return parsed.data.tunnels;
}

function readErrorMessage(result: SystemTaskResult | null): string | null {
    if (!result || result.ok) {
        return null;
    }
    const message = typeof result.error?.message === 'string' ? result.error.message.trim() : '';
    return message || null;
}

export function useRemoteHostSshTunnelControl(options: Readonly<{
    runner?: SystemTaskRunner;
}> = {}) {
    const runner = options.runner ?? getDefaultSystemTaskRunner();
    const execution = useMountedActionExecution(useActiveServerAccountScope(), { onApprovalPending: registration => {
        if (registration.scope) router.push(`/inbox/approvals/${encodeURIComponent(registration.artifactId)}?serverId=${encodeURIComponent(registration.scope.serverId)}`);
    } });
    const [bridgeUnavailable, setBridgeUnavailable] = React.useState(false);
    const isUnavailable = runner.mode !== 'tauri' || bridgeUnavailable;
    const [listTaskId, setListTaskId] = React.useState<string | null>(null);
    const [stopTaskId, setStopTaskId] = React.useState<string | null>(null);
    const [tunnels, setTunnels] = React.useState<readonly SshTunnelSnapshot[]>([]);
    const [lastErrorMessage, setLastErrorMessage] = React.useState<string | null>(null);
    const autoRefreshRequestedRef = React.useRef(false);
    const handledStopTaskIdRef = React.useRef<string | null>(null);

    const listSnapshot = useSystemTaskSnapshot(runner, listTaskId);
    const stopSnapshot = useSystemTaskSnapshot(runner, stopTaskId);

    const refreshTunnels = React.useCallback(async () => {
        if (isUnavailable) {
            return null;
        }
        try {
            const taskId = await runner.start(buildSshTunnelListSystemTaskSpec());
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
            setListTaskId(taskId);
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

    const stopTunnel = React.useCallback(async (tunnelKey: string) => {
        if (isUnavailable) {
            return null;
        }
        try {
            const response = await execution.execute('remote_hosts.tunnel.stop', { target: { kind: 'desktop', tunnelKey } });
            if (!response.ok) throw new Error(response.errorCode);
            const result = REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1['remote_hosts.tunnel.stop'].parse(response.result);
            if (result.status !== 'task_started') throw new Error(result.status === 'unavailable' ? result.reason : result.status);
            if (!execution.isCurrent()) return null;
            const taskId = result.taskId;
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
            setStopTaskId(taskId);
            handledStopTaskIdRef.current = null;
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
    }, [isUnavailable, execution.execute, execution.isCurrent]);

    React.useEffect(() => {
        if (isUnavailable) {
            return;
        }
        if (autoRefreshRequestedRef.current) {
            return;
        }
        autoRefreshRequestedRef.current = true;
        void refreshTunnels().catch(() => {});
    }, [isUnavailable, refreshTunnels]);

    React.useEffect(() => {
        const nextTunnels = readSshTunnelList(listSnapshot?.result ?? null);
        if (nextTunnels) {
            setTunnels(nextTunnels);
            setLastErrorMessage(null);
            return;
        }

        const errorMessage = readErrorMessage(listSnapshot?.result ?? null);
        if (errorMessage) {
            setLastErrorMessage(errorMessage);
        }
    }, [listSnapshot]);

    React.useEffect(() => {
        if (!stopSnapshot?.result || handledStopTaskIdRef.current === stopSnapshot.taskId) {
            return;
        }

        handledStopTaskIdRef.current = stopSnapshot.taskId;
        if (!stopSnapshot.result.ok) {
            setLastErrorMessage(readErrorMessage(stopSnapshot.result));
            return;
        }

        void refreshTunnels().catch(() => {});
    }, [refreshTunnels, stopSnapshot]);

    const activeTaskSnapshot = React.useMemo<SystemTaskRunState | null>(() => {
        const snapshot = stopSnapshot?.result ? null : stopSnapshot ?? (listSnapshot?.result ? null : listSnapshot);
        return snapshot ?? null;
    }, [listSnapshot, stopSnapshot]);

    return {
        activeTaskSnapshot,
        isUnavailable,
        lastErrorMessage,
        refreshTunnels,
        stopTunnel,
        tunnels,
        approval: execution.approval,
    };
}
