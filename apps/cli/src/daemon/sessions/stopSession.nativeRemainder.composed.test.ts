import { afterEach, expect, it, vi } from 'vitest';

// Procfs and signal delivery are the only substituted boundaries. No native
// process is launched or signalled by this composition.
const native = vi.hoisted(() => ({
  rows: new Map<number, { parent: number; ticks: number; tag?: string; unit?: string; uid?: number }>(),
  unavailable: false,
  captureFailure: null as 'alive' | 'gone' | null,
  read(path: string): string {
    if (this.unavailable) throw Object.assign(new Error('Census unavailable'), { code: 'EACCES' });
    if (this.captureFailure && path.endsWith('/children')) {
      if (this.captureFailure === 'gone') this.rows.delete(Number(path.split('/')[2]));
      this.captureFailure = null;
      throw Object.assign(new Error('Subtree observation denied'), { code: 'EACCES' });
    }
    const pid = Number(path.split('/')[2]);
    const row = this.rows.get(pid);
    if (!row) throw Object.assign(new Error('Absent native generation'), { code: 'ENOENT' });
    if (path.endsWith('/status')) return `Uid:\t${row.uid ?? 1000}\n`;
    if (path.endsWith('/stat')) {
      const fields = Array<string>(22).fill('0');
      fields[0] = 'S'; fields[1] = String(row.parent); fields[2] = String(pid);
      fields[19] = String(row.ticks);
      return `${pid} (fixture) ${fields.join(' ')}`;
    }
    if (path.endsWith('/children')) return [...this.rows].filter(([, child]) => child.parent === pid).map(([childPid]) => childPid).join(' ');
    if (path.endsWith('/environ')) return row.tag ? `HAPPIER_PROCESS_OWNER=${row.tag}\0` : '';
    if (path.endsWith('/cgroup')) return row.unit ? `0::${row.unit}\n` : '';
    if (path.endsWith('/cmdline')) return 'fixture\0';
    return '';
  },
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      const path = String(args[0]);
      const task = /^\/proc\/(\d+)\/task$/.exec(path);
      if (task) return native.rows.has(Number(task[1])) ? Promise.resolve([task[1]])
        : Promise.reject(Object.assign(new Error('Absent native generation'), { code: 'ENOENT' }));
      return path === '/proc'
        ? native.unavailable ? Promise.reject(Object.assign(new Error('Census unavailable'), { code: 'EACCES' }))
          : Promise.resolve([...native.rows.keys()].map(String)) : actual.readdir(...args);
    },
    readlink: (...args: Parameters<typeof actual.readlink>) => String(args[0]).startsWith('/proc/')
      ? Promise.resolve('/fixture') : actual.readlink(...args),
    open: async (...args: Parameters<typeof actual.open>) => {
      if (!String(args[0]).startsWith('/proc/')) return actual.open(...args);
      const bytes = Buffer.from(native.read(String(args[0])));
      let offset = 0;
      return {
        async read(buffer: Buffer, start: number, length: number) {
          const bytesRead = bytes.copy(buffer, start, offset, offset + length);
          offset += bytesRead;
          return { bytesRead, buffer };
        },
        async close() {},
      };
    },
  };
});

import { createStopSession } from './stopSession';
import { createOnChildExited } from './onChildExited';
import { createEndOwnerRemainder } from '../processes/endOwnerRemainder';
import { createProcessOwnershipRuntime } from '../processes/ownership/processOwnershipRuntime';
import { listHappierProcessRoots } from '../processes/roots/listHappierProcessRoots';
import { waitForTrackedRunnerProcessesExit } from './waitForTrackedRunnerProcessesExit';
import { createHappierLinuxScopeName } from '../platform/linux/systemdUserResourceGovernor';
import type { TrackedSession } from '../types';
import { readProcessCensus } from '@/processes/census/processCensus';
import { requestPlannedRunnerRestart } from '../plannedRunnerRestart/requestPlannedRunnerRestart';
import { createVersionRuntimeRefreshAttemptHandoff } from '../plannedRunnerRestart/versionRuntimeRefreshAttemptHandoff';
import type { RestartSessionRunnerCompletion } from '../plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

afterEach(() => { native.rows.clear(); native.unavailable = false; native.captureFailure = null; vi.restoreAllMocks(); });

it.skipIf(process.platform !== 'linux').each(['alive', 'gone'] as const)(
  'releases the tracked runner and retains the capture cause when capture fails with runner %s', async state => {
    const runner = 42000101;
    const child = 42000102;
    const sessionId = `PID-${runner}`;
    native.rows.set(process.pid, { parent: 1, ticks: 10 });
    native.rows.set(runner, { parent: process.pid, ticks: 100 });
    native.rows.set(child, { parent: runner, ticks: 110 });
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(runner), pid: runner, happySessionId: sessionId, startedBy: 'terminal', processStartTimeMs: 1000 };
    const sessions = new Map([[tracked.trackingKey, tracked]]);
    const ownership = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc',
      listRoots: snapshot => listHappierProcessRoots({ snapshot, trackedSessions: sessions.values() }) });
    const remainder = createEndOwnerRemainder({ processOwnershipRuntime: ownership, daemonScopeKey: '123456789abc', firstPass() {} });
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (!native.rows.has(pid)) throw Object.assign(new Error('Exited'), { code: 'ESRCH' });
      if (signal !== 0) {
        native.rows.delete(pid);
        for (const row of native.rows.values()) if (row.parent === pid) row.parent = 1;
      }
      return true;
    });
    const onExit = createOnChildExited({ trackedSessionsByKey: sessions, ownerRemainder: remainder,
      spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null });
    const observeExit = async ({ trackedPids }: Readonly<{ trackedPids: readonly number[] }>) =>
      await waitForTrackedRunnerProcessesExit({ runners: trackedPids.map(pid => ({ pid })), timeoutMs: 0, pollIntervalMs: 0 });
    const stop = createStopSession({ trackedSessionsByKey: sessions, ownerRemainder: remainder,
      readHostAttachmentState: async () => ({ status: 'absent' }), readTerminalAttachmentInfo: async () => null,
      areTrackedRunnersExited: observeExit,
      waitForTrackedRunnersExit: async input => {
        const exited = await observeExit(input);
        if (exited) for (const pid of input.trackedPids) await onExit(pid, { reason: 'process-missing', code: null, signal: null });
        return exited && input.trackedPids.every(pid => !sessions.has(legacyPidSessionTrackingKey(pid)));
      } });
    native.captureFailure = state;
    expect(await stop(sessionId)).toEqual({ status: 'incomplete', reason: 'process_owner_observation_unavailable',
      processFailure: { phase: 'tree_capture', reason: 'read_failed' } });
    expect(native.rows.has(runner)).toBe(false);
    expect(native.rows.has(child)).toBe(false);
    expect(sessions.size).toBe(0);
    expect(await stop(sessionId)).toEqual({ status: 'not_found' });
  });

it.skipIf(process.platform !== 'linux').each([true, false])('force Stop preserves late native admission without losing ordinary cleanup (remainder=%s)', async withRemainder => {
  const runner = 42000001;
  const ordinary = 42000002;
  const detached = 42000003;
  const container = 42000004;
  const containerChild = 42000005;
  const containerId = 'f'.repeat(64);
  const owner = { kind: 'session', sessionId: 'forced-native-remainder' } as const;
  native.rows.set(process.pid, { parent: 1, ticks: 10 });
  native.rows.set(runner, { parent: process.pid, ticks: 100 });
  native.rows.set(ordinary, { parent: runner, ticks: 110 });
  native.rows.set(detached, { parent: ordinary, ticks: 120 });
  if (withRemainder) {
    native.rows.set(container, { parent: runner, ticks: 130 });
    native.rows.set(containerChild, { parent: container, ticks: 140 });
  }
  const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(runner), pid: runner, startedBy: 'terminal', happySessionId: owner.sessionId,
    processStartTimeMs: 1000 };
  const sessions = new Map([[tracked.trackingKey, tracked]]);
  let nativeAdmitted = false;
  const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc',
    listRoots: snapshot => listHappierProcessRoots({ snapshot, trackedSessions: sessions.values(),
      nativeContainers: nativeAdmitted ? [{ pid: container, owner: { kind: 'container', serverId: 'home', machineId: 'machine',
        serviceId: 'production/web', containerId, composeProject: 'production', composeService: 'web', environmentId: 'environment' } }] : [] }) });
  const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: '123456789abc', firstPass() {} });
  const signals: number[] = [];
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal === 0) {
      if (!native.rows.has(pid)) throw Object.assign(new Error('Native generation exited'), { code: 'ESRCH' });
      return true;
    }
    signals.push(pid);
    if (pid === runner && signal !== 'SIGKILL') return true;
    native.rows.delete(pid);
    for (const row of native.rows.values()) if (row.parent === pid) row.parent = 1;
    return true;
  });
  const observeExit = async ({ trackedPids }: Readonly<{ trackedPids: readonly number[] }>) =>
    await waitForTrackedRunnerProcessesExit({ runners: trackedPids.map(pid => ({ pid })), timeoutMs: 0, pollIntervalMs: 0 });
  const stop = createStopSession({ trackedSessionsByKey: sessions, ...(withRemainder ? { ownerRemainder: remainder } : {}),
    readHostAttachmentState: async () => ({ status: 'absent' }), readTerminalAttachmentInfo: async () => null,
    areTrackedRunnersExited: observeExit,
    waitForTrackedRunnersExit: async input => {
      if (withRemainder && !nativeAdmitted) {
        // Engine admission can settle while the ordinary runner ignores its first
        // signal. Its current cgroup is now native service authority, not Session custody.
        nativeAdmitted = true;
        native.rows.get(container)!.unit = `/system.slice/docker-${containerId}.scope`;
        native.rows.get(containerChild)!.unit = `/system.slice/docker-${containerId}.scope`;
        native.rows.get(detached)!.parent = 1;
      }
      return await observeExit(input);
    } });
  expect(await stop(owner.sessionId)).toEqual({ status: 'stopped' });
  expect([runner, ordinary, detached].filter(pid => native.rows.has(pid))).toEqual([]);
  expect(signals).toEqual(expect.arrayContaining([runner, ordinary, detached]));
  if (withRemainder) {
    expect(signals.filter(pid => pid === container || pid === containerChild)).toEqual([]);
    expect([container, containerChild].every(pid => native.rows.has(pid))).toBe(true);
  }
});

it.skipIf(process.platform !== 'linux').each([
  { sharedFence: false, foreignChild: false, settleExit: false },
  { sharedFence: true, foreignChild: false, settleExit: false },
  { sharedFence: true, foreignChild: true, settleExit: false },
  { sharedFence: true, foreignChild: false, settleExit: true },
].flatMap(scenario => [false, true].map(nestedPeer => ({ ...scenario, nestedPeer, unavailable: false, wrapped: false, nativeRuns: false, denyRunSignal: false, detachedFence: false }))).concat([
  { sharedFence: false, foreignChild: false, settleExit: false, nestedPeer: false, unavailable: true, wrapped: false, nativeRuns: false, denyRunSignal: false, detachedFence: false },
  ...[false, true].map(settleExit => ({ sharedFence: true, foreignChild: false, settleExit, nestedPeer: true, unavailable: false, wrapped: true, nativeRuns: false, denyRunSignal: false, detachedFence: false })),
  ...[false, true].map(denyRunSignal => ({ sharedFence: true, foreignChild: false, settleExit: false, nestedPeer: true, unavailable: false, wrapped: true, nativeRuns: true, denyRunSignal, detachedFence: false })),
  ...[false, true].map(sharedFence => ({ sharedFence, foreignChild: false, settleExit: false, nestedPeer: false, unavailable: false, wrapped: false, nativeRuns: false, denyRunSignal: false, detachedFence: true })),
]))('captures the native Stop tree (shared fence=$sharedFence, foreign principal=$foreignChild, exit owner=$settleExit, nested peer=$nestedPeer, unavailable=$unavailable, wrapped=$wrapped, native Runs=$nativeRuns, denied Run signal=$denyRunSignal, detached member=$detachedFence)', async ({ sharedFence, foreignChild, settleExit, nestedPeer, unavailable, wrapped, nativeRuns, denyRunSignal, detachedFence }) => {
  const scope = '123456789abc';
  const owner = { kind: 'session', sessionId: 'native-remainder' } as const;
  const run = { kind: 'run', runId: 'summary-generator', sessionId: owner.sessionId } as const;
  const review = { kind: 'run', runId: 'retained-review', sessionId: owner.sessionId } as const;
  const runner = 41000001;
  const foreground = 41000002;
  const generator = 41000003;
  const descendant = 41000004;
  const peer = 41000005;
  const peerChild = 41000006;
  const worker = wrapped ? 41000007 : runner;
  const reviewer = 41000008;
  const independentRun = 41000009;
  const independentRunChild = 41000010;
  const detached = 41000011;
  const peerRun = { kind: 'run', runId: 'independent-review', sessionId: 'peer-session' } as const;
  const unit = `/user.slice/${createHappierLinuxScopeName(`v1.${scope}.happier.daemon`)!}`;
  native.rows.set(process.pid, { parent: 1, ticks: 10 });
  native.rows.set(runner, { parent: process.pid, ticks: 100, unit });
  if (wrapped) {
    native.rows.set(worker, { parent: runner, ticks: 105, unit });
    native.rows.set(reviewer, { parent: worker, ticks: 115, unit, tag: `v1.${scope}.run.${review.runId}` });
  }
  if (nativeRuns) {
    native.rows.set(independentRun, { parent: worker, ticks: 160, unit, tag: `v1.${scope}.run.${peerRun.runId}` });
    native.rows.set(independentRunChild, { parent: independentRun, ticks: 170, unit });
  }
  native.rows.set(foreground, { parent: worker, ticks: 110, unit, tag: `v1.${scope}.session.${owner.sessionId}` });
  native.rows.set(generator, { parent: worker, ticks: 120, unit, tag: `v1.${scope}.run.${run.runId}` });
  native.rows.set(descendant, { parent: foreground, ticks: 130, unit, ...(foreignChild ? { uid: 1001 } : {}) });
  native.rows.set(peer, { parent: process.pid, ticks: 90, ...(detachedFence && !sharedFence ? {} : { unit }) });
  if (detachedFence) native.rows.set(detached, { parent: 1, ticks: 180, unit });
  if (nestedPeer) {
    native.rows.set(peer, { parent: runner, ticks: 140, unit });
    native.rows.set(peerChild, { parent: peer, ticks: 150, unit });
  }
  const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(runner), pid: runner, startedBy: 'terminal', happySessionId: owner.sessionId,
    ...(wrapped ? { sessionRunnerPid: worker, runnerProcessIdentity: { pid: worker, processStartTimeMs: 1050 } } : {}),
    processStartTimeMs: 1000, ...(sharedFence || detachedFence ? { linuxLaunchUnit: unit.split('/').at(-1) } : {}) };
  const peerTracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(peer), pid: peer, startedBy: 'terminal', happySessionId: 'peer-session',
    processStartTimeMs: 900, ...(sharedFence ? { linuxLaunchUnit: unit.split('/').at(-1) } : {}) };
  if (nestedPeer) peerTracked.processStartTimeMs = 1400;
  const sessions = new Map([[peerTracked.trackingKey, peerTracked], [tracked.trackingKey, tracked]]);
  const runtime = createProcessOwnershipRuntime({ daemonScopeKey: scope,
    listRoots: snapshot => listHappierProcessRoots({ snapshot, daemonScopeKey: scope,
      trackedSessions: sessions.values(), executionRuns: [...[run, ...(wrapped ? [review] : [])].map(owner => ({
        owner, pid: nativeRuns ? owner === review ? reviewer : generator : worker,
        processStartTimeMs: nativeRuns ? owner === review ? 1150 : 1200 : wrapped ? 1050 : 1000,
      })), ...(nativeRuns ? [{ owner: peerRun, pid: independentRun, processStartTimeMs: 1600 }] : [])] }) });
  const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: scope, firstPass: () => {} });
  const signals: number[] = [];
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal === 0) {
      if (!native.rows.has(pid)) throw Object.assign(new Error('Native generation exited'), { code: 'ESRCH' });
      return true;
    }
    if (![runner, worker, reviewer, foreground, generator, descendant, ...(detachedFence && !sharedFence ? [detached] : [])].includes(pid)) throw new Error(`Unexpected signal target ${pid}`);
    signals.push(pid);
    if (denyRunSignal && pid === generator) throw Object.assign(new Error('Native termination refused'), { code: 'EPERM' });
    native.rows.delete(pid);
    if (wrapped && pid === runner) {
      // The wrapper and foreground close normally. Detached Run disposal is
      // not proof that either child native root has exited before host exit.
      for (const exited of [worker, foreground, descendant]) native.rows.delete(exited);
      for (const row of native.rows.values()) if (row.parent === worker) row.parent = 1;
    }
    // A departing runner cannot keep its children's parent-chain evidence alive.
    for (const row of native.rows.values()) if (row.parent === pid) row.parent = 1;
    return true;
  });
  const onChildExited = createOnChildExited({ trackedSessionsByKey: sessions, ownerRemainder: remainder,
    spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null });
  const observeExit = async ({ trackedPids }: Readonly<{ trackedPids: readonly number[] }>) => {
    const exited = await waitForTrackedRunnerProcessesExit({
      runners: trackedPids.map(pid => ({ pid })), timeoutMs: 0, pollIntervalMs: 0,
    });
    // Zero is a single physical probe, not a budget for asynchronous lifecycle
    // cleanup. This composition awaits retirement under the enclosing test budget.
    if (exited && settleExit) for (const pid of trackedPids) {
      await onChildExited(pid, { reason: 'process-missing', code: null, signal: null });
    }
    return exited;
  };
  const stop = createStopSession({ trackedSessionsByKey: sessions, ownerRemainder: remainder,
    readHostAttachmentState: async () => ({ status: 'absent' }),
    areTrackedRunnersExited: observeExit, waitForTrackedRunnersExit: observeExit });

  const observed = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
  expect(observed.status).toBe('ok');
  if (observed.status !== 'ok') throw new Error('Fixture census unavailable');
  expect(observed.rows.find(row => row.pid === runner)?.start.startTimeMs).toBe(1000);
  native.unavailable = unavailable;
  if (unavailable) {
    const reservations = new Set<SessionTrackingKey>();
    const completion = createVersionRuntimeRefreshAttemptHandoff<RestartSessionRunnerCompletion>({ timeoutMs: null,
      timeoutCompletion: { ok: false, status: 'partial_failure' },
      supersededCompletion: { ok: false, status: 'partial_failure' },
      cancelledCompletion: { ok: false, status: 'partial_failure' } });
    const target = { sessionId: owner.sessionId, previousPid: runner, tracked };
    const request = () => requestPlannedRunnerRestart({ sessionId: owner.sessionId, tracked,
      deferral: { kind: 'none' }, restartRequestedSessions: reservations, trackedSessionsByKey: sessions,
      completion: { hasPending: () => completion.hasPending(), join: () => completion.join(target), create: () => completion.create(target) },
      isProcessSafeToSignal: async () => true,
      captureRunnerRemainder: () => remainder.captureTree(owner, { pid: runner, start: { startTimeMs: 1000 } }),
      requestSignal: async request => {
        if (!await request.shouldSignal()) return { status: 'skipped_stale_owner' };
        signals.push(runner);
        completion.settleSession(owner.sessionId, { ok: true });
        return { status: 'requested' };
      },
    });
    expect(await request()).toEqual({ signaled: false, notSignaledReason: 'remainder_capture_unavailable' });
    expect(signals, 'refresh must refuse before signal when native capture is unavailable').toEqual([]);
    expect(reservations.size).toBe(0);
    expect(completion.hasPending()).toBe(false);
    expect(tracked.ownerRemainderCapture).toBeUndefined();

    native.unavailable = false;
    const earlier = await remainder.captureTree(owner, { pid: runner, start: { startTimeMs: 1000 } });
    expect(earlier?.scope).toBe('subtree');
    tracked.ownerRemainderCapture = earlier;
    native.unavailable = true;
    expect(await request()).toEqual({ signaled: false, notSignaledReason: 'remainder_capture_unavailable' });
    expect(tracked.ownerRemainderCapture).toBe(earlier);
    expect(signals).toEqual([]);
    expect(reservations.size).toBe(0);
    expect(completion.hasPending()).toBe(false);
    expect(await stop(owner.sessionId)).toEqual({ status: 'incomplete', reason: 'process_owner_observation_unavailable',
      processFailure: { phase: 'ownership_view', reason: 'read_failed' } });
    expect(signals).toEqual([]);

    native.unavailable = false;
    expect(await request()).toEqual({ signaled: true, completion: { ok: true } });
    expect(signals).toEqual([runner]);
    expect(tracked.ownerRemainderCapture?.scope).toBe('subtree');
    expect(tracked.ownerRemainderCapture).not.toBe(earlier);
    return;
  }
  if (foreignChild) {
    expect(await stop(owner.sessionId)).toEqual({ status: 'incomplete', reason: 'runner_signal_incomplete' });
    expect(signals.sort()).toEqual([runner, foreground, generator].sort());
    expect([...native.rows.keys()].sort()).toEqual([process.pid, descendant, peer, ...(nestedPeer ? [peerChild] : [])].sort());
    expect(tracked.ownerRemainderCapture?.roots.some(root => root.pid === descendant)).toBe(true);
    return;
  }
  expect(await stop(owner.sessionId)).toEqual(denyRunSignal
    ? { status: 'incomplete', reason: 'runner_signal_incomplete' } : { status: 'stopped' });
  expect([...native.rows.keys()].sort()).toEqual([process.pid, peer, ...(nestedPeer ? [peerChild] : []),
    ...(nativeRuns ? [independentRun, independentRunChild] : []), ...(denyRunSignal ? [generator] : []),
    ...(detachedFence && sharedFence ? [detached] : [])].sort());
  expect(signals.sort()).toEqual([...(wrapped ? [runner, reviewer, generator] : [runner, foreground, generator, descendant]),
    ...(detachedFence && !sharedFence ? [detached] : [])].sort());
  if (wrapped) expect(tracked.ownerRemainderCapture?.roots.map(root => root.pid)).toEqual(expect.arrayContaining([worker, reviewer, generator]));
  expect(tracked.ownerRemainderCapture?.scope).toBe('subtree');
  expect(tracked.ownerRemainderCapture?.roots.some(root => [peer, peerChild, independentRun, independentRunChild].includes(root.pid))).toBe(false);
  expect(tracked.stopRequestedAtMs).toBeTypeOf('number');
  if (settleExit) expect(tracked.ownerRemainderResult?.status).toBe('complete');
});
