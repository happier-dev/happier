import * as React from 'react';
import type { SystemTaskResult } from '@happier-dev/protocol';

import { buildLocalMachineSetupSystemTaskSpec } from './buildLocalMachineSetupSystemTaskSpec';
import { getSystemTasksRunner } from './systemTasksRuntime';
import { useSystemTaskSnapshot } from './useSystemTaskSnapshot';
import type { SystemTaskRunState, SystemTaskRunner } from './types';

export type ThisComputerSetupFollowUp = 'auth' | 'approval' | null;

export function resolveThisComputerSetupFollowUp(result: SystemTaskResult | null): ThisComputerSetupFollowUp {
    if (!result || result.ok) {
        return null;
    }
    if (result.error.code === 'not_authenticated') {
        return 'auth';
    }
    if (result.error.code === 'machine_id_unavailable') {
        return 'approval';
    }
    return null;
}

export function useThisComputerSetupTask(options: Readonly<{
    runner?: SystemTaskRunner;
    autoStart?: boolean;
    onNeedsAuth?: () => void;
    onNeedsApproval?: () => void;
    onSucceeded?: (snapshot: SystemTaskRunState) => void;
}> = {}) {
    const runner = options.runner ?? getSystemTasksRunner();
    const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
    const [isStarting, setIsStarting] = React.useState(false);
    const [startError, setStartError] = React.useState<string | null>(null);
    const activeTaskSnapshot = useSystemTaskSnapshot(runner, activeTaskId);
    const autoStartAttemptedRef = React.useRef(false);
    const handledResultTaskIdRef = React.useRef<string | null>(null);

    const start = React.useCallback(async () => {
        setIsStarting(true);
        setStartError(null);
        try {
            const taskId = await runner.start(buildLocalMachineSetupSystemTaskSpec());
            handledResultTaskIdRef.current = null;
            setActiveTaskId(taskId);
            return taskId;
        } catch (error) {
            setStartError(error instanceof Error ? error.message : 'system_task_start_failed');
            throw error;
        } finally {
            setIsStarting(false);
        }
    }, [runner]);

    const cancel = React.useCallback(() => {
        if (!activeTaskId) {
            return;
        }
        void runner.cancel(activeTaskId);
    }, [activeTaskId, runner]);

    React.useEffect(() => {
        if (!options.autoStart || autoStartAttemptedRef.current || activeTaskId) {
            return;
        }
        autoStartAttemptedRef.current = true;
        void start().catch(() => {});
    }, [activeTaskId, options.autoStart, start]);

    React.useEffect(() => {
        if (!activeTaskSnapshot?.result) {
            return;
        }
        if (handledResultTaskIdRef.current === activeTaskSnapshot.taskId) {
            return;
        }

        handledResultTaskIdRef.current = activeTaskSnapshot.taskId;
        if (activeTaskSnapshot.result.ok) {
            options.onSucceeded?.(activeTaskSnapshot);
            return;
        }

        const followUp = resolveThisComputerSetupFollowUp(activeTaskSnapshot.result);
        if (followUp === 'auth') {
            options.onNeedsAuth?.();
            return;
        }
        if (followUp === 'approval') {
            options.onNeedsApproval?.();
        }
    }, [activeTaskSnapshot, options]);

    const completedMachineId = React.useMemo(() => {
        if (!activeTaskSnapshot?.result?.ok) {
            return null;
        }
        const machineId = (activeTaskSnapshot.result.data as { machineId?: unknown } | undefined)?.machineId;
        return typeof machineId === 'string' && machineId.trim().length > 0 ? machineId.trim() : null;
    }, [activeTaskSnapshot]);

    return {
        activeTaskId,
        activeTaskSnapshot,
        cancel,
        completedMachineId,
        isStarting,
        runner,
        start,
        startError,
    };
}
