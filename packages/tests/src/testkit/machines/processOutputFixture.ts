import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import type { ProcessCensusDependencies, ProcessCensusRow } from '../../../../../apps/cli/src/processes/census/processCensus';
import type { HappierProcessRoot } from '../../../../../apps/cli/src/daemon/processes/ownership/types';
import { createProcessOwnershipRuntime } from '../../../../../apps/cli/src/daemon/processes/ownership/processOwnershipRuntime';
import { resolveProcessOwnerRequester } from '../../../../../apps/cli/src/daemon/processes/ownership/resolveProcessOwnerRequester';
import { createLeftBehindPass } from '../../../../../apps/cli/src/daemon/processes/leftBehind/leftBehindPass';
import { createMachineProcessesView } from '../../../../../apps/cli/src/daemon/processes/view/createMachineProcessesView';
import { processRef } from '../../../../../apps/cli/src/daemon/processes/view/processRef';
import { createProcessActionExecutor } from '../../../../../apps/cli/src/daemon/processes/actions/processActionExecutor';
import { registerDaemonProcessesRpcHandlers } from '../../../../../apps/cli/src/rpc/handlers/daemonProcesses';
import { registerDaemonMachineGuardRpcHandlers } from '../../../../../apps/cli/src/rpc/handlers/daemonMachineGuard';
import { buildActionExecutorContextForRpc } from '../../../../../apps/cli/src/rpc/handlers/_actionDispatchAdapter';
import { createMachineVitalsSampler } from '../../../../../apps/cli/src/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '../../../../../apps/cli/src/daemon/vitals/history/minuteHistoryStore';
import { createMachineResourceSummary } from '../../../../../apps/cli/src/daemon/resources/machineResourceSummary';
import { createStoragePolicyFixture } from '../../../../../apps/cli/src/storage/storagePolicy.testkit';
import { createManagedActivityInventory } from '../../../../../apps/cli/src/daemon/lifecycle/managedActivity';
import { createActivityLog } from '../../../../../apps/cli/src/daemon/guard/activityLog';
import { createGuardRuntime } from '../../../../../apps/cli/src/daemon/guard/guardRuntime';
import type { GuardOwnership } from '../../../../../apps/cli/src/daemon/guard/guardPlanner';
import { createGuardWatch } from '../../../../../apps/cli/src/daemon/guard/view/guardWatch';
import { createSessionMemoryCeiling } from '../../../../../apps/cli/src/daemon/platform/linux/sessionMemoryCeiling';
import { createUnavailableActionTransportDeps } from '../../../../../apps/cli/src/testkit/actionTransportDeps';
import { nativeOutputTarget, createNativeOutputRpcManager, invokeNativeOutput } from './nativeOutputFixture';

const target = nativeOutputTarget;
const scope = '123456789abc';
const sessionId = 'output-contract-session';
const sessionPid = 30;
const owner = { kind: 'session', sessionId } as const;

/** Native helper responses and signals are the OS boundary. Census decoding,
 * ownership, process control, Guard planning and RPC output producers stay real. */
export async function createProcessOutputFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'machines-output-processes-'));
  const cleanup: (() => void | Promise<void>)[] = [() => rm(directory, { recursive: true, force: true })];
  try {
    const rows = new Map<number, ProcessCensusRow>();
    const row = (pid: number, marker?: string): ProcessCensusRow => ({
      pid, ppid: 1, pgid: pid, start: { startTimeMs: pid * 10, native: `darwin-proc:${pid}:0:${pid}` },
      principal: { kind: 'uid', value: '501' }, name: 'contract-worker', argv: ['contract-worker'],
      cpuTimeUs: 0, memory: { bytes: 4096, kind: 'rss' }, ...(marker ? { ownerTag: marker } : {}),
    });
    rows.set(process.pid, row(process.pid));
    rows.set(sessionPid, row(sessionPid, `v1.${scope}.session.${sessionId}`));
    const roots: HappierProcessRoot[] = [{ owner, pid: sessionPid, start: rows.get(sessionPid)!.start,
      live: true, ownerCreatedAtMs: 0,
      requesterWorkAttributionV1: { ...target, accountId: target.custodianAccountId } }];
    const censusDependencies: ProcessCensusDependencies = {
      platform: 'darwin', selfPid: process.pid, helperExecutablePath: '/fixture/native-process-helper',
      execFile: async () => ({ stdout: JSON.stringify({ v: 1, capturedAtMs: Date.now(), logicalCpus: 4,
        rows: [...rows.values()], partial: [] }) }),
    };
    const ownership = createProcessOwnershipRuntime({ platform: 'darwin', selfPid: process.pid,
      daemonScopeKey: scope, censusDependencies, listRoots: () => roots });
    const leftBehind = createLeftBehindPass({ processOwnershipRuntime: ownership });
    cleanup.push(() => leftBehind.dispose());
    const sampler = createMachineVitalsSampler({
      readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
      historyStore: await createMinuteHistoryStore({ directory: join(directory, 'history') }),
    });
    cleanup.push(() => sampler.stop());
    await sampler.start();
    const requesterForOwner = (candidate: Parameters<typeof resolveProcessOwnerRequester>[0], currentRoots: readonly HappierProcessRoot[]) =>
      resolveProcessOwnerRequester(candidate, currentRoots, { target, custodianAccountId: target.custodianAccountId });
    const view = createMachineProcessesView({ processOwnershipRuntime: ownership, leftBehind, machineVitals: sampler,
      platform: 'darwin', selfPid: process.pid, allProcessesVisible: () => true, requesterForOwner });
    cleanup.push(() => view.dispose());
    const signals: number[] = [];
    const actions = createProcessActionExecutor({ ownership, leftBehind, requesterForOwner,
      platform: 'darwin', selfPid: process.pid, allProcessesVisible: () => true,
      systemBoundary: { platform: 'darwin', censusDependencies,
        kill(pid) {
          // This callback never calls process.kill or another native signal API.
          if (pid !== sessionPid) throw new Error('Unexpected fixture signal target');
          signals.push(pid); rows.delete(pid);
        }, wait: async () => {},
      },
    });
    const manager = createNativeOutputRpcManager();
    registerDaemonProcessesRpcHandlers(manager, { view, actions, target: () => target });

    const summary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
    cleanup.push(() => summary.stop());
    const activity = await createActivityLog({ activeServerDir: directory, resourceSummary: summary });
    const policy = await createStoragePolicyFixture();
    cleanup.push(() => policy.stop());
    const inventory = createManagedActivityInventory({ now: Date.now, producers: [] });
    cleanup.push(() => inventory.dispose());
    const readFacts = async (observed?: GuardOwnership) => ({
      ownership: observed ?? await ownership.readOwners({ freshness: 'fresh' }), inventory: await inventory.read(), targets: [],
    });
    const readPolicy = () => {
      const current = policy.read();
      if (current.status !== 'ready') throw new Error('Fixture Guard policy unavailable');
      return current.policy.guard;
    };
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected inactive Guard transport'); };
    const runtime = createGuardRuntime({ vitals: sampler, readPolicy, subscribePolicy: policy.subscribe,
      subscribe: inventory.subscribe, readFacts: () => readFacts(), activity,
      stop: unexpected, notice: unexpected, notifyEpisode: unexpected, onError: error => { throw error; } });
    const guard = createGuardWatch({ policy, sampler, ownership, readFacts,
      readTarget: () => target, activityLog: activity, sessionState: runtime,
      readState: () => ({ v: 1, capabilities: { memoryPressure: { status: 'available' },
        ceiling: { status: 'unavailable', reason: 'no_user_manager' }, keepAwake: { modes: ['off'] } }, keepAwakeHolding: false }),
      readLeftBehind: () => ({ count: leftBehind.confirmed().length, footprintBytes: 0 }), subscribe: runtime.subscribe,
    });
    cleanup.push(() => guard.dispose());
    // No tracked Linux Session exists in this Darwin census. The real ceiling
    // owner answers its declared next-start branch without touching host cgroups.
    const ceiling = createSessionMemoryCeiling({ activeServerDir: directory,
      capability: { status: 'available' }, activityLog: activity, readPolicy, readSessions: async () => [],
      readEligibility: unexpected, stopSession: unexpected, notice: unexpected, notify: unexpected });
    cleanup.push(() => ceiling.stop());
    let guardAction: NonNullable<ActionExecutorDeps['machineGuardAction']>;
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineGuardAction: args => guardAction(args) });
    guardAction = registerDaemonMachineGuardRpcHandlers(manager, { target: () => target, guard, activity,
      keepRunning: async input => ({ status: await runtime.keepRunning(input.sessionId ?? '') }),
      setSessionCeiling: (input, _requester, signal) => ceiling.apply(input, signal),
      dispatchUndoAction: async (input, context) => {
        const actionContext = buildActionExecutorContextForRpc({ ...context, serverId: target.serverId,
          externalActionTarget: { kind: 'machine', machineId: target.machineId }, runtimeAccountId: target.custodianAccountId });
        // Receiving RPC already admitted this request. Invoke its real Guard
        // owner; a recorded restoration would use the canonical Action executor.
        const result = await guardAction({ actionId: 'machines.guard.activity.undo', input, context: actionContext,
          executeCanonicalAction: (id, childInput) => executor.execute(id, childInput, actionContext) });
        return { ok: true, result };
      },
    });
    const ref = processRef(sessionPid, roots[0]!.start);
    const processTarget = async () => {
      const current = await ownership.readOwners({ freshness: 'fresh' });
      if (current.status !== 'ok') throw new Error('Fixture process census unavailable');
      const selected = current.rows.find(item => item.pid === sessionPid);
      if (!selected) throw new Error('Fixture process was already ended');
      return { ref, expect: { level: selected.level, ...(selected.owner ? { owner: selected.owner } : {}) } };
    };
    return { target: { serverId: target.serverId, machineId: target.machineId }, ref, processTarget, signals,
      invoke: (id: ActionId, input: unknown) => invokeNativeOutput(manager, id, input),
      close: async () => { for (const release of cleanup.splice(0).reverse()) await release(); },
    };
  } catch (error) { for (const release of cleanup.splice(0).reverse()) await release(); throw error; }
}

export type ProcessOutputFixture = Awaited<ReturnType<typeof createProcessOutputFixture>>;
type ProcessOutputCase = Readonly<{ input(fixture: ProcessOutputFixture): unknown | Promise<unknown>;
  execute?(fixture: ProcessOutputFixture, input: unknown): Promise<unknown> }>;
export const processOutputCases = new Map<ActionId, ProcessOutputCase>([
  ['machines.processes.list', { input: f => ({ ...f.target, scope: 'all', view: 'tree' }) }],
  ['machines.processes.get', { input: f => ({ ...f.target, ref: f.ref }) }],
  ['machines.processes.check', { input: f => ({ ...f.target, refs: [f.ref] }) }],
  // This Session has no lifecycle stop adapter: its real owner directs the
  // person to Kill, rather than a fixture inventing a successful Stop receipt.
  ['machines.processes.stop', { input: async f => ({ ...f.target, targets: [await f.processTarget()] }) }],
  ['machines.processes.startAgain', { input: f => ({ ...f.target, ref: f.ref }) }],
  ['machines.processes.kill', { input: async f => ({ ...f.target, targets: [await f.processTarget()], tree: false }) }],
  ['machines.processes.leftBehind.cleanUp', { input: f => ({ ...f.target, refs: [f.ref] }) }],
  ['machines.guard.get', { input: f => f.target }],
  ['machines.guard.activity.list', { input: f => ({ ...f.target, range: 'today' }) }],
  ['machines.guard.activity.undo', { input: f => ({ ...f.target, entryId: 'absent-activity-entry' }) }],
  ['machines.guard.idleStop.keepRunning', { input: f => ({ ...f.target, sessionId }) }],
  ['machines.guard.sessionCeiling.set', { input: f => ({ ...f.target, sessionId, bytes: null }) }],
]);
