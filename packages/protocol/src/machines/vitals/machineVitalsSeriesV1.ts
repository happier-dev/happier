import type { MachineVitalsSnapshotV1 } from './machineVitalsRpcV1.js';
import type { MachineVitalsSampleV1 } from './machineVitalsSampleV1.js';

type Series = MachineVitalsSnapshotV1['series5m'];

/** One gap rule for a daemon snapshot and its delivered live samples. */
export function appendMachineVitalsSeriesV1(series: Series, previous: MachineVitalsSampleV1 | null, samples: readonly MachineVitalsSampleV1[]): Series {
    let next: Series = {
        cpu: [...series.cpu], memory: [...series.memory],
        networkRx: [...series.networkRx], networkTx: [...series.networkTx],
    };
    let last = previous;
    for (const sample of samples) {
        // Wall time labels a chart; delivery order owns currentness. A clock
        // step starts a new chart segment rather than retaining future points.
        if (last && sample.sampledAt < last.sampledAt) next = { cpu: [], memory: [], networkRx: [], networkTx: [] };
        const missed = last && sample.sampledAt - last.sampledAt > 2 * Math.max(last.intervalMs, sample.intervalMs)
            ? last.sampledAt + last.intervalMs : null;
        const add = (points: Series['cpu'], value: number | null) => {
            if (missed !== null) points.push({ t: missed, y: null });
            points.push({ t: sample.sampledAt, y: value });
        };
        add(next.cpu, sample.cpu.reported ? sample.cpu.busyPct : null);
        add(next.memory, sample.memory.reported ? sample.memory.availableBytes : null);
        add(next.networkRx, sample.network.reported ? sample.network.rxBps : null);
        add(next.networkTx, sample.network.reported ? sample.network.txBps : null);
        last = sample;
    }
    return next;
}

/** R7: twenty 15-second slots; minute records cover a minute, explicit nulls never interpolate. */
export function projectMachineVitalsSeriesV1(series: Series, sampledAt: number): Series {
    const stepMs = 15_000;
    const end = Math.floor(sampledAt / stepMs) * stepMs;
    const start = end - 300_000 + stepMs;
    const points = (incoming: Series['cpu']): Series['cpu'] => {
        const byStep = new Map<number, Series['cpu'][number]>();
        for (const point of incoming) {
            if (point.t < start || point.t > sampledAt) continue;
            const at = Math.floor(point.t / stepMs) * stepMs;
            // Keep the first observation in a slot; a later live tick cannot redraw it.
            if (!byStep.has(at)) byStep.set(at, point);
        }
        const projected: Series['cpu'] = [];
        const first = byStep.size > 0 ? Math.min(...byStep.keys()) : end + stepMs;
        let covering: Series['cpu'][number] | undefined;
        for (let at = first; at <= end; at += stepMs) {
            const observed = byStep.get(at);
            if (observed) covering = observed;
            projected.push(covering && covering.y !== null && at < covering.t + 60_000
                ? covering : { t: at, y: null });
        }
        return projected;
    };
    return { cpu: points(series.cpu), memory: points(series.memory), networkRx: points(series.networkRx), networkTx: points(series.networkTx) };
}
