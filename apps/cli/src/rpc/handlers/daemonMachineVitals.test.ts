import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RpcHandlerContext, RpcHandlerMap, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { createLinuxMachineVitalsReader } from '@/daemon/vitals/readers/linux';
import type { MachineVitalsReader, MachineVitalsReaderInput } from '@/daemon/vitals/readers/types';
import { MachineVitalsSnapshotV1Schema, MachineVitalsWatchResultV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import { registerDaemonMachineVitalsRpcHandlers } from './daemonMachineVitals';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createLinuxVitalsFixture } from '@/daemon/vitals/readers/linux.testkit';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { MachineResourceSummaryV1Schema, projectMachineResourceSummaryV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { MachineResourcesPolicyV1Schema, type MachineMonitoringPolicyV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';

describe('Machine vitals Machine admission', () => {
    const directories: string[] = [];
    const samplers: ReturnType<typeof createMachineVitalsSampler>[] = [];
    const controllers: AbortController[] = [];
    const initialTime = Date.UTC(2026, 9, 10);
    const identity = { serverId: 's', machineId: 'm', installationId: 'i', custodianAccountId: 'owner' };
    afterEach(async () => {
        controllers.splice(0).forEach(controller => controller.abort());
        await Promise.all(samplers.splice(0).map(sampler => sampler.stop()));
        vi.useRealTimers();
        await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
    });
    async function setup(options: { readers?: MachineVitalsReader; target?: () => typeof identity; monitoring?: Partial<MachineMonitoringPolicyV1> } = {}) {
        const directory = await mkdtemp(join(tmpdir(), 'happier-vitals-rpc-'));
        directories.push(directory);
        const historyStore = await createMinuteHistoryStore({ directory });
        const policy = MachineResourcesPolicyV1Schema.parse({ v: 1, monitoring: options.monitoring ?? {} });
        const sampler = createMachineVitalsSampler({ readers: options.readers ?? createLinuxMachineVitalsReader({ root: directory }), historyStore,
            monotonicMs: () => Date.now() - initialTime, readPolicy: () => policy });
        samplers.push(sampler);
        // Match the canonical erased heterogeneous RPC transport registry.
        const handlers: RpcHandlerMap = new Map();
        const rpc: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
        registerDaemonMachineVitalsRpcHandlers(rpc, { sampler, target: options.target ?? (() => identity) });
        return { sampler, handlers };
    }
    function context(actorAccountId: string, role: 'use' | 'manage', verify = async () => true, controller = new AbortController()): RpcHandlerContext {
        controllers.push(controller);
        return { signal: controller.signal, machineAdmission: {
            machineId: 'm', installationId: 'i', custodianAccountId: 'owner', actorAccountId, role, encryptionMode: 'plain',
        // The real RPC transport also fails current-admission verification closed on cancellation.
        }, verifyMachineAdmissionCurrent: async () => !controller.signal.aborted && await verify() && !controller.signal.aborted };
    }
    async function sampledSetup(readFails = () => false, monitoring: Partial<MachineMonitoringPolicyV1> = {}) {
        vi.useFakeTimers();
        vi.setSystemTime(initialTime);
        const reads: MachineVitalsReaderInput[] = [];
        // Native OS readings are the system boundary; sampler, journal and RPC admission remain real.
        const readers: MachineVitalsReader = { async read(input) {
            reads.push(input);
            if (readFails()) throw new Error('Native reader unavailable');
            return {
                state: 'reporting', host: { logicalCores: 4, memoryTotalBytes: 1000, bootedAt: initialTime - 100_000 },
                sample: {
                    v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs,
                    cpu: { reported: true, busyPct: 25 },
                    memory: { reported: true, totalBytes: 1000, availableBytes: 800, usedBytes: 200,
                        pressure: { level: 'calm', source: 'events' },
                        composition: [{ kind: 'apps' as const, bytes: 200 }] },
                    disk: { reported: false, reason: 'unavailable' }, network: { reported: true, rxBps: 100, txBps: 50 },
                    limits: { files: { used: 1, max: 10 }, ...(input.overviewExtras ? { inotify: { used: 2, max: 20 } } : {}) },
                    ...(input.overviewExtras ? {
                        gpu: [{ name: 'gpu', busyPct: 20 }], battery: { pct: 80, state: 'charging' as const, onAC: true },
                        thermal: { state: 'nominal' as const }, sharedMemory: { totalBytes: 500, availableBytes: 400 },
                    } : {}),
                },
                minuteCounters: { monotonicMs: input.monotonicMs, cpu: { busy: input.monotonicMs / 4, total: input.monotonicMs },
                    network: { interfaceIds: ['eth0'], rxBytes: input.monotonicMs, txBytes: input.monotonicMs / 2 } },
            };
        } };
        const result = await setup({ readers, monitoring });
        await result.sampler.start();
        return { ...result, reads };
    }
    async function advance(sampler: ReturnType<typeof createMachineVitalsSampler>, ms: number) {
        await vi.advanceTimersByTimeAsync(ms);
        await sampler.start();
        // A minute append is real filesystem IO. Its completion may arm an
        // already-due base tick after the fake clock's initial advance ended.
        await vi.advanceTimersByTimeAsync(0);
        await sampler.start();
    }
    it('composes native vitals through the real RPC manager, route registration and current Machine admission', async () => {
        const native = await createLinuxVitalsFixture();
        let current = true;
        const { sampler } = await setup({ readers: createLinuxMachineVitalsReader({ root: native.root }) });
        const manager = new RpcHandlerManager({ scopePrefix: 'm', localMachineId: 'm', encryptionMode: 'plain', logger: () => {},
            authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: 'm', resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'i',
                // Current Home access verification is the network boundary. Local
                // target matching, authorization, dispatch and schemas remain real.
                verifyMachineAdmission: async () => current,
            }) });
        registerDaemonMachineVitalsRpcHandlers(manager, { sampler, target: () => identity });
        const request = { method: `m:${RPC_METHODS.MACHINES_VITALS_GET}`, params: { machineId: 'm', view: 'summary' },
            callerAuthority: 'present_user' as const,
            machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse(context('owner', 'manage').machineAdmission) };
        try {
            await sampler.start();
            const response = await manager.handleRequest(request);
            expect(MachineVitalsSnapshotV1Schema.parse(response)).toEqual(response);
            expect(response).toMatchObject({ state: 'reporting', sample: { memory: { totalBytes: 102_400_000, availableBytes: 40_960_000 } } });
            const summary = MachineVitalsSnapshotV1Schema.parse(response);
            expect(MachineResourceSummaryV1Schema.parse(projectMachineResourceSummaryV1(summary, sampler.host() ?? undefined)).cpu)
                .toMatchObject({ load1: expect.any(Number), logicalCores: summary.sample?.cpu.reported ? sampler.host()?.logicalCores : undefined });
            expect(summary.sample?.memory).toMatchObject({ composition: expect.any(Array) });
            if (summary.sample?.memory.reported) expect(summary.sample.memory.composition?.reduce((sum, part) => sum + part.bytes, 0)).toBe(summary.sample.memory.usedBytes);
            current = false;
            expect(await manager.handleRequest(request)).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
        } finally { await sampler.stop(); await native.cleanup(); }
    });
    it('authorizes each parked watch once at dispatch and re-admits only the next request', async () => {
        const { sampler } = await sampledSetup();
        let current = true;
        let verifications = 0;
        const manager = new RpcHandlerManager({ scopePrefix: 'm', localMachineId: 'm', encryptionMode: 'plain', logger: () => {},
            authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: 'm', resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'i',
                // Home verification is the network boundary; dispatcher, route and sampler are real.
                verifyMachineAdmission: async () => { verifications++; return current; },
            }) });
        registerDaemonMachineVitalsRpcHandlers(manager, { sampler, target: () => identity });
        const request = (sinceSampledAt: number) => ({ method: `m:${RPC_METHODS.DAEMON_VITALS_WATCH}`,
            params: { machineId: 'm', view: 'summary', sinceSampledAt }, callerAuthority: 'present_user' as const,
            machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse(context('recipient', 'use').machineAdmission) });
        for (let sample = 0; sample < 3; sample++) {
            const before = verifications;
            const pending = manager.handleRequest(request(sampler.latest()!.sampledAt));
            await advance(sampler, 0);
            const parkedVerifications = verifications - before;
            expect(parkedVerifications).toBe(1);
            await advance(sampler, 60_000);
            expect(MachineVitalsWatchResultV1Schema.parse(await pending)).toMatchObject({ changed: true });
            expect(verifications - before).toBe(1);
        }
        const beforeRevocation = verifications;
        const pending = manager.handleRequest(request(sampler.latest()!.sampledAt));
        await advance(sampler, 0);
        current = false;
        await advance(sampler, 60_000);
        expect(MachineVitalsWatchResultV1Schema.parse(await pending)).toMatchObject({ changed: true });
        expect(verifications - beforeRevocation).toBe(1);
        const beforeDenied = verifications;
        expect(await manager.handleRequest(request(sampler.latest()!.sampledAt))).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
        expect(verifications - beforeDenied).toBe(1);
    });
    it('retains producer sample identity through typed Overview snapshot and watch replies', async () => {
        const { sampler, handlers } = await sampledSetup();
        const sample = sampler.latest();
        const snapshot = await handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!(
            { machineId: 'm', view: 'overview' }, context('recipient', 'use'));
        if (!snapshot || typeof snapshot !== 'object' || !('sample' in snapshot)) throw new Error('Missing snapshot sample');
        expect(snapshot.sample).toBe(sample);
        const watch = await handlers.get(RPC_METHODS.DAEMON_VITALS_WATCH)!(
            { machineId: 'm', view: 'overview', sinceSampledAt: initialTime - 1 }, context('recipient', 'use'));
        if (!watch || typeof watch !== 'object' || !('samples' in watch) || !Array.isArray(watch.samples)) throw new Error('Missing watch samples');
        expect(watch.samples[0]).toBe(sample);
    });
    it('admits custodians and Use recipients to content-free machine facts', async () => {
        const { handlers } = await setup();
        for (const admitted of [context('owner', 'manage'), context('recipient', 'use')]) {
            expect(await handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!({ serverId: 's', machineId: 'm', view: 'summary' }, admitted))
                .toMatchObject({ state: 'reporting', sample: null, series5m: { cpu: [], memory: [] } });
            expect(await handlers.get(RPC_METHODS.MACHINES_VITALS_HISTORY_GET)!({ machineId: 'm', range: '1h' }, admitted))
                .toMatchObject({ range: '1h', today: { rxBytes: 0, txBytes: 0 } });
        }
    });
    it('reads vitals for a caller-local label of the admitted Home', async () => {
        const { handlers } = await setup({ target: () => ({ ...identity, serverId: 'daemon-home' }) });
        const admitted = context('recipient', 'use');
        expect(await handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!({ serverId: 'browser-home', machineId: 'm' }, admitted))
            .toMatchObject({ state: 'reporting', sample: null });
    });
    it('refuses missing admission and another exact target while consuming dispatch admission', async () => {
        const { handlers } = await setup();
        const read = handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!;
        await expect(read({ machineId: 'm' })).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        await expect(read({ machineId: 'other' }, context('recipient', 'use'))).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        expect(await read({ machineId: 'm' }, context('recipient', 'use', async () => false))).toMatchObject({ sample: null });
        expect(await read({ serverId: 'browser-home', machineId: 'm' }, context('recipient', 'use', async () => false))).toMatchObject({ sample: null });
        for (const patch of [{ installationId: 'other' }, { custodianAccountId: 'other' }, { machineId: 'other' }, { actorAccountId: '' }]) {
            const admitted = context('recipient', 'use');
            await expect(read({ machineId: 'm' }, { ...admitted, machineAdmission: { ...admitted.machineAdmission!, ...patch } }))
                .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        }
        expect(await read({ machineId: 'm' }, { ...context('recipient', 'use'), verifyMachineAdmissionCurrent: undefined }))
            .toMatchObject({ sample: null });
    });
    it('reports failed local target predicates without private identity values', async () => {
        const { handlers } = await setup();
        const read = handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!;
        const reportAdmissionDenial = vi.fn();
        const admitted = { ...context('recipient', 'use'), reportAdmissionDenial };
        await expect(read({ machineId: 'private-other-machine' }, admitted)).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        expect(reportAdmissionDenial.mock.calls).toEqual([['machine_request_target']]);
        reportAdmissionDenial.mockClear();
        await expect(read({ machineId: 'm' }, { ...admitted, machineAdmission: { ...admitted.machineAdmission!, installationId: 'private-old-installation' } }))
            .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        expect(reportAdmissionDenial.mock.calls).toEqual([['machine_installation']]);
        reportAdmissionDenial.mockClear();
        expect(await read({ machineId: 'm' }, { ...admitted, verifyMachineAdmissionCurrent: async () => false })).toMatchObject({ sample: null });
        expect(reportAdmissionDenial.mock.calls).toEqual([]);
        expect(JSON.stringify(reportAdmissionDenial.mock.calls)).not.toContain('private-');
    });
    it('rejects unknown or malformed inputs for every vitals entry point', async () => {
        const { handlers } = await setup();
        const admitted = context('recipient', 'use');
        for (const [method, request, issue] of [
            [RPC_METHODS.MACHINES_VITALS_GET, { machineId: 'm', content: true }, { code: 'unrecognized_keys', path: [], keys: ['content'] }],
            [RPC_METHODS.MACHINES_VITALS_HISTORY_GET, { machineId: 'm', range: '1h', content: true }, { code: 'unrecognized_keys', path: [], keys: ['content'] }],
            [RPC_METHODS.DAEMON_VITALS_WATCH, { machineId: 'm', view: 'summary', content: true }, { code: 'unrecognized_keys', path: [], keys: ['content'] }],
            [RPC_METHODS.MACHINES_VITALS_GET, { machineId: 'm', view: 'anything' }, { code: 'invalid_value', path: ['view'] }],
            [RPC_METHODS.MACHINES_VITALS_HISTORY_GET, { machineId: 'm', range: 'forever' }, { code: 'invalid_value', path: ['range'] }],
            [RPC_METHODS.DAEMON_VITALS_WATCH, { machineId: 'm', view: 'summary', sinceSampledAt: -1 }, { code: 'too_small', path: ['sinceSampledAt'] }],
        ] as const) await expect(handlers.get(method)!(request, admitted)).rejects.toMatchObject({
            issues: expect.arrayContaining([expect.objectContaining(issue)]),
        });
    });
    it('rejects a changed installation before consuming the admitted target', async () => {
        let target = identity;
        const { handlers } = await setup({ target: () => target });
        for (const replacement of [{ ...identity, installationId: 'replaced' }]) {
            target = identity;
            target = replacement;
            await expect(handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!({ serverId: 's', machineId: 'm' }, context('recipient', 'use')))
                .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        }
    });
    it('does not acquire sampling demand for immediate get or history reads', async () => {
        const { sampler, handlers, reads } = await sampledSetup(undefined, { mode: 'while_viewing' });
        const admitted = context('recipient', 'use');
        await handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!({ machineId: 'm', view: 'overview' }, admitted);
        await handlers.get(RPC_METHODS.MACHINES_VITALS_HISTORY_GET)!({ machineId: 'm', range: '1h' }, admitted);
        await advance(sampler, 59_000);
        expect(reads).toHaveLength(0);
        await advance(sampler, 1000);
        expect(reads).toHaveLength(0);
        const pending = handlers.get(RPC_METHODS.DAEMON_VITALS_WATCH)!({ machineId: 'm', view: 'overview', sinceSampledAt: initialTime }, admitted);
        await advance(sampler, 0);
        expect(await pending).toMatchObject({ changed: true });
        expect(reads).toHaveLength(1);
        expect(reads[0]).toMatchObject({ sampledAt: initialTime + 60_000, intervalMs: 2_000, overviewExtras: true });
    });
    it('keeps the five-minute wire series continuous at the minute cadence for summary demand', async () => {
        const { sampler, handlers } = await sampledSetup();
        const release = sampler.demand('summary');
        try {
            for (let minute = 0; minute < 3; minute++) await advance(sampler, 60_000);
            const snapshot = MachineVitalsSnapshotV1Schema.parse(await handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!(
                { machineId: 'm', view: 'summary' }, context('recipient', 'use')));
            expect(sampler.samplesSince(initialTime - 1).map(sample => sample.intervalMs)).toEqual(Array(4).fill(60_000));
            for (const points of Object.values(snapshot.series5m)) {
                const live = points.filter(point => point.t >= initialTime);
                expect(live.map(point => point.t)).toEqual(Array.from({ length: 4 }, (_, index) => initialTime + index * 60_000));
                expect(live.every(point => point.y !== null)).toBe(true);
            }
        } finally { release(); }
    });
    it('keeps an explicit gap in every wire metric after genuinely missed minute samples', async () => {
        let failing = false;
        const { sampler, handlers } = await sampledSetup(() => failing);
        await advance(sampler, 60_000);
        failing = true;
        await advance(sampler, 180_000);
        failing = false;
        await advance(sampler, 60_000);
        const snapshot = MachineVitalsSnapshotV1Schema.parse(await handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!(
            { machineId: 'm', view: 'summary' }, context('recipient', 'use')));
        for (const points of Object.values(snapshot.series5m)) {
            expect(points.filter(point => point.y === null)).toEqual([{ t: initialTime + 120_000, y: null }]);
            expect(points.at(-1)?.t).toBe(initialTime + 300_000);
            expect(points.at(-1)?.y).not.toBeNull();
        }
    });
    it('finishes an admitted changed-sample watch and releases parked demand', async () => {
        const { sampler, handlers, reads } = await sampledSetup(undefined, { mode: 'while_viewing' });
        let valid = true;
        const pending = handlers.get(RPC_METHODS.DAEMON_VITALS_WATCH)!({ machineId: 'm', view: 'summary', sinceSampledAt: initialTime }, context('recipient', 'use', async () => valid));
        await advance(sampler, 0);
        valid = false;
        await advance(sampler, 60_000);
        expect(await pending).toMatchObject({ changed: true });
        await advance(sampler, 61_000);
        expect(reads.at(-1)?.sampledAt).toBe(initialTime + 60_000);
    });
    it('releases cadence and extras demand when the RPC transport cancels a parked watch', async () => {
        const { sampler, handlers, reads } = await sampledSetup(undefined, { mode: 'while_viewing' });
        const controller = new AbortController();
        const admitted = context('recipient', 'use', async () => true, controller);
        const pending = handlers.get(RPC_METHODS.DAEMON_VITALS_WATCH)!({ machineId: 'm', view: 'overview', sinceSampledAt: initialTime }, admitted);
        const rejected = expect(pending).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        await advance(sampler, 0);
        controller.abort();
        await rejected;
        await advance(sampler, 59_000);
        expect(reads.at(-1)?.sampledAt).toBe(initialTime);
        await advance(sampler, 1000);
        expect(reads).toHaveLength(1);
        expect(sampler.minutes(initialTime)).toEqual([]);
    });
    it('does not resolve summary watches on two-second live ticks', async () => {
        const { sampler, handlers } = await sampledSetup();
        const releaseLive = sampler.demand('live');
        try {
            let resolved = false;
            const pending = handlers.get(RPC_METHODS.DAEMON_VITALS_WATCH)!({ machineId: 'm', view: 'summary', sinceSampledAt: initialTime }, context('recipient', 'use'));
            void pending.then(() => { resolved = true; });
            await advance(sampler, 14_000);
            expect(sampler.latest()?.sampledAt).toBe(initialTime + 14_000);
            expect(resolved).toBe(false);
            await advance(sampler, 2000);
            expect(MachineVitalsWatchResultV1Schema.parse(await pending)).toMatchObject({ changed: true, samples: [{ sampledAt: initialTime + 16_000 }] });
        } finally { releaseLive(); }
    });
    it('keeps memory detail attached to summary readings while filtering independent Overview extras', async () => {
        const { sampler, handlers } = await sampledSetup();
        const releaseOverview = sampler.demandOverview();
        try {
            await advance(sampler, 2_000);
            const admitted = context('recipient', 'use');
            const overview = MachineVitalsSnapshotV1Schema.parse(await handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!({ machineId: 'm', view: 'overview' }, admitted));
            expect(overview.sample).toMatchObject({ gpu: [{ name: 'gpu' }], battery: { pct: 80 }, thermal: { state: 'nominal' },
                sharedMemory: { totalBytes: 500 }, memory: { composition: [{ kind: 'apps' }] }, limits: { inotify: { used: 2 } } });
            const summary = MachineVitalsSnapshotV1Schema.parse(await handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!({ machineId: 'm', view: 'summary' }, admitted));
            const pending = handlers.get(RPC_METHODS.DAEMON_VITALS_WATCH)!({ machineId: 'm', view: 'summary', sinceSampledAt: initialTime }, admitted);
            await advance(sampler, 16_000);
            const watched = MachineVitalsWatchResultV1Schema.parse(await pending);
            expect(watched.changed).toBe(true);
            if (!watched.changed) throw new Error('Expected summary samples');
            for (const sample of [summary.sample, ...watched.samples]) {
                expect(sample).toMatchObject({ limits: { files: { used: 1, max: 10 } } });
                for (const key of ['gpu', 'battery', 'thermal', 'sharedMemory']) expect(sample).not.toHaveProperty(key);
                expect(sample?.memory).toMatchObject({ composition: [{ kind: 'apps', bytes: 200 }] });
                expect(sample?.limits).not.toHaveProperty('inotify');
            }
        } finally { releaseOverview(); }
    });
    it('keeps the slow-fact tick budget across normal Overview watch re-arms', async () => {
        const { sampler, handlers, reads } = await sampledSetup();
        let cursor = initialTime;
        for (let cycle = 0; cycle < 9; cycle++) {
            const pending = handlers.get(RPC_METHODS.DAEMON_VITALS_WATCH)!({ machineId: 'm', view: 'overview', sinceSampledAt: cursor }, context('recipient', 'use'));
            await advance(sampler, 0);
            await advance(sampler, 2000);
            const result = MachineVitalsWatchResultV1Schema.parse(await pending);
            expect(result.changed).toBe(true);
            if (!result.changed) throw new Error('Expected Overview samples');
            cursor = result.samples.at(-1)!.sampledAt;
        }
        expect(reads.filter(input => input.overviewExtras).map(input => input.sampledAt)).toEqual([initialTime + 2_000, initialTime + 18_000]);
    });

    it.each([false, true])('serves the real minute sample between Overview re-arms (summary demand: %s)', async (summary) => {
        const { sampler, handlers, reads } = await sampledSetup();
        const releaseOverview = sampler.demandOverview();
        const releaseSummary = summary ? sampler.demand('summary') : () => {};
        await advance(sampler, 59_800);
        const cursor = sampler.latest()!.sampledAt;
        releaseOverview();
        // Delivery/re-arm crosses a base tick at the minute, with no parked Overview.
        await advance(sampler, 500);
        const watch = handlers.get(RPC_METHODS.DAEMON_VITALS_WATCH)!;
        const admitted = context('recipient', 'use');
        const catchUp = MachineVitalsWatchResultV1Schema.parse(await watch({ machineId: 'm', view: 'overview', sinceSampledAt: cursor }, admitted));
        expect(catchUp).toMatchObject({ changed: true, samples: [{ sampledAt: initialTime + 60_000, intervalMs: 2_000 }] });
        const returning = watch({ machineId: 'm', view: 'overview', sinceSampledAt: initialTime + 60_000 }, admitted);
        await advance(sampler, 1_700);
        expect(MachineVitalsWatchResultV1Schema.parse(await returning)).toMatchObject({ changed: true, samples: [{ sampledAt: initialTime + 62_000, intervalMs: 2_000 }] });
        expect(reads.filter(read => read.sampledAt >= initialTime + 59_800).map(read => read.sampledAt))
            .toEqual([initialTime + 60_000, initialTime + 62_000]);
        releaseSummary();
    });

    it('keeps another Overview live when a concurrent watcher cancels', async () => {
        const { sampler, handlers, reads } = await sampledSetup(undefined, { mode: 'while_viewing' });
        const watch = handlers.get(RPC_METHODS.DAEMON_VITALS_WATCH)!;
        const controller = new AbortController();
        const cancelled = watch({ machineId: 'm', view: 'overview', sinceSampledAt: initialTime }, context('owner', 'manage', async () => true, controller));
        const rejected = expect(cancelled).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        const surviving = watch({ machineId: 'm', view: 'overview', sinceSampledAt: initialTime }, context('recipient', 'use'));
        await advance(sampler, 0);
        controller.abort();
        await rejected;
        await advance(sampler, 2_000);
        expect(MachineVitalsWatchResultV1Schema.parse(await surviving)).toMatchObject({ changed: true, samples: [{ sampledAt: initialTime + 2_000, intervalMs: 2_000 }] });
        expect(reads.filter(read => read.sampledAt > initialTime).map(read => read.intervalMs)).toEqual([2_000]);
        await advance(sampler, 57_000);
        expect(reads.at(-1)?.sampledAt).toBe(initialTime + 2_000);
    });
});
