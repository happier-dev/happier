import type { MachineResourceSummaryV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import type { MachineMemoryPressureSourceV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';

import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { formatVitalsLoad } from '@/components/machines/vitals/vitalsFormat';
import { resolveMachineCoreCount } from '@/components/machines/vitals/machineVitalsPresentation';
import { t } from '@/text';

import type { MachineSummaryMetric } from './machineSummarySettingModel';

export {
    DEFAULT_MACHINE_SUMMARY_METRICS, DEFAULT_MACHINE_SUMMARY_STYLE, MACHINE_SUMMARY_METRICS, MACHINE_SUMMARY_STYLES, normalizeMachineSummaryMetrics,
    type MachineSummaryMetric, type MachineSummaryStyle,
} from './machineSummarySettingModel';

export type MachineResourceTone = MachineResourceSummaryV1['cpu']['tone'];

/**
 * The colour of a machine's attention word or sentence lead ("Short on memory"), at either level: "Needs you"
 * is the one attention amber wherever it appears, and rose means failure only (DESIGN.md).
 */
export function resolveMachineAttentionWordColor(colors: Parameters<typeof resolveMachineResourceToneColor>[1]): string {
    return resolveMachineResourceToneColor('warn', colors);
}

export function resolveMachineResourceToneColor(
    tone: MachineResourceTone,
    colors: Readonly<{ text: Readonly<{ primary: string }>; state: Readonly<{ attention: Readonly<{ textForeground: string }>; danger: Readonly<{ textForeground: string }> }> }>,
): string {
    // One severity: a resource that needs you (`crit`) or asks for a look (`warn`) is attention, never a failure, so its
    // meter, word and dot share the attention amber (DESIGN.md; owner bar 11-16). Calm is ink.
    return tone === 'calm' ? colors.text.primary : colors.state.attention.textForeground;
}

/** One instrument as every style draws it: the figure, its fill (0–1, by used), its line, its tone and its exact name. */
export type MachineSummaryInstrument = Readonly<{
    metric: MachineSummaryMetric;
    /** The short figure ("12%", "71 GB", memory under pressure "94%"); `null` when the machine did not measure it (never "0"). */
    figure: string | null;
    /** How full the meter or ring is, by what is used (R9); `null` when unmeasured. */
    used: number | null;
    /** The 5-minute line, already scaled 0–1; empty when no line belongs to this metric (disk). */
    line: readonly (number | null)[];
    tone: MachineResourceTone;
    /** The exact reading for the tooltip and the accessible name ("Memory 71 GB free, 57 GB in use"). */
    exact: string | null;
    /** CPU only: "Load 2.31 · 18 cores" from the facts the summary holds; `null` when it holds neither (older daemon). */
    detail?: string | null;
}>;

/**
 * The CPU line under a filling figure. Load is the daemon's per-core-normalised observation, shown as sent (never divided
 * again); cores are the capacity the machine has, said as "available" when a container's limit is below the host's.
 */
export function describeMachineCpuLoadAndCores(cpu: MachineResourceSummaryV1['cpu']): string | null {
    const load = cpu.load1 === undefined ? null : formatVitalsLoad(cpu.load1);
    const host = cpu.logicalCores === undefined ? null
        : { logicalCores: cpu.logicalCores, ...(cpu.effectiveCores !== undefined ? { effectiveCores: cpu.effectiveCores } : {}) };
    const count = host ? resolveMachineCoreCount(host) : null;
    const limited = host !== null && host.effectiveCores !== undefined && host.effectiveCores > 0 && host.effectiveCores < host.logicalCores;
    if (load !== null && count !== null) {
        return t(limited ? 'machineVitals.cpu.loadAndCoresLimited' : 'machineVitals.cpu.loadAndCores', { load, count });
    }
    if (load !== null) return t('machineVitals.cpu.load', { load });
    return count === null ? null : t('machineVitals.cpu.cores', { count });
}

/** CPU's line scales to its recent peak but never below 40 %, so a 2 → 3 % wiggle stays flat (no min–max). */
export const CPU_LINE_FLOOR_PCT = 40;

function scaleLine(points: MachineResourceSummaryV1['cpu']['series'], max: number): (number | null)[] {
    if (max <= 0) return points.map(point => (point.y === null ? null : 0));
    return points.map(point => (point.y === null ? null : Math.max(0, Math.min(1, point.y / max))));
}

/** The summary's memory line is percent available; drawn, it reads in use like CPU's line and the meters' fill. */
function memoryInUseLine(points: MachineResourceSummaryV1['memory']['series']): (number | null)[] {
    return scaleLine(points, 100).map(free => (free === null ? null : 1 - free));
}

/**
 * A sparkline draws runs, not stray dots: a sample with a gap on both sides (a daemon that skipped readings under load)
 * would be a lone dot at this size, so it is left out (owner bar 11-16). Runs keep their gaps; nothing is interpolated.
 */
function withoutLoneSamples(line: (number | null)[]): (number | null)[] {
    return line.map((y, index) => y !== null && (line[index - 1] ?? null) === null && (line[index + 1] ?? null) === null ? null : y);
}

function formatRate(bps: number): string {
    return t('machineSummary.rate', { value: formatHappierDataBytes(bps, { kind: 'storage' }) });
}

const MEMORY_PRESSURE_SOURCE_KEYS = {
    kernel_level: 'machineVitals.memory.source.kernel',
    psi: 'machineVitals.memory.source.estimated',
    events: 'machineVitals.memory.source.estimated',
    none: 'machineVitals.memory.source.none',
} as const;

/** The same provenance wording for the full Memory tile and every summary. Omission is unknown. */
export function formatMachineMemoryPressureSource(source: MachineMemoryPressureSourceV1 | undefined): string | null {
    return source === undefined ? null : t(MEMORY_PRESSURE_SOURCE_KEYS[source]);
}

/**
 * The instruments of one summary, by the value convention (R7, R9, MPG-20): CPU percent in use; memory and
 * disk free, with the pressure word when memory is not calm; bars and rings fill by used; network is the
 * download rate on an auto-scaled line. Nothing is re-derived: tone and values are plan 20's.
 */
export function buildMachineSummaryInstruments(summary: MachineResourceSummaryV1): Readonly<Record<MachineSummaryMetric, MachineSummaryInstrument>> {
    const cpuPct = summary.cpu.busyPct;
    const cpuPeak = Math.max(CPU_LINE_FLOOR_PCT, ...summary.cpu.series.map(point => point.y ?? 0));
    const memory = summary.memory;
    const memoryUsed = memory.availableBytes !== null && memory.totalBytes !== null && memory.totalBytes > 0
        ? Math.max(0, Math.min(1, 1 - memory.availableBytes / memory.totalBytes)) : null;
    const pressureWord = memory.pressure === 'critical' ? t('machineSummary.pressure.critical')
        : memory.pressure === 'elevated' ? t('machineSummary.pressure.elevated') : null;
    const pressured = pressureWord !== null && memory.tone !== 'calm';
    const memoryFree = memory.availableBytes !== null ? formatHappierDataBytes(memory.availableBytes, { kind: 'memory' }) : null;
    const memoryExact = memoryFree === null ? null : memory.availableBytes !== null && memory.totalBytes !== null
        ? t('machineSummary.exact.memory', { free: memoryFree, used: formatHappierDataBytes(Math.max(0, memory.totalBytes - memory.availableBytes), { kind: 'memory' }) })
        : t('machineSummary.exact.memoryFree', { free: memoryFree });
    const disk = summary.disk;
    const diskUsed = disk.availableBytes !== null && disk.totalBytes !== null && disk.totalBytes > 0
        ? Math.max(0, Math.min(1, 1 - disk.availableBytes / disk.totalBytes)) : null;
    const diskFree = disk.availableBytes !== null ? formatHappierDataBytes(disk.availableBytes, { kind: 'storage' }) : null;
    const rx = summary.network.rxBps;
    const rxPeak = Math.max(1, ...summary.network.rxSeries.map(point => point.y ?? 0));
    return {
        cpu: {
            metric: 'cpu',
            figure: cpuPct === null ? null : `${Math.round(cpuPct)}%`,
            used: cpuPct === null ? null : cpuPct / 100,
            line: withoutLoneSamples(scaleLine(summary.cpu.series, cpuPeak)),
            tone: summary.cpu.tone,
            exact: cpuPct === null ? null : t('machineSummary.exact.cpu', { percent: Math.round(cpuPct) }),
            detail: describeMachineCpuLoadAndCores(summary.cpu),
        },
        memory: {
            metric: 'memory',
            // Memory under pressure says how full it is, in tone (the tone is the pressure, never a word in the
            // number's place); a calm one, or one without a pressure signal, says its free memory (OWNER-UI-1115B B1).
            figure: pressured ? (memoryUsed !== null ? `${Math.round(memoryUsed * 100)}%` : pressureWord) : memoryFree,
            used: memoryUsed,
            line: withoutLoneSamples(memoryInUseLine(memory.series)),
            tone: memory.tone,
            exact: memoryExact === null ? null
                : [pressured ? pressureWord : null, memoryExact, formatMachineMemoryPressureSource(memory.pressureSource)].filter(Boolean).join(', '),
        },
        disk: {
            metric: 'disk',
            figure: diskFree,
            used: diskUsed,
            line: [],
            tone: disk.tone,
            exact: diskFree === null ? null : disk.totalBytes === null
                ? t('machineSummary.exact.diskFree', { free: diskFree })
                : t('machineSummary.exact.disk', { free: diskFree, total: formatHappierDataBytes(disk.totalBytes, { kind: 'storage' }) }),
        },
        network: {
            metric: 'network',
            figure: rx === null ? null : formatRate(rx),
            used: null,
            line: withoutLoneSamples(scaleLine(summary.network.rxSeries, rxPeak)),
            tone: summary.network.tone,
            exact: rx === null ? null : t('machineSummary.exact.network', {
                down: formatRate(rx), up: formatRate(summary.network.txBps ?? 0),
            }),
        },
    };
}

/**
 * The chosen metrics this summary can draw: a figure it holds, or a recent line it holds while the figure drops
 * for a sample. A metric the machine did not measure is omitted, never drawn as a placeholder; with no summary
 * yet, none is drawn.
 */
export function selectMeasuredMachineSummaryMetrics(
    metrics: readonly MachineSummaryMetric[],
    instruments: Readonly<Record<MachineSummaryMetric, MachineSummaryInstrument>> | null,
): readonly MachineSummaryMetric[] {
    if (!instruments) return [];
    const measured = metrics.filter(metric => instruments[metric].figure !== null || instruments[metric].line.some(y => y !== null));
    return measured.length === metrics.length ? metrics : measured;
}

/**
 * Which metrics fit, given room for `capacity` of them: calm metrics yield first, a toned metric never
 * drops (MPG-20). The kept ones stay in canonical order.
 */
export function fitMachineSummaryMetrics(
    metrics: readonly MachineSummaryMetric[],
    instruments: Readonly<Record<MachineSummaryMetric, MachineSummaryInstrument>> | null,
    capacity: number,
): readonly MachineSummaryMetric[] {
    if (metrics.length <= capacity) return metrics;
    const toned = metrics.filter(metric => instruments?.[metric].tone !== undefined && instruments[metric].tone !== 'calm');
    const calm = metrics.filter(metric => !toned.includes(metric));
    const keep = new Set([...toned, ...calm.slice(0, Math.max(0, capacity - toned.length))]);
    return metrics.filter(metric => keep.has(metric));
}
