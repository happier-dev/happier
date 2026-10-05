import type { SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol';

import { waitForSystemTaskResult } from '@/components/systemTasks/createSystemTaskRunner';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildLocalDaemonServiceSystemTaskSpec';
import { t } from '@/text';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { buildUpdateItemId } from '@/updates/items/updateItem';
import { recordUpdateCompleted } from '@/updates/updateCompletions';
import type { LocalDaemonStatusData } from './useLocalDaemonControl';
import { createThisComputerSetupPromptContinuation } from '@/components/systemTasks/useThisComputerSetupTask';
import type { SystemTaskAuthRequestApproval } from '@/components/systemTasks/approveSystemTaskAuthRequestPrompt';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';
import { readThisComputerSetupScope } from '@/components/systemTasks/thisComputerSetup/thisComputerSetupScope';

/**
 * S-10 — the state every surface describing this computer shares, per system-task runner: the
 * last status the CLI reported, and the ONE `cli.update.v1` run (Settings › This computer,
 * Settings › Updates and any other entry observe the same task id and the same in-flight guard,
 * so a second press anywhere starts nothing). Status reads still start where they always did
 * (each `useLocalDaemonControl` mount); their results land here so every mount agrees. Mutation
 * exclusion across processes stays the install owner's (`cli_update_in_progress`).
 */
export type LocalDaemonSharedState<TStatus> = Readonly<{
    status: TStatus | null;
    setup: Readonly<{
        taskId: string | null;
        rereading: boolean;
        errorMessage: string | null;
        scope: Readonly<{ serverId: string | null; serverUrl: string; accountId: string | null }> | null;
    }>;
    cliUpdate: Readonly<{
        taskId: string | null;
        starting: boolean;
        /** Why the last update could not start or did not finish, as one sentence; `null` otherwise. */
        errorMessage: string | null;
        /** The re-read after a finished update (or after another update already running) is in flight. */
        rereading: boolean;
    }>;
}>;

type Store<TStatus> = {
    state: LocalDaemonSharedState<TStatus>;
    listeners: Set<() => void>;
};

const storesByRunner = new WeakMap<SystemTaskRunner, Store<unknown>>();

function resolveStore<TStatus>(runner: SystemTaskRunner): Store<TStatus> {
    const existing = storesByRunner.get(runner);
    if (existing) return existing as Store<TStatus>;
    const created: Store<unknown> = {
        state: { status: null, setup: { taskId: null, rereading: false, errorMessage: null, scope: null },
            cliUpdate: { taskId: null, starting: false, errorMessage: null, rereading: false } },
        listeners: new Set(),
    };
    storesByRunner.set(runner, created);
    return created as Store<TStatus>;
}

function update<TStatus>(runner: SystemTaskRunner, next: (state: LocalDaemonSharedState<TStatus>) => LocalDaemonSharedState<TStatus>): void {
    const store = resolveStore<TStatus>(runner);
    const replaced = next(store.state);
    if (replaced === store.state) return;
    store.state = replaced;
    for (const listener of store.listeners) listener();
}

export function subscribeLocalDaemonSharedState(runner: SystemTaskRunner, listener: () => void): () => void {
    const store = resolveStore(runner);
    store.listeners.add(listener);
    return () => {
        store.listeners.delete(listener);
    };
}

export function readLocalDaemonSharedState<TStatus>(runner: SystemTaskRunner): LocalDaemonSharedState<TStatus> {
    return resolveStore<TStatus>(runner).state;
}

export function publishLocalDaemonStatus<TStatus>(runner: SystemTaskRunner, status: TStatus): void {
    update<TStatus>(runner, (state) => (state.status === status ? state : { ...state, status }));
}

/** Observe the runner's admitted setup; its outcome and scoped readback outlive Settings. */
export function adoptLocalComputerSetup<TStatus>(
    runner: SystemTaskRunner,
    taskId: string,
    spec: SystemTaskSpec,
    approval: SystemTaskAuthRequestApproval,
    parseStatus: (result: SystemTaskResult) => TStatus | null,
): void {
    if (readLocalDaemonSharedState(runner).setup.taskId === taskId) return;
    const params = spec.params;
    const scope = { serverId: approval.serverId ?? null, serverUrl: approval.expectedRelayUrl,
        accountId: params !== null && typeof params === 'object' && !Array.isArray(params)
            && 'activeAccountId' in params && typeof params.activeAccountId === 'string' ? params.activeAccountId : null };
    const statusScope = {
        relayUrl: params !== null && typeof params === 'object' && !Array.isArray(params)
            && 'activeRelayUrl' in params && typeof params.activeRelayUrl === 'string' ? params.activeRelayUrl : scope.serverUrl,
        serverIdentityId: params !== null && typeof params === 'object' && !Array.isArray(params)
            && 'activeServerIdentityId' in params && typeof params.activeServerIdentityId === 'string' ? params.activeServerIdentityId : null,
    };
    const setSetup = (patch: Partial<LocalDaemonSharedState<TStatus>['setup']>) =>
        update<TStatus>(runner, (state) => ({ ...state, setup: { ...state.setup, ...patch } }));
    setSetup({ taskId, rereading: false, errorMessage: null, scope });
    const setRun = (patch: Partial<LocalDaemonSharedState<TStatus>['setup']>) =>
        update<TStatus>(runner, (state) => state.setup.taskId === taskId
            ? { ...state, setup: { ...state.setup, ...patch } } : state);
    void (async () => {
        const result = await waitForSystemTaskResult(runner, taskId);
        if (!result.ok) {
            setRun({ errorMessage: resolveSystemTaskFailureMessage(result.error) ?? result.error.message });
            return;
        }
        setRun({ rereading: true });
        const statusTaskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec('daemon.service.status.v1', statusScope));
        const statusResult = await waitForSystemTaskResult(runner, statusTaskId);
        const status = parseStatus(statusResult);
        const activeScope = getActiveServerAccountScope();
        if (status && activeScope && areServerProfileIdentifiersEquivalent(activeScope.serverId, scope.serverId)
            && (scope.accountId === null || activeScope.accountId === scope.accountId)) publishLocalDaemonStatus(runner, status);
        if (!status) setRun({ errorMessage: statusResult.ok ? t('settings.systemTaskStartFailed') : statusResult.error.message });
    })().catch((error: unknown) => {
        setRun({ errorMessage: readSystemTaskStartErrorMessage(error) ?? t('settings.systemTaskStartFailed') });
    }).finally(() => {
        setRun({ rereading: false });
    });
}

/** Admission belongs to the runner, including Home/checklist starts and pending native launch. */
export async function startLocalComputerSetup<TStatus>(
    runner: SystemTaskRunner,
    spec: SystemTaskSpec,
    approval: SystemTaskAuthRequestApproval,
    parseStatus: (result: SystemTaskResult) => TStatus | null,
): Promise<string | null> {
    try {
        const taskId = await runner.start(spec, createThisComputerSetupPromptContinuation(approval, spec));
        adoptLocalComputerSetup(runner, taskId, runner.getTaskSpec?.(taskId) ?? spec, approval, parseStatus);
        return taskId;
    } catch (error) {
        const scope = readThisComputerSetupScope(spec);
        if (!runner.getActiveSetupTask()) update<TStatus>(runner, (state) => ({ ...state, setup: {
            taskId: null, rereading: false,
            scope: { serverId: approval.serverId ?? null, serverUrl: approval.expectedRelayUrl, accountId: scope?.expectedAccountId ?? null },
            errorMessage: isSystemTaskBridgeUnavailableError(error) ? t('settings.systemTaskBridgeUnavailable')
                : (readSystemTaskStartErrorMessage(error) ?? t('settings.systemTaskStartFailed')),
        } }));
        return null;
    }
}

/**
 * K5 — why `cli.update.v1` did not finish, in the one sentence a row shows. `cli_update_in_progress`
 * is not a failure (another update holds the install lock) and never reaches here.
 */
export function describeCliUpdateFailure(failure: Readonly<{ code?: string | null }>): string {
    switch (failure.code) {
        case 'cli_not_managed':
            return t('updates.row.cliNotManaged');
        case 'cli_update_rolled_back':
            return t('updates.row.rolledBackLocal');
        case 'cli_update_smoke_failed':
            return t('updates.row.smokeFailed');
        default:
            return t('updates.row.failedGeneric');
    }
}

function isRunInFlight(runner: SystemTaskRunner, cliUpdate: LocalDaemonSharedState<unknown>['cliUpdate']): boolean {
    if (cliUpdate.starting || cliUpdate.rereading) return true;
    if (!cliUpdate.taskId) return false;
    const snapshot = runner.getSnapshot(cliUpdate.taskId);
    return snapshot != null && snapshot.result == null;
}

export function isLocalCliUpdateRunning(runner: SystemTaskRunner): boolean {
    return isRunInFlight(runner, readLocalDaemonSharedState(runner).cliUpdate);
}

/**
 * Starts the one update of this computer's managed CLI. Success is re-read, never inferred from the
 * exit code: after the run (or when another update already held the lock) the status is read once
 * and published to every surface through `parseStatus`.
 */
export type CliUpdateStartContext = Readonly<{
    scope: ServerAccountScope;
    spec: SystemTaskSpec;
    machineId: string | null;
}>;

export async function startLocalCliUpdate<TStatus>(
    runner: SystemTaskRunner,
    parseStatus: (result: SystemTaskResult) => TStatus | null,
    context?: CliUpdateStartContext,
): Promise<void> {
    if (runner.mode === 'unavailable' || isLocalCliUpdateRunning(runner)) return;
    // Completion belongs to the initiating account, not whichever surface later observes it.
    const scope = context?.scope ?? getActiveServerAccountScope();
    const machineId = context ? context.machineId : readLocalDaemonSharedState<LocalDaemonStatusData>(runner).status?.machineId;
    const spec = context?.spec ?? buildLocalDaemonServiceSystemTaskSpec('cli.update.v1');
    const setCli = (patch: Partial<LocalDaemonSharedState<TStatus>['cliUpdate']>) =>
        update<TStatus>(runner, (state) => ({ ...state, cliUpdate: { ...state.cliUpdate, ...patch } }));

    setCli({ starting: true, errorMessage: null });
    let taskId: string;
    try {
        taskId = await runner.start(spec);
    } catch (error) {
        setCli({
            starting: false,
            errorMessage: isSystemTaskBridgeUnavailableError(error)
                ? t('settings.systemTaskBridgeUnavailable')
                : (readSystemTaskStartErrorMessage(error) ?? t('settings.systemTaskStartFailed')),
        });
        return;
    }
    setCli({ taskId, starting: false });

    const result = await waitForSystemTaskResult(runner, taskId).catch(() => null);
    const failureCode = result && !result.ok && typeof result.error?.code === 'string' ? result.error.code : null;
    const inProgressElsewhere = failureCode === 'cli_update_in_progress';
    if (result && !result.ok && !inProgressElsewhere) {
        setCli({ errorMessage: describeCliUpdateFailure({ code: failureCode }) });
        return;
    }
    if (!result) {
        setCli({ errorMessage: t('updates.row.failedGeneric') });
        return;
    }

    if (result.ok && scope) {
        recordUpdateCompleted(scope, buildUpdateItemId(machineId ?? 'this-computer', { kind: 'happier-cli' }));
    }
    setCli({ rereading: true });
    try {
        const statusTaskId = await runner.start({ ...spec, kind: 'daemon.service.status.v1' });
        const statusResult = await waitForSystemTaskResult(runner, statusTaskId);
        const status = parseStatus(statusResult);
        const activeScope = getActiveServerAccountScope();
        if (status && (!scope || (activeScope?.serverId === scope.serverId && activeScope.accountId === scope.accountId))) {
            publishLocalDaemonStatus(runner, status);
        }
    } catch (error) {
        console.warn('Failed to re-read this computer after a CLI update:', error);
    } finally {
        setCli({ rereading: false });
    }
}
