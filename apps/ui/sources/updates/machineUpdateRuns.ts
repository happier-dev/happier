import * as React from 'react';

import { getInstallablesRegistryEntries } from '@/capabilities/installablesRegistry';
import { buildMachineUpdateFactsRequest } from '@/capabilities/requests';
import { prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { startAgentInstallJob, waitForAgentInstallJob } from '@/agents/machineAgents/installJobs/installJobStore';
import { presentAgentInstallJobFailure, presentAgentInstallJobRpcFailure } from '@/agents/machineAgents/installJobs/presentAgentInstallJobFailure';
import { MACHINE_RPC_POLL_INTERVAL_MS } from '@/sync/ops/machineRpcPollInterval';
import { t } from '@/text';

import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { recordUpdateCompleted } from './updateCompletions';
export { markUpdateCompletionsSeen, readUnseenUpdateCompletions, recordUpdateCompleted, useUnseenUpdateCompletions } from './updateCompletions';
import type { UpdateItem, UpdateItemStep } from './items/updateItem';
import type { UpdateRunObservation } from './items/buildMachineUpdateItems';
import { planUpdateAll, type UpdateAllPlan } from './items/buildUpdatesSummary';

export type UpdateAllProgress = Readonly<{ done: number; total: number; stopping: boolean }>;

// Explicit presses supply already-discovered rows. Detail views observe this action-owned state;
// closing them neither cancels the plan nor loses its Stop intent. Separate groups may run together.
type UpdateBatchRun = Readonly<{ plan: UpdateAllPlan; progress: UpdateAllProgress }>;
type UpdateBatchScope = Readonly<{
    groups: ReadonlyMap<string | null, UpdateBatchRun>;
    progress: UpdateAllProgress;
}>;
const batchesByScope = new Map<string, UpdateBatchScope>();
const batchListeners = new Set<() => void>();

function publishUpdateBatch(key: string, groupId: string | null, run: UpdateBatchRun | null): void {
    const groups = new Map(batchesByScope.get(key)?.groups);
    if (run) groups.set(groupId, run);
    else groups.delete(groupId);
    if (groups.size === 0) batchesByScope.delete(key);
    else {
        let done = 0;
        let total = 0;
        let stopping = false;
        for (const group of groups.values()) {
            done += group.progress.done;
            total += group.progress.total;
            stopping ||= group.progress.stopping;
        }
        batchesByScope.set(key, { groups, progress: { done, total, stopping } });
    }
    for (const listener of batchListeners) listener();
}

export function readUpdateBatch(scope: ServerAccountScope | null): UpdateAllProgress | null {
    return scope ? batchesByScope.get(serverAccountScopeKeySuffix(scope))?.progress ?? null : null;
}

export function stopUpdateBatch(scope: ServerAccountScope | null): void {
    if (!scope) return;
    const key = serverAccountScopeKeySuffix(scope);
    for (const [groupId, run] of batchesByScope.get(key)?.groups ?? []) {
        if (!run.progress.stopping) publishUpdateBatch(key, groupId, { ...run, progress: { ...run.progress, stopping: true } });
    }
}

export async function runUpdateBatch(
    scope: ServerAccountScope,
    items: readonly UpdateItem[],
    executeItem: (item: UpdateItem) => Promise<void>,
    groupId: string | null = null,
): Promise<void> {
    const key = serverAccountScopeKeySuffix(scope);
    const running = batchesByScope.get(key)?.groups;
    if (running && (groupId === null || running.has(null) || running.has(groupId))) return;
    const plan = planUpdateAll(items);
    if (plan.total === 0) return;
    // Disjoint machine groups may run together; overlapping groups cannot bypass the existing
    // per-machine helper → agent → CLI order with another presentation id.
    if (running && [...running.values()].some((run) =>
        (run.plan.appItemId !== null && plan.appItemId !== null)
        || run.plan.machines.some((current) => plan.machines.some((next) => current.machineId === next.machineId)),
    )) return;
    const byId = new Map(items.map((item) => [item.id, item]));
    publishUpdateBatch(key, groupId, { plan, progress: { done: 0, total: plan.total, stopping: false } });
    const settle = () => {
        const run = batchesByScope.get(key)?.groups.get(groupId);
        if (run) publishUpdateBatch(key, groupId, { ...run, progress: { ...run.progress, done: run.progress.done + 1 } });
    };
    const shouldStop = () => batchesByScope.get(key)?.groups.get(groupId)?.progress.stopping === true;
    try {
        const results = await Promise.allSettled([
            ...plan.machines.map(async (machine) => {
                for (const itemId of machine.itemIds) {
                    if (shouldStop()) return;
                    const item = byId.get(itemId);
                    if (item) await executeItem(item);
                    settle();
                }
            }),
            (async () => {
                const appItem = plan.appItemId ? byId.get(plan.appItemId) : undefined;
                if (!appItem || shouldStop()) return;
                if (appItem.action.kind === 'run' && appItem.action.verb === 'update') await executeItem(appItem);
                settle();
            })(),
        ]);
        for (const result of results) if (result.status === 'rejected') throw result.reason;
    } finally {
        publishUpdateBatch(key, groupId, null);
    }
}

export function useUpdateBatch(
    scope: ServerAccountScope | null,
    items: readonly UpdateItem[],
    executeItem: (item: UpdateItem) => Promise<void>,
): Readonly<{
    batch: UpdateAllProgress | null;
    updateAll: () => Promise<void>;
    updateGroup: (group: Readonly<{ id: string; items: readonly UpdateItem[] }>) => Promise<void>;
    stopAfterCurrent: () => void;
}> {
    const key = scope ? serverAccountScopeKeySuffix(scope) : null;
    const read = React.useCallback(() => key ? batchesByScope.get(key)?.progress ?? null : null, [key]);
    const batch = React.useSyncExternalStore(
        React.useCallback((listener: () => void) => {
            batchListeners.add(listener);
            return () => { batchListeners.delete(listener); };
        }, []), read, read,
    );
    const updateAll = React.useCallback(async () => {
        if (scope) await runUpdateBatch(scope, items, executeItem);
    }, [executeItem, items, scope]);
    const updateGroup = React.useCallback(async (group: Readonly<{ id: string; items: readonly UpdateItem[] }>) => {
        if (scope) await runUpdateBatch(scope, group.items, executeItem, group.id);
    }, [executeItem, scope]);
    const stopAfterCurrent = React.useCallback(() => stopUpdateBatch(scope), [scope]);
    return { batch, updateAll, updateGroup, stopAfterCurrent };
}

/**
 * The one record of machine-side update runs started from this app (agent CLIs, helper
 * installables, another machine's Happier CLI). Each run is the executor's own call — a machine
 * capability invoke or the daemon's `cli.update.v1` system task — and the row reads its lifecycle
 * from here: in flight, failed with one sentence, or (a remote CLI) admitted by its task and waiting
 * for the machine to report the result it persisted. Success is never taken from the call itself: the row
 * re-reads the machine's facts afterwards.
 *
 * Module-level on purpose: the popover and the screen are two views of the same runs.
 */
type RunRecord =
    | Readonly<{ status: 'running' }>
    | Readonly<{ status: 'failed'; message: string; logPath?: string | null }>
    /**
     * A remote CLI update whose task confirmed it admitted the update (started the updater);
     * `baseline` is the machine's last-update fact at that moment.
     */
    | Readonly<{ status: 'accepted'; baseline: string }>
    | Readonly<{ status: 'finished' }>
    /** The runtime found the tool already current: nothing ran, and it is not an "Updated". */
    | Readonly<{ status: 'alreadyCurrent' }>;

type RunRecords = ReadonlyMap<string, RunRecord>;

/**
 * Runs per server scope (`serverId`): a run belongs to the server whose machines it was started on,
 * so switching servers neither shows it on the other server's rows nor redirects its calls.
 */
let recordsByServer: ReadonlyMap<string, RunRecords> = new Map();
const NO_RECORDS: RunRecords = new Map();
const listeners = new Set<() => void>();

function readScope(serverId: string): RunRecords {
    return recordsByServer.get(serverId) ?? NO_RECORDS;
}

function setRecord(serverId: string, itemId: string, record: RunRecord): void {
    const scope = new Map(readScope(serverId));
    scope.set(itemId, record);
    const next = new Map(recordsByServer);
    next.set(serverId, scope);
    recordsByServer = next;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** One server's runs, outside React (the summary and tests read the same record). */
export function readMachineUpdateRuns(serverId: string): RunRecords {
    return readScope(serverId);
}

export function useMachineUpdateRuns(serverId: string): RunRecords {
    const read = React.useCallback(() => readScope(serverId), [serverId]);
    return React.useSyncExternalStore(subscribe, read, read);
}



const IDLE: UpdateRunObservation = { running: false, step: null, errorMessage: null };

/**
 * What a row's executor currently says. `lastUpdateSignature` is the remote CLI's current
 * last-update fact, so an accepted run stays "running" only until the machine reports anything new.
 */
export function observeMachineUpdateRun(
    runs: RunRecords,
    itemId: string,
    options: Readonly<{ step?: UpdateItemStep; lastUpdateSignature?: string }> = {},
): UpdateRunObservation {
    const record = runs.get(itemId);
    if (!record || record.status === 'finished') return IDLE;
    if (record.status === 'running') return { running: true, step: options.step ?? 'installing', errorMessage: null };
    if (record.status === 'failed') return { running: false, step: null, errorMessage: record.message, logPath: record.logPath ?? null };
    if (record.status === 'alreadyCurrent') return { running: false, step: null, errorMessage: null, alreadyCurrent: true };
    return record.baseline === (options.lastUpdateSignature ?? '')
        ? { running: true, step: 'reconnecting', errorMessage: null }
        : IDLE;
}

export function signatureOfLastUpdate(lastUpdate: unknown): string {
    return lastUpdate == null ? '' : JSON.stringify(lastUpdate);
}

function describeRemoteFailure(code: string | undefined): string {
    // A retryable refusal: the lock may belong to an ordinary install or another channel's
    // activation, which never writes this update's record, so it is not shown as installing.
    if (code === 'cli_update_in_progress') return t('updates.row.anotherUpdateRunning');
    if (code === 'cli_not_managed') return t('updates.row.cliNotManaged');
    if (code === 'cli_remote_update_unsupported') return t('updates.row.remoteUnsupported');
    return t('updates.row.failedGeneric');
}

/**
 * The runtime's reason when it is one short sentence; raw installer output (several lines, log
 * text) never becomes the row's words — its detail stays behind View log.
 */
function readRuntimeSentence(message: string): string | null {
    const text = message.trim();
    if (!text || text.length > 200 || /[\r\n]/.test(text)) return null;
    return /[.!?…]$/.test(text) ? text : null;
}

/** K6 failure codes → one sentence, when the runtime gave no sentence of its own. */
function describeInstallFailure(code: string | undefined): string {
    if (code === 'update-not-verified') return t('updates.row.updateNotVerified');
    if (code === 'update-not-available') return t('updates.row.updateItYourWay');
    return t('updates.row.failedGeneric');
}

/** Five minutes: the existing installer invoke budget (`InstallableDepInstaller`). */
const INSTALL_INVOKE_TIMEOUT_MS = 5 * 60_000;

type RemoteTaskOutcome =
    | Readonly<{ kind: 'started' }>
    | Readonly<{ kind: 'failed'; code: string | undefined }>
    /** The machine stopped answering before the task said whether it admitted the update. */
    | Readonly<{ kind: 'unknown' }>;

function readTaskResult(value: unknown): Readonly<{ ok: boolean; code?: string }> | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as { ok?: unknown; error?: { code?: unknown } };
    if (record.ok === true) return { ok: true };
    if (record.ok === false) return { ok: false, code: typeof record.error?.code === 'string' ? record.error.code : undefined };
    return null;
}

/**
 * `tool.systemTasks` `start` only returns a task id; the task's own outcome (it started the
 * detached updater, or a named refusal) arrives through `poll`. Ask until the task reports it, at
 * the app's machine-RPC cadence. No deadline is guessed: the task settles as soon as the updater
 * is spawned. A machine that stops answering first leaves the outcome unknown, never admitted.
 */
async function awaitRemoteTaskOutcome(scope: ServerAccountScope, machineId: string, taskId: string): Promise<RemoteTaskOutcome> {
    for (;;) {
        const polled = await machineCapabilitiesInvoke(machineId, {
            id: 'tool.systemTasks',
            method: 'poll',
            params: { taskId, cursor: 0 },
        }, scope);
        if (!polled.supported || !polled.response.ok) return { kind: 'unknown' };
        const payload = polled.response.result as { result?: unknown } | null;
        const result = readTaskResult(payload?.result);
        if (result) return result.ok ? { kind: 'started' } : { kind: 'failed', code: result.code };
        await new Promise((resolve) => setTimeout(resolve, MACHINE_RPC_POLL_INTERVAL_MS));
    }
}

async function runRemoteCliUpdate(scope: ServerAccountScope, itemId: string, machineId: string, lastUpdateSignature: string): Promise<void> {
    const serverId = scope.serverId;
    const started = await machineCapabilitiesInvoke(machineId, {
        id: 'tool.systemTasks',
        method: 'start',
        params: { spec: { protocolVersion: 1, kind: 'cli.update.v1', params: {} } },
    }, scope);
    if (!started.supported) {
        // A transport loss may still have reached the machine: unknown (Retry), not a refusal.
        setRecord(serverId, itemId, {
            status: 'failed',
            message: started.reason === 'error' ? t('updates.row.outcomeUnknown') : describeRemoteFailure(undefined),
        });
        return;
    }
    if (!started.response.ok) {
        setRecord(serverId, itemId, { status: 'failed', message: describeRemoteFailure(started.response.error.code) });
        return;
    }
    const taskId = (started.response.result as { taskId?: unknown } | null)?.taskId;
    if (typeof taskId !== 'string' || !taskId) {
        setRecord(serverId, itemId, { status: 'failed', message: describeRemoteFailure(undefined) });
        return;
    }
    const outcome = await awaitRemoteTaskOutcome(scope, machineId, taskId);
    if (outcome.kind === 'unknown') {
        setRecord(serverId, itemId, { status: 'failed', message: t('updates.row.outcomeUnknown') });
        return;
    }
    if (outcome.kind === 'failed') {
        setRecord(serverId, itemId, { status: 'failed', message: describeRemoteFailure(outcome.code) });
        return;
    }
    // Admitted: from here the machine's own `cliUpdate.lastUpdate` says how it ended, including a
    // failure before activation.
    setRecord(serverId, itemId, { status: 'accepted', baseline: lastUpdateSignature });
    recordUpdateCompleted(scope, itemId, 'pendingRemote');
}

/**
 * Re-reads that machine's update facts fresh (the daemon's cache bypassed, each agent CLI with its
 * latest version) through the capability-cache owner, so a finished update resolves its row and
 * the pill count from the machine's own answer.
 */
export function refreshMachineUpdateFacts(serverId: string, machineId: string): void {
    void prefetchMachineCapabilities({ machineId, serverId, request: { ...buildMachineUpdateFactsRequest(), bypassCache: true } });
}

/**
 * Runs one machine row's update through its canonical executor, then re-reads that machine's facts
 * on the same `serverId` (success is re-read, never taken from the call).
 */
export async function runMachineItemUpdate(
    item: UpdateItem,
    context: Readonly<{ scope: ServerAccountScope; lastUpdateSignature?: string }>,
): Promise<void> {
    const machineId = item.machineId;
    if (!machineId || item.action.kind !== 'run') return;
    // Captured once: mutation and polls authenticate as the account that initiated this row.
    const scope = context.scope;
    const serverId = scope.serverId;
    if (readScope(serverId).get(item.id)?.status === 'running') return;
    setRecord(serverId, item.id, { status: 'running' });

    const subject = item.subject;
    try {
        if (subject.kind === 'happier-cli') {
            await runRemoteCliUpdate(scope, item.id, machineId, context.lastUpdateSignature ?? '');
            return;
        }

        if (subject.kind === 'agent-cli') {
            const target = { ...scope, machineId, agentId: subject.agentId };
            await startAgentInstallJob(target, 'update', { consent: { vendorRecipe: true } });
            const outcome = await waitForAgentInstallJob(target);
            if (outcome.kind === 'failed') {
                setRecord(serverId, item.id, { status: 'failed', message: presentAgentInstallJobFailure(outcome).body });
            } else if (outcome.version !== null && outcome.version === item.currentVersion) {
                setRecord(serverId, item.id, { status: 'alreadyCurrent' });
            } else {
                setRecord(serverId, item.id, { status: 'finished' });
                recordUpdateCompleted(scope, item.id);
            }
            return;
        }

        const request = subject.kind === 'installable'
                ? (() => {
                    const entry = getInstallablesRegistryEntries().find((candidate) => candidate.key === subject.key);
                    return entry ? { id: entry.capabilityId, method: 'upgrade' } : null;
                })()
                : null;
        if (!request) {
            setRecord(serverId, item.id, { status: 'failed', message: t('updates.row.failedGeneric') });
            return;
        }
        const result = await machineCapabilitiesInvoke(machineId, request, { ...scope, timeoutMs: INSTALL_INVOKE_TIMEOUT_MS });
        if (!result.supported) {
            setRecord(serverId, item.id, {
                status: 'failed',
                message: result.reason === 'not-supported' ? t('deps.installNotSupported') : t('updates.row.failedGeneric'),
            });
            return;
        }
        if (!result.response.ok) {
            setRecord(serverId, item.id, {
                status: 'failed',
                message: readRuntimeSentence(result.response.error.message) ?? describeInstallFailure(result.response.error.code),
                logPath: typeof result.response.logPath === 'string' ? result.response.logPath : null,
            });
            return;
        }
        const outcome = result.response.result as { alreadyCurrent?: unknown } | null | undefined;
        if (outcome?.alreadyCurrent === true) {
            setRecord(serverId, item.id, { status: 'alreadyCurrent' });
            return;
        }
        setRecord(serverId, item.id, { status: 'finished' });
        recordUpdateCompleted(scope, item.id);
    } catch (error) {
        setRecord(serverId, item.id, { status: 'failed', message: subject.kind === 'agent-cli' ? presentAgentInstallJobRpcFailure(error).body : t('updates.row.failedGeneric') });
    } finally {
        refreshMachineUpdateFacts(serverId, machineId);
    }
}
