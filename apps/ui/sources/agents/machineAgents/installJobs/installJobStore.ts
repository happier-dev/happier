import type { AgentInstallJob, AgentInstallJobConsent, AgentInstallJobEvent, AgentInstallJobIntent, AgentInstallJobUpdate, DaemonAgentInstallCancelResponse, DaemonAgentInstallStartRequest } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { buildMachineAgentInventoryKey } from '@happier-dev/protocol/capabilities';

import { serverAccountScopedResourceKey, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { subscribeMachineRpcRecovery } from '@/sync/runtime/orchestration/serverScopedRpc/subscribeMachineRpcRecovery';
import { machineAgentInventoryStore } from '../machineAgentInventoryStore';
import type { MachineAgentJob, MachineAgentJobStep } from '../machineAgentTypes';
import { AgentInstallJobRpcError, cancelAgentInstallJobRpc, followAgentInstallJobRpc, listAgentInstallJobsRpc, readAgentInstallJobRpc, startAgentInstallJobRpc } from './api';

export type MachineAgentInstallJobTarget = ServerAccountScope & Readonly<{ machineId: string }>;
export type AgentInstallJobTarget = MachineAgentInstallJobTarget & Readonly<{ agentId: string; definitionId?: string }>;
export type AgentInstallJobStartOptions = Readonly<{ consent: AgentInstallJobConsent; force?: boolean;
    expectedDefinitionVersion?: DaemonAgentInstallStartRequest['expectedDefinitionVersion'] }>;

type JobObservation = { controller: AbortController; follow: boolean };
type JobRecord = { target: AgentInstallJobTarget; job: MachineAgentJob; cursor: number; hydrated: boolean; observation?: JobObservation };
type JobDiscovery = { controller: AbortController; promise: Promise<void>; readers: number };
type MachineJobs = { target: MachineAgentInstallJobTarget; controller: AbortController; jobs: ReadonlyMap<string, MachineAgentJob>; records: Map<string, JobRecord>; listeners: Set<() => void>; agentListeners: Map<string, Set<() => void>>; loading?: JobDiscovery; starts: Map<string, Promise<MachineAgentJob>>; detachRecovery?: () => void };
const machines = new Map<string, MachineJobs>();
const machineKey = (target: MachineAgentInstallJobTarget) => serverAccountScopedResourceKey(target, 'agent-install-jobs', target.machineId);
const inventoryKey = (target: MachineAgentInstallJobTarget) => serverAccountScopedResourceKey(target, 'machine-agents', target.machineId);

// Closing a presenter must not stop a daemon job; replacing its credential must stop
// this Account's reads immediately. The shared credential fanout owns that distinction.
subscribeHomeCredentialChange(({ serverId }) => {
    for (const [key, state] of [...machines]) {
        if (state.target.serverId !== serverId) continue;
        state.controller.abort();
        state.detachRecovery?.();
        for (const record of state.records.values()) stopObserving(record);
        machines.delete(key);
        machineAgentInventoryStore.publishJobs(inventoryKey(state.target), new Map());
        for (const listener of state.listeners) listener();
        for (const listeners of state.agentListeners.values()) for (const listener of listeners) listener();
    }
});

function requireCurrent(state: MachineJobs): void {
    if (state.controller.signal.aborted) throw new AgentInstallJobRpcError('scope_retired');
}

function accountLifetime(state: MachineJobs): ServerAccountScopeLifetime {
    const signal = state.controller.signal;
    return {
        scope: { serverId: state.target.serverId, accountId: state.target.accountId },
        isCurrent: () => !signal.aborted,
        onRetire(cancel) {
            if (signal.aborted) { cancel(); return { dispose() {} }; }
            signal.addEventListener('abort', cancel, { once: true });
            return { dispose() { signal.removeEventListener('abort', cancel); } };
        },
    };
}

function machine(target: MachineAgentInstallJobTarget): MachineJobs {
    const key = machineKey(target);
    let state = machines.get(key);
    if (!state) {
        state = { target, controller: new AbortController(), jobs: new Map(), records: new Map(), listeners: new Set(), agentListeners: new Map(), starts: new Map() };
        machines.set(key, state);
    }
    return state;
}

function publish(target: AgentInstallJobTarget, job: MachineAgentJob | null): void {
    const state = machine(target);
    const targetKey = buildMachineAgentInventoryKey(target);
    const previous = state.jobs.get(targetKey);
    if (previous === job || (!job && !state.jobs.has(targetKey))) return;
    const jobs = new Map(state.jobs);
    if (job) jobs.set(targetKey, job);
    else jobs.delete(targetKey);
    state.jobs = jobs;
    machineAgentInventoryStore.publishJobs(inventoryKey(target), jobs);
    for (const listener of state.agentListeners.get(targetKey) ?? []) listener();
    for (const listener of state.listeners) listener();
}

function retainObservationFailure(record: JobRecord, error: unknown): boolean {
    if (record.job.outcome || !(error instanceof AgentInstallJobRpcError) || error.code === 'request_failed') return false;
    if (record.job.readFailure !== error.code) {
        record.job = { ...record.job, readFailure: error.code };
        publish(record.target, record.job);
    }
    return true;
}

export function readAgentInstallJob(target: AgentInstallJobTarget): MachineAgentJob | null {
    return machine(target).jobs.get(buildMachineAgentInventoryKey(target)) ?? null;
}

export function readMachineAgentInstallJobs(target: MachineAgentInstallJobTarget): ReadonlyMap<string, MachineAgentJob> {
    return machine(target).jobs;
}

function hasReaders(state: MachineJobs, record: JobRecord): boolean {
    return state.listeners.size > 0 || (state.agentListeners.get(buildMachineAgentInventoryKey(record.target))?.size ?? 0) > 0;
}

function stopObserving(record: JobRecord): void {
    const observation = record.observation;
    record.observation = undefined;
    observation?.controller.abort();
}

function updateDemand(state: MachineJobs, record?: JobRecord): void {
    if (state.controller.signal.aborted) return;
    if (state.listeners.size || state.agentListeners.size) {
        state.detachRecovery ??= subscribeMachineRpcRecovery({ ...state.target, expectedAccountId: state.target.accountId }, () => {
            for (const current of state.records.values()) if (hasReaders(state, current)) void observe(state, current);
        });
    } else {
        state.detachRecovery?.();
        state.detachRecovery = undefined;
    }
    if (!record) return;
    if (hasReaders(state, record)) void observe(state, record);
    else if (record.observation?.follow) stopObserving(record);
}

export function subscribeAgentInstallJob(target: AgentInstallJobTarget, listener: () => void): () => void {
    const state = machine(target);
    const targetKey = buildMachineAgentInventoryKey(target);
    let listeners = state.agentListeners.get(targetKey);
    if (!listeners) {
        listeners = new Set();
        state.agentListeners.set(targetKey, listeners);
    }
    listeners.add(listener);
    updateDemand(state, state.records.get(targetKey));
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) state.agentListeners.delete(targetKey);
        updateDemand(state, state.records.get(targetKey));
    };
}

export function subscribeMachineAgentInstallJobs(target: MachineAgentInstallJobTarget, listener: () => void): () => void {
    const state = machine(target);
    state.listeners.add(listener);
    updateDemand(state);
    for (const record of state.records.values()) void observe(state, record);
    return () => {
        state.listeners.delete(listener);
        updateDemand(state);
        for (const record of state.records.values()) {
            if (record.observation?.follow && !hasReaders(state, record)) stopObserving(record);
        }
    };
}

function fromWire(job: AgentInstallJob): MachineAgentJob {
    return {
        jobId: job.jobId, intent: job.intent, startedAtMs: job.startedAt, logLine: null, outcome: job.outcome,
        ...(job.executionScope ? { executionScope: job.executionScope } : {}),
        steps: job.steps.map((step) => {
            const progress = job.progress.find((entry) => entry.stepId === step.stepId);
            return { ...step, bytesDone: progress?.bytesDone ?? null, bytesTotal: progress?.bytesTotal ?? null };
        }),
    };
}

function applyEvents(job: MachineAgentJob, events: readonly AgentInstallJobEvent[]): MachineAgentJob {
    let next = job;
    for (const event of events) {
        if (event.t === 'log') {
            if (next.logLine !== event.line) next = { ...next, logLine: event.line };
            continue;
        }
        const index = next.steps.findIndex((step) => step.stepId === event.stepId);
        const previous = next.steps[index];
        const step: MachineAgentJobStep = event.t === 'step'
            ? { stepId: event.stepId, label: event.label, state: event.state, bytesDone: previous?.bytesDone ?? null, bytesTotal: previous?.bytesTotal ?? null }
            : { stepId: event.stepId, label: previous?.label ?? event.stepId, state: previous?.state ?? 'pending', bytesDone: event.bytesDone, bytesTotal: event.bytesTotal };
        if (previous && previous.label === step.label && previous.state === step.state && previous.bytesDone === step.bytesDone && previous.bytesTotal === step.bytesTotal) continue;
        const steps = [...next.steps];
        if (index < 0) steps.push(step);
        else steps[index] = step;
        next = { ...next, steps };
    }
    return next;
}

async function observe(state: MachineJobs, record: JobRecord): Promise<void> {
    const { target } = record;
    const targetKey = buildMachineAgentInventoryKey(target);
    if (state.controller.signal.aborted || record.observation || record.job.outcome || state.records.get(targetKey) !== record) return;
    const observation = { controller: new AbortController(), follow: hasReaders(state, record) };
    record.observation = observation;
    const isCurrent = () => !state.controller.signal.aborted && state.records.get(targetKey) === record
        && record.observation === observation;
    const applyUpdate = (update: AgentInstallJobUpdate, outcome?: MachineAgentJob['outcome']) => {
        if (update.nextCursor < record.cursor) return;
        const events = update.events.slice(Math.max(0, update.events.length - (update.nextCursor - record.cursor)));
        let next = applyEvents(record.job.readFailure ? { ...record.job, readFailure: undefined } : record.job, events);
        if (outcome) next = { ...next, outcome };
        record.cursor = update.nextCursor;
        record.job = next;
        publish(target, next);
    };
    let completedFiniteRead = false;
    try {
        const rpcTarget = { ...target, signal: observation.controller.signal };
        const input = { jobId: record.job.jobId, cursor: record.cursor };
        const response = observation.follow
            ? await followAgentInstallJobRpc(rpcTarget, input, update => { if (isCurrent()) applyUpdate(update); })
            : await readAgentInstallJobRpc(rpcTarget, input);
        if (!isCurrent()) return;
        if (!response.ok) {
            if (response.errorCode === 'job_not_found') {
                state.records.delete(targetKey);
                try {
                    // The initial discovery may have supplied the now-pruned job. Finish it
                    // before a fresh list so recovery cannot rejoin that stale snapshot.
                    await state.loading?.promise;
                    await ensureMachineAgentInstallJobs(target);
                    requireCurrent(state);
                } catch (error) {
                    // Keep the last projection for the next authenticated reconnect.
                    if (!state.controller.signal.aborted && !state.records.has(targetKey)) state.records.set(targetKey, record);
                    throw error;
                }
                if (!state.records.has(targetKey)) publish(target, null);
                return;
            }
            throw new AgentInstallJobRpcError(response.errorCode, response.error);
        }
        applyUpdate(response, response.outcome);
        completedFiniteRead = !observation.follow && !response.done;
    } catch (error) {
        if (isCurrent()) retainObservationFailure(record, error);
    } finally {
        if (record.observation === observation) {
            record.observation = undefined;
            if (completedFiniteRead && hasReaders(state, record)) void observe(state, record);
        }
    }
}

/** List is discovery/recovery; once hydrated, cursor reads own a job's changing projection. */
export function ensureMachineAgentInstallJobs(target: MachineAgentInstallJobTarget, options: Readonly<{ signal?: AbortSignal }> = {}): Promise<void> {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(new AgentInstallJobRpcError('request_cancelled'));
    const state = machine(target);
    if (!state.loading) {
        const controller = new AbortController();
        const retire = () => controller.abort();
        state.controller.signal.addEventListener('abort', retire, { once: true });
        if (state.controller.signal.aborted) controller.abort();
        const promise = (async () => {
            const response = await listAgentInstallJobsRpc({ ...target, signal: controller.signal });
            if (controller.signal.aborted) throw new AgentInstallJobRpcError('request_cancelled');
            requireCurrent(state);
            if (!response.ok) throw new AgentInstallJobRpcError(response.errorCode, response.error);
            const latest = new Map<string, AgentInstallJob>();
            for (const wire of response.jobs) {
                const targetKey = buildMachineAgentInventoryKey(wire);
                const candidate = latest.get(targetKey);
                // Active work is selected per Agent/definition target. Historical timestamps can
                // precede a clock correction, so active work takes priority over history.
                if (!candidate || (candidate.done && !wire.done) || (candidate.done === wire.done && candidate.startedAt < wire.startedAt)) {
                    latest.set(targetKey, wire);
                }
            }
            for (const wire of latest.values()) {
                const targetKey = buildMachineAgentInventoryKey(wire);
                const previous = state.records.get(targetKey);
                // A start response names the admitted job even when an older list arrives later.
                if (previous && !previous.hydrated && previous.job.jobId !== wire.jobId) continue;
                if (previous?.job.jobId === wire.jobId && previous.hydrated && !previous.job.readFailure) continue;
                if (wire.done && previous && previous.job.jobId !== wire.jobId && previous.job.startedAtMs > wire.startedAt) continue;
                if (previous) stopObserving(previous);
                const agentTarget = { ...target, agentId: wire.agentId, definitionId: wire.definitionId };
                const record: JobRecord = { target: agentTarget, job: fromWire(wire), cursor: 0, hydrated: true };
                state.records.set(targetKey, record);
                publish(agentTarget, record.job);
                if (!wire.done) void observe(state, record);
            }
        })().catch(error => {
            if (!controller.signal.aborted) {
                for (const record of state.records.values()) retainObservationFailure(record, error);
            }
            throw error;
        }).finally(() => {
            state.controller.signal.removeEventListener('abort', retire);
            if (state.loading?.controller === controller) state.loading = undefined;
        }).then(() => {
            // Discovery may omit a job after a daemon restart. Only its authenticated
            // cursor read can retire the retained projection through job_not_found.
            // Clear loading first: that read can itself request fresh discovery.
            for (const record of state.records.values()) {
                if (record.job.readFailure) void observe(state, record);
            }
        });
        state.loading = { controller, promise, readers: 0 };
    }
    const discovery = state.loading;
    discovery.readers += 1;
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const release = () => {
            if (settled) return false;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            discovery.readers -= 1;
            // Discovery observes jobs; retiring its last reader never cancels a daemon job.
            if (discovery.readers === 0 && state.loading === discovery) {
                state.loading = undefined;
                discovery.controller.abort();
            }
            return true;
        };
        const onAbort = () => { if (release()) reject(new AgentInstallJobRpcError('request_cancelled')); };
        signal?.addEventListener('abort', onAbort, { once: true });
        discovery.promise.then(() => { if (release()) resolve(); }, error => { if (release()) reject(error); });
        if (signal?.aborted) onAbort();
    });
}

export function startAgentInstallJob(target: AgentInstallJobTarget, intent: AgentInstallJobIntent, options: AgentInstallJobStartOptions): Promise<MachineAgentJob> {
    const state = machine(target);
    const targetKey = buildMachineAgentInventoryKey(target);
    // A definition's pin can change while its earlier start RPC is pending.
    // The daemon owns joins under the captured Account/definition/version.
    const shareAdmission = target.definitionId === undefined;
    const starting = shareAdmission ? state.starts.get(targetKey) : undefined;
    if (starting) return starting;
    const promise = (async () => {
        const response = await startAgentInstallJobRpc({ ...target, signal: state.controller.signal }, { agentId: target.agentId,
            ...(target.definitionId === undefined ? {} : { definitionId: target.definitionId }), intent, ...options });
        requireCurrent(state);
        if (!response.ok) throw new AgentInstallJobRpcError(response.errorCode, response.error);
        if (state.records.get(targetKey)?.job.jobId !== response.jobId) {
            const previous = state.records.get(targetKey);
            if (previous) stopObserving(previous);
            const record: JobRecord = { target, job: { jobId: response.jobId, intent, ...(response.executionScope ? { executionScope: response.executionScope } : {}), startedAtMs: Date.now(), steps: [], logLine: null, outcome: null }, cursor: 0, hydrated: false };
            state.records.set(targetKey, record);
            publish(target, record.job);
        }
        const record = state.records.get(targetKey);
        if (!record) throw new AgentInstallJobRpcError('job_not_found');
        // Native admission is already acknowledged. Discovery must not turn that
        // acknowledgement into a failed start if the Account retires while reading.
        void (async () => {
            // Fetch daemon-owned timing and steps through the shared discovery request.
            try { await ensureMachineAgentInstallJobs(target); } catch { /* Read still resumes the admitted job. */ }
            if (state.controller.signal.aborted) return;
            const current = state.records.get(targetKey);
            if (current) void observe(state, current);
        })();
        return record.job;
    })().finally(() => { if (shareAdmission) state.starts.delete(targetKey); });
    if (shareAdmission) state.starts.set(targetKey, promise);
    return promise;
}

export async function cancelAgentInstallJob(target: AgentInstallJobTarget): Promise<void> {
    const state = machine(target);
    const targetKey = buildMachineAgentInventoryKey(target);
    const record = state.records.get(targetKey);
    if (!record) {
        if (state.jobs.has(targetKey)) throw new AgentInstallJobRpcError('job_not_found');
        return;
    }
    if (record.job.outcome) return;
    const response = await cancelMachineAgentInstallJob(target, record.job.jobId);
    if (!response.ok) throw new AgentInstallJobRpcError(response.errorCode, response.error);
}

/** Action cancellation addresses the exact admitted job, including one discovered after remount. */
export async function cancelMachineAgentInstallJob(target: MachineAgentInstallJobTarget, jobId: string): Promise<DaemonAgentInstallCancelResponse> {
    const state = machine(target);
    const response = await cancelAgentInstallJobRpc({ ...target, signal: state.controller.signal }, { jobId });
    requireCurrent(state);
    if (!response.ok) return response;
    observeMachineAgentInstallJobCancellation(target, jobId);
    return response;
}

/** Resume the same job's cursor after an accepted cancellation, including an unmounted row. */
export function observeMachineAgentInstallJobCancellation(target: MachineAgentInstallJobTarget, jobId: string): void {
    const state = machines.get(machineKey(target));
    const record = state && [...state.records.values()].find((candidate) => candidate.job.jobId === jobId);
    if (state && record) void observe(state, record);
}

/** Queue and update adapters await the daemon job's terminal outcome. */
export function waitForAgentInstallJob(target: AgentInstallJobTarget): Promise<NonNullable<MachineAgentJob['outcome']>> {
    return new Promise((resolve, reject) => {
        const inspect = () => {
            const job = readAgentInstallJob(target);
            if (!job) {
                unsubscribe();
                reject(new AgentInstallJobRpcError('job_not_found'));
            } else if (job.outcome) {
                unsubscribe();
                resolve(job.outcome);
            } else if (job.readFailure) {
                unsubscribe();
                reject(new AgentInstallJobRpcError(job.readFailure));
            }
        };
        const unsubscribe = subscribeAgentInstallJob(target, inspect);
        inspect();
    });
}
