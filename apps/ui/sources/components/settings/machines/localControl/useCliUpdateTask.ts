import * as React from 'react';
import type { SystemTaskSpec } from '@happier-dev/protocol';

import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { useSystemTaskSnapshot } from '@/components/systemTasks/useSystemTaskSnapshot';
import { awaitSystemTaskResult } from '@/components/systemTasks/awaitSystemTaskResult';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import { desktopSetupCoordinator, resolveThisComputerServiceForActiveRelay } from '@/setup/desktopSetupCoordinator';
import { cliAcquisitionFailureStatus } from '@/setup/setupStageModel';
import { t } from '@/text';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { buildUpdateItemId } from '@/updates/items/updateItem';
import { recordUpdateCompleted } from '@/updates/updateCompletions';

import { buildLocalDaemonServiceSystemTaskSpec } from './buildLocalDaemonServiceSystemTaskSpec';

/** A queued update retains the initiating account and task target before other items finish. */
export type CliUpdateStartContext = Readonly<{
    scope: ServerAccountScope;
    spec: SystemTaskSpec;
    machineId: string | null;
}>;

export type CliUpdateTask = Readonly<{
    /** Starts `cli.update.v1` and waits for its result. A second press while one runs does nothing. */
    start: (context?: CliUpdateStartContext) => Promise<void>;
    /** The run, for the existing task progress presentation. */
    snapshot: SystemTaskRunState | null;
    running: boolean;
    /** Why the update could not start or did not finish, in words the row can show. */
    errorMessage: string | null;
}>;

type CliUpdateActionState = Readonly<{
    taskId: string | null;
    running: boolean;
    startError: string | null;
}>;

type CliUpdateAction = Readonly<{
    getState: () => CliUpdateActionState;
    subscribe: (listener: () => void) => () => void;
    start: (context?: CliUpdateStartContext) => Promise<void>;
}>;

/**
 * S-10 — ONE action per runner, shared by every surface that offers "Update" for this computer's
 * command line (the Home setup panel, Settings › This computer, Settings › Updates). A module-level
 * owner rather than per-mount state: two surfaces used to hold two task ids and two `running`
 * guards, so each could start its own `cli.update.v1`. The run itself stays the system task's
 * (`useSystemTaskSnapshot`); this owns only which run is current and its start error. Mutation
 * exclusion across processes is the install owner's (lane D).
 */
const actionsByRunner = new WeakMap<SystemTaskRunner, CliUpdateAction>();

function isRunInFlight(runner: SystemTaskRunner, state: CliUpdateActionState): boolean {
    if (state.running) return true;
    if (!state.taskId) return false;
    const snapshot = runner.getSnapshot(state.taskId);
    return snapshot != null && snapshot.result == null;
}

function createCliUpdateAction(runner: SystemTaskRunner): CliUpdateAction {
    let state: CliUpdateActionState = { taskId: null, running: false, startError: null };
    const listeners = new Set<() => void>();
    const set = (next: CliUpdateActionState) => {
        state = next;
        for (const listener of listeners) listener();
    };

    return {
        getState: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        start: async (context) => {
            if (isRunInFlight(runner, state) || runner.mode === 'unavailable') {
                return;
            }
            // The initiating account owns completion even if every observing surface unmounts.
            const scope = context?.scope ?? getActiveServerAccountScope();
            const inspection = desktopSetupCoordinator.readInspectionSnapshot();
            const machineId = context ? context.machineId : resolveThisComputerServiceForActiveRelay(inspection)?.facts.auth.machineId ?? null;
            set({ ...state, running: true, startError: null });
            try {
                const taskId = await runner.start(context?.spec ?? buildLocalDaemonServiceSystemTaskSpec('cli.update.v1'));
                set({ taskId, running: true, startError: null });
                // The shared result waiter survives every presentation subscription. Update-all
                // awaits this promise, so admission cannot retire the batch while the CLI runs.
                const result = await awaitSystemTaskResult(runner, taskId);
                // A finished update, or another one already running on this computer (K5
                // `cli_update_in_progress`): either way the answer is what the CLI now reports.
                if (result.ok || isUpdateInProgressElsewhere(result.error)) {
                    await desktopSetupCoordinator.inspect({ fresh: true });
                }
                if (result.ok && scope) {
                    recordUpdateCompleted(scope, buildUpdateItemId(machineId ?? 'this-computer', { kind: 'happier-cli' }));
                }
            } catch (error) {
                set({
                    ...state,
                    running: false,
                    startError: isSystemTaskBridgeUnavailableError(error)
                        ? t('settings.systemTaskBridgeUnavailable')
                        : (readSystemTaskStartErrorMessage(error) ?? t('settings.systemTaskStartFailed')),
                });
            } finally {
                set({ ...state, running: false });
            }
        },
    };
}

function resolveCliUpdateAction(runner: SystemTaskRunner): CliUpdateAction {
    const existing = actionsByRunner.get(runner);
    if (existing) return existing;
    const created = createCliUpdateAction(runner);
    actionsByRunner.set(runner, created);
    return created;
}

/**
 * R17 — the one "Update" action for this computer's command line. The executor owns the update
 * (K2: acquisition owner, then a service restart); every caller observes the same shared run
 * (S-10), and `onSucceeded` fires once per caller for each run that finished while it watched.
 */
export function useCliUpdateTask(options: Readonly<{
    runner?: SystemTaskRunner;
    /** After the re-inspection has settled — e.g. the setup gate retrying the run the update unblocked. */
    onSucceeded?: () => void;
}> = {}): CliUpdateTask {
    const runner = options.runner ?? getSystemTasksRunner();
    const action = resolveCliUpdateAction(runner);
    const state = React.useSyncExternalStore(action.subscribe, action.getState, action.getState);
    const snapshot = useSystemTaskSnapshot(runner, state.taskId);
    const failure = snapshot?.result && !snapshot.result.ok ? snapshot.result.error : null;
    // Another update already running is in progress, not an error: it reads as running while
    // this computer is re-read, and the re-read facts say where it ended.
    const inProgressElsewhere = isUpdateInProgressElsewhere(failure);
    const refreshing = React.useSyncExternalStore(
        desktopSetupCoordinator.subscribe,
        () => desktopSetupCoordinator.readInspectionRefreshing(),
        () => desktopSetupCoordinator.readInspectionRefreshing(),
    );
    const running = state.running
        || (snapshot != null && snapshot.result == null)
        || (inProgressElsewhere && refreshing);

    const onSucceededRef = React.useRef(options.onSucceeded);
    onSucceededRef.current = options.onSucceeded;
    // A run that had already finished before this caller mounted is not "just succeeded" for it.
    const handledTaskIdRef = React.useRef<string | null>(snapshot?.result ? snapshot.taskId : null);
    React.useEffect(() => {
        if (running || !snapshot?.result?.ok || handledTaskIdRef.current === snapshot.taskId) {
            return;
        }
        handledTaskIdRef.current = snapshot.taskId;
        onSucceededRef.current?.();
    }, [running, snapshot]);

    return {
        start: action.start,
        snapshot,
        running,
        errorMessage: state.startError ?? (failure && !inProgressElsewhere ? describeCliUpdateFailure(failure) : null),
    };
}

/**
 * Why `cli.update.v1` did not finish, in the one sentence a row or the setup surface shows: the
 * CLI is not the app's to replace, the download/install step that stopped (the same sentences the
 * setup acquisition uses), or the new version installed while the service kept the old one.
 */
export function describeCliUpdateFailure(failure: Readonly<{ code: string }>): string {
    if (failure.code === 'cli_not_managed') return t('machine.thisComputer.cliNotManaged');
    // K5 (lane D): the transaction restored the previous version, or the new one never ran.
    if (failure.code === 'cli_update_rolled_back') return t('updates.row.rolledBackLocal');
    if (failure.code === 'cli_update_smoke_failed') return t('updates.row.smokeFailed');
    return cliAcquisitionFailureStatus(failure.code) ?? t('machine.thisComputer.cliUpdateFailed');
}

function isUpdateInProgressElsewhere(failure: Readonly<{ code: string }> | null | undefined): boolean {
    return failure?.code === 'cli_update_in_progress';
}
