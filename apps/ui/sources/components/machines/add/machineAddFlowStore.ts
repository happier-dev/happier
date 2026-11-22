import * as React from 'react';
import { createDefaultSshCredentialsDraft } from '@/components/ssh/sshCredentialsDraft';
import type { SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import type { AwaitedMachineArrivalBaseline } from '@/components/onboarding/detection/useAwaitedMachineArrival';
import type { MachineAddPathId } from './machineAddPaths';
import type { MachineAddCommandOs } from './machineAddCommand';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { ManagedMachineEnrollmentIdentityV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedControllerChoice } from '@/components/settings/machines/managed/useManagedControllerScope';

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
    /** Original SSH target/ref custody; later form edits cannot retarget a prompt. */
    sshSubmission?: Readonly<{ draft: MachineAddSshDraft; savedHostRevision: number | 'absent' | null }>;
}>;
export type MachineAddSshDraft = SshCredentialsDraft & Readonly<{
    privateKeyMaterial?: string; savedHostId?: string | null; savedHostExpectedRevision?: number | 'absent';
    enrollmentIdentity?: ManagedMachineEnrollmentIdentityV1;
}>;
export type MachineAddFlowDraft = Readonly<{
    serverId: string | null;
    path: MachineAddPathId | null;
    /** Create one is open instead of a connect path (lab `m-add`): nothing is waiting to connect. */
    creating: boolean;
    createController?: ManagedControllerChoice;
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
const notSeeingListeners = new Set<() => void>();
let watchTimer: ReturnType<typeof setTimeout> | null = null;

export function readMachineAddFlowDraft(): MachineAddFlowDraft { return draft; }

function publish() {
    for (const listener of listeners) listener();
}

function millisecondsUntilNotSeeing() {
    return draft.startedAtMs === null ? null : NOT_SEEING_AFTER_MS - (Date.now() - draft.startedAtMs);
}

function readNotSeeing() {
    const remaining = millisecondsUntilNotSeeing();
    return remaining !== null && remaining <= 0;
}

function publishNotSeeing() {
    for (const listener of notSeeingListeners) listener();
}

function scheduleNotSeeing() {
    if (watchTimer !== null) clearTimeout(watchTimer);
    watchTimer = null;
    if (notSeeingListeners.size === 0) return;
    const remaining = millisecondsUntilNotSeeing();
    if (remaining === null || remaining <= 0) return;
    watchTimer = setTimeout(() => {
        watchTimer = null;
        publishNotSeeing();
    }, remaining);
}

export function updateMachineAddFlowDraft(next: MachineAddFlowDraft | ((current: MachineAddFlowDraft) => MachineAddFlowDraft)): void {
    const previous = draft;
    draft = typeof next === 'function' ? next(previous) : next;
    if (draft === previous) return;
    if (draft.startedAtMs !== previous.startedAtMs) {
        scheduleNotSeeing();
        publishNotSeeing();
    }
    publish();
}

/** Lifecycle teardown only; user cancellation is admitted through the enrollment Actions. */
function cancelMachineAddFlowTasks(): void {
    for (const handle of [draft.thisComputerTask, draft.sshTask]) {
        handle?.unsubscribeCompletion?.();
        const snapshot = handle?.taskId ? handle.runner.getSnapshot(handle.taskId) : null;
        if (handle?.taskId && !snapshot?.result && !snapshot?.cancelRequested) {
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

function subscribeNotSeeing(listener: () => void): () => void {
    notSeeingListeners.add(listener);
    if (notSeeingListeners.size === 1) scheduleNotSeeing();
    return () => {
        notSeeingListeners.delete(listener);
        if (notSeeingListeners.size === 0) scheduleNotSeeing();
    };
}

export function useMachineAddFlowDraft() {
    const draft = React.useSyncExternalStore(subscribe, readMachineAddFlowDraft, readMachineAddFlowDraft);
    const notSeeing = React.useSyncExternalStore(subscribeNotSeeing, readNotSeeing, readNotSeeing);
    return {
        draft,
        update: updateMachineAddFlowDraft,
        discard: discardMachineAddFlowDraft,
        notSeeing,
    };
}

export function useMachineAddFlowDraftSelector<T>(selector: (draft: MachineAddFlowDraft) => T): T {
    return React.useSyncExternalStore(subscribe, () => selector(readMachineAddFlowDraft()), () => selector(readMachineAddFlowDraft()));
}
