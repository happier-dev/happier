import * as React from 'react';
import { createDefaultSshCredentialsDraft } from '@/components/ssh/sshCredentialsDraft';
import type { SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import type { AwaitedMachineArrivalBaseline } from '@/components/onboarding/detection/useAwaitedMachineArrival';
import type { MachineAddPathId } from './machineAddPaths';
import type { MachineAddCommandOs } from './machineAddCommand';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';

export type MachineAddTaskHandle = Readonly<{
    runner: SystemTaskRunner;
    taskId: string | null;
    starting: boolean;
    startError: string | null;
    /** The existing actor identity, captured once by the retained task owner. */
    accountScope?: AccountSettingsScope | null;
    startPromise?: Promise<string | null>;
    /** Completion subscription follows the actual task even with no presenter mounted. */
    observeCompletion?: (taskId: string) => (() => void);
    unsubscribeCompletion?: () => void;
}>;
export type MachineAddSshDraft = SshCredentialsDraft & Readonly<{ privateKeyMaterial?: string; savedHostId?: string | null }>;
export type MachineAddFlowDraft = Readonly<{
    serverId: string | null;
    path: MachineAddPathId | null;
    /** Create one is open instead of a connect path (lab `m-add`): nothing is waiting to connect. */
    creating: boolean;
    sshDraft: MachineAddSshDraft;
    os: MachineAddCommandOs;
    thisComputerTask: MachineAddTaskHandle | null;
    sshTask: MachineAddTaskHandle | null;
    baseline: AwaitedMachineArrivalBaseline | null;
    startedAtMs: number | null;
}>;

function createDraft(): MachineAddFlowDraft {
    return { serverId: null, path: null, creating: false, sshDraft: createDefaultSshCredentialsDraft(), os: 'linux', thisComputerTask: null, sshTask: null, baseline: null, startedAtMs: null };
}

const NOT_SEEING_AFTER_MS = 5 * 60_000;
let draft = createDraft();
const listeners = new Set<() => void>();
let watchTimer: ReturnType<typeof setTimeout> | null = null;

export function readMachineAddFlowDraft(): MachineAddFlowDraft { return draft; }

function publish() {
    for (const listener of listeners) listener();
}

export function updateMachineAddFlowDraft(next: MachineAddFlowDraft | ((current: MachineAddFlowDraft) => MachineAddFlowDraft)): void {
    const previous = draft;
    draft = typeof next === 'function' ? next(previous) : next;
    if (draft === previous) return;
    if (draft.startedAtMs !== previous.startedAtMs) {
        if (watchTimer !== null) clearTimeout(watchTimer);
        watchTimer = null;
        const startedAtMs = draft.startedAtMs;
        if (startedAtMs !== null) {
            const remaining = NOT_SEEING_AFTER_MS - (Date.now() - startedAtMs);
            if (remaining > 0) watchTimer = setTimeout(() => {
                watchTimer = null;
                if (draft.startedAtMs !== startedAtMs) return;
                // No clock/status mirror: invalidate the projection once at the approved boundary.
                draft = { ...draft };
                publish();
            }, remaining);
        }
    }
    publish();
}

export function cancelMachineAddFlowTasks(): void {
    for (const handle of [draft.thisComputerTask, draft.sshTask]) {
        handle?.unsubscribeCompletion?.();
        if (handle?.taskId && !handle.runner.getSnapshot(handle.taskId)?.result) {
            void handle.runner.cancel(handle.taskId).catch(() => {});
        }
    }
    // A start still awaiting its OS bridge cannot be cancelled by id yet. Invalidating its
    // promise lets the start owner cancel the returned id instead of resurrecting this draft.
    updateMachineAddFlowDraft((current) => ({
        ...current, startedAtMs: null, baseline: null,
        thisComputerTask: current.thisComputerTask?.starting ? null : current.thisComputerTask,
        sshTask: current.sshTask?.starting ? null : current.sshTask,
    }));
}

export function discardMachineAddFlowDraft(): void {
    cancelMachineAddFlowTasks();
    updateMachineAddFlowDraft(createDraft());
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function useMachineAddFlowDraft() {
    const draft = React.useSyncExternalStore(subscribe, readMachineAddFlowDraft, readMachineAddFlowDraft);
    return {
        draft,
        update: updateMachineAddFlowDraft,
        discard: discardMachineAddFlowDraft,
        notSeeing: draft.startedAtMs !== null && Date.now() - draft.startedAtMs >= NOT_SEEING_AFTER_MS,
    };
}

export function useMachineAddFlowDraftSelector<T>(selector: (draft: MachineAddFlowDraft) => T): T {
    return React.useSyncExternalStore(subscribe, () => selector(readMachineAddFlowDraft()), () => selector(readMachineAddFlowDraft()));
}
