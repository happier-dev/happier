import * as React from 'react';
import type { SystemTaskResult } from '@happier-dev/protocol';

import { readTokenOnlyAuthRequestPrompt, respondToTokenOnlyAuthRequestPrompt, type SystemTaskAuthRequestApproval } from './approveSystemTaskAuthRequestPrompt';
import { presentUnmanagedCliConsent } from './presentUnmanagedCliConsent';
import { getSystemTasksRunner } from './systemTasksRuntime';
import { readSystemTaskStartErrorMessage } from './systemTaskStartError';
import { answerThisComputerSetupPrompt } from './thisComputerSetup/answerThisComputerSetupPrompt';
import { matchesThisComputerSetupScope } from './thisComputerSetup/thisComputerSetupScope';
import { useSystemTaskSnapshot } from './useSystemTaskSnapshot';
import type { SystemTaskPromptContinuation, SystemTaskRunState, SystemTaskRunner } from './types';
import type { SystemTaskSpec } from '@happier-dev/protocol';
import { adoptLocalComputerSetup, readLocalDaemonSharedState, subscribeLocalDaemonSharedState } from '@/components/settings/machines/localControl/localDaemonSharedState';
import { readLocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';

export type ThisComputerSetupFollowUp = 'auth' | null;

export function resolveThisComputerSetupFollowUp(result: SystemTaskResult | null): ThisComputerSetupFollowUp {
    if (!result || result.ok) {
        return null;
    }
    if (result.error.code === 'not_authenticated') {
        return 'auth';
    }
    return null;
}

/** Captures the initiating Home; navigation never retargets a pending pairing request. */
export function createThisComputerSetupPromptContinuation(
    approval?: SystemTaskAuthRequestApproval,
    spec?: SystemTaskSpec,
): SystemTaskPromptContinuation {
    const params = spec?.params;
    const expectedAccountId = params !== null && typeof params === 'object' && !Array.isArray(params)
        && 'activeAccountId' in params && typeof params.activeAccountId === 'string'
        ? params.activeAccountId.trim() : approval?.expectedAccountId;
    const scopedApproval = approval ? { ...approval, ...(expectedAccountId ? { expectedAccountId } : {}) } : undefined;
    return async (prompt) => {
        const authPrompt = readTokenOnlyAuthRequestPrompt({ type: 'prompt', data: prompt.data });
        if (authPrompt) {
            if (!scopedApproval) return undefined;
            let answer: unknown;
            await respondToTokenOnlyAuthRequestPrompt({ prompt: authPrompt, approval: scopedApproval,
                confirmUnmanagedCli: presentUnmanagedCliConsent, respond: (next) => { answer = next; },
            });
            return answer;
        }
        return await answerThisComputerSetupPrompt(prompt);
    };
}

export function useThisComputerSetupTask(options: Readonly<{
    runner?: SystemTaskRunner;
    /** A presenter-owned handle; otherwise adopt this runner's continued setup for the explicit Home. */
    taskId?: string | null;
    /** A cancellation-on-leave owner refuses a borrowed run; other surfaces adopt by default. */
    adoptExisting?: boolean;
    onTaskIdChange?: (taskId: string | null) => void;
    onNeedsAuth?: () => void;
    onSucceeded?: (snapshot: SystemTaskRunState) => void;
    /** When set, blocking token-only pairing prompts are answered through the explicit endpoint. */
    authRequestApproval?: SystemTaskAuthRequestApproval;
}> = {}) {
    const runner = options.runner ?? getSystemTasksRunner();
    const retainedSetup = React.useSyncExternalStore(runner.subscribeActiveSetupTask, runner.getActiveSetupTask, () => null);
    const subscribeOutcome = React.useCallback((listener: () => void) => subscribeLocalDaemonSharedState(runner, listener), [runner]);
    const readOutcome = React.useCallback(() => readLocalDaemonSharedState(runner).setup, [runner]);
    const retainedOutcome = React.useSyncExternalStore(subscribeOutcome, readOutcome, readOutcome);
    const [localTaskId, setLocalTaskId] = React.useState<string | null>(() => {
        const approval = options.authRequestApproval;
        if (!approval || options.taskId !== undefined) return null;
        const retained = runner.getActiveSetupTask();
        return retained && matchesThisComputerSetupScope(retained.spec, approval) ? retained.taskId : null;
    });
    const approval = options.authRequestApproval;
    const scopedRetainedSetup = retainedSetup && approval && matchesThisComputerSetupScope(retainedSetup.spec, approval) ? retainedSetup : null;
    const retainedOutcomeTaskId = options.adoptExisting !== false && approval && retainedOutcome.taskId
        && matchesThisComputerSetupScope(runner.getTaskSpec?.(retainedOutcome.taskId) ?? null, approval)
        ? retainedOutcome.taskId : null;
    const activeTaskId = options.taskId === undefined
        ? scopedRetainedSetup?.taskId ?? retainedOutcomeTaskId ?? (localTaskId && approval && !matchesThisComputerSetupScope(runner.getTaskSpec?.(localTaskId) ?? null, approval) ? null : localTaskId)
        : options.taskId;
    React.useEffect(() => {
        if (options.taskId !== undefined || !approval) return;
        setLocalTaskId((current) => scopedRetainedSetup?.taskId
            ?? (current && matchesThisComputerSetupScope(runner.getTaskSpec?.(current) ?? null, approval) ? current : null));
    }, [runner, options.taskId, scopedRetainedSetup, approval?.expectedRelayUrl, approval?.serverId, approval?.expectedAccountId]);
    const setActiveTaskId = React.useCallback((taskId: string | null) => {
        setLocalTaskId(taskId);
        options.onTaskIdChange?.(taskId);
    }, [options.onTaskIdChange]);
    const [isStarting, setIsStarting] = React.useState(false);
    const [startError, setStartError] = React.useState<string | null>(null);
    const activeTaskSnapshot = useSystemTaskSnapshot(runner, activeTaskId);
    const handledResultTaskIdRef = React.useRef<string | null>(null);

    const start = React.useCallback(async (spec: SystemTaskSpec) => {
        setIsStarting(true);
        setStartError(null);
        try {
            const taskId = await runner.start(spec, createThisComputerSetupPromptContinuation(options.authRequestApproval, spec), {
                adoptExisting: options.adoptExisting,
            });
            if (options.authRequestApproval && options.adoptExisting !== false) {
                adoptLocalComputerSetup(runner, taskId, runner.getTaskSpec?.(taskId) ?? spec,
                    options.authRequestApproval, readLocalDaemonStatusData);
            }
            handledResultTaskIdRef.current = null;
            setActiveTaskId(taskId);
            return taskId;
        } catch (error) {
            setStartError(readSystemTaskStartErrorMessage(error) ?? 'system_task_start_failed');
            throw error;
        } finally {
            setIsStarting(false);
        }
    }, [runner, setActiveTaskId, options.authRequestApproval, options.adoptExisting]);

    const cancel = React.useCallback(() => {
        if (!activeTaskId) {
            return;
        }
        void runner.cancel(activeTaskId);
    }, [activeTaskId, runner]);


    React.useEffect(() => {
        if (!activeTaskId || !runner.registerPromptContinuation
            || runner.listPromptContinuations?.().some((entry) => entry.taskId === activeTaskId)) return;
        runner.registerPromptContinuation(activeTaskId, createThisComputerSetupPromptContinuation(
            options.authRequestApproval, runner.getTaskSpec?.(activeTaskId) ?? undefined,
        ));
    }, [activeTaskId, runner, options.authRequestApproval]);

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
        isStarting: isStarting || scopedRetainedSetup?.taskId === null,
        runner,
        start,
        startError,
    };
}
