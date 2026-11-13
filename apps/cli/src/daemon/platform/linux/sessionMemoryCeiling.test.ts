import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import { MachineGuardPolicyV1Schema } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import type { SessionGuardNoticeStateV1 } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import { readSessionMemoryCeilingOverride } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import { createActivityLog } from '../../guard/activityLog';
import { evaluateSessionEligibility } from '../../guard/sessionEligibility';
import type { LiveWorkInventoryV1 } from '../../lifecycle/managedActivity';
import type { TrackedSession } from '../../types';
import type { ProcessCensusRow } from '@/processes/census/processCensus';
import { listHappierProcessRoots } from '../../processes/roots/listHappierProcessRoots';
import { buildCgroupProcessLaunchSpec } from './buildCgroupSelfMigratingHappyCliLaunchSpec';
import { createHappierLinuxScopeName } from './systemdUserResourceGovernor';
import { createSessionMemoryCeiling, type SessionMemoryCeilingTarget } from './sessionMemoryCeiling';
import { createProcessOwnershipRuntime } from '../../processes/ownership/processOwnershipRuntime';
import { buildActivityNotificationContent } from '@/notifications/activity/buildActivityNotificationContent';
import { GuardAttentionNotificationV1Schema } from '@happier-dev/protocol/activity/webhookPayload';
import { createLeftBehindPass } from '../../processes/leftBehind/leftBehindPass';
import { createMachineProcessesView } from '../../processes/view/createMachineProcessesView';
import { MachineProcessesAnswerV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { createMachineVitalsSampler } from '../../vitals/createMachineVitalsSampler';
import { createMachineVitalsReader } from '../../vitals/createMachineVitalsReader';
import { createMinuteHistoryStore } from '../../vitals/history/minuteHistoryStore';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => { runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
  runtimeOptions: { pluginIds: ['happier.agent.codex'] } }); });
afterAll(async () => {
  try { await runtime?.dispose(); }
  finally { await pluginReloadController.shutdown(); }
});

const releases: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'happier-session-ceiling-'));
  releases.push(() => rm(dir, { recursive: true, force: true }));
  let now = Date.UTC(2026, 9, 11);
  const actions: unknown[] = [];
  const log = await createActivityLog({ activeServerDir: dir, nowMs: () => now,
    resourceSummary: { reportAutomaticAction: action => { actions.push(action); } } });
  const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(42), pid: 42, happySessionId: 'session', startedBy: 'daemon', processStartTimeMs: 20 };
  const unit = createHappierLinuxScopeName('v1.0123456789ab.session.session')!;
  tracked.linuxLaunchUnit = unit;
  let target: SessionMemoryCeilingTarget = { tracked, root: { owner: { kind: 'session', sessionId: 'session' }, pid: 42,
    start: { startTimeMs: 20 }, live: true, ownerCreatedAtMs: 0,
    containment: { kind: 'linux_unit', prefix: `/user.slice/happier-jobs.slice/${unit}` } },
    label: 'Session', metadata: {}, attribution: { kind: 'unknown' } };
  let active = false;
  let events = 'high 0\noom_kill 0\n';
  let usage = 0;
  let usageReadFails = false;
  let scopeGone = false;
  const watchers = new Map<string, () => void>();
  const properties: Array<{ unit: string; bytes: number | null }> = [];
  const writes: Array<{ path: string; value: string }> = [];
  const stops: TrackedSession[] = [];
  const stopRecorded: TrackedSession[] = [];
  let stopSucceeds = true;
  const notices: SessionGuardNoticeStateV1[] = [];
  const notifications: unknown[] = [];
  let runnerLive = true;
  let reads = 0;
  let eligibilityReads = 0;
  let notifyFails = false;
  let cancelAfterNotice = false;
  let cancelAfterStop = false;
  let cancelAfterNotify = false;
  let heldNotify: Readonly<{ wait: Promise<void>; entered(): void }> | undefined;
  let heldDraftRead: Readonly<{ wait: Promise<void>; entered(): void }> | undefined;
  let heldPlanningRead: Readonly<{ boundary: 'targets' | 'counter'; wait: Promise<void>; entered(): void }> | undefined;
  let exitEvidence = '';
  let exitUnavailable = false;
  const exitReads: string[] = [];
  const controller = new AbortController();
  const native = {
    readFile: async (path: string) => {
      if (path.endsWith('.scope.json')) {
        exitReads.push(path);
        if (exitUnavailable) throw new Error('Exit evidence unavailable');
        if (!exitEvidence) throw Object.assign(new Error('No capture'), { code: 'ENOENT' });
        return exitEvidence;
      }
      if (heldPlanningRead?.boundary === 'counter' && path.endsWith('memory.events')) {
        const held = heldPlanningRead; heldPlanningRead = undefined; held.entered(); await held.wait;
      }
      if (scopeGone && path.endsWith('memory.events')) throw Object.assign(new Error('Scope collected'), { code: 'ENOENT' });
      if (usageReadFails && path.endsWith('memory.current')) throw new Error('Scope usage unreadable');
      return path.endsWith('memory.events') ? events : path.endsWith('memory.current') ? String(usage) : 'max';
    },
    writeFile: async (path: string, value: string) => { writes.push({ path, value }); },
    setProperty: async (unit: string, bytes: number | null) => { properties.push({ unit, bytes }); },
    watch: (path: string, listener: () => void) => { watchers.set(path, listener); return { close: () => { watchers.delete(path); } }; },
  };
  const owner = createSessionMemoryCeiling({ capability: { status: 'available' }, native, nowMs: () => now, activeServerDir: dir,
    readPolicy: () => policy,
    readSessions: async () => {
      reads++;
      if (heldPlanningRead?.boundary === 'targets') { const held = heldPlanningRead; heldPlanningRead = undefined; held.entered(); await held.wait; }
      if (cancelAfterNotice && notices.at(-1)?.kind === 'stopped') {
        controller.abort(new Error('Policy changed')); controller.signal.throwIfAborted();
      }
      return [target];
    },
    hasSessionOverrides: () => readSessionMemoryCeilingOverride(target.metadata) != null,
    readEligibility: async runner => {
      eligibilityReads++;
      // The final admission reads draft state through a network boundary before real eligibility evaluation.
      if (heldDraftRead && notifications.length > 0) { const held = heldDraftRead; heldDraftRead = undefined; held.entered(); await held.wait; }
      const inventory: LiveWorkInventoryV1 = { coverage: 'complete', items: [{ category: 'session', ownerRef: runner,
        attribution: { kind: 'unknown' }, state: active ? 'active' : 'settled', settledAt: now }] };
      return (await evaluateSessionEligibility({ tracked: runner, inventory, draft: { status: 'absent' }, resume: { sessionId: 'session',
        rawSession: { machineId: 'machine', path: '/project' }, metadata: { runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: { backendMode: 'appServer' } }, machineId: 'machine', path: '/project', flavor: 'codex', codexSessionId: 'native' } } }));
    },
    stopSession: async (_id, runner) => {
      stops.push(runner);
      if (stopSucceeds) { runnerLive = false; if (cancelAfterStop) controller.abort(new Error('Policy changed')); }
      return stopSucceeds;
    },
    onSessionStopRecorded: async runner => {
      if (!(await log.list({ range: 'today' })).entries.some(entry => entry.kind === 'stopped_session')) throw new Error('Stop receipt not committed');
      stopRecorded.push(runner);
    },
    notice: async (_runner, state) => { notices.push(state); return true; },
    clearNotice: async () => { notices.push({ kind: 'clear' }); return true; },
    notify: async value => {
      if (!runnerLive) throw new Error('Runner RPC retired'); if (notifyFails) throw new Error('Runner RPC unavailable');
      if (heldNotify) { const held = heldNotify; heldNotify = undefined; held.entered(); await held.wait; }
      notifications.push(value); if (cancelAfterNotify) controller.abort(new Error('Policy changed'));
    }, activityLog: log,
  });
  releases.push(() => owner.stop());
  let policy = MachineGuardPolicyV1Schema.parse({ sessionMemoryCeiling: { bytes: 1000, warnAtPercent: 90 } });
  const plan = () => owner.readPlan({ policy, now, signal: controller.signal });
  const run = async () => { for (;;) { const next = await plan(); if (!next.run) return; await next.run(); } };
  const edge = (high: number, oom = 0) => { events = `high ${high}\noom_kill ${oom}\n`; for (const listener of watchers.values()) listener(); };
  return { owner, plan, run, edge, log, actions, properties, writes, stops, stopRecorded, notices, notifications, watchers, get policy() { return policy; }, unit, dir,
    advance: (ms: number) => { now += ms; },
    clearPolicy: () => { policy = MachineGuardPolicyV1Schema.parse({ ...policy, sessionMemoryCeiling: { ...policy.sessionMemoryCeiling, bytes: null } }); },
    setPolicyBytes: (bytes: number) => { policy = MachineGuardPolicyV1Schema.parse({ ...policy, sessionMemoryCeiling: { ...policy.sessionMemoryCeiling, bytes } }); },
    holdNotification: () => {
      let release!: () => void; let enter!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      const entered = new Promise<void>(resolve => { enter = resolve; });
      heldNotify = { wait, entered: enter }; return { entered, release };
    },
    holdFinalDraftRead: () => {
      let release!: () => void; let enter!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      const entered = new Promise<void>(resolve => { enter = resolve; });
      heldDraftRead = { wait, entered: enter }; return { entered, release };
    },
    holdPlanningRead: (boundary: 'targets' | 'counter') => {
      let release!: () => void; let enter!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      const entered = new Promise<void>(resolve => { enter = resolve; });
      heldPlanningRead = { boundary, wait, entered: enter }; return { entered, release };
    },
    notifyFails: (value: boolean) => { notifyFails = value; },
    cancelAfterNotice: () => { cancelAfterNotice = true; },
    cancelAfterStop: () => { cancelAfterStop = true; },
    cancelAfterNotify: () => { cancelAfterNotify = true; },
    exitReads,
    pendingExit: () => { exitEvidence = ' '; },
    capturedExit: (scope = unit) => { exitEvidence = JSON.stringify({ v: 1, unit: scope,
      path: `/sys/fs/cgroup/user.slice/happier-jobs.slice/${scope}`, status: 'captured', oom: 1, oomKill: 1 });
      watchers.get(join(dir, `scope-exit-${unit}.json`))?.(); },
    exitUnavailable: () => { exitUnavailable = true; },
    retire: (collect = true) => { target = { ...target, root: { ...target.root, live: false } }; scopeGone = collect; for (const listener of watchers.values()) listener(); },
    reads: () => reads,
    eligibilityReads: () => eligibilityReads,
    stopSucceeds: (value: boolean) => { stopSucceeds = value; },
    usage: (value: number) => { usage = value; }, active: (value: boolean) => { active = value; },
    usageReadFails: (value: boolean) => { usageReadFails = value; },
    target: (value: SessionMemoryCeilingTarget) => { target = value; }, readTarget: () => target };
}

describe('per-Session soft memory ceiling owner', () => {
  it('preserves the observed usage and applied ceiling through a retried notice and its receipt', async () => {
    const f = await fixture(); await f.run();
    f.usage(950); f.owner.refreshOnTick(); f.notifyFails(true);
    await expect(f.run()).rejects.toThrow('Runner RPC unavailable');
    // A later observation must not rewrite the occurrence whose receipt was already committed.
    f.usage(970); f.owner.refreshOnTick(); f.notifyFails(false); await f.run();
    const notice = GuardAttentionNotificationV1Schema.parse({ topic: 'guard_attention', machineId: 'machine',
      ...f.notifications[0] as object });
    expect(notice).toMatchObject({ memory: { usedBytes: 950, limitBytes: 1000 } });
    expect((await f.log.list({ range: 'today' })).entries.find(entry => entry.kind === 'ceiling_near'))
      .toMatchObject({ memory: { usedBytes: 950, limitBytes: 1000 } });
    const content = buildActivityNotificationContent(notice, { readyIncludeMessageText: false });
    expect(content.data).toMatchObject({ memory: { usedBytes: 950, limitBytes: 1000 } });
    expect(content.body).toContain('950 B'); expect(content.body).toContain('1,000 B');
  });
  it('withdraws unreadable current usage while preserving the applied limit and recovers on the next native observation', async () => {
    const f = await fixture(); const root = f.readTarget().root;
    await f.run(); f.usage(300); f.owner.refreshOnTick(); await f.run();
    expect(f.owner.readObservation(root)).toMatchObject({ usedBytes: 300 });
    f.usageReadFails(true); f.owner.refreshOnTick();
    await expect(f.run()).rejects.toThrow('Scope usage unreadable');
    expect(f.owner.readObservation(root)).toEqual({ limitBytes: 1000 });
    f.usageReadFails(false); f.usage(400); f.owner.refreshOnTick(); await f.run();
    expect(f.owner.readObservation(root)).toMatchObject({ usedBytes: 400 });
  });
  it('publishes only applied, generation-matched native usage and a complete five-minute throttle observation', async () => {
    const f = await fixture();
    const target = f.readTarget();
    expect(f.owner.readObservation(target.root)).toBeUndefined();
    await f.run();
    expect(f.owner.readObservation(target.root)).toEqual({ limitBytes: 1000 });
    f.active(true); f.usage(950); f.owner.refreshOnTick(); await f.run();
    expect(f.owner.readObservation(target.root)).toMatchObject({ limitBytes: 1000, usedBytes: 950 });
    expect(f.owner.readObservation(target.root)).not.toHaveProperty('throttleCount5m');
    f.advance(60_000); f.edge(3); await f.run();
    f.advance(240_000); f.usage(970); f.owner.refreshOnTick(); await f.run();
    expect(f.owner.readObservation(target.root)).toMatchObject({ usedBytes: 970, throttleCount5m: 3 });
    // Native process-table I/O is replaced; identity, ownership, view, and the strict wire consumer are real.
    const runtime = createProcessOwnershipRuntime({ selfPid: target.root.pid, platform: 'linux', daemonScopeKey: '0123456789ab',
      listRoots: () => [f.readTarget().root], censusDependencies: { platform: 'darwin', selfPid: target.root.pid,
        helperExecutablePath: '/fixture/native-census', execFile: async () => ({ stdout: JSON.stringify({ v: 1,
          capturedAtMs: Date.now(), logicalCpus: 2, rows: [
            { pid: target.root.pid, ppid: 1, start: target.root.start, principal: { kind: 'uid', value: '1' }, name: 'runner', memory: { bytes: 40, kind: 'rss' }, cpuTimeUs: 0 },
            { pid: 70, ppid: 1, start: { startTimeMs: 70 }, principal: null, name: 'unreadable', memory: null, cpuTimeUs: null },
          ] }) }) } });
    const pass = createLeftBehindPass({ processOwnershipRuntime: runtime }); releases.push(() => pass.dispose());
    const sampler = createMachineVitalsSampler({ readers: createMachineVitalsReader(), historyStore: await createMinuteHistoryStore({ directory: join(f.dir, 'vitals') }) });
    releases.push(() => sampler.stop());
    const view = createMachineProcessesView({ processOwnershipRuntime: runtime, leftBehind: pass, platform: 'linux', selfPid: target.root.pid,
      bootTimeMs: 1000, allProcessesVisible: () => false, requesterForOwner: () => ({ accountId: 'owner' }),
      machineVitals: sampler,
      readCeiling: root => f.owner.readObservation(root) }); releases.push(() => view.dispose());
    const answer = MachineProcessesAnswerV1Schema.parse(await view.list({ machineId: 'machine' }, { accountId: 'owner', custodianAccountId: 'owner' }));
    expect(answer.owners[0].ceiling).toMatchObject({ usedBytes: 970, limitBytes: 1000, throttleCount5m: 3 });
    expect(answer.unverifiableCount).toBe(1);
    expect(f.owner.readObservation({ ...target.root, start: { startTimeMs: 21 } })).toBeUndefined();
    f.advance(60_000); f.owner.refreshOnTick(); await f.run();
    expect(f.owner.readObservation(target.root)).toMatchObject({ throttleCount5m: 0 });
    f.clearPolicy(); await f.run();
    expect(f.owner.readObservation(target.root)).toBeUndefined();
  });
  it.skipIf(process.platform === 'win32')('joins the native exit write without waiting for surviving scope descendants', async () => {
    const f = await fixture(); f.clearPolicy(); f.pendingExit();
    const launcher = spawn('/bin/sh', ['-c', 'exec sleep 30'], { stdio: 'ignore' });
    const tracked = f.readTarget().tracked; tracked.childProcess = launcher;
    let settled = false;
    const observation = f.owner.observeRunnerExit(tracked).then(result => { settled = true; return result; });
    try {
      await setImmediate();
      expect(settled).toBe(false);
      f.capturedExit();
      expect(await observation).toEqual({ status: 'recorded' });
      expect(launcher.exitCode).toBeNull();
      expect(f.watchers.size).toBe(0);
    } finally { launcher.kill('SIGTERM'); await observation; }
  });
  it.skipIf(process.platform === 'win32')('does not wait indefinitely for a capture writer lost with its launcher', async () => {
    const f = await fixture(); f.clearPolicy(); f.pendingExit();
    const launcher = spawn('/bin/sh', ['-c', 'exec sleep 30'], { stdio: 'ignore' });
    const tracked = f.readTarget().tracked; tracked.childProcess = launcher;
    const observation = f.owner.observeRunnerExit(tracked);
    try {
      await setImmediate(); launcher.kill('SIGTERM');
      expect(await observation).toEqual({ status: 'unavailable' });
      expect(f.watchers.size).toBe(0);
      expect((await f.log.list({ range: 'today' })).entries).toHaveLength(0);
    } finally { launcher.kill('SIGTERM'); await observation; }
  });
  it.skipIf(process.platform === 'win32')('consumes completed capture while the scope launcher still awaits surviving descendants', async () => {
    const f = await fixture(); f.clearPolicy(); f.capturedExit();
    const launcher = spawn('/bin/sh', ['-c', 'exec sleep 30'], { stdio: 'ignore' });
    releases.push(() => { launcher.kill('SIGTERM'); });
    const tracked = f.readTarget().tracked;
    tracked.childProcess = launcher;
    tracked.sessionRunnerPid = 42;
    const observation = f.owner.observeRunnerExit(tracked);
    try {
      await setImmediate();
      expect(f.exitReads).toHaveLength(1);
      expect(launcher.exitCode).toBeNull();
      expect(await observation).toEqual({ status: 'recorded' });
    } finally {
      launcher.kill('SIGTERM');
      await observation;
    }
  });
  it.each([null, 1000])('records positively attributed collected-scope OOM on runner exit with MemoryHigh=%s', async bytes => {
    const f = await fixture(); f.policy.sessionMemoryCeiling.bytes = bytes;
    if (bytes !== null) await f.run();
    f.capturedExit(); f.retire();
    expect(await f.owner.observeRunnerExit(f.readTarget().tracked)).toEqual({ status: 'recorded' });
    expect((await f.log.list({ range: 'today' })).entries).toMatchObject([{ kind: 'system_oom_kill', rule: 'system',
      outcome: 'done', subject: { kind: 'session', sessionId: 'session', title: null } }]);
    expect(f.exitReads[0]).toBe(join(f.dir, `scope-exit-${f.unit}.json`));
    expect(f.stops).toHaveLength(0);
    expect(f.watchers.size).toBe(0);
  });

  it('does not infer OOM from runner exit, peer scope evidence or an unavailable capture', async () => {
    for (const observation of ['none', 'peer', 'unavailable'] as const) {
      const f = await fixture(); f.clearPolicy(); f.retire();
      if (observation === 'peer') f.capturedExit(createHappierLinuxScopeName('v1.0123456789ab.session.session')!);
      if (observation === 'unavailable') f.exitUnavailable();
      expect(await f.owner.observeRunnerExit(f.readTarget().tracked)).toEqual({ status: observation === 'none' ? 'not_observed' : 'unavailable' });
      expect((await f.log.list({ range: 'today' })).entries).toHaveLength(0);
    }
  });

  it('consumes a departed scope capture and avoids duplicate observed OOM', async () => {
    const f = await fixture(); f.clearPolicy();
    f.capturedExit(); f.retire();
    expect(await f.owner.observeRunnerExit(f.readTarget().tracked)).toEqual({ status: 'recorded' });
    expect(f.exitReads).toHaveLength(1);
    expect((await f.log.list({ range: 'today' })).entries).toHaveLength(1);
    expect(await f.owner.observeRunnerExit(f.readTarget().tracked)).toEqual({ status: 'already_recorded' });
    const bounded = await fixture(); await bounded.run(); bounded.edge(0, 1); await bounded.run();
    bounded.capturedExit(); bounded.retire();
    expect(await bounded.owner.observeRunnerExit(bounded.readTarget().tracked)).toEqual({ status: 'already_recorded' });
    expect((await bounded.log.list({ range: 'today' })).entries).toMatchObject([
      { kind: 'system_oom_kill', note: 'This Session ran out of memory.' },
    ]);
  });
  it.each(['systemd', 'cgroup'] as const)('enforces a fresh %s Session ceiling from canonical launch custody without a precommitted Session identity', async kind => {
    const f = await fixture();
    const daemonScopeKey = '0123456789ab';
    // The launch has no Session identity; the accepted runner binds it afterwards.
    const unit = createHappierLinuxScopeName(`v1.${daemonScopeKey}.happier.daemon`)!;
    const launch = buildCgroupProcessLaunchSpec({ unit, memoryHighBytes: 1000,
      launchSpec: { filePath: '/runtime/happier', args: ['codex'], env: {} },
      scope: kind === 'systemd'
        ? { kind, systemdRunPath: '/usr/bin/systemd-run', transportEnvironment: {}, supportsEnvironmentExpansionOption: true }
        : { kind, baseDir: '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service' },
    });
    const physicalUnit = kind === 'systemd'
      ? launch.args.find(arg => arg.startsWith('--unit='))?.slice('--unit='.length)
      : launch.env?.HAPPIER_DAEMON_PROCESS_CGROUP_UNIT;
    expect(launch.linuxLaunchUnit).toBe(physicalUnit);
    const tracked = { ...f.readTarget().tracked, linuxLaunchUnit: launch.linuxLaunchUnit };
    const prefix = `/user.slice/user-1000.slice/user@1000.service/${kind === 'systemd' ? 'happier-jobs.slice/' : ''}${physicalUnit}`;
    const principal = { kind: 'uid', value: '1000' } as const;
    const rows: ProcessCensusRow[] = [
      { pid: 10, ppid: 1, start: { startTimeMs: 10 }, principal, name: 'happier', memory: null, cpuTimeUs: null },
      { pid: tracked.pid, ppid: 10, start: { startTimeMs: 20 }, principal, name: 'happier',
        memory: null, cpuTimeUs: null, cgroup: `${prefix}/delegated-child` },
    ];
    const root = listHappierProcessRoots({ selfPid: 10, daemonScopeKey, platform: 'linux', trackedSessions: [tracked],
      snapshot: { status: 'ok', rows, logicalCpus: 4, capturedAtMs: Date.UTC(2026, 9, 11) } })
      .find(item => item.owner.kind === 'session');
    expect(root?.containment).toEqual({ kind: 'linux_unit', prefix });
    if (!root) throw new Error('Canonical Session root missing');
    f.target({ ...f.readTarget(), tracked, root });
    await f.run();
    expect(f.watchers.size).toBe(1);
    if (kind === 'systemd') expect(f.properties).toEqual([{ unit: physicalUnit, bytes: 1000 }]);
    else expect(f.writes).toContainEqual({ path: `/sys/fs/cgroup${prefix}/memory.high`, value: '1000\n' });
    f.usage(950); f.owner.refreshOnTick(); await f.run();
    expect(f.notifications).toContainEqual(expect.objectContaining({ kind: 'ceiling_near', sessionId: tracked.happySessionId }));
    f.edge(1); await f.run();
    expect(f.stops).toEqual([tracked]);
    expect((await f.log.list({ range: 'today' })).entries).toContainEqual(expect.objectContaining({ kind: 'stopped_session', rule: 'ceiling', outcome: 'done' }));
  });
  it('uses the exact promoted runner birth, not the launch wrapper birth', async () => {
    const f = await fixture();
    const target = f.readTarget();
    const tracked: TrackedSession = { ...target.tracked, pid: 41, processStartTimeMs: 10, sessionRunnerPid: 42,
      runnerProcessIdentity: { pid: 42, processStartTimeMs: 20, processCommandHash: 'runner' } };
    f.target({ ...target, tracked });
    await expect(f.owner.apply({ sessionId: 'session', bytes: 1000 })).resolves.toEqual({ status: 'applied', appliesAt: 'now' });
    expect(f.properties.at(-1)?.bytes).toBe(1000);
    f.target({ ...target, tracked: { ...tracked, runnerProcessIdentity: { ...tracked.runnerProcessIdentity!, processStartTimeMs: 30 } } });
    await expect(f.owner.apply({ sessionId: 'session', bytes: 2000 })).rejects.toThrow('memory scope unavailable');
    expect(f.properties).toHaveLength(1);
    f.target({ ...target, tracked: { ...tracked, runnerProcessIdentity: undefined } });
    await expect(f.owner.apply({ sessionId: 'session', bytes: 2000 })).rejects.toThrow('memory scope unavailable');
    expect(f.properties).toHaveLength(1);
  });
  it.each(['policy_off', 'override_none', 'policy_reenabled'] as const)('does not apply a stale native ceiling proposal after target admission changes to %s', async change => {
    const f = await fixture();
    if (change === 'policy_reenabled') { await f.run(); f.clearPolicy(); }
    const plan = await f.plan(); const held = f.holdPlanningRead('targets'); const applying = plan.run!();
    await held.entered;
    if (change === 'policy_off') f.clearPolicy();
    else if (change === 'policy_reenabled') f.setPolicyBytes(2000);
    else {
      const target = f.readTarget();
      f.target({ ...target, metadata: { sessionGuardStateV1: { v: 1, kind: 'configured', ceilingBytes: null } } });
      await f.owner.apply({ sessionId: 'session', bytes: null });
    }
    held.release(); await applying;
    expect(f.properties.map(property => property.bytes)).toEqual(change === 'policy_off' ? [] : change === 'override_none' ? [null] : [1000]);
    await f.run();
    expect(f.properties.at(-1)?.bytes).toBe(change === 'policy_reenabled' ? 2000 : null);
    expect(f.watchers.size).toBe(change === 'policy_reenabled' ? 1 : 0);
  });
  it.each(['targets', 'counter'] as const)('does not attach late native resources when the planning %s read is retired', async boundary => {
    const f = await fixture(); const held = f.holdPlanningRead(boundary);
    const lifetime = new AbortController(); const reader = new AbortController();
    const request = { policy: f.policy, now: Date.UTC(2026, 9, 11), signal: lifetime.signal, readSignal: reader.signal };
    const reading = f.owner.readPlan(request);
    await held.entered; f.clearPolicy(); reader.abort(new Error('Policy changed')); held.release();
    const error = await reading.then(() => undefined, error => error);
    expect(f.watchers.size).toBe(0);
    expect(f.owner.enabled(f.policy)).toBe(false);
    expect(f.properties).toHaveLength(0);
    expect(error).toBe(reader.signal.reason);
    expect(lifetime.signal.aborted).toBe(false);
  });
  it('keeps the returned native action on its actuator lifetime after its successful reader retires', async () => {
    const f = await fixture(); const lifetime = new AbortController(); const reader = new AbortController();
    const request = { policy: f.policy, now: Date.UTC(2026, 9, 11), signal: lifetime.signal, readSignal: reader.signal };
    const plan = await f.owner.readPlan(request);
    reader.abort(new Error('Read complete')); await plan.run?.();
    expect(f.properties.at(-1)?.bytes).toBe(1000);
    expect(f.watchers.size).toBe(1);
  });
  it('withdraws the stop intent when policy turns off during the final network draft admission', async () => {
    const f = await fixture(); await f.run(); const draft = f.holdFinalDraftRead(); f.edge(1);
    const running = f.run(); await draft.entered;
    f.clearPolicy(); draft.release(); await running;
    expect(f.stops).toHaveLength(0);
    expect(f.notices.at(-1)).toEqual({ kind: 'clear' });
    expect((await f.log.list({ range: 'today' })).entries.some(entry => entry.kind === 'stopped_session')).toBe(false);
  });
  it.each(['working', 'policy_off', 'override_none'] as const)('re-admits the current ceiling and fresh work after a pending notification becomes %s', async change => {
    const f = await fixture(); await f.run(); const notification = f.holdNotification(); f.edge(1);
    const before = f.eligibilityReads();
    const running = f.run(); await notification.entered;
    if (change === 'working') f.active(true);
    else if (change === 'policy_off') f.clearPolicy();
    else {
      const target = f.readTarget();
      f.target({ ...target, metadata: { sessionGuardStateV1: { v: 1, kind: 'configured', ceilingBytes: null } } });
      await f.owner.apply({ sessionId: 'session', bytes: null });
    }
    notification.release(); await running;
    expect(f.stops).toHaveLength(0);
    expect(f.notices.at(-1)).toEqual({ kind: 'clear' });
    expect((await f.log.list({ range: 'today' })).entries.some(entry => entry.kind === 'stopped_session')).toBe(false);
    // One final exact-target observation after the awaited notification, not
    // repeated draft/inventory reads before that boundary can settle.
    expect(f.eligibilityReads() - before).toBe(change === 'working' ? 1 : 0);
  });
  it('commits the actual stopped Session receipt when cancellation follows the native stop acknowledgement', async () => {
    const f = await fixture(); await f.run(); f.cancelAfterStop(); f.edge(1);
    await expect(f.run()).rejects.toThrow('Policy changed');
    expect((await f.log.list({ range: 'today' })).entries).toContainEqual(expect.objectContaining({ kind: 'stopped_session', outcome: 'done' }));
    expect(f.stopRecorded).toEqual([f.readTarget().tracked]);
    expect(f.notices.at(-1)).toMatchObject({ kind: 'stopped' });
  });
  it.each(['admission', 'notification'] as const)('withdraws the acknowledged stopped intent when policy cancellation interrupts fresh Session %s', async phase => {
    const f = await fixture(); await f.run();
    if (phase === 'admission') f.cancelAfterNotice(); else f.cancelAfterNotify();
    f.edge(1);
    await expect(f.run()).rejects.toThrow('Policy changed');
    expect(f.stops).toHaveLength(0);
    expect(f.notices.at(-1)).toEqual({ kind: 'clear' });
    expect((await f.log.list({ range: 'today' })).entries.some(entry => entry.kind === 'stopped_session')).toBe(false);
  });
  it('does not read or attach native scope observers when every ceiling is off', async () => {
    const f = await fixture(); f.policy.sessionMemoryCeiling.bytes = null;
    await f.run();
    expect(f.properties).toHaveLength(0);
    expect(f.watchers.size).toBe(0);
    expect(f.reads()).toBe(0);
    expect(f.owner.enabled(f.policy)).toBe(false);
    const target = f.readTarget();
    f.target({ ...target, metadata: { sessionGuardStateV1: { v: 1, kind: 'configured', ceilingBytes: 2000 } } });
    await f.owner.apply({ sessionId: 'session', bytes: 2000 });
    expect(f.owner.enabled(f.policy)).toBe(true);
    await f.run();
    expect(f.properties.at(-1)?.bytes).toBe(2000);
    f.target({ ...target, metadata: { sessionGuardStateV1: { v: 1, kind: 'configured', ceilingBytes: null } } });
    await f.run();
    expect(f.properties.at(-1)?.bytes).toBe(null);
    expect(f.owner.enabled(f.policy)).toBe(false);
    expect(f.watchers.size).toBe(0);
  });

  it('retains a completed stop receipt through failed journal IO and clears an unconfirmed stop marker', async () => {
    const f = await fixture(); await f.run();
    const failedFile = join(f.dir, 'machine-guard', 'activity-2026-10-11.jsonl');
    await mkdir(failedFile, { recursive: true });
    f.edge(1);
    await expect(f.run()).rejects.toThrow();
    expect(f.stops).toHaveLength(1);
    expect(f.stopRecorded).toHaveLength(0);
    await rm(failedFile, { recursive: true });
    await f.run();
    expect(f.stops).toHaveLength(1);
    expect(f.stopRecorded).toEqual([f.readTarget().tracked]);
    expect((await f.log.list({ range: 'today' })).entries.filter(entry => entry.kind === 'stopped_session')).toHaveLength(1);
    const failed = await fixture(); await failed.run(); failed.stopSucceeds(false);
    failed.edge(1); await failed.run();
    expect(failed.notices.at(-1)).toEqual({ kind: 'clear' });
    expect((await failed.log.list({ range: 'today' })).entries).toContainEqual(expect.objectContaining({ kind: 'stop_failed', outcome: 'failed' }));
    expect(failed.stopRecorded).toHaveLength(0);
  });
  it('applies live policy and explicit override changes to the exact existing scope', async () => {
    const f = await fixture();
    await f.run();
    expect(f.properties).toEqual([{ unit: f.unit, bytes: 1000 }]);
    expect(await f.owner.apply({ sessionId: 'session', bytes: null })).toEqual({ status: 'applied', appliesAt: 'now' });
    expect(f.properties.at(-1)).toEqual({ unit: f.unit, bytes: null });
    f.policy.sessionMemoryCeiling.bytes = 2000;
    await f.run();
    expect(f.properties.at(-1)).toEqual({ unit: f.unit, bytes: 2000 });
    const target = f.readTarget();
    f.target({ ...target, root: { ...target.root, containment: { kind: 'linux_unit', prefix: `/user.slice/${f.unit}` } } });
    await f.owner.apply({ sessionId: 'session', bytes: 3000 });
    expect(f.writes.at(-1)).toEqual({ path: `/sys/fs/cgroup/user.slice/${f.unit}/memory.high`, value: '3000\n' });
  });

  it('uses the first kernel throttle edge to gently stop only fresh resumable eligible work and writes its durable way back', async () => {
    const f = await fixture();
    await f.run();
    f.edge(1);
    expect(f.stops).toHaveLength(0);
    await f.run();
    expect(f.stops).toEqual([f.readTarget().tracked]);
    expect(f.eligibilityReads()).toBe(1);
    expect(f.notices).toEqual([expect.objectContaining({ rule: 'ceiling', ceilingBytes: 1000 })]);
    const receipt = (await f.log.list({ range: 'today' })).entries.find(entry => entry.kind === 'stopped_session');
    expect(receipt).toMatchObject({ rule: 'ceiling', outcome: 'done', wayBack: [{ label: 'resume', actionId: 'session.open' }] });
    expect(f.actions).toHaveLength(1);
    f.edge(2); await f.run();
    expect(f.stops).toHaveLength(1);
    f.policy.sessionMemoryCeiling.bytes = null; f.retire(); await f.run();
    expect(f.watchers.size).toBe(0);
    expect(f.owner.enabled(f.policy)).toBe(false);
  });

  it('leaves busy work throttled, records system OOM separately, and notices near-limit once per runner per ceiling value', async () => {
    const f = await fixture(); f.active(true);
    await f.run();
    f.usage(900); f.owner.refreshOnTick(); f.notifyFails(true);
    await expect(f.run()).rejects.toThrow('Runner RPC unavailable');
    f.notifyFails(false); await f.run();
    f.owner.refreshOnTick(); await f.run();
    expect((await f.log.list({ range: 'today' })).entries.filter(entry => entry.kind === 'ceiling_near')).toHaveLength(1);
    f.edge(1); await f.run();
    expect(f.stops).toHaveLength(0);
    expect((await f.log.list({ range: 'today' })).entries).toContainEqual(expect.objectContaining({ kind: 'ceiling_reached', note: 'working' }));
    f.edge(2, 1); await f.run();
    expect((await f.log.list({ range: 'today' })).entries).toContainEqual(expect.objectContaining({ kind: 'system_oom_kill', rule: 'system' }));
    expect(f.actions).toHaveLength(0);
    f.policy.sessionMemoryCeiling.bytes = 2000; f.usage(1800); f.owner.refreshOnTick(); await f.run();
    expect((await f.log.list({ range: 'today' })).entries.filter(entry => entry.kind === 'ceiling_near')).toHaveLength(2);
    f.policy.sessionMemoryCeiling.bytes = 1000; f.owner.refreshOnTick(); await f.run();
    expect((await f.log.list({ range: 'today' })).entries.filter(entry => entry.kind === 'ceiling_near')).toHaveLength(2);
  });
});
