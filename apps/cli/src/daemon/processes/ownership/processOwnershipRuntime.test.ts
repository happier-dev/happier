import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localServiceProcfsFixture } from '@/daemon/local/services/inventory/platform/censusFixture.testkit';
import { listHappierProcessRoots } from '../roots/listHappierProcessRoots';
import { createProcessOwnershipRuntime } from './processOwnershipRuntime';
import { createProcessActionExecutor } from '../actions/processActionExecutor';
import { createMachineProcessesView } from '../view/createMachineProcessesView';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createLeftBehindPass } from '../leftBehind/leftBehindPass';

describe('processOwnershipRuntime root observation boundary', () => {
    it('keeps genuinely unreadable or unsupported cgroups unknown without weakening an ordinary live parent proof', async () => {
        const id = 'd'.repeat(64);
        for (const unavailable of ['denied', 'unsupported-layout'] as const) {
            const procfs = localServiceProcfsFixture([{ pid: 20 }, { pid: 30 }, { pid: 31, ppid: 30 }]);
            const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', platform: 'linux',
                censusDependencies: { platform: 'linux', linuxBoundary: { ...procfs, readFile: async path => {
                    if (/^\/proc\/(20|31)\/cgroup$/u.test(path)) {
                        if (unavailable === 'denied') throw Object.assign(new Error('procfs denied'), { code: 'EACCES' });
                        return `11:memory:/docker/${id}\n10:cpu,cpuacct:/docker/${id}\n`;
                    }
                    return procfs.readFile(path);
                } } },
                listRoots: snapshot => listHappierProcessRoots({ snapshot, platform: 'linux', trackedSessions: [{ pid: 30,
                    happySessionId: 'ordinary-session', processStartTimeMs: snapshot.rows.find(row => row.pid === 30)!.start.startTimeMs }],
                    nativeContainers: [{ pid: 20, owner: { kind: 'container', serverId: 'home', machineId: 'machine', serviceId: 'production/web',
                        containerId: id, composeProject: 'production', composeService: 'web', environmentId: 'environment' } }] }) });
            const read = await runtime.readOwners({ freshness: 'fresh' });
            expect(read.status).toBe('ok');
            if (read.status !== 'ok') throw new Error('Expected a readable process identity census');
            expect(read.snapshot.partial?.find(row => row.pid === 20)?.missing).toContain('cgroup');
            expect(read.rows.find(row => row.pid === 20)).toMatchObject({ owner: null, level: 'unknown' });
            expect(read.rows.find(row => row.pid === 31)).toMatchObject({ owner: { kind: 'session', sessionId: 'ordinary-session' }, level: 'proven' });
        }
    });
    it('requires current Environment read before native process disclosure and refuses raw controls without another census owner', async () => {
        const id = 'b'.repeat(64);
        const nativeOwner = { kind: 'container' as const, serverId: 'home', machineId: 'machine',
            serviceId: 'production/web', containerId: id, composeProject: 'production', composeService: 'web', environmentId: 'environment' };
        const procfs = localServiceProcfsFixture([{ pid: 20, uid: '0', command: ['worker', '--token', 'private-token'] },
            { pid: 21, ppid: 20, uid: '0', command: ['worker-child'] }]);
        let nativeReads = 0;
        let signals = 0;
        const censusDependencies = { platform: 'linux' as const, linuxBoundary: { ...procfs,
            readdir: async (path: string) => { nativeReads++; return procfs.readdir(path); },
            readFile: async (path: string) => path.endsWith('/cgroup') && /^\/proc\/(20|21)\//u.test(path)
                ? `0::/system.slice/docker-${id}.scope` : procfs.readFile(path) } };
        const runtime = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: '123456789abc', censusDependencies,
            listRoots: snapshot => listHappierProcessRoots({ snapshot, platform: 'linux', nativeContainers: [{ owner: nativeOwner, pid: 20 }] }) });
        const vitals = createMachineVitalsSampler({ readers: { read: async () => { throw new Error('No metrics demand'); } },
            historyStore: { read: async () => [], append: async () => true, prune: async () => undefined,
                appendAlert: async () => undefined, minutes: () => [], alerts: () => [] } });
        const leftBehind = createLeftBehindPass({ processOwnershipRuntime: runtime });
        const view = createMachineProcessesView({ platform: 'linux', bootTimeMs: 100, allProcessesVisible: () => false,
            processOwnershipRuntime: runtime, leftBehind, machineVitals: vitals, requesterForOwner: () => null });
        const requester = { accountId: 'reader', custodianAccountId: 'owner' };
        let allowed = false;
        let accessReads = 0;
        const admitted = { ...requester, async canReadEnvironment(target: Readonly<{ serverId: string; environmentId: string }>) {
            expect(target).toEqual({ serverId: 'home', environmentId: 'environment' }); accessReads++; return allowed;
        } };
        try {
            expect((await view.list({ machineId: 'machine' }, requester)).owners).toEqual([]);
            expect((await view.list({ machineId: 'machine' }, admitted)).owners).toEqual([]);
            allowed = true;
            accessReads = 0;
            const before = nativeReads;
            const answers = await Promise.all(Array.from({ length: 8 }, () => view.list({ machineId: 'machine' }, admitted)));
            expect(nativeReads - before).toBe(1);
            expect(accessReads).toBe(8); // One current read per requester disclosure, shared by both service processes.
            expect(answers.every(answer => answer.owners.length === 1 && answer.owners[0].members.length === 2)).toBe(true);
            expect(JSON.stringify(answers)).not.toContain('private-token');
            const member = answers[0].owners[0].members[0];
            allowed = false;
            expect((await view.get({ machineId: 'machine', ref: member.ref }, admitted)).row).toBeNull();
            expect((await view.check({ machineId: 'machine', refs: [member.ref] }, admitted)).checks)
                .toEqual([{ ref: member.ref, present: false, identityEqual: false }]);
            const actions = createProcessActionExecutor({ ownership: runtime, leftBehind, platform: 'linux',
                requesterForOwner: () => null, allProcessesVisible: () => true,
                systemBoundary: { platform: 'linux', censusDependencies, kill() { signals++; }, wait: async () => {} } });
            const target = { ref: member.ref, expect: { level: 'proven' as const, owner: nativeOwner } };
            for (const operation of [actions.executeStop({ machineId: 'machine', targets: [target] }, { accountId: 'owner', isCustodian: true }),
                actions.executeKill({ machineId: 'machine', tree: true, targets: [target] }, { accountId: 'owner', isCustodian: true })]) {
                expect(await operation).toMatchObject({ status: 'refused', outcomes: [{ reasonCode: 'native_service_control_required' }] });
            }
            expect(signals).toBe(0);
        } finally { view.dispose(); leftBehind.dispose(); await vitals.stop(); }
    });

    it('shares the complete passive observation, separates field and attribution demand, and never retains a settled table', async () => {
        const procfs = localServiceProcfsFixture(Array.from({ length: 1000 }, (_, index) => ({ pid: process.pid + index + 1 })));
        let nativeReads = 0;
        const projections: Array<'retained' | 'recover'> = [];
        const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', platform: 'linux',
            censusDependencies: { platform: 'linux', linuxBoundary: { ...procfs,
                readdir: async path => { nativeReads++; return procfs.readdir(path); } } },
            listRoots: (snapshot, options) => {
                projections.push(options.requesterAttribution ?? 'recover');
                return listHappierProcessRoots({ snapshot, platform: 'linux', daemonScopeKey: '123456789abc' });
            } });
        const sameDemand = Array.from({ length: 8 }, (_, index) => runtime.readOwners({ freshness: 'shared',
            fields: index % 2 ? ['argv', 'cwd'] : ['cwd', 'argv'] }));
        const answers = await Promise.all(sameDemand);
        expect(answers.every(answer => answer.status === 'ok' && answer.snapshot.rows.length === 1001)).toBe(true);
        expect(nativeReads).toBe(1);
        expect(projections).toEqual(['recover']);

        await Promise.all([runtime.readOwners({ freshness: 'shared', fields: [] }),
            runtime.readOwners({ freshness: 'shared', fields: ['argv'] }),
            runtime.readOwners({ freshness: 'shared', fields: ['argv'], requesterAttribution: 'retained' })]);
        expect(nativeReads).toBe(3);
        expect(projections.slice(1).sort()).toEqual(['recover', 'recover', 'retained']);
        await runtime.readOwners({ freshness: 'shared', fields: ['cwd', 'argv'] });
        expect(nativeReads).toBe(4);
        expect(projections).toHaveLength(5);
        await Promise.all([runtime.readOwners({ freshness: 'fresh', fields: [] }),
            runtime.readOwners({ freshness: 'fresh', fields: [] })]);
        expect(nativeReads).toBe(6);
        expect(projections).toHaveLength(7);
    });

    it('returns typed unavailability for a genuine lifecycle filesystem read failure, never an empty authoritative owner table', async () => {
        const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc',
            censusDependencies: { platform: 'linux', linuxBoundary: localServiceProcfsFixture([]) },
            listRoots: async snapshot => {
                // Genuine missing lifecycle source; only the procfs OS adapter is a fixture.
                await readFile(join(tmpdir(), randomUUID(), 'session-marker.json'), 'utf8');
                return listHappierProcessRoots({ snapshot });
            } });
        await expect(runtime.readOwners({ freshness: 'fresh' })).resolves.toEqual({ status: 'unavailable', reason: 'read_failed' });
        await expect(runtime.resolveSnapshot({ status: 'ok', capturedAtMs: 1000, logicalCpus: 1, rows: [] }))
            .resolves.toEqual({ status: 'unavailable', reason: 'read_failed' });
    });
});
