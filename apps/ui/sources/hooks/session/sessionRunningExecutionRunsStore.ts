import type { ExecutionRunPublicState } from '@happier-dev/protocol';

import { sessionExecutionRunList, type SessionExecutionRunListResult } from '@/sync/ops/sessionExecutionRuns';
import { subscribeExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';

import { reconcileStableRows } from './reconcileStableRows';

/**
 * One running-execution-run poll per session, shared by every surface that needs it.
 *
 * A session shows this data in at least five independent places (session shell, session header,
 * Agents pane, subagent details, message details). While the poll lived inside the hook, each of
 * those mounted its own 5 s interval against the same session: measured at one
 * `sessionExecutionRunList` per mount per interval, so an open session with the Agents pane and a
 * details surface issued four identical RPCs every five seconds.
 *
 * The subscription is therefore reference counted here. The first subscriber for a session starts
 * the loop, later subscribers join the cadence already in flight, and the last one to leave tears
 * the timer down and drops the entry. Push invalidation arrives through the existing
 * `executionRunActivityBus` — the coordination seam that already exists — rather than a second one.
 */

export const SESSION_RUNNING_EXECUTION_RUNS_POLL_INTERVAL_MS = 5_000;
const SESSION_RUNNING_EXECUTION_RUNS_EMPTY_CONFIRM_DELAY_MS = 1_000;
const SESSION_RUNNING_EXECUTION_RUNS_IDLE_ERROR_RETRY_LIMIT = 2;

export const EMPTY_RUNNING_EXECUTION_RUNS: readonly ExecutionRunPublicState[] = Object.freeze([]);

type SessionRunningExecutionRunsEntry = {
    runs: readonly ExecutionRunPublicState[];
    readonly listeners: Set<() => void>;
    timer: ReturnType<typeof setTimeout> | null;
    generation: number;
    inFlight: boolean;
    pendingRepoll: boolean;
    hadRunningRun: boolean;
    pendingEmptyConfirm: boolean;
    idleErrorRetries: number;
    stopActivitySubscription: (() => void) | null;
};

const entriesBySessionId = new Map<string, SessionRunningExecutionRunsEntry>();

function normalizeSessionId(sessionId: string): string {
    return typeof sessionId === 'string' ? sessionId.trim() : '';
}

function isRpcMethodNotAvailableError(input: unknown): boolean {
    if (!input || typeof input !== 'object') return false;
    const code = typeof (input as any).errorCode === 'string' ? String((input as any).errorCode) : '';
    if (code === 'RPC_METHOD_NOT_AVAILABLE') return true;
    const message = typeof (input as any).error === 'string' ? String((input as any).error) : '';
    return /rpc method not available/i.test(message);
}

export function resolveRunningExecutionRunsFromListResult(
    result: SessionExecutionRunListResult,
): readonly ExecutionRunPublicState[] {
    if ((result as any)?.ok === false) return [];
    const runs = Array.isArray((result as any)?.runs) ? ((result as any).runs as ExecutionRunPublicState[]) : [];
    return runs.filter((run) => {
        const status = typeof (run as any)?.status === 'string' ? String((run as any).status).trim().toLowerCase() : '';
        return status === 'running';
    });
}

function notify(entry: SessionRunningExecutionRunsEntry): void {
    for (const listener of [...entry.listeners]) {
        try {
            listener();
        } catch {
            // A listener failure must not stop the rest of the fan-out.
        }
    }
}

function publishRuns(
    entry: SessionRunningExecutionRunsEntry,
    nextRuns: readonly ExecutionRunPublicState[],
): void {
    const reconciled = nextRuns.length === 0
        ? EMPTY_RUNNING_EXECUTION_RUNS
        : reconcileStableRows(entry.runs, nextRuns, (run) => run.runId);
    if (reconciled === entry.runs) return;
    entry.runs = reconciled;
    notify(entry);
}

function clearEntryTimer(entry: SessionRunningExecutionRunsEntry): void {
    if (!entry.timer) return;
    clearTimeout(entry.timer);
    entry.timer = null;
}

function scheduleNext(
    sessionId: string,
    entry: SessionRunningExecutionRunsEntry,
    generation: number,
    delayMs: number,
): void {
    if (entry.generation !== generation) return;
    clearEntryTimer(entry);
    entry.timer = setTimeout(() => {
        void pollOnce(sessionId, generation);
    }, delayMs);
}

async function pollOnce(sessionId: string, generation: number): Promise<void> {
    const entry = entriesBySessionId.get(sessionId);
    if (!entry || entry.generation !== generation) return;
    if (entry.inFlight) return;

    entry.inFlight = true;
    try {
        let response: SessionExecutionRunListResult = await sessionExecutionRunList(sessionId, {});
        if ((response as any)?.ok === false && isRpcMethodNotAvailableError(response)) {
            response = await sessionExecutionRunList(sessionId, {});
        }

        if (entriesBySessionId.get(sessionId) !== entry || entry.generation !== generation) return;

        if ((response as any)?.ok === false) {
            if (entry.hadRunningRun) {
                scheduleNext(sessionId, entry, generation, SESSION_RUNNING_EXECUTION_RUNS_POLL_INTERVAL_MS);
                return;
            }

            if (entry.idleErrorRetries < SESSION_RUNNING_EXECUTION_RUNS_IDLE_ERROR_RETRY_LIMIT) {
                entry.idleErrorRetries += 1;
                scheduleNext(sessionId, entry, generation, SESSION_RUNNING_EXECUTION_RUNS_POLL_INTERVAL_MS);
                return;
            }

            clearEntryTimer(entry);
            publishRuns(entry, EMPTY_RUNNING_EXECUTION_RUNS);
            return;
        }

        entry.idleErrorRetries = 0;
        const nextRunning = resolveRunningExecutionRunsFromListResult(response);
        if (nextRunning.length > 0) {
            entry.hadRunningRun = true;
            entry.pendingEmptyConfirm = false;
            publishRuns(entry, nextRunning);
            scheduleNext(sessionId, entry, generation, SESSION_RUNNING_EXECUTION_RUNS_POLL_INTERVAL_MS);
            return;
        }

        if (entry.hadRunningRun && !entry.pendingEmptyConfirm) {
            entry.pendingEmptyConfirm = true;
            scheduleNext(sessionId, entry, generation, SESSION_RUNNING_EXECUTION_RUNS_EMPTY_CONFIRM_DELAY_MS);
            return;
        }

        entry.hadRunningRun = false;
        entry.pendingEmptyConfirm = false;
        clearEntryTimer(entry);
        publishRuns(entry, EMPTY_RUNNING_EXECUTION_RUNS);
    } finally {
        entry.inFlight = false;
        if (
            entry.pendingRepoll
            && entry.generation === generation
            && entriesBySessionId.get(sessionId) === entry
        ) {
            entry.pendingRepoll = false;
            void pollOnce(sessionId, generation);
        }
    }
}

function handleExecutionRunActivity(sessionId: string): void {
    const entry = entriesBySessionId.get(sessionId);
    if (!entry) return;
    clearEntryTimer(entry);
    entry.pendingEmptyConfirm = false;
    if (entry.inFlight) {
        entry.pendingRepoll = true;
        return;
    }
    void pollOnce(sessionId, entry.generation);
}

/**
 * Poll now unless the shared loop is already about to, so a surface mounting into an active cadence
 * costs nothing while one mounting into an idle store still gets fresh data.
 */
function pollUnlessAlreadyPending(sessionId: string, entry: SessionRunningExecutionRunsEntry): void {
    if (entry.inFlight || entry.timer) return;
    entry.pendingEmptyConfirm = false;
    void pollOnce(sessionId, entry.generation);
}

/**
 * The current shared snapshot. Never creates an entry: a `useSyncExternalStore` snapshot read can
 * happen on a render that is thrown away, and that must not start a poll.
 */
export function readRunningExecutionRuns(sessionId: string): readonly ExecutionRunPublicState[] {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return EMPTY_RUNNING_EXECUTION_RUNS;
    return entriesBySessionId.get(normalizedSessionId)?.runs ?? EMPTY_RUNNING_EXECUTION_RUNS;
}

export function subscribeToRunningExecutionRuns(sessionId: string, listener: () => void): () => void {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return () => {};

    let entry = entriesBySessionId.get(normalizedSessionId);
    if (!entry) {
        entry = {
            runs: EMPTY_RUNNING_EXECUTION_RUNS,
            listeners: new Set(),
            timer: null,
            generation: 0,
            inFlight: false,
            pendingRepoll: false,
            hadRunningRun: false,
            pendingEmptyConfirm: false,
            idleErrorRetries: 0,
            stopActivitySubscription: null,
        };
        entriesBySessionId.set(normalizedSessionId, entry);
        entry.stopActivitySubscription = subscribeExecutionRunActivity(
            normalizedSessionId,
            () => handleExecutionRunActivity(normalizedSessionId),
        );
    }

    const activeEntry = entry;
    activeEntry.listeners.add(listener);
    pollUnlessAlreadyPending(normalizedSessionId, activeEntry);

    let subscribed = true;
    return () => {
        if (!subscribed) return;
        subscribed = false;
        activeEntry.listeners.delete(listener);
        if (activeEntry.listeners.size > 0) return;
        if (entriesBySessionId.get(normalizedSessionId) !== activeEntry) return;

        // Bumping the generation orphans any in-flight response and any timer callback that already
        // escaped `clearTimeout`, so a torn-down session can never publish or reschedule.
        activeEntry.generation += 1;
        clearEntryTimer(activeEntry);
        activeEntry.pendingRepoll = false;
        activeEntry.stopActivitySubscription?.();
        activeEntry.stopActivitySubscription = null;
        entriesBySessionId.delete(normalizedSessionId);
    };
}

/**
 * A surface observed transcript evidence that run state may have moved (a new `SubAgentRun` call, a
 * stop result). Refresh the shared loop, unless it is already fetching or scheduled.
 */
export function requestRunningExecutionRunsRefresh(sessionId: string): void {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return;
    const entry = entriesBySessionId.get(normalizedSessionId);
    if (!entry) return;
    pollUnlessAlreadyPending(normalizedSessionId, entry);
}
