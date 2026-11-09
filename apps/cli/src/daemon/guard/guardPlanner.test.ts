import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateSessionEligibility } from './sessionEligibility';
import { planGuard, planIdleSessions, projectGuardLadderV1, type GuardTarget } from './guardPlanner';
import { processRef } from '../processes/view/processRef';
import { resolveProcessOwnership } from '../processes/ownership/resolveProcessOwnership';
import type { HappierProcessRoot } from '../processes/ownership/types';
import type { ProcessCensusSnapshot } from '@/processes/census/processCensus';
import type { LiveWorkInventoryV1 } from '../lifecycle/managedActivity';
import type { TrackedSession } from '../types';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

const tracked: TrackedSession = { pid: 30, happySessionId: 's', startedBy: 'daemon' };
const serviceOwner = {};
const browserOwner = {};
const browserWayBack = [{ label: 'reopen' as const, actionId: 'browser.view.open' as const, input: { machineId: 'm' } }];
const serviceWayBack = [{ label: 'start_again' as const, actionId: 'localServices.launcher.start' as const, input: { machineId: 'm', serviceId: 'server' } }];
const inventory: LiveWorkInventoryV1 = { coverage: 'complete', items: [
  { category: 'session', ownerRef: tracked, attribution: { kind: 'unknown' }, state: 'settled', settledAt: 1 },
  { category: 'service', ownerRef: serviceOwner, attribution: { kind: 'unknown' }, state: 'settled', settledAt: 2 },
] };
const roots: HappierProcessRoot[] = [
  { owner: { kind: 'browser_sidecar' }, pid: 10, start: { startTimeMs: 1 }, live: true, ownerCreatedAtMs: 1, stop: async () => {} },
  { owner: { kind: 'service', serviceId: 'server' }, pid: 20, start: { startTimeMs: 1 }, live: true, ownerCreatedAtMs: 1, stop: async () => {} },
  { owner: { kind: 'session', sessionId: 's' }, pid: 30, start: { startTimeMs: 1 }, live: true, ownerCreatedAtMs: 1 },
];
const snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }> = { status: 'ok', capturedAtMs: 120000, logicalCpus: 1,
  rows: roots.map((root, i) => ({ pid: root.pid, ppid: null, start: root.start, principal: { kind: 'uid', value: '1' },
    name: root.owner.kind, memory: { bytes: (i + 1) * 100, kind: 'rss' }, cpuTimeUs: 0 })) };
const ownership = { status: 'ok' as const, snapshot, roots, rows: resolveProcessOwnership({ snapshot, roots,
  daemonPrincipal: { kind: 'uid', value: '1' }, platform: 'darwin' }) };
const policy = { enabled: true, actAt: 'critical' as const, sustainMs: 60000, cooldownMs: 60000,
  steps: { browsers: true, devServers: true, idleSessions: true }, pausedUntil: null };
let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
let targets: GuardTarget[];
beforeAll(async () => {
  runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
  const eligibility = await evaluateSessionEligibility({ tracked, inventory, draft: { status: 'absent' }, resume: {
    sessionId: 's', rawSession: { machineId: 'm', path: '/project' },
    metadata: { runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: { backendMode: 'appServer' } }, machineId: 'm', path: '/project', flavor: 'codex', codexSessionId: 'native-s' },
  } });
  targets = [
    { kind: 'browser', root: roots[0]!, ownerRef: browserOwner, idle: true, settledAt: 3, label: 'Browser', wayBack: browserWayBack },
    { kind: 'service', scope: 'project', workspacePath: '/project', workspaceIdle: true,
      connectionMinutes: [{ t: 60000, quiet: true, quietSince: 0 }, { t: 120000, quiet: true, quietSince: 0 }],
      root: roots[1]!, ownerRef: serviceOwner, listeners: [{ establishedConnections: 0 }], label: 'Server', wayBack: serviceWayBack },
    { kind: 'session', root: roots[2]!, tracked, eligibility, label: 'Session' },
  ];
});
afterAll(async () => { await runtime?.dispose(); });

describe('memory guard canonical ladder', () => {
  it('admits an independently proven idle Session despite unrelated unavailable machine work', () => {
    const unrelatedUnknown: LiveWorkInventoryV1 = { coverage: 'unknown', items: [...inventory.items,
      { category: 'sync', ownerRef: {}, attribution: { kind: 'unknown' }, state: 'unknown' }] };
    const session = targets[2]!;
    expect(planGuard({ policy, ownership, inventory: unrelatedUnknown, targets: [session], now: 120000 }).candidate)
      .toMatchObject({ kind: 'session', root: { pid: tracked.pid } });
    expect(planIdleSessions({ policy: { enabled: true, afterMs: 120000, warnBeforeMs: 60000 },
      ownership, inventory: unrelatedUnknown, targets: [session], now: 120000, keepRunningAnchors: new Map() }).items)
      .toHaveLength(1);
  });
  it.each(['unknown', 'active', 'missing'] as const)('rechecks the same Session latest %s work after an earlier eligible read', state => {
    const changed: LiveWorkInventoryV1 = { coverage: state === 'unknown' ? 'unknown' : 'complete',
      items: inventory.items.flatMap(item => item.ownerRef !== tracked ? [item]
        : state === 'missing' ? [] : [{ ...item, state }]) };
    expect(planGuard({ policy, ownership, inventory: changed, targets: [targets[2]!], now: 120000 }).candidate).toBeUndefined();
    expect(planIdleSessions({ policy: { enabled: true, afterMs: 120000, warnBeforeMs: 60000 }, ownership,
      inventory: changed, targets: [targets[2]!], now: 120000, keepRunningAnchors: new Map() }).items).toHaveLength(0);
  });
  it('uses a newer settled interval observed after draft and resume eligibility', () => {
    const changed = { ...inventory, items: inventory.items.map(item => item.ownerRef === tracked ? { ...item, settledAt: 50 } : item) };
    expect(planGuard({ policy, ownership, inventory: changed, targets: [targets[2]!], now: 120000 }).candidate?.settledAt).toBe(50);
    expect(planIdleSessions({ policy: { enabled: true, afterMs: 120000, warnBeforeMs: 60000 }, ownership,
      inventory: changed, targets: [targets[2]!], now: 120000, keepRunningAnchors: new Map() }).items[0])
      .toMatchObject({ anchor: 50, stopAt: 120050, candidate: { settledAt: 50 } });
  });
  it('names every ladder row by the census process identity, the same ref the Processes census and stop Actions use', () => {
    const ladder = projectGuardLadderV1(planGuard({ policy, ownership, inventory, targets, now: 120000 }).ladder);
    const rows = [...ladder.steps.flatMap(step => step.candidates), ...ladder.excluded];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const root = roots.find(candidate => row.ref === processRef(candidate.pid, candidate.start))!;
      expect(root).toBeDefined();
      expect(row.ref).toBe(row.processRef);
      expect(row.processRef).toBe(processRef(root.pid, root.start));
    }
  });
  it('uses rung order before size and the identical planner for preview and execution', () => {
    const plan = planGuard({ policy, ownership, inventory, targets, now: 120000 });
    expect(plan.candidate).toMatchObject({ kind: 'browser', footprintBytes: 100, root: { pid: 10 } });
    expect(plan.ladder.steps.map(step => step.freesAboutBytes)).toEqual([100, 200, 300]);
    expect(planGuard({ policy: { ...policy, steps: { ...policy.steps, browsers: false } }, ownership, inventory, targets, now: 120000 }).candidate)
      .toMatchObject({ kind: 'service', footprintBytes: 200 });
  });
  it('keeps unknown connections, live owner work, draft truth, and a changed native identity out of execution', async () => {
    const kept: GuardTarget[] = [
      { ...targets[0]!, root: { ...roots[0]!, start: { startTimeMs: 9 } } },
      { ...targets[1]!, kind: 'service', root: roots[1]!, ownerRef: serviceOwner, listeners: [{ establishedConnections: null }], label: 'Server' },
      { ...targets[2]!, kind: 'session', root: roots[2]!, tracked, label: 'Session', eligibility: (await evaluateSessionEligibility({ tracked,
        inventory, draft: { status: 'present', updatedAt: 1 }, resume: { sessionId: 's', rawSession: { machineId: 'm', path: '/project' },
          metadata: { runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: { backendMode: 'appServer' } }, machineId: 'm', path: '/project', flavor: 'codex', codexSessionId: 'native-s' } } })) },
    ];
    const plan = planGuard({ policy, ownership, inventory, targets: kept, now: 120000 });
    expect(plan.candidate).toBeUndefined();
    expect(plan.ladder.excluded.map(item => item.reason)).toEqual(['identity_changed', 'connections_unknown', 'unsent_draft']);
    expect(planGuard({ policy, ownership, inventory,
      targets: [{ ...targets[1]!, kind: 'service', scope: 'project', root: roots[1]!, ownerRef: serviceOwner,
        listeners: [{ establishedConnections: 0 }], label: 'Server', workspaceIdle: false }], now: 120000 }).ladder.excluded[0]?.reason).toBe('working');
    expect(planGuard({ policy, ownership, inventory, targets: [{ ...targets[1]!, kind: 'service', root: roots[1]!,
      ownerRef: serviceOwner, label: 'Server', wayBack: serviceWayBack, listeners: [{ establishedConnections: 1 }] }], now: 120000 })
      .ladder.excluded[0]?.reason).toBe('visitors');
  });
  it('uses largest measured footprint first and the older owner idle anchor for equal sizes', () => {
    const root = { ...roots[0]!, pid: 11 };
    const nextSnapshot = { ...snapshot, rows: [...snapshot.rows, { ...snapshot.rows[0]!, pid: 11 }] };
    const nextRoots = [...roots, root];
    const nextOwnership = { ...ownership, snapshot: nextSnapshot, roots: nextRoots, rows: resolveProcessOwnership({
      snapshot: nextSnapshot, roots: nextRoots, daemonPrincipal: { kind: 'uid', value: '1' }, platform: 'darwin' }) };
    expect(planGuard({ policy, ownership: nextOwnership, inventory, targets: [...targets,
      { kind: 'browser', root, ownerRef: {}, idle: true, settledAt: 1, label: 'Older browser', wayBack: browserWayBack }], now: 120000 }).candidate?.root.pid).toBe(11);
    const largerSnapshot = { ...nextSnapshot, rows: [...nextSnapshot.rows,
      { ...snapshot.rows[0]!, pid: 12, ppid: 11, memory: { bytes: 50, kind: 'rss' as const } }] };
    const largerOwnership = { ...nextOwnership, snapshot: largerSnapshot, rows: resolveProcessOwnership({ snapshot: largerSnapshot,
      roots: nextRoots, daemonPrincipal: { kind: 'uid', value: '1' }, platform: 'darwin' }) };
    const largerPlan = planGuard({ policy, ownership: largerOwnership, inventory, targets: [...targets,
      { kind: 'browser', root, ownerRef: {}, idle: true, settledAt: 5, label: 'Larger browser', wayBack: browserWayBack }], now: 120000 });
    expect(largerPlan.candidate).toMatchObject({ root: { pid: 11 }, footprintBytes: 150 });
    expect(largerPlan.ladder.steps[0]?.freesAboutBytes).toBe(250);
  });
  it('never promotes a plain terminal, foreign process, unknown native fact, or waiting Session into a stop target', async () => {
    const terminalRoot = { ...roots[0]!, owner: { kind: 'terminal' as const, terminalId: 't' } };
    const terminalOwnership = { ...ownership, roots: [terminalRoot], rows: resolveProcessOwnership({ snapshot, roots: [terminalRoot],
      daemonPrincipal: { kind: 'uid', value: '1' }, platform: 'darwin' }) };
    const target = targets[0]!;
    expect(planGuard({ policy, ownership: terminalOwnership, inventory, targets: [{ ...target, root: terminalRoot }], now: 120000 })
      .ladder.excluded[0]?.reason).toBe('unsupported_target');
    for (const principal of [{ kind: 'uid' as const, value: '2' }, null]) {
      const native = { ...snapshot, rows: snapshot.rows.map(row => ({ ...row, principal })) };
      const resolved = { ...ownership, snapshot: native, rows: resolveProcessOwnership({ snapshot: native, roots,
        daemonPrincipal: { kind: 'uid', value: '1' }, platform: 'darwin' }) };
      const plan = planGuard({ policy, ownership: resolved, inventory, targets, now: 120000 });
      expect(plan.candidate).toBeUndefined();
      expect(plan.ladder.excluded.every(item => item.reason === (principal ? 'not_happier' : 'ownership_unknown'))).toBe(true);
    }
    const waiting = { ...inventory, items: [...inventory.items, { category: 'attention' as const,
      ownerRef: tracked, attribution: { kind: 'unknown' as const }, state: 'active' as const }] };
    const session = { ...targets[2]!, kind: 'session' as const, root: roots[2]!, tracked, label: 'Session', eligibility:
      (await evaluateSessionEligibility({ tracked, inventory: waiting, draft: { status: 'absent' }, resume: { sessionId: 's',
        rawSession: { machineId: 'm', path: '/project' }, metadata: { runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: { backendMode: 'appServer' } }, machineId: 'm', path: '/project', flavor: 'codex', codexSessionId: 'native-s' } } })) };
    expect(planGuard({ policy, ownership, inventory: waiting, targets: [session], now: 120000 }).ladder.excluded[0]?.reason).toBe('waiting_for_you');
  });
  it('requires a captured native stop owner and restoration reference before admitting browsers or services', () => {
    const nativeStop = async () => {};
    const restoration = browserWayBack;
    const serviceRestoration = serviceWayBack;
    const missing: GuardTarget[] = [
      { ...targets[0]!, root: { ...roots[0]!, stop: nativeStop }, wayBack: undefined },
      { ...targets[0]!, root: { ...roots[0]!, stop: undefined }, wayBack: restoration },
      { ...targets[1]!, root: { ...roots[1]!, stop: nativeStop }, wayBack: undefined },
      { ...targets[1]!, root: { ...roots[1]!, stop: undefined }, wayBack: serviceRestoration },
    ];
    const plan = planGuard({ policy, ownership, inventory, targets: missing, now: 120000 });
    expect(plan.candidate).toBeUndefined();
    expect(plan.ladder.excluded.map(item => item.reason)).toEqual(Array(4).fill('unsupported_target'));
  });
  it('admits only quiet Project services after the full connection window, independently of running service residency', () => {
    const project = { ...targets[1]!, kind: 'service' as const, scope: 'project' as const, workspaceIdle: true,
      root: roots[1]!, ownerRef: serviceOwner, listeners: [{ establishedConnections: 0 }], label: 'Server' };
    const resident = { ...inventory, items: inventory.items.map(item => item.ownerRef === serviceOwner
      ? { ...item, state: 'active' as const } : item) };
    const decide = (target: GuardTarget) => planGuard({ policy: { ...policy, sustainMs: 120000 }, ownership,
      inventory: resident, targets: [target], now: 120000 });
    expect(decide(project).candidate).toMatchObject({ kind: 'service', settledAt: 0 });
    expect(decide({ ...project, connectionMinutes: [{ t: 60000, quiet: true, quietSince: 59000 },
      { t: 120000, quiet: true, quietSince: 59000 }] }).candidate).toBeUndefined();
    expect(decide({ ...project, workspaceIdle: false }).ladder.excluded[0]?.reason).toBe('working');
    expect(decide({ ...project, workspaceIdle: null }).ladder.excluded[0]?.reason).toBe('activity_unknown');
    expect(decide({ ...project, scope: 'session' }).ladder.excluded[0]?.reason).toBe('unsupported_target');
    for (const connectionMinutes of [[{ t: 120000, quiet: true }],
      [{ t: 0, quiet: true }, { t: 120000, quiet: true }],
      [{ t: 60000, quiet: null }, { t: 120000, quiet: true }]]) {
      expect(decide({ ...project, connectionMinutes }).candidate).toBeUndefined();
    }
    expect(decide({ ...project, listeners: [{ establishedConnections: 0 }, { establishedConnections: 1 }] }).ladder.excluded[0]?.reason).toBe('visitors');
  });
});
