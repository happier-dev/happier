import { t } from '@/text';
import { storage } from '@/sync/domains/state/storageStore';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { createAwaitedMachineArrivalBaseline } from '@/components/onboarding/detection/useAwaitedMachineArrival';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import type { MachineAddPathId } from './machineAddPaths';
import { readMachineAddFlowDraft, updateMachineAddFlowDraft, type MachineAddTaskHandle } from './machineAddFlowStore';

export function hasRunningMachineAddTask(): boolean {
    const draft = readMachineAddFlowDraft();
    return [draft.thisComputerTask, draft.sshTask].some((handle) => Boolean(handle &&
        (handle.starting || (handle.taskId && !handle.runner.getSnapshot(handle.taskId)?.result))));
}

export function beginMachineAddWatch(serverId: string, path: MachineAddPathId): void {
    const profile = getServerProfileById(serverId);
    const state = storage.getState();
    const machines = state.machineListByServerId[serverId];
    const presence = state.machinePresenceByServerId[resolveServerProfileScopeIdForIdentifier(serverId)];
    const baseline = profile && Array.isArray(machines) ? createAwaitedMachineArrivalBaseline(profile.serverUrl, machines, serverId, presence) : null;
    updateMachineAddFlowDraft((draft) => draft.startedAtMs !== null ? draft : { ...draft, serverId, path, baseline, startedAtMs: Date.now() });
}

/** Consuming an arrival ends its watch without canceling setup that may still be finishing. */
export function completeMachineAddWatch(): void {
    updateMachineAddFlowDraft(draft => ({ ...draft, startedAtMs: null, baseline: null }));
}

/** The retained start promise is the one task-lifetime authority, independent of its presenter. */
export function startMachineAddTask(kind: 'thisComputer' | 'ssh', runner: SystemTaskRunner,
    start: (isCurrent: () => boolean) => Promise<string | null>, observeCompletion?: MachineAddTaskHandle['observeCompletion'],
    continuation?: MachineAddTaskHandle, sshSubmission?: MachineAddTaskHandle['sshSubmission']): Promise<string | null> {
    const key = kind === 'ssh' ? 'sshTask' : 'thisComputerTask';
    const accountScope = continuation?.accountScope ?? storage.getState().settingsScope;
    if (continuation && !areAccountSettingsScopesEqual(accountScope, storage.getState().settingsScope)) return Promise.resolve(null);
    if (continuation ? readMachineAddFlowDraft()[key] !== continuation || continuation.starting : hasRunningMachineAddTask()) return Promise.resolve(null);
    readMachineAddFlowDraft()[key]?.unsubscribeCompletion?.();
    const isCurrent = () => readMachineAddFlowDraft()[key]?.startPromise === promise;
    const promise: Promise<string | null> = Promise.resolve().then(() => isCurrent() ? start(isCurrent) : null).then((taskId) => {
        const handle = readMachineAddFlowDraft()[key];
        if (handle?.startPromise !== promise) {
            if (taskId) void runner.cancel(taskId).catch(() => {});
            return null;
        }
        if (!taskId) {
            if (continuation?.taskId && !runner.getSnapshot(continuation.taskId)?.result) void runner.cancel(continuation.taskId).catch(() => {});
            updateMachineAddFlowDraft((draft) => ({ ...draft, [key]: null, startedAtMs: null, baseline: null }));
            return null;
        }
        const unsubscribeCompletion = observeCompletion?.(taskId);
        updateMachineAddFlowDraft((draft) => ({ ...draft, [key]: { ...handle, starting: false, taskId, startPromise: undefined, unsubscribeCompletion } }));
        return taskId;
    }).catch((error: unknown) => {
        const handle = readMachineAddFlowDraft()[key];
        if (handle?.startPromise === promise) updateMachineAddFlowDraft((draft) => ({ ...draft, [key]: {
            ...handle, starting: false, startPromise: undefined, startError: error instanceof Error ? error.message : t('settings.systemTaskStartFailed'),
        } }));
        return null;
    });
    updateMachineAddFlowDraft((draft) => ({ ...draft, [key]: { runner, accountScope, taskId: continuation?.taskId ?? null,
        starting: true, startError: null, startPromise: promise, observeCompletion,
        sshSubmission: continuation?.sshSubmission ?? sshSubmission } }));
    return promise;
}
