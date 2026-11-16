import { describe, expect, it } from 'vitest';
import { MachineResourceSummaryV1Schema, projectMachineResourceSummaryV1, type MachineResourceSummaryV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { MachineVitalsSnapshotV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';

import {
    buildMachineSummaryInstruments,
    fitMachineSummaryMetrics,
    normalizeMachineSummaryMetrics,
    resolveMachineAttentionWordColor,
    resolveMachineResourceToneColor,
} from './machineSummaryStripModel';
import { t } from '@/text';

const GB = 1024 ** 3;
const line = (values: readonly (number | null)[]) => values.map((y, index) => ({ t: index * 15_000, y }));

function summary(overrides: Partial<MachineResourceSummaryV1> = {}): MachineResourceSummaryV1 {
    return {
        sampledAt: 1, stepMs: 15_000, seriesFrom: 0,
        cpu: { busyPct: 12.4, tone: 'calm', series: line([2, 3, 2, 3]) },
        memory: { availableBytes: 71 * GB, totalBytes: 128 * GB, pressure: 'calm', tone: 'calm', series: line([70 / 128 * 100, 71 / 128 * 100]) },
        disk: { volumeId: 'v', volumeLabel: 'Macintosh HD', availableBytes: 412 * GB, totalBytes: 994 * GB, tone: 'calm', series: [] },
        network: { rxBps: 2_000_000, txBps: 340_000, tone: 'calm', rxSeries: line([1, 2]), txSeries: line([1, 1]) },
        ...overrides,
    };
}

describe('one severity for a machine that needs you (DESIGN.md: amber is attention, rose is failure only)', () => {
    const colors = { text: { primary: 'ink' }, state: { attention: { textForeground: 'amber' }, danger: { textForeground: 'rose' } } };
    it('draws a needs-you meter in the same attention amber as its word and dot, never rose', () => {
        expect(resolveMachineResourceToneColor('crit', colors)).toBe(resolveMachineAttentionWordColor(colors));
        expect(resolveMachineResourceToneColor('warn', colors)).toBe('amber');
        expect(resolveMachineResourceToneColor('calm', colors)).toBe('ink');
    });
});

describe('the Machine summary value convention', () => {
    it('accepts omitted provenance and drops unknown memory presentation fields while validating known values', () => {
        const legacy = summary();
        expect(MachineResourceSummaryV1Schema.parse(legacy)).toEqual(legacy);
        expect(MachineResourceSummaryV1Schema.parse({ ...legacy, memory: { ...legacy.memory, futurePresentation: 'quiet' } }).memory).toEqual(legacy.memory);
        expect(MachineResourceSummaryV1Schema.safeParse({ ...legacy, memory: { ...legacy.memory, pressureSource: 'guessed' } }).success).toBe(false);
        expect(MachineResourceSummaryV1Schema.safeParse({ ...legacy, memory: { ...legacy.memory, totalBytes: -1 } }).success).toBe(false);
    });
    it.each([
        // The first sample stands alone before a gap: a sparkline leaves it out rather than draw a stray dot.
        { capacity: 8 * GB, expected: [null, null, 0.25, 1, 0] },
        { capacity: 0, expected: [null, null, null, null, null] },
        { capacity: null, expected: [null, null, null, null, null] },
    ])('projects daemon byte samples into an in-use memory line with capacity $capacity (OWNER-UI-1115B B1)', ({ capacity, expected }) => {
        const memory: MachineVitalsSampleV1['memory'] = capacity === null
            ? { reported: false, reason: 'unavailable' }
            : { reported: true, totalBytes: capacity, availableBytes: 6 * GB, usedBytes: 2 * GB,
                pressure: { level: 'calm', source: 'psi' } };
        // daemonMachineVitals emits available bytes from live samples (and total minus used from minutes).
        const snapshot = MachineVitalsSnapshotV1Schema.parse({
            state: 'reporting',
            sample: { v: 1, sampledAt: 60_000, intervalMs: 15_000, memory,
                cpu: { reported: true, busyPct: 12 }, disk: { reported: true, volumes: [] },
                network: { reported: true, rxBps: 0, txBps: 0 } },
            series5m: { cpu: [], memory: line([4 * GB, null, 6 * GB, 0, 8 * GB]), networkRx: [], networkTx: [] },
        });
        const projected = projectMachineResourceSummaryV1(snapshot);
        expect(projected).not.toBeNull();
        expect(buildMachineSummaryInstruments(projected!).memory.line).toEqual(expected);
        expect(snapshot.series5m.memory).toEqual(line([4 * GB, null, 6 * GB, 0, 8 * GB]));
    });

    it('keeps an empty Show (names only), drops unknown ids and orders the rest canonically', () => {
        expect(normalizeMachineSummaryMetrics([])).toEqual([]);
        expect(normalizeMachineSummaryMetrics(['network', 'cpu', 'cpu', 'gpu'])).toEqual(['cpu', 'network']);
        expect(normalizeMachineSummaryMetrics('cpu')).toEqual(['cpu', 'memory', 'disk']);
    });

    it('says CPU in use and memory and disk free, while meters fill by what is used', () => {
        const instruments = buildMachineSummaryInstruments(summary());
        expect(instruments.cpu.figure).toBe('12%');
        expect(instruments.memory.figure).toBe('71 GiB');
        expect(instruments.memory.used).toBeCloseTo(57 / 128);
        expect(instruments.disk.figure).toBe('442 GB');
        expect(instruments.disk.used).toBeCloseTo(582 / 994);
        expect(instruments.memory.exact).toContain('71 GiB');
    });

    it('shows nothing for a metric the machine did not measure, never zero', () => {
        const instruments = buildMachineSummaryInstruments(summary({ cpu: { busyPct: null, tone: 'calm', series: [] } }));
        expect(instruments.cpu.figure).toBeNull();
        expect(instruments.cpu.used).toBeNull();
        expect(instruments.cpu.exact).toBeNull();
    });

    it('says how much memory is in use, in tone, when memory is not calm; the pressure word stays in its exact reading (OWNER-UI-1115B B1)', () => {
        const instruments = buildMachineSummaryInstruments(summary({
            memory: { availableBytes: 0.2 * GB, totalBytes: 4 * GB, pressure: 'critical', tone: 'crit', series: line([0.25 / 4 * 100, 0.2 / 4 * 100]) },
        }));
        expect(instruments.memory.tone).toBe('crit');
        expect(instruments.memory.figure).toBe('95%');
        expect(instruments.memory.exact).toContain(t('machineSummary.pressure.critical'));
        // The line reads like CPU's and the meters' fill: in use, so tight memory draws high, never along the floor.
        expect(instruments.memory.line).toEqual([0.9375, 0.95]);
    });

    it('draws no stray dots: a sample cut off by gaps on both sides is left out of the sparkline (owner bar 11-16)', () => {
        const gappy = buildMachineSummaryInstruments(summary({ cpu: { busyPct: 80, tone: 'calm', series: line([80, null, 40, null, 40, 80]) } })).cpu.line;
        expect(gappy).toEqual([null, null, null, null, 0.5, 1]);
    });
    it('keeps a 2 → 3 % CPU wiggle flat: the line scales to its peak, never below 40 %', () => {
        const flat = buildMachineSummaryInstruments(summary()).cpu.line;
        expect(flat).toEqual([0.05, 0.075, 0.05, 0.075]);
        const busy = buildMachineSummaryInstruments(summary({ cpu: { busyPct: 80, tone: 'calm', series: line([20, 80]) } })).cpu.line;
        expect(busy).toEqual([0.25, 1]);
    });

    it('lets calm metrics yield first when there is no room, and never drops a toned one', () => {
        const instruments = buildMachineSummaryInstruments(summary({
            disk: { volumeId: 'v', volumeLabel: '/data', availableBytes: 10 * GB, totalBytes: 1800 * GB, tone: 'warn', series: [] },
        }));
        expect(fitMachineSummaryMetrics(['cpu', 'memory', 'disk', 'network'], instruments, 2)).toEqual(['cpu', 'disk']);
        expect(fitMachineSummaryMetrics(['cpu', 'disk'], instruments, 1)).toEqual(['disk']);
    });
});
