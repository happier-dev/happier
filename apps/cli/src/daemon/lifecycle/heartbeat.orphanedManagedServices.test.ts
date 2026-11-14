import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { reloadConfiguration } from '@/configuration';
import { createManagedServiceDurabilityOwner } from '@/plugins/runtime/invocation/services/managedServiceDurability';
import { readManagedServiceEndpointProjectionCandidates } from '@/plugins/runtime/invocation/services/managedServiceEndpointProjection';
import { createProcessOwnershipRuntime } from '../processes/ownership/processOwnershipRuntime';

import type { ProcessCensusDependencies } from '@/processes/census/processCensus';
import type { HappierProcessRoot } from '../processes/ownership/types';
import type { ManagedServiceEndpointProjectionInputV1 } from '@/plugins/runtime/invocation/services/managedServiceEndpointProjection';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  reloadConfiguration();
});

it.each(['identity unavailable', 'termination failed', 'replacement during retry', 'root exited with owned group survivor',
  'root exited with other owner in group', 'root exited with reowned group member', 'root exited with unknown group member', 'all owners live or unknown'] as const)(
  'retries retained managed custody on a later retirement pass after %s while protecting live and unknown owners', async (failure) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-heartbeat-managed-retry-'));
    vi.stubEnv('HAPPIER_HOME_DIR', home);
    reloadConfiguration();
    const rows = new Map<number, { parent: number; ticks: number; group?: number }>([
      [process.pid, { parent: 1, ticks: 10 }],
      [5001, { parent: 1, ticks: 90 }],
      [5100, { parent: 1, ticks: 110 }],
      [5101, { parent: 1, ticks: 120 }],
      [5102, { parent: 1, ticks: 130 }],
      [5103, { parent: 1, ticks: 140 }],
    ]);
    let censusReads = 0;
    const censusDependencies: ProcessCensusDependencies = {
      platform: 'linux', selfPid: process.pid,
      linuxBoundary: {
        async readdir() { censusReads++; return [...rows.keys()].map(String); },
        async readlink() { return '/fixture'; },
        async readFile(path) {
          const pid = Number(path.split('/')[2]);
          const row = rows.get(pid);
          if (!row) throw Object.assign(new Error('process gone'), { code: 'ENOENT' });
          if (path.endsWith('/status')) return 'Uid:\t1000\n';
          if (path.endsWith('/stat')) return `${pid} (fixture) ${['S', String(row.parent), String(row.group ?? 5000), '1', '0', '0',
            ...Array(13).fill('0'), String(row.ticks), '0', '0'].join(' ')}`;
          return '';
        },
      },
    };
    const roots: HappierProcessRoot[] = [
      { owner: { kind: 'session', sessionId: 'ended-session' }, pid: 5100, start: { startTimeMs: 1100 }, live: false, ownerCreatedAtMs: 0 },
      { owner: { kind: 'session', sessionId: 'live-idle-session' }, pid: 5101, start: { startTimeMs: 1200 }, live: true, ownerCreatedAtMs: 0 },
      { owner: { kind: 'session', sessionId: 'replaced-session' }, pid: 5103, start: { startTimeMs: 1400 }, live: false, ownerCreatedAtMs: 0 },
      { owner: { kind: 'session', sessionId: 'replaced-session' }, pid: 5001, start: { startTimeMs: 900 }, live: true, ownerCreatedAtMs: 0 },
    ];
    const processOwnership = createProcessOwnershipRuntime({
      platform: 'linux', daemonScopeKey: '123456789abc', censusDependencies, listRoots: () => roots,
    });
    let recovering = false;
    const terminated: number[] = [];
    const owner = createManagedServiceDurabilityOwner({
      rootDir: join(home, 'managed-services'), platform: 'linux',
      observeProcessStartIdentity: async pid => {
        if (pid === 5100 && !recovering && failure !== 'termination failed') throw new Error('identity unavailable');
        if (pid === 5100 && recovering && failure === 'root exited with reowned group member') {
          rows.set(5201, { parent: 1, ticks: 155, group: 6000 });
          const index = roots.findIndex(root => root.pid === 5201);
          roots[index] = { owner: { kind: 'session', sessionId: 'new-live-owner' }, pid: 5201,
            start: { startTimeMs: 1550 }, live: true, ownerCreatedAtMs: 0 };
        }
        if (pid === 5100 && recovering && failure === 'replacement during retry'
          && !roots.some(root => root.live && root.owner.kind === 'session' && root.owner.sessionId === 'ended-session')) {
          roots.push({ owner: { kind: 'session', sessionId: 'ended-session' }, pid: 5001,
            start: { startTimeMs: 900 }, live: true, ownerCreatedAtMs: 0 });
        }
        const row = rows.get(pid);
        return row ? `${pid}:${row.ticks * 10}` : null;
      },
      observeProcessGroupPresence: async pid => rows.has(pid) || [...rows.values()].some(row => row.group === pid) ? 'alive' : 'absent',
      processTreeSystemBoundary: { platform: 'linux', censusDependencies,
        kill(pid) { terminated.push(pid); rows.delete(pid); return true; }, wait: async () => {} },
      // The OS termination boundary changes the same native fixture read by the real ownership producer.
      terminateProcessTree: async ({ pid }) => {
        if (!recovering && failure === 'termination failed') throw new Error('termination unavailable');
        terminated.push(pid);
        rows.delete(pid);
      },
    });
    const projection = (pid: number, sessionId: string): ManagedServiceEndpointProjectionInputV1 => ({
      sessionId, pluginId: 'opencode', contributionId: 'opencode/agent', serverId: 'opencode-server',
      instanceId: `instance-${pid}`, sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-a', installSource: 'npm' },
      custodyOwner: 'sessionRunner', mode: 'managedSpawn',
      endpoint: { baseUrl: `http://127.0.0.1:${pid}`, host: '127.0.0.1', port: pid },
      process: { pid, startIdentity: `${pid}:${rows.get(pid)!.ticks * 10}` }, createdAtMs: 1,
    });
    try {
      for (const [pid, sessionId] of [[5100, 'ended-session'], [5101, 'live-idle-session'],
        [5102, 'unknown-session'], [5103, 'replaced-session']] as const) {
        await owner.publishEndpointProjection(projection(pid, sessionId));
      }
      await expect(owner.retireSessionRunnerOwnedProjections({ sessionId: 'ended-session' })).resolves.toEqual([]);
      expect(await readdir(join(home, 'managed-services', 'endpoint-projections'))).toHaveLength(4);
      recovering = true;
      if (failure.startsWith('root exited')) {
        rows.delete(5100);
        rows.set(5200, { parent: 1, ticks: 150, group: 5100 });
        roots.push({ owner: { kind: 'session', sessionId: 'ended-session' }, pid: 5200,
          start: { startTimeMs: 1500 }, live: false, ownerCreatedAtMs: 0 });
        if (failure === 'root exited with reowned group member') {
          rows.set(5201, { parent: 1, ticks: 155, group: 5100 });
          roots.push({ owner: { kind: 'session', sessionId: 'ended-session' }, pid: 5201,
            start: { startTimeMs: 1550 }, live: false, ownerCreatedAtMs: 0 });
        } else if (failure !== 'root exited with owned group survivor') {
          rows.set(5300, { parent: 1, ticks: 160, group: 5100 });
          if (failure === 'root exited with other owner in group') roots.push({
            owner: { kind: 'session', sessionId: 'another-ended-session' }, pid: 5300,
            start: { startTimeMs: 1600 }, live: false, ownerCreatedAtMs: 0,
          });
        }
      }
      if (failure === 'all owners live or unknown') {
        const index = roots.findIndex(root => root.pid === 5100);
        roots[index] = { ...roots[index]!, live: true };
      }
      const ownership = await processOwnership.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
      expect(ownership.status).toBe('ok');
      if (ownership.status !== 'ok') throw new Error('fixture census unavailable');
      expect(ownership.rows.find(row => row.pid === (failure.startsWith('root exited') ? 5200 : 5100)))
        .toMatchObject(failure === 'all owners live or unknown' ? { ownerEnded: false, level: 'proven' }
          : { ownerEnded: true, level: 'left_behind' });
      // The daemon runs this retirement at startup and at every runner exit edge (I5); each call is one pass.
      const tick = async () => { await owner.retireEndedSessionRunnerOwnedProjections({ processOwnership }); };
      const readsBeforeTick = censusReads;
      await tick();
      if (failure === 'all owners live or unknown') expect(censusReads - readsBeforeTick).toBe(1);
      const expectedTerminated = ['root exited with owned group survivor', 'root exited with reowned group member'].includes(failure) ? [5200]
        : ['replacement during retry', 'root exited with other owner in group',
          'root exited with unknown group member', 'all owners live or unknown'].includes(failure) ? [] : [5100];
      expect(terminated).toEqual(expectedTerminated);
      if (failure === 'root exited with reowned group member') expect(rows.has(5201)).toBe(true);
      expect(readManagedServiceEndpointProjectionCandidates(join(home, 'managed-services')).map(item => item.instanceId).sort()).toEqual([
        ...(expectedTerminated.length === 0 || failure === 'root exited with reowned group member' ? ['instance-5100'] : []),
        'instance-5101', 'instance-5102', 'instance-5103',
      ]);
      await tick();
      expect(terminated).toEqual(expectedTerminated);
      if (failure === 'all owners live or unknown') {
        for (const current of readManagedServiceEndpointProjectionCandidates(join(home, 'managed-services'))) {
          await owner.releaseEndpointProjection(current);
        }
        const readsBeforeEmptyTick = censusReads;
        await tick();
        // MANAGED-SCOPE-LEAK-1112: Linux recovery must inventory native scopes even without projections.
        expect(censusReads - readsBeforeEmptyTick).toBe(1);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it('retires Darwin descendants before their parents while fresh ownership still proves their ancestry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-managed-darwin-retry-'));
  const rows = new Map([[process.pid, { parent: 1, group: process.pid }],
    [6100, { parent: 1, group: 6100 }], [6101, { parent: 6100, group: 6100 }],
    [6102, { parent: 6101, group: 6100 }]]);
  const identity = (pid: number) => `darwin-proc:${pid}:1:0`;
  const censusDependencies: ProcessCensusDependencies = {
    platform: 'darwin', selfPid: process.pid, helperExecutablePath: '/native-helper',
    execFile: async () => ({ stdout: JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 1,
      rows: [...rows].map(([pid, row]) => ({ pid, ppid: row.parent, pgid: row.group, name: 'fixture',
        start: { startTimeMs: 1000, native: identity(pid) }, principal: { kind: 'uid', value: '1000' },
        memory: null, cpuTimeUs: null })), partial: [],
    }), stderr: '' }),
  };
  const processOwnership = createProcessOwnershipRuntime({ platform: 'darwin', daemonScopeKey: '123456789abc',
    censusDependencies, listRoots: () => [6100, 6101, 6102].map(pid => ({
      owner: { kind: 'session', sessionId: 'ended-session' },
      pid, start: { startTimeMs: 1000, native: identity(pid) }, live: false, ownerCreatedAtMs: 0 })),
  });
  const terminated: number[] = [];
  const owner = createManagedServiceDurabilityOwner({ rootDir: home, platform: 'darwin',
    observeProcessStartIdentity: async pid => rows.has(pid) ? identity(pid) : null,
    observeProcessGroupPresence: async pid => [...rows.values()].some(row => row.group === pid) ? 'alive' : 'absent',
    processTreeSystemBoundary: { platform: 'darwin', censusDependencies, wait: async () => {},
      kill(pid) {
        terminated.push(pid);
        rows.delete(pid);
        for (const row of rows.values()) if (row.parent === pid) row.parent = 1;
        return true;
      },
    },
  });
  try {
    await owner.publishEndpointProjection({ sessionId: 'ended-session', pluginId: 'opencode',
      contributionId: 'opencode/agent', serverId: 'opencode-server', instanceId: 'darwin-instance',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-a', installSource: 'npm' },
      custodyOwner: 'sessionRunner', mode: 'managedSpawn',
      endpoint: { baseUrl: 'http://127.0.0.1:6100', host: '127.0.0.1', port: 6100 },
      process: { pid: 6100, startIdentity: identity(6100) }, createdAtMs: 1,
    });
    const retired = await owner.retireEndedSessionRunnerOwnedProjections({ processOwnership });
    expect(terminated).toEqual([6102, 6101, 6100]);
    expect(retired).toEqual([]);
    expect(readManagedServiceEndpointProjectionCandidates(home)).toHaveLength(1);
  } finally { await rm(home, { recursive: true, force: true }); }
});
