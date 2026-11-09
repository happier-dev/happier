import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineResourcesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';

import { createMachineResourceSummary } from '@/daemon/resources/machineResourceSummary';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import type { MachineVitalsReaderResult } from '@/daemon/vitals/readers/types';
import { createKeepAwake } from '@/integrations/keepAwake';
import { createGuardStatePublication, type GuardStatePublication } from './guardStatePublication';

describe('Guard state publication through sampler and resource summary owners', () => {
    let directory: string;
    beforeEach(async () => {
        vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 10));
        directory = await mkdtemp(join(tmpdir(), 'happier-guard-state-'));
    });
    afterEach(async () => { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });

    async function setup(holderAvailable = false) {
        let pressure: 'calm' | 'not_reported' = 'calm';
        let lowMemorySignal: boolean | undefined;
        let failed = false;
        let publication: GuardStatePublication | undefined;
        const intervals: number[] = [];
        const policy = MachineResourcesPolicyV1Schema.parse({ v: 1, monitoring: { mode: 'always', intervalMs: 60_000 } });
        const sampler = createMachineVitalsSampler({ historyStore: await createMinuteHistoryStore({ directory }),
            readPolicy: () => policy,
            // OS reader boundary; sampling, history, publication and summary owners are real.
            readers: { read: async (input): Promise<MachineVitalsReaderResult> => {
                intervals.push(input.intervalMs);
                if (failed) return { state: 'unavailable', reason: 'reader_failed' };
                return { state: 'reporting', host: { logicalCores: 1, memoryTotalBytes: 1000, bootedAt: 1 },
                    sample: { v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs,
                        cpu: { reported: false, reason: 'unavailable' },
                        memory: { reported: true, totalBytes: 1000, availableBytes: 1, usedBytes: 999,
                            ...(lowMemorySignal === undefined ? {} : { lowMemorySignal }),
                            pressure: { level: pressure, source: pressure === 'not_reported' ? 'none' : 'events' } },
                        disk: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' } },
                    minuteCounters: { monotonicMs: input.monotonicMs, cpu: null, network: null } };
            } }, onTick: () => publication?.refresh(),
        });
        await sampler.start();
        const summary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
        const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null,
            kill: () => { child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); return true; } });
        const keepAwake = holderAvailable ? createKeepAwake({ platform: 'darwin',
            // OS process adapter only: macOS readiness/exit are native process events.
            spawn: () => child as unknown as ChildProcess }) : createKeepAwake({ platform: 'linux', exists: () => false });
        await keepAwake.update();
        publication = createGuardStatePublication({ sampler, summary, keepAwake,
            ceilingCapability: { status: 'unavailable', reason: 'no_user_manager' } });
        const tick = async () => { await vi.advanceTimersByTimeAsync(60_000); await sampler.start(); };
        return { sampler, summary, keepAwake, publication, intervals, tick, ready: () => { child.emit('spawn'); },
            pressure: (next: typeof pressure) => { pressure = next; }, fail: (next: boolean) => { failed = next; },
            lowMemorySignal: (next: boolean | undefined) => { lowMemorySignal = next; },
            stop: async () => { publication?.stop(); summary.stop(); await keepAwake.release(); await sampler.stop(); } };
    }

    it('publishes actual capabilities without confusing nearly exhausted bytes for an OS pressure signal', async () => {
        const f = await setup();
        expect(f.summary.getSummary()?.guard).toMatchObject({
            capabilities: { memoryPressure: { status: 'available' }, ceiling: { status: 'unavailable', reason: 'no_user_manager' },
                keepAwake: { modes: ['off'], unavailableReason: 'no_inhibitor' } }, keepAwakeHolding: false,
        });
        const changed = vi.fn(); f.publication.subscribe(changed);
        const initial = f.publication.read(); await f.tick();
        expect(f.publication.read()).toBe(initial); expect(changed).not.toHaveBeenCalled();
        f.pressure('not_reported'); await f.tick();
        expect(f.summary.getSummary()?.guard?.capabilities.memoryPressure).toEqual({ status: 'unavailable', reason: 'no_pressure_signal' });
        f.lowMemorySignal(true); await f.tick();
        expect(f.sampler.latest()?.memory).toMatchObject({ reported: true, lowMemorySignal: true,
            pressure: { level: 'not_reported', source: 'none' } });
        expect(f.summary.getSummary()?.guard?.capabilities.memoryPressure).toEqual({ status: 'available' });
        const nativeSignal = f.publication.read();
        f.lowMemorySignal(false); await f.tick();
        expect(f.summary.getSummary()?.guard?.capabilities.memoryPressure).toEqual({ status: 'available' });
        expect(f.publication.read()).toBe(nativeSignal);
        f.lowMemorySignal(undefined); await f.tick();
        expect(f.summary.getSummary()?.guard?.capabilities.memoryPressure).toEqual({ status: 'unavailable', reason: 'no_pressure_signal' });
        f.fail(true); await f.tick();
        expect(f.summary.getSummary()?.guard?.capabilities.memoryPressure).toEqual({ status: 'unavailable', reason: 'sampler_unavailable' });
        f.fail(false); f.pressure('calm'); await f.tick();
        expect(f.summary.getSummary()?.guard?.capabilities.memoryPressure).toEqual({ status: 'available' });
        expect(f.summary.getSummary()).not.toHaveProperty('lastAutomaticAction');
        expect(f.intervals.every(interval => interval === 60_000)).toBe(true);
        f.publication.stop(); const stopped = f.publication.read();
        f.pressure('not_reported'); await f.tick();
        expect(f.publication.read()).toBe(stopped);
        await f.stop();
    });

    it('reports holding only while the actual keep-awake holder is ready, then withdraws on release', async () => {
        const f = await setup(true);
        expect(f.publication.read()).toMatchObject({ keepAwakeHolding: false,
            capabilities: { keepAwake: { modes: ['off', 'on', 'on_power'] } } });
        f.ready();
        expect(f.summary.getSummary()?.guard?.keepAwakeHolding).toBe(true);
        await f.keepAwake.release();
        expect(f.summary.getSummary()?.guard?.keepAwakeHolding).toBe(false);
        expect(f.summary.getSummary()).not.toHaveProperty('lastAutomaticAction');
        await f.stop();
    });
});
