import { mkdtemp, rm } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineGuardPolicyV1Schema } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import { MachineResourcesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { createGuardRuntime, type GuardPolicyWork } from './guardRuntime';
import { createActivityLog } from './activityLog';
import { createMachineVitalsSampler } from '../vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '../vitals/history/minuteHistoryStore';
import { createMachineResourceSummary } from '../resources/machineResourceSummary';
import { createManagedActivityInventory, readWorkspaceSessionIdle } from '../lifecycle/managedActivity';
import { createSessionLiveWorkProducer } from '../lifecycle/sessionLiveWorkProducer';
import { resolveProcessOwnership } from '../processes/ownership/resolveProcessOwnership';
import type { ProcessCensusSnapshot } from '@/processes/census/processCensus';
import type { HappierProcessRoot } from '../processes/ownership/types';
import type { TrackedSession } from '../types';
import type { SessionGuardNoticeStateV1 } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import { evaluateSessionEligibility } from './sessionEligibility';
import { createBrowserAutomationOwnerRegistry } from '../browser/automation/owners';
import { waitForChangeOrDeadline } from '../lifecycle/waitForChangeOrDeadline';
import type { SessionDraftPresence } from '@/session/drafts/readSessionDraftPresence';
import { createGuardSessionRestoration } from './sessionRestoration';
import { sessionStop } from './actuators/sessionStop';
import { createGuardLeftBehindFixture, guardLeftBehindAttribution } from './actuators/leftBehind.testkit';
import { planLeftBehind } from './actuators/leftBehind';
import { createProcessActionExecutor } from '../processes/actions/processActionExecutor';
import { createProcessOwnershipRuntime } from '../processes/ownership/processOwnershipRuntime';
import { listHappierProcessRoots } from '../processes/roots/listHappierProcessRoots';
import { parseProcessOwnerTag } from '@/processes/ownerTag';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => { runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
  runtimeOptions: { pluginIds: ['happier.agent.codex'] } }); });
afterAll(async () => { await runtime?.dispose(); });

describe('memory guard episode on the incumbent minute sampler', () => {
  let directory: string;
  beforeEach(async () => { vi.useFakeTimers(); vi.setSystemTime(0); directory = await mkdtemp(join(tmpdir(), 'happier-memory-guard-')); });
  afterEach(async () => { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });

  async function setup(kind: 'browser' | 'session' | 'service' = 'browser', initiallyEnabled = true, nativeLowMemorySignal?: boolean, sessionCount = 1, policyWork?: GuardPolicyWork, monitoringIntervalMs = 60_000) {
    let level: 'calm' | 'critical' | 'not_reported' = nativeLowMemorySignal === undefined ? 'critical' : 'not_reported';
    let lowMemorySignal = nativeLowMemorySignal;
    const pressureSource = nativeLowMemorySignal === undefined ? 'events' as const : 'none' as const;
    let available = 100;
    let missing = false;
    const sampled: number[] = [];
    // Cadence is now an explicit Machine preference, never changed by opening Overview.
    const resourcesPolicy = MachineResourcesPolicyV1Schema.parse({ v: 1, monitoring: { intervalMs: monitoringIntervalMs } });
    const sampler = createMachineVitalsSampler({ nowMs: Date.now, monotonicMs: Date.now,
      readPolicy: () => resourcesPolicy,
      historyStore: await createMinuteHistoryStore({ directory: join(directory, 'minutes'), nowMs: Date.now }),
      // Native memory/counter adapter only. Minute bucketing and demand remain real.
      readers: { read: async input => {
        sampled.push(input.intervalMs);
        if (missing) return { state: 'unavailable', reason: 'reader_failed' };
        return { state: 'reporting', host: { logicalCores: 1, memoryTotalBytes: 1000, bootedAt: 0 },
          sample: { v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs,
            cpu: { reported: false, reason: 'unavailable' }, memory: { reported: true, totalBytes: 1000,
              availableBytes: available, usedBytes: 1000 - available, pressure: { level, source: pressureSource },
              ...(lowMemorySignal === undefined ? {} : { lowMemorySignal }) },
            disk: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' } },
          minuteCounters: { monotonicMs: input.monotonicMs, cpu: null, network: null } };
      } } });
    const summary = createMachineResourceSummary({ sampler, nowMs: Date.now, readNearlyFull: () => null, onError: error => { throw error; } });
    const activity = await createActivityLog({ activeServerDir: directory, nowMs: Date.now, resourceSummary: summary });
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(10), pid: 10, happySessionId: 's', startedBy: 'daemon' };
    const sessions: TrackedSession[] = [tracked, ...Array.from({ length: sessionCount - 1 }, (_, index) => ({
      trackingKey: legacyPidSessionTrackingKey(11 + index), pid: 11 + index, happySessionId: `s${index + 2}`, startedBy: 'daemon' }))];
    let working = false;
    let otherSessionWorking = false;
    let draft: SessionDraftPresence = { status: 'absent' };
    let footprint: number | undefined = 80;
    let reads = 0;
    let activityReads = 0;
    let noticeAvailable = true;
    const browserOwners = createBrowserAutomationOwnerRegistry({ now: Date.now });
    const browserView = { browserSessionId: 'browser', viewId: 'view' };
    browserOwners.getInputControl(browserView);
    let duringActivityRead: (() => void | Promise<void>) | undefined;
    let duringNativeRead: ((signal?: AbortSignal) => Promise<void>) | undefined;
    const errors: unknown[] = [];
    const background: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(30), pid: 30, happySessionId: 'background', startedBy: 'daemon', spawnOptions: { directory: '/project' } };
    // Session live-work RPC boundary shared by aggregate and exact-target owners.
    const readActivity: Parameters<typeof createSessionLiveWorkProducer>[0]['readActivity'] = async session => {
      activityReads++; await duringActivityRead?.();
      return { session: working || session !== tracked && otherSessionWorking ? 'active' : 'settled',
        input: 'settled', agents: 'settled', attention: 'settled', settledAt: 0 };
    };
    const producer = createSessionLiveWorkProducer({ readSessions: () => kind === 'session' ? sessions : [background], readActivity });
    const inventory = createManagedActivityInventory({ producers: [producer], now: Date.now });
    const root: HappierProcessRoot = { owner: kind === 'session' ? { kind: 'session', sessionId: 's' }
      : kind === 'service' ? { kind: 'service', serviceId: 'project-service' } : { kind: 'browser_sidecar' },
      pid: 10, start: { startTimeMs: 1 }, live: true, ownerCreatedAtMs: 0, stop: async () => {} };
    const roots = kind === 'session' ? sessions.map(session => session === tracked ? root : {
      ...root, pid: session.pid, owner: { kind: 'session' as const, sessionId: session.happySessionId! } }) : [root];
    let present = true;
    let sessionHost: { pid: number; stop(signal: AbortSignal): Promise<boolean> } | undefined;
    let failed = false;
    let connections: number | null = 0;
    let stops = 0;
    let notifications = 0;
    const notices: SessionGuardNoticeStateV1[] = [];
    const stoppedIds: string[] = [];
    let onNotice: ((state: SessionGuardNoticeStateV1, sessionId: string | undefined) => Promise<void>) | undefined;
    let onNativeStop: (() => Promise<void>) | undefined;
    let onStopRecorded: (() => Promise<void>) | undefined;
    const eligibility = async (session: TrackedSession, facts: Awaited<ReturnType<typeof inventory.read>>) =>
      evaluateSessionEligibility({ tracked: session, inventory: facts, draft,
        resume: { sessionId: session.happySessionId!, rawSession: { machineId: 'm', path: '/project' },
          metadata: { runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: { backendMode: 'appServer' } },
            machineId: 'm', path: '/project', flavor: 'codex', codexSessionId: `native-${session.happySessionId}` } } });
    let policy = MachineGuardPolicyV1Schema.parse({ memoryGuard: { enabled: initiallyEnabled, sustainMs: 60000 } });
    const edges = new Set<() => void>();
    const changed = () => { for (const edge of edges) edge(); };
    const runtime = createGuardRuntime({ vitals: sampler, readPolicy: () => policy, policyWork,
      subscribePolicy: listener => { edges.add(listener); return () => { edges.delete(listener); }; },
      subscribe: listener => { edges.add(listener); const release = inventory.subscribe(listener); return () => { edges.delete(listener); release(); }; },
      readFacts: async (readSignal?: AbortSignal) => {
        reads++;
        await duringNativeRead?.(readSignal);
        const browserIdle = browserOwners.readSessionIdle('browser');
        const snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }> = { status: 'ok', capturedAtMs: Date.now(), logicalCpus: 1,
          rows: present ? roots.map(root => ({ pid: root.pid, ppid: null, start: root.start, principal: { kind: 'uid' as const, value: '1' }, name: 'browser',
            memory: footprint === undefined ? null : { bytes: footprint, kind: 'rss' }, cpuTimeUs: 0 })) : [] };
        const facts = await inventory.read();
        return { ownership: { status: 'ok', snapshot, roots: present ? roots : [], rows: resolveProcessOwnership({ snapshot,
          roots: present ? roots : [], platform: 'darwin', daemonPrincipal: { kind: 'uid', value: '1' } }) }, inventory: facts, sessionHost,
          targets: !present ? [] : kind === 'browser' ? [{ kind: 'browser', root, ownerRef: root, label: 'Browser', ...browserIdle,
            wayBack: [{ label: 'reopen', actionId: 'browser.view.open', input: { machineId: 'm' } }] }]
            : kind === 'service' ? [{ kind: 'service', scope: 'project', workspacePath: '/project',
              workspaceIdle: readWorkspaceSessionIdle(facts, { workspacePath: '/project' }), root, ownerRef: root, label: 'Project server',
              listeners: [{ establishedConnections: connections }],
              wayBack: [{ label: 'start_again', actionId: 'localServices.launcher.start', input: { machineId: 'm', serviceId: 'project-service' } }] }]
            : await Promise.all(sessions.map(async (tracked, index) => ({ kind: 'session' as const, root: roots[index], tracked, label: 'Session',
              wayBack: [{ label: 'resume' as const, actionId: 'session.open' as const, input: { sessionId: tracked.happySessionId!, intent: 'resume' } }],
              eligibility: await eligibility(tracked, facts) }))) };
      },
      stop: async (candidate, signal) => {
        // Compose the same final Session admission as startDaemon; only its
        // native stop and Session activity transport are boundary fixtures.
        if (candidate.target.kind === 'session') return sessionStop({ candidate, signal,
          readCurrentTracked: id => present ? sessions.find(session => session.happySessionId === id) : undefined,
          readCurrentEligibility: async session => {
            const exact = createSessionLiveWorkProducer({ readSessions: () => present ? [session] : [], readActivity });
            return eligibility(session, await exact.read());
          },
          stopSession: async (_id, session) => {
            stops++; stoppedIds.push(session.happySessionId!); await onNativeStop?.(); return !failed;
          },
        });
        // A native acknowledgement cannot prove process absence.
        stops++; await onNativeStop?.();
        return failed ? { status: 'failed', reason: 'native_stop_failed' } : { status: 'stopped' };
      },
      onSessionStopRecorded: async () => { await onStopRecorded?.(); },
      notice: async (candidate, state) => { notices.push(state);
        await onNotice?.(state, candidate.target.kind === 'session' ? candidate.target.tracked.happySessionId : undefined);
        return noticeAvailable; },
      activity, notifyEpisode: async () => { notifications++; }, onError: error => { errors.push(error); },
    });
    await sampler.start();
    const signal = new AbortController();
    let finished = false;
    const running = runtime.run(signal.signal).finally(() => { finished = true; });
    const drain = async () => {
      await sampler.start();
      for (let i = 0; i < 4; i++) {
        await activity.list({ range: 'today' });
        // A real minute append can finish after the fake clock's advance returns.
        // Join that read, then fire only timers already due at the current time.
        await sampler.start();
        await vi.advanceTimersByTimeAsync(0);
        for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      }
    };
    await drain();
    return { runtime, sampler, activity, sampled, notices, stoppedIds, drain, changed, get stops() { return stops; }, get notifications() { return notifications; }, get reads() { return reads; }, get activityReads() { return activityReads; },
      setPresent: (value: boolean, notify = true) => { present = value; if (notify) changed(); }, setFailed: (value: boolean) => { failed = value; },
      setSessionHost: (value: typeof sessionHost) => { sessionHost = value; changed(); },
      setLevel: (value: typeof level) => { level = value; }, setAvailable: (value: number) => { available = value; },
      setLowMemorySignal: (value: typeof lowMemorySignal) => { lowMemorySignal = value; },
      setDraft: (value: SessionDraftPresence) => { draft = value; changed(); },
      setFootprint: (value: number | undefined) => { footprint = value; changed(); },
      setNoticeAvailable: (value: boolean) => { noticeAvailable = value; },
      setMissing: (value: boolean) => { missing = value; },
      setConnections: (value: number | null) => { connections = value; changed(); },
      setWorking: (value: boolean) => { working = value; producer.notifyChanged(); },
      setOtherSessionWorking: (value: boolean) => { otherSessionWorking = value; producer.notifyChanged(); },
      setSessionAttribution: (value: NonNullable<TrackedSession['requesterWorkAttributionV1']>) => {
        for (const session of sessions) session.requesterWorkAttributionV1 = value;
        producer.notifyChanged();
      },
      onNotice: (value: typeof onNotice) => { onNotice = value; },
      onNativeStop: (value: typeof onNativeStop) => { onNativeStop = value; },
      onStopRecorded: (value: typeof onStopRecorded) => { onStopRecorded = value; },
      duringActivityRead: (value: typeof duringActivityRead) => { duringActivityRead = value; },
      duringNativeRead: (value: typeof duringNativeRead) => { duringNativeRead = value; },
      abort: () => signal.abort(), finished: () => finished,
      takeOverBrowser: () => { browserOwners.takeOver(browserView); },
      setPolicy: (patch: Partial<typeof policy.memoryGuard>) => { policy = { ...policy, memoryGuard: { ...policy.memoryGuard, ...patch } }; changed(); },
      setIdlePolicy: (patch: Partial<typeof policy.idleSessions>) => { policy = { ...policy, idleSessions: { ...policy.idleSessions, ...patch } }; changed(); },
      setLeftBehindPolicy: (patch: Partial<typeof policy.leftBehind>) => { policy = { ...policy, leftBehind: { ...policy.leftBehind, ...patch } }; changed(); },
      close: async () => { signal.abort(); await running; await sampler.stop(); inventory.dispose(); summary.stop(); expect(errors).toEqual([]); } };
  }

  it('keeps automatic observations on minutes and owner changes while Overview samples every two seconds', async () => {
    const fixture = await setup('service', true, undefined, 1, undefined, 2_000);
    const release = fixture.sampler.demandOverview();
    try {
      fixture.setLevel('calm');
      await vi.advanceTimersByTimeAsync(0); await fixture.drain();
      const reads = fixture.reads;
      await vi.advanceTimersByTimeAsync(58_000); await fixture.drain();
      expect(fixture.sampler.latest()?.intervalMs).toBe(2_000);
      expect(fixture.reads).toBe(reads);
      fixture.setConnections(1); await fixture.drain();
      expect(fixture.reads).toBeGreaterThan(reads);
      const afterOwnerChange = fixture.reads;
      fixture.setConnections(0); await fixture.drain();
      expect(fixture.reads).toBeGreaterThan(afterOwnerChange);
      const beforeMinute = fixture.reads;
      await vi.advanceTimersByTimeAsync(2_000); await fixture.drain();
      expect(fixture.reads).toBeGreaterThan(beforeMinute);
      expect(fixture.runtime.readPreview()?.excluded).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'connections_unknown' }),
      ]));
      expect(fixture.stops).toBe(0);
    } finally { release(); await fixture.close(); }
  });

  it('stays quiet with both stop rules off, then independently warns and stops an idle session without pressure or RSS', async () => {
    const fixture = await setup('session', false);
    try {
      await vi.advanceTimersByTimeAsync(600000); await fixture.drain();
      expect(fixture.reads).toBe(0);
      fixture.setMissing(true); fixture.setFootprint(undefined);
      fixture.setIdlePolicy({ enabled: true, afterMs: 1200000 });
      await fixture.drain();
      expect(fixture.runtime.readSessionWarning('s')).toBeUndefined();
      await vi.advanceTimersByTimeAsync(300000); await fixture.drain();
      expect(fixture.runtime.readSessionWarning('s')).toMatchObject({ stopAt: 1200000 });
      expect(fixture.notices).toContainEqual({ kind: 'stopping', stopAt: 1200000, rule: 'idle_sessions' });
      expect(fixture.stops).toBe(0);
      await vi.advanceTimersByTimeAsync(300000); await fixture.drain();
      expect(fixture.stops).toBe(1);
      expect(fixture.notices).toContainEqual(expect.objectContaining({ kind: 'stopped', rule: 'idle_sessions' }));
      expect((await fixture.activity.list({ range: 'today' })).entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'stopped_session', rule: 'idle_sessions', outcome: 'done' })]));
      expect(fixture.notifications).toBe(0);
    } finally { await fixture.close(); }
  });
  it.each(['idle', 'memory'] as const)('publishes the %s Session warning before delivery and withdraws a failed acknowledgment without stopping', async rule => {
    const fixture = await setup('session', rule === 'memory');
    let release!: () => void;
    const delivery = new Promise<void>(resolve => { release = resolve; });
    let duringDelivery: Readonly<{ stopAt: number }> | undefined;
    try {
      fixture.onNotice(async state => {
        if (state.kind !== 'stopping') return;
        duringDelivery = fixture.runtime.readSessionWarning('s');
        await delivery;
      });
      if (rule === 'idle') { fixture.setIdlePolicy({ enabled: true, afterMs: 600000 }); await fixture.drain(); }
      await vi.advanceTimersByTimeAsync(rule === 'idle' ? 300000 : 60000); await fixture.drain();
      expect(duringDelivery).toEqual({ stopAt: rule === 'idle' ? 600000 : 360000 });
      await vi.advanceTimersByTimeAsync(600000); await fixture.drain();
      expect(fixture.stops).toBe(0);
      fixture.setNoticeAvailable(false); release(); await fixture.drain();
      expect(fixture.runtime.readSessionWarning('s')).toBeUndefined();
      expect(fixture.stops).toBe(0);
    } finally { release(); await fixture.close(); }
  });
  it.each(['idle', 'memory'] as const)('keeps the %s Session warning cleared when Keep running wins before delivery acknowledges', async rule => {
    const fixture = await setup('session', rule === 'memory');
    let release!: () => void;
    const delivery = new Promise<void>(resolve => { release = resolve; });
    let delivering = false;
    try {
      fixture.onNotice(async state => { if (state.kind === 'stopping') { delivering = true; await delivery; } });
      if (rule === 'idle') { fixture.setIdlePolicy({ enabled: true, afterMs: 600000 }); await fixture.drain(); }
      await vi.advanceTimersByTimeAsync(rule === 'idle' ? 300000 : 60000); await fixture.drain();
      expect(delivering).toBe(true);
      expect(await fixture.runtime.keepRunning('s')).toBe('kept');
      expect(fixture.runtime.readSessionWarning('s')).toBeUndefined();
      // Exclude an independent next warning under continuing pressure: only the held ACK may publish now.
      if (rule === 'idle') fixture.setIdlePolicy({ enabled: false });
      else fixture.setPolicy({ enabled: false });
      const publications: (Readonly<{ stopAt: number }> | undefined)[] = [];
      const stopObserving = fixture.runtime.subscribe(() => { publications.push(fixture.runtime.readSessionWarning('s')); });
      try {
        release(); await fixture.drain();
        expect(fixture.runtime.readSessionWarning('s')).toBeUndefined();
        expect(publications.every(value => value === undefined)).toBe(true);
        expect(fixture.stops).toBe(0);
      } finally { stopObserving(); }
    } finally { release(); await fixture.close(); }
  });
  it('honors a Keep-running idle deadline between minute samples', async () => {
    const fixture = await setup('session', false);
    try {
      fixture.setIdlePolicy({ enabled: true, afterMs: 600000 }); await fixture.drain();
      await vi.advanceTimersByTimeAsync(301000); await fixture.drain();
      expect(await fixture.runtime.keepRunning('s')).toBe('kept'); await fixture.drain();
      await vi.advanceTimersByTimeAsync(300000); await fixture.drain();
      expect(fixture.runtime.readSessionWarning('s')).toEqual({ stopAt: 901000 });
      await vi.advanceTimersByTimeAsync(299999); await fixture.drain();
      expect(fixture.stops).toBe(0);
      await vi.advanceTimersByTimeAsync(1); await fixture.drain();
      expect(fixture.stops).toBe(1);
      expect(fixture.sampler.latest()?.sampledAt).toBeLessThan(901000);
    } finally { await fixture.close(); }
  });
  it.each(['idle', 'memory'] as const)('keeps the same %s stop intent when another Session starts work during its publication', async rule => {
    const fixture = await setup('session', rule === 'memory', undefined, 2);
    try {
      if (rule === 'idle') {
        fixture.setIdlePolicy({ enabled: true, afterMs: 600000 });
        await fixture.drain();
      }
      let startedOtherSession = false;
      const targetNotices: SessionGuardNoticeStateV1[] = [];
      fixture.onNotice(async (state, sessionId) => {
        if (sessionId !== 's') return;
        targetNotices.push(state);
        if (state.kind === 'stopped' && !startedOtherSession) {
          startedOtherSession = true;
          fixture.setOtherSessionWorking(true);
        }
      });
      for (let minute = 0; minute < (rule === 'idle' ? 10 : 6); minute += 1) {
        await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      }
      expect(fixture.stoppedIds).toEqual(['s']);
      // Each stopped notice creates a durable requested record. An unrelated
      // inventory edge must not cancel it and create another for the same stop.
      expect(targetNotices.filter(state => state.kind === 'stopped')).toHaveLength(1);
      expect(targetNotices.some(state => state.kind === 'clear')).toBe(false);
    } finally { await fixture.close(); }
  });
  it.each(['idle', 'memory', 'memory_with_auxiliary'] as const)('admits a due %s stop while unrelated inventory edges arrive during native reads', async rule => {
    const native = rule === 'memory_with_auxiliary' ? createGuardLeftBehindFixture() : undefined;
    // Compose the real native confirmation and due planner, as the daemon's
    // auxiliary owner does. Its empty confirmed set has no cleanup effect.
    const policyWork: GuardPolicyWork | undefined = native ? {
      enabled: policy => policy.leftBehind.mode !== 'off',
      subscribe: () => () => {},
      async readPlan({ policy, now }) {
        await native.observe();
        const plan = planLeftBehind({ policy: policy.leftBehind, confirmed: native.tracker.confirmed(), now });
        return { nextAt: plan.nextAt };
      },
    } : undefined;
    const fixture = await setup('session', rule !== 'idle', undefined, 1, policyWork);
    try {
      if (native) { fixture.setLeftBehindPolicy({ mode: 'automatic', graceMs: 60000 }); await fixture.drain(); }
      if (rule === 'idle') { fixture.setIdlePolicy({ enabled: true, afterMs: 600000 }); await fixture.drain(); }
      for (let minute = 0; minute < (rule === 'idle' ? 9 : 5); minute++) {
        await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      }
      let arrivals = 0;
      let admissionStartedAt: number | undefined;
      fixture.duringNativeRead(async () => {
        // A same-minute timer can precede the asynchronous sampler commit.
        // Churn starts only once the pressure evidence required for admission exists.
        const minute = Math.floor(Date.now() / 60000) * 60000;
        if (rule !== 'idle' && ((fixture.sampler.latest()?.sampledAt ?? -1) < minute
          || fixture.sampler.minutes(minute).at(-1)?.t !== minute)) return;
        admissionStartedAt ??= fixture.reads - 1;
        // Background owner churn never changes the selected Session's generation.
        // Keep the old loop finite so a regression reports its repeated observations.
        if (arrivals < 8) { arrivals++; fixture.changed(); }
      });
      let readsAtStop: number | undefined;
      fixture.onNativeStop(async () => { readsAtStop = admissionStartedAt === undefined ? undefined : fixture.reads - admissionStartedAt; });
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.stoppedIds).toEqual(['s']);
      expect(fixture.notices.filter(state => state.kind === 'stopped')).toHaveLength(1);
      expect(arrivals).toBeGreaterThan(0);
      expect(readsAtStop).toBeLessThanOrEqual(3);
    } finally { await fixture.close(); }
  });
  it.each(['idle', 'memory'] as const)('cancels the %s intent when Keep running wins during its publication', async rule => {
    const fixture = await setup('session', rule === 'memory');
    try {
      if (rule === 'idle') {
        fixture.setIdlePolicy({ enabled: true, afterMs: 600000 });
        await fixture.drain();
      }
      fixture.onNotice(async state => {
        if (state.kind === 'stopped') expect(await fixture.runtime.keepRunning('s')).toBe('kept');
      });
      for (let minute = 0; minute < (rule === 'idle' ? 10 : 6); minute += 1) {
        await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      }
      expect(fixture.stops).toBe(0);
      expect(fixture.notices.filter(state => state.kind === 'stopped')).toHaveLength(1);
      expect(fixture.notices).toContainEqual({ kind: 'clear' });
    } finally { await fixture.close(); }
  });
  it('observes an unannounced stop on the next live sample and verifies after its existing cooldown', async () => {
    const fixture = await setup('browser', true, undefined, 1, undefined, 2_000);
    let release: (() => void) | undefined;
    try {
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.stops).toBe(1);
      release = fixture.sampler.demandOverview();
      await vi.advanceTimersByTimeAsync(0); await fixture.drain();
      fixture.setPresent(false, false); fixture.setAvailable(180);
      await vi.advanceTimersByTimeAsync(2000); await fixture.drain();
      const readsAfterAbsence = fixture.reads;
      await vi.advanceTimersByTimeAsync(56000); await fixture.drain();
      expect(fixture.reads).toBe(readsAfterAbsence);
      await vi.advanceTimersByTimeAsync(3999); await fixture.drain();
      expect((await fixture.activity.list({ range: 'today' })).entries).toEqual([]);
      await vi.advanceTimersByTimeAsync(1); await fixture.drain();
      expect((await fixture.activity.list({ range: 'today' })).entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'closed_browser', at: 122000, freedBytes: 80, outcome: 'done' }),
      ]));
    } finally { release?.(); await fixture.close(); }
  });
  it.each(['shutdown', 'policy_off'] as const)('retires a whole auxiliary native-read observer on %s without cancelling the shared census or acting later', async cancellation => {
    const native = createGuardLeftBehindFixture();
    await native.observe(); native.advance(60000); await native.observe();
    const nativeRead = native.censusDependencies.execFile!;
    let finishNative!: () => void;
    const nativePending = new Promise<void>(resolve => { finishNative = resolve; });
    let entered = false;
    // Hold only native helper transport; the census reader/ownership/tracker remain real.
    const heldNativeRead: typeof nativeRead = async (...args) => { entered = true; await nativePending; return nativeRead(...args); };
    const censusDependencies = { ...native.censusDependencies, execFile: heldNativeRead };
    const ownership = createProcessOwnershipRuntime({ listRoots: snapshot => listHappierProcessRoots({ snapshot,
      selfPid: process.pid, platform: 'darwin', daemonScopeKey: parseProcessOwnerTag(native.rows.get(300)?.ownerTag)!.daemonScopeKey,
      endedRoots: native.roots }),
      daemonScopeKey: parseProcessOwnerTag(native.rows.get(300)?.ownerTag)!.daemonScopeKey,
      selfPid: process.pid, platform: 'darwin', censusDependencies });
    const observe = async () => {
      const result = await ownership.readOwners({ freshness: 'fresh' });
      if (result.status !== 'ok') throw new Error(`Native fixture unavailable: ${result.reason}`);
      native.tracker.observe({ status: 'ok', capturedAtMs: result.snapshot.capturedAtMs, rows: result.rows });
    };
    const signals: number[] = [];
    const nativeActions = createProcessActionExecutor({ ownership, leftBehind: native.tracker,
      allProcessesVisible: () => false, requesterForOwner: () => guardLeftBehindAttribution, selfPid: process.pid, platform: 'darwin',
      systemBoundary: { platform: 'darwin', censusDependencies,
        kill(pid) { signals.push(pid); native.rows.delete(pid); }, wait: async () => undefined } });
    const listeners = new Set<() => void>();
    // Same owner composition as the daemon: fresh native confirmation, canonical due planner, then canonical cleanup.
    const policyWork: GuardPolicyWork = {
      enabled: policy => policy.leftBehind.mode !== 'off',
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async readPlan({ policy, signal }) {
        await observe();
        const plan = planLeftBehind({ policy: policy.leftBehind, confirmed: native.tracker.confirmed(), now: native.now() });
        const due = plan.due[0];
        return { nextAt: plan.nextAt, ...(due ? { run: async () => {
          await nativeActions.cleanUp({ serverId: 'home', machineId: 'machine', refs: [...due.refs] },
            { accountId: 'owner', isCustodian: true }, { signal });
        } } : {}) };
      },
    };
    const fixture = await setup('browser', false, undefined, 1, policyWork);
    try {
      fixture.setLeftBehindPolicy({ mode: 'automatic', graceMs: 0 }); await fixture.drain();
      expect(entered).toBe(true);
      expect(listeners.size).toBe(1);
      if (cancellation === 'shutdown') fixture.abort();
      else fixture.setLeftBehindPolicy({ mode: 'off' });
      await fixture.drain();
      if (cancellation === 'shutdown') expect(fixture.finished()).toBe(true);
      else expect(listeners.size).toBe(0);
      finishNative(); await observe(); await fixture.drain();
      expect(native.tracker.confirmed()).toHaveLength(2);
      expect(signals).toEqual([]);
      expect(native.rows.has(300)).toBe(true);
      expect(native.rows.has(301)).toBe(true);
      expect((await fixture.activity.list({ range: 'today' })).entries).toEqual([]);
    } finally { finishNative(); await fixture.close(); }
  });
  it('waits for exact target absence, cooldown and a later minute before measuring freed memory; out-of-steps stays quiet', async () => {
    const fixture = await setup();
    // Still scarce after the freed 80 (≤ 10 % available), so the episode runs out of steps.
    fixture.setAvailable(20);
    try {
      fixture.setPolicy({ actAt: 'elevated' });
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.stops).toBe(1);
      expect(fixture.runtime.readEpisode()).toMatchObject({ state: 'verifying' });
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect((await fixture.activity.list({ range: 'today' })).entries).toEqual([]);
      fixture.setPresent(false); await fixture.drain();
      fixture.setAvailable(100);
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      const entries = (await fixture.activity.list({ range: 'today' })).entries;
      expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'closed_browser', freedBytes: 80, outcome: 'done',
        trigger: expect.objectContaining({ level: 'critical' }) }),
        expect.objectContaining({ kind: 'out_of_steps' })]));
      await vi.advanceTimersByTimeAsync(120000); await fixture.drain();
      expect((await fixture.activity.list({ range: 'today' })).entries.filter(entry => entry.kind === 'out_of_steps')).toHaveLength(1);
      expect(fixture.notifications).toBe(1);
      expect(new Set(fixture.sampled)).toEqual(new Set([60000]));
      fixture.setLevel('calm'); await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.runtime.readEpisode()).toBeUndefined();
    } finally { await fixture.close(); }
  });
  it('does not read Activity history when a newly started Session was never Guard-stopped', async () => {
    const fixture = await setup('session', false);
    const attribution = { serverId: 'home', accountId: 'owner', machineId: 'm', installationId: 'installation' };
    await fixture.activity.append({ v: 1, id: 'unrelated', at: 0, kind: 'housekeeping', rule: 'housekeeping', outcome: 'done', attribution });
    let journalReads = 0;
    const realOpen = filesystem.open;
    const observed = vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
      const [path, flags] = args;
      if (String(path).startsWith(join(directory, 'machine-guard', 'activity-'))
        && (flags === 'r' || typeof flags === 'number' && (flags & (constants.O_WRONLY | constants.O_RDWR)) === 0)) journalReads++;
      return realOpen(...args);
    });
    try {
      const restoration = createGuardSessionRestoration({ activity: fixture.activity, nowMs: Date.now });
      for (let index = 0; index < 5; index++) await restoration.onSessionRunnerStarted({
        trackingKey: legacyPidSessionTrackingKey(40 + index), pid: 40 + index, happySessionId: `fresh-${index}`, startedBy: 'daemon', requesterWorkAttributionV1: attribution,
      });
      expect(journalReads).toBe(0);
      expect((await fixture.activity.list({ range: 'today' })).entries.map(row => row.id)).toEqual(['unrelated']);
    } finally { observed.mockRestore(); await fixture.close(); }
  });
  it.each(['idle', 'memory'] as const)('folds a %s stop receipt when the native replacement is ready before the receipt is appended', async rule => {
    const fixture = await setup('session', rule === 'memory');
    try {
      const attribution = { serverId: 'home', accountId: 'owner', machineId: 'm', installationId: 'installation' };
      const restored: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(40), pid: 40, happySessionId: 's', startedBy: 'daemon', requesterWorkAttributionV1: attribution,
        happySessionMetadataFromLocalWebhook: { path: '/project', host: 'host', homeDir: '/home/test', happyHomeDir: '/home/test/.happier',
          happyLibDir: '/opt/happier', happyToolsDir: '/home/test/.happier/tools' } };
      const restoration = createGuardSessionRestoration({ activity: fixture.activity, nowMs: Date.now });
      // The Session notice RPC publishes this same requested metadata before acknowledging the stop intent.
      fixture.onNotice(async state => {
        if (state.kind === 'stopped') restored.happySessionMetadataFromLocalWebhook!.sessionGuardStateV1 = { v: 1, ...state, kind: 'requested' };
      });
      // OS launch/stop ordering: replacement webhook settles before the outgoing stop acknowledgement.
      fixture.onNativeStop(async () => {
        await restoration.onSessionRunnerStarted(restored);
        fixture.setPresent(false);
      });
      fixture.onStopRecorded(async () => { await restoration.onSessionRunnerStarted(restored); });
      fixture.setSessionAttribution(attribution);
      if (rule === 'idle') fixture.setIdlePolicy({ enabled: true, afterMs: 600000 });
      await fixture.drain();
      if (rule === 'idle') { await vi.advanceTimersByTimeAsync(600000); await fixture.drain(); }
      else for (let minute = 0; minute < 8; minute++) { await vi.advanceTimersByTimeAsync(60000); await fixture.drain(); }
      expect(fixture.stops).toBe(1);
      const receipt = (await fixture.activity.list({ range: 'today' })).entries.find(row => row.kind === 'stopped_session');
      expect(receipt).toBeDefined();
      expect(receipt?.undoneAt).toBe(receipt?.at);
    } finally { await fixture.close(); }
  });
  it('retains a failed wake receipt and marks the stopped Session undone only after it actually starts', async () => {
    const fixture = await setup('session', false);
    const attribution = { serverId: 'home', accountId: 'owner', machineId: 'm', installationId: 'installation' };
    try {
      await fixture.activity.append({ v: 1, id: 'prior-stop', at: 0, kind: 'stopped_session', rule: 'idle_sessions', outcome: 'done', attribution,
        subject: { kind: 'session', sessionId: 'stopped', title: 'Authored title' },
        wayBack: [{ label: 'resume', actionId: 'session.open', input: { sessionId: 'stopped' } }] });
      const restoration = createGuardSessionRestoration({ activity: fixture.activity, nowMs: Date.now });
      await restoration.onActivationRejected({ sessionId: 'stopped', reason: 'spawn-rejected', requester: attribution, failure: { reason: 'no_ptys' } });
      expect((await fixture.activity.list({ range: 'today' })).entries).toContainEqual(expect.objectContaining({
        kind: 'start_failed', ref: 'prior-stop', failure: { reason: 'no_ptys' }, nextStep: 'close_idle_terminals',
      }));
      expect((await fixture.activity.read('prior-stop'))?.undoneAt).toBeUndefined();
      await restoration.onSessionRunnerStarted({ trackingKey: legacyPidSessionTrackingKey(40), pid: 40, happySessionId: 'stopped', startedBy: 'daemon', requesterWorkAttributionV1: attribution,
        happySessionMetadataFromLocalWebhook: { path: '/project', host: 'host', homeDir: '/home/test', happyHomeDir: '/home/test/.happier',
          happyLibDir: '/opt/happier', happyToolsDir: '/home/test/.happier/tools', sessionGuardStateV1: { v: 1, kind: 'stopped', at: 0, rule: 'idle_sessions' } } });
      expect((await fixture.activity.read('prior-stop'))?.undoneAt).toBe(0);
    } finally { await fixture.close(); }
  });
  it('keeps simultaneous Session countdowns separate while sharing the earliest real deadline', async () => {
    const fixture = await setup('session', false, undefined, 2);
    try {
      fixture.setIdlePolicy({ enabled: true, afterMs: 600000 }); await fixture.drain();
      await vi.advanceTimersByTimeAsync(300000); await fixture.drain();
      expect(fixture.runtime.readSessionWarning('s')).toEqual({ stopAt: 600000 });
      expect(fixture.runtime.readSessionWarning('s2')).toEqual({ stopAt: 600000 });
      expect(await fixture.runtime.keepRunning('s')).toBe('kept'); await fixture.drain();
      expect(fixture.runtime.readSessionWarning('s')).toBeUndefined();
      expect(fixture.runtime.readSessionWarning('s2')).toEqual({ stopAt: 600000 });
      await vi.advanceTimersByTimeAsync(300000); await fixture.drain();
      expect(fixture.stoppedIds).toEqual(['s2']);
      expect(fixture.runtime.readSessionWarning('s')).toEqual({ stopAt: 900000 });
      await vi.advanceTimersByTimeAsync(300000); await fixture.drain();
      expect(fixture.stoppedIds).toEqual(['s2', 's']);
      expect((await fixture.activity.list({ range: 'today' })).entries.filter(entry => entry.kind === 'stopped_session')).toEqual([
        expect.objectContaining({ subject: expect.objectContaining({ sessionId: 's' }), wayBack: [{ label: 'resume', actionId: 'session.open', input: { sessionId: 's', intent: 'resume' } }] }),
        expect.objectContaining({ subject: expect.objectContaining({ sessionId: 's2' }) })]);
    } finally { await fixture.close(); }
  });
  it('withdraws idle warnings on Keep running, draft edits and policy changes, anchoring the next deadline to the latest tombstone', async () => {
    const fixture = await setup('session', false);
    try {
      fixture.setIdlePolicy({ enabled: true, afterMs: 600000 }); await fixture.drain();
      await vi.advanceTimersByTimeAsync(300000); await fixture.drain();
      expect(fixture.runtime.readSessionWarning('s')).toEqual({ stopAt: 600000 });
      expect(await fixture.runtime.keepRunning('s')).toBe('kept'); await fixture.drain();
      expect(fixture.runtime.readSessionWarning('s')).toBeUndefined();
      expect((await fixture.activity.list({ range: 'today' })).entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'kept_running', rule: 'idle_sessions' })]));
      await vi.advanceTimersByTimeAsync(300000); await fixture.drain();
      expect(fixture.runtime.readSessionWarning('s')).toEqual({ stopAt: 900000 });
      fixture.setDraft({ status: 'present', updatedAt: 600000 }); await fixture.drain();
      expect(fixture.runtime.readSessionWarning('s')).toBeUndefined();
      fixture.setDraft({ status: 'absent', updatedAt: 600000 }); await fixture.drain();
      await vi.advanceTimersByTimeAsync(300000); await fixture.drain();
      expect(fixture.runtime.readSessionWarning('s')).toEqual({ stopAt: 1200000 });
      fixture.setIdlePolicy({ afterMs: 1200000 }); await fixture.drain();
      expect(fixture.runtime.readSessionWarning('s')).toBeUndefined();
      await vi.advanceTimersByTimeAsync(300000); await fixture.drain();
      expect(fixture.stops).toBe(0);
      expect(fixture.notices.filter(state => state.kind === 'clear')).toHaveLength(3);
    } finally { await fixture.close(); }
  });
  it('fails closed once when an idle warning is unavailable, and does not spin on a past deadline', async () => {
    const fixture = await setup('session', false);
    try {
      fixture.setNoticeAvailable(false);
      fixture.setIdlePolicy({ enabled: true, afterMs: 600000 }); await fixture.drain();
      await vi.advanceTimersByTimeAsync(300000); await fixture.drain();
      const reads = fixture.reads;
      expect(fixture.runtime.readSessionWarning('s')).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1200000); await fixture.drain();
      expect(fixture.reads).toBe(reads);
      expect(fixture.notices.filter(state => state.kind === 'stopping')).toHaveLength(1);
      expect(fixture.stops).toBe(0);
      fixture.setNoticeAvailable(true); fixture.changed(); await fixture.drain();
      expect(fixture.stops).toBe(1);
    } finally { await fixture.close(); }
  });
  it('re-admits idle work after the durable stop marker and leaves no stopped metadata after stop failure', async () => {
    const fixture = await setup('session', false);
    try {
      fixture.setIdlePolicy({ enabled: true, afterMs: 600000 }); await fixture.drain();
      fixture.onNotice(async state => { if (state.kind === 'stopped') fixture.setWorking(true); });
      await vi.advanceTimersByTimeAsync(600000); await fixture.drain();
      expect(fixture.stops).toBe(0);
      expect(fixture.runtime.readSessionWarning('s')).toBeUndefined();
      fixture.onNotice(undefined); fixture.setWorking(false); fixture.setFailed(true); await fixture.drain();
      expect(fixture.stops).toBe(1);
      expect(fixture.notices.at(-1)).toEqual({ kind: 'clear' });
      const reads = fixture.reads;
      await vi.advanceTimersByTimeAsync(600000); await fixture.drain();
      expect(fixture.reads).toBe(reads);
      expect(fixture.stops).toBe(1);
      expect((await fixture.activity.list({ range: 'today' })).entries.filter(entry => entry.kind === 'stop_failed')).toEqual([
        // The final owner now settles the cancelled working intent as well as
        // the later genuine native failure; neither means the Session stopped.
        expect.objectContaining({ rule: 'idle_sessions', outcome: 'failed', note: 'stop_incomplete' }),
        expect.objectContaining({ rule: 'idle_sessions', outcome: 'failed', note: 'working' })]);
    } finally { await fixture.close(); }
  });
  it.each(['idle', 'memory'] as const)('uses only the final exact Session admission after an awaited %s stop notice', async rule => {
    const fixture = await setup('session', rule === 'memory', undefined, 5);
    let readsAtNotice = 0;
    let readsAtNative: number | undefined;
    try {
      if (rule === 'idle') fixture.setIdlePolicy({ enabled: true, afterMs: 600000 });
      fixture.onNotice(async state => {
        if (state.kind !== 'stopped') return;
        // The network ACK yields after planning; final admission must not
        // re-observe four unrelated Session transports before this target.
        readsAtNotice = fixture.activityReads;
        await Promise.resolve();
      });
      fixture.onNativeStop(async () => { readsAtNative ??= fixture.activityReads - readsAtNotice; });
      for (let minute = 0; minute < (rule === 'idle' ? 10 : 6); minute++) {
        await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      }
      expect(fixture.stoppedIds).toContain('s');
      expect(readsAtNative).toBe(1);
    } finally { await fixture.close(); }
  });
  it('uses canonical native low-memory pressure for admission, critical receipts and observed recovery', async () => {
    const fixture = await setup('browser', true, true);
    fixture.setAvailable(20);
    try {
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.stops).toBe(1);
      expect(fixture.runtime.readEpisode()).toMatchObject({ state: 'verifying' });
      fixture.setPresent(false); fixture.setAvailable(100); await fixture.drain();
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect((await fixture.activity.list({ range: 'today' })).entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'closed_browser', outcome: 'done', trigger: expect.objectContaining({ level: 'critical' }) })]));
      expect(fixture.runtime.readEpisode()).toMatchObject({ state: 'out_of_steps' });
      fixture.setLowMemorySignal(undefined);
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.runtime.readEpisode()).toMatchObject({ state: 'out_of_steps' });
      fixture.setLowMemorySignal(false);
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.runtime.readEpisode()).toBeUndefined();
      expect(new Set(fixture.sampled)).toEqual(new Set([60000]));
    } finally { await fixture.close(); }
  });
  it('does not act while paused and records a native stop failure once without retrying the same generation', async () => {
    const fixture = await setup();
    try {
      fixture.setPolicy({ pausedUntil: 180000 }); fixture.setFailed(true);
      await vi.advanceTimersByTimeAsync(120000); await fixture.drain();
      expect(fixture.stops).toBe(0);
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.stops).toBe(1);
      expect((await fixture.activity.list({ range: 'today' })).entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'stop_failed', outcome: 'failed' }), expect.objectContaining({ kind: 'out_of_steps' })]));
      await vi.advanceTimersByTimeAsync(120000); await fixture.drain();
      expect(fixture.stops).toBe(1);
    } finally { await fixture.close(); }
  });
  it('breaks sustain on a missing minute and still verifies a disabled rule without assuming it helped', async () => {
    const fixture = await setup();
    try {
      fixture.setPolicy({ sustainMs: 120000 });
      fixture.setMissing(true); await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      fixture.setMissing(false); await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.stops).toBe(0);
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.stops).toBe(1);
      fixture.setPolicy({ enabled: false }); fixture.setPresent(false); fixture.setLevel('not_reported'); await fixture.drain();
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect((await fixture.activity.list({ range: 'today' })).entries).toEqual([
        expect.objectContaining({ kind: 'closed_browser', outcome: 'did_not_help', freedBytes: 0 })]);
      expect(fixture.runtime.readEpisode()).toBeUndefined();
      expect(fixture.stops).toBe(1);
    } finally { await fixture.close(); }
  });
  it('reclaims an idle Session host only under sustained scarcity, before user resources', async () => {
    const fixture = await setup('browser');
    const reclaim = vi.fn(async () => { fixture.setPresent(false); return true; });
    try {
      fixture.setAvailable(600);
      fixture.setSessionHost({ pid: 10, stop: reclaim });
      for (let minute = 0; minute < 3; minute++) { await vi.advanceTimersByTimeAsync(60_000); await fixture.drain(); }
      expect(reclaim).not.toHaveBeenCalled();
      fixture.setAvailable(50);
      for (let minute = 0; minute < 3; minute++) { await vi.advanceTimersByTimeAsync(60_000); await fixture.drain(); }
      expect(reclaim).toHaveBeenCalledTimes(1);
      expect(fixture.stops).toBe(0);
      expect(fixture.notices).toEqual([]);
    } finally { await fixture.close(); }
  });

  it('acts only on real scarcity: a kernel stall with most memory available releases nothing, scarcity releases the idle Session', async () => {
    const fixture = await setup('session');
    try {
      // The kernel reports a critical stall (e.g. Linux PSI) while 60 % of memory is available.
      fixture.setAvailable(600);
      for (let minute = 0; minute < 8; minute++) { await vi.advanceTimersByTimeAsync(60000); await fixture.drain(); }
      expect({ stops: fixture.stops, notices: fixture.notices.length, episode: fixture.runtime.readEpisode() })
        .toEqual({ stops: 0, notices: 0, episode: undefined });
      fixture.setAvailable(50);
      for (let minute = 0; minute < 8; minute++) { await vi.advanceTimersByTimeAsync(60000); await fixture.drain(); }
      expect(fixture.stoppedIds).toEqual(['s']);
    } finally { await fixture.close(); }
  });
  it('publishes the Session warning, honors Keep running, and re-admits activity after an awaited stop marker', async () => {
    const fixture = await setup('session');
    try {
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.runtime.readSessionWarning('s')).toEqual({ stopAt: 360000 });
      expect(await fixture.runtime.keepRunning('s')).toBe('kept'); await fixture.drain();
      expect(fixture.runtime.readKeepRunningAnchor('s')).toBe(60000);
      expect(fixture.notices).toContainEqual({ kind: 'clear' });
      fixture.onNotice(async state => { if (state.kind === 'stopped') fixture.setWorking(true); });
      for (let minute = 0; minute < 5; minute++) { await vi.advanceTimersByTimeAsync(60000); await fixture.drain(); }
      expect(fixture.notices).toContainEqual(expect.objectContaining({ kind: 'stopped' }));
      expect(fixture.stops).toBe(0);
      expect(fixture.runtime.readSessionWarning('s')).toBeUndefined();
    } finally { await fixture.close(); }
  });
  it('re-admits actual browser control when a human takes over during another Session RPC read', async () => {
    const fixture = await setup();
    try {
      fixture.duringActivityRead(async () => { await Promise.resolve(); fixture.takeOverBrowser(); });
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.stops).toBe(0);
      expect((await fixture.activity.list({ range: 'today' })).entries.some(entry => entry.kind === 'closed_browser')).toBe(false);
    } finally { await fixture.close(); }
  });
  it('clears the shared Session stop notice when the canonical stop boundary rejects the request', async () => {
    const fixture = await setup('session');
    try {
      fixture.setFailed(true);
      for (let minute = 0; minute < 6; minute++) { await vi.advanceTimersByTimeAsync(60000); await fixture.drain(); }
      expect(fixture.stops).toBe(1);
      expect(fixture.notices.at(-1)).toEqual({ kind: 'clear' });
      expect((await fixture.activity.list({ range: 'today' })).entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'stop_failed', outcome: 'failed' })]));
    } finally { await fixture.close(); }
  });
  it('uses only the existing minute cadence for Project service connection sustain and never erases a visitor observed within a minute', async () => {
    const fixture = await setup('service');
    try {
      fixture.setPolicy({ sustainMs: 60000 });
      fixture.setConnections(1);
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      fixture.setConnections(0); await fixture.drain();
      expect(fixture.stops).toBe(0);
      expect(fixture.runtime.readPreview()?.steps[1]?.candidates).toEqual([]);
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.stops).toBe(0);
      expect(fixture.runtime.readPreview()?.steps[1]?.candidates).toHaveLength(1);
      fixture.setLevel('calm');
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      fixture.setLevel('critical');
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.stops).toBe(1);
      expect(new Set(fixture.sampled)).toEqual(new Set([60000]));
    } finally { await fixture.close(); }
  });
  it('does not backdate a Project service first observed quiet just before the next minute', async () => {
    const fixture = await setup('service', false);
    try {
      await vi.advanceTimersByTimeAsync(59000); await fixture.drain();
      fixture.setPolicy({ enabled: true }); await fixture.drain();
      expect(fixture.runtime.readPreview()?.steps[1]?.candidates).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000); await fixture.drain();
      expect(fixture.stops).toBe(0);
      expect(fixture.runtime.readPreview()?.steps[1]?.candidates).toEqual([]);
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.runtime.readPreview()?.steps[1]?.candidates).toHaveLength(1);
      expect(new Set(fixture.sampled)).toEqual(new Set([60000]));
    } finally { await fixture.close(); }
  });
  it.each(['preview', 'fire'] as const)('cancels the %s native observer on shutdown without cancelling its shared publisher', async phase => {
    const fixture = await setup('service');
    let releaseReply: () => void = () => {};
    let entered: () => void = () => {};
    const request = new Promise<void>(resolve => { releaseReply = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let published = false;
    // Deferred native/network reply shared with the existing scanner publisher.
    const publisher = request.then(() => { published = true; });
    try {
      fixture.duringNativeRead(async readSignal => {
        if (phase === 'fire' && fixture.runtime.readEpisode()?.state !== 'acting') return;
        entered();
        await waitForChangeOrDeadline({ signal: readSignal, waitForChange: () => request });
        readSignal?.throwIfAborted();
      });
      if (phase === 'fire') await vi.advanceTimersByTimeAsync(60000);
      else fixture.changed();
      await started;
      fixture.abort(); await fixture.drain();
      expect(fixture.finished()).toBe(true);
      expect(fixture.stops).toBe(0);
      expect(published).toBe(false);
      releaseReply(); await publisher;
      expect(published).toBe(true);
    } finally { releaseReply(); await publisher; await fixture.close(); }
  });
  it('breaks Project service connection sustain on unknown counts and missing minutes, and honors actual workspace Session activity', async () => {
    const fixture = await setup('service');
    try {
      fixture.setPolicy({ sustainMs: 120000 }); fixture.setConnections(null);
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      fixture.setConnections(0);
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.stops).toBe(0);
      fixture.setMissing(true); await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      fixture.setMissing(false); fixture.setWorking(true);
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.stops).toBe(0);
      fixture.setWorking(false); await fixture.drain();
      expect(fixture.runtime.readPreview()?.steps[1]?.candidates).toEqual([]);
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.runtime.readPreview()?.steps[1]?.candidates).toHaveLength(1);
      fixture.setLevel('calm'); await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      fixture.setLevel('critical');
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      await vi.advanceTimersByTimeAsync(60000); await fixture.drain();
      expect(fixture.stops).toBe(1);
    } finally { await fixture.close(); }
  });
});
