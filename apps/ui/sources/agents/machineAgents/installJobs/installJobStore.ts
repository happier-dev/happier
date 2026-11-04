import type { AgentInstallJob, AgentInstallJobConsent, AgentInstallJobEvent, AgentInstallJobIntent, DaemonAgentInstallCancelResponse, DaemonAgentInstallStartRequest } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { buildMachineAgentInventoryKey } from '@happier-dev/protocol/capabilities';

import { MACHINE_RPC_POLL_INTERVAL_MS } from '@/sync/ops/machineRpcPollInterval';
import { serverAccountScopedResourceKey, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { machineAgentInventoryStore } from '../machineAgentInventoryStore';
import type { MachineAgentJob, MachineAgentJobStep } from '../machineAgentTypes';
import { AgentInstallJobRpcError, cancelAgentInstallJobRpc, listAgentInstallJobsRpc, readAgentInstallJobRpc, startAgentInstallJobRpc } from './api';

export type MachineAgentInstallJobTarget = ServerAccountScope & Readonly<{ machineId: string }>;
export type AgentInstallJobTarget = MachineAgentInstallJobTarget & Readonly<{ agentId: string; definitionId?: string }>;
export type AgentInstallJobStartOptions = Readonly<{ consent: AgentInstallJobConsent; force?: boolean;
    expectedDefinitionVersion?: DaemonAgentInstallStartRequest['expectedDefinitionVersion'] }>;

type JobRecord = { target: AgentInstallJobTarget; job: MachineAgentJob; cursor: number; hydrated: boolean; polling: boolean; timer?: ReturnType<typeof setTimeout> };
type JobDiscovery = { controller: AbortController; promise: Promise<void>; readers: number };
type MachineJobs = { target: MachineAgentInstallJobTarget; controller: AbortController; jobs: ReadonlyMap<string, MachineAgentJob>; records: Map<string, JobRecord>; listeners: Set<() => void>; agentListeners: Map<string, Set<() => void>>; loading?: JobDiscovery; starts: Map<string, Promise<MachineAgentJob>> };
const machines = new Map<string, MachineJobs>();
const machineKey = (target: MachineAgentInstallJobTarget) => serverAccountScopedResourceKey(target, 'agent-install-jobs', target.machineId);
const inventoryKey = (target: MachineAgentInstallJobTarget) => serverAccountScopedResourceKey(target, 'machine-agents', target.machineId);

// Closing a presenter must not stop a daemon job; replacing its credential must stop
// this Account's reads immediately. The shared credential fanout owns that distinction.
subscribeHomeCredentialChange(({ serverId }) => {
    for (const [key, state] of [...machines]) {
        if (state.target.serverId !== serverId) continue;
        state.controller.abort();
        for (const record of state.records.values()) if (record.timer) clearTimeout(record.timer);
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

export function readAgentInstallJob(target: AgentInstallJobTarget): MachineAgentJob | null {
    return machine(target).jobs.get(buildMachineAgentInventoryKey(target)) ?? null;
}

export function readMachineAgentInstallJobs(target: MachineAgentInstallJobTarget): ReadonlyMap<string, MachineAgentJob> {
    return machine(target).jobs;
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
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) state.agentListeners.delete(targetKey);
    };
}

export function subscribeMachineAgentInstallJobs(target: MachineAgentInstallJobTarget, listener: () => void): () => void {
    const listeners = machine(target).listeners;
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function fromWire(job: AgentInstallJob): MachineAgentJob {
    return {
        jobId: job.jobId, intent: job.intent, startedAtMs: job.startedAt, logLine: null, outcome: job.outcome,
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

async function poll(target: AgentInstallJobTarget, record: JobRecord): Promise<void> {
    const state = machine(target);
    const targetKey = buildMachineAgentInventoryKey(target);
    if (state.controller.signal.aborted || record.polling || record.job.outcome || state.records.get(targetKey) !== record) return;
    record.polling = true;
    try {
        const response = await readAgentInstallJobRpc({ ...target, signal: state.controller.signal }, { jobId: record.job.jobId, cursor: record.cursor });
        if (state.controller.signal.aborted || state.records.get(targetKey) !== record) return;
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
                    // Discovery can lose the connection too. Keep the last projection and
                    // retry through the same poll owner rather than declaring an outcome.
                    if (!state.controller.signal.aborted && !state.records.has(targetKey)) state.records.set(targetKey, record);
                    throw error;
                }
                if (!state.records.has(targetKey)) publish(target, null);
                return;
            }
            throw new AgentInstallJobRpcError(response.errorCode, response.error);
        }
        let next = applyEvents(record.job, response.events);
        if (response.outcome && JSON.stringify(next.outcome) !== JSON.stringify(response.outcome)) next = { ...next, outcome: response.outcome };
        record.cursor = response.nextCursor;
        record.job = next;
        publish(target, next);
        if (response.done) return;
    } catch {
        // A disconnected presenter cannot establish a daemon outcome. Keep the job and cursor;
        // the next read resumes it, and job_not_found handles a daemon restart.
    } finally {
        record.polling = false;
    }
    if (!state.controller.signal.aborted && state.records.get(targetKey) === record && !record.job.outcome) {
        record.timer = setTimeout(() => { void poll(target, record); }, MACHINE_RPC_POLL_INTERVAL_MS);
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
                if (previous?.job.jobId === wire.jobId && previous.hydrated) continue;
                if (wire.done && previous && previous.job.jobId !== wire.jobId && previous.job.startedAtMs > wire.startedAt) continue;
                if (previous?.timer) clearTimeout(previous.timer);
                const agentTarget = { ...target, agentId: wire.agentId, definitionId: wire.definitionId };
                const record: JobRecord = { target: agentTarget, job: fromWire(wire), cursor: 0, hydrated: true, polling: false };
                state.records.set(targetKey, record);
                publish(agentTarget, record.job);
                if (!wire.done) void poll(agentTarget, record);
            }
        })().finally(() => {
            state.controller.signal.removeEventListener('abort', retire);
            if (state.loading?.controller === controller) state.loading = undefined;
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
            if (previous?.timer) clearTimeout(previous.timer);
            const record: JobRecord = { target, job: { jobId: response.jobId, intent, startedAtMs: Date.now(), steps: [], logLine: null, outcome: null }, cursor: 0, hydrated: false, polling: false };
            state.records.set(targetKey, record);
            publish(target, record.job);
        }
        const record = state.records.get(targetKey);
        if (!record) throw new AgentInstallJobRpcError('job_not_found');
        // Native admission is already acknowledged. Discovery must not turn that
        // acknowledgement into a failed start if the Account retires while reading.
        void (async () => {
            // Fetch daemon-owned timing/steps before polling, sharing any mount-time list request.
            try { await ensureMachineAgentInstallJobs(target); } catch { /* Read still resumes the admitted job. */ }
            if (state.controller.signal.aborted) return;
            const current = state.records.get(targetKey);
            if (current) void poll(target, current);
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
    const record = [...state.records.values()].find((candidate) => candidate.job.jobId === jobId);
    if (record) {
        if (record.timer) clearTimeout(record.timer);
        void poll(record.target, record);
    }
    return response;
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
            }
        };
        const unsubscribe = subscribeAgentInstallJob(target, inspect);
        inspect();
    });
}
