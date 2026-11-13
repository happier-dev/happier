import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { configuration } from '@/configuration';
import { createHappierLinuxScopeName } from '@/daemon/platform/linux/systemdUserResourceGovernor';
import { createProcessOwnershipRuntime } from '@/daemon/processes/ownership/processOwnershipRuntime';
import { listHappierProcessRoots } from '@/daemon/processes/roots/listHappierProcessRoots';
import { formatProcessOwnerTag, resolveProcessOwnerScopeKey } from '@/processes/ownerTag';
import type { ProcessCensusDependencies } from '@/processes/census/processCensus';
import { createManagedServiceDurabilityOwner } from './managedServiceDurability';

it.each(['linux', 'darwin', 'win32'] as const)('recovers projection-free service scopes only with this home’s ended-owner proof on %s', async platform => {
    const rootDir = await mkdtemp(join(tmpdir(), 'managed-scope-recovery-'));
    const home = configuration.happyHomeDir;
    const scope = resolveProcessOwnerScopeKey(home, 'linux');
    const unit = (serviceId: string, happierHomeDir = home) => createHappierLinuxScopeName(formatProcessOwnerTag({
        happierHomeDir, platform: 'linux', owner: { kind: 'service', serviceId },
    }))!;
    const endedUnit = unit('ended');
    const rows = new Map([
        [process.pid, { parent: 1, unit: '' }],
        [5100, { parent: 1, unit: endedUnit }],
        [5101, { parent: 5100, unit: endedUnit }],
        [5200, { parent: 1, unit: unit('live') }],
        [5300, { parent: 1, unit: unit('unknown') }],
        [5400, { parent: 1, unit: unit('ended', `${home}-foreign`) }],
    ]);
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', selfPid: process.pid,
        linuxBoundary: {
            async readdir() { return [...rows.keys()].map(String); },
            async readlink() { return '/fixture'; },
            async readFile(path) {
                const pid = Number(path.split('/')[2]);
                const row = rows.get(pid);
                if (!row) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
                if (path.endsWith('/status')) return 'Uid:\t1000\n';
                if (path.endsWith('/cgroup')) return `0::/user.slice/${row.unit}\n`;
                if (path.endsWith('/stat')) return `${pid} (fixture) ${['S', String(row.parent), String(pid), '1', '0', '0',
                    ...Array(13).fill('0'), String(pid), '0', '0'].join(' ')}`;
                return '';
            },
        } };
    const ownership = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: scope, censusDependencies,
        listRoots: snapshot => listHappierProcessRoots({ snapshot, platform: 'linux', daemonScopeKey: scope,
            managedServices: [{ owner: { kind: 'service', serviceId: 'live' }, pid: 5200, start: { startTimeMs: 52000 } }],
            endedRoots: [{ owner: { kind: 'service', serviceId: 'ended' }, pid: 5000,
                start: { startTimeMs: 50000 }, live: false }] }),
    });
    const kill = vi.fn((pid: number) => { rows.delete(pid); return true; });
    const owner = createManagedServiceDurabilityOwner({ rootDir, platform,
        processTreeSystemBoundary: { platform: 'linux', censusDependencies, kill, wait: async () => {} },
    });
    try {
        const view = await ownership.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
        expect(view.status === 'ok' && view.rows.find(row => row.pid === 5100)?.level).toBe('left_behind');
        const retired = await owner.retireEndedSessionRunnerOwnedProjections({ processOwnership: ownership });
        expect([...retired].sort()).toEqual(platform === 'linux' ? [5100, 5101] : []);
        expect([...rows.keys()].sort()).toEqual((platform === 'linux'
            ? [process.pid, 5200, 5300, 5400] : [process.pid, 5100, 5101, 5200, 5300, 5400]).sort());
        await expect(owner.retireEndedSessionRunnerOwnedProjections({ processOwnership: ownership })).resolves.toEqual([]);
    } finally { await rm(rootDir, { recursive: true, force: true }); }
});

it('reads the native census only when an owner ends, a projection retires or an authorized scope is still standing', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'managed-scope-recovery-demand-'));
    const home = configuration.happyHomeDir;
    const scope = resolveProcessOwnerScopeKey(home, 'linux');
    const unit = (serviceId: string) => createHappierLinuxScopeName(formatProcessOwnerTag({
        happierHomeDir: home, platform: 'linux', owner: { kind: 'service', serviceId },
    }))!;
    const rows = new Map([[process.pid, { parent: 1, unit: '' }], [5200, { parent: 1, unit: unit('live') }]]);
    let censuses = 0;
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', selfPid: process.pid,
        linuxBoundary: {
            async readdir() { censuses++; return [...rows.keys()].map(String); },
            async readlink() { return '/fixture'; },
            async readFile(path) {
                const pid = Number(path.split('/')[2]);
                const row = rows.get(pid);
                if (!row) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
                if (path.endsWith('/status')) return 'Uid:\t1000\n';
                if (path.endsWith('/cgroup')) return `0::/user.slice/${row.unit}\n`;
                if (path.endsWith('/stat')) return `${pid} (fixture) ${['S', String(row.parent), String(pid), '1', '0', '0',
                    ...Array(13).fill('0'), String(pid), '0', '0'].join(' ')}`;
                return '';
            },
        } };
    const endedRoots: { owner: { kind: 'service'; serviceId: string }; pid: number; start: { startTimeMs: number }; live: false }[] = [];
    const ownership = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: scope, censusDependencies,
        listRoots: snapshot => listHappierProcessRoots({ snapshot, platform: 'linux', daemonScopeKey: scope,
            managedServices: [{ owner: { kind: 'service', serviceId: 'live' }, pid: 5200, start: { startTimeMs: 52000 } }],
            endedRoots }),
    });
    let killWorks = false;
    const owner = createManagedServiceDurabilityOwner({ rootDir, platform: 'linux',
        processTreeSystemBoundary: { platform: 'linux', censusDependencies, wait: async () => {},
            kill: (pid: number) => { if (killWorks) rows.delete(pid); return true; } },
    });
    const pass = async () => {
        const before = censuses;
        const retired = await owner.retireEndedSessionRunnerOwnedProjections({ processOwnership: ownership });
        return { censuses: censuses - before, retired: [...retired].sort() };
    };
    try {
        // Startup inherits whatever the previous daemon lifetime left behind.
        expect((await pass()).censuses).toBe(1);
        // Nothing ended since: an idle heartbeat reads nothing.
        expect(await pass()).toEqual({ censuses: 0, retired: [] });
        expect(await pass()).toEqual({ censuses: 0, retired: [] });
        // A service owner ends and leaves its scope behind.
        rows.set(5100, { parent: 1, unit: unit('ended') });
        endedRoots.push({ owner: { kind: 'service', serviceId: 'ended' }, pid: 5000, start: { startTimeMs: 50000 }, live: false });
        owner.requestRecovery();
        // The first authorized attempt fails to empty the scope, so the next heartbeat retries it.
        expect((await pass()).retired).toEqual([]);
        killWorks = true;
        expect(await pass()).toMatchObject({ retired: [5100] });
        expect(await pass()).toEqual({ censuses: 0, retired: [] });
    } finally { await rm(rootDir, { recursive: true, force: true }); }
});
