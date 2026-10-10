import { totalmem } from 'node:os';
import { describe, expect, it } from 'vitest';

import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { getMachineFinitePolicyV1, type MachineFinitePolicyMetadataPortV1 } from '@happier-dev/protocol/machines/machineFinitePolicyV1';
import type { ProjectMemoryDemandV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectMemoryDemandV1';

import { createProjectWorkerAdmission, type ProjectWorkerReservationOutcome } from './projectWorkerAdmission';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const success: ProjectWorkerReservationOutcome = { kind: 'process_settled', result: { ok: true, result: { exitCode: 0 } } };
const scope = { accountId: 'requester', machineId: 'target' };

function harness(runAtMost: number | null = 1) {
  let policy = { accepting: true, runAtMost };
  let policyUnavailable = false;
  let memory: { totalBytes: number; availableBytes: number } | null = { totalBytes: 100, availableBytes: 100 };
  const policyPort: MachineFinitePolicyMetadataPortV1 = {
    read: async () => policyUnavailable ? { status: 'unavailable' } : {
      status: 'ready', metadata: { finitePolicyV1: policy }, metadataVersion: 1,
    },
    compareAndSwap: async () => ({ status: 'unavailable' }),
  };
  const drain = createDaemonAdmissionDrain();
  const admission = createProjectWorkerAdmission({ machineId: scope.machineId, readPolicy: () => getMachineFinitePolicyV1(policyPort), admissionDrain: drain,
    readMemory: () => memory });
  const store = createActionOperationStore();
  let sequence = 0;
  const runner = createActionOperationRunner({ store, generateOperationId: () => `op-${++sequence}`,
    resolveAction: actionId => ({ actionId, title: 'Run script', operation: {
      version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
    } }),
  });
  const started: string[] = [];
  const acceptedHandles: unknown[] = [];
  const unknownOutcomes: unknown[] = [];
  const gates = new Map<string, ReturnType<typeof deferred<ProjectWorkerReservationOutcome>>>();
  function run(name: string, demand?: ProjectMemoryDemandV1,
    relatedWorkspaces?: readonly Readonly<{ workspaceRefId: string; relationshipId?: string }>[]) {
    const gate = gates.get(name) ?? deferred<ProjectWorkerReservationOutcome>();
    gates.set(name, gate);
    return runner.observe({ actionId: 'projects.script.run', requestId: name, input: { name, ...(demand ? { demand } : {}) }, scope,
      cancellation: 'supported', execute: context => {
        if (!context.operationAcceptance) throw new Error('Missing tracked operation');
        return admission.execute({ operationId: context.operationAcceptance.operationId, workspaceRefId: 'worker-copy',
          relationshipId: relatedWorkspaces?.find(related => related.workspaceRefId === 'worker-copy')?.relationshipId ?? 'relationship',
          relatedWorkspaces, requesterAccountId: scope.accountId, signal: context.signal,
          memoryDemand: demand, accept: handle => {
            acceptedHandles.push(handle);
            context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
              machineId: handle.machineId, workspaceRefId: handle.workspaceRefId, cwd: '/worker-copy' } });
            context.operationAcceptance?.accept(handle);
          },
          onQueue: ahead => context.updateProgress({ phase: 'queued', current: ahead, total: ahead + 1 }),
          onUnknown: outcome => unknownOutcomes.push(outcome),
          run: async reservation => {
            started.push(name); reservation.phase('running');
            context.publishOwnerUpdate({ state: 'running' }); return await gate.promise;
          },
        });
      },
    });
  }
  return { admission, runner, store, drain, started, gates, run, acceptedHandles, unknownOutcomes,
    setPolicy: (next: typeof policy) => { policy = next; },
    setPolicyUnavailable: (next: boolean) => { policyUnavailable = next; },
    setMemory: (next: typeof memory) => { memory = next; },
  };
}

describe('finite target admission and real reservation custody', () => {
  it('observes service eligibility independently of finite accepting and capacity without pumping work', async () => {
    const h = harness();
    const demand = { bytes: 20, basis: { kind: 'declared' } } as const;
    await h.run('resident');
    await h.run('waiting');
    await turn();
    expect(h.started).toEqual(['resident']);
    h.setPolicy({ accepting: false, runAtMost: 1 });
    expect(await h.admission.observeServiceEligibility(demand)).toEqual({ eligible: true,
      load: { kind: 'known', running: 1, queued: 1, accepting: false, runAtMost: 1 } });
    h.setPolicyUnavailable(true);
    expect(await h.admission.observeServiceEligibility(demand)).toEqual({ eligible: true, load: { kind: 'unknown' } });
    h.setMemory({ totalBytes: 100, availableBytes: 1 });
    expect(await h.admission.observeServiceEligibility(demand)).toMatchObject({ eligible: true });
    expect(await h.admission.observeServiceEligibility({ ...demand, bytes: 101 }))
      .toMatchObject({ eligible: false, reason: 'memory_insufficient' });
    h.setMemory(null);
    expect(await h.admission.observeServiceEligibility(demand)).toMatchObject({ eligible: false, reason: 'memory_unavailable' });
    expect(await h.admission.observeServiceEligibility()).toMatchObject({ eligible: true });
    h.drain.beginTemporaryDrain();
    expect(await h.admission.observeServiceEligibility()).toMatchObject({ eligible: false, reason: 'draining' });
    expect(h.started).toEqual(['resident']);
    expect(h.admission.dependencies()).toHaveLength(2);
    h.drain.resume(); h.setPolicyUnavailable(false); h.setPolicy({ accepting: true, runAtMost: 1 });
    h.setMemory({ totalBytes: 100, availableBytes: 100 });
    h.gates.get('resident')!.resolve(success); await turn();
    h.gates.get('waiting')!.resolve(success); await turn();
  });

  it('observes finite eligibility without accepting or launching, preserving free-pressure eligibility and unknown load', async () => {
    const h = harness();
    const demand = { bytes: 20, basis: { kind: 'declared' } } as const;
    const observer = h.admission;
    h.setMemory({ totalBytes: 100, availableBytes: 10 });
    expect(await observer.observeFiniteEligibility(demand)).toEqual({ eligible: true,
      load: { kind: 'known', running: 0, queued: 0, accepting: true, runAtMost: 1 } });
    expect(await observer.observeFiniteEligibility({ ...demand, bytes: 101 }))
      .toMatchObject({ eligible: false, reason: 'memory_insufficient' });
    h.setMemory(null);
    expect(await observer.observeFiniteEligibility(demand)).toMatchObject({ eligible: false, reason: 'memory_unavailable' });
    expect(await observer.observeFiniteEligibility()).toMatchObject({ eligible: true });
    h.setPolicy({ accepting: false, runAtMost: 1 });
    expect(await observer.observeFiniteEligibility()).toMatchObject({ eligible: false, reason: 'not_accepting' });
    h.drain.beginTemporaryDrain();
    expect(await observer.observeFiniteEligibility()).toMatchObject({ eligible: false, reason: 'draining' });
    h.drain.resume(); h.setPolicyUnavailable(true);
    expect(await observer.observeFiniteEligibility(demand)).toEqual({ eligible: false, reason: 'policy_unavailable', load: { kind: 'unknown' } });
    expect(h.acceptedHandles).toEqual([]); expect(h.started).toEqual([]);
    expect(h.admission.dependencies()).toEqual([]); expect(h.store.list(scope).items).toEqual([]);
    h.setPolicyUnavailable(false); h.setPolicy({ accepting: true, runAtMost: 1 });
    h.setMemory({ totalBytes: 100, availableBytes: 10 });
    await h.run('resident'); await h.run('pressure', demand); await turn();
    h.setPolicy({ accepting: true, runAtMost: null }); h.setMemory({ totalBytes: 100, availableBytes: 100 });
    expect(await observer.observeFiniteEligibility(demand)).toEqual({ eligible: true,
      load: { kind: 'known', running: 1, queued: 1, accepting: true, runAtMost: null } });
    expect(h.started).toEqual(['resident']);
    h.gates.get('resident')!.resolve(success); await turn();
    h.gates.get('pressure')!.resolve(success); await turn();
  });

  it('returns exact accepted handles, coalesces request identity and preserves FIFO through unconfirmed Stop', async () => {
    const h = harness();
    expect(await h.run('first')).toMatchObject({ ok: true, result: { operation: { operationId: 'op-1', state: 'accepted' } } });
    expect(await h.run('second')).toMatchObject({ ok: true, result: { operation: { operationId: 'op-2', state: 'accepted' } } });
    expect(await h.run('third')).toMatchObject({ ok: true, result: { operation: { operationId: 'op-3', state: 'accepted' } } });
    expect(h.acceptedHandles).toEqual(['op-1', 'op-2', 'op-3'].map(operationId => ({
      kind: 'accepted', operationId, machineId: 'target', workspaceRefId: 'worker-copy',
    })));
    await turn();
    expect(h.started).toEqual(['first']);
    expect(await h.run('second')).toMatchObject({ ok: true, result: { operation: { operationId: 'op-2' } } });
    expect(await h.runner.observe({ actionId: 'projects.script.run', requestId: 'second', input: { different: true }, scope,
      execute: async () => ({ ok: true, result: null }) })).toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    expect(h.runner.cancel(scope, 'op-1')).toEqual({ kind: 'requested' });
    await turn();
    expect(h.started).toEqual(['first']);
    expect(await h.admission.load()).toMatchObject({ kind: 'known', running: 1, queued: 2 });
    h.gates.get('first')!.resolve(success);
    await turn();
    expect(h.started).toEqual(['first', 'second']);
    h.gates.get('second')!.resolve(success);
    await turn();
    expect(h.started).toEqual(['first', 'second', 'third']);
    h.gates.get('third')!.resolve(success);
    await turn();
    expect(h.store.list(scope).items.every(item => item.state === 'succeeded')).toBe(true);
  });

  it('removes a cancelled queued entry before any later launch and reports dependencies from the real queue', async () => {
    const h = harness();
    await h.run('first'); await h.run('second');
    expect(h.admission.dependencies({ relationshipId: 'relationship' })).toEqual([
      { operationId: 'op-1', workspaceRefId: 'worker-copy', relationshipId: 'relationship', state: 'running' },
      { operationId: 'op-2', workspaceRefId: 'worker-copy', relationshipId: 'relationship', state: 'queued' },
    ]);
    h.runner.cancel(scope, 'op-2');
    await turn();
    expect(h.store.get(scope, 'op-2')?.state).toBe('cancelled');
    h.gates.get('first')!.resolve(success);
    await turn();
    expect(h.started).toEqual(['first']);
    expect(h.admission.dependencies({ workspaceRefId: 'worker-copy' })).toEqual([]);
  });

  it('retains both actual Sync edges and every endpoint dependency without multiplying target operations or reservations', async () => {
    const h = harness();
    const route = [
      { workspaceRefId: 'source', relationshipId: 'source-hub' },
      { workspaceRefId: 'hub', relationshipId: 'source-hub' },
      { workspaceRefId: 'hub', relationshipId: 'hub-target' },
      { workspaceRefId: 'worker-copy', relationshipId: 'hub-target' },
    ];
    await h.run('first', undefined, route); await h.run('next', undefined, route); await turn();
    expect(h.admission.dependencies({ workspaceRefId: 'source' }).map(dependency => dependency.operationId))
      .toEqual(['op-1', 'op-2']);
    expect(h.admission.dependencies({ workspaceRefId: 'hub' }).map(dependency => dependency.operationId))
      .toEqual(['op-1', 'op-2']);
    expect(h.admission.dependencies({ relationshipId: 'source-hub' })).toEqual([
      { operationId: 'op-1', workspaceRefId: 'worker-copy', relationshipId: 'source-hub', state: 'running' },
      { operationId: 'op-2', workspaceRefId: 'worker-copy', relationshipId: 'source-hub', state: 'queued' },
    ]);
    expect(h.admission.dependencies({ relationshipId: 'hub-target' })).toHaveLength(2);
    expect(h.admission.dependencies({ workspaceRefId: 'source', relationshipId: 'hub-target' })).toEqual([]);
    expect(h.admission.dependencies({ requesterAccountId: 'foreign', relationshipId: 'source-hub' })).toEqual([]);
    expect(await h.admission.load()).toMatchObject({ running: 1, queued: 1 });
    h.runner.cancel(scope, 'op-1'); await turn();
    expect(h.admission.dependencies({ relationshipId: 'source-hub' })).toHaveLength(2);
    h.runner.cancel(scope, 'op-2'); await turn();
    expect(h.admission.dependencies({ workspaceRefId: 'source' }).map(dependency => dependency.operationId)).toEqual(['op-1']);
    h.gates.get('first')!.resolve(success); await turn();
    expect(h.started).toEqual(['first']);
    expect(h.admission.dependencies({ workspaceRefId: 'hub' })).toEqual([]);
  });

  it('preserves accepted queue when accepting is off or ceiling is lowered, and reopens temporary drain', async () => {
    const h = harness(2);
    await h.run('first'); await h.run('second'); await h.run('third');
    h.setPolicy({ accepting: false, runAtMost: 1 });
    expect(await h.run('refused')).toMatchObject({ ok: true, result: { kind: 'not_accepted', reason: 'not_accepting' } });
    h.drain.beginTemporaryDrain();
    expect(await h.run('drained')).toMatchObject({ ok: true, result: { kind: 'not_accepted', reason: 'draining' } });
    h.gates.get('first')!.resolve(success); await turn();
    expect(h.started).toEqual(['first', 'second']);
    h.gates.get('second')!.resolve(success); await turn();
    expect(h.started).toEqual(['first', 'second', 'third']);
    h.drain.resume(); h.setPolicy({ accepting: true, runAtMost: 1 });
    expect(await h.run('reopened')).toMatchObject({ ok: true, result: { operation: { state: 'accepted' } } });
    h.gates.get('third')!.resolve(success); await turn();
    expect(h.started).toEqual(['first', 'second', 'third', 'reopened']);
    h.gates.get('reopened')!.resolve(success); await turn();
  });

  it('refuses unavailable policy without treating it as an unlimited worker', async () => {
    const h = harness(); h.setPolicyUnavailable(true);
    expect(await h.run('refused')).toMatchObject({ ok: false, errorCode: 'project_worker_policy_unavailable' });
    expect(h.started).toEqual([]);
    expect(await h.admission.load()).toEqual({ kind: 'unknown' });
  });

  it('holds total declared bytes independently of a null count ceiling and does not subtract RSS twice', async () => {
    const h = harness(null);
    const demand = { bytes: 60, basis: { kind: 'declared' } } as const;
    await h.run('first', demand); await h.run('second', demand);
    await turn();
    expect(h.started).toEqual(['first']);
    expect(await h.admission.load()).toMatchObject({ running: 1, queued: 1, runAtMost: null });
    h.setMemory({ totalBytes: 100, availableBytes: 65 });
    h.gates.get('first')!.resolve(success); await turn();
    expect(h.started).toEqual(['first', 'second']);
    h.gates.get('second')!.resolve(success); await turn();
    const small = { bytes: 30, basis: { kind: 'declared' } } as const;
    await h.run('resident', small);
    h.setMemory({ totalBytes: 100, availableBytes: 35 });
    await h.run('spare', small); await turn();
    expect(h.started).toEqual(['first', 'second', 'resident', 'spare']);
    h.gates.get('resident')!.resolve(success); h.gates.get('spare')!.resolve(success); await turn();
  });

  it('distinguishes permanent total shortage, telemetry refusal and temporary available-memory queueing', async () => {
    const h = harness(null);
    expect(await h.run('too-large', { bytes: 101, basis: { kind: 'declared' } }))
      .toMatchObject({ ok: true, result: { kind: 'not_accepted', reason: 'memory_insufficient' } });
    h.setMemory(null);
    expect(await h.run('unknown', { bytes: 20, basis: { kind: 'declared' } }))
      .toMatchObject({ ok: true, result: { kind: 'not_accepted', reason: 'memory_unavailable' } });
    await h.run('demandless'); await turn();
    expect(h.started).toEqual(['demandless']);
    h.setMemory({ totalBytes: 100, availableBytes: 10 });
    expect(await h.run('pressure', { bytes: 20, basis: { kind: 'declared' } })).toMatchObject({ ok: true, result: { operation: { state: 'accepted' } } });
    await h.run('after-pressure');
    await turn(); expect(h.started).toEqual(['demandless']);
    h.setMemory({ totalBytes: 100, availableBytes: 100 });
    await h.admission.load(); await turn();
    expect(h.started).toEqual(['demandless', 'pressure', 'after-pressure']);
    h.gates.get('demandless')!.resolve(success); h.gates.get('pressure')!.resolve(success);
    h.gates.get('after-pressure')!.resolve(success); await turn();
  });

  it('holds one slot throughout preparation and setup; explicit no-launch failure releases the slot', async () => {
    const h = harness();
    const preparing = deferred<void>();
    const setup = deferred<void>();
    const settled = deferred<ProjectWorkerReservationOutcome>();
    const states: string[] = [];
    let accept!: (handle: unknown) => void;
    const accepted = new Promise(resolve => { accept = resolve; });
    const running = h.admission.execute({ operationId: 'direct', workspaceRefId: 'worker-copy', accept,
      signal: new AbortController().signal,
      run: async context => {
        context.phase('copying'); states.push('copying'); await preparing.promise;
        context.phase('setup'); states.push('setup'); await setup.promise;
        return await settled.promise;
      },
    });
    await accepted; await h.run('next'); await turn();
    expect(await h.admission.load()).toMatchObject({ running: 1, queued: 1 });
    expect(h.admission.dependencies({ workspaceRefId: 'worker-copy' })[0]?.state).toBe('copying');
    preparing.resolve(); await turn();
    expect(states).toEqual(['copying', 'setup']); expect(h.started).toEqual([]);
    expect(h.admission.dependencies({ workspaceRefId: 'worker-copy' })[0]?.state).toBe('setup');
    setup.resolve(); await turn(); expect(states).toEqual(['copying', 'setup']);
    settled.resolve({ kind: 'no_launch', result: { ok: false, errorCode: 'setup_failed', error: 'setup_failed' } });
    await running; await turn(); expect(h.started).toEqual(['next']);
    h.gates.get('next')!.resolve(success); await turn();
  });

  it('does not enter preparation if cancellation arrives at reservation before any work starts', async () => {
    const h = harness();
    const controller = new AbortController();
    let launched = false;
    const result = h.admission.execute({ operationId: 'cancel-at-dequeue', workspaceRefId: 'worker-copy',
      signal: controller.signal, accept: () => undefined, onReserved: () => controller.abort(),
      run: async () => { launched = true; return success; },
    });
    await expect(result).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(launched).toBe(false);
    expect(await h.admission.load()).toMatchObject({ running: 0, queued: 0 });
  });

  it('does not mistake an ambiguous process boundary rejection for settlement', async () => {
    const h = harness();
    const unknown = deferred<unknown>();
    const accepted = deferred<unknown>();
    void h.admission.execute({ operationId: 'ambiguous-launch', workspaceRefId: 'worker-copy',
      signal: new AbortController().signal, accept: accepted.resolve, onUnknown: unknown.resolve,
      run: async () => { throw new Error('Process transport lost after dispatch'); },
    });
    await accepted.promise;
    await expect(unknown.promise).resolves.toBeInstanceOf(Error);
    await h.run('next'); await turn();
    expect(h.started).toEqual([]);
    expect(await h.admission.load()).toMatchObject({ running: 1, queued: 1 });
  });

  it('keeps typed process uncertainty pending in the real operation and reservation instead of releasing FIFO custody', async () => {
    const h = harness();
    await h.run('first'); await h.run('next'); await turn();
    const uncertain = { kind: 'outcome_uncertain', result: { ok: false, errorCode: 'stop_unconfirmed', error: 'stop_unconfirmed' } } as const;
    h.gates.get('first')!.resolve(uncertain);
    await turn();
    expect(h.started).toEqual(['first']);
    expect(h.store.get(scope, 'op-1')?.state).toBe('running');
    expect(await h.admission.load()).toMatchObject({ running: 1, queued: 1 });
    expect(h.unknownOutcomes).toEqual([uncertain]);
    expect(h.admission.dependencies()).toMatchObject([{ operationId: 'op-1', state: 'running' },
      { operationId: 'op-2', state: 'queued' }]);
  });

  it('treats an observed measured label as reviewed bytes without an effect attestation or evidence requirement', async () => {
    const h = harness(null);
    await h.run('declared', { bytes: 60, basis: { kind: 'declared' } });
    const response = await h.run('observed', { bytes: 60, basis: { kind: 'measured' } });
    expect(response).toMatchObject({ ok: true, result: { operation: { state: 'accepted' } } });
    await turn();
    expect(h.started).toEqual(['declared']);
    expect(await h.admission.load()).toMatchObject({ running: 1, queued: 1 });
    h.gates.get('declared')!.resolve(success); await turn();
    expect(h.started).toEqual(['declared', 'observed']);
    h.gates.get('observed')!.resolve(success); await turn();
  });

  it('uses real OS total memory for the production default rather than accepting guessed capacity', async () => {
    const policyPort: MachineFinitePolicyMetadataPortV1 = {
      read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 1 }),
      compareAndSwap: async () => ({ status: 'unavailable' }),
    };
    const admission = createProjectWorkerAdmission({ machineId: 'target', readPolicy: () => getMachineFinitePolicyV1(policyPort),
      admissionDrain: createDaemonAdmissionDrain() });
    let accepted = false;
    let started = false;
    expect(await admission.execute({ operationId: 'too-large-on-os', workspaceRefId: 'worker-copy',
      signal: new AbortController().signal, memoryDemand: { bytes: totalmem() + 1, basis: { kind: 'declared' } },
      accept: () => { accepted = true; }, run: async () => { started = true; return success; },
    })).toMatchObject({ ok: true, result: { kind: 'not_accepted', reason: 'memory_insufficient' } });
    expect(accepted).toBe(false);
    expect(started).toBe(false);
  });
});
