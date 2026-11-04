import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineGuardViewV1Schema } from '@happier-dev/protocol/machines/guard/guardRpcV1';
import { localServiceProcfsFixture } from '../../local/services/inventory/platform/censusFixture.testkit';
import { createManagedActivityInventory, type LiveWorkItemV1 } from '../../lifecycle/managedActivity';
import { createProcessOwnershipRuntime } from '../../processes/ownership/processOwnershipRuntime';
import { createLeftBehindPass } from '../../processes/leftBehind/leftBehindPass';
import { createMachineResourcesPolicyRuntime } from '../../resources/machineResourcesPolicy';
import { createMachineResourceSummary } from '../../resources/machineResourceSummary';
import { createKeepAwake } from '@/integrations/keepAwake';
import { createMachineVitalsSampler } from '../../vitals/createMachineVitalsSampler';
import { createLinuxMachineVitalsReader } from '../../vitals/readers/linux';
import { createLinuxVitalsFixture } from '../../vitals/readers/linux.testkit';
import { createMinuteHistoryStore } from '../../vitals/history/minuteHistoryStore';
import { createActivityLog } from '../activityLog';
import { evaluateSessionEligibility } from '../sessionEligibility';
import { planGuard, projectGuardLadderV1, type GuardFacts, type GuardTarget } from '../guardPlanner';
import { createGuardRuntime } from '../guardRuntime';
import { createGuardStatePublication } from '../guardStatePublication';
import type { TrackedSession } from '../../types';
import { createGuardWatch } from './guardWatch';
import { createIdleTerminalPolicyFixture } from '../idleTerminalPolicy.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => { runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
  runtimeOptions: { pluginIds: ['happier.agent.codex'] } }); });
afterAll(async () => { await runtime?.dispose(); });

const epoch = Date.UTC(2026, 9, 10);
const target = { serverId: 'home', machineId: 'machine', installationId: 'installation' };
const requester = { serverId: 'home', accountId: 'alice', isCustodian: false };
const attribution = { ...target, accountId: 'alice' };

describe('Guard requester view and parked watch', () => {
  let directory: string;
  const cleanup: Array<() => Promise<void> | void> = [];
  beforeEach(async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    directory = await mkdtemp(join(tmpdir(), 'happier-guard-watch-'));
  });
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
    vi.useRealTimers(); await rm(directory, { recursive: true, force: true });
  });

  async function setup(otherAccount = 'bob', workState: 'settled' | 'active' = 'settled', withProjectServices = false, withTerminals = false, failBrowser = false) {
    const os = await createLinuxVitalsFixture(); cleanup.push(os.cleanup);
    const readers = createLinuxMachineVitalsReader({ root: os.root });
    const historyStore = await createMinuteHistoryStore({ directory: join(directory, 'history'), nowMs: Date.now });
    const sampler = createMachineVitalsSampler({ readers, historyStore, nowMs: Date.now, monotonicMs: Date.now });
    await sampler.start(); cleanup.push(() => sampler.stop());
    const summary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, nowMs: Date.now,
      onError: error => { throw error; } }); cleanup.push(() => summary.stop());
    const tracked = [1001, 1002, 1003].map((pid, index): TrackedSession => ({ pid, startedBy: 'daemon', happySessionId: `s${index}` }));
    const browserOwner = {};
    const projects = [{ id: 'own-project', workspace: { rootPath: '/own-project' }, attribution },
      { id: 'other-project', workspace: { rootPath: '/other-project' }, attribution: { ...attribution, accountId: 'bob' } }];
    let heldActivityReply: Readonly<{ entered(): void; waiting: Promise<void> }> | undefined;
    const inventory = createManagedActivityInventory({ now: Date.now, producers: [{
      // Genuine Session activity transport boundary; inventory admission/coalescing remains real.
      read: async () => {
        const held = heldActivityReply; heldActivityReply = undefined;
        if (held) { held.entered(); await held.waiting; }
        return { coverage: 'complete', items: tracked.map((session, index): LiveWorkItemV1 => ({
        category: 'session', ownerRef: session, state: workState, settledAt: epoch - 120_000,
        attribution: index === 0 ? attribution : index === 1 ? { ...attribution, accountId: otherAccount }
          : { ...attribution, installationId: 'foreign-installation' },
        })) };
      }, subscribe: () => () => {},
    }] }); cleanup.push(() => inventory.dispose());
    let nativeReads = 0;
    let rootReads = 0;
    let heldNativeRead: Readonly<{ entered(): void; waiting: Promise<void> }> | undefined;
    let guardName = 'systemd-oomd';
    let memoryPages = 1;
    const procfs = localServiceProcfsFixture([...tracked.map(item => ({ pid: item.pid })), { pid: 1004 }, { pid: 1005 },
      ...(withProjectServices ? [{ pid: 1006 }, { pid: 1007 }] : [])]);
    const ownership = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', platform: 'linux',
      censusDependencies: { platform: 'linux', linuxBoundary: { ...procfs,
        readdir: async path => {
          const held = heldNativeRead; heldNativeRead = undefined;
          if (held) { held.entered(); await held.waiting; }
          nativeReads++; return procfs.readdir(path);
        },
        readFile: async path => {
          if (path === '/proc/self/auxv') {
            const value = Buffer.alloc(32); value.writeBigUInt64LE(6n, 0); value.writeBigUInt64LE(4096n, 8); return value;
          }
          const result = await procfs.readFile(path);
          if (path === '/proc/1005/stat') return String(result).replace('(node)', `(${guardName})`);
          if (/\/proc\/100[1-467]\/stat$/u.test(path)) return String(result).replace(/4096 1$/u, `4096 ${memoryPages}`);
          return result;
        },
      } },
      listRoots: snapshot => { rootReads++; return snapshot.rows.filter(row => row.pid >= 1001 && row.pid <= 1004
        || withProjectServices && row.pid >= 1006 && row.pid <= 1007).map(row => ({
        pid: row.pid, start: row.start, live: true, ownerCreatedAtMs: epoch - 120_000,
        stop: async () => {},
        owner: row.pid >= 1006 ? { kind: 'service' as const, serviceId: `project-service-${row.pid}` }
          : row.pid === 1004 ? { kind: 'browser_sidecar' as const }
          : { kind: 'session' as const, sessionId: `s${row.pid - 1001}` },
      })); },
    });
    let metadata: Record<string, unknown> = {};
    let metadataVersion = 2;
    const policy = createMachineResourcesPolicyRuntime({ port: {
      read: async () => ({ status: 'ready', metadata, metadataVersion }),
      // Genuine Machine metadata transport boundary; policy normalization/CAS remain real.
      compareAndSwap: async request => {
        if (request.expectedMetadataVersion !== metadataVersion) return { status: 'conflict', metadata, metadataVersion };
        metadata = request.metadata; metadataVersion++;
        return { status: 'applied', metadata, metadataVersion };
      },
    } }); await policy.reload(); cleanup.push(() => policy.stop());
    const activityLog = await createActivityLog({ activeServerDir: directory, nowMs: Date.now,
      resourceSummary: summary });
    for (const [id, who] of [['own', attribution], ['other', { ...attribution, accountId: otherAccount }],
      ['foreign', { ...attribution, installationId: 'foreign-installation' }]] as const) {
      await activityLog.append({ v: 1, id, at: epoch, kind: 'stopped_session', rule: 'idle_sessions', outcome: 'done',
        subject: { kind: 'session', sessionId: id, title: id }, attribution: who });
    }
    const readFacts = async (owners: GuardFacts['ownership']): Promise<GuardFacts> => {
      const facts = await inventory.read();
      const targets: GuardTarget[] = owners.status !== 'ok' ? [] : await Promise.all(owners.roots.map(async (root): Promise<GuardTarget> => {
        if (root.owner.kind === 'service') {
          const project = projects[root.pid - 1006]!;
          return { kind: 'service', root, ownerRef: project, label: `private-${project.id}-service`,
            scope: 'project', workspacePath: project.workspace.rootPath, workspaceIdle: true,
            attribution: project.attribution, listeners: [{ establishedConnections: 0 }],
            wayBack: [{ label: 'start_again', actionId: 'localServices.launcher.start', input: {
              machineId: 'machine', serviceId: root.owner.serviceId,
            } }] };
        }
        if (root.owner.kind === 'browser_sidecar') return { kind: 'browser', root, ownerRef: browserOwner,
          label: 'private-browser', idle: true, settledAt: epoch - 120_000,
          wayBack: [{ label: 'reopen', actionId: 'browser.view.open', input: { machineId: 'machine' } }] };
        const session = tracked.find(item => item.pid === root.pid)!;
        return { kind: 'session', root, tracked: session, label: `private-${session.happySessionId}`,
          eligibility: (await evaluateSessionEligibility({ tracked: session, inventory: facts, draft: { status: 'absent' }, resume: {
            sessionId: session.happySessionId!, rawSession: { machineId: 'machine', path: '/project' },
            metadata: { runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: { backendMode: 'appServer' } }, machineId: 'machine', path: '/project', flavor: 'codex', codexSessionId: `native-${session.happySessionId}` },
          } })) };
      }));
      return { ownership: owners, inventory: facts, targets };
    };
    const changes = new Set<() => void>();
    const waitingForPark = new Set<() => void>();
    let onSubscribe: (() => void) | undefined;
    let reachedStop!: () => void;
    const stopEntered = new Promise<void>(resolve => { reachedStop = resolve; });
    const sessionState = createGuardRuntime({ vitals: sampler, readPolicy: () => {
      const current = policy.read(); if (current.status !== 'ready') throw new Error('Policy unavailable');
      return current.policy.guard;
    }, subscribePolicy: policy.subscribe, subscribe: () => () => {},
      readFacts: async () => readFacts(await ownership.readOwners({ freshness: 'fresh' })),
      // Real owner logic runs until its genuine process-stop boundary; cancellation releases it.
      stop: async (candidate, signal) => candidate.kind === 'browser' && failBrowser
        ? { status: 'failed', reason: 'browser_still_running' } : new Promise(resolve => {
        reachedStop(); signal.addEventListener('abort', () => resolve({ status: 'failed', reason: 'cancelled' }), { once: true });
      }), notice: async () => true,
      activity: activityLog, notifyEpisode: async () => {}, nowMs: Date.now, onError: error => { throw error; },
    });
    const keepAwake = createKeepAwake({ platform: 'linux', exists: () => false }); await keepAwake.update();
    cleanup.push(() => keepAwake.release());
    const publication = createGuardStatePublication({ sampler, summary, keepAwake, episodeOwner: sessionState,
      ceilingCapability: { status: 'unavailable', reason: 'no_user_manager' } }); cleanup.push(() => publication.stop());
    const leftBehind = createLeftBehindPass({ processOwnershipRuntime: ownership }); cleanup.push(() => leftBehind.dispose());
    const terminalFixture = withTerminals ? await createIdleTerminalPolicyFixture(cleanup) : undefined;
    if (terminalFixture) for (const [terminalKey, requesterAccountId, installationId] of [
      ['own-private-terminal', 'alice', 'installation'], ['other-private-terminal', 'bob', 'installation'],
      ['old-private-terminal', 'alice', 'old-installation'],
    ]) await terminalFixture.terminals.ensure({ terminalKey: terminalKey!, cwd: '/project',
      custody: { ...target, requesterAccountId: requesterAccountId!, installationId: installationId!, kind: 'machine', rootPath: '/project' } });
    const view = createGuardWatch({ policy, sampler, ownership, readFacts, readState: publication.read, readTarget: () => target,
      ...(terminalFixture ? { terminalState: terminalFixture.owner.terminalState } : {}),
      activityLog, sessionState, readLeftBehind: () => ({ count: leftBehind.confirmed().length, footprintBytes: 0 }),
      platform: 'linux', nowMs: Date.now, subscribe: listener => {
        changes.add(listener); onSubscribe?.();
        for (const ready of waitingForPark) ready(); waitingForPark.clear();
        return () => { changes.delete(listener); };
      } });
    cleanup.push(() => view.dispose());
    return { view, sampler, policy, ownership, readFacts, activityLog, inventory,
      holdActivityReply: () => {
        let release!: () => void;
        let entered!: () => void;
        const waiting = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        heldActivityReply = { entered, waiting }; cleanup.push(release);
        return { entered: started, release };
      },
      holdNativeRead: () => {
        let release!: () => void;
        let entered!: () => void;
        const waiting = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        heldNativeRead = { entered, waiting }; cleanup.push(release);
        return { entered: started, release };
      },
      nativeReads: () => nativeReads, rootReads: () => rootReads, setGuardName: (name: string) => { guardName = name; },
      setMemory: (pages: number) => { memoryPages = pages; }, listeners: () => changes.size,
      onSubscribe: (callback: () => void) => { onSubscribe = callback; },
      parked: () => changes.size ? Promise.resolve() : new Promise<void>(resolve => { waitingForPark.add(resolve); }),
      enableMemory: async () => {
        const current = policy.read(); if (current.status !== 'ready') throw new Error('Policy unavailable');
        await policy.set({ expectedRevision: current.revision, patch: { guard: {
          memoryGuard: { enabled: true, sustainMs: 60_000 }, ...(failBrowser ? { idleSessions: { warnBeforeMs: 0 } } : {}),
        } } });
        await os.put('/proc/zoneinfo', 'Node 0, zone Normal\n pages free 0\n min 10\n low 20\n high 30\n');
        await os.put('/proc/pressure/memory', 'some avg10=1.00 avg60=1.00 avg300=1.00 total=1\nfull avg10=1.00 avg60=1.00 avg300=1.00 total=1\n');
      },
      runMemory: () => {
        const controller = new AbortController(); const running = sessionState.run(controller.signal);
        cleanup.push(async () => { controller.abort(); await running; });
        return stopEntered;
      },
    };
  }

  it('runs one full census for concurrent passive Guard consumers per observation and none without demand', async () => {
    const h = await setup();
    const consumers = 8;
    const before = h.nativeReads();
    const rootsBefore = h.rootReads();
    for (let tick = 0; tick < 4; tick++) {
      const results = await Promise.all(Array.from({ length: consumers }, (_, index) => index % 2
        ? h.view.watch({ machineId: 'machine' }, requester)
        : h.view.readView(requester)));
      for (const result of results) {
        const view = 'changed' in result ? result.changed ? result.view : undefined : result;
        expect(view?.idle.map(row => row.sessionRef)).toEqual(['s0']);
        expect(JSON.stringify(view)).not.toContain('private-s1');
      }
      expect(h.nativeReads() - before).toBe(tick + 1);
      expect(h.rootReads() - rootsBefore).toBe(tick + 1);
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(h.nativeReads() - before).toBe(4);
    expect(h.rootReads() - rootsBefore).toBe(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.nativeReads() - before).toBe(4);
    h.setMemory(2);
    const current = await h.view.readView(requester);
    expect(current.ladder.summary.candidatesBytes).toBe(8192);
    expect(h.nativeReads() - before).toBe(5);
  });

  it('keeps an effect-time fresh census independent of concurrent passive Guard readers', async () => {
    const h = await setup();
    const held = h.holdNativeRead();
    const before = h.nativeReads();
    const preview = h.view.readView(requester);
    await held.entered;
    try {
      const fresh = await h.ownership.readOwners({ freshness: 'fresh' });
      expect(fresh.status).toBe('ok');
      expect(h.nativeReads() - before).toBe(1);
    } finally { held.release(); }
    expect((await preview).idle.map(row => row.sessionRef)).toEqual(['s0']);
    expect(h.nativeReads() - before).toBe(2);
  });

  it('returns the real planner preview while disclosing only exactly attributed private rows', async () => {
    const h = await setup();
    const custodian = await h.view.readView({ ...requester, isCustodian: true });
    const full = planGuard({ ...await h.readFacts(await h.ownership.readOwners({ freshness: 'fresh' })),
      memoryUsage: { inUseBytes: custodian.ladder.summary.inUseBytes, notHappiersBytes: custodian.ladder.summary.notHappiersBytes },
      policy: custodian.policy.memoryGuard, now: epoch });
    expect(custodian.ladder).toEqual(projectGuardLadderV1(full.ladder));
    const own = await h.view.readView(requester);
    expect(MachineGuardViewV1Schema.safeParse(own).success).toBe(true);
    expect(own.ladder.steps.flatMap(step => step.candidates).map(row => row.label)).toEqual(['private-s0']);
    expect(own.idle.map(row => row.sessionRef)).toEqual(['s0']);
    expect(own.recentActivity.map(row => row.id)).toEqual(['own']);
    expect(own.recentActivityOthers).toBe(2);
    expect(own.otherMemoryGuards).toEqual(['systemd-oomd']);
    expect(own.ladder.summary.candidatesBytes).toBe(4096);
    expect(own.ladder.summary.candidatesBytes).toBeLessThan(custodian.ladder.summary.candidatesBytes);
    expect(own.ladder.summary.notHappiersBytes).toBe(custodian.ladder.summary.notHappiersBytes);
    expect(own.othersWorkCount).toBe(3);
    expect(own.leftBehind.footprintBytes).toBeNull();
    expect(JSON.stringify(own)).not.toContain('private-browser');
    expect(JSON.stringify(own)).not.toContain('private-s1');
    await expect(h.view.readView({ ...requester, serverId: 'another-home' })).rejects.toMatchObject({ reason: 'wrong_target' });
    h.policy.stop();
    await expect(h.view.readView(requester)).rejects.toMatchObject({ name: 'GuardViewUnavailableError', reason: 'policy_unavailable' });
  });

  it('projects actual PTY private preview rows only for the exact requester, retaining aggregate others counts', async () => {
    const h = await setup('bob', 'settled', false, true);
    const full = await h.view.readView({ ...requester, isCustodian: true });
    expect(full.idleTerminals).toHaveLength(3);
    const own = await h.view.readView(requester);
    expect(MachineGuardViewV1Schema.safeParse(own).success).toBe(true);
    expect(own.idleTerminals?.map(row => row.terminalKey)).toEqual(['own-private-terminal']);
    expect(own.othersWorkCount).toBe(5);
    expect(JSON.stringify(own)).not.toContain('other-private-terminal');
    expect(JSON.stringify(own)).not.toContain('old-private-terminal');
    expect(own.idleTerminals?.[0]).not.toHaveProperty('attribution');
  });

  it('refreshes parked previews on summary samples and releases demand on cancellation', async () => {
    const h = await setup();
    const first = await h.view.watch({ machineId: 'machine' }, requester);
    expect(first.changed).toBe(true);
    if (!first.changed) throw new Error('Expected initial view');
    h.setGuardName('earlyoom');
    await vi.advanceTimersByTimeAsync(1_000);
    const controller = new AbortController();
    const pending = h.view.watch({ machineId: 'machine', since: first.since }, requester, controller.signal);
    // Only parked observations hold the sampler's canonical summary demand.
    await h.parked();
    expect(h.listeners()).toBe(1);
    h.setGuardName('systemd-oomd');
    h.setMemory(2);
    await vi.advanceTimersByTimeAsync(15_000); await h.sampler.start();
    expect(h.sampler.latest()?.intervalMs).toBe(15_000);
    const changed = await pending;
    expect(changed.changed).toBe(true);
    if (!changed.changed) throw new Error('Expected changed preview');
    expect(changed.since).toBeGreaterThan(first.since);
    expect(changed.view.ladder.summary.candidatesBytes).toBeGreaterThan(first.view.ladder.summary.candidatesBytes);
    expect(changed.view.otherMemoryGuards).toEqual(['earlyoom']);
    const waiting = h.view.watch({ machineId: 'machine', since: changed.since }, requester, controller.signal);
    await h.parked();
    controller.abort();
    await expect(waiting).resolves.toEqual({ changed: false });
    expect(h.listeners()).toBe(0);
    const reads = h.nativeReads();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.nativeReads()).toBe(reads);
    expect(h.sampler.latest()?.intervalMs).toBe(15_000);
    await vi.advanceTimersByTimeAsync(30_000); await h.sampler.start();
    expect(h.sampler.latest()?.intervalMs).toBe(60_000);
  });

  it('keeps a parked ladder on the summary cadence when Overview demands live samples', async () => {
    const h = await setup();
    const first = await h.view.watch({ machineId: 'machine' }, requester);
    if (!first.changed) throw new Error('Expected initial view');
    const release = h.sampler.demandOverview();
    const controller = new AbortController();
    let settled = false;
    const pending = h.view.watch({ machineId: 'machine', since: first.since }, requester, controller.signal)
      .then(result => { settled = true; return result; });
    const drain = async () => {
      await h.sampler.start();
      for (let read = 0; read < 4; read++) {
        await h.activityLog.list({ range: 'today' });
        for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      }
    };
    try {
      await h.parked();
      await vi.advanceTimersByTimeAsync(0); await drain();
      const reads = h.nativeReads();
      h.setMemory(2);
      for (let sample = 0; sample < 7; sample++) { await vi.advanceTimersByTimeAsync(2_000); await drain(); }
      expect(h.sampler.latest()?.intervalMs).toBe(2_000);
      expect(h.nativeReads()).toBe(reads);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000); await drain();
      const changed = await pending;
      expect(changed.changed).toBe(true);
      if (!changed.changed) throw new Error('Expected summary preview');
      expect(changed.view.ladder.summary.candidatesBytes).toBeGreaterThan(first.view.ladder.summary.candidatesBytes);
    } finally { controller.abort(); release(); await pending; }
  });

  it.each(['request', 'dispose'] as const)('releases initial readers on %s cancellation without cancelling the shared native producer', async mode => {
    const h = await setup();
    const native = h.holdNativeRead();
    const controller = new AbortController();
    const outcomes: string[] = [];
    const reader = h.view.readView(requester, controller.signal).then(() => { outcomes.push('read_completed'); }, error => {
      expect(error).toMatchObject({ name: 'GuardViewUnavailableError', reason: mode === 'dispose' ? 'stopped' : 'cancelled' });
      outcomes.push('read_cancelled');
    });
    const watcher = h.view.watch({ machineId: 'machine' }, requester, controller.signal).then(result => {
      expect(result).toEqual({ changed: false }); outcomes.push('watch_cancelled');
    });
    try {
      await native.entered;
      const reads = h.nativeReads();
      if (mode === 'dispose') h.view.dispose(); else controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect([...outcomes].sort()).toEqual(['read_cancelled', 'watch_cancelled']);
      expect(h.nativeReads()).toBe(reads);
    } finally {
      native.release(); await Promise.all([reader, watcher]);
    }
    expect((await h.ownership.readOwners({ freshness: 'fresh' })).status).toBe('ok');
    if (mode === 'request') expect((await h.view.readView(requester)).idle.map(row => row.sessionRef)).toEqual(['s0']);
  });

  it('releases a disposed reader while a shared Session activity reply remains independently readable', async () => {
    const h = await setup();
    const transport = h.holdActivityReply();
    let outcome = 'pending';
    const reader = h.view.readView(requester).then(() => { outcome = 'completed'; }, error => {
      expect(error).toMatchObject({ name: 'GuardViewUnavailableError', reason: 'stopped' }); outcome = 'stopped';
    });
    await transport.entered;
    let inventoryCompleted = false;
    const independent = h.inventory.read().then(result => { inventoryCompleted = true; return result; });
    try {
      h.view.dispose();
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe('stopped');
      expect(inventoryCompleted).toBe(false);
    } finally {
      transport.release(); await reader;
    }
    expect((await independent).coverage).toBe('complete');
    expect(inventoryCompleted).toBe(true);
  });

  it('uses machine in-use memory and canonical owned census bytes, not excluded targets or summed foreign RSS', async () => {
    const h = await setup();
    const view = await h.view.readView({ ...requester, isCustodian: true });
    const memory = h.sampler.latest()?.memory;
    if (!memory?.reported) throw new Error('Fixture memory unavailable');
    expect(view.ladder.summary.inUseBytes).toBe(memory.totalBytes - memory.availableBytes);
    expect(view.ladder.summary.notHappiersBytes).toBe(memory.totalBytes - memory.availableBytes - 4 * 4096);
    expect(view.ladder.summary.candidatesBytes).toBeGreaterThan(0);
    h.setMemory(1_000_000);
    const shared = await h.view.readView({ ...requester, isCustodian: true });
    expect(shared.ladder.summary.inUseBytes).toBe(memory.totalBytes - memory.availableBytes);
    expect(shared.ladder.summary.notHappiersBytes).toBe(0);
  });

  it('withholds foreign work bytes while reporting only other-work counts to a recipient', async () => {
    const h = await setup('carol', 'active');
    const custodian = await h.view.readView({ ...requester, isCustodian: true });
    expect(custodian.ladder.summary.candidatesBytes).toBeGreaterThan(0);
    expect(custodian.ladder.summary.workingBytes).toBeGreaterThan(0);
    expect(custodian.ladder.summary.inUseBytes).toBeGreaterThan(0);
    const bob = await h.view.readView({ ...requester, accountId: 'bob' });
    expect(bob.ladder.steps.map(step => step.freesAboutBytes)).toEqual([0, 0, 0]);
    expect(bob.ladder.summary).toMatchObject({ candidatesBytes: 0, inUseBytes: custodian.ladder.summary.inUseBytes, workingBytes: 0,
      workingSessions: 0, leftAloneSessions: 0 });
    expect(bob.othersWorkCount).toBe(4);
    expect(custodian.othersWorkCount).toBe(0);
    expect(bob.leftBehind).toEqual({ count: custodian.leftBehind.count, footprintBytes: null });
    expect(bob.ladder.steps.flatMap(step => step.candidates)).toEqual([]);
    expect(bob.ladder.excluded).toEqual([]);
    expect(JSON.stringify(bob)).not.toContain('private-');
  });

  it('uses captured Project attribution for private service rows and the runtime connection history for preview', async () => {
    const h = await setup('bob', 'settled', true);
    await h.enableMemory();
    const first = await h.view.readView({ ...requester, isCustodian: true });
    expect(first.ladder.steps[1]?.candidates).toEqual([]);
    const ownFirst = await h.view.readView(requester);
    expect(ownFirst.ladder.excluded.find(row => row.kind === 'service'))
      .toMatchObject({ label: 'private-own-project-service', reason: 'connections_unknown' });
    await vi.advanceTimersByTimeAsync(60_000); await h.sampler.start();
    const custodian = await h.view.readView({ ...requester, isCustodian: true });
    expect(custodian.ladder.steps[1]?.candidates.map(row => row.label)).toEqual([
      'private-own-project-service', 'private-other-project-service',
    ]);
    const own = await h.view.readView(requester);
    expect(own.ladder.steps[1]?.candidates.map(row => row.label)).toEqual(['private-own-project-service']);
    expect(own.ladder.steps[1]?.freesAboutBytes).toBe(4096);
    expect(own.ladder.summary.candidatesBytes).toBe(8192);
    expect(own.othersWorkCount).toBe(4);
    expect(JSON.stringify(own)).not.toContain('private-other-project-service');
    expect(JSON.stringify(own)).not.toContain('project-service-1007');
  });

  it('closes the read-subscribe gap and wakes for Activity without another sampling timer', async () => {
    const h = await setup();
    const first = await h.view.watch({ machineId: 'machine' }, requester);
    if (!first.changed) throw new Error('Expected initial view');
    h.onSubscribe(() => h.setMemory(3));
    const gap = await h.view.watch({ machineId: 'machine', since: first.since }, requester);
    expect(gap.changed).toBe(true);
    if (!gap.changed) throw new Error('Expected gap-closing view');
    expect(gap.view.ladder.summary.candidatesBytes).toBeGreaterThan(first.view.ladder.summary.candidatesBytes);
    const pending = h.view.watch({ machineId: 'machine', since: gap.since }, requester);
    await h.parked();
    await h.activityLog.append({ v: 1, id: 'new', at: epoch, kind: 'housekeeping', rule: 'housekeeping', outcome: 'done', attribution });
    const changed = await pending;
    expect(changed.changed).toBe(true);
    if (!changed.changed) throw new Error('Expected Activity view');
    expect(changed.view.recentActivity.map(row => row.id)).toContain('new');
    expect(h.listeners()).toBe(0);
  });

  it('wakes parked Activity readers when undoing yesterday leaves Today unchanged', async () => {
    const h = await setup();
    await h.activityLog.append({ v: 1, id: 'yesterday', at: epoch - 60_000, kind: 'stopped_session',
      rule: 'idle_sessions', outcome: 'done', attribution,
      wayBack: [{ label: 'resume', actionId: 'session.open', input: { sessionId: 'yesterday' } }] });
    const first = await h.view.watch({ machineId: 'machine' }, requester);
    if (!first.changed) throw new Error('Expected initial view');
    const controller = new AbortController();
    let answer: Awaited<ReturnType<typeof h.view.watch>> | undefined;
    const pending = h.view.watch({ machineId: 'machine', since: first.since }, requester, controller.signal)
      .then(value => { answer = value; });
    try {
      await h.parked();
      await h.activityLog.markUndone({ id: 'undo-yesterday', ref: 'yesterday', at: epoch, attribution });
      expect((await h.activityLog.list({ range: '7d' })).entries.find(row => row.id === 'yesterday'))
        .toMatchObject({ undoneAt: epoch });
      await vi.waitFor(() => expect(answer?.changed).toBe(true));
      if (!answer?.changed) throw new Error('Expected Activity invalidation');
      expect(answer.since).toBeGreaterThan(first.since);
      expect(answer.view.recentActivity).toEqual(first.view.recentActivity);
      const reads = h.nativeReads();
      await h.activityLog.append({ v: 1, id: 'earlier-day-append', at: epoch - 120_000, kind: 'housekeeping',
        rule: 'housekeeping', outcome: 'done', attribution });
      expect(h.nativeReads()).toBe(reads);
      const next = await h.view.watch({ machineId: 'machine', since: answer.since }, requester);
      expect(next.changed).toBe(true);
      if (!next.changed) throw new Error('Expected journal change between watches');
      expect(next.since).toBeGreaterThan(answer.since);
      expect(next.view.recentActivity).toEqual(first.view.recentActivity);
    } finally { controller.abort(); await pending; }
  });

  it('projects the actual acting episode onto its current rung without selecting another candidate', async () => {
    const h = await setup();
    await h.enableMemory();
    await vi.advanceTimersByTimeAsync(60_000); await h.sampler.start();
    await h.runMemory();
    const view = await h.view.readView({ ...requester, isCustodian: true });
    expect(view.state.episode).toMatchObject({ state: 'acting', step: 1 });
    expect(view.ladder.steps[0]?.status).toBe('run');
    expect(view.ladder.steps[0]?.candidates[0]?.label).toBe('private-browser');
    expect(view.ladder.steps.slice(1).some(step => step.status === 'done')).toBe(false);
  });

  it('excludes a failed still-present browser from the executable preview and shows the next session', async () => {
    const h = await setup('bob', 'settled', false, false, true);
    await h.enableMemory();
    await vi.advanceTimersByTimeAsync(60_000); await h.sampler.start();
    await h.runMemory();
    const view = await h.view.readView({ ...requester, isCustodian: true });
    expect(view.state.episode).toMatchObject({ state: 'acting', step: 3 });
    expect(view.ladder.steps[0]?.candidates).toEqual([]);
    expect(view.ladder.excluded).toContainEqual(expect.objectContaining({ label: 'private-browser', reason: 'stop_failed' }));
    expect(view.ladder.steps[2]?.status).toBe('run');
    expect(view.ladder.steps[2]?.candidates[0]?.label).toBe('private-s0');
    expect(view.recentActivity).toContainEqual(expect.objectContaining({ kind: 'stop_failed', note: 'browser_still_running' }));
  });
});
