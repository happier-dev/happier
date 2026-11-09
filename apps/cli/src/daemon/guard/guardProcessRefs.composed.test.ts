import { describe, expect, it } from 'vitest';
import type { ProcessCensusDependencies } from '@/processes/census/processCensus';
import { localServiceProcfsFixture } from '../local/services/inventory/platform/censusFixture.testkit';
import { createProcessOwnershipRuntime } from '../processes/ownership/processOwnershipRuntime';
import { resolveProcessOwnerRequester } from '../processes/ownership/resolveProcessOwnerRequester';
import type { HappierProcessRoot, ProcessOwnerRef } from '../processes/ownership/types';
import { listHappierProcessRoots } from '../processes/roots/listHappierProcessRoots';
import { createProcessActionExecutor } from '../processes/actions/processActionExecutor';
import { processRef } from '../processes/view/processRef';
import { MachineGuardPolicyV1Schema } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import type { TrackedSession } from '../types';
import { createReadGuardFacts } from './readGuardFacts';
import { evaluateSessionEligibility } from './sessionEligibility';
import { planGuard, projectGuardLadderV1 } from './guardPlanner';
import { MachineGuardLadderV1Schema } from '@happier-dev/protocol/machines/guard/guardViewV1';
import { normalizeLocalServiceScan } from '../local/services/inventory/scanner';
import { createMachineProcessesView } from '../processes/view/createMachineProcessesView';
import { createLeftBehindPass } from '../processes/leftBehind/leftBehindPass';
import { createMachineVitalsSampler } from '../vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '../vitals/history/minuteHistoryStore';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('Guard process refs consumed by Processes', () => {
  it('projects the admitted native birth and stops that birth while refusing a reused PID', async () => withTempDir('guard-process-refs-', async directory => {
    const scope = '123456789abc';
    const target = { serverId: 'home', machineId: 'machine', installationId: 'installation' };
    const requesterForOwner = (owner: ProcessOwnerRef, roots: readonly HappierProcessRoot[]) =>
      resolveProcessOwnerRequester(owner, roots, { target, custodianAccountId: 'owner' });
    const absent = new Set<number>();
    let birth = 12345;
    let stops = 0;
    // The process table and termination are OS boundaries; both projections and admission stay real.
    const procfs = () => localServiceProcfsFixture([{ pid: 30 }].filter(row => !absent.has(row.pid)));
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', linuxBoundary: {
      readdir: path => procfs().readdir(path), readlink: path => procfs().readlink(path),
      readFile: async path => {
        const value = await procfs().readFile(path);
        return path === '/proc/30/stat' ? String(value).replace('12345 4096', `${birth} 4096`) : value;
      },
    } };
    const initialCensus = await (await import('@/processes/census/processCensus')).createProcessCensusReader(censusDependencies)({ freshness: 'fresh', scope: 'all' });
    if (initialCensus.status !== 'ok') throw new Error('Expected readable process table');
    const native = initialCensus.rows.find(row => row.pid === 30)!;
    const tracked: TrackedSession = { pid: 30, happySessionId: 'session', startedBy: 'daemon', processStartTimeMs: native.start.startTimeMs,
      requesterWorkAttributionV1: { ...target, accountId: 'owner' } };
    const inventory = { coverage: 'complete' as const, items: [] };
    const ownership = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: scope, censusDependencies,
      listRoots: snapshot => listHappierProcessRoots({ snapshot, platform: 'linux', daemonScopeKey: scope, trackedSessions: [tracked] }) });
    const admitted = await ownership.readOwners({ freshness: 'fresh' });
    const readFacts = createReadGuardFacts({ trackedSessions: () => [tracked], readBrowsers: () => [],
      readInventory: async () => inventory,
      readServices: async () => normalizeLocalServiceScan({ machineId: 'machine', now: 0, previous: null,
        workspaces: [], ownership: [], listeners: [], processes: new Map() }),
      readSessionEligibility: session => evaluateSessionEligibility({ tracked: session, inventory,
        draft: { status: 'present', updatedAt: 1 }, resume: {
          sessionId: 'session', rawSession: { machineId: 'machine', path: '/project' },
          metadata: { machineId: 'machine', path: '/project' },
        } }),
    });
    const facts = await readFacts({ ownership: admitted, inventory });
    const ladder = projectGuardLadderV1(planGuard({ ...facts, policy: MachineGuardPolicyV1Schema.parse({}).memoryGuard, now: Date.now() }).ladder);
    expect(MachineGuardLadderV1Schema.parse(ladder).excluded.find(row => row.kind === 'session')?.label).toBeNull();
    const projected = ladder.excluded.find(row => row.kind === 'session')!;
    const ref = projected.ref;
    if (!ref) throw new Error('Expected Guard to project its Session process ref');
    expect(ref).toBe(projected.processRef);
    expect(ref).toBe(processRef(native.pid, native.start));
    const sampler = createMachineVitalsSampler({ historyStore: await createMinuteHistoryStore({ directory }),
      readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) } });
    const leftBehind = createLeftBehindPass({ processOwnershipRuntime: ownership });
    const processes = createMachineProcessesView({ processOwnershipRuntime: ownership, leftBehind, machineVitals: sampler,
      platform: 'linux', bootTimeMs: 0, allProcessesVisible: () => false, requesterForOwner });
    try {
      expect(await processes.check({ machineId: 'machine', refs: [ref] }, { accountId: 'owner', custodianAccountId: 'owner' }))
        .toMatchObject({ checks: [{ ref, present: true, identityEqual: true, level: 'proven', owner: { kind: 'session', sessionId: 'session' } }] });
      const executor = createProcessActionExecutor({ ownership, platform: 'linux', leftBehind,
        allProcessesVisible: () => false, requesterForOwner,
        stopOwner: async () => { stops++; absent.add(30); return true; } });
      const request = { machineId: 'machine', targets: [{ ref,
        expect: { level: 'proven' as const, owner: { kind: 'session' as const, sessionId: 'session' } } }] };
      birth++;
      expect(await processes.check({ machineId: 'machine', refs: [ref] }, { accountId: 'owner', custodianAccountId: 'owner' }))
        .toMatchObject({ checks: [{ ref, identityEqual: false }] });
      expect(await executor.executeStop(request, { accountId: 'owner', isCustodian: true }))
        .toMatchObject({ status: 'refused', outcomes: [{ reasonCode: 'identity_changed' }] });
      expect(stops).toBe(0);
      birth--;
      expect(await executor.executeStop(request, { accountId: 'owner', isCustodian: true }))
        .toMatchObject({ status: 'ended', outcomes: [{ outcome: 'ended' }] });
      expect(stops).toBe(1);
    } finally { processes.dispose(); leftBehind.dispose(); await sampler.stop(); }
  }));
});
