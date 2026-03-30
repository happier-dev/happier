import * as React from 'react';
import type { SystemTaskResult } from '@happier-dev/protocol';

import { getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import { t } from '@/text';
import { buildLocalRelayRuntimeSystemTaskSpec } from './buildLocalRelayRuntimeSystemTaskSpec';
import { decorateLocalControlSnapshot } from './decorateLocalControlSnapshot';

type RelayRuntimeStatusData = Readonly<{
    installed: boolean;
    version: string | null;
    relayUrl: string;
    healthy: boolean;
    service: Readonly<{
        active: boolean | null;
        enabled: boolean | null;
    }>;
}>;

type RelayRuntimeActionKind =
    | 'relay.runtime.installOrUpdate.v1'
    | 'relay.runtime.start.v1'
    | 'relay.runtime.stop.v1';

function readRelayRuntimeStatusData(result: SystemTaskResult | null): RelayRuntimeStatusData | null {
    if (!result?.ok) {
        return null;
    }

    const data = result.data as Record<string, unknown> | undefined;
    const relayUrl = typeof data?.relayUrl === 'string' ? data.relayUrl.trim() : '';
    const service = data?.service;
    if (!relayUrl || !service || typeof service !== 'object') {
        return null;
    }

    const serviceRecord = service as Record<string, unknown>;
    return {
        installed: data?.installed === true,
        version: typeof data?.version === 'string' ? data.version : null,
        relayUrl,
        healthy: data?.healthy === true,
        service: {
            active: typeof serviceRecord.active === 'boolean' ? serviceRecord.active : null,
            enabled: typeof serviceRecord.enabled === 'boolean' ? serviceRecord.enabled : null,
        },
    };
}

function readErrorMessage(result: SystemTaskResult | null): string | null {
    if (!result || result.ok) {
        return null;
    }
    const message = typeof result.error?.message === 'string' ? result.error.message.trim() : '';
    return message || null;
}

export function useLocalRelayRuntimeControl(options: Readonly<{
    runner?: SystemTaskRunner;
}> = {}) {
    const runner = options.runner ?? getDefaultSystemTaskRunner();
    const [bridgeUnavailable, setBridgeUnavailable] = React.useState(false);
    const isUnavailable = runner.mode === 'unavailable' || bridgeUnavailable;
    const [statusTaskId, setStatusTaskId] = React.useState<string | null>(null);
    const [actionTaskId, setActionTaskId] = React.useState<string | null>(null);
    const [lastStatus, setLastStatus] = React.useState<RelayRuntimeStatusData | null>(null);
    const [lastErrorMessage, setLastErrorMessage] = React.useState<string | null>(null);
    const autoRefreshRequestedRef = React.useRef(false);
    const handledActionTaskIdRef = React.useRef<string | null>(null);

    const statusSnapshot = useSystemTaskSnapshot(runner, statusTaskId);
    const actionSnapshot = useSystemTaskSnapshot(runner, actionTaskId);

    const startTask = React.useCallback(async (kind: RelayRuntimeActionKind | 'relay.runtime.status.v1') => {
        try {
            const taskId = await runner.start(buildLocalRelayRuntimeSystemTaskSpec(kind));
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
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
    }, [runner]);

    const refreshStatus = React.useCallback(async () => {
        if (isUnavailable) {
            return null;
        }
        const taskId = await startTask('relay.runtime.status.v1');
        if (!taskId) {
            return null;
        }
        setStatusTaskId(taskId);
        return taskId;
    }, [isUnavailable, startTask]);

    const runAction = React.useCallback(async (kind: RelayRuntimeActionKind) => {
        if (isUnavailable) {
            return null;
        }
        const taskId = await startTask(kind);
        if (!taskId) {
            return null;
        }
        handledActionTaskIdRef.current = null;
        setActionTaskId(taskId);
        return taskId;
    }, [isUnavailable, startTask]);

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
        const nextStatus = readRelayRuntimeStatusData(statusSnapshot?.result ?? null);
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
        if (!actionSnapshot?.result || handledActionTaskIdRef.current === actionSnapshot.taskId) {
            return;
        }

        handledActionTaskIdRef.current = actionSnapshot.taskId;
        if (!actionSnapshot.result.ok) {
            setLastErrorMessage(readErrorMessage(actionSnapshot.result));
            return;
        }

        const inlineStatus = readRelayRuntimeStatusData(actionSnapshot.result);
        if (inlineStatus) {
            setLastStatus(inlineStatus);
            setLastErrorMessage(null);
        }

        void refreshStatus().catch(() => {});
    }, [actionSnapshot, refreshStatus]);

    const activeTaskSnapshot = React.useMemo<SystemTaskRunState | null>(() => {
        const snapshot = actionSnapshot?.result ? null : actionSnapshot ?? (statusSnapshot?.result ? null : statusSnapshot);
        return snapshot ? decorateLocalControlSnapshot(snapshot) : null;
    }, [actionSnapshot, statusSnapshot]);

    const isBusy = activeTaskSnapshot != null && activeTaskSnapshot.result == null;

    return {
        activeTaskSnapshot,
        installOrUpdate: React.useCallback(async () => {
            await runAction('relay.runtime.installOrUpdate.v1');
        }, [runAction]),
        isBusy,
        isUnavailable,
        lastErrorMessage,
        refreshStatus,
        startRelay: React.useCallback(async () => {
            await runAction('relay.runtime.start.v1');
        }, [runAction]),
        status: lastStatus,
        stopRelay: React.useCallback(async () => {
            await runAction('relay.runtime.stop.v1');
        }, [runAction]),
    };
}
