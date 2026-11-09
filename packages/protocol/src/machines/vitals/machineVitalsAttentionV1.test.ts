import { describe, expect, it } from 'vitest';
import { deriveMachineVitalsAttentionV1, composeMachineResourceAttentionV1 } from './machineVitalsAttentionV1.js';
import type { MachineVitalsSampleV1 } from './machineVitalsSampleV1.js';

const sample = (sampledAt: number, patch: Partial<MachineVitalsSampleV1> = {}): MachineVitalsSampleV1 => ({
    v: 1, sampledAt, intervalMs: 60_000,
    cpu: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' },
    memory: { reported: true, totalBytes: 1000, availableBytes: 800, usedBytes: 200, pressure: { level: 'calm', source: 'events' } },
    disk: { reported: true, volumes: [{ id: 'home', label: 'Home', mount: '/home', totalBytes: 1000, availableBytes: 500 }] },
    ...patch,
});
const memory = (level: 'calm' | 'elevated' | 'critical', extra: Partial<Extract<MachineVitalsSampleV1['memory'], { reported: true }>> = {}): MachineVitalsSampleV1['memory'] => ({
    reported: true, totalBytes: 1000, availableBytes: 800, usedBytes: 200, pressure: { level, source: 'events' }, ...extra,
});
const derive = (recent: MachineVitalsSampleV1[], previous: ReturnType<typeof deriveMachineVitalsAttentionV1> = [], nearlyFull = { freeFraction: 0.1 }) =>
    deriveMachineVitalsAttentionV1({ recent, previous, nearlyFull });

describe('canonical vitals attention', () => {
    it('enters on critical pressure, preserves since while changing level, and requires a full observed calm minute to exit', () => {
        const entry = derive([sample(0, { memory: memory('critical') })]);
        expect(entry).toEqual([expect.objectContaining({ key: 'memory', pressure: 'critical', level: 'needs_you', since: 0 })]);
        const held = derive([sample(60_000, { memory: memory('elevated') })], entry);
        expect(held).toEqual([expect.objectContaining({ pressure: 'elevated', level: 'look', since: 0 })]);
        expect(derive([sample(60_000), sample(119_999)], held)).toEqual(held);
        expect(derive([sample(60_000), sample(120_000)], held)).toEqual([]);
        // Missing reads / sleep never count as an observed recovery interval.
        expect(derive([sample(60_000), sample(240_000)], held)).toEqual(held);
        expect(derive([sample(60_000, { memory: { reported: false, reason: 'unavailable' } }), sample(120_000)], held)).toEqual(held);
        const unknownPressure = memory('calm', { pressure: { level: 'not_reported', source: 'none' } });
        expect(derive([sample(60_000, { memory: unknownPressure }), sample(120_000, { memory: unknownPressure })], held)).toEqual(held);
        const observedNegative = memory('calm', { pressure: { level: 'not_reported', source: 'none' }, lowMemorySignal: false });
        expect(derive([sample(60_000, { memory: observedNegative }), sample(120_000, { memory: observedNegative })], held)).toEqual([]);
    });
    it('counts a viewer arriving at the fast cadence as recovery coverage across the slower reading before it', () => {
        const entry = derive([sample(0, { memory: memory('critical') })]);
        // A slow reading at one minute, then a viewer's first readings at 2 s spacing.
        const recent = [sample(60_000), sample(118_000, { intervalMs: 2_000 }), sample(120_000, { intervalMs: 2_000 })];
        expect(derive(recent, entry)).toEqual([]);
    });

    it('uses the policy disk threshold even with alerts off, ignores purgeable space, and treats inode exhaustion as full', () => {
        const disk: MachineVitalsSampleV1['disk'] = { reported: true, volumes: [{ id: 'data', label: 'Data', mount: '/data', totalBytes: 1000,
            availableBytes: 150, availableIncludingPurgeableBytes: 900 }] };
        expect(derive([sample(0, { disk })])).toEqual([]);
        expect(derive([sample(0, { disk })], [], { freeFraction: 0.2 })).toEqual([expect.objectContaining({ key: 'disk:data', kind: 'disk_nearly_full', level: 'look' })]);
        expect(deriveMachineVitalsAttentionV1({ recent: [sample(0, { disk })], previous: [], nearlyFull: { freeBytes: 200 } })).toHaveLength(1);
        expect(derive([sample(0, { disk: { reported: true, volumes: [{ ...disk.volumes[0], inodesExhausted: true }] } })])).toEqual([
            expect.objectContaining({ kind: 'disk_full', level: 'needs_you' }),
        ]);
    });
    it('uses the Windows low-memory/commit exhaustion signals and fully used enforced limits, never guessed near limits', () => {
        expect(derive([sample(0, { memory: memory('calm', { pressure: { level: 'not_reported', source: 'none' }, lowMemorySignal: true }) })])).toEqual([
            expect.objectContaining({ pressure: 'critical', level: 'needs_you' }),
        ]);
        expect(derive([sample(0, { memory: memory('calm', { pressure: { level: 'not_reported', source: 'none' }, commitUsedBytes: 2000, commitLimitBytes: 2000 }) })])).toHaveLength(1);
        const reasons = derive([sample(0, { limits: { files: { used: 99, max: 100 }, daemonFiles: { used: 10, max: 10 }, ptys: { used: 20, max: 20 } } })]);
        expect(reasons.map(reason => reason.key).sort()).toEqual(['limit:files', 'limit:ptys']);
        expect(composeMachineResourceAttentionV1([derive([sample(0, { memory: memory('elevated') })]), reasons]).reasons[0].level).toBe('needs_you');
    });
    it('does not guess an unavailable policy threshold or use it as recovery evidence, but still detects a full disk', () => {
        const recent = [sample(0), sample(60_000)];
        expect(deriveMachineVitalsAttentionV1({ recent, previous: [], nearlyFull: null })).toEqual([]);
        const previous = derive([sample(0)], [], { freeFraction: 0.6 });
        expect(deriveMachineVitalsAttentionV1({ recent, previous, nearlyFull: null })).toEqual(previous);
        expect(deriveMachineVitalsAttentionV1({ recent: [sample(0, { disk: { reported: true, volumes: [{ id: 'home',
            label: 'Home', mount: '/home', totalBytes: 1000, availableBytes: 0 }] } })], previous: [], nearlyFull: null })).toEqual([
            expect.objectContaining({ kind: 'disk_full', level: 'needs_you' }),
        ]);
    });
});
