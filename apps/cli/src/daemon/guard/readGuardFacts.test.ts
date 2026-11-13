import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserAutomationOwnerRegistry } from '../browser/automation/owners';
import { createProcessOwnershipRuntime } from '../processes/ownership/processOwnershipRuntime';
import type { HappierProcessRoot } from '../processes/ownership/types';
import type { ProcessCensusSnapshot } from '@/processes/census/processCensus';
import { normalizeLocalServiceScan, type LocalServiceListenerFact } from '../local/services/inventory/scanner';
import { createLocalServicesDaemonRuntime } from '../local/services/runtime';
import { createLocalServiceEndpointEnricher } from '../local/services/inventory/endpoint';
import { createLocalPageTitleEnricher } from '../local/services/inventory/pageTitle';
import { createManagedActivityInventory, type LiveWorkInventoryV1 } from '../lifecycle/managedActivity';
import type { TrackedSession } from '../types';
import { evaluateSessionEligibility } from './sessionEligibility';
import { createReadGuardFacts } from './readGuardFacts';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { applyDisplayTitleSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => { runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
  runtimeOptions: { pluginIds: ['happier.agent.codex'] } }); });
afterAll(async () => { await runtime?.dispose(); });

async function fixture() {
  const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(30), pid: 30, happySessionId: 's', processStartTimeMs: 1, startedBy: 'daemon',
    happySessionMetadataFromLocalWebhook: { path: '/project', host: 'host', homeDir: '/home/test',
      happyHomeDir: '/home/test/.happier', happyLibDir: '/opt/happier', happyToolsDir: '/home/test/.happier/tools',
      summary: { text: 'Build tests', updatedAt: 1 } } };
  const roots: HappierProcessRoot[] = [
    { owner: { kind: 'browser_sidecar' }, pid: 10, start: { startTimeMs: 1, native: 'browser' }, live: true, ownerCreatedAtMs: 1, stop: async () => undefined },
    { owner: { kind: 'service', serviceId: 'server', workspaceId: 'workspace' }, pid: 20, start: { startTimeMs: 1, native: 'service' }, live: true, ownerCreatedAtMs: 1, workspacePath: '/project/nested', stop: async () => undefined },
    { owner: { kind: 'session', sessionId: 's' }, pid: 30, start: { startTimeMs: 1, native: 'session' }, live: true, ownerCreatedAtMs: 1 },
    { owner: { kind: 'service', serviceId: 'plugin-server', sessionId: 's', pluginId: 'plugin' }, pid: 40, start: { startTimeMs: 1, native: 'plugin-service' }, live: true, ownerCreatedAtMs: 1, stop: async () => undefined },
  ];
  const snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }> = { status: 'ok', capturedAtMs: 100, logicalCpus: 1,
    rows: [...roots.map(root => ({ pid: root.pid, ppid: null, start: root.start, principal: { kind: 'uid' as const, value: '1' },
      name: root.owner.kind, memory: { bytes: 100, kind: 'rss' as const }, cpuTimeUs: 0 })),
    { pid: 21, ppid: 20, start: { startTimeMs: 2, native: 'worker' }, principal: { kind: 'uid', value: '1' }, name: 'worker',
      memory: { bytes: 50, kind: 'rss' }, cpuTimeUs: 0 }] };
  const ownership = await createProcessOwnershipRuntime({ listRoots: () => roots, selfPid: 30, daemonScopeKey: 'scope', platform: 'darwin' })
    .resolveSnapshot(snapshot);
  if (ownership.status !== 'ok') throw new Error('Fixture owners unavailable');
  let work: LiveWorkInventoryV1 = { coverage: 'complete', items: [
    { category: 'session', ownerRef: tracked, attribution: { kind: 'unknown' }, state: 'settled', settledAt: 1, workspacePath: '/project', workspaceId: 'workspace' },
    { category: 'service', ownerRef: 'server', attribution: { kind: 'unknown' }, state: 'active' },
  ] };
  let workReadBoundary: (() => Promise<void>) | undefined;
  const workListeners = new Set<() => void>();
  const activity = createManagedActivityInventory({ producers: [{ read: () => workReadBoundary ? workReadBoundary().then(() => work) : work,
    subscribe: listener => { workListeners.add(listener); return () => { workListeners.delete(listener); }; },
  }] });
  const inventory = await activity.read();
  const updateWork = (next: LiveWorkInventoryV1) => {
    work = next;
    for (const listener of workListeners) listener();
  };
  const normalizeServices = (establishedConnections: number | null, additional: readonly LocalServiceListenerFact[] = [],
    socketOwnerReadFailures: readonly number[] = [], listenerPid = 21) => normalizeLocalServiceScan({ machineId: 'm', now: 100, previous: null, workspaces: [], ownership: ownership.rows,
    socketOwnerReadFailures,
    listeners: [...additional, { pid: listenerPid, address: '127.0.0.1', port: 5173, protocol: 'tcp', establishedConnections }],
    processes: new Map(snapshot.rows.map(row => [row.pid, { pid: row.pid, ppid: row.ppid ?? undefined,
      processStartTimeMs: row.start.startTimeMs, censusRow: row, command: 'vite', processOwnership: 'self' as const }])) });
  const eligibility = async () => (await evaluateSessionEligibility({ tracked, inventory, draft: { status: 'absent' }, resume: {
    sessionId: 's', rawSession: { machineId: 'm', path: '/project' },
    metadata: { runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: { backendMode: 'appServer' } }, machineId: 'm', path: '/project', flavor: 'codex', codexSessionId: 'native-s' },
  } }));
  const project = { workspace: { id: 'workspace', rootPath: '/project', serverId: 'server', machineId: 'm', createdAtMs: 1 },
    cwd: '/project/nested', requester: { serverId: 'server', accountId: 'account', machineId: 'm', installationId: 'installation' } };
  const resourceTargets = [{ root: roots[1]!, project, lifecyclePurpose: 'development' as const },
    { root: roots[3]!, lifecyclePurpose: 'development' as const }];
  const deferWorkReads = (boundary: () => Promise<void>) => { workReadBoundary = boundary; };
  return { tracked, roots, ownership, inventory, activity, updateWork, deferWorkReads, project, resourceTargets, services: normalizeServices(0), normalizeServices, eligibility };
}

describe('Guard canonical owner fact projection', () => {
  it('carries only a real Session title, never a private directory or an English fallback', async () => {
    const f = await fixture();
    const metadata = f.tracked.happySessionMetadataFromLocalWebhook!;
    const read = (tracked: TrackedSession) => createReadGuardFacts({ trackedSessions: () => [tracked], readBrowsers: () => [],
      readServices: async () => f.services, readInventory: () => f.activity.read(),
      readSessionEligibility: async () => f.eligibility() })(f);
    for (const [summary, name, expected] of [
      [undefined, undefined, null],
      [{ text: '   ', updatedAt: 1 }, '  ', null],
      [{ text: '  ', updatedAt: 1 }, '  Authored name  ', 'Authored name'],
      [undefined, '3f9a0c21', '3f9a0c21'],
      [{ text: '  Build tests  ', updatedAt: 1 }, 'Authored name', 'Build tests'],
    ] as const) {
      const facts = await read({ ...f.tracked, happySessionMetadataFromLocalWebhook: {
        ...metadata, path: '/home/test/.happier/session-directories/3f9a0c21',
        sessionDirectoryV1: { v: 1, kind: 'managed' }, summary, name,
      } });
      expect(facts.targets.find(target => target.kind === 'session')?.label).toBe(expected);
    }
    const currentMetadata = applyDisplayTitleSessionMetadata(metadata, { title: 'Current state title', updatedAt: 2 });
    expect((await read({ ...f.tracked, happySessionMetadataFromLocalWebhook: currentMetadata }))
      .targets.find(target => target.kind === 'session')?.label).toBe('Current state title');
  });
  it('excludes deployment and infrastructure service purposes from development cleanup', async () => {
    const f = await fixture();
    for (const lifecyclePurpose of ['development', 'deployment', 'infrastructure'] as const) {
      const reader = createReadGuardFacts({ trackedSessions: () => [], readBrowsers: () => [],
        readServices: async () => f.services, readInventory: () => f.activity.read(),
        readServiceTargets: () => [{ ...f.resourceTargets[0]!, lifecyclePurpose }],
        readSessionEligibility: async () => f.eligibility() });
      expect((await reader(f)).targets.filter(target => target.kind === 'service'))
        .toHaveLength(lifecyclePurpose === 'development' ? 1 : 0);
    }
  });
  it('joins a promoted runner by its own birth, never the original wrapper birth', async () => {
    const f = await fixture();
    const promoted: TrackedSession = { ...f.tracked, pid: 29, processStartTimeMs: 9, sessionRunnerPid: 30,
      runnerProcessIdentity: { pid: 30, processStartTimeMs: 1, processCommandHash: 'runner' } };
    const read = (session: TrackedSession) => createReadGuardFacts({ trackedSessions: () => [session], readBrowsers: () => [],
      readServices: async () => f.services, readInventory: () => f.activity.read(), readSessionEligibility: async () => f.eligibility() })(f);
    expect((await read(promoted)).targets).toMatchObject([{ kind: 'session', root: { pid: 30 }, tracked: promoted }]);
    expect((await read({ ...promoted, runnerProcessIdentity: { ...promoted.runnerProcessIdentity!, processStartTimeMs: 2 } })).targets).toEqual([]);
  });
  it('projects only captured Project services and canonical listener generations without assigning a Session origin', async () => {
    const f = await fixture();
    const reader = createReadGuardFacts({ trackedSessions: () => [f.tracked], readBrowsers: () => [{
      root: f.roots[0]!, ownerRef: 's', idle: true, settledAt: 5, label: 'Browser',
    }], readServices: async () => f.services, readServiceTargets: () => f.resourceTargets, readInventory: () => f.activity.read(), readSessionEligibility: async () => f.eligibility() });
    const facts = await reader(f);
    expect(facts.ownership).toBe(f.ownership);
    expect(facts.inventory).toEqual(f.inventory);
    expect(facts.targets.find(target => target.kind === 'browser')?.root.stop).toBe(f.roots[0]?.stop);
    expect(facts.targets.filter(target => target.kind === 'service')).toMatchObject([{ scope: 'project', workspacePath: '/project',
      workspaceIdle: true, attribution: f.project.requester, root: { pid: 20 }, listeners: [{ establishedConnections: 0 }] }]);
    expect(facts.targets.find(target => target.kind === 'service')?.ownerRef).toBe(f.project);
    expect(facts.targets.find(target => target.kind === 'browser')?.ownerRef).toBe(f.tracked);
    expect(facts.targets.find(target => target.kind === 'session')).toMatchObject({ tracked: f.tracked,
      label: 'Build tests', eligibility: { eligible: true }, wayBack: [{ label: 'resume', actionId: 'session.open', input: { sessionId: 's', intent: 'resume' } }] });
  });

  it('reads native idle and visitors after asynchronous eligibility, and never turns stale listeners into zero', async () => {
    const f = await fixture();
    const automation = createBrowserAutomationOwnerRegistry({ now: () => 10 });
    const view = { browserSessionId: 's', viewId: 'v' };
    automation.getInputControl(view);
    let refreshedAfterEligibility = false;
    let resolveNetworkRead!: () => void;
    const networkRead = new Promise<void>(resolve => { resolveNetworkRead = resolve; });
    let services = f.services;
    const reader = createReadGuardFacts({ trackedSessions: () => [f.tracked],
      readSessionEligibility: async () => { await networkRead; refreshedAfterEligibility = true; return f.eligibility(); },
      readServices: async () => {
        expect(refreshedAfterEligibility).toBe(true);
        return services;
      },
      readServiceTargets: () => f.resourceTargets,
      readInventory: () => f.activity.read(),
      readBrowsers: () => [{ root: f.roots[0]!, ownerRef: 's', ...automation.readSessionIdle('s'), label: 'Browser' }],
    });
    const pending = reader(f);
    automation.takeOver(view);
    services = f.normalizeServices(1);
    f.updateWork({ ...f.inventory, items: f.inventory.items.map(item => item.category === 'session'
      ? { ...item, state: 'active' } : item) });
    resolveNetworkRead();
    const facts = await pending;
    expect(facts.targets.find(target => target.kind === 'browser')).toMatchObject({ idle: false });
    expect(facts.targets.find(target => target.kind === 'service')).toMatchObject({ workspaceIdle: false, listeners: [{ establishedConnections: 1 }] });
    expect(facts.inventory.items.find(item => item.category === 'session')?.state).toBe('active');
    f.updateWork(f.inventory);
    services = { ...services, entries: services.entries.map(entry => ({ ...entry, state: 'stale' as const })) };
    expect((await reader(f)).targets.find(target => target.kind === 'service')).toMatchObject({ listeners: [{ establishedConnections: null }] });
    const changed = { ...f.tracked, processStartTimeMs: 9 };
    const unproven = await createReadGuardFacts({ trackedSessions: () => [changed], readBrowsers: () => [],
      readServices: async () => f.services, readServiceTargets: () => f.resourceTargets, readInventory: () => f.activity.read(), readSessionEligibility: async () => f.eligibility() })(f);
    expect(unproven.targets.some(target => target.kind === 'session')).toBe(false);
    expect(unproven.targets.find(target => target.kind === 'service')?.ownerRef).toBe(f.project);
    services = { ...f.services, entries: f.services.entries.map(entry => ({ ...entry, provenance: {
      ...entry.provenance, process: entry.provenance?.process
        ? { ...entry.provenance.process, processStartTimeMs: 9 } : undefined,
    } })) };
    expect((await reader(f)).targets.find(target => target.kind === 'service')).toMatchObject({ listeners: [{ establishedConnections: null }] });
    const multiple = f.normalizeServices(1, [{ pid: 20, address: '127.0.0.1', port: 5180, protocol: 'tcp', establishedConnections: 0 }]);
    services = { ...multiple, entries: multiple.entries.map(entry => entry.provenance?.process?.pid === 21
      ? { ...entry, provenance: { ...entry.provenance, process: { ...entry.provenance.process, processStartTimeMs: 9 } } } : entry) };
    expect((await reader(f)).targets.find(target => target.kind === 'service')).toMatchObject({ listeners: expect.arrayContaining([
      { establishedConnections: 0 }, { establishedConnections: null },
    ]) });
    services = { ...multiple, entries: multiple.entries.map(entry => entry.provenance?.process?.pid === 21
      ? { ...entry, provenance: { ...entry.provenance, process: { ...entry.provenance.process,
        pid: 99, lineagePids: [99, 20], processStartTimeMs: 9 } } } : entry) };
    expect((await reader(f)).targets.find(target => target.kind === 'service')).toMatchObject({ listeners: expect.arrayContaining([
      { establishedConnections: 0 }, { establishedConnections: null },
    ]) });
  });

  it('reads Project workspace work from the canonical inventory, not service residency or nested command cwd', async () => {
    const f = await fixture();
    const reader = createReadGuardFacts({ trackedSessions: () => [f.tracked], readBrowsers: () => [],
      readServices: async () => f.services, readServiceTargets: () => f.resourceTargets, readInventory: () => f.activity.read(), readSessionEligibility: async () => f.eligibility() });
    const working: LiveWorkInventoryV1 = { ...f.inventory, items: f.inventory.items.map(item => item.category === 'session'
      ? { ...item, state: 'active', workspacePath: '/project/other' } : item) };
    f.updateWork(working);
    expect((await reader({ ...f, inventory: working })).targets.find(target => target.kind === 'service')).toMatchObject({ workspaceIdle: false });
    f.updateWork({ ...working, coverage: 'unknown' });
    expect((await reader({ ...f, inventory: { ...working, coverage: 'unknown' } })).targets.find(target => target.kind === 'service')).toMatchObject({ workspaceIdle: null });
    const unrelated: LiveWorkInventoryV1 = { ...working, items: working.items.map(item => item.category === 'session'
      ? { ...item, workspaceId: 'other-workspace' } : item) };
    f.updateWork(unrelated);
    expect((await reader({ ...f, inventory: unrelated })).targets.find(target => target.kind === 'service')).toMatchObject({ workspaceIdle: true });
  });

  it('observes a visitor arriving during the final canonical inventory transport', async () => {
    const f = await fixture();
    let enterTransport!: () => void;
    let finishTransport!: () => void;
    const entered = new Promise<void>(resolve => { enterTransport = resolve; });
    const networkRead = new Promise<void>(resolve => { finishTransport = resolve; });
    // The real inventory waits for primitive remote work facts; no inventory logic is mocked.
    f.deferWorkReads(() => { enterTransport(); return networkRead; });
    let visitors = 0;
    const reader = createReadGuardFacts({ trackedSessions: () => [f.tracked], readBrowsers: () => [],
      readServices: async () => f.normalizeServices(visitors), readServiceTargets: () => f.resourceTargets,
      readInventory: () => f.activity.read(), readSessionEligibility: async () => f.eligibility() });
    const pending = reader(f);
    await entered;
    visitors = 1;
    finishTransport();
    expect((await pending).targets.find(target => target.kind === 'service')).toMatchObject({ listeners: [{ establishedConnections: 1 }] });
    f.activity.dispose();
  });

  it('denies incomplete owned socket coverage but preserves unrelated foreign socket failures', async () => {
    const f = await fixture();
    let services = f.normalizeServices(0, [], [21], 20);
    const reader = createReadGuardFacts({ trackedSessions: () => [f.tracked], readBrowsers: () => [],
      readServices: async () => services, readServiceTargets: () => f.resourceTargets,
      readInventory: () => f.activity.read(), readSessionEligibility: async () => f.eligibility() });
    expect((await reader(f)).targets.find(target => target.kind === 'service')).toMatchObject({ listeners: [{ establishedConnections: null }] });
    services = f.normalizeServices(0, [], [30, 999], 20);
    expect((await reader(f)).targets.find(target => target.kind === 'service')).toMatchObject({ listeners: [{ establishedConnections: 0 }] });
    f.activity.dispose();
  });

  it('cancels a late Guard native reader without canceling presentation or scheduling its successor scan', async () => {
    const f = await fixture();
    let enterHttp!: () => void;
    let releaseHttp!: () => void;
    const httpEntered = new Promise<void>(resolve => { enterHttp = resolve; });
    const httpRead = new Promise<void>(resolve => { releaseHttp = resolve; });
    let nativeScans = 0;
    const services = createLocalServicesDaemonRuntime({ machineId: 'm', startLoop: false, inventoryEnabled: () => true,
      scan: async () => { nativeScans++; return { listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 21, establishedConnections: 0 }],
        processes: new Map(f.ownership.snapshot.rows.map(row => [row.pid, { pid: row.pid, ppid: row.ppid ?? undefined,
          censusRow: row, processStartTimeMs: row.start.startTimeMs, command: 'vite' }])), workspaces: [], diagnostics: [] }; },
      endpointEnricher: createLocalServiceEndpointEnricher({ now: () => 100, probe: async ({ scheme }) => scheme === 'http' }),
      pageTitleEnricher: createLocalPageTitleEnricher({ timeoutMs: 10_000, maxBodyBytes: 1_024, concurrency: 1,
        successTtlMs: 30_000, failureTtlMs: 5_000, fetch: async () => {
          enterHttp(); await httpRead; return new Response('<title>Project</title>', { headers: { 'content-type': 'text/html' } });
        } }),
    });
    let fullSettled = false;
    const full = services.refreshInventoryNow().then(snapshot => { fullSettled = true; return snapshot; });
    try {
      await httpEntered;
      const cancellation = new AbortController();
      let enterNative!: () => void;
      const nativeEntered = new Promise<void>(resolve => { enterNative = resolve; });
      const reader = createReadGuardFacts({ trackedSessions: () => [f.tracked], readBrowsers: () => [],
        readServices: signal => { enterNative(); return services.refreshInventoryNow({ stage: 'native', signal }); }, readServiceTargets: () => f.resourceTargets,
        readInventory: () => f.activity.read(), readSessionEligibility: async () => f.eligibility() });
      let cancellationReason: unknown;
      const pending = reader({ ...f, signal: cancellation.signal });
      void pending.catch(error => { cancellationReason = error; });
      await nativeEntered;
      const reason = new Error('Guard stopped');
      cancellation.abort(reason);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(cancellationReason).toBe(reason);
      expect(fullSettled).toBe(false);
      releaseHttp();
      expect((await full).entries[0]?.presentation?.pageTitle).toBe('Project');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(nativeScans).toBe(1);
    } finally { releaseHttp(); await full; await services.stop(); f.activity.dispose(); }
  });

  it('does not add a Browser owner absent from the supplied canonical ownership', async () => {
    const f = await fixture();
    const reader = createReadGuardFacts({ trackedSessions: () => [f.tracked], readBrowsers: () => [{
      root: f.roots[0]!, ownerRef: 's', idle: true, settledAt: 5, label: 'Browser',
    }], readServices: async () => f.services, readInventory: () => f.activity.read(), readSessionEligibility: async () => f.eligibility() });
    const facts = await reader({ ...f, ownership: { ...f.ownership,
      roots: f.ownership.roots.filter(root => root.owner.kind !== 'browser_sidecar') } });
    expect(facts.targets.some(target => target.kind === 'browser')).toBe(false);
  });
});
