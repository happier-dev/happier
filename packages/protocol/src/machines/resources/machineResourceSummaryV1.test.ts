import { describe, expect, it } from 'vitest';
import { MachineResourceSummaryV1Schema, projectMachineResourceSummaryV1 } from './machineResourceSummaryV1.js';
import { MachineVitalsSampleV1Schema } from '../vitals/machineVitalsSampleV1.js';
import type { MachineVitalsSnapshotV1 } from '../vitals/machineVitalsRpcV1.js';

const host = { logicalCores: 8, effectiveCores: 0.5, memoryTotalBytes: 1024, bootedAt: 0 };

const snapshot = (cpu: unknown): MachineVitalsSnapshotV1 => ({
    state: 'reporting',
    sample: MachineVitalsSampleV1Schema.parse({
        v: 1, sampledAt: 1, intervalMs: 15_000, cpu,
        memory: { reported: false, reason: 'platform' }, disk: { reported: false, reason: 'platform' },
        network: { reported: false, reason: 'platform' },
    }),
    series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
});

describe('Machine resource CPU presentation', () => {
    it('keeps older and Windows observations honest when load or capacity is absent', () => {
        const cpu = projectMachineResourceSummaryV1(snapshot({ reported: true, busyPct: 10 }))?.cpu;
        expect(cpu).toEqual({ busyPct: 10, tone: 'calm', series: [] });
        expect(MachineResourceSummaryV1Schema.parse(projectMachineResourceSummaryV1(snapshot({ reported: false, reason: 'platform' }))).cpu)
            .toEqual({ busyPct: null, tone: 'calm', series: [] });
    });

    it('rounds load to the lab display precision and admits only valid known CPU presentation fields', () => {
        const summary = projectMachineResourceSummaryV1(snapshot({ reported: true, busyPct: 10,
            load1: 2.3141 }), host);
        expect(summary?.cpu).toMatchObject({ load1: 2.31, logicalCores: 8, effectiveCores: 0.5 });
        expect(summary?.cpu).not.toHaveProperty('futurePresentation');
        expect(MachineResourceSummaryV1Schema.parse({ ...summary, cpu: { ...summary?.cpu, futurePresentation: true } }).cpu)
            .toEqual(summary?.cpu);
        for (const fields of [{ load1: -1 }, { logicalCores: -1 }, { effectiveCores: -1 }]) {
            expect(MachineResourceSummaryV1Schema.safeParse({ ...summary, cpu: { ...summary?.cpu, ...fields } }).success).toBe(false);
        }
    });

    it('keeps zero load and Windows core facts without inventing a load measurement', () => {
        expect(projectMachineResourceSummaryV1(snapshot({ reported: true, busyPct: null, load1: 0 }), host)?.cpu)
            .toMatchObject({ load1: 0, logicalCores: 8, effectiveCores: 0.5 });
        const windows = projectMachineResourceSummaryV1(snapshot({ reported: true, busyPct: 10 }), host)?.cpu;
        expect(windows).toMatchObject({ logicalCores: 8, effectiveCores: 0.5 });
        expect(windows).not.toHaveProperty('load1');
    });
});
