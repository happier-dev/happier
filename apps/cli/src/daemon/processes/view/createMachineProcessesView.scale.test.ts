import { afterEach, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createProcessOwnershipRuntime } from '../ownership/processOwnershipRuntime';
import { listHappierProcessRoots } from '../roots/listHappierProcessRoots';
import { createLeftBehindPass } from '../leftBehind/leftBehindPass';
import { createMachineProcessesView } from './createMachineProcessesView';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createLocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import { createLocalServiceEndpointEnricher } from '@/daemon/local/services/inventory/endpoint';
import type { MachineProcessesAnswerV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';

afterEach(() => vi.useRealTimers());

it('returns private custody rows on a 10,000-process host before unrelated HTTP inventory enrichment settles', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const pids = Array.from({ length: 10_000 }, (_, offset) => offset + 100);
    const scope = '123456789abc';
    const auxv = Buffer.alloc(32);
    auxv.writeBigUInt64LE(6n); auxv.writeBigUInt64LE(4096n, 8);
    let executableReads = 0;
    // Genuine OS boundary: all census parsing, attribution and projection remain real.
    const ownership = createProcessOwnershipRuntime({ selfPid: 100, platform: 'linux', daemonScopeKey: scope,
        censusDependencies: { platform: 'linux', selfPid: 100, logicalCpus: 48, linuxBoundary: {
            readdir: async () => pids.map(String),
            readlink: async path => {
                if (path.endsWith('/exe')) { executableReads++; return '/usr/bin/node'; }
                return '/private/work';
            },
            readFile: async path => {
                if (path.endsWith('/auxv')) return auxv;
                const pid = Number(path.split('/')[2]);
                if (path.endsWith('/status')) return `Uid:\t${pid < 103 || pid % 5 !== 0 ? 1000 : 2000}\n`;
                if (path.endsWith('/stat')) {
                    const fields = ['S', String(pid === 101 ? 100 : pid === 102 ? 101 : 1), String(pid), String(pid),
                        '0', '-1', ...Array<string>(5).fill('0'), '12', '8', ...Array<string>(6).fill('0'), String(pid), '4096', '3'];
                    return `${pid} (node) ${fields.join(' ')}`;
                }
                if (path.endsWith('/cgroup')) return '0::/user.slice\n';
                if (path.endsWith('/cmdline')) return 'node\0worker.js\0--token\0private-token\0';
                if (path.endsWith('/environ')) return pid === 101 || pid === 102 ? `HAPPIER_PROCESS_OWNER=v1.${scope}.session.s\0` : '';
                throw new Error(`Unexpected procfs path ${path}`);
            },
        } },
        listRoots: snapshot => listHappierProcessRoots({ snapshot, selfPid: 100, platform: 'linux', bootTimeMs: 0,
            daemonScopeKey: scope, trackedSessions: [{ pid: 101, happySessionId: 's', processStartTimeMs: 1010 }] }),
    });
    const leftBehind = createLeftBehindPass({ processOwnershipRuntime: ownership });
    const sampler = createMachineVitalsSampler({ readers: { read: async () => { throw new Error('No vitals demand'); } },
        // Persistent history is a system boundary; this list must never request it.
        historyStore: { read: async () => [], append: async () => true, prune: async () => undefined,
            appendAlert: async () => undefined, minutes: () => [], alerts: () => [] } });
    let enterProbe!: () => void;
    let releaseProbe!: () => void;
    const entered = new Promise<void>(resolve => { enterProbe = resolve; });
    const pendingHttp = new Promise<void>(resolve => { releaseProbe = resolve; });
    const services = createLocalServicesDaemonRuntime({ machineId: 'm', startLoop: false, inventoryEnabled: () => true,
        scan: async () => ({ listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 102 }],
            processes: new Map([[102, { pid: 102, command: 'node worker.js', processStartTimeMs: 1020 }]]), workspaces: [], diagnostics: [] }),
        endpointEnricher: createLocalServiceEndpointEnricher({ now: Date.now, probe: async () => { enterProbe(); await pendingHttp; return true; } }),
        pageTitleEnricher: { fetchTitle: async () => null },
    });
    const refresh = services.refreshInventoryNow();
    await entered;
    const view = createMachineProcessesView({ processOwnershipRuntime: ownership, leftBehind, machineVitals: sampler,
        localServiceRoutes: services.inventoryRoutes, platform: 'linux', selfPid: 100, bootTimeMs: 0,
        allProcessesVisible: () => false, requesterForOwner: () => ({ accountId: 'a' }) });
    let answer: MachineProcessesAnswerV1 | undefined;
    const started = performance.now();
    const list = view.list({ machineId: 'm' }, { accountId: 'a', custodianAccountId: 'a' }).then(value => { answer = value; });
    try {
        // Flush actual procfs promise work; no invented wall-clock deadline.
        await vi.waitFor(() => expect(answer?.state).toBe('live'));
        console.info(JSON.stringify({ phase: 'scale_list', processCount: pids.length, ms: performance.now() - started }));
        expect(answer?.totals.happier.processCount).toBe(3);
        expect(answer?.owners.flatMap(owner => owner.members).map(row => row.pid).sort()).toEqual([100, 101, 102]);
        expect(JSON.stringify(answer)).not.toContain('private-token');
        expect(answer?.notHappier).toBeUndefined();
        // Linux app grouping consumes cgroup/name, never executable paths.
        expect(executableReads).toBe(0);
        expect(services.inventoryRegistry.getSnapshot().generatedAt).toBe(0);
        const ref = answer!.owners.flatMap(owner => owner.members).find(row => row.pid === 102)!.ref;
        expect((await view.get({ machineId: 'm', ref }, { accountId: 'a', custodianAccountId: 'a' })).row?.pid).toBe(102);
        expect((await view.check({ machineId: 'm', refs: [ref] }, { accountId: 'a', custodianAccountId: 'a' })).checks)
            .toMatchObject([{ ref, present: true, identityEqual: true, level: 'proven' }]);
    } finally {
        releaseProbe();
        await refresh; await list;
        view.dispose(); leftBehind.dispose(); await services.stop();
    }
});
