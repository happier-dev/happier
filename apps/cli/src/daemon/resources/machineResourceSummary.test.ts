import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineResourceSummary } from './machineResourceSummary';
import { createMachineVitalsSampler } from '../vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '../vitals/history/minuteHistoryStore';
import type { MachineVitalsReaderResult } from '../vitals/readers/types';
import type { ApiMachineClient } from '@/api/apiMachine';
import { MachinePublishedDaemonStateV1Schema, StoredMachinePublishedDaemonStateV1Schema,
    type MachinePublishedDaemonStateV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { MachineResourceSummaryV1Schema, projectMachineResourceSummaryV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';

describe('Machine resource summary through the real sampler', () => {
    let directory: string;
    const initialTime = Date.UTC(2026, 9, 10);
    beforeEach(async () => { vi.useFakeTimers(); vi.setSystemTime(initialTime); directory = await mkdtemp(join(tmpdir(), 'happier-resource-summary-')); });
    afterEach(async () => { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });

    async function setup(initialThreshold: { freeFraction: number } | null = { freeFraction: 0.1 }, initialFailure?: 'helper_missing' | 'reader_failed') {
        let pressure: 'calm' | 'critical' = 'calm';
        let failure = initialFailure;
        let load1 = 2.314;
        let filesUsed: number | undefined;
        let threshold = initialThreshold;
        const historyStore = await createMinuteHistoryStore({ directory });
        let summary: ReturnType<typeof createMachineResourceSummary> | undefined;
        const sampler = createMachineVitalsSampler({ historyStore,
            // The reader is the OS boundary; counter aggregation/history/lifecycle remain real.
            readers: { read: async (input): Promise<MachineVitalsReaderResult> => failure ? { state: 'unavailable', reason: failure } : {
                state: 'reporting', host: { logicalCores: 4, effectiveCores: 0.5, memoryTotalBytes: 1000, bootedAt: initialTime - 1000 },
                sample: { v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs,
                    cpu: { reported: true, busyPct: input.sampledAt % 100, load1 },
                    memory: { reported: true, totalBytes: 1000, availableBytes: 800, usedBytes: 200, pressure: { level: pressure, source: 'events' } },
                    disk: { reported: true, volumes: [{ id: 'home', label: 'Home', mount: '/home', totalBytes: 1000, availableBytes: 150 }] },
                    network: { reported: false, reason: 'unavailable' },
                    ...(filesUsed === undefined ? {} : { limits: { files: { used: filesUsed, max: 100 } } }) },
                minuteCounters: { monotonicMs: input.monotonicMs, cpu: null, network: null },
            } }, onTick: () => summary?.refresh(),
        });
        const writes: MachinePublishedDaemonStateV1[] = [];
        const initialState: MachinePublishedDaemonStateV1 = {
            status: 'running', localServices: { v: 1, state: 'ready', runningCount: 2 },
        };
        let connection!: Parameters<ApiMachineClient['onConnectionStateChange']>[0];
        const transport: Pick<ApiMachineClient, 'updateDaemonState' | 'onConnectionStateChange'> = {
            updateDaemonState: async update => {
                const produced = update(writes.at(-1) ?? initialState);
                // Validate before any tolerant stored reader can discard producer drift.
                expect(MachinePublishedDaemonStateV1Schema.parse(produced)).toEqual(produced);
                expect(StoredMachinePublishedDaemonStateV1Schema.parse(JSON.parse(JSON.stringify(produced)))).toEqual(produced);
                writes.push(produced);
                return 'published';
            },
            onConnectionStateChange: listener => { connection = listener; return () => {}; },
        };
        await sampler.start();
        summary = createMachineResourceSummary({ sampler, readNearlyFull: () => threshold, onError: error => { throw error; } });
        const release = summary.attachPublication(transport, () => false);
        // Connection transport fixture: the summary only observes the connection phase.
        const setConnection = (phase: 'online' | 'offline') => connection({ phase } as Parameters<typeof connection>[0]);
        const tick = async () => { await vi.advanceTimersByTimeAsync(60_000); await sampler.start(); };
        return { sampler, summary, writes, release, setConnection, tick,
            pressure: (next: typeof pressure) => { pressure = next; }, fail: (next: typeof failure) => { failure = next; },
            load: (next: number) => { load1 = next; },
            files: (next: number) => { filesUsed = next; },
            threshold: (next: typeof threshold) => { threshold = next; summary?.refresh(); } };
    }

    it('projects readable load and observed core capacity without publishing sample changes to daemonState', async () => {
        const f = await setup();
        f.setConnection('online');
        const valueSummary = () => MachineResourceSummaryV1Schema.parse(projectMachineResourceSummaryV1({
            state: 'reporting', sample: f.sampler.latest(),
            series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
        }, f.summary.getSummary()?.host));
        try {
            expect(valueSummary().cpu).toMatchObject({ load1: 2.31, logicalCores: 4, effectiveCores: 0.5 });
            const publications = f.writes.length;
            for (let sample = 0; sample < 12; sample++) {
                f.load(2.3101 + sample * 0.0001);
                await f.tick();
                expect(valueSummary().cpu).toMatchObject({ load1: 2.31 });
            }
            expect(f.writes).toHaveLength(publications);
            f.load(2.326); await f.tick();
            expect(valueSummary().cpu).toMatchObject({ load1: 2.33 });
            expect(f.writes).toHaveLength(publications);
            f.pressure('critical'); await f.tick();
            expect(f.writes).toHaveLength(publications + 1);
            expect(f.writes.at(-1)?.resources?.attention.level).toBe('needs_you');
            f.files(100); await f.tick();
            const withLimit = f.writes.length;
            f.files(101); await f.tick();
            expect(f.writes).toHaveLength(withLimit);
            expect(f.summary.getSummary()?.attention.reasons).toContainEqual(expect.objectContaining({
                kind: 'limit_reached', limit: 'files', used: 101, max: 100,
            }));
        } finally { f.release(); f.summary.stop(); await f.sampler.stop(); }
    });

    it('publishes transitions only, preserves other state, retains typed guard way-back, and republishes on reconnect', async () => {
        const f = await setup();
        f.setConnection('online');
        expect(f.writes).toHaveLength(1);
        expect(f.writes[0].localServices).toMatchObject({ state: 'ready', runningCount: 2 });
        const initial = f.summary.getSummary();
        await f.tick();
        expect(f.writes).toHaveLength(1);
        expect(f.summary.getSummary()).toBe(initial);
        f.pressure('critical'); await f.tick();
        expect(f.writes).toHaveLength(2);
        expect(f.writes.at(-1)?.resources?.attention.level).toBe('needs_you');
        expect(f.summary.getSummary()?.host).toBe(initial?.host);
        const critical = f.summary.getSummary();
        await f.tick(); expect(f.writes).toHaveLength(2);
        expect(f.summary.getSummary()).toBe(critical);
        f.summary.reportAutomaticAction({ at: Date.now(), kind: 'stopped_session', entryId: 'entry', undoable: true,
            facts: { rule: 'memory_guard', freedBytes: 100, count: 1 } });
        expect(f.writes.at(-1)?.resources?.lastAutomaticAction).toMatchObject({ entryId: 'entry', undoable: true, facts: { freedBytes: 100 } });
        expect(f.writes.at(-1)?.resources).not.toHaveProperty('sample');
        f.summary.reportAutomaticAction({ at: Date.now(), kind: 'stopped_service', entryId: 'other-entry', undoable: true,
            facts: { rule: 'memory_guard', freedBytes: 20 } });
        expect(f.writes.at(-1)?.resources?.lastAutomaticAction?.entryId).toBe('other-entry');
        const beforeReconnect = f.writes.length;
        f.setConnection('offline'); f.setConnection('online'); expect(f.writes).toHaveLength(beforeReconnect + 1);
        f.summary.stop();
        f.setConnection('offline'); f.setConnection('online');
        await f.tick(); expect(f.writes).toHaveLength(beforeReconnect + 1);
        f.release(); await f.sampler.stop();
    });

    it('uses changed policy immediately and publishes reader failure only after one minute, then recovers', async () => {
        const f = await setup(); f.setConnection('online');
        f.threshold({ freeFraction: 0.2 });
        expect(f.summary.getSummary()?.attention.reasons[0].kind).toBe('disk_nearly_full');
        f.fail('reader_failed'); await f.tick();
        expect(f.summary.getSummary()?.vitals.state).toBe('reporting');
        await f.tick(); expect(f.summary.getSummary()?.vitals).toMatchObject({ state: 'unavailable', reason: 'reader_failed' });
        f.fail(undefined); await f.tick(); expect(f.summary.getSummary()?.vitals.state).toBe('reporting');
        f.fail('helper_missing'); await f.tick();
        expect(f.summary.getSummary()?.vitals).toMatchObject({ state: 'unavailable', reason: 'helper_missing' });
        f.fail('reader_failed'); const releaseDemand = f.sampler.demand('summary');
        await vi.advanceTimersByTimeAsync(15_000);
        expect(f.summary.getSummary()?.vitals.state).toBe('unavailable');
        releaseDemand();
        f.release(); f.summary.stop(); await f.sampler.stop();
    });

    it('publishes share-safe Guard state transitions without claiming an automatic effect or publishing every tick', async () => {
        const f = await setup(); f.setConnection('online');
        const state = { v: 1 as const, capabilities: {
            memoryPressure: { status: 'available' as const }, ceiling: { status: 'unavailable' as const, reason: 'not_linux' as const },
            keepAwake: { modes: ['off' as const, 'on' as const, 'on_power' as const] },
        }, keepAwakeHolding: true };
        f.summary.setGuardState(state);
        expect(f.writes.at(-1)?.resources?.guard).toMatchObject(state);
        expect(f.writes.at(-1)?.resources).not.toHaveProperty('lastAutomaticAction');
        const count = f.writes.length;
        f.summary.setGuardState(state); await f.tick();
        expect(f.writes).toHaveLength(count);
        f.summary.setGuardState({ ...state, episode: { state: 'out_of_steps', since: Date.now() } });
        expect(f.writes).toHaveLength(count + 1);
        expect(f.writes.at(-1)?.resources?.attention.reasons).toContainEqual(expect.objectContaining({ kind: 'guard_out_of_steps' }));
        expect(f.writes.at(-1)?.resources).not.toHaveProperty('lastAutomaticAction');
        f.summary.setGuardState(state);
        expect(f.writes.at(-1)?.resources?.attention.reasons.some(reason => reason.kind === 'guard_out_of_steps')).toBe(false);
        f.release(); f.summary.stop(); await f.sampler.stop();
    });

    it('does not invent a disk threshold while the initial policy is unavailable', async () => {
        const f = await setup(null); f.setConnection('online');
        expect(f.summary.getSummary()?.attention.level).toBe('calm');
        f.pressure('critical'); await f.tick();
        expect(f.summary.getSummary()?.attention.reasons.map(reason => reason.kind)).toEqual(['memory_pressure']);
        f.threshold({ freeFraction: 0.1 });
        expect(f.summary.getSummary()?.attention.reasons.map(reason => reason.kind)).toEqual(['memory_pressure']);
        f.threshold({ freeFraction: 0.2 });
        expect(f.summary.getSummary()?.attention.reasons.map(reason => reason.kind)).toEqual(['memory_pressure', 'disk_nearly_full']);
        f.release(); f.summary.stop(); await f.sampler.stop();
    });

    it('publishes a first-read failure immediately without host facts, recovers, and retains only observed host facts', async () => {
        for (const initialFailure of ['helper_missing', 'reader_failed'] as const) {
            const f = await setup(undefined, initialFailure); f.setConnection('online');
            expect(f.writes).toHaveLength(1);
            expect(f.summary.getSummary()?.vitals).toEqual({ state: 'unavailable', since: initialTime, reason: initialFailure });
            expect(f.summary.getSummary()).not.toHaveProperty('host');
            f.fail(undefined); await f.tick();
            expect(f.summary.getSummary()).toMatchObject({ vitals: { state: 'reporting' }, host: { logicalCores: 4 } });
            f.fail('helper_missing'); await f.tick();
            expect(f.summary.getSummary()).toMatchObject({ vitals: { state: 'unavailable', reason: 'helper_missing' }, host: { logicalCores: 4 } });
            f.release(); f.summary.stop(); await f.sampler.stop();
            vi.setSystemTime(initialTime);
        }
    });
});
