import { freemem, totalmem } from 'node:os';

import type { ActionExecuteResult } from '@happier-dev/protocol/actions';
import type { MachineFinitePolicyGetResultV1 } from '@happier-dev/protocol/machines/machineFinitePolicyV1';
import type { FiniteAdmissionV1, ProjectWorkerDependencyV1, ProjectWorkerMemoryObservationV1, WorkerLoadObservationV1 } from '@happier-dev/protocol/workspaces/projectWorkerExecutionV1';
import type { ProjectMemoryDemandV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectMemoryDemandV1';

import type { DaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';

export type ProjectWorkerDependency = Readonly<ProjectWorkerDependencyV1>;

/** Real preparation/process observations; uncertainty never proves settlement. */
export type ProjectWorkerReservationOutcome = Readonly<{
  kind: 'no_launch' | 'process_settled' | 'outcome_uncertain';
  result: ActionExecuteResult;
}>;
export type ProjectWorkerMemoryObservation = Readonly<ProjectWorkerMemoryObservationV1>;
export type ProjectWorkerFiniteEligibility = Readonly<{
  eligible: boolean;
  reason?: 'not_accepting' | 'draining' | 'memory_insufficient' | 'memory_unavailable' | 'policy_unavailable';
  load: WorkerLoadObservationV1;
  observedMemory?: ProjectWorkerMemoryObservation;
}>;
export type ProjectWorkerServiceEligibility = Readonly<{
  eligible: boolean;
  reason?: 'draining' | 'memory_insufficient' | 'memory_unavailable';
  load: WorkerLoadObservationV1;
  observedMemory?: ProjectWorkerMemoryObservation;
}>;
export type ProjectWorkerAdmissionRequest = Readonly<{
  operationId: string;
  workspaceRefId: string;
  relationshipId?: string;
  /** Both endpoint bindings of each actual accepted Sync preparation edge. */
  relatedWorkspaces?: readonly Readonly<{ workspaceRefId: string; relationshipId?: string }>[];
  requesterAccountId?: string;
  memoryDemand?: ProjectMemoryDemandV1;
  signal: AbortSignal;
  accept(handle: Extract<FiniteAdmissionV1, { kind: 'accepted' }>): void;
  onQueue?(ahead: number): void;
  onReserved?(): void;
  onUnknown?(error: unknown): void;
  run(context: Readonly<{ signal: AbortSignal; phase(phase: 'copying' | 'setup' | 'running'): void }>): Promise<ProjectWorkerReservationOutcome>;
}>;

type Entry = {
  request: ProjectWorkerAdmissionRequest;
  state: ProjectWorkerDependency['state'];
  bytes: number;
  relatedWorkspaces: NonNullable<ProjectWorkerAdmissionRequest['relatedWorkspaces']>;
  resolve(result: ActionExecuteResult): void;
  removeAbortListener(): void;
};

const cancelled = (): ActionExecuteResult => ({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
const refused = (reason: Extract<FiniteAdmissionV1, { kind: 'not_accepted' }>['reason']): ActionExecuteResult => (
  { ok: true, result: { kind: 'not_accepted', reason } satisfies FiniteAdmissionV1 }
);

/** Process-local FIFO only. Action operations own identity/replay; the process owner owns settlement. */
export function createProjectWorkerAdmission(options: Readonly<{
  machineId: string;
  readPolicy: () => Promise<MachineFinitePolicyGetResultV1>;
  admissionDrain: DaemonAdmissionDrain;
  readMemory?: () => ProjectWorkerMemoryObservation | null;
}>) {
  const entries = new Map<string, Entry>();
  const queue: Entry[] = [];
  const listeners = new Set<() => void>();
  const readMemory = options.readMemory ?? (() => ({ totalBytes: totalmem(), availableBytes: freemem() }));
  let admissionTail: Promise<void> = Promise.resolve();
  let pumping: Promise<void> | null = null;
  let changedWhilePumping = false;

  async function readPolicy(): Promise<MachineFinitePolicyGetResultV1> {
    try { return await options.readPolicy(); } catch { return { status: 'unavailable' }; }
  }
  function memory(): ProjectWorkerMemoryObservation | null {
    try {
      const observation = readMemory();
      return observation && Number.isSafeInteger(observation.totalBytes) && observation.totalBytes > 0
        && Number.isSafeInteger(observation.availableBytes) && observation.availableBytes >= 0
        && observation.availableBytes <= observation.totalBytes ? observation : null;
    } catch { return null; }
  }
  function reservations() { return [...entries.values()].filter(entry => entry.state !== 'queued'); }
  function observedLoad(policy: MachineFinitePolicyGetResultV1): WorkerLoadObservationV1 {
    return policy.status !== 'ready' ? { kind: 'unknown' } : {
      kind: 'known', running: reservations().length, queued: queue.length,
      accepting: policy.policy.accepting && !options.admissionDrain.isQuiescing(), runAtMost: policy.policy.runAtMost,
    };
  }
  function assessMemory(memoryDemand?: ProjectMemoryDemandV1): Readonly<{
    reason?: 'memory_insufficient' | 'memory_unavailable';
    observedMemory?: ProjectWorkerMemoryObservation;
  }> {
    if (!memoryDemand) return {};
    const observation = memory();
    if (!observation) return { reason: 'memory_unavailable' };
    if (memoryDemand.bytes > observation.totalBytes) return { reason: 'memory_insufficient', observedMemory: observation };
    return {};
  }
  async function assessAdmission(memoryDemand?: ProjectMemoryDemandV1) {
    const policy = await readPolicy();
    let reason: ProjectWorkerFiniteEligibility['reason'];
    let observedMemory: ProjectWorkerMemoryObservation | undefined;
    if (options.admissionDrain.isQuiescing()) reason = 'draining';
    else if (policy.status !== 'ready') reason = 'policy_unavailable';
    else if (!policy.policy.accepting) reason = 'not_accepting';
    else ({ reason, observedMemory } = assessMemory(memoryDemand));
    return { policy, reason, observedMemory };
  }
  function changed() {
    queue.forEach((entry, ahead) => entry.request.onQueue?.(ahead));
    for (const listener of listeners) listener();
  }
  function finish(entry: Entry, result: ActionExecuteResult) {
    if (entries.get(entry.request.operationId) !== entry) return;
    const queuedIndex = queue.indexOf(entry);
    if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
    entries.delete(entry.request.operationId);
    entry.removeAbortListener();
    entry.resolve(result);
    changed();
    void notifyChanged();
  }
  async function pump() {
    do {
      changedWhilePumping = false;
      while (queue.length) {
        const policy = await readPolicy();
        if (policy.status !== 'ready') break;
        const entry = queue[0];
        if (!entry) break;
        if (entry.request.signal.aborted) { finish(entry, cancelled()); continue; }
        const active = reservations();
        if (policy.policy.runAtMost !== null && active.length >= policy.policy.runAtMost) break;
        if (entry.bytes > 0) {
          const observation = memory();
          // Execution-owner notifications/operation inspection can recover telemetry. Accepted custody stays put.
          if (!observation) break;
          if (entry.bytes > observation.totalBytes) {
            finish(entry, { ok: false, errorCode: 'memory_insufficient', error: 'memory_insufficient' });
            continue;
          }
          // Free already includes RSS. Held demand is compared to total separately, never subtracted from free.
          const heldBytes = active.reduce((sum, held) => sum + held.bytes, 0);
          if (entry.bytes > observation.availableBytes || entry.bytes > observation.totalBytes - heldBytes) break;
        }
        queue.shift();
        entry.state = 'reserved';
        entry.request.onReserved?.();
        changed();
        // No work has entered the preparation/process owner yet, so this is a proved no-launch cancellation.
        if (entry.request.signal.aborted) { finish(entry, cancelled()); continue; }
        void (async () => {
          try {
            const outcome = await entry.request.run({ signal: entry.request.signal, phase: phase => {
              if (entries.get(entry.request.operationId) !== entry) return;
              entry.state = phase;
              changed();
            } });
            if (outcome.kind === 'outcome_uncertain') {
              entry.request.onUnknown?.(outcome);
              return;
            }
            finish(entry, outcome.result);
          } catch (error) {
            // A rejected launch/stop may have produced descendants. It is not a process-terminal fact.
            entry.request.onUnknown?.(error);
          }
        })();
      }
    } while (changedWhilePumping);
  }
  function notifyChanged(): Promise<void> {
    changedWhilePumping = true;
    if (!pumping) {
      pumping = pump().finally(() => { pumping = null; });
    }
    return pumping;
  }

  return Object.freeze({
    execute(request: ProjectWorkerAdmissionRequest): Promise<ActionExecuteResult> {
      // Preserve invocation order across asynchronous policy reads; the runner already coalesces operation requests.
      let resolve!: (result: ActionExecuteResult) => void;
      const result = new Promise<ActionExecuteResult>(accept => { resolve = accept; });
      admissionTail = admissionTail.then(async () => {
        if (request.signal.aborted) { resolve(cancelled()); return; }
        if (options.admissionDrain.isQuiescing()) { resolve(refused('draining')); return; }
        const assessment = await assessAdmission(request.memoryDemand);
        if (request.signal.aborted) { resolve(cancelled()); return; }
        if (assessment.reason === 'policy_unavailable') {
          resolve({ ok: false, errorCode: 'project_worker_policy_unavailable', error: 'project_worker_policy_unavailable' });
          return;
        }
        if (assessment.reason) { resolve(refused(assessment.reason)); return; }
        const bytes = request.memoryDemand?.bytes ?? 0;
        const relatedWorkspaces = [{ workspaceRefId: request.workspaceRefId,
          ...(request.relationshipId ? { relationshipId: request.relationshipId } : {}) }, ...(request.relatedWorkspaces ?? [])]
          .map(related => ({ workspaceRefId: related.workspaceRefId,
            ...(related.relationshipId ? { relationshipId: related.relationshipId } : {}) }));
        const entry: Entry = { request, state: 'queued', bytes, relatedWorkspaces, resolve, removeAbortListener: () => undefined };
        const abort = () => { if (entry.state === 'queued') finish(entry, cancelled()); };
        request.signal.addEventListener('abort', abort, { once: true });
        entry.removeAbortListener = () => request.signal.removeEventListener('abort', abort);
        entries.set(request.operationId, entry);
        queue.push(entry);
        request.accept({ kind: 'accepted', operationId: request.operationId, machineId: options.machineId,
          workspaceRefId: request.workspaceRefId });
        changed();
        void notifyChanged();
      }).catch(error => {
        // Pre-acceptance failures cannot acquire a reservation. Accepted callback failures leave custody intact.
        if (!entries.has(request.operationId)) resolve({ ok: false, errorCode: 'project_worker_admission_failed',
          error: error instanceof Error ? error.message : 'project_worker_admission_failed' });
      });
      return result;
    },
    notifyChanged,
    async observeFiniteEligibility(memoryDemand?: ProjectMemoryDemandV1): Promise<ProjectWorkerFiniteEligibility> {
      const { policy, reason, observedMemory } = await assessAdmission(memoryDemand);
      // Advisory inspection never pumps accepted work or acquires a reservation.
      return { eligible: reason === undefined, ...(reason ? { reason } : {}), load: observedLoad(policy),
        ...(observedMemory ? { observedMemory } : {}) };
    },
    async observeServiceEligibility(memoryDemand?: ProjectMemoryDemandV1): Promise<ProjectWorkerServiceEligibility> {
      const policy = await readPolicy();
      const assessment = options.admissionDrain.isQuiescing() ? { reason: 'draining' as const } : assessMemory(memoryDemand);
      const { reason } = assessment;
      // Finite policy is a load observation, not service acceptance or a lifetime slot.
      return { eligible: reason === undefined, ...(reason ? { reason } : {}), load: observedLoad(policy),
        ...('observedMemory' in assessment && assessment.observedMemory ? { observedMemory: assessment.observedMemory } : {}) };
    },
    async load(): Promise<WorkerLoadObservationV1> {
      await notifyChanged();
      return observedLoad(await readPolicy());
    },
    dependencies(filter: Readonly<{ workspaceRefId?: string; relationshipId?: string; requesterAccountId?: string }> = {}): readonly ProjectWorkerDependency[] {
      return [...entries.values()].filter(entry => (filter.requesterAccountId === undefined || entry.request.requesterAccountId === filter.requesterAccountId)
        && entry.relatedWorkspaces.some(related => (filter.workspaceRefId === undefined || related.workspaceRefId === filter.workspaceRefId)
          && (filter.relationshipId === undefined || related.relationshipId === filter.relationshipId))).map(entry => {
        const relationshipId = filter.relationshipId ?? entry.request.relationshipId;
        return { operationId: entry.request.operationId, workspaceRefId: entry.request.workspaceRefId, state: entry.state,
          ...(relationshipId ? { relationshipId } : {}) };
      });
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
}

export type ProjectWorkerAdmission = ReturnType<typeof createProjectWorkerAdmission>;
