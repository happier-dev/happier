import type { MachineResourceAttentionV1, MachineResourceReasonV1 } from '../resources/machineResourceSummaryV1.js';
import type { MachineVitalsSampleV1 } from './machineVitalsSampleV1.js';
import { effectiveMachineMemoryPressureV1 } from './effectiveMachineMemoryPressureV1.js';

export type MachineVitalsAttentionInputV1 = Readonly<{
    recent: readonly MachineVitalsSampleV1[];
    previous: readonly MachineResourceReasonV1[];
    nearlyFull: { freeFraction: number } | { freeBytes: number } | null;
}>;

/** One capacity decision for attention and cleanup explanations. Purgeable capacity is never available now. */
export function resolveMachineDiskAttentionKindV1(
    volume: Readonly<{ totalBytes: number; availableBytes: number; inodesExhausted?: boolean }>,
    nearlyFull: MachineVitalsAttentionInputV1['nearlyFull'],
): 'disk_full' | 'disk_nearly_full' | null {
    if (volume.availableBytes === 0 || volume.inodesExhausted === true) return 'disk_full';
    const nearly = nearlyFull !== null && ('freeBytes' in nearlyFull ? volume.availableBytes < nearlyFull.freeBytes
        : volume.totalBytes > 0 && volume.availableBytes / volume.totalBytes < nearlyFull.freeFraction);
    return nearly ? 'disk_nearly_full' : null;
}

function reasonsForSample(sample: MachineVitalsSampleV1, nearlyFull: MachineVitalsAttentionInputV1['nearlyFull']): MachineResourceReasonV1[] {
    const reasons: MachineResourceReasonV1[] = [];
    if (sample.memory.reported) {
        const memory = sample.memory;
        const pressure = effectiveMachineMemoryPressureV1(memory);
        if (pressure === 'elevated' || pressure === 'critical') reasons.push({
            key: 'memory', level: pressure === 'critical' ? 'needs_you' : 'look', since: sample.sampledAt,
            metric: 'memory', nextStep: 'review_processes', kind: 'memory_pressure', pressure, swapping: memory.swap?.swapping ?? false,
        });
    }
    if (sample.disk.reported) for (const volume of sample.disk.volumes) {
        const kind = resolveMachineDiskAttentionKindV1(volume, nearlyFull);
        if (kind) reasons.push({
            key: `disk:${volume.id}`, level: kind === 'disk_full' ? 'needs_you' : 'look', since: sample.sampledAt,
            metric: 'disk', nextStep: 'free_up_space', kind, volumeId: volume.id, volumeLabel: volume.label,
        });
    }
    for (const limit of ['files', 'ptys', 'processes', 'inotify'] as const) {
        const candidates = [sample.limits?.[limit], ...(limit === 'files' ? [sample.limits?.daemonFiles] : [])];
        const reached = candidates.find(facts => facts && facts.max > 0 && facts.used >= facts.max);
        if (reached) reasons.push({ key: `limit:${limit}`, level: 'needs_you', since: sample.sampledAt,
            metric: 'limits', nextStep: 'review_processes', kind: 'limit_reached', limit, ...reached });
    }
    return reasons;
}

function isObserved(sample: MachineVitalsSampleV1, reason: MachineResourceReasonV1, nearlyFull: MachineVitalsAttentionInputV1['nearlyFull']): boolean {
    switch (reason.kind) {
        case 'guard_out_of_steps': return false; // Guard's episode owner clears this reason, never a vitals sample.
        case 'memory_pressure': return effectiveMachineMemoryPressureV1(sample.memory) !== 'not_reported';
        case 'disk_full': return sample.disk.reported;
        case 'disk_nearly_full': return sample.disk.reported && nearlyFull !== null;
        case 'limit_reached': return sample.limits?.[reason.limit] !== undefined
            || (reason.limit === 'files' && sample.limits?.daemonFiles !== undefined);
    }
}

export function deriveMachineVitalsAttentionV1(input: MachineVitalsAttentionInputV1): MachineResourceReasonV1[] {
    const latest = input.recent.at(-1);
    if (!latest) return [...input.previous];
    const previousByKey = new Map(input.previous.map(reason => [reason.key, reason]));
    const current = reasonsForSample(latest, input.nearlyFull).map(reason => ({
        ...reason, since: previousByKey.get(reason.key)?.since ?? reason.since,
    }));
    const currentKeys = new Set(current.map(reason => reason.key));
    for (const previous of input.previous) {
        if (currentKeys.has(previous.key)) continue;
        let falseSince = latest.sampledAt;
        let next: MachineVitalsSampleV1 | undefined;
        for (let index = input.recent.length - 1; index >= 0; index--) {
            const point = input.recent[index];
            if (!isObserved(point, previous, input.nearlyFull) || reasonsForSample(point, input.nearlyFull).some(reason => reason.key === previous.key)) break;
            // Recovery needs coverage; a sleeping machine's two isolated reads are not a calm minute.
            if (next && next.sampledAt - point.sampledAt > 2 * Math.max(next.intervalMs, point.intervalMs)) break;
            falseSince = point.sampledAt;
            next = point;
            if (latest.sampledAt - falseSince >= 60_000) break;
        }
        if (latest.sampledAt - falseSince < 60_000) current.push(previous);
    }
    return composeMachineResourceAttentionV1([current]).reasons;
}

export function composeMachineResourceAttentionV1(parts: readonly (readonly MachineResourceReasonV1[])[]): MachineResourceAttentionV1 {
    const reasons = parts.flatMap(part => part).sort((a, b) =>
        Number(b.level === 'needs_you') - Number(a.level === 'needs_you') || a.since - b.since || a.key.localeCompare(b.key));
    return { level: reasons.some(reason => reason.level === 'needs_you') ? 'needs_you' : reasons.length ? 'look' : 'calm', reasons };
}
