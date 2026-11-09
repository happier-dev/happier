import { afterEach, expect, it, vi } from 'vitest';
import type { ProcessCensusInput, ProcessCensusSnapshot } from '@/processes/census/processCensus';
import { createProcessOwnershipRuntime } from '../ownership/processOwnershipRuntime';
import { createLeftBehindPass } from '../leftBehind/leftBehindPass';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMachineProcessesView } from './createMachineProcessesView';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import { createLocalServiceInventoryRoutes } from '@/daemon/local/services/inventory/routes';
import { MACHINE_WATCH_WINDOW_MS } from '@happier-dev/protocol/rpc/machineWatchWindow';
import { MachineProcessesCheckResultV1Schema, MachineProcessesGetResultV1Schema, MachineProcessesWatchResultV1Schema, type MachineProcessesWatchResultV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { spawnSupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';
import { spawn } from 'node:child_process';
import { createManagedChildProcess } from '@/subprocess/supervision/managedChildProcess';
import { once } from 'node:events';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { writeDaemonState, clearDaemonStateForTestTeardown } from '@/persistence';
import { configuration } from '@/configuration';
import { createTerminalProcessRegistry } from '@/daemon/local/services/inventory/terminalRegistry';
import { listHappierProcessRoots } from '../roots/listHappierProcessRoots';
import { formatProcessOwnerTag, resolveProcessOwnerScopeKey } from '@/processes/ownerTag';
import { PROCESS_LAUNCH_NOTIFICATION_PATH, ProcessLaunchNotificationResultSchema } from '@/processes/launchNotification';
import { createProcessCustodySamplingInvoker } from '@/subprocess/supervision/processCustody';
import { decodeHelperCensus } from '@/processes/census/decodeHelperCensus';
import { createGuardLeftBehindFixture, guardLeftBehindOwner } from '../../guard/actuators/leftBehind.testkit';

// Native census and vitals I/O are system boundaries; the sampler and every domain owner are real.
const boundary = vi.hoisted(() => ({ read: vi.fn<(input: ProcessCensusInput) => Promise<ProcessCensusSnapshot>>() }));
vi.mock('@/processes/census/processCensus', async importOriginal => ({
    ...await importOriginal<typeof import('@/processes/census/processCensus')>(), readProcessCensus: boundary.read,
}));
afterEach(() => { vi.useRealTimers(); boundary.read.mockReset(); });
it('checks left-behind display facts from the authorized row without disclosing foreign or reused identities', async () => {
    const native = createGuardLeftBehindFixture();
    const pass = createLeftBehindPass({ processOwnershipRuntime: native.ownership });
    const sampler = createMachineVitalsSampler({ readers: { read: async () => { throw new Error('No vitals demand'); } },
        historyStore: { read: async () => [], append: async () => true, prune: async () => undefined,
            appendAlert: async () => undefined, minutes: () => [], alerts: () => [] } });
    const view = createMachineProcessesView({ processOwnershipRuntime: native.ownership, leftBehind: pass,
        machineVitals: sampler, platform: 'darwin', selfPid: process.pid,
        allProcessesVisible: () => false, requesterForOwner: () => ({ accountId: 'owner' }) });
    try {
        await pass.firstPass();
        native.advance(60_000);
        await pass.readConfirmed();
        const refs = pass.confirmed().map(item => item.ref);
        expect(refs).toHaveLength(2);
        const result = await view.check({ machineId: 'machine', refs }, { accountId: 'owner', custodianAccountId: 'owner' });
        expect(MachineProcessesCheckResultV1Schema.parse(result).checks).toMatchObject(refs.map(ref => ({ ref,
            present: true, identityEqual: true, level: 'left_behind', owner: guardLeftBehindOwner,
            row: { ref, name: 'watcher', command: 'watcher', level: 'left_behind' } })));
        expect(MachineProcessesGetResultV1Schema.parse(await view.get({ machineId: 'machine', ref: refs[0]! },
            { accountId: 'owner', custodianAccountId: 'owner' })).row).toMatchObject({ name: 'watcher', command: 'watcher' });
        expect((await view.check({ machineId: 'machine', refs }, { accountId: 'foreign', custodianAccountId: 'owner' })).checks)
            .toEqual(refs.map(ref => ({ ref, present: false, identityEqual: false })));
        const child = native.rows.get(300)!;
        native.rows.set(300, { ...child, start: { startTimeMs: child.start.startTimeMs + 1 } });
        expect((await view.check({ machineId: 'machine', refs: [refs[0]!] }, { accountId: 'owner', custodianAccountId: 'owner' })).checks[0])
            .not.toHaveProperty('row');
    } finally { view.dispose(); pass.dispose(); await sampler.stop(); }
});
it('does not let an older metrics read erase newly discovered ownership', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const row = (pid: number) => ({ pid, ppid: pid === 100 ? 1 : 100, start: { startTimeMs: pid === 100 ? 100 : 1000 + pid },
        principal: { kind: 'uid' as const, value: '1000' }, name: 'fixture', memory: { bytes: 20, kind: 'rss' as const }, cpuTimeUs: null });
    let discovered = false;
    let releaseMetrics: (() => void) | undefined;
    boundary.read.mockImplementation(async input => {
        if (input.pids) {
            await new Promise<void>(resolve => { releaseMetrics = resolve; });
            // The older observation positively retires the original child.
            return { status: 'ok', capturedAtMs: 3000, logicalCpus: 2, rows: [row(100)] };
        }
        return { status: 'ok', capturedAtMs: Date.now(), logicalCpus: 2, rows: [row(100), row(discovered ? 21 : 20)] };
    });
    const runtime = createProcessOwnershipRuntime({ selfPid: 100, platform: 'darwin', daemonScopeKey: '123456789abc', listRoots: () => [
        { owner: { kind: 'happier' }, pid: 100, start: { startTimeMs: 100 }, ownerCreatedAtMs: 100, live: true },
    ] });
    const pass = createLeftBehindPass({ processOwnershipRuntime: runtime });
    const sampler = createMachineVitalsSampler({ readers: { read: async input => ({ state: 'reporting',
        host: { logicalCores: 2, memoryTotalBytes: 2000, bootedAt: 0 },
        sample: { v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs, cpu: { reported: false, reason: 'unavailable' },
            memory: { reported: false, reason: 'unavailable' }, disk: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' } },
        minuteCounters: { monotonicMs: input.monotonicMs, cpu: null, network: null },
    }) }, historyStore: { read: async () => [], append: async () => true, prune: async () => undefined,
        appendAlert: async () => undefined, minutes: () => [], alerts: () => [] }, monotonicMs: () => Date.now() });
    const view = createMachineProcessesView({ processOwnershipRuntime: runtime, leftBehind: pass, machineVitals: sampler,
        platform: 'darwin', selfPid: 100, allProcessesVisible: () => false, requesterForOwner: () => ({ accountId: 'a' }) });
    const requester = { accountId: 'a', custodianAccountId: 'a' };
    const request = { machineId: 'm', scope: 'happier' as const, view: 'tree' as const };
    const cancellation = new AbortController();
    await sampler.start();
    const initial = await view.watch(request, requester);
    const parked = view.watch({ ...request, since: initial.changed ? initial.answer.capturedAtMs : 0 }, requester, cancellation.signal);
    try {
        await vi.advanceTimersByTimeAsync(2000);
        expect(releaseMetrics).toBeTypeOf('function');
        discovered = true;
        const newer = await view.watch(request, requester);
        expect(newer.changed && newer.answer.owners.flatMap(owner => owner.members).map(item => item.pid)).toContain(21);
        releaseMetrics?.();
        const answer = await parked;
        expect(answer.changed && answer.answer.owners.flatMap(owner => owner.members).map(item => item.pid)).toContain(21);
    } finally {
        releaseMetrics?.(); cancellation.abort(); await parked; view.dispose(); pass.dispose(); await sampler.stop();
    }
});
it('shares one demanded Overview process stream across viewers without enumerating on metric-only samples', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    let nativeEnumerations = 0;
    const runtime = createProcessOwnershipRuntime({ selfPid: 100, platform: 'darwin', daemonScopeKey: '123456789abc',
        censusDependencies: { platform: 'darwin', selfPid: 100, helperExecutablePath: '/fixture/helper',
            execFile: async (_file, args) => {
                if (!args.some(arg => arg.startsWith('--pids='))) nativeEnumerations++;
                return { stdout: JSON.stringify({ v: 1, capturedAtMs: Date.now(), logicalCpus: 2,
                    rows: Array.from({ length: 1001 }, (_, index) => ({ pid: 100 + index, ppid: index ? 100 : 1,
                        start: { startTimeMs: 100 + index }, principal: { kind: 'uid', value: '1000' }, name: 'fixture',
                        memory: { bytes: 20, kind: 'rss' }, cpuTimeUs: Date.now() * 100 })) }) };
            } },
        listRoots: () => [{ owner: { kind: 'happier' }, pid: 100, start: { startTimeMs: 100 }, ownerCreatedAtMs: 100, live: true }],
    });
    const pass = createLeftBehindPass({ processOwnershipRuntime: runtime });
    const sampler = createMachineVitalsSampler({ readers: { read: async input => ({ state: 'reporting',
        host: { logicalCores: 2, memoryTotalBytes: 2000, bootedAt: 0 },
        sample: { v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs, cpu: { reported: false, reason: 'unavailable' },
            memory: { reported: false, reason: 'unavailable' }, disk: { reported: false, reason: 'unavailable' },
            network: { reported: false, reason: 'unavailable' } },
        minuteCounters: { monotonicMs: input.monotonicMs, cpu: null, network: null },
    }) }, historyStore: { read: async () => [], append: async () => true, prune: async () => undefined,
        appendAlert: async () => undefined, minutes: () => [], alerts: () => [] }, monotonicMs: () => Date.now() });
    const view = createMachineProcessesView({ processOwnershipRuntime: runtime, leftBehind: pass, machineVitals: sampler,
        platform: 'darwin', selfPid: 100, allProcessesVisible: () => false, requesterForOwner: () => ({ accountId: 'a' }) });
    const requester = { accountId: 'a', custodianAccountId: 'a' };
    const request = { machineId: 'm', scope: 'happier' as const, view: 'owners' as const };
    const controller = new AbortController();
    let releaseOverview: (() => void) | undefined;
    try {
        await sampler.start();
        releaseOverview = sampler.demandOverview();
        let answers = await Promise.all(Array.from({ length: 8 }, () => view.watch(request, requester)));
        expect(nativeEnumerations).toBe(1);
        for (let period = 0; period < 20; period++) {
            const pending = answers.map(answer => view.watch({ ...request,
                since: answer.changed ? answer.answer.capturedAtMs : Date.now() }, requester, controller.signal));
            await vi.advanceTimersByTimeAsync(period === 0 ? 4000 : 2000);
            answers = await Promise.all(pending);
            expect(answers.every(answer => answer.changed && answer.answer.totals.happier.processCount === 1001)).toBe(true);
            expect(answers.every(answer => answer.changed && answer.answer.history === undefined)).toBe(true);
        }
        // One discovery on open, then the approved 25 s ownership backstop.
        // Eight viewers and twenty real sample periods do not multiply discovery.
        expect(nativeEnumerations).toBe(2);
    } finally {
        controller.abort(); releaseOverview?.(); view.dispose(); pass.dispose(); await sampler.stop();
    }
});
it('projects no process rows while an unchanged watch parks and projects each changed row once', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const processCount = 1501;
    const snapshot = () => ({ v: 1, capturedAtMs: Date.now(), logicalCpus: 2,
        rows: Array.from({ length: processCount }, (_, index) => ({ pid: 100 + index, ppid: index ? 100 : 1,
            start: { startTimeMs: 100 + index }, principal: { kind: 'uid', value: '1000' }, name: 'fixture',
            memory: { bytes: 20, kind: 'rss' }, cpuTimeUs: null })) });
    const runtime = createProcessOwnershipRuntime({ selfPid: 100, platform: 'darwin', daemonScopeKey: '123456789abc',
        // Native helper execution is the OS boundary; keep census decoding and
        // ownership resolution real for this scale-shaped projection contract.
        censusDependencies: { platform: 'darwin', selfPid: 100, helperExecutablePath: '/fixture/helper',
            execFile: async () => ({ stdout: JSON.stringify(snapshot()), stderr: '' }) },
        listRoots: () => [
        { owner: { kind: 'happier' }, pid: 100, start: { startTimeMs: 100 }, ownerCreatedAtMs: 100, live: true },
    ] });
    const pass = createLeftBehindPass({ processOwnershipRuntime: runtime });
    const sampler = createMachineVitalsSampler({ readers: { read: async input => ({ state: 'reporting',
        host: { logicalCores: 2, memoryTotalBytes: 2000, bootedAt: 0 },
        sample: { v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs, cpu: { reported: false, reason: 'unavailable' },
            memory: { reported: false, reason: 'unavailable' }, disk: { reported: false, reason: 'unavailable' },
            network: { reported: false, reason: 'unavailable' } },
        minuteCounters: { monotonicMs: input.monotonicMs, cpu: null, network: null },
    }) }, historyStore: { read: async () => [], append: async () => true, prune: async () => undefined,
        appendAlert: async () => undefined, minutes: () => [], alerts: () => [] } });
    // This adapter supplies actual fixture ownership identity. Count row projection
    // work at its input, without replacing the projector, planner or ownership logic.
    let projectedRows = 0;
    const view = createMachineProcessesView({ processOwnershipRuntime: runtime, leftBehind: pass, machineVitals: sampler,
        platform: 'darwin', selfPid: 100, allProcessesVisible: () => false,
        requesterForOwner: () => { projectedRows++; return { accountId: 'a' }; } });
    const requester = { accountId: 'a', custodianAccountId: 'a' };
    const request = { machineId: 'm', scope: 'happier' as const, view: 'tree' as const };
    const cancellation = new AbortController();
    let pending: Promise<MachineProcessesWatchResultV1> | undefined;
    try {
        await sampler.start();
        const initial = await view.watch(request, requester);
        expect(initial.changed && initial.answer.totals.happier.processCount).toBe(processCount);
        expect(projectedRows).toBe(processCount);
        projectedRows = 0;
        pending = view.watch({ ...request, since: Date.now() }, requester, cancellation.signal);
        await vi.advanceTimersByTimeAsync(0);
        expect(projectedRows).toBe(0);
        await vi.advanceTimersByTimeAsync(2000);
        const answer = await pending;
        expect(answer.changed && answer.answer.totals.happier.processCount).toBe(processCount);
        expect(projectedRows).toBe(processCount);
        expect(MachineProcessesWatchResultV1Schema.safeParse(answer).success).toBe(true);
        projectedRows = 0;
        pending = view.watch({ ...request, since: Date.now() }, requester, cancellation.signal);
        await vi.advanceTimersByTimeAsync(0);
        cancellation.abort();
        expect(await pending).toEqual({ changed: false });
        expect(projectedRows).toBe(0);
    } finally {
        cancellation.abort(); await pending;
        view.dispose(); pass.dispose(); await sampler.stop();
    }
});
it.each(['reused', 'exited', 'unreadable', 'resources_unreadable', 'principal_unreadable', 'principal_null', 'principal_changed', 'external_principal_changed', 'external_self_principal_null'] as const)('reconciles a %s PID through the recipient watch projection', async observation => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    let reused = false;
    const external = observation === 'external_principal_changed' || observation === 'external_self_principal_null';
    const cpu = () => reused && observation === 'external_self_principal_null' ? Date.now() * 1000 : null;
    const principalObservation = observation === 'principal_unreadable' || observation === 'principal_null' || observation === 'principal_changed' || external;
    boundary.read.mockImplementation(async () => {
        const snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }> = { status: 'ok', capturedAtMs: Date.now(), logicalCpus: 2, rows: [
        { pid: 100, ppid: 1, start: { startTimeMs: 100 }, principal: reused && observation === 'external_self_principal_null' ? null : { kind: 'uid', value: '1000' }, name: 'daemon', memory: { bytes: 20, kind: 'rss' }, cpuTimeUs: cpu() },
        { pid: 20, ppid: 1, start: { startTimeMs: 200 }, principal: { kind: 'uid', value: '1000' }, name: 'agent', memory: { bytes: 10, kind: 'rss' }, cpuTimeUs: cpu() },
        ...(!reused || observation === 'reused' || observation === 'resources_unreadable' || principalObservation ? [{ pid: 42, ppid: external || reused && observation === 'reused' ? 1 : 20,
            start: { startTimeMs: reused && observation === 'reused' ? 2000 : 400, native: reused && observation === 'reused' ? 'gen2' : 'gen1' },
            principal: reused && principalObservation ? observation === 'external_self_principal_null' ? { kind: 'uid' as const, value: '1000' }
                : observation === 'principal_changed' || external ? { kind: 'uid' as const, value: '1001' } : null
                : { kind: 'uid' as const, value: '1000' }, name: reused && observation === 'reused' ? 'unrelated' : 'tool',
            memory: reused && observation === 'resources_unreadable' ? null : { bytes: reused ? 999 : 100, kind: 'rss' as const }, cpuTimeUs: cpu() },
        ] : []),
    ], ...(reused && (observation === 'unreadable' || observation === 'resources_unreadable' || observation === 'principal_unreadable')
        ? { partial: [{ pid: 42, missing: observation === 'unreadable' ? ['start'] : observation === 'principal_unreadable' ? ['principal'] : ['memory', 'cpuTimeUs'] }] } : {}) };
        return observation === 'principal_null' ? decodeHelperCensus(JSON.stringify({ v: 1, capturedAtMs: snapshot.capturedAtMs,
            logicalCpus: snapshot.logicalCpus, rows: snapshot.rows }), 100) : snapshot;
    });
    const runtime = createProcessOwnershipRuntime({ selfPid: 100, platform: 'darwin', daemonScopeKey: '123456789abc', listRoots: () => [
        { owner: { kind: 'happier' }, pid: 100, start: { startTimeMs: 100 }, ownerCreatedAtMs: 100, live: true },
        { owner: { kind: 'session', sessionId: 'old-owner' }, pid: 20, start: { startTimeMs: 200 }, ownerCreatedAtMs: 200, live: true },
    ] });
    const pass = createLeftBehindPass({ processOwnershipRuntime: runtime });
    const sampler = createMachineVitalsSampler({ readers: { read: async input => ({ state: 'reporting',
        host: { logicalCores: 2, memoryTotalBytes: 2000, bootedAt: 0 },
        sample: { v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs, cpu: { reported: true, busyPct: null },
            memory: { reported: true, totalBytes: 2000, availableBytes: 900, usedBytes: 1100, pressure: { level: 'calm', source: 'events' } },
            disk: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' } },
        minuteCounters: { monotonicMs: input.monotonicMs, cpu: null, network: null },
    }) }, historyStore: { read: async () => [], append: async () => true, prune: async () => undefined,
        appendAlert: async () => undefined, minutes: () => [], alerts: () => [] }, monotonicMs: () => Date.now() });
    const view = createMachineProcessesView({ processOwnershipRuntime: runtime, leftBehind: pass, machineVitals: sampler,
        platform: 'darwin', selfPid: 100, allProcessesVisible: () => external,
        requesterForOwner: owner => ({ accountId: owner.kind === 'session' ? 'guest' : 'custodian', displayName: 'Fixture identity' }) });
    const requester = { accountId: external ? 'custodian' : 'guest', custodianAccountId: 'custodian' };
    const request = { machineId: 'm', scope: external ? 'all' as const : 'happier' as const, view: 'tree' as const };
    const cancellation = new AbortController();
    try {
        await sampler.start();
        const initial = await view.watch(request, requester);
        expect(initial.changed && initial.answer.totals.happier.memoryBytes).toBe(external ? 30 : 110);
        const firstPending = view.watch({ ...request, since: Date.now() }, requester, cancellation.signal);
        await vi.advanceTimersByTimeAsync(2000);
        const first = await firstPending;
        expect(first.changed && first.answer.history?.['session:old-owner']?.at(-1)?.memoryBytes).toBe(external ? 10 : 110);
        reused = true;
        let measured: MachineProcessesWatchResultV1 | undefined;
        const secondPending = view.watch({ ...request, since: Date.now() }, requester, cancellation.signal)
            .then(answer => { measured = answer; return answer; });
        await vi.advanceTimersByTimeAsync(2000);
        expect(measured?.changed).toBe(true);
        const second = await secondPending;
        expect(second.changed).toBe(true);
        if (!second.changed) throw new Error('Expected measured watch answer');
        if (external) {
            expect(initial.changed && initial.answer.notHappier?.flatMap(group => group.members).map(row => row.pid)).toEqual([42]);
            expect(second.answer.notHappier).toEqual([]);
            expect(second.answer.unverifiableCount).toBe(1);
            expect(JSON.stringify(second.answer)).not.toContain('999');
            return;
        }
        const unreadable = observation === 'unreadable' || observation === 'resources_unreadable';
        const retained = unreadable || principalObservation;
        expect(second.answer.owners[0].members.map(row => row.pid)).toEqual(retained ? [20, 42] : [20]);
        expect(second.answer.totals.happier).toMatchObject({ processCount: retained ? 2 : 1, memoryBytes: retained ? null : 10 });
        if (retained) expect(second.answer.owners[0].members.find(row => row.pid === 42))
            .toMatchObject({ level: observation === 'resources_unreadable' ? 'proven' : 'unknown', memoryBytes: null });
        expect(second.answer.history?.['session:old-owner']?.at(-1)?.memoryBytes).toBe(retained ? null : 10);
        expect(second.answer.history?.['session:old-owner']?.[0].memoryBytes).toBe(110);
        expect(Object.keys(second.answer.history ?? {})).toEqual(['session:old-owner']);
        expect(second.answer.othersWork).toEqual({ count: 1 });
        expect(MachineProcessesWatchResultV1Schema.safeParse(second).success).toBe(true);
        if (observation === 'unreadable' || principalObservation) {
            const ref = second.answer.owners[0].members.find(row => row.pid === 42)!.ref;
            expect((await view.check({ machineId: 'm', refs: [ref] }, requester)).checks)
                .toEqual([{ ref, present: false, identityEqual: false }]);
        }
        if (retained) {
            reused = false;
            const recoveredPending = view.watch({ ...request, since: Date.now() }, requester, cancellation.signal);
            await vi.advanceTimersByTimeAsync(2000);
            const recovered = await recoveredPending;
            expect(recovered.changed && recovered.answer.owners[0].members.find(row => row.pid === 42))
                .toMatchObject({ level: 'proven', memoryBytes: 100 });
            expect(recovered.changed && recovered.answer.totals.happier.memoryBytes).toBe(110);
        }
    } finally {
        cancellation.abort(); view.dispose(); pass.dispose(); await sampler.stop();
    }
});
it.each(['plugin supervisor', 'managed child'])('discovers a real %s launch before either sampling cadence and stops discovery when disposed', async launchOwner => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); vi.setSystemTime(1000);
    let childPid: number | undefined;
    boundary.read.mockImplementation(async () => ({ status: 'ok', capturedAtMs: Date.now(), logicalCpus: 2, rows: [
        { pid: 100, ppid: 1, start: { startTimeMs: 100 }, principal: { kind: 'uid', value: '1000' }, name: 'daemon',
            memory: { bytes: 20, kind: 'rss' }, cpuTimeUs: 0 },
        ...(childPid === undefined ? [] : [{ pid: childPid, ppid: 100, start: { startTimeMs: 1000 },
            principal: { kind: 'uid' as const, value: '1000' }, name: 'tool', memory: { bytes: 30, kind: 'rss' as const }, cpuTimeUs: 0 }]),
    ] }));
    const runtime = createProcessOwnershipRuntime({ selfPid: 100, platform: 'darwin', daemonScopeKey: '123456789abc', listRoots: () => [
        { owner: { kind: 'happier' }, pid: 100, start: { startTimeMs: 100 }, ownerCreatedAtMs: 100, live: true },
    ] });
    const pass = createLeftBehindPass({ processOwnershipRuntime: runtime });
    const sampler = createMachineVitalsSampler({ readers: { read: async () => { throw new Error('No sampler tick expected'); } },
        historyStore: { read: async () => [], append: async () => true, prune: async () => undefined,
            appendAlert: async () => undefined, minutes: () => [], alerts: () => [] } });
    const view = createMachineProcessesView({ processOwnershipRuntime: runtime, leftBehind: pass, machineVitals: sampler,
        platform: 'darwin', selfPid: 100, allProcessesVisible: () => false, requesterForOwner: () => ({ accountId: 'a' }) });
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'm',
        stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 's' }),
        requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'private-spawn-fixture' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture control port');
    await mkdir(dirname(configuration.daemonStateFile), { recursive: true });
    writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(), startedWithCliVersion: 'fixture',
        controlToken: 'private-spawn-fixture' });
    const requester = { accountId: 'a', custodianAccountId: 'a' };
    const initial = await view.watch({ machineId: 'm', scope: 'happier', view: 'tree' }, requester);
    const cancellation = new AbortController();
    let answer: MachineProcessesWatchResultV1 | undefined;
    const parked = view.watch({ machineId: 'm', scope: 'happier', view: 'tree', since: initial.changed ? initial.answer.capturedAtMs : 0 },
        requester, cancellation.signal).then(value => { answer = value; });
    await vi.advanceTimersByTimeAsync(1);
    const readsBeforeRejectedNotification = boundary.read.mock.calls.length;
    expect((await app.inject({ method: 'POST', url: PROCESS_LAUNCH_NOTIFICATION_PATH, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: PROCESS_LAUNCH_NOTIFICATION_PATH,
        headers: { 'x-happier-daemon-token': 'private-spawn-fixture' }, payload: { pid: 123 } })).statusCode).toBe(400);
    // Native sampling uses its real cli-common exec boundary, outside managed
    // workload launch. Sampling itself must not invalidate the demanded view.
    if (process.platform !== 'linux') {
        const nativeSample = await createProcessCustodySamplingInvoker()({ command: 'process-census', sampledAt: Date.now(),
            args: [`--caller-pid=${process.pid}`, `--pids=${process.pid}`, '--identity-only=true'] });
        expect(nativeSample.state).toBe('ready');
        await vi.advanceTimersByTimeAsync(0);
    }
    expect(boundary.read.mock.calls.length).toBe(readsBeforeRejectedNotification);
    const launched = launchOwner === 'plugin supervisor'
        ? spawnSupervisedPluginProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: process.env })
        : (() => {
            const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: process.env, stdio: 'pipe' });
            const managed = createManagedChildProcess(child);
            return { child, handle: { wait: managed.waitForTermination } };
        })();
    childPid = launched.child.pid;
    try {
        await once(launched.child, 'spawn');
        await vi.waitFor(() => expect(answer?.changed).toBe(true));
        expect(Date.now()).toBeLessThan(2000);
        expect(answer?.changed && answer.answer.owners.flatMap(owner => owner.members).map(row => row.pid)).toContain(childPid);
        expect(MachineProcessesWatchResultV1Schema.safeParse(answer).success).toBe(true);
        const response = await app.inject({ method: 'POST', url: PROCESS_LAUNCH_NOTIFICATION_PATH,
            headers: { 'x-happier-daemon-token': 'private-spawn-fixture' }, payload: {} });
        expect(ProcessLaunchNotificationResultSchema.parse(response.json())).toEqual({ accepted: true });
        const reads = boundary.read.mock.calls.length;
        view.dispose();
        const next = spawnSupervisedPluginProcess({ command: process.execPath, args: ['-e', 'process.exit(0)'], env: process.env });
        await once(next.child, 'spawn');
        await next.handle.wait();
        await vi.advanceTimersByTimeAsync(1);
        expect(boundary.read.mock.calls.length).toBe(reads);
    } finally {
        cancellation.abort(); await parked;
        view.dispose(); pass.dispose();
        launched.child.kill('SIGKILL');
        await launched.handle.wait();
        vi.useRealTimers(); await sampler.stop();
        await app.close(); await clearDaemonStateForTestTeardown();
    }
});
it('drains roots registered during a census and discovers idle registrations on re-arm even in the same millisecond', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const terminalRegistry = createTerminalProcessRegistry();
    const home = '/process-discovery-fixture';
    let pids: number[] = [];
    let releaseRead: (() => void) | undefined;
    let pauseNextRead = false;
    boundary.read.mockImplementation(async () => {
        const snapshot: ProcessCensusSnapshot = { status: 'ok', capturedAtMs: Date.now(), logicalCpus: 2, rows: [
            { pid: 100, ppid: 1, start: { startTimeMs: 100 }, principal: { kind: 'uid', value: '1000' }, name: 'daemon', memory: null, cpuTimeUs: 0 },
            ...pids.map(pid => ({ pid, ppid: 100, start: { startTimeMs: 900 }, principal: { kind: 'uid' as const, value: '1000' },
                name: 'shell', memory: { bytes: 30, kind: 'rss' as const }, cpuTimeUs: 0,
                ownerTag: formatProcessOwnerTag({ happierHomeDir: home, platform: 'darwin', owner: { kind: 'terminal', terminalId: `t${pid}` } }) })),
        ] };
        if (pauseNextRead) {
            pauseNextRead = false;
            await new Promise<void>(resolve => { releaseRead = resolve; });
        }
        return snapshot;
    });
    const runtime = createProcessOwnershipRuntime({ selfPid: 100, platform: 'darwin', daemonScopeKey: resolveProcessOwnerScopeKey(home, 'darwin'),
        listRoots: snapshot => listHappierProcessRoots({ snapshot, selfPid: 100, platform: 'darwin', happierHomeDir: home, terminalRegistry }) });
    const pass = createLeftBehindPass({ processOwnershipRuntime: runtime });
    const sampler = createMachineVitalsSampler({ readers: { read: async () => { throw new Error('No sampler tick expected'); } },
        historyStore: { read: async () => [], append: async () => true, prune: async () => undefined,
            appendAlert: async () => undefined, minutes: () => [], alerts: () => [] } });
    const view = createMachineProcessesView({ processOwnershipRuntime: runtime, leftBehind: pass, machineVitals: sampler,
        platform: 'darwin', selfPid: 100, allProcessesVisible: () => false, requesterForOwner: () => ({ accountId: 'a' }) });
    const requester = { accountId: 'a', custodianAccountId: 'a' };
    const initial = await view.watch({ machineId: 'm', scope: 'happier', view: 'tree' }, requester);
    const cancellation = new AbortController();
    const parked = view.watch({ machineId: 'm', scope: 'happier', view: 'tree', since: initial.changed ? initial.answer.capturedAtMs : 0 }, requester, cancellation.signal);
    try {
        await vi.advanceTimersByTimeAsync(0);
        pids = [20]; pauseNextRead = true;
        terminalRegistry.registerTerminalProcesses({ terminalKey: 't20', terminalId: 't20', workspacePath: '/repo', pids: [20] });
        expect(releaseRead).toBeTypeOf('function');
        pids = [20, 30];
        terminalRegistry.registerTerminalProcesses({ terminalKey: 't30', terminalId: 't30', workspacePath: '/repo', pids: [30] });
        releaseRead?.();
        const answer = await parked;
        expect(answer.changed && answer.answer.owners.filter(owner => owner.owner.kind === 'terminal').flatMap(owner => owner.members.map(row => row.pid))).toEqual([20, 30]);
        expect(MachineProcessesWatchResultV1Schema.safeParse(answer).success).toBe(true);
        expect(Date.now()).toBe(1000);
        const reads = boundary.read.mock.calls.length;
        pids.push(40);
        terminalRegistry.registerTerminalProcesses({ terminalKey: 't40', terminalId: 't40', workspacePath: '/repo', pids: [40] });
        await vi.advanceTimersByTimeAsync(0);
        expect(boundary.read.mock.calls.length).toBe(reads);
        const rearmed = await view.watch({ machineId: 'm', scope: 'happier', view: 'tree', since: answer.changed ? answer.answer.capturedAtMs : 0 }, requester);
        expect(rearmed.changed && rearmed.answer.owners.flatMap(owner => owner.members.map(row => row.pid))).toContain(40);
    } finally {
        releaseRead?.(); cancellation.abort(); await parked;
        view.dispose(); pass.dispose(); vi.useRealTimers(); await sampler.stop();
    }
});
it('shares discovery across concurrent watch opens so a stale capture cannot overwrite a launch discovered by the other reader', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const terminalRegistry = createTerminalProcessRegistry();
    const home = '/concurrent-process-discovery-fixture';
    let launched = false;
    let releaseRead: (() => void) | undefined;
    let pause = true;
    boundary.read.mockImplementation(async () => {
        const snapshot: ProcessCensusSnapshot = { status: 'ok', capturedAtMs: Date.now(), logicalCpus: 2, rows: [
            { pid: 100, ppid: 1, start: { startTimeMs: 100 }, principal: { kind: 'uid', value: '1000' }, name: 'daemon', memory: null, cpuTimeUs: 0 },
            ...(launched ? [{ pid: 20, ppid: 100, start: { startTimeMs: 900 }, principal: { kind: 'uid' as const, value: '1000' },
                name: 'shell', memory: { bytes: 30, kind: 'rss' as const }, cpuTimeUs: 0,
                ownerTag: formatProcessOwnerTag({ happierHomeDir: home, platform: 'darwin', owner: { kind: 'terminal', terminalId: 't20' } }) }] : []),
        ] };
        if (pause) { pause = false; await new Promise<void>(resolve => { releaseRead = resolve; }); }
        return snapshot;
    });
    const runtime = createProcessOwnershipRuntime({ selfPid: 100, platform: 'darwin', daemonScopeKey: resolveProcessOwnerScopeKey(home, 'darwin'),
        listRoots: snapshot => listHappierProcessRoots({ snapshot, selfPid: 100, platform: 'darwin', happierHomeDir: home, terminalRegistry }) });
    const pass = createLeftBehindPass({ processOwnershipRuntime: runtime });
    const sampler = createMachineVitalsSampler({ readers: { read: async () => { throw new Error('No sampler tick expected'); } },
        historyStore: { read: async () => [], append: async () => true, prune: async () => undefined,
            appendAlert: async () => undefined, minutes: () => [], alerts: () => [] } });
    const view = createMachineProcessesView({ processOwnershipRuntime: runtime, leftBehind: pass, machineVitals: sampler,
        platform: 'darwin', selfPid: 100, allProcessesVisible: () => false, requesterForOwner: () => ({ accountId: 'a' }) });
    const requester = { accountId: 'a', custodianAccountId: 'a' };
    const request = { machineId: 'm', scope: 'happier' as const, view: 'tree' as const };
    const first = view.watch(request, requester);
    await vi.advanceTimersByTimeAsync(0);
    launched = true;
    terminalRegistry.registerTerminalProcesses({ terminalKey: 't20', terminalId: 't20', workspacePath: '/repo', pids: [20] });
    const second = view.watch(request, requester);
    try {
        await vi.advanceTimersByTimeAsync(0);
        releaseRead?.();
        for (const answer of await Promise.all([first, second])) {
            expect(answer.changed && answer.answer.owners.flatMap(owner => owner.members.map(row => row.pid))).toContain(20);
        }
    } finally {
        releaseRead?.(); view.dispose(); await Promise.all([first, second]);
        pass.dispose(); vi.useRealTimers(); await sampler.stop();
    }
});
it.each([6000, MACHINE_WATCH_WINDOW_MS + 1000, 31_000])('samples only while watched, warming CPU after a %i ms re-arm gap', async rearmGapMs => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    let name = 'daemon';
    let cpuReported = true;
    boundary.read.mockImplementation(async input => ({ status: 'ok', capturedAtMs: Date.now(), logicalCpus: 2, rows: [
        { pid: 100, ppid: 1, start: { startTimeMs: 100 }, principal: { kind: 'uid', value: '1000' }, name,
            memory: { bytes: input.pids ? 30 : 20, kind: 'rss' }, cpuTimeUs: cpuReported ? Date.now() * 100 : null },
    ] }));
    const runtime = createProcessOwnershipRuntime({ selfPid: 100, platform: 'darwin', daemonScopeKey: '123456789abc', listRoots: () => [
        { owner: { kind: 'happier' }, pid: 100, start: { startTimeMs: 100 }, ownerCreatedAtMs: 100, live: true },
    ] });
    const pass = createLeftBehindPass({ processOwnershipRuntime: runtime });
    const directory = await mkdtemp(join(tmpdir(), 'processes-watch-'));
    const sampler = createMachineVitalsSampler({ readers: { read: async input => ({ state: 'reporting',
        host: { logicalCores: 2, effectiveCores: 0.5, memoryTotalBytes: 1000, bootedAt: 0 },
        sample: { v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs, cpu: { reported: true, busyPct: null },
            memory: { reported: true, totalBytes: 1000, availableBytes: 900, usedBytes: 100, pressure: { level: 'calm', source: 'events' } },
            disk: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' } },
        minuteCounters: { monotonicMs: input.monotonicMs, cpu: null, network: null },
    }) }, historyStore: await createMinuteHistoryStore({ directory }), monotonicMs: () => Date.now() });
    await sampler.start();
    const registry = createLocalServiceInventoryRegistry();
    registry.replaceSnapshot({ v: 1, machineId: 'm', generatedAt: 1000, refreshState: 'idle', diagnostics: [], entries: [{
        id: 'listener', machineId: 'm', address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' }, port: 5173, protocol: 'tcp',
        detectedAt: 1000, lastSeenAt: 1000, state: 'listening', source: 'detected', labels: [], confidence: 'high',
        processOwnershipConfidence: 'high', workspaceAssociationConfidence: 'high', diagnostics: [],
        provenance: { process: { pid: 100, processStartTimeMs: 100, lineagePids: [100], command: 'daemon', redacted: true } },
    }] });
    const localServiceRoutes = createLocalServiceInventoryRoutes({ registry });
    const view = createMachineProcessesView({ processOwnershipRuntime: runtime, leftBehind: pass, machineVitals: sampler, localServiceRoutes,
        platform: 'darwin', selfPid: 100, allProcessesVisible: () => false, requesterForOwner: () => ({ accountId: 'a', displayName: 'A' }) });
    const requester = { accountId: 'a', custodianAccountId: 'a' };
    const initial = await view.list({ machineId: 'm' }, requester);
    const standalone = await view.get({ machineId: 'm', ref: initial.owners[0].members[0].ref }, requester);
    expect(standalone.row).toMatchObject({ ports: [{ port: 5173, inventoryEntryId: 'listener' }] });
    expect(localServiceRoutes.watcherCount()).toBe(0);
    name = 'fresh native name';
    const firstWatch = await view.watch({ machineId: 'm', scope: 'happier', view: 'tree' }, requester);
    expect(firstWatch.changed && firstWatch.answer.owners[0].members[0].name).toBe(name);
    const fullCensusCount = () => boundary.read.mock.calls.filter(([input]) => input.pids === undefined).length;
    const fullCensusesBeforeIdleIntervals = fullCensusCount();
    const controller = new AbortController();
    const watched = view.watch({ machineId: 'm', scope: 'happier', view: 'tree',
        since: firstWatch.changed ? firstWatch.answer.capturedAtMs : initial.capturedAtMs }, requester, controller.signal);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(4000);
    const answer = await watched;
    expect(answer.changed).toBe(true);
    expect(answer.changed && answer.answer.owners[0].members[0].cpuPercent).toBe(20);
    expect(answer.changed && answer.answer.owners[0].totals.cpuPercent).toBe(20);
    expect(localServiceRoutes.watcherCount()).toBe(0);
    const ref = initial.owners[0].members[0].ref;
    const rearmed = view.watch({ machineId: 'm', scope: 'happier', view: 'tree', since: Date.now(), detailToken: ref }, requester);
    await vi.advanceTimersByTimeAsync(2000);
    const second = await rearmed;
    expect(second.changed && second.answer.owners[0].members[0].cpuPercent).toBe(20);
    expect(second.changed && second.answer.owners[0].members[0].memoryBytes).toBe(30);
    expect(second.changed && second.answer.history?.[ref]).toHaveLength(3);
    // TA-20-6 permits the retained observation to yield an honest average on
    // the first returning tick. After the shared watch window expires, the
    // view has discarded its observations and must collect a new pair.
    const expired = rearmGapMs > MACHINE_WATCH_WINDOW_MS;
    const readsBeforeGap = boundary.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(rearmGapMs);
    expect(boundary.read.mock.calls.length).toBe(readsBeforeGap);
    const rearmedAt = Date.now();
    // The client holds the second answer's series: the third carries only what is newer than it.
    const heldHistory = second.changed ? Object.values(second.answer.history ?? {}).flat() : [];
    const historySince = Math.max(...heldHistory.map(sample => sample.capturedAtMs));
    const thirdWatch = view.watch({ machineId: 'm', scope: 'happier', view: 'tree', historySince,
        since: second.changed ? second.answer.capturedAtMs : 0 }, requester);
    await vi.advanceTimersByTimeAsync(4000);
    const third = await thirdWatch;
    expect(third.changed).toBe(true);
    expect(MachineProcessesWatchResultV1Schema.safeParse(third).success).toBe(true);
    expect(third.changed && third.answer.owners[0].members[0].cpuPercent).toBe(20);
    expect(third.changed && third.answer.owners[0].totals.cpuPercent).toBe(20);
    expect(third.changed && third.answer.capturedAtMs).toBe(rearmedAt + (expired ? 2000 : 0));
    expect(fullCensusCount()).toBe(fullCensusesBeforeIdleIntervals + (expired ? 1 : 0));
    expect(boundary.read.mock.calls.some(([input]) => input.pids !== undefined
        && input.fields?.includes('memory') && input.fields.includes('cpuTimeUs'))).toBe(true);
    const reads = boundary.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(boundary.read.mock.calls.length).toBe(reads);
    const history = (await view.get({ machineId: 'm', ref }, requester)).history;
    expect(history).toEqual(expired ? [
        { capturedAtMs: rearmedAt, memoryBytes: 30 },
        { capturedAtMs: rearmedAt + 2000, memoryBytes: 30, cpuPercent: 20 },
    ] : [
        { capturedAtMs: 3000, memoryBytes: 30 },
        { capturedAtMs: 5000, memoryBytes: 30, cpuPercent: 20 },
        { capturedAtMs: 7000, memoryBytes: 30, cpuPercent: 20 },
        { capturedAtMs: 9000, memoryBytes: null, cpuPercent: null },
        { capturedAtMs: rearmedAt, memoryBytes: 30, cpuPercent: 20 },
    ]);
    const newerThanHeld = history!.filter(sample => sample.capturedAtMs > historySince);
    // Per-arrival cost follows what is new, not the retained window.
    expect(newerThanHeld).toHaveLength(2);
    expect(third.changed && third.answer.history?.[third.answer.owners[0].rowId]).toEqual(expired
        ? [{ capturedAtMs: historySince + 2000, memoryBytes: null, cpuPercent: null }, ...newerThanHeld] : newerThanHeld);
    await vi.advanceTimersByTimeAsync(MACHINE_WATCH_WINDOW_MS);
    expect((await view.get({ machineId: 'm', ref }, requester)).history).toBeUndefined();
    cpuReported = false;
    const refreshed = await view.watch({ machineId: 'm', scope: 'happier', view: 'tree' }, requester);
    const memoryOnly = view.watch({ machineId: 'm', scope: 'happier', view: 'tree',
        since: refreshed.changed ? refreshed.answer.capturedAtMs : Date.now() }, requester);
    await vi.advanceTimersByTimeAsync(2000);
    const memoryAnswer = await memoryOnly;
    expect(memoryAnswer.changed && memoryAnswer.answer.owners[0].members[0]).toMatchObject({ memoryBytes: 30 });
    expect(memoryAnswer.changed && memoryAnswer.answer.owners[0].members[0].cpuPercent).toBeUndefined();
    const cancellation = new AbortController();
    // Cancel the pending operation before pumping an overdue sampling timer;
    // an answer that completes first legitimately wins the cancellation race.
    const parked = view.watch({ machineId: 'm', scope: 'happier', view: 'tree',
        since: memoryAnswer.changed ? memoryAnswer.answer.capturedAtMs : Date.now() }, requester, cancellation.signal);
    cancellation.abort();
    expect(await parked).toEqual({ changed: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(localServiceRoutes.watcherCount()).toBe(0);
    view.dispose(); pass.dispose(); await sampler.stop(); await rm(directory, { recursive: true, force: true });
});
